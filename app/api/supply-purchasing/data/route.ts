import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getAllSupplyOnHand, getSupplyFuturePOs, getVendorInfo, getTFMItemsBySKU } from '@/lib/db/queries/tfm'
import { getAllCustomerOrdersForPurchasing } from '@/lib/db/queries/csgportal'
import { getAllRecipes, getRecipes } from '@/lib/db/queries/tfm-custom'

// Per-item simulation horizon = vendor leadTime + targetDOC (computed below per item)

function serializeDates(obj: any): any {
  if (obj instanceof Date) return obj.toISOString()
  if (Array.isArray(obj)) return obj.map(serializeDates)
  if (obj && typeof obj === 'object') {
    const result: any = {}
    for (const [k, v] of Object.entries(obj)) result[k] = serializeDates(v)
    return result
  }
  return obj
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

export interface ConsumptionEvent {
  date: string
  productSku: string
  productName: string
  orderNumber: string
  orderedQty: number
  consumedQty: number   // supply units consumed for this order line
}

export interface ExpediteOption {
  poId: number
  poNumber: string
  currentEta: Date
  suggestedEta: Date
  qty: number
  daysToExpedite: number
}

export interface FuturePO {
  poId: number
  poNumber: string
  eta: Date
  qty: number
  isOverdue: boolean
}

export interface PurchasingItem {
  itemId: number
  sku: string
  name: string
  category: string
  vendorName: string
  vendorIsDefault: boolean  // false = no default set; fell back to an arbitrary vendor
  leadTimeDays: number
  targetDocDays: number
  forecastWindowDays: number
  onHandQty: number
  qtyOnOrder: number          // all open supply POs (including overdue, treated as arriving today)
  overduePoQty: number        // portion of qtyOnOrder that is past-ETA
  upcomingConsumption: number // within leadTime + targetDoc window
  runOutDate: Date | null
  alertDate: Date | null
  qtyToPurchase: number
  hasSufficientStock: boolean
  futurePOs: FuturePO[]
  expediteOptions: ExpediteOption[]
  consumptionEvents: ConsumptionEvent[]  // individual orders driving demand
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // ── Parallel data fetch ──────────────────────────────────────────────
    const [onHandItems, futurePOs, vendorInfoMap, allRecipes] = await Promise.all([
      getAllSupplyOnHand(),
      getSupplyFuturePOs(),
      getVendorInfo().catch(() => new Map()),
      getAllRecipes(),
    ])

    // Determine how far out to fetch orders: use the longest vendor window among all items
    // (minimum 90 days so we always have a useful horizon even if vendor data is missing)
    const maxForecastWindowDays = vendorInfoMap.size > 0
      ? Math.max(90, ...Array.from(vendorInfoMap.values()).map(v => v.leadTimeDays + v.targetDocDays))
      : 90
    const dataFetchEnd = addDays(today, maxForecastWindowDays)

    // Build supply PO lookup: itemId → all open POs (sorted by eta)
    // NOTE: we keep overdue POs — they're treated as arriving today in the simulation
    // (matching old app behavior: past-ETA POs add to day-0 inventory)
    const posByItem = new Map<number, FuturePO[]>()
    for (const po of futurePOs) {
      const arr = posByItem.get(po.itemId) ?? []
      const isOverdue = new Date(po.eta) < today
      arr.push({
        poId: po.poId,
        poNumber: po.poNumber,
        eta: new Date(po.eta),
        qty: po.qty,
        isOverdue,
      })
      posByItem.set(po.itemId, arr)
    }
    for (const [, pos] of posByItem) {
      pos.sort((a, b) => a.eta.getTime() - b.eta.getTime())
    }

    // Which supply items are actually used in recipes?
    const usedSupplyItemIds = new Set<number>()
    for (const [, lines] of Array.from(allRecipes.entries())) {
      for (const line of lines) usedSupplyItemIds.add(line.supplyItemId)
    }

    // ── Build consumption map ────────────────────────────────────────────
    // consumptionByItem: supplyItemId → Map<dateStr, totalConsumed>
    // consumptionEventsByItem: supplyItemId → detailed order events
    const consumptionByDate  = new Map<number, Map<string, number>>()
    const consumptionEvents  = new Map<number, ConsumptionEvent[]>()

    try {
      // Use unfiltered orders: no category restriction, no completed/received exclusion
      const orders = await getAllCustomerOrdersForPurchasing(today, dataFetchEnd)
      const orderSKUs = Array.from(new Set(orders.map(o => o.sku)))
      const tfmMap = await getTFMItemsBySKU(orderSKUs)
      const tfmItemIds = Array.from(tfmMap.values()).map(v => v.tfmItemId)
      const recipeMap = await getRecipes(tfmItemIds)

      for (const order of orders) {
        const tfmRecord = tfmMap.get(order.sku)
        if (!tfmRecord) continue
        const recipe = recipeMap.get(tfmRecord.tfmItemId) ?? []
        const dateStr = order.readyByDate.toISOString().split('T')[0]

        for (const line of recipe) {
          const consumed = line.qtyPerUnit * order.orderedQty

          // Date-aggregated map (for simulation)
          let dateMap = consumptionByDate.get(line.supplyItemId)
          if (!dateMap) { dateMap = new Map(); consumptionByDate.set(line.supplyItemId, dateMap) }
          dateMap.set(dateStr, (dateMap.get(dateStr) ?? 0) + consumed)

          // Detailed event list (for drill-down)
          const events = consumptionEvents.get(line.supplyItemId) ?? []
          events.push({
            date: dateStr,
            productSku: order.sku,
            productName: order.productName,
            orderNumber: order.orderNumber,
            orderedQty: order.orderedQty,
            consumedQty: Math.round(consumed * 1000) / 1000,
          })
          consumptionEvents.set(line.supplyItemId, events)
        }
      }
    } catch (err) {
      console.error('supply-purchasing: consumption fetch failed (non-fatal):', err)
    }

    // ── Build purchasing items ───────────────────────────────────────────
    const items: PurchasingItem[] = []

    for (const supply of onHandItems) {
      if (!usedSupplyItemIds.has(supply.itemId)) continue

      const vendor = vendorInfoMap.get(supply.itemId) ?? {
        leadTimeDays: 30, targetDocDays: 0, vendorName: 'Unknown Vendor', isDefault: false,
      }
      const forecastWindowDays = vendor.leadTimeDays + vendor.targetDocDays
      // Simulation runs exactly to the end of this item's forecast window (leadTime + targetDOC)
      const forecastEnd = addDays(today, forecastWindowDays)
      const itemSimEnd  = forecastEnd

      const itemPOs = posByItem.get(supply.itemId) ?? []

      // qtyOnOrder = ALL open supply POs (including overdue ones, matching old app)
      const qtyOnOrder   = itemPOs.reduce((s, p) => s + p.qty, 0)
      const overduePoQty = itemPOs.filter(p => p.isOverdue).reduce((s, p) => s + p.qty, 0)

      // ── Day-by-day simulation ────────────────────────────────────────
      // Overdue POs: add to day-0 inventory (same as old app)
      const dateMap = consumptionByDate.get(supply.itemId) ?? new Map<string, number>()
      let stock = supply.onHandQty + overduePoQty  // start with overdue arrivals already in
      let runOutDate: Date | null = null
      let upcomingConsumption = 0
      let poIdx = itemPOs.filter(p => p.isOverdue).length // skip overdue POs (already added above)
      const nonOverduePOs = itemPOs.filter(p => !p.isOverdue)
      let futurePOIdx = 0

      const cur = new Date(today)
      while (cur <= itemSimEnd) {
        // Add arriving future POs
        while (futurePOIdx < nonOverduePOs.length && nonOverduePOs[futurePOIdx].eta <= cur) {
          stock += nonOverduePOs[futurePOIdx].qty
          futurePOIdx++
        }

        // Subtract consumption
        const dateStr = cur.toISOString().split('T')[0]
        const consumed = dateMap.get(dateStr) ?? 0
        stock -= consumed

        // Accumulate consumption within planning window
        if (cur <= forecastEnd) upcomingConsumption += consumed

        // Track run-out (first time stock goes negative)
        if (stock < 0 && runOutDate === null) {
          runOutDate = new Date(cur)
        }

        cur.setDate(cur.getDate() + 1)
      }

      // ── Purchasing metrics ───────────────────────────────────────────
      const qtyToPurchase = Math.max(0, Math.ceil(upcomingConsumption) - (supply.onHandQty + qtyOnOrder))

      let alertDate: Date | null = null
      if (runOutDate !== null) {
        const raw = addDays(runOutDate, -vendor.leadTimeDays)
        alertDate = raw < today ? new Date(today) : raw
      }

      // ── Expedite analysis ────────────────────────────────────────────
      const expediteOptions: ExpediteOption[] = []
      if (runOutDate !== null) {
        const suggestedEtaBase = addDays(runOutDate, -1)
        for (const po of nonOverduePOs) {
          if (po.eta > runOutDate) {
            const suggestedEta = suggestedEtaBase < today ? new Date(today) : new Date(suggestedEtaBase)
            const daysToExpedite = Math.round((po.eta.getTime() - suggestedEta.getTime()) / 86400000)
            if (daysToExpedite > 0) {
              expediteOptions.push({
                poId: po.poId,
                poNumber: po.poNumber,
                currentEta: po.eta,
                suggestedEta,
                qty: po.qty,
                daysToExpedite,
              })
            }
          }
        }
      }

      // Sort consumption events by date
      const itemEvents = (consumptionEvents.get(supply.itemId) ?? [])
        .sort((a, b) => a.date.localeCompare(b.date))

      items.push({
        itemId: supply.itemId,
        sku: supply.sku,
        name: supply.name,
        category: supply.category,
        vendorName: vendor.vendorName,
        vendorIsDefault: vendor.isDefault,
        leadTimeDays: vendor.leadTimeDays,
        targetDocDays: vendor.targetDocDays,
        forecastWindowDays,
        onHandQty: supply.onHandQty,
        qtyOnOrder,
        overduePoQty,
        upcomingConsumption: Math.round(upcomingConsumption * 100) / 100,
        runOutDate,
        alertDate,
        qtyToPurchase,
        hasSufficientStock: qtyToPurchase === 0,
        futurePOs: itemPOs,
        expediteOptions,
        consumptionEvents: itemEvents,
      })
    }

    // Sort: needs attention first (by alert date), then sufficient stock
    items.sort((a, b) => {
      const aUrgent = !a.hasSufficientStock || a.expediteOptions.length > 0
      const bUrgent = !b.hasSufficientStock || b.expediteOptions.length > 0
      if (aUrgent && !bUrgent) return -1
      if (!aUrgent && bUrgent) return 1
      if (a.alertDate && b.alertDate) return a.alertDate.getTime() - b.alertDate.getTime()
      if (a.alertDate) return -1
      if (b.alertDate) return 1
      return a.sku.localeCompare(b.sku)
    })

    return NextResponse.json(serializeDates({ items }))
  } catch (err: any) {
    console.error('supply-purchasing/data error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
