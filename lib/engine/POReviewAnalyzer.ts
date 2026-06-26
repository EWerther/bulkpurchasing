import type { POReviewLine, POReviewStatus, ERPPOLine, Company } from './types'

interface SKUContext {
  itemId: number
  sku: string
  productName: string
  company: Company
  currentInventory: number
  ads: number
  isNewProduct: boolean
}

interface AnalyzerConfig {
  minDOC: number
  maxDOC: number
  adjustFromDate?: Date
  freezeDate?: Date
}

function isWeekday(d: Date): boolean {
  const day = d.getDay()
  return day !== 0 && day !== 6
}

function nextWeekday(d: Date): Date {
  const r = new Date(d)
  while (!isWeekday(r)) r.setDate(r.getDate() + 1)
  return r
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}

export class POReviewAnalyzer {
  private today: Date

  constructor(private cfg: AnalyzerConfig) {
    this.today = new Date()
    this.today.setHours(0, 0, 0, 0)
  }

  analyze(
    poLines: ERPPOLine[],
    skuContextMap: Map<number, SKUContext>
  ): POReviewLine[] {
    const results: POReviewLine[] = []

    // Group by itemId and sort by ETA to compute priorPOsQty correctly
    const byItem = new Map<number, ERPPOLine[]>()
    for (const po of poLines) {
      const arr = byItem.get(po.itemId) ?? []
      arr.push(po)
      byItem.set(po.itemId, arr)
    }

    for (const [itemId, lines] of Array.from(byItem.entries())) {
      const ctx = skuContextMap.get(itemId)
      if (!ctx) continue

      const sorted = [...lines].sort((a, b) => a.eta.getTime() - b.eta.getTime())

      let priorQtyAccumulated = 0
      let lastAdjustedETA: Date | undefined

      for (const po of sorted) {
        const effectiveETA = po.eta < this.today ? this.today : po.eta
        const daysToETA = daysBetween(this.today, effectiveETA)

        // Check if locked: ETA is before adjustFromDate (or frozen)
        const adjustFrom = this.cfg.adjustFromDate ?? this.today
        const isLocked = po.eta < adjustFrom || (this.cfg.freezeDate ? po.eta < this.cfg.freezeDate : false)

        const ads = ctx.ads
        const inv = ctx.currentInventory

        const projected = inv - (ads * daysToETA) + priorQtyAccumulated
        const projectedDOC = ads > 0 ? projected / ads : Infinity
        const docAfterArrival = ads > 0 ? (projected + po.qty) / ads : Infinity

        let status: POReviewStatus
        if (isLocked) {
          status = 'Locked'
        } else if (projectedDOC < this.cfg.minDOC) {
          status = 'Rush'
        } else if (docAfterArrival > this.cfg.maxDOC) {
          status = 'Push Off'
        } else {
          status = 'On Track'
        }

        let suggestedETA: Date | undefined
        if (status === 'Rush' || status === 'Push Off') {
          const targetDOC = status === 'Rush'
            ? this.cfg.minDOC
            : Math.max(this.cfg.minDOC, this.cfg.maxDOC - po.qty / (ads || 1))

          suggestedETA = this.binarySearchETA(inv, ads, po.qty, priorQtyAccumulated, targetDOC, lastAdjustedETA)

          if (suggestedETA && Math.abs(daysBetween(suggestedETA, po.eta)) < 1) {
            status = 'On Track'
            suggestedETA = undefined
          }
        }

        const line: POReviewLine = {
          poId: po.poId,
          poItemId: po.poItemId,
          poNumber: po.poNumber,
          sku: ctx.sku,
          itemId,
          productName: ctx.productName,
          company: ctx.company,
          currentETA: po.eta,
          effectiveETA,
          orderedQty: po.qty,
          ads,
          currentInventory: inv,
          currentDOC: ads > 0 ? inv / ads : Infinity,
          projectedDOC,
          docAfterArrival,
          status,
          suggestedETA,
          isNewProduct: ctx.isNewProduct,
          minDOC: this.cfg.minDOC,
          maxDOC: this.cfg.maxDOC,
        }

        results.push(line)
        priorQtyAccumulated += po.qty
        lastAdjustedETA = suggestedETA ?? effectiveETA
      }
    }

    return results
  }

  private binarySearchETA(
    currentInv: number,
    ads: number,
    orderQty: number,
    priorQty: number,
    targetDOC: number,
    minDate?: Date
  ): Date {
    const floor = minDate ?? this.today
    let lo = 0
    let hi = 365

    for (let i = 0; i < 50; i++) {
      const mid = Math.floor((lo + hi) / 2)
      const candidate = addDays(floor, mid)
      const daysToCandidate = daysBetween(this.today, candidate)
      const projected = currentInv - (ads * daysToCandidate) + priorQty
      const docAtArrival = ads > 0 ? projected / ads : Infinity

      if (docAtArrival < targetDOC) {
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }

    let result = addDays(floor, lo)
    // Snap to next weekday
    result = nextWeekday(result)
    return result
  }
}
