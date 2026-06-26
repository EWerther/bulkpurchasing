/**
 * Shared helper: build the full supply picture from TFM databases.
 * Used by multiple API routes.
 */
import type { SupplyItem } from './types'
import { config } from '@/lib/config'
import { getSupplyOnHand, getSupplyFuturePOs, getVendorLeadTimes, getTFMItemsBySKU } from '@/lib/db/queries/tfm'
import { getRecipes } from '@/lib/db/queries/tfm-custom'

export async function buildSupplyItems(supplyItemIds?: number[]): Promise<Map<number, SupplyItem>> {
  const [onHandItems, futurePOs, leadTimes] = await Promise.all([
    getSupplyOnHand(),
    getSupplyFuturePOs(),   // no date filter — includes overdue unreceived POs
    getVendorLeadTimes(),
  ])

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const posByItem = new Map<number, typeof futurePOs>()
  for (const po of futurePOs) {
    const arr = posByItem.get(po.itemId) ?? []
    arr.push(po)
    posByItem.set(po.itemId, arr)
  }

  const supplyMap = new Map<number, SupplyItem>()
  for (const item of onHandItems) {
    if (supplyItemIds && !supplyItemIds.includes(item.itemId)) continue

    const allPos = posByItem.get(item.itemId) ?? []
    const overduePos  = allPos.filter(p => p.eta < today)
    const upcomingPos = allPos.filter(p => p.eta >= today)

    // Overdue unreceived POs are folded directly into onHandQty so they are
    // immediately available in running stock from the start — no timing dependency
    // on creditPOs to add them at the right moment in sequential processing.
    const overdueQty = overduePos.reduce((sum, p) => sum + p.qty, 0)

    supplyMap.set(item.itemId, {
      itemId: item.itemId,
      sku: item.sku,
      name: item.name,
      category: item.category,
      onHandQty: item.onHandQty + overdueQty,
      futurePOs: [
        // Overdue POs: shown in UI with ⚠ badge but qty=0 so creditPOs doesn't double-count
        ...overduePos.map(p => ({
          poId:        p.poId,
          poNumber:    p.poNumber,
          eta:         new Date(today),
          originalEta: p.eta,
          isOverdue:   true,
          qty:         0,        // already folded into onHandQty above
        })),
        // Future POs: credited normally via creditPOs when their ETA arrives
        ...upcomingPos.map(p => ({
          poId:        p.poId,
          poNumber:    p.poNumber,
          eta:         p.eta,
          isOverdue:   false,
          qty:         p.qty,
        })),
      ],
      vendorLeadTimeDays: leadTimes.get(item.itemId) ?? 30,
    })
  }

  return supplyMap
}

export function buildSubstituteItemIdMap(
  substituteSkuMap: Map<string, string[]>,
  supplyItems: Map<number, SupplyItem>
): Map<number, number[]> {
  const skuToId = new Map<string, number>()
  for (const [id, item] of supplyItems) {
    skuToId.set(item.sku, id)
  }

  const idMap = new Map<number, number[]>()
  for (const [primarySKU, subSKUs] of substituteSkuMap) {
    const primaryId = skuToId.get(primarySKU)
    if (primaryId === undefined) continue
    const subIds = subSKUs.map(s => skuToId.get(s)).filter((id): id is number => id !== undefined)
    if (subIds.length > 0) idMap.set(primaryId, subIds)
  }
  return idMap
}

export async function buildTFMItemIdMap(
  finishedGoodSKUs: string[]
): Promise<Map<string, number>> {
  const tfmItems = await getTFMItemsBySKU(finishedGoodSKUs)
  const skuToTfmId = new Map<string, number>()
  for (const [sku, record] of tfmItems) {
    skuToTfmId.set(sku, record.tfmItemId)
  }
  return skuToTfmId
}
