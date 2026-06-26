import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import {
  getTFMSupplyPOList,
  getTFMSupplyPOLines,
  getSupplyFuturePOsExcluding,
  getAllSupplyOnHand,
  getTFMItemsBySKU,
} from '@/lib/db/queries/tfm'
import { getAllCustomerOrdersForPurchasing } from '@/lib/db/queries/csgportal'
import { getRecipes } from '@/lib/db/queries/tfm-custom'

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

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const poIdStr = searchParams.get('poId')
  if (!poIdStr) return NextResponse.json({ error: 'poId required' }, { status: 400 })
  const poId = parseInt(poIdStr)
  if (isNaN(poId)) return NextResponse.json({ error: 'Invalid poId' }, { status: 400 })

  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const [allPOs, poLines, otherFuturePOs, allOnHand] = await Promise.all([
      getTFMSupplyPOList(),
      getTFMSupplyPOLines(poId),
      getSupplyFuturePOsExcluding(poId),
      getAllSupplyOnHand(),
    ])

    const po = allPOs.find(p => p.poId === poId)
    if (!po) return NextResponse.json({ error: 'PO not found' }, { status: 404 })
    if (!poLines.length) return NextResponse.json(serializeDates({ po, lines: [] }))

    // Horizon: ETA + 2 weeks (or today + 2 weeks if no ETA)
    const etaDate = po.eta ? new Date(po.eta) : today
    const horizonEnd = addDays(etaDate, 14)

    const poItemIds = new Set(poLines.map(l => l.itemId))
    const onHandMap = new Map(allOnHand.map(i => [i.itemId, i.onHandQty]))

    // Other open POs for items on this PO only
    const otherPosByItem = new Map<number, typeof otherFuturePOs>()
    for (const p of otherFuturePOs) {
      if (!poItemIds.has(p.itemId)) continue
      const arr = otherPosByItem.get(p.itemId) ?? []
      arr.push(p)
      otherPosByItem.set(p.itemId, arr)
    }

    // Build consumption events per supply item from upcoming production orders
    interface ConsumptionEvent {
      date: string
      orderNumber: string
      productSku: string
      productName: string
      orderedQty: number
      supplyQty: number
    }
    const consumptionByItem = new Map<number, ConsumptionEvent[]>()

    try {
      const orders = await getAllCustomerOrdersForPurchasing(today, horizonEnd)
      const orderSKUs = Array.from(new Set(orders.map(o => o.sku)))
      const tfmMap = await getTFMItemsBySKU(orderSKUs)
      const recipeMap = await getRecipes(Array.from(tfmMap.values()).map(v => v.tfmItemId))

      for (const order of orders) {
        const tfmRecord = tfmMap.get(order.sku)
        if (!tfmRecord) continue
        const recipe = recipeMap.get(tfmRecord.tfmItemId) ?? []
        const dateStr = order.readyByDate.toISOString().split('T')[0]

        for (const line of recipe) {
          if (!poItemIds.has(line.supplyItemId)) continue
          const consumed = Math.round(line.qtyPerUnit * order.orderedQty * 1000) / 1000
          const events = consumptionByItem.get(line.supplyItemId) ?? []
          events.push({
            date:        dateStr,
            orderNumber: order.orderNumber,
            productSku:  order.sku,
            productName: order.productName,
            orderedQty:  order.orderedQty,
            supplyQty:   consumed,
          })
          consumptionByItem.set(line.supplyItemId, events)
        }
      }
    } catch (err) {
      console.error('tfm-pos/impact: consumption fetch failed (non-fatal):', err)
    }

    // Per-line simulation
    const lines = poLines.map(line => {
      const poQty = line.qty
      const poEtaStr = po.eta ? new Date(po.eta).toISOString().split('T')[0] : null
      const onHandQty = onHandMap.get(line.itemId) ?? 0
      const otherPOs  = (otherPosByItem.get(line.itemId) ?? [])
        .sort((a, b) => a.eta.getTime() - b.eta.getTime())
      const events    = (consumptionByItem.get(line.itemId) ?? [])
        .sort((a, b) => a.date.localeCompare(b.date))

      // Other PO arrivals by date
      const otherArrivalByDate = new Map<string, number>()
      for (const p of otherPOs) {
        const ds = p.eta.toISOString().split('T')[0]
        otherArrivalByDate.set(ds, (otherArrivalByDate.get(ds) ?? 0) + p.qty)
      }

      // Consumption events grouped by date
      const consumptionEventsByDate = new Map<string, ConsumptionEvent[]>()
      for (const ev of events) {
        const arr = consumptionEventsByDate.get(ev.date) ?? []
        arr.push(ev)
        consumptionEventsByDate.set(ev.date, arr)
      }

      // Collect all dates with activity
      const activeDates = new Set<string>([
        ...Array.from(otherArrivalByDate.keys()),
        ...Array.from(consumptionEventsByDate.keys()),
        ...(poEtaStr ? [poEtaStr] : []),
      ])
      const sortedDates = Array.from(activeDates).sort()

      // Run two parallel simulations: with and without this PO
      let stockWithout = onHandQty
      let stockWith    = onHandQty

      const productionOrders: {
        date: string
        orderNumber: string
        productSku: string
        productName: string
        orderedQty: number
        supplyNeeded: number
        stockWithoutPO: number
        stockWithPO: number
        isShortWithout: boolean
        isShortWith: boolean
      }[] = []

      for (const dateStr of sortedDates) {
        // Apply other PO arrivals (both simulations)
        const otherArrival = otherArrivalByDate.get(dateStr) ?? 0
        stockWithout += otherArrival
        stockWith    += otherArrival

        // Apply this PO at its ETA (only "with" simulation)
        if (poEtaStr && dateStr === poEtaStr) {
          stockWith += poQty
        }

        // Process each consumption event on this date
        for (const ev of (consumptionEventsByDate.get(dateStr) ?? [])) {
          stockWithout -= ev.supplyQty
          stockWith    -= ev.supplyQty
          productionOrders.push({
            date:           dateStr,
            orderNumber:    ev.orderNumber,
            productSku:     ev.productSku,
            productName:    ev.productName,
            orderedQty:     ev.orderedQty,
            supplyNeeded:   ev.supplyQty,
            stockWithoutPO: Math.round(stockWithout * 100) / 100,
            stockWithPO:    Math.round(stockWith    * 100) / 100,
            isShortWithout: stockWithout < 0,
            isShortWith:    stockWith    < 0,
          })
        }
      }

      const ordersAtRisk   = productionOrders.filter(o => o.isShortWithout && !o.isShortWith).length
      const ordersShortBoth = productionOrders.filter(o => o.isShortWith).length
      const verdict = ordersShortBoth > 0 ? 'critical' : ordersAtRisk > 0 ? 'risky' : 'safe'

      return {
        lineId:    line.lineId,
        itemId:    line.itemId,
        sku:       line.sku,
        itemName:  line.itemName,
        category:  line.category,
        poQty,
        onHandQty,
        otherPoArrivals: otherPOs.map(p => ({
          poNumber: p.poNumber,
          eta:      p.eta.toISOString().split('T')[0],
          qty:      p.qty,
        })),
        productionOrders,
        ordersAtRisk,
        ordersShortBoth,
        verdict,
      }
    })

    return NextResponse.json(serializeDates({ po, lines }))
  } catch (err: any) {
    console.error('tfm-pos/impact error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
