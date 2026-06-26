import type { GeneratedPOLine, Company } from './types'

interface CommittedArrival {
  eta: Date
  qty: number
}

interface SKUInput {
  itemId: number
  sku: string
  productName: string
  company: Company
  currentInventory: number
  ads: number
  committedArrivals?: CommittedArrival[]  // selected open POs to credit at their ETA dates
}

interface GeneratorConfig {
  minDOC: number
  maxDOC: number
  minOrderQty: number
  maxOrderQty: number
  cutoffDate: Date
  startDate?: Date
}

function isWeekday(d: Date): boolean {
  const day = d.getDay()
  return day !== 0 && day !== 6
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

export class POScheduleGenerator {
  constructor(private cfg: GeneratorConfig) {}

  generate(skus: SKUInput[]): GeneratedPOLine[] {
    const results: GeneratedPOLine[] = []
    const start = this.cfg.startDate ?? new Date()
    start.setHours(0, 0, 0, 0)

    for (const sku of skus) {
      if (sku.ads <= 0) continue

      let inv = sku.currentInventory
      const ads = sku.ads
      let current = new Date(start)

      // Sort committed arrivals ascending so we can credit them in order
      const arrivals = (sku.committedArrivals ?? [])
        .slice()
        .sort((a, b) => a.eta.getTime() - b.eta.getTime())
      let arrivalIdx = 0

      while (current <= this.cfg.cutoffDate) {
        // Credit any selected open PO quantities that arrive on or before today's sim date
        while (arrivalIdx < arrivals.length && arrivals[arrivalIdx].eta <= current) {
          inv += arrivals[arrivalIdx].qty
          arrivalIdx++
        }

        if (isWeekday(current)) {
          const doc = inv / ads
          if (doc <= this.cfg.minDOC) {
            // Before generating, check whether a pending selected-PO arrival will arrive
            // before inventory runs out AND will bring DOC above minDOC on its own.
            // If so, skip — no point scheduling production the day before a PO lands.
            const nextArrival = arrivalIdx < arrivals.length ? arrivals[arrivalIdx] : null
            if (nextArrival) {
              const daysUntil = Math.round(
                (nextArrival.eta.getTime() - current.getTime()) / 86400000
              )
              const invAtArrival = inv - ads * daysUntil
              const docAfterArrival = (invAtArrival + nextArrival.qty) / ads
              if (daysUntil > 0 && invAtArrival >= 0 && docAfterArrival > this.cfg.minDOC) {
                // Arrival covers the gap — no order needed today
                inv -= ads
                current = addDays(current, 1)
                continue
              }
            }

            const ideal = Math.round(Math.max(0, this.cfg.maxDOC * ads - inv))
            const orderQty = Math.min(
              Math.max(Math.max(ideal, this.cfg.minOrderQty), this.cfg.minOrderQty),
              this.cfg.maxOrderQty
            )
            results.push({
              sku: sku.sku,
              itemId: sku.itemId,
              productName: sku.productName,
              company: sku.company,
              arrivalDate: new Date(current),
              orderedQty: orderQty,
              projectedInventoryAtTrigger: inv,
              projectedDOCAtTrigger: doc,
              ads,
              currentInventory: sku.currentInventory,
              isNewProduct: false,
            })
            inv += orderQty
          }
        }
        inv -= ads
        current = addDays(current, 1)
      }
    }

    return results.sort((a, b) => a.arrivalDate.getTime() - b.arrivalDate.getTime())
  }
}
