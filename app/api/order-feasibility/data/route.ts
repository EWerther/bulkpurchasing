import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getCustomerOrders } from '@/lib/db/queries/csgportal'
import { getTFMItemsBySKU } from '@/lib/db/queries/tfm'
import { getRecipes } from '@/lib/db/queries/tfm-custom'
import { buildSupplyItems, buildSubstituteItemIdMap } from '@/lib/engine/supplyPipeline'
import { ProductionFeasibilityAnalyzer } from '@/lib/engine/ProductionFeasibilityAnalyzer'
import { SupplyAllocationOptimizer } from '@/lib/engine/SupplyAllocationOptimizer'
import { config } from '@/lib/config'
import type { DemandItem, SupplyItem, AllocationWarning } from '@/lib/engine/types'

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

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { throughDate: throughDateStr, deductionMode = 'ordered' } = await req.json()
  const throughDate = throughDateStr ? new Date(throughDateStr) : (() => {
    const d = new Date()
    d.setMonth(d.getMonth() + 1)
    return d
  })()

  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // Fetch all customer orders in window
    const rawOrders = await getCustomerOrders(today, throughDate)
    const allowedCats = config.production.feasibilityAllowedCategories

    // Map to TFM item IDs
    const uniqueSKUs = Array.from(new Set(rawOrders.map(o => o.sku)))
    const tfmItemMap = await getTFMItemsBySKU(uniqueSKUs)
    const recipes = await getRecipes(Array.from(tfmItemMap.values()).map(v => v.tfmItemId))

    const supplyItems = await buildSupplyItems()
    const substituteIdMap = buildSubstituteItemIdMap(config.production.substitutes, supplyItems)

    // Build demand items for optimizer
    const demandItems: DemandItem[] = rawOrders
      .filter(o => allowedCats.includes(o.category))
      .map(o => {
        const tfmId = tfmItemMap.get(o.sku)?.tfmItemId ?? -1
        return {
          id: `co-${o.orderId}`,
          itemId: tfmId,
          sku: o.sku,
          productName: o.productName,
          company: o.company.toUpperCase().includes('FTX') ? 'FTX' : 'SBYL',
          orderedQty: o.orderedQty,
          eta: o.readyByDate,
          sourceType: 'CustomerOrder',
          sourceRef: o.orderNumber,
          isNewProduct: false,
          ads: 0,
          currentInventory: 0,
          currentDOC: Infinity,
          priorityScore: Math.max(0, Math.round((o.readyByDate.getTime() - today.getTime()) / 86400000)),
        } as DemandItem
      })

    // Run optimizer
    const optimizer = new SupplyAllocationOptimizer(supplyItems, recipes, substituteIdMap)
    const { warnings } = optimizer.optimize(demandItems, deductionMode as 'ordered' | 'producible')

    // alwaysDeductAvailable=true  → Full Order mode: deduct full orderedQty even if partial
    // alwaysDeductAvailable=false → Realistic mode: only deduct canProduceQty
    const feasibilityAnalyzer = new ProductionFeasibilityAnalyzer(supplyItems, {
      alwaysDeductAvailable: deductionMode !== 'producible',
      substituteMap: substituteIdMap,
    })

    // Group by day
    const dayMap = new Map<string, any[]>()
    const noRecipeItems: any[] = []

    const orderedByDate = rawOrders
      .filter(o => allowedCats.includes(o.category))
      .sort((a, b) => a.readyByDate.getTime() - b.readyByDate.getTime())

    for (const order of orderedByDate) {
      const tfmRecord = tfmItemMap.get(order.sku)
      const dateKey = order.readyByDate.toISOString().split('T')[0]

      if (!tfmRecord) {
        noRecipeItems.push({ ...order, reason: 'No TFM mapping' })
        continue
      }

      const recipe = recipes.get(tfmRecord.tfmItemId) ?? []
      const feasibility = feasibilityAnalyzer.checkFeasibility(
        order.orderedQty,
        order.readyByDate,
        recipe,
        order.readyByDate
      )

      const orderWarnings = warnings.filter(w => w.affectedDemandIds.includes(`co-${order.orderId}`))

      const limitingComponent = feasibility.ingredientDetails
        .filter(d => d.shortage > 0 && !d.isSubstituted)
        .sort((a, b) => b.shortage - a.shortage)[0]

      const dayItems = dayMap.get(dateKey) ?? []
      dayItems.push({
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        company: order.company,
        sku: order.sku,
        productName: order.productName,
        readyByDate: order.readyByDate,
        orderedQty: order.orderedQty,
        canProduceQty: feasibility.canProduceQty,
        status: feasibility.status,
        requiresNewSupplyPO: feasibility.requiresNewSupplyPO,
        usesSubstitute: feasibility.usesSubstitute,
        limitingComponent,
        ingredientDetails: feasibility.ingredientDetails,
        optimizerWarnings: orderWarnings,
      })
      dayMap.set(dateKey, dayItems)
    }

    const days = []
    for (const [dateKey, items] of Array.from(dayMap.entries())) {
      const fullCount = items.filter((i: any) => i.status === 'Full').length
      const partialCount = items.filter((i: any) => i.status === 'Partial').length
      const noneCount = items.filter((i: any) => i.status === 'None').length
      days.push({
        date: dateKey,
        items,
        fullCount,
        partialCount,
        noneCount,
        isToday: dateKey === today.toISOString().split('T')[0],
      })
    }

    const allItems = Array.from(dayMap.values()).flat()
    return NextResponse.json(serializeDates({
      days,
      noRecipeItems,
      optimizerWarnings: warnings,
      summary: {
        totalChecked: rawOrders.length,
        fullCount: allItems.filter((i: any) => i.status === 'Full').length,
        partialCount: allItems.filter((i: any) => i.status === 'Partial').length,
        noneCount: allItems.filter((i: any) => i.status === 'None').length,
        noRecipeCount: noRecipeItems.length,
      },
    }))
  } catch (err: any) {
    console.error('order-feasibility/data error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
