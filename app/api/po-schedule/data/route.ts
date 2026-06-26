import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getInventoryFTX, getADSFTX, getOpenPOsFTX, getTFMVendorItemIdsFTX } from '@/lib/db/queries/ftx'
import { getInventorySBYL, getADSSBYL, getOpenPOsSBYL, getTFMVendorItemIdsSBYL, getRPKGComponentsSBYL } from '@/lib/db/queries/sbyl'
import { getTFMItemsBySKU } from '@/lib/db/queries/tfm'
import { getRecipes } from '@/lib/db/queries/tfm-custom'
import { buildSupplyItems, buildSubstituteItemIdMap } from '@/lib/engine/supplyPipeline'
import { POScheduleGenerator } from '@/lib/engine/POScheduleGenerator'
import { POReviewAnalyzer } from '@/lib/engine/POReviewAnalyzer'
import { ProductionFeasibilityAnalyzer } from '@/lib/engine/ProductionFeasibilityAnalyzer'
import { SupplyAllocationOptimizer } from '@/lib/engine/SupplyAllocationOptimizer'
import { config } from '@/lib/config'
import type {
  DemandItem, GeneratedPOLine, POAction, NotFeasibleItem,
  NewProductItem, ERPPOLine,
} from '@/lib/engine/types'

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

function daysBetween(a: Date, b: Date) {
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const {
    company = 'FTX',
    cutoffDate: cutoffStr,
    minDOC = config.poSchedule.minDOC,
    maxDOC = config.poSchedule.maxDOC,
    etaDiffThresholdDays = config.poSchedule.etaDiffThresholdDays,
    qtyDiffThresholdPct = config.poSchedule.qtyDiffThresholdPct,
  } = body

  const cutoffDate = cutoffStr ? new Date(cutoffStr) : (() => {
    const d = new Date()
    d.setMonth(d.getMonth() + config.poReview.defaultMonthsAhead)
    return d
  })()

  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const tfmVendorId = company === 'FTX' ? config.poSchedule.tfmVendorIdFTX : config.poSchedule.tfmVendorIdSBYL

    const [inventory, adsRecords, erpPOs, tfmItemIds, sbylRPKG] = await Promise.all([
      company === 'FTX' ? getInventoryFTX() : getInventorySBYL(),
      company === 'FTX' ? getADSFTX() : getADSSBYL(),
      company === 'FTX' ? getOpenPOsFTX(cutoffDate) : getOpenPOsSBYL(cutoffDate),
      company === 'FTX' ? getTFMVendorItemIdsFTX(config.poSchedule.tfmVendorIdFTX) : getTFMVendorItemIdsSBYL(config.poSchedule.tfmVendorIdSBYL),
      company === 'SBYL' ? getRPKGComponentsSBYL(config.poSchedule.tfmVendorIdSBYL) : Promise.resolve([]),
    ])

    // RPKG lookups (SBYL only)
    const rpkgByComponentId = new Map(sbylRPKG.map(r => [r.componentItemId, r]))
    const rpkgComponentItemIds = new Set(sbylRPKG.map(r => r.componentItemId))
    // Master item IDs: these sell and are TFM-linked, but must never generate a PO —
    // purchasing is at the component level only.
    const rpkgMasterItemIds = new Set(sbylRPKG.map(r => r.masterItemId))

    // Build lookup maps
    const invById = new Map(inventory.map(i => [i.itemId, i.totalUnits]))
    const invBySKU = new Map(inventory.map(i => [i.sku, i.totalUnits]))
    const adsByItemId = new Map(adsRecords.map(a => [a.itemId, a.ads]))
    const adsBySKU = new Map(adsRecords.map(a => [a.sku, a.ads]))

    const uniqueSKUs = Array.from(new Set([
      ...inventory.map(i => i.sku),
      ...erpPOs.map(p => p.sku),
    ]))

    const tfmItemMap = await getTFMItemsBySKU(uniqueSKUs)
    const tfmIds = Array.from(tfmItemMap.values()).map(v => v.tfmItemId)
    const recipes = await getRecipes(tfmIds)
    const supplyItems = await buildSupplyItems()
    const substituteIdMap = buildSubstituteItemIdMap(config.production.substitutes, supplyItems)

    const allowedCats = config.production.feasibilityAllowedCategories

    // Separate new products
    const adsItemIds = new Set(adsRecords.filter(a => a.ads > 0).map(a => a.itemId))
    const newProductItems: NewProductItem[] = []
    const establishedItems: Array<{
      itemId: number; sku: string; productName: string;
      currentInventory: number; ads: number;
    }> = []

    for (const inv of inventory) {
      const ads = adsBySKU.get(inv.sku) ?? 0
      const isRpkgComponent = rpkgComponentItemIds.has(inv.itemId)
      const isNew = ads === 0 && !isRpkgComponent

      if (isNew) {
        // Only surface as a new product if there's already an open PO to the TFM vendor
        const poLines = erpPOs.filter(p => p.sku === inv.sku)
        if (poLines.length > 0) {
          newProductItems.push({
            sku: inv.sku,
            itemId: inv.itemId,
            productName: poLines[0].productName || inv.sku,
            company: company as 'FTX' | 'SBYL',
            openPOLines: poLines.map(p => ({
              poId: p.poId, poItemId: p.poItemId, poNumber: p.poNumber,
              eta: p.eta, qty: p.qty, isNewProduct: true,
              itemId: p.itemId, sku: p.sku, productName: p.productName, category: p.category ?? '',
            })),
          })
        }
        // No open TFM PO → skip entirely (no ADS and no incoming stock)
      } else if (isRpkgComponent && tfmItemIds.has(inv.itemId)) {
        // RPKG component: use master ADS + (master inventory + component inventory)
        const rpkg = rpkgByComponentId.get(inv.itemId)!
        const masterInv = invById.get(rpkg.masterItemId) ?? 0
        const effectiveInv = masterInv + inv.totalUnits * rpkg.quantity
        const masterADS = adsByItemId.get(rpkg.masterItemId) ?? 0
        if (masterADS > 0) {
          establishedItems.push({
            itemId: inv.itemId,
            sku: inv.sku,
            productName: inv.sku,
            currentInventory: effectiveInv,
            ads: masterADS,
          })
        }
      } else if (ads > 0 && tfmItemIds.has(inv.itemId) && !rpkgMasterItemIds.has(inv.itemId)) {
        // Regular established: own ADS > 0, TFM-linked, NOT an RPKG component, NOT an RPKG master.
        // Master SKUs (e.g. MIL-CFB-DL) sell but purchasing is done at component level only.
        establishedItems.push({
          itemId: inv.itemId,
          sku: inv.sku,
          productName: inv.sku,
          currentInventory: inv.totalUnits,
          ads,
        })
      }
    }

    // Also patch skuContextMap for RPKG components when analyzing ERP POs
    // (so review analyzer uses master ADS + effective inventory for those POs)

    // Generate PO schedule for established items
    const generator = new POScheduleGenerator({
      minDOC,
      maxDOC,
      minOrderQty: config.poSchedule.minOrderQty,
      maxOrderQty: config.poSchedule.maxOrderQty,
      cutoffDate,
    })

    const generatedLines = generator.generate(
      establishedItems.map(e => ({ ...e, company: company as 'FTX' | 'SBYL' }))
    )

    // Run feasibility on generated lines
    const feasibilityAnalyzer = new ProductionFeasibilityAnalyzer(supplyItems, {
      alwaysDeductAvailable: false,
    })

    for (const line of generatedLines.sort((a, b) => a.arrivalDate.getTime() - b.arrivalDate.getTime())) {
      const tfmId = tfmItemMap.get(line.sku)?.tfmItemId
      if (!tfmId) { line.feasibilityStatus = 'NoRecipe'; continue }
      const recipe = recipes.get(tfmId) ?? []
      if (!recipe.length) { line.feasibilityStatus = 'NoRecipe'; continue }

      const result = feasibilityAnalyzer.checkFeasibility(line.orderedQty, line.arrivalDate, recipe, line.arrivalDate)
      line.feasibilityStatus = result.status
      line.ingredientDetails = result.ingredientDetails
      if (result.status !== 'Full') {
        line.feasibleDate = feasibilityAnalyzer.findFirstFeasibleDay(
          recipe,
          line.orderedQty,
          result.ingredientDetails.filter(d => d.shortage > 0)
        )
      }
    }

    // Run POReviewAnalyzer on ERP POs
    // For RPKG components, context uses master ADS + effective inventory
    const skuContextMap = new Map(
      erpPOs.map(po => {
        const rpkg = rpkgByComponentId.get(po.itemId)
        if (rpkg) {
          const masterInv   = invById.get(rpkg.masterItemId) ?? 0
          const compInv     = invById.get(po.itemId) ?? 0
          const effectiveInv = masterInv + compInv * rpkg.quantity
          const masterADS   = adsByItemId.get(rpkg.masterItemId) ?? 0
          return [po.itemId, {
            itemId: po.itemId,
            sku: po.sku,
            productName: po.productName ?? '',
            company: company as 'FTX' | 'SBYL',
            currentInventory: effectiveInv,
            ads: masterADS,
            isNewProduct: false,
          }]
        }
        return [po.itemId, {
          itemId: po.itemId,
          sku: po.sku,
          productName: po.productName ?? '',
          company: company as 'FTX' | 'SBYL',
          currentInventory: invById.get(po.itemId) ?? 0,
          ads: adsByItemId.get(po.itemId) ?? 0,
          isNewProduct: (adsByItemId.get(po.itemId) ?? 0) === 0,
        }]
      })
    )
    const reviewAnalyzer = new POReviewAnalyzer({ minDOC, maxDOC })
    const reviewLines = reviewAnalyzer.analyze(erpPOs, skuContextMap)

    // Run optimizer
    const demandItems: DemandItem[] = generatedLines.map(g => {
      const inv = invBySKU.get(g.sku) ?? 0
      const ads = adsBySKU.get(g.sku) ?? 0
      return {
        id: `gen-${g.sku}-${g.arrivalDate.toISOString()}`,
        itemId: tfmItemMap.get(g.sku)?.tfmItemId ?? -1,
        sku: g.sku,
        productName: g.productName,
        company: company as 'FTX' | 'SBYL',
        orderedQty: g.orderedQty,
        eta: g.arrivalDate,
        sourceType: 'PO',
        sourceRef: 'Generated',
        isNewProduct: false,
        ads,
        currentInventory: inv,
        currentDOC: ads > 0 ? inv / ads : Infinity,
        priorityScore: ads > 0 ? inv / ads : 999,
      }
    })

    const optimizer = new SupplyAllocationOptimizer(supplyItems, recipes, substituteIdMap)
    const { warnings: optimizerWarnings } = optimizer.optimize(demandItems)

    // Match generated vs ERP POs
    const createActions: POAction[] = []
    const updateActions: POAction[] = []
    const excessActions: POAction[] = []
    const notFeasibleItems: NotFeasibleItem[] = []
    const unresolvedPOs: GeneratedPOLine[] = []

    // Group by SKU
    const generatedBySKU = new Map<string, GeneratedPOLine[]>()
    for (const g of generatedLines) {
      const arr = generatedBySKU.get(g.sku) ?? []
      arr.push(g)
      generatedBySKU.set(g.sku, arr)
    }

    const erpBySKU = new Map<string, ERPPOLine[]>()
    for (const p of erpPOs) {
      const arr = erpBySKU.get(p.sku) ?? []
      arr.push(p)
      erpBySKU.set(p.sku, arr)
    }

    const allSKUs = new Set([...Array.from(generatedBySKU.keys()), ...Array.from(erpBySKU.keys())])
    for (const sku of Array.from(allSKUs)) {
      const genList = (generatedBySKU.get(sku) ?? []).sort((a, b) => a.arrivalDate.getTime() - b.arrivalDate.getTime())
      const erpList = (erpBySKU.get(sku) ?? []).sort((a, b) => a.eta.getTime() - b.eta.getTime())
      const ctx = establishedItems.find(e => e.sku === sku)
      const inv = invBySKU.get(sku) ?? 0
      const ads = adsBySKU.get(sku) ?? 0
      const doc = ads > 0 ? inv / ads : Infinity

      const maxLen = Math.max(genList.length, erpList.length)
      for (let i = 0; i < maxLen; i++) {
        const gen = genList[i]
        const erp = erpList[i]

        if (gen && !erp) {
          // Create
          const infeasDelta = gen.feasibleDate ? daysBetween(gen.arrivalDate, gen.feasibleDate) : 0
          const createETA = infeasDelta > 0 ? gen.feasibleDate! : gen.arrivalDate
          createActions.push({
            actionType: 'Create',
            sku,
            itemId: gen.itemId,
            productName: gen.productName,
            company: company as 'FTX' | 'SBYL',
            recommendedETA: createETA,
            recommendedQty: gen.orderedQty,
            reason: `Replenishment needed. Projected DOC at trigger: ${gen.projectedDOCAtTrigger.toFixed(1)} days`,
            currentInventory: inv,
            currentDOC: doc,
            ads,
            isNewProduct: false,
            feasibilityStatus: gen.feasibilityStatus,
          })
        } else if (!gen && erp) {
          // Excess
          const reviewLine = reviewLines.find(r => r.poId === erp.poId && r.poItemId === erp.poItemId)
          excessActions.push({
            actionType: 'ConsiderCancel',
            sku,
            itemId: erp.itemId,
            productName: erp.productName ?? sku,
            company: company as 'FTX' | 'SBYL',
            poId: erp.poId,
            poItemId: erp.poItemId,
            poNumber: erp.poNumber,
            currentETA: erp.eta,
            currentQty: erp.qty,
            reason: 'No replenishment needed at this time based on current DOC projection',
            currentInventory: inv,
            currentDOC: doc,
            ads,
            isNewProduct: false,
          })
        } else if (gen && erp) {
          // Match — compare
          const etaDiff = Math.abs(daysBetween(gen.arrivalDate, erp.eta))
          const qtyDiffPct = erp.qty > 0 ? Math.abs(gen.orderedQty - erp.qty) / erp.qty * 100 : 0
          const etaNeedsUpdate = etaDiff > etaDiffThresholdDays
          const qtyNeedsUpdate = qtyDiffPct > qtyDiffThresholdPct

          let actionType: POAction['actionType'] = 'UpdateBoth'
          let reason = ''

          if (!etaNeedsUpdate && !qtyNeedsUpdate) continue

          if (etaNeedsUpdate && qtyNeedsUpdate) {
            actionType = 'UpdateBoth'
            reason = `ETA off by ${etaDiff} days; Qty off by ${qtyDiffPct.toFixed(0)}%`
          } else if (etaNeedsUpdate) {
            actionType = 'UpdateETA'
            reason = `ETA off by ${etaDiff} days`
          } else {
            actionType = 'UpdateQty'
            reason = `Qty off by ${qtyDiffPct.toFixed(0)}%`
          }

          const infeasDelta = gen.feasibleDate ? daysBetween(gen.arrivalDate, gen.feasibleDate) : 0
          const recETA = infeasDelta > 0 ? gen.feasibleDate! : gen.arrivalDate

          updateActions.push({
            actionType,
            sku,
            itemId: erp.itemId,
            productName: erp.productName ?? sku,
            company: company as 'FTX' | 'SBYL',
            poId: erp.poId,
            poItemId: erp.poItemId,
            poNumber: erp.poNumber,
            currentETA: erp.eta,
            recommendedETA: recETA,
            currentQty: erp.qty,
            recommendedQty: gen.orderedQty,
            reason,
            currentInventory: inv,
            currentDOC: doc,
            ads,
            isNewProduct: false,
            feasibilityStatus: gen.feasibilityStatus,
          })
        }
      }

      // Not feasible items
      for (const g of genList.filter(g => g.feasibilityStatus === 'None' || g.feasibilityStatus === 'Partial')) {
        const shortageKey = (g.ingredientDetails ?? [])
          .filter(d => d.shortage > 0)
          .map(d => d.supplySKU)
          .sort()
          .join(',')
        notFeasibleItems.push({
          sku: g.sku,
          itemId: g.itemId,
          productName: g.productName,
          company: company as 'FTX' | 'SBYL',
          scheduledQty: g.feasibilityStatus === 'Partial' ? (g.ingredientDetails?.reduce((min, d) => {
            if (d.shortage > 0) return Math.min(min, Math.floor(d.qtyAvailable / d.qtyPerUnit))
            return min
          }, g.orderedQty) ?? 0) : 0,
          orderedQty: g.orderedQty,
          arrivalDate: g.arrivalDate,
          ingredientDetails: g.ingredientDetails ?? [],
          shortageGroupKey: shortageKey,
        })
      }
    }

    return NextResponse.json(serializeDates({
      createActions,
      updateActions,
      excessActions,
      notFeasibleItems,
      newProductItems,
      unresolvedPOs,
      optimizerWarnings,
      generatedLines,
      summary: {
        totalGenerated: generatedLines.length,
        excludedCount: 0,
        newProductCount: newProductItems.length,
      },
    }))
  } catch (err: any) {
    console.error('po-schedule/data error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
