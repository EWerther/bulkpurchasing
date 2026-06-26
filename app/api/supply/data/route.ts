import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getAllSupplyOnHand, getSupplyFuturePOs, getVendorLeadTimes, getTFMItemsBySKU } from '@/lib/db/queries/tfm'
import { getCustomerOrders } from '@/lib/db/queries/csgportal'
import { getAllRecipes, getRecipes } from '@/lib/db/queries/tfm-custom'
import { getInventoryFTX, getADSFTX, getOpenPOsFTX, getTFMVendorItemIdsFTX } from '@/lib/db/queries/ftx'
import { getInventorySBYL, getADSSBYL, getOpenPOsSBYL, getTFMVendorItemIdsSBYL } from '@/lib/db/queries/sbyl'
import { buildSupplyItems, buildSubstituteItemIdMap } from '@/lib/engine/supplyPipeline'
import { POScheduleGenerator } from '@/lib/engine/POScheduleGenerator'
import { SupplyAllocationOptimizer } from '@/lib/engine/SupplyAllocationOptimizer'
import { config } from '@/lib/config'
import type { SupplyItem, SupplyComponentView, ProjectedStockDay, DemandItem, SupplyAllocationView } from '@/lib/engine/types'

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

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const throughDateParam = searchParams.get('throughDate')
  const includeAllocations = searchParams.get('includeAllocations') === 'true'
  const throughDate = throughDateParam ? new Date(throughDateParam) : (() => {
    const d = new Date()
    d.setMonth(d.getMonth() + config.poReview.defaultMonthsAhead)
    return d
  })()

  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // ── Core supply data (always fetched) ──────────────────────────────
    const [onHandItems, futurePOs, leadTimes, allRecipes] = await Promise.all([
      getAllSupplyOnHand(),
      getSupplyFuturePOs(),
      getVendorLeadTimes(),
      getAllRecipes(),
    ])

    const posByItem = new Map<number, typeof futurePOs>()
    for (const po of futurePOs) {
      const arr = posByItem.get(po.itemId) ?? []
      arr.push(po)
      posByItem.set(po.itemId, arr)
    }

    const supplyMap = new Map<number, SupplyItem>()
    for (const item of onHandItems) {
      supplyMap.set(item.itemId, {
        itemId: item.itemId,
        sku: item.sku,
        name: item.name,
        category: item.category,
        onHandQty: item.onHandQty,
        futurePOs: (posByItem.get(item.itemId) ?? []).map(p => ({
          poId: p.poId,
          poNumber: p.poNumber,
          eta: p.eta,
          qty: p.qty,
        })),
        vendorLeadTimeDays: leadTimes.get(item.itemId) ?? 30,
      })
    }

    const usedSupplyItemIds = new Set<number>()
    for (const [, recipeLines] of Array.from(allRecipes.entries())) {
      for (const line of recipeLines) usedSupplyItemIds.add(line.supplyItemId)
    }

    // ── Consumption from existing production orders ─────────────────────
    // Each open production order (WP_WHOD/WP_WHOI) consumes supply components
    // based on the TFM recipe. Group by supply item so we can show consumption
    // events alongside incoming POs.
    interface ConsumptionEvent {
      orderNumber: string
      date: string        // ISO YYYY-MM-DD
      qty: number         // supply units consumed (orderedQty × qtyPerUnit)
      productSku: string
      productName: string
      orderedQty: number  // mattress/product units being produced
    }
    const consumptionBySupplyItem = new Map<number, ConsumptionEvent[]>()

    try {
      const orders = await getCustomerOrders(today, throughDate)
      const orderSKUs = Array.from(new Set(orders.map(o => o.sku)))
      const tfmMap  = await getTFMItemsBySKU(orderSKUs)
      const recipeMap = await getRecipes(Array.from(tfmMap.values()).map(v => v.tfmItemId))

      for (const order of orders) {
        const tfmRecord = tfmMap.get(order.sku)
        if (!tfmRecord) continue
        const recipe = recipeMap.get(tfmRecord.tfmItemId) ?? []
        const dateStr = order.readyByDate.toISOString().split('T')[0]

        for (const line of recipe) {
          const consumed = line.qtyPerUnit * order.orderedQty
          const events = consumptionBySupplyItem.get(line.supplyItemId) ?? []
          events.push({
            orderNumber: order.orderNumber,
            date:        dateStr,
            qty:         Math.round(consumed * 1000) / 1000,
            productSku:  order.sku,
            productName: order.productName,
            orderedQty:  order.orderedQty,
          })
          consumptionBySupplyItem.set(line.supplyItemId, events)
        }
      }
    } catch (consErr: any) {
      console.error('supply consumption calc error (non-fatal):', consErr)
    }

    // ── Optional: run optimizer to get allocations ──────────────────────
    // committedBySupplyItem: supplyItemId → total qty committed
    // allocationViewsByItem: supplyItemId → list of allocation views
    const committedByItem = new Map<number, number>()
    const allocationViewsByItem = new Map<number, SupplyAllocationView[]>()

    if (includeAllocations) {
      try {
        const cutoffDate = new Date(today)
        cutoffDate.setMonth(cutoffDate.getMonth() + config.poReview.defaultMonthsAhead)

        // Fetch FTX + SBYL demand data in parallel
        const [
          ftxInventory, ftxADS, ftxOpenPOs, ftxTFMItemIds,
          sbylInventory, sbylADS, sbylOpenPOs, sbylTFMItemIds,
        ] = await Promise.all([
          getInventoryFTX(),
          getADSFTX(),
          getOpenPOsFTX(cutoffDate),
          getTFMVendorItemIdsFTX(config.poSchedule.tfmVendorIdFTX),
          getInventorySBYL(),
          getADSSBYL(),
          getOpenPOsSBYL(cutoffDate),
          getTFMVendorItemIdsSBYL(config.poSchedule.tfmVendorIdSBYL),
        ])

        const ftxADSByItemId = new Map(ftxADS.map(a => [a.itemId, a.ads]))
        const ftxInvBySKU = new Map(ftxInventory.map(i => [i.sku, i.totalUnits]))
        const ftxADSBySKU = new Map(ftxADS.map(a => [a.sku, a.ads]))
        const sbylADSByItemId = new Map(sbylADS.map(a => [a.itemId, a.ads]))
        const sbylInvBySKU = new Map(sbylInventory.map(i => [i.sku, i.totalUnits]))
        const sbylADSBySKU = new Map(sbylADS.map(a => [a.sku, a.ads]))

        const skuToProductName = new Map<string, string>()
        for (const po of [...ftxOpenPOs, ...sbylOpenPOs]) {
          if (po.productName && !skuToProductName.has(po.sku)) skuToProductName.set(po.sku, po.productName)
        }

        // Established items
        const ftxEstablished = ftxInventory
          .filter(i => (ftxADSByItemId.get(i.itemId) ?? 0) > 0 && ftxTFMItemIds.has(i.itemId))
          .map(i => ({ itemId: i.itemId, sku: i.sku, company: 'FTX' as const, productName: skuToProductName.get(i.sku) ?? i.sku, currentInventory: i.totalUnits, ads: ftxADSByItemId.get(i.itemId)! }))

        const sbylEstablished = sbylInventory
          .filter(i => (sbylADSByItemId.get(i.itemId) ?? 0) > 0 && sbylTFMItemIds.has(i.itemId))
          .map(i => ({ itemId: i.itemId, sku: i.sku, company: 'SBYL' as const, productName: skuToProductName.get(i.sku) ?? i.sku, currentInventory: i.totalUnits, ads: sbylADSByItemId.get(i.itemId)! }))

        // Generate PO schedule
        const generator = new POScheduleGenerator({
          minDOC: config.poSchedule.minDOC,
          maxDOC: config.poSchedule.maxDOC,
          minOrderQty: config.poSchedule.minOrderQty,
          maxOrderQty: config.poSchedule.maxOrderQty,
          cutoffDate,
        })
        const ftxGenerated = generator.generate(ftxEstablished)
        const sbylGenerated = generator.generate(sbylEstablished)

        // New product POs
        const ftxADSItemIds = new Set(ftxADS.filter(a => a.ads > 0).map(a => a.itemId))
        const sbylADSItemIds = new Set(sbylADS.filter(a => a.ads > 0).map(a => a.itemId))
        const ftxNewPOs = ftxOpenPOs.filter(po => !ftxADSItemIds.has(po.itemId))
        const sbylNewPOs = sbylOpenPOs.filter(po => !sbylADSItemIds.has(po.itemId))

        // Resolve TFM item IDs
        const allSKUs = Array.from(new Set([
          ...ftxGenerated.map(g => g.sku),
          ...sbylGenerated.map(g => g.sku),
          ...ftxNewPOs.map(p => p.sku),
          ...sbylNewPOs.map(p => p.sku),
        ]))
        const tfmItemMap = await getTFMItemsBySKU(allSKUs)
        const tfmItemIds = Array.from(tfmItemMap.values()).map(v => v.tfmItemId)
        const recipes = await getRecipes(tfmItemIds)

        // Build all demand items
        const buildDemand = (
          generated: typeof ftxGenerated,
          newPOs: typeof ftxNewPOs,
          company: 'FTX' | 'SBYL',
          invBySKU: Map<string, number>,
          adsBySKU: Map<string, number>,
        ): DemandItem[] => {
          const items: DemandItem[] = []
          for (const g of generated) {
            const tfmId = tfmItemMap.get(g.sku)?.tfmItemId
            if (!tfmId) continue
            const inv = invBySKU.get(g.sku) ?? 0
            const ads = adsBySKU.get(g.sku) ?? 0
            items.push({
              id: `gen-${company}-${g.sku}-${g.arrivalDate.toISOString().split('T')[0]}`,
              itemId: tfmId, sku: g.sku, productName: g.productName, company,
              orderedQty: g.orderedQty, eta: g.arrivalDate,
              sourceType: 'PO', sourceRef: 'Generated', isNewProduct: false,
              ads, currentInventory: inv, currentDOC: ads > 0 ? inv / ads : 999,
              priorityScore: ads > 0 ? inv / ads : 999,
            })
          }
          for (const po of newPOs) {
            const tfmId = tfmItemMap.get(po.sku)?.tfmItemId
            if (!tfmId) continue
            const daysUntilETA = Math.max(0, Math.round((po.eta.getTime() - today.getTime()) / 86400000))
            items.push({
              id: `erp-${po.poId}-${po.poItemId}`,
              itemId: tfmId, sku: po.sku, productName: po.productName, company,
              orderedQty: po.qty, eta: po.eta,
              sourceType: 'PO', sourceRef: po.poNumber, isNewProduct: true,
              ads: 0, currentInventory: invBySKU.get(po.sku) ?? 0, currentDOC: 999,
              priorityScore: daysUntilETA,
            })
          }
          return items
        }

        const allDemand: DemandItem[] = [
          ...buildDemand(ftxGenerated, ftxNewPOs, 'FTX', ftxInvBySKU, ftxADSBySKU),
          ...buildDemand(sbylGenerated, sbylNewPOs, 'SBYL', sbylInvBySKU, sbylADSBySKU),
        ]

        // Run supply allocation optimizer
        const supplyItemsForOpt = await buildSupplyItems()
        const substituteIdMap = buildSubstituteItemIdMap(config.production.substitutes, supplyItemsForOpt)
        const optimizer = new SupplyAllocationOptimizer(supplyItemsForOpt, recipes, substituteIdMap)
        const { results: allocationResults } = optimizer.optimize(allDemand)

        // Map allocations back to supply item IDs
        const demandById = new Map(allDemand.map(d => [d.id, d]))
        for (const result of allocationResults) {
          const demand = demandById.get(result.demandId)
          if (!demand) continue

          for (const [supplyItemId, allocatedQty] of Array.from(result.allocations.entries())) {
            if (allocatedQty <= 0) continue

            committedByItem.set(supplyItemId, (committedByItem.get(supplyItemId) ?? 0) + allocatedQty)

            const viewList = allocationViewsByItem.get(supplyItemId) ?? []
            viewList.push({
              company: demand.company,
              type: 'PO',
              reference: demand.sourceRef,
              sku: demand.sku,
              productName: demand.productName,
              dueDate: demand.eta,
              qtyAllocated: allocatedQty,
              feasibilityStatus: result.feasibilityStatus,
              priorityScore: demand.priorityScore,
              isNewProduct: demand.isNewProduct,
              sourcePage: 'production-schedule',
            })
            allocationViewsByItem.set(supplyItemId, viewList)
          }
        }
      } catch (allocErr: any) {
        // Allocation enrichment failed — still return base supply data
        console.error('supply/data allocation error (non-fatal):', allocErr)
      }
    }

    // ── Build output components ────────────────────────────────────────
    const components: SupplyComponentView[] = []

    for (const [itemId, item] of Array.from(supplyMap.entries())) {
      if (!usedSupplyItemIds.has(itemId)) continue

      const sortedPOs = [...item.futurePOs].sort((a, b) => a.eta.getTime() - b.eta.getTime())

      // Build consumption map: date string → total consumed on that day
      const consumptionEvents = consumptionBySupplyItem.get(itemId) ?? []
      const consumptionByDate = new Map<string, number>()
      for (const ev of consumptionEvents) {
        consumptionByDate.set(ev.date, (consumptionByDate.get(ev.date) ?? 0) + ev.qty)
      }

      // Project inventory timeline — factor in both incoming POs and consumption
      const timeline: ProjectedStockDay[] = []
      let stock = item.onHandQty
      const current = new Date(today)
      let poIdx = 0

      while (current <= throughDate) {
        let arrivals = 0
        while (poIdx < sortedPOs.length && sortedPOs[poIdx].eta <= current) {
          arrivals += sortedPOs[poIdx].qty
          poIdx++
        }
        const dateStr = current.toISOString().split('T')[0]
        const consumed = consumptionByDate.get(dateStr) ?? 0
        stock += arrivals - consumed
        timeline.push({ date: new Date(current), stock, arrivals, consumed })
        current.setDate(current.getDate() + 1)
      }

      const hasShortageRisk = timeline.some(t => t.stock <= 0)
      const committedQty = committedByItem.get(itemId) ?? 0
      const allocations = allocationViewsByItem.get(itemId) ?? []

      components.push({
        itemId,
        sku: item.sku,
        name: item.name,
        category: item.category,
        onHandQty: item.onHandQty,
        committedQty,
        availableQty: Math.max(0, item.onHandQty - committedQty),
        futurePOs: item.futurePOs,
        consumptionEvents: consumptionEvents.sort((a, b) => a.date.localeCompare(b.date)),
        allocations,
        projectedTimeline: timeline,
        hasShortageRisk,
        warnings: [],
      })
    }

    return NextResponse.json(serializeDates({ components, allocationsIncluded: includeAllocations }))
  } catch (err: any) {
    console.error('supply/data error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
