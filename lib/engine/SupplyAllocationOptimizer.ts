import type {
  DemandItem,
  AllocationResult,
  AllocationWarning,
  RecipeLine,
  SupplyItem,
} from './types'

export class SupplyAllocationOptimizer {
  private runningStock: Map<number, number>
  private creditedPOs: Set<string>

  constructor(
    private supplyItems: Map<number, SupplyItem>,
    private recipes: Map<number, RecipeLine[]>,
    private substituteMap: Map<number, number[]>
  ) {
    this.runningStock = new Map()
    this.creditedPOs = new Set()
    for (const [id, item] of Array.from(supplyItems.entries())) {
      this.runningStock.set(id, item.onHandQty)
    }
  }

  /**
   * @param deductionMode
   *   'ordered'    — deducts full ordered qty from supply even if production is partial.
   *                  Conservative / procurement-safe. Default.
   *   'producible' — deducts only the quantity that can actually be produced (limited by
   *                  the most constrained component). Realistic for production sequencing:
   *                  if foam limits a mattress run to 103 units, the cover supply only
   *                  loses 103 units, not 600.
   */
  optimize(
    demandItems: DemandItem[],
    deductionMode: 'ordered' | 'producible' = 'ordered',
  ): {
    results: AllocationResult[]
    warnings: AllocationWarning[]
  } {
    const sorted = [...demandItems].sort((a, b) => a.priorityScore - b.priorityScore)
    const results: AllocationResult[] = []
    const resultMap = new Map<string, AllocationResult>()

    for (const demand of sorted) {
      this.creditPOsUpTo(demand.eta)

      const recipe = this.recipes.get(demand.itemId) ?? []
      const allocations = new Map<number, number>()
      let canProduceQty = demand.orderedQty
      let feasibilityStatus: 'Full' | 'Partial' | 'None' = 'Full'

      for (const ingredient of recipe) {
        const needed = ingredient.qtyPerUnit * demand.orderedQty
        const avail = this.runningStock.get(ingredient.supplyItemId) ?? 0
        const allocate = Math.min(needed, avail)

        this.runningStock.set(ingredient.supplyItemId, avail - allocate)
        allocations.set(ingredient.supplyItemId, allocate)

        let shortage = needed - allocate

        if (shortage > 0) {
          const subItemIds = this.substituteMap.get(ingredient.supplyItemId) ?? []
          for (const subItemId of subItemIds) {
            if (shortage <= 0) break
            const subAvail = this.runningStock.get(subItemId) ?? 0
            const subAllocate = Math.min(shortage, subAvail)
            this.runningStock.set(subItemId, subAvail - subAllocate)
            allocations.set(subItemId, (allocations.get(subItemId) ?? 0) + subAllocate)
            shortage -= subAllocate
          }
        }

        if (shortage > 0) {
          const canFromThis = Math.floor(allocate / ingredient.qtyPerUnit)
          canProduceQty = Math.min(canProduceQty, canFromThis)
        }
      }

      canProduceQty = Math.max(0, canProduceQty)

      // In 'producible' mode: refund the excess supply deducted beyond what can actually
      // be produced. E.g. if only 103 of 600 units are producible (foam limited), we
      // refund the cover supply for the 497 units we couldn't make — so downstream orders
      // see the realistic available cover stock, not a phantom depletion.
      if (deductionMode === 'producible') {
        for (const ingredient of recipe) {
          const deducted     = allocations.get(ingredient.supplyItemId) ?? 0
          const shouldDeduct = Math.min(canProduceQty * ingredient.qtyPerUnit, deducted)
          const refund       = deducted - shouldDeduct
          if (refund > 0) {
            const cur = this.runningStock.get(ingredient.supplyItemId) ?? 0
            this.runningStock.set(ingredient.supplyItemId, cur + refund)
            allocations.set(ingredient.supplyItemId, shouldDeduct)
          }
        }
      }

      if (canProduceQty >= demand.orderedQty) {
        feasibilityStatus = 'Full'
      } else if (canProduceQty > 0) {
        feasibilityStatus = 'Partial'
      } else {
        feasibilityStatus = 'None'
      }

      const result: AllocationResult = {
        demandId: demand.id,
        allocations,
        feasibilityStatus,
        warnings: [],
      }
      results.push(result)
      resultMap.set(demand.id, result)
    }

    const warnings = this.runForwardLookPass(sorted, results, resultMap)

    return { results, warnings }
  }

  private creditPOsUpTo(upToDate: Date) {
    for (const [itemId, item] of Array.from(this.supplyItems.entries())) {
      for (const po of item.futurePOs) {
        const key = `${itemId}-${po.poId}`
        if (!this.creditedPOs.has(key) && po.eta <= upToDate) {
          this.runningStock.set(itemId, (this.runningStock.get(itemId) ?? 0) + po.qty)
          this.creditedPOs.add(key)
        }
      }
    }
  }

  private runForwardLookPass(
    sortedDemand: DemandItem[],
    results: AllocationResult[],
    resultMap: Map<string, AllocationResult>
  ): AllocationWarning[] {
    const warnings: AllocationWarning[] = []

    // For each supply item, check if near-term demands strand future demands
    const supplyToDemandsMap = new Map<number, string[]>()
    for (const result of results) {
      for (const [supplyItemId] of Array.from(result.allocations.entries())) {
        const arr = supplyToDemandsMap.get(supplyItemId) ?? []
        arr.push(result.demandId)
        supplyToDemandsMap.set(supplyItemId, arr)
      }
    }

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const nearTermThreshold = new Date(today)
    nearTermThreshold.setDate(nearTermThreshold.getDate() + 7)

    for (const [supplyItemId, demandIds] of Array.from(supplyToDemandsMap.entries())) {
      const nearTermDemands = demandIds.filter(did => {
        const demand = sortedDemand.find(d => d.id === did)
        return demand && demand.eta <= nearTermThreshold
      })

      for (const nearId of nearTermDemands) {
        const nearDemand = sortedDemand.find(d => d.id === nearId)!

        for (const futureId of demandIds) {
          if (futureId === nearId) continue
          const futureDemand = sortedDemand.find(d => d.id === futureId)
          if (!futureDemand || futureDemand.eta <= nearTermThreshold) continue

          // Find when ALL of futureDemand's OTHER ingredients will be available
          const futureRecipe = this.recipes.get(futureDemand.itemId) ?? []
          const otherIngredients = futureRecipe.filter(r => r.supplyItemId !== supplyItemId)

          let otherComponentsDate: Date | null = null
          for (const other of otherIngredients) {
            const otherItem = this.supplyItems.get(other.supplyItemId)
            if (!otherItem) continue
            const needed = other.qtyPerUnit * futureDemand.orderedQty
            const onHand = otherItem.onHandQty

            if (onHand >= needed) continue

            const sortedPOs = [...otherItem.futurePOs].sort((a, b) => a.eta.getTime() - b.eta.getTime())
            let accumulated = onHand
            for (const po of sortedPOs) {
              accumulated += po.qty
              if (accumulated >= needed) {
                if (!otherComponentsDate || po.eta > otherComponentsDate) {
                  otherComponentsDate = po.eta
                }
                break
              }
            }
          }

          if (!otherComponentsDate || otherComponentsDate <= nearDemand.eta) continue

          // Project remaining stock of supplyItemId at otherComponentsDate
          const supplyItem = this.supplyItems.get(supplyItemId)!
          let projectedStock = this.runningStock.get(supplyItemId) ?? 0
          for (const po of supplyItem.futurePOs) {
            if (po.eta <= otherComponentsDate) projectedStock += po.qty
          }

          const futureResult = resultMap.get(futureId)
          const futureNeeded = (this.recipes.get(futureDemand.itemId) ?? [])
            .find(r => r.supplyItemId === supplyItemId)
          if (!futureNeeded) continue

          const qtyNeeded = futureNeeded.qtyPerUnit * futureDemand.orderedQty
          if (projectedStock < qtyNeeded) {
            const qtyAtRisk = qtyNeeded - projectedStock
            const supplyName = supplyItem.sku

            warnings.push({
              type: 'SupplyStranded',
              message: `Allocating ${supplyName} to ${nearDemand.sku} (priority: ${nearDemand.priorityScore.toFixed(0)} days) now leaves ${futureDemand.sku} without ${supplyName} when its other components arrive on ${otherComponentsDate.toLocaleDateString()}. ${futureDemand.sku} needs ${qtyNeeded} units; only ${Math.round(projectedStock)} will remain.`,
              affectedDemandIds: [nearId, futureId],
              supplyItemId,
              supplySKU: supplyItem.sku,
              qtyAtRisk: Math.round(qtyAtRisk),
              recommendedAction: `Consider delaying ${nearDemand.sku} or expediting ${supplyName}`,
            })
          }
        }
      }
    }

    return warnings
  }

  static computePriorityScore(demand: DemandItem): number {
    if (!demand.isNewProduct && demand.ads > 0) {
      return demand.currentInventory / demand.ads
    }
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return Math.max(0, Math.round((demand.eta.getTime() - today.getTime()) / 86400000))
  }
}
