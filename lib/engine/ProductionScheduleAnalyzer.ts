import type {
  ScheduledDay,
  ScheduledItem,
  SupplyItem,
  RecipeLine,
  POReviewLine,
  AllocationWarning,
  FeasibilityResult,
  IngredientDetail,
  Company,
} from './types'
import { ProductionFeasibilityAnalyzer } from './ProductionFeasibilityAnalyzer'

interface PlacementInput {
  demandId: string
  poId: number
  poItemId: number
  poNumber: string
  sku: string
  itemId: number
  productName: string
  company: Company
  orderedQty: number
  targetDate: Date
  isLocked: boolean
  isNewProduct: boolean
  ads: number
  currentInventory: number
  currentDOC: number
  recipe: RecipeLine[]
  optimizerWarnings: AllocationWarning[]
}

interface ScheduleConfig {
  dailyCapacity: number
  freezeDate?: Date
  cutoffDate: Date
}

function isWeekday(d: Date): boolean {
  const day = d.getDay()
  return day !== 0 && day !== 6
}

function nextWeekday(d: Date): Date {
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  while (!isWeekday(r)) r.setDate(r.getDate() + 1)
  return r
}

function addWeekdays(d: Date, n: number): Date {
  const r = new Date(d)
  let added = 0
  while (added < n) {
    r.setDate(r.getDate() + 1)
    if (isWeekday(r)) added++
  }
  return r
}

export class ProductionScheduleAnalyzer {
  constructor(
    private supplyItems: Map<number, SupplyItem>,
    private config: ScheduleConfig
  ) {}

  buildSchedule(
    items: PlacementInput[],
    feasibilityAnalyzer: ProductionFeasibilityAnalyzer
  ): { days: ScheduledDay[]; droppedItems: PlacementInput[] } {
    const dayMap = new Map<string, ScheduledItem[]>()
    const droppedItems: PlacementInput[] = []

    for (const item of items) {
      const isLocked = item.isLocked
      // Items that land before the freeze date must be pushed forward to it —
      // they are NOT committed/locked, just arrived early. Never pin an unlocked
      // item to a date in the committed window.
      let targetWeekday = nextWeekday(item.targetDate)
      if (!isLocked && this.config.freezeDate && targetWeekday < this.config.freezeDate) {
        targetWeekday = nextWeekday(this.config.freezeDate)
      }
      const feasibility = feasibilityAnalyzer.checkFeasibility(
        item.orderedQty,
        targetWeekday,
        item.recipe,
        targetWeekday,
        isLocked
      )

      const isInfeasible = feasibility.status === 'None' || feasibility.status === 'NoRecipe'

      let scheduledDate = targetWeekday
      let scheduledQty = item.orderedQty
      let moveReason: string | undefined
      let isInfeasibleLocked = false

      if (feasibility.status === 'NoRecipe') {
        // Place at target, no supply check
        scheduledDate = targetWeekday
      } else if (feasibility.status === 'Full') {
        scheduledDate = targetWeekday
      } else if (feasibility.status === 'None' && isLocked) {
        scheduledDate = targetWeekday
        isInfeasibleLocked = true
        moveReason = 'Locked — supply insufficient but cannot move'
      } else if (feasibility.status === 'None' && !isLocked) {
        const firstFeasible = feasibilityAnalyzer.findFirstFeasibleDay(
          item.recipe,
          item.orderedQty,
          feasibility.ingredientDetails.filter(d => d.shortage > 0)
        )
        scheduledDate = nextWeekday(firstFeasible)
        // Never place an unlocked generated item on a locked date — if supply resolves
        // before adjustFromDate, push the item to adjustFromDate instead
        if (this.config.freezeDate && scheduledDate < this.config.freezeDate) {
          scheduledDate = nextWeekday(this.config.freezeDate)
        }
        moveReason = `Moved: supply available ${scheduledDate.toLocaleDateString()}`
      } else if (feasibility.status === 'Partial') {
        scheduledQty = feasibility.canProduceQty
        scheduledDate = targetWeekday
        if (feasibility.canProduceQty < item.orderedQty) {
          moveReason = `Partial: ${feasibility.canProduceQty} of ${item.orderedQty} producible`
        }
      }

      // Hard safety: no unlocked item can ever land on a locked date (before freezeDate).
      // Covers all feasibility branches — belt-and-suspenders over the per-branch guards.
      if (!isLocked && this.config.freezeDate && scheduledDate < this.config.freezeDate) {
        scheduledDate = nextWeekday(this.config.freezeDate)
        moveReason = (moveReason ? moveReason + ' / ' : '') + `Pushed to adjust-from date`
      }

      const docAtDate = item.ads > 0
        ? (item.currentInventory - item.ads * Math.max(0, Math.round((scheduledDate.getTime() - new Date().getTime()) / 86400000))) / item.ads
        : Infinity

      const scheduledItem: ScheduledItem = {
        demandId: item.demandId,
        poId: item.poId,
        poItemId: item.poItemId,
        poNumber: item.poNumber,
        sku: item.sku,
        itemId: item.itemId,
        productName: item.productName,
        company: item.company,
        scheduledQty,
        orderedQty: item.orderedQty,
        scheduledDate,
        originalETA: item.targetDate,
        isLocked,
        isInfeasibleLocked,
        isNewProduct: item.isNewProduct,
        docAtDate,
        moveReason,
        feasibilityStatus: feasibility.status === 'NoRecipe' ? 'NoRecipe' : feasibility.status,
        ingredientDetails: feasibility.ingredientDetails,
        optimizerWarnings: item.optimizerWarnings,
      }

      // Check cutoff
      if (scheduledDate > this.config.cutoffDate) {
        droppedItems.push(item)
        continue
      }

      const dateKey = scheduledDate.toISOString().split('T')[0]
      const existing = dayMap.get(dateKey) ?? []
      existing.push(scheduledItem)
      dayMap.set(dateKey, existing)
    }

    // Capacity cascade — max 500 passes
    let changed = true
    let passes = 0
    while (changed && passes < 500) {
      changed = false
      passes++

      for (const [dateKey, dayItems] of Array.from(dayMap.entries())) {
        const totalQty = dayItems.reduce((s, i) => s + i.scheduledQty, 0)
        if (totalQty <= this.config.dailyCapacity) continue

        // Sort by DOC ascending (most urgent stays), locked always stays
        const unlocked = dayItems
          .filter(i => !i.isLocked && !i.isInfeasibleLocked)
          .sort((a, b) => (a.isNewProduct ? Infinity : a.docAtDate) - (b.isNewProduct ? Infinity : b.docAtDate))

        let remaining = totalQty - this.config.dailyCapacity

        for (const movable of [...unlocked].reverse()) {
          if (remaining <= 0) break

          const movableQty = movable.scheduledQty
          if (movableQty <= remaining) {
            // Move entire item to next weekday
            const newDate = addWeekdays(movable.scheduledDate, 1)
            if (newDate > this.config.cutoffDate) {
              dayItems.splice(dayItems.indexOf(movable), 1)
              droppedItems.push({
                demandId: movable.demandId,
                poId: movable.poId,
                poItemId: movable.poItemId,
                poNumber: movable.poNumber,
                sku: movable.sku,
                itemId: movable.itemId,
                productName: movable.productName,
                company: movable.company,
                orderedQty: movable.orderedQty,
                targetDate: movable.originalETA,
                isLocked: false,
                isNewProduct: movable.isNewProduct,
                ads: 0,
                currentInventory: 0,
                currentDOC: 0,
                recipe: [],
                optimizerWarnings: [],
              })
            } else {
              movable.scheduledDate = newDate
              movable.moveReason = (movable.moveReason ?? '') + ' (over-capacity cascade)'
              dayItems.splice(dayItems.indexOf(movable), 1)
              const newKey = newDate.toISOString().split('T')[0]
              const newDay = dayMap.get(newKey) ?? []
              newDay.push(movable)
              dayMap.set(newKey, newDay)
            }
            remaining -= movableQty
            changed = true
          } else {
            // Partial split: keep what fits, overflow remainder
            const keepQty = movable.scheduledQty - remaining
            const overflowQty = remaining

            movable.scheduledQty = keepQty
            movable.moveReason = (movable.moveReason ?? '') + ` (split: ${keepQty} kept)`

            const overflowDate = addWeekdays(movable.scheduledDate, 1)
            if (overflowDate <= this.config.cutoffDate) {
              const overflow: ScheduledItem = {
                ...movable,
                scheduledQty: overflowQty,
                scheduledDate: overflowDate,
                moveReason: 'Overflow from capacity split',
              }
              const overflowKey = overflowDate.toISOString().split('T')[0]
              const overflowDay = dayMap.get(overflowKey) ?? []
              overflowDay.push(overflow)
              dayMap.set(overflowKey, overflowDay)
            }
            remaining = 0
            changed = true
          }
        }
      }
    }

    // Build final days array
    const days: ScheduledDay[] = []
    for (const [, items] of Array.from(dayMap.entries())) {
      if (!items.length) continue
      const totalQty = items.reduce((s, i) => s + i.scheduledQty, 0)
      days.push({
        date: items[0].scheduledDate,
        items,
        totalQty,
        isOverCapacity: totalQty > this.config.dailyCapacity,
        hasConflict: false,
        conflicts: [],
      })
    }

    return {
      days: days.sort((a, b) => a.date.getTime() - b.date.getTime()),
      droppedItems,
    }
  }
}
