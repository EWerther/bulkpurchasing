import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getInventoryFTX, getADSFTX, getOpenPOsFTX, getTFMVendorItemIdsFTX } from '@/lib/db/queries/ftx'
import { getInventorySBYL, getADSSBYL, getOpenPOsSBYL, getTFMVendorItemIdsSBYL, getRPKGComponentsSBYL } from '@/lib/db/queries/sbyl'
import { getTFMItemsBySKU } from '@/lib/db/queries/tfm'
import { getRecipes } from '@/lib/db/queries/tfm-custom'
import { buildSupplyItems, buildSubstituteItemIdMap } from '@/lib/engine/supplyPipeline'
import { POScheduleGenerator } from '@/lib/engine/POScheduleGenerator'
import { ProductionFeasibilityAnalyzer } from '@/lib/engine/ProductionFeasibilityAnalyzer'
import { ProductionScheduleAnalyzer } from '@/lib/engine/ProductionScheduleAnalyzer'
import { SupplyAllocationOptimizer } from '@/lib/engine/SupplyAllocationOptimizer'
import { config } from '@/lib/config'
import type { DemandItem } from '@/lib/engine/types'

function serializeDates(obj: any): any {
  if (obj instanceof Date) return obj.toISOString()
  if (obj instanceof Map) return Object.fromEntries(Array.from(obj.entries()).map(([k, v]: [any, any]) => [k, serializeDates(v)]))
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

  const body = await req.json()
  const {
    cutoffDate: cutoffStr,
    adjustFromDate: adjustFromStr,
    etaOverrides = {} as Record<string, string>,
    qtyOverrides = {} as Record<string, number>,
    generateSchedule = false,
    minDOC = config.poSchedule.minDOC,
    maxDOC = config.poSchedule.maxDOC,
  } = body
  // Selected open POs from modal — included in DOC simulation and pinned in results
  const selectedOpenPOs: Array<{ poId: number; poItemId: number; company: 'FTX' | 'SBYL' }> =
    Array.isArray(body.selectedOpenPOs) ? body.selectedOpenPOs : []

  const cutoffDate = cutoffStr ? new Date(cutoffStr) : (() => {
    const d = new Date()
    d.setMonth(d.getMonth() + config.poReview.defaultMonthsAhead)
    return d
  })()
  const adjustFromDate = adjustFromStr ? new Date(adjustFromStr) : undefined

  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    // Merge horizon is always 1 year — ensures every existing ITPO line has a
    // future schedule item to be matched against (push-off) rather than excluded.
    const mergeHorizonDate = new Date(today)
    mergeHorizonDate.setFullYear(mergeHorizonDate.getFullYear() + 1)

    // Fetch both FTX and SBYL in parallel — TFM supply is shared across both companies
    const [
      ftxInventory, ftxADS, ftxOpenPOs, ftxTFMItemIds,
      sbylInventory, sbylADS, sbylOpenPOs, sbylTFMItemIds,
      sbylRPKG,
    ] = await Promise.all([
      getInventoryFTX(),
      getADSFTX(),
      getOpenPOsFTX(mergeHorizonDate),
      getTFMVendorItemIdsFTX(config.poSchedule.tfmVendorIdFTX),
      getInventorySBYL(),
      getADSSBYL(),
      getOpenPOsSBYL(mergeHorizonDate),
      getTFMVendorItemIdsSBYL(config.poSchedule.tfmVendorIdSBYL),
      getRPKGComponentsSBYL(config.poSchedule.tfmVendorIdSBYL),
    ])

    // Lookup maps
    const ftxInvBySKU = new Map(ftxInventory.map(i => [i.sku, i.totalUnits]))
    const ftxADSByItemId = new Map(ftxADS.map(a => [a.itemId, a.ads]))
    const ftxADSBySKU = new Map(ftxADS.map(a => [a.sku, a.ads]))
    const sbylInvByItemId = new Map(sbylInventory.map(i => [i.itemId, i.totalUnits]))
    const sbylInvBySKU = new Map(sbylInventory.map(i => [i.sku, i.totalUnits]))
    const sbylADSByItemId = new Map(sbylADS.map(a => [a.itemId, a.ads]))
    const sbylADSBySKU = new Map(sbylADS.map(a => [a.sku, a.ads]))

    // RPKG lookup: componentItemId → mapping (one-to-one for TFM components)
    const rpkgByComponentId = new Map(sbylRPKG.map(r => [r.componentItemId, r]))
    const rpkgByMasterSku = new Map(sbylRPKG.map(r => [r.masterSku, r]))
    const rpkgComponentItemIds = new Set(sbylRPKG.map(r => r.componentItemId))
    // Master item IDs must also be excluded from regular established items —
    // purchasing is done at the component level only; the master (assembled) SKU
    // never needs its own PO and should not appear in the demand review at all.
    const rpkgMasterItemIds = new Set(sbylRPKG.map(r => r.masterItemId))

    // Product name lookup from ERP POs (best source we have for established items too)
    const skuToProductName = new Map<string, string>()
    for (const po of [...ftxOpenPOs, ...sbylOpenPOs]) {
      if (po.productName && !skuToProductName.has(po.sku)) skuToProductName.set(po.sku, po.productName)
    }

    // Established items: ADS > 0 AND linked to TFM vendor via VNIT
    // These use raw on-hand inventory — Load Demand output is never affected by adjustFromDate.
    const ftxEstablished = ftxInventory
      .filter(i => (ftxADSByItemId.get(i.itemId) ?? 0) > 0 && ftxTFMItemIds.has(i.itemId))
      .map(i => ({
        itemId: i.itemId,
        sku: i.sku,
        productName: skuToProductName.get(i.sku) ?? i.sku,
        currentInventory: i.totalUnits,
        ads: ftxADSByItemId.get(i.itemId)!,
        company: 'FTX' as const,
        isRpkg: false,
        masterSku: undefined as string | undefined,
      }))

    // SBYL established: split into regular items and RPKG component items
    // Regular: ADS > 0, TFM-linked, NOT an RPKG component AND NOT an RPKG master.
    const sbylRegularEstablished = sbylInventory
      .filter(i =>
        (sbylADSByItemId.get(i.itemId) ?? 0) > 0 &&
        sbylTFMItemIds.has(i.itemId) &&
        !rpkgComponentItemIds.has(i.itemId) &&
        !rpkgMasterItemIds.has(i.itemId)
      )
      .map(i => ({
        itemId: i.itemId,
        sku: i.sku,
        productName: skuToProductName.get(i.sku) ?? i.sku,
        currentInventory: i.totalUnits,
        ads: sbylADSByItemId.get(i.itemId)!,
        company: 'SBYL' as const,
        isRpkg: false,
        masterSku: undefined as string | undefined,
      }))

    // RPKG: TFM-sourced component items — use master ADS + effective inventory
    const sbylRPKGEstablished = sbylRPKG
      .filter(r => sbylTFMItemIds.has(r.componentItemId))
      .map(r => {
        const masterInv   = sbylInvByItemId.get(r.masterItemId) ?? 0
        const compInv     = sbylInvByItemId.get(r.componentItemId) ?? 0
        const effectiveInv = masterInv + compInv * r.quantity
        const masterADS   = sbylADSByItemId.get(r.masterItemId) ?? 0
        return {
          itemId: r.componentItemId,
          sku: r.componentSku,
          productName: r.componentName,
          currentInventory: effectiveInv,
          ads: masterADS,
          company: 'SBYL' as const,
          isRpkg: true,
          masterSku: r.masterSku,
        }
      })
      .filter(r => r.ads > 0)

    const sbylEstablished = [...sbylRegularEstablished, ...sbylRPKGEstablished]

    // Build committed arrivals from selected open POs — keyed by itemId.
    // These are credited at their ETA dates in the DOC simulation so the generator
    // produces fewer/later desired demand orders for those SKUs.
    const selectedFTXPOSet = new Set(
      selectedOpenPOs.filter(p => p.company === 'FTX').map(p => `${p.poId}-${p.poItemId}`)
    )
    const selectedSBYLPOSet = new Set(
      selectedOpenPOs.filter(p => p.company === 'SBYL').map(p => `${p.poId}-${p.poItemId}`)
    )
    const ftxArrivalsById = new Map<number, Array<{ eta: Date; qty: number }>>()
    const sbylArrivalsById = new Map<number, Array<{ eta: Date; qty: number }>>()
    for (const po of ftxOpenPOs) {
      if (selectedFTXPOSet.has(`${po.poId}-${po.poItemId}`)) {
        const arr = ftxArrivalsById.get(po.itemId) ?? []
        arr.push({ eta: po.eta, qty: po.qty })
        ftxArrivalsById.set(po.itemId, arr)
      }
    }
    for (const po of sbylOpenPOs) {
      if (selectedSBYLPOSet.has(`${po.poId}-${po.poItemId}`)) {
        const arr = sbylArrivalsById.get(po.itemId) ?? []
        arr.push({ eta: po.eta, qty: po.qty })
        sbylArrivalsById.set(po.itemId, arr)
      }
    }

    // Attach committed arrivals to established items before running the generator
    const ftxEstablishedWithArrivals = ftxEstablished.map(i => ({
      ...i,
      committedArrivals: ftxArrivalsById.get(i.itemId),
    }))
    const sbylEstablishedWithArrivals = sbylEstablished.map(i => ({
      ...i,
      committedArrivals: sbylArrivalsById.get(i.itemId),
    }))

    // Run POScheduleGenerator with raw inventory + selected PO arrivals — used for Load Demand display.
    const generator = new POScheduleGenerator({
      minDOC,
      maxDOC,
      minOrderQty: config.poSchedule.minOrderQty,
      maxOrderQty: config.poSchedule.maxOrderQty,
      cutoffDate,
    })
    const ftxGenerated = generator.generate(ftxEstablishedWithArrivals)
    const sbylGenerated = generator.generate(sbylEstablishedWithArrivals)

    // Run a second generator to the full merge horizon (1 year) — this gives merge-preview
    // a target date for every existing ITPO line, even low-ADS items whose next PO falls
    // well beyond the user's display cutoff. The cutoff date only filters what's shown.
    const mergeGenerator = new POScheduleGenerator({
      minDOC,
      maxDOC,
      minOrderQty: config.poSchedule.minOrderQty,
      maxOrderQty: config.poSchedule.maxOrderQty,
      cutoffDate: mergeHorizonDate,
    })
    const ftxMergeLines = mergeGenerator.generate(ftxEstablishedWithArrivals)
    const sbylMergeLines = mergeGenerator.generate(sbylEstablishedWithArrivals)

    // New product items: ADS = 0, has open TFM-vendor PO, NOT an RPKG component
    const ftxADSItemIds = new Set(ftxADS.filter(a => a.ads > 0).map(a => a.itemId))
    const sbylADSItemIds = new Set(sbylADS.filter(a => a.ads > 0).map(a => a.itemId))
    // All new-product POs up to merge horizon (used for merge-preview so nothing is spuriously excluded)
    const ftxAllNewProductPOs = ftxOpenPOs.filter(po => !ftxADSItemIds.has(po.itemId))
    const sbylAllNewProductPOs = sbylOpenPOs.filter(po =>
      !sbylADSItemIds.has(po.itemId) && !rpkgComponentItemIds.has(po.itemId)
    )
    // Display-only subset: filter to cutoff date so the review table isn't cluttered with far-future POs.
    // Exclude POs the user has already explicitly selected — they appear as 'SelectedPO' instead.
    const ftxNewProductPOs = ftxAllNewProductPOs.filter(po =>
      po.eta <= cutoffDate && !selectedFTXPOSet.has(`${po.poId}-${po.poItemId}`)
    )
    const sbylNewProductPOs = sbylAllNewProductPOs.filter(po =>
      po.eta <= cutoffDate && !selectedSBYLPOSet.has(`${po.poId}-${po.poItemId}`)
    )

    // Pre-compute selected PO arrays (used for allSKUs lookup and reviewItems)
    const selectedFTXPOsList = ftxOpenPOs.filter(po => selectedFTXPOSet.has(`${po.poId}-${po.poItemId}`))
    const selectedSBYLPOsList = sbylOpenPOs.filter(po => selectedSBYLPOSet.has(`${po.poId}-${po.poItemId}`))

    // All open ERP ITpos with ETA ≤ adjustFromDate — these are accepted committed orders.
    // ftxOpenPOs/sbylOpenPOs are already filtered to TFM vendor (VNDR_ID), so no extra filter needed.
    const committedFTXPOs  = adjustFromDate ? ftxOpenPOs.filter(po => po.eta  <= adjustFromDate) : []
    const committedSBYLPOs = adjustFromDate ? sbylOpenPOs.filter(po => po.eta <= adjustFromDate) : []

    // Resolve TFM item IDs for all demand SKUs (including committed item SKUs)
    const allSKUs = Array.from(new Set([
      ...ftxGenerated.map(g => g.sku),
      ...sbylGenerated.map(g => g.sku),
      ...ftxNewProductPOs.map(p => p.sku),
      ...sbylNewProductPOs.map(p => p.sku),
      ...committedFTXPOs.map(p => p.sku),
      ...committedSBYLPOs.map(p => p.sku),
      ...selectedFTXPOsList.map(p => p.sku),
      ...selectedSBYLPOsList.map(p => p.sku),
    ]))
    const tfmItemMap = await getTFMItemsBySKU(allSKUs)
    const tfmIds = Array.from(tfmItemMap.values()).map(v => v.tfmItemId)
    const recipes = await getRecipes(tfmIds)
    const supplyItems = await buildSupplyItems()
    const substituteIdMap = buildSubstituteItemIdMap(config.production.substitutes, supplyItems)

    // Build unified demand review items:
    //   - Generated lines (established items, both companies) — the desired PO schedule
    //   - New product ERP POs (both companies) — existing commitments for ADS=0 items
    type ReviewItem = {
      demandId: string
      type: 'Generated' | 'NewProductPO' | 'SelectedPO'
      company: 'FTX' | 'SBYL'
      sku: string
      productName: string
      category: string
      recommendedETA: Date
      qty: number
      ads: number
      currentInventory: number
      projectedDOCAtTrigger: number
      poId: number
      poItemId: number
      poNumber: string
      isNewProduct: boolean
      isRpkg: boolean
      masterSku: string | undefined
      isLocked?: boolean   // true for committed ERP ITpos shown as locked calendar entries
    }

    const reviewItems: ReviewItem[] = [
      ...ftxGenerated.map(g => ({
        demandId: `gen-FTX-${g.sku}-${g.arrivalDate.toISOString().split('T')[0]}`,
        type: 'Generated' as const,
        company: 'FTX' as const,
        sku: g.sku,
        productName: g.productName,
        category: tfmItemMap.get(g.sku)?.category ?? '',
        recommendedETA: g.arrivalDate,
        qty: g.orderedQty,
        ads: g.ads,
        currentInventory: g.currentInventory,
        projectedDOCAtTrigger: g.projectedDOCAtTrigger,
        poId: 0,
        poItemId: 0,
        poNumber: '',
        isNewProduct: false,
        isRpkg: false,
        masterSku: undefined,
      })),
      ...sbylGenerated.map(g => {
        const rpkg = rpkgByComponentId.get(
          sbylEstablished.find(e => e.sku === g.sku)?.itemId ?? -1
        )
        return {
          demandId: `gen-SBYL-${g.sku}-${g.arrivalDate.toISOString().split('T')[0]}`,
          type: 'Generated' as const,
          company: 'SBYL' as const,
          sku: g.sku,
          productName: g.productName,
          category: tfmItemMap.get(g.sku)?.category ?? '',
          recommendedETA: g.arrivalDate,
          qty: g.orderedQty,
          ads: g.ads,
          currentInventory: g.currentInventory,
          projectedDOCAtTrigger: g.projectedDOCAtTrigger,
          poId: 0,
          poItemId: 0,
          poNumber: '',
          isNewProduct: false,
          isRpkg: !!rpkg,
          masterSku: rpkg?.masterSku,
        }
      }),
      ...ftxNewProductPOs.map(po => ({
        demandId: `erp-${po.poId}-${po.poItemId}`,
        type: 'NewProductPO' as const,
        company: 'FTX' as const,
        sku: po.sku,
        productName: po.productName,
        category: tfmItemMap.get(po.sku)?.category ?? '',
        recommendedETA: po.eta,
        qty: po.qty,
        ads: 0,
        currentInventory: ftxInvBySKU.get(po.sku) ?? 0,
        projectedDOCAtTrigger: 0,
        poId: po.poId,
        poItemId: po.poItemId,
        poNumber: po.poNumber,
        isNewProduct: true,
        isRpkg: false,
        masterSku: undefined,
      })),
      ...sbylNewProductPOs.map(po => ({
        demandId: `erp-${po.poId}-${po.poItemId}`,
        type: 'NewProductPO' as const,
        company: 'SBYL' as const,
        sku: po.sku,
        productName: po.productName,
        category: tfmItemMap.get(po.sku)?.category ?? '',
        recommendedETA: po.eta,
        qty: po.qty,
        ads: 0,
        currentInventory: sbylInvBySKU.get(po.sku) ?? 0,
        projectedDOCAtTrigger: 0,
        poId: po.poId,
        poItemId: po.poItemId,
        poNumber: po.poNumber,
        isNewProduct: true,
        isRpkg: false,
        masterSku: undefined,
      })),
      // Selected open POs — chosen by user before clicking Load Demand.
      // Shown in results with their own badge; already factored into the DOC simulation.
      ...selectedFTXPOsList.map(po => ({
        demandId: `selected-FTX-${po.poId}-${po.poItemId}`,
        type: 'SelectedPO' as const,
        company: 'FTX' as const,
        sku: po.sku,
        productName: po.productName,
        category: tfmItemMap.get(po.sku)?.category ?? '',
        recommendedETA: po.eta,
        qty: po.qty,
        ads: ftxADSByItemId.get(po.itemId) ?? 0,
        currentInventory: ftxInvBySKU.get(po.sku) ?? 0,
        projectedDOCAtTrigger: 0,
        poId: po.poId,
        poItemId: po.poItemId,
        poNumber: po.poNumber,
        isNewProduct: !ftxADSItemIds.has(po.itemId),
        isRpkg: false,
        masterSku: undefined,
      })),
      ...selectedSBYLPOsList.map(po => ({
        demandId: `selected-SBYL-${po.poId}-${po.poItemId}`,
        type: 'SelectedPO' as const,
        company: 'SBYL' as const,
        sku: po.sku,
        productName: po.productName,
        category: tfmItemMap.get(po.sku)?.category ?? '',
        recommendedETA: po.eta,
        qty: po.qty,
        ads: sbylADSByItemId.get(po.itemId) ?? 0,
        currentInventory: sbylInvBySKU.get(po.sku) ?? 0,
        projectedDOCAtTrigger: 0,
        poId: po.poId,
        poItemId: po.poItemId,
        poNumber: po.poNumber,
        isNewProduct: !sbylADSItemIds.has(po.itemId),
        isRpkg: false,
        masterSku: undefined,
      })),
    ]

    // Annotate review items with hasRecipe flag (used in both phases)
    const reviewItemsAnnotated = reviewItems.map(item => {
      const tfmId = tfmItemMap.get(item.sku)?.tfmItemId
      const recipe = tfmId ? (recipes.get(tfmId) ?? []) : []
      return { ...item, hasRecipe: recipe.length > 0, tfmLinked: !!tfmId }
    })

    const baseSummary = {
      ftxEstablishedCount: ftxGenerated.length,
      sbylEstablishedCount: sbylGenerated.length,
      ftxNewProductCount: ftxNewProductPOs.length,
      sbylNewProductCount: sbylNewProductPOs.length,
      totalDemandItems: reviewItems.length,
      noRecipeCount: reviewItemsAnnotated.filter(r => !r.hasRecipe && r.tfmLinked).length,
    }

    // Build future-PO lists per SKU (for the "Next PO" column in Load Demand view).
    // Uses the already-fetched open POs (full merge horizon) — no extra DB call needed.
    const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0)
    const ftxFuturePOsBySKU = new Map<string, Array<{ poId: number; poItemId: number; poNumber: string; eta: Date; qty: number; draftCompleted: boolean }>>()
    for (const po of ftxOpenPOs) {
      if (po.eta < todayMidnight) continue
      const arr = ftxFuturePOsBySKU.get(po.sku) ?? []
      arr.push({ poId: po.poId, poItemId: po.poItemId, poNumber: po.poNumber, eta: po.eta, qty: po.qty, draftCompleted: !!(po as any).draftCompleted })
      ftxFuturePOsBySKU.set(po.sku, arr)
    }
    for (const [, list] of ftxFuturePOsBySKU) list.sort((a, b) => a.eta.getTime() - b.eta.getTime())

    const sbylFuturePOsBySKU = new Map<string, Array<{ poId: number; poItemId: number; poNumber: string; eta: Date; qty: number; draftCompleted: boolean }>>()
    for (const po of sbylOpenPOs) {
      if (po.eta < todayMidnight) continue
      const arr = sbylFuturePOsBySKU.get(po.sku) ?? []
      arr.push({ poId: po.poId, poItemId: po.poItemId, poNumber: po.poNumber, eta: po.eta, qty: po.qty, draftCompleted: !!(po as any).draftCompleted })
      sbylFuturePOsBySKU.set(po.sku, arr)
    }
    for (const [, list] of sbylFuturePOsBySKU) list.sort((a, b) => a.eta.getTime() - b.eta.getTime())

    const reviewItemsWithPOs = reviewItemsAnnotated.map(item => ({
      ...item,
      futurePOs: (item.company === 'FTX' ? ftxFuturePOsBySKU : sbylFuturePOsBySKU).get(item.sku) ?? [],
    }))

    // Phase 1: return demand review list only (no schedule yet)
    if (!generateSchedule) {
      return NextResponse.json(serializeDates({ reviewItems: reviewItemsWithPOs, summary: baseSummary }))
    }

    // Phase 2: if adjustFromDate is set, re-run the generator with projected inventory
    // (on-hand + committed ERP POs arriving by adjustFromDate) starting from that date.
    // This is the schedule generation logic — Load Demand is NOT affected.

    // Selected POs are always locked to their ERP dates in the production schedule —
    // they are committed factory orders just like adjustFromDate committed items.
    // Build the locked versions here so both paths (with/without adjustFromDate) can use them.
    const selectedPOScheduleItems: typeof reviewItemsAnnotated = [
      ...selectedFTXPOsList.map(po => {
        const tfmId = tfmItemMap.get(po.sku)?.tfmItemId
        const recipe = tfmId ? (recipes.get(tfmId) ?? []) : []
        return {
          demandId: `selected-FTX-${po.poId}-${po.poItemId}`,
          type: 'SelectedPO' as const,
          company: 'FTX' as const,
          sku: po.sku, productName: po.productName,
          category: tfmItemMap.get(po.sku)?.category ?? '',
          recommendedETA: po.eta, qty: po.qty,
          ads: ftxADSByItemId.get(po.itemId) ?? 0,
          currentInventory: ftxInvBySKU.get(po.sku) ?? 0,
          projectedDOCAtTrigger: 0,
          poId: po.poId, poItemId: po.poItemId, poNumber: po.poNumber,
          isNewProduct: false, isRpkg: false, masterSku: undefined as string | undefined,
          hasRecipe: recipe.length > 0, tfmLinked: !!tfmId,
          isLocked: true,
        }
      }),
      ...selectedSBYLPOsList.map(po => {
        const tfmId = tfmItemMap.get(po.sku)?.tfmItemId
        const recipe = tfmId ? (recipes.get(tfmId) ?? []) : []
        return {
          demandId: `selected-SBYL-${po.poId}-${po.poItemId}`,
          type: 'SelectedPO' as const,
          company: 'SBYL' as const,
          sku: po.sku, productName: po.productName,
          category: tfmItemMap.get(po.sku)?.category ?? '',
          recommendedETA: po.eta, qty: po.qty,
          ads: sbylADSByItemId.get(po.itemId) ?? 0,
          currentInventory: sbylInvBySKU.get(po.sku) ?? 0,
          projectedDOCAtTrigger: 0,
          poId: po.poId, poItemId: po.poItemId, poNumber: po.poNumber,
          isNewProduct: false, isRpkg: false, masterSku: undefined as string | undefined,
          hasRecipe: recipe.length > 0, tfmLinked: !!tfmId,
          isLocked: true,
        }
      }),
    ]

    // Default: use reviewItemsAnnotated but replace SelectedPO items with their locked versions
    let scheduleEffectiveItems: typeof reviewItemsAnnotated = [
      ...reviewItemsAnnotated.filter(r => r.type !== 'SelectedPO'),
      ...selectedPOScheduleItems,
    ]

    // committedSupplyDeductions: committed ERP ITPos that will pre-deplete supply
    // before the scheduler runs. They are NOT placed in the calendar — they are
    // accepted background production. Supply is depleted in date order so later
    // generated items see the correct available stock.
    const committedSupplyDeductions: Array<{ qty: number; targetDate: Date; recipe: any[] }> = []

    if (adjustFromDate) {
      // Build committed PO quantities (ETA <= adjustFromDate) from already-fetched open POs
      const ftxCommitted  = new Map<number, number>()
      const sbylCommitted = new Map<number, number>()
      for (const po of ftxOpenPOs)  { if (po.eta <= adjustFromDate) ftxCommitted.set(po.itemId,  (ftxCommitted.get(po.itemId)  ?? 0) + po.qty) }
      for (const po of sbylOpenPOs) { if (po.eta <= adjustFromDate) sbylCommitted.set(po.itemId, (sbylCommitted.get(po.itemId) ?? 0) + po.qty) }

      // Projected established items: on-hand + committed POs arriving by adjustFromDate
      const ftxEstablishedProj = ftxEstablished.map(i => ({
        ...i, currentInventory: i.currentInventory + (ftxCommitted.get(i.itemId) ?? 0),
      }))
      const sbylEstablishedProj = sbylEstablished.map(i => {
        if (!i.isRpkg) return { ...i, currentInventory: i.currentInventory + (sbylCommitted.get(i.itemId) ?? 0) }
        const rpkg = sbylRPKG.find(r => r.componentItemId === i.itemId)
        const masterCommitted = rpkg ? (sbylCommitted.get(rpkg.masterItemId) ?? 0) : 0
        const compCommitted   = sbylCommitted.get(i.itemId) ?? 0
        return { ...i, currentInventory: i.currentInventory + masterCommitted + compCommitted }
      })

      // Re-run generator with projected inventory, starting from adjustFromDate
      const scheduleGenerator = new POScheduleGenerator({
        minDOC, maxDOC,
        minOrderQty: config.poSchedule.minOrderQty,
        maxOrderQty: config.poSchedule.maxOrderQty,
        cutoffDate,
        startDate: new Date(adjustFromDate),
      })
      const ftxScheduleGenerated  = scheduleGenerator.generate(ftxEstablishedProj)
      const sbylScheduleGenerated = scheduleGenerator.generate(sbylEstablishedProj)

      // Committed ERP ITPos — shown in the calendar as locked entries on their actual dates.
      // They are accepted background production; the scheduler force-deducts their supply
      // so that generated items see correctly-depleted stock.
      const committedReviewItems: typeof reviewItemsAnnotated = [
        ...committedFTXPOs.map(po => {
          const tfmId = tfmItemMap.get(po.sku)?.tfmItemId
          const recipe = tfmId ? (recipes.get(tfmId) ?? []) : []
          return {
            demandId: `committed-FTX-${po.poId}-${po.poItemId}`,
            type: 'Generated' as const,
            company: 'FTX' as const,
            sku: po.sku, productName: po.productName,
            category: tfmItemMap.get(po.sku)?.category ?? '',
            recommendedETA: po.eta, qty: po.qty,
            ads: ftxADSByItemId.get(po.itemId) ?? 0,
            currentInventory: ftxInvBySKU.get(po.sku) ?? 0,
            projectedDOCAtTrigger: 0,
            poId: po.poId, poItemId: po.poItemId, poNumber: po.poNumber,
            isNewProduct: false, isRpkg: false, masterSku: undefined as string | undefined,
            hasRecipe: recipe.length > 0, tfmLinked: !!tfmId,
            isLocked: true,
          }
        }),
        ...committedSBYLPOs.map(po => {
          const tfmId = tfmItemMap.get(po.sku)?.tfmItemId
          const recipe = tfmId ? (recipes.get(tfmId) ?? []) : []
          return {
            demandId: `committed-SBYL-${po.poId}-${po.poItemId}`,
            type: 'Generated' as const,
            company: 'SBYL' as const,
            sku: po.sku, productName: po.productName,
            category: tfmItemMap.get(po.sku)?.category ?? '',
            recommendedETA: po.eta, qty: po.qty,
            ads: sbylADSByItemId.get(po.itemId) ?? 0,
            currentInventory: sbylInvBySKU.get(po.sku) ?? 0,
            projectedDOCAtTrigger: 0,
            poId: po.poId, poItemId: po.poItemId, poNumber: po.poNumber,
            isNewProduct: false, isRpkg: false, masterSku: undefined as string | undefined,
            hasRecipe: recipe.length > 0, tfmLinked: !!tfmId,
            isLocked: true,
          }
        }),
      ]

      // Generated items from adjustFromDate forward + new product POs (unchanged)
      const projectedItems = [
        ...ftxScheduleGenerated.map(g => ({
          ...reviewItemsAnnotated.find(r => r.sku === g.sku && r.company === 'FTX') ?? {},
          demandId: `gen-FTX-${g.sku}-${g.arrivalDate.toISOString().split('T')[0]}`,
          sku: g.sku, company: 'FTX' as const,
          recommendedETA: g.arrivalDate, qty: g.orderedQty,
          ads: g.ads, currentInventory: g.currentInventory,
          isNewProduct: false, isRpkg: false, isLocked: false,
        })),
        ...sbylScheduleGenerated.map(g => ({
          ...reviewItemsAnnotated.find(r => r.sku === g.sku && r.company === 'SBYL') ?? {},
          demandId: `gen-SBYL-${g.sku}-${g.arrivalDate.toISOString().split('T')[0]}`,
          sku: g.sku, company: 'SBYL' as const,
          recommendedETA: g.arrivalDate, qty: g.orderedQty,
          ads: g.ads, currentInventory: g.currentInventory,
          isNewProduct: false, isRpkg: false, isLocked: false,
        })),
        // Only include new-product POs with ETA after adjustFromDate — those before it
        // are already covered by committedFTXPOs/committedSBYLPOs above
        ...reviewItemsAnnotated.filter(r => r.isNewProduct && (!adjustFromDate || r.recommendedETA > adjustFromDate)),
      ] as typeof reviewItemsAnnotated

      // Committed + selected PO items first (both locked) so supply is deducted at their
      // ERP dates before generated items are placed.
      scheduleEffectiveItems = [...committedReviewItems, ...selectedPOScheduleItems, ...projectedItems]
    }

    // Phase 2: apply ETA + qty overrides, then run full pipeline
    const effectiveItems = scheduleEffectiveItems.map(item => {
      let result: typeof item = item
      const etaOverride = etaOverrides[item.demandId]
      if (etaOverride) result = { ...result, recommendedETA: new Date(etaOverride) }
      const qtyOverride = qtyOverrides[item.demandId]
      if (qtyOverride != null && qtyOverride > 0) result = { ...result, qty: qtyOverride }
      return result
    })

    // Build placement inputs — items with no recipe are excluded from scheduling
    type NoRecipeItem = {
      demandId: string; sku: string; productName: string; company: string
      qty: number; recommendedETA: Date; poNumber: string; isNewProduct: boolean
    }
    const noRecipeItems: NoRecipeItem[] = []
    const placementInputs: Array<{
      demandId: string; poId: number; poItemId: number; poNumber: string
      sku: string; itemId: number; productName: string; company: 'FTX' | 'SBYL'
      orderedQty: number; targetDate: Date; isLocked: boolean; isNewProduct: boolean
      ads: number; currentInventory: number; currentDOC: number; recipe: any[]; optimizerWarnings: any[]
    }> = []

    for (const item of effectiveItems) {
      const isCommitted = item.isLocked === true

      // Skip past-due generated items — committed items always included (they're locked productions)
      if (!isCommitted && item.recommendedETA < today) continue
      // Skip items not linked to TFM — committed items included regardless
      if (!isCommitted && !tfmItemMap.has(item.sku)) continue

      const tfmId = tfmItemMap.get(item.sku)?.tfmItemId
      const recipe = tfmId ? (recipes.get(tfmId) ?? []) : []

      if (recipe.length === 0) {
        if (!isCommitted) {
          // Flag allowed categories (mattresses etc.) for the no-recipe panel
          const isAllowedCategory = config.production.feasibilityAllowedCategories.includes(item.category)
          if (isAllowedCategory) {
            noRecipeItems.push({
              demandId: item.demandId,
              sku: item.sku,
              productName: item.productName,
              company: item.company,
              qty: item.qty,
              recommendedETA: item.recommendedETA,
              poNumber: item.poNumber,
              isNewProduct: item.isNewProduct,
            })
          }
          continue
        }
        // Committed + no recipe: fall through — placed as NoRecipe-locked, no supply deduction
      }

      const inv = item.company === 'FTX' ? (ftxInvBySKU.get(item.sku) ?? 0) : (sbylInvBySKU.get(item.sku) ?? 0)
      const ads = item.company === 'FTX' ? (ftxADSBySKU.get(item.sku) ?? 0) : (sbylADSBySKU.get(item.sku) ?? 0)
      const doc = ads > 0 ? inv / ads : Infinity
      // Committed items use their actual ERP ETA — show on the date ERP says, even if in the past.
      // Generated / new-product items are clamped to adjustFromDate so none land before it.
      const effectiveETA = isCommitted
        ? new Date(item.recommendedETA)
        : new Date(Math.max(item.recommendedETA.getTime(), today.getTime(), adjustFromDate ? adjustFromDate.getTime() : 0))

      placementInputs.push({
        demandId: item.demandId,
        poId: item.poId,
        poItemId: item.poItemId,
        poNumber: item.poNumber,
        sku: item.sku,
        itemId: tfmId ?? 0,
        productName: item.productName,
        company: item.company,
        orderedQty: item.qty,
        targetDate: effectiveETA,
        isLocked: isCommitted,
        isNewProduct: item.isNewProduct,
        ads,
        currentInventory: inv,
        currentDOC: doc,
        recipe,
        optimizerWarnings: [],
      })
    }

    // Build DemandItems for SupplyAllocationOptimizer
    const demandItems: DemandItem[] = placementInputs.map(p => ({
      id: p.demandId,
      itemId: p.itemId,
      sku: p.sku,
      productName: p.productName,
      company: p.company,
      orderedQty: p.orderedQty,
      eta: p.targetDate,
      sourceType: 'PO',
      sourceRef: p.poNumber || 'Generated',
      isNewProduct: p.isNewProduct,
      ads: p.ads,
      currentInventory: p.currentInventory,
      currentDOC: p.currentDOC,
      // Priority: DOC days for established items, days until ETA for new products
      priorityScore: p.ads > 0
        ? p.currentDOC
        : Math.max(0, Math.round((p.targetDate.getTime() - today.getTime()) / 86400000)),
    }))

    const optimizer = new SupplyAllocationOptimizer(supplyItems, recipes, substituteIdMap)
    const { warnings, results: allocationResults } = optimizer.optimize(demandItems)

    // Build per-demand-item drilldown: recipe lines + allocation details + incoming POs
    const allocationByDemandId = new Map(allocationResults.map(r => [r.demandId, r.allocations]))
    const drilldown: Record<string, object> = {}
    for (const p of placementInputs) {
      const recipe = recipes.get(p.itemId) ?? []
      const alloc  = allocationByDemandId.get(p.demandId) ?? new Map<number, number>()
      drilldown[p.demandId] = recipe.map(ing => {
        const qtyNeeded   = ing.qtyPerUnit * p.orderedQty
        const qtyAlloc    = alloc.get(ing.supplyItemId) ?? 0
        const supplyItem  = supplyItems.get(ing.supplyItemId)
        const canProduce  = ing.qtyPerUnit > 0 ? Math.floor(qtyAlloc / ing.qtyPerUnit) : 0
        return {
          supplyItemId:    ing.supplyItemId,
          sku:             ing.supplySKU,
          name:            ing.supplyName,
          category:        ing.supplyCategory,
          qtyPerUnit:      ing.qtyPerUnit,
          qtyNeeded,
          qtyAllocated:    qtyAlloc,
          canProduceFromThis: canProduce,
          onHand:          supplyItem?.onHandQty ?? 0,
          isBottleneck:    qtyAlloc < qtyNeeded,
          incomingPOs:     (supplyItem?.futurePOs ?? []).map(po => ({
            poNumber: po.poNumber,
            eta:      po.eta instanceof Date ? po.eta.toISOString() : po.eta,
            qty:      po.qty,
          })),
        }
      })
    }

    // Index warnings by demand ID for fast lookup
    const warningsByDemandId = new Map<string, typeof warnings>()
    for (const w of warnings) {
      for (const did of w.affectedDemandIds) {
        const arr = warningsByDemandId.get(did) ?? []
        arr.push(w)
        warningsByDemandId.set(did, arr)
      }
    }
    for (const p of placementInputs) {
      p.optimizerWarnings = warningsByDemandId.get(p.demandId) ?? []
    }

    // Sort by target date before feasibility checks so creditPOsUpTo() always advances
    // forward in time — prevents a later-dated item from incorrectly crediting a PO
    // (e.g. Jun 5 box arrival) into running stock before an earlier item (Jun 3) is checked.
    placementInputs.sort((a, b) => a.targetDate.getTime() - b.targetDate.getTime())

    const feasibilityAnalyzer = new ProductionFeasibilityAnalyzer(supplyItems, { alwaysDeductAvailable: false })
    // Note: committed items (isLocked=true) are sorted to the front by targetDate below,
    // so the scheduler processes them first and deducts their supply before generated items.

    const scheduleAnalyzer = new ProductionScheduleAnalyzer(supplyItems, {
      dailyCapacity: config.production.dailyCapacity,
      cutoffDate,
      freezeDate: adjustFromDate,  // prevents generated items from landing before adjustFromDate
    })

    const { days, droppedItems } = scheduleAnalyzer.buildSchedule(placementInputs, feasibilityAnalyzer)

    // SKUs that have a recipe — used to filter mergeItems so no-recipe items
    // (which get dropped from the production schedule) don't appear in ERP sync.
    const skusWithRecipe = new Set(
      [...ftxMergeLines, ...sbylMergeLines]
        .filter(g => {
          const tfmId = tfmItemMap.get(g.sku)?.tfmItemId
          return tfmId != null && (recipes.get(tfmId) ?? []).length > 0
        })
        .map(g => g.sku)
    )

    // Build the flat merge-items list (full 1-year horizon).
    // Passed directly to merge-preview so it can match every existing ITPO line
    // to a future desired date rather than suggesting spurious excludes.
    const mergeItems = [
      ...ftxMergeLines.filter(g => skusWithRecipe.has(g.sku)).map(g => ({
        demandId: `gen-FTX-${g.sku}-${g.arrivalDate.toISOString().split('T')[0]}`,
        company: 'FTX' as const,
        sku: g.sku,
        productName: g.productName,
        scheduledQty: g.orderedQty,
        scheduledDate: g.arrivalDate.toISOString(),
        isLocked: adjustFromDate != null && g.arrivalDate <= adjustFromDate,
        isNewProduct: false,
        docAtDate: g.projectedDOCAtTrigger,
        feasibilityStatus: '',
        poId: 0, poItemId: 0, poNumber: '',
      })),
      ...sbylMergeLines.filter(g => skusWithRecipe.has(g.sku)).map(g => ({
        demandId: `gen-SBYL-${g.sku}-${g.arrivalDate.toISOString().split('T')[0]}`,
        company: 'SBYL' as const,
        sku: g.sku,
        productName: g.productName,
        scheduledQty: g.orderedQty,
        scheduledDate: g.arrivalDate.toISOString(),
        isLocked: adjustFromDate != null && g.arrivalDate <= adjustFromDate,
        isNewProduct: false,
        docAtDate: g.projectedDOCAtTrigger,
        feasibilityStatus: '',
        poId: 0, poItemId: 0, poNumber: '',
      })),
      ...ftxAllNewProductPOs.map(po => ({
        demandId: `erp-${po.poId}-${po.poItemId}`,
        company: 'FTX' as const,
        sku: po.sku,
        productName: po.productName,
        scheduledQty: po.qty,
        scheduledDate: po.eta.toISOString(),
        isLocked: adjustFromDate != null && po.eta <= adjustFromDate,
        isNewProduct: true,
        docAtDate: 0,
        feasibilityStatus: '',
        poId: po.poId, poItemId: po.poItemId, poNumber: po.poNumber,
      })),
      ...sbylAllNewProductPOs.map(po => ({
        demandId: `erp-${po.poId}-${po.poItemId}`,
        company: 'SBYL' as const,
        sku: po.sku,
        productName: po.productName,
        scheduledQty: po.qty,
        scheduledDate: po.eta.toISOString(),
        isLocked: adjustFromDate != null && po.eta <= adjustFromDate,
        isNewProduct: true,
        docAtDate: 0,
        feasibilityStatus: '',
        poId: po.poId, poItemId: po.poItemId, poNumber: po.poNumber,
      })),
    ]

    return NextResponse.json(serializeDates({
      // Exclude committed locked items from the demand review table — they appear in the calendar
      reviewItems: effectiveItems.filter(i => !i.isLocked),
      days,
      droppedItems,
      noRecipeItems,
      optimizerWarnings: warnings,
      drilldown,
      mergeItems,
      dailyCapacity: config.production.dailyCapacity,
      summary: {
        ...baseSummary,
        noRecipeCount: noRecipeItems.length,
        totalScheduled: days.reduce((s, d) => s + d.items.length, 0),
        movedItems: days.flatMap(d => d.items).filter(i => i.moveReason).length,
        infeasibleLocked: days.flatMap(d => d.items).filter(i => i.isInfeasibleLocked).length,
        overCapacityDays: days.filter(d => d.isOverCapacity).length,
        conflicts: days.filter(d => d.hasConflict).length,
        droppedCount: droppedItems.length,
      },
    }))

  } catch (err: any) {
    console.error('production-schedule/data error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
