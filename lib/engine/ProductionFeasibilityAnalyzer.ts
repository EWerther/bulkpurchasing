import type {
  FeasibilityResult,
  IngredientDetail,
  RecipeLine,
  SupplyItem,
  SupplyPOArrival,
} from './types'

interface AnalyzerOptions {
  alwaysDeductAvailable: boolean
  substituteMap?: Map<number, number[]>
}

export class ProductionFeasibilityAnalyzer {
  private runningStock: Map<number, number>

  constructor(
    private supplyItems: Map<number, SupplyItem>,
    private options: AnalyzerOptions
  ) {
    this.runningStock = new Map()
    for (const [id, item] of Array.from(supplyItems.entries())) {
      this.runningStock.set(id, item.onHandQty)
    }
  }

  // Track which POs have already been credited so we never double-count.
  // Using a Set of poId strings avoids mutating item.futurePOs in place
  // (the original mutation bug caused later-dated items to incorrectly see
  // supply that hadn't arrived yet for earlier-dated items).
  private creditedPoIds = new Set<number>()

  private creditPOs(upToDate: Date) {
    for (const [itemId, item] of Array.from(this.supplyItems.entries())) {
      for (const po of item.futurePOs) {
        if (!this.creditedPoIds.has(po.poId) && po.eta <= upToDate) {
          this.runningStock.set(itemId, (this.runningStock.get(itemId) ?? 0) + po.qty)
          this.creditedPoIds.add(po.poId)
        }
      }
    }
  }

  checkFeasibility(
    orderedQty: number,
    eta: Date,
    recipe: RecipeLine[],
    creditPOsUpTo?: Date,
    forceDeductFull?: boolean   // true for locked committed items — always consume supply
  ): FeasibilityResult {
    if (!recipe.length) {
      return {
        status: 'NoRecipe',
        canProduceQty: 0,
        requiresNewSupplyPO: false,
        usesSubstitute: false,
        ingredientDetails: [],
      }
    }

    if (creditPOsUpTo) {
      this.creditPOs(creditPOsUpTo)
    }

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const daysUntilETA = Math.max(0, Math.round((eta.getTime() - today.getTime()) / 86400000))

    let canProduce = orderedQty
    let requiresNewSupplyPO = false
    let usesSubstitute = false
    const ingredientDetails: IngredientDetail[] = []

    for (const ingredient of recipe) {
      const needed = ingredient.qtyPerUnit * orderedQty
      const primaryAvail = this.runningStock.get(ingredient.supplyItemId) ?? 0
      let shortage = Math.max(0, needed - primaryAvail)

      let substituteQtyUsed = 0
      let substituteStillShort = 0
      let isSubstituted = false
      let substituteSKU: string | undefined

      const subItemIds = this.options.substituteMap?.get(ingredient.supplyItemId) ?? []
      const supplyItem = this.supplyItems.get(ingredient.supplyItemId)
      const leadTimeDays = supplyItem?.vendorLeadTimeDays ?? 30

      for (const subItemId of subItemIds) {
        if (shortage <= 0) break
        const subAvail = this.runningStock.get(subItemId) ?? 0
        const used = Math.min(subAvail, shortage)
        substituteQtyUsed += used
        shortage -= used
        if (used > 0) {
          isSubstituted = true
          usesSubstitute = true
          if (!substituteSKU) substituteSKU = this.supplyItems.get(subItemId)?.sku
        }
      }
      substituteStillShort = shortage

      const effectiveShortage = shortage
      const canOrderInTime = leadTimeDays <= daysUntilETA

      let canProduceFromThis: number
      if (effectiveShortage > 0 && canOrderInTime) {
        canProduceFromThis = orderedQty
        requiresNewSupplyPO = true
      } else {
        const combined = primaryAvail + substituteQtyUsed
        canProduceFromThis = Math.floor(combined / ingredient.qtyPerUnit)
      }

      canProduce = Math.min(canProduce, canProduceFromThis)

      ingredientDetails.push({
        supplyItemId: ingredient.supplyItemId,
        supplySKU: ingredient.supplySKU,
        supplyName: ingredient.supplyName,
        supplyCategory: ingredient.supplyCategory,
        qtyPerUnit: ingredient.qtyPerUnit,
        qtyNeeded: needed,
        qtyAvailable: primaryAvail,
        shortage: effectiveShortage,
        canOrderInTime,
        leadTimeDays,
        daysUntilETA,
        isSubstituted,
        substituteSKU,
        substituteQtyUsed,
        substituteStillShort,
      })
    }

    canProduce = Math.max(0, canProduce)

    const status: FeasibilityResult['status'] =
      canProduce >= orderedQty ? 'Full'
      : canProduce > 0 ? 'Partial'
      : 'None'

    // Deduct from running stock
    // forceDeductFull: locked committed items consume supply regardless of feasibility status
    const actualProduced = (this.options.alwaysDeductAvailable || forceDeductFull) ? orderedQty : canProduce
    for (const ingredient of recipe) {
      const needed = ingredient.qtyPerUnit * actualProduced
      const primaryAvail = this.runningStock.get(ingredient.supplyItemId) ?? 0
      const primaryUsed = Math.min(needed, primaryAvail)
      this.runningStock.set(ingredient.supplyItemId, primaryAvail - primaryUsed)

      let remainder = needed - primaryUsed
      if (remainder > 0 && this.options.substituteMap) {
        const subItemIds = this.options.substituteMap.get(ingredient.supplyItemId) ?? []
        for (const subItemId of subItemIds) {
          if (remainder <= 0) break
          const subAvail = this.runningStock.get(subItemId) ?? 0
          const subUsed = Math.min(remainder, subAvail)
          this.runningStock.set(subItemId, subAvail - subUsed)
          remainder -= subUsed
        }
      }
    }

    return {
      status,
      canProduceQty: canProduce,
      requiresNewSupplyPO,
      usesSubstitute,
      ingredientDetails,
    }
  }

  findFirstFeasibleDay(
    recipe: RecipeLine[],
    orderedQty: number,
    currentShortages: IngredientDetail[]
  ): Date {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    let latestDate = today

    for (const shortage of currentShortages) {
      if (shortage.shortage <= 0) continue

      const supplyItem = this.supplyItems.get(shortage.supplyItemId)
      if (!supplyItem) continue

      const sortedPOs = [...supplyItem.futurePOs].sort((a, b) => a.eta.getTime() - b.eta.getTime())
      let accumulated = this.runningStock.get(shortage.supplyItemId) ?? 0
      const needed = shortage.qtyPerUnit * orderedQty

      let found = false
      for (const po of sortedPOs) {
        accumulated += po.qty
        if (accumulated >= needed) {
          if (po.eta > latestDate) latestDate = po.eta
          found = true
          break
        }
      }

      if (!found) {
        const fallback = new Date(today)
        fallback.setDate(fallback.getDate() + (supplyItem.vendorLeadTimeDays || 365))
        if (fallback > latestDate) latestDate = fallback
      }
    }

    // Snap to next weekday
    while (latestDate.getDay() === 0 || latestDate.getDay() === 6) {
      latestDate.setDate(latestDate.getDate() + 1)
    }

    return latestDate
  }

  getRunningStock(): Map<number, number> {
    return new Map(this.runningStock)
  }
}
