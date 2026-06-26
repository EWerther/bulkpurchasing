import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getInventoryFTX, getADSFTX, getOpenPOsFTX, getTFMVendorItemIdsFTX } from '@/lib/db/queries/ftx'
import { getInventorySBYL, getADSSBYL, getOpenPOsSBYL, getTFMVendorItemIdsSBYL } from '@/lib/db/queries/sbyl'
import { getTFMItemsBySKU } from '@/lib/db/queries/tfm'
import { getRecipes } from '@/lib/db/queries/tfm-custom'
import { buildSupplyItems } from '@/lib/engine/supplyPipeline'
import { POScheduleGenerator } from '@/lib/engine/POScheduleGenerator'
import { ProductionFeasibilityAnalyzer } from '@/lib/engine/ProductionFeasibilityAnalyzer'
import { config } from '@/lib/config'
import type { ERPPOLine } from '@/lib/engine/types'

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

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

export type Urgency = 'critical' | 'urgent' | 'high' | 'medium' | 'watch'
export type ActionType = 'create' | 'update_eta' | 'update_qty' | 'update_both' | 'consider_cancel' | 'on_track' | 'new_product'

function classifyUrgency(currentDOC: number, minDOC: number): Urgency {
  const buffer = currentDOC - minDOC
  if (buffer <= 0) return 'critical'
  if (buffer <= 7) return 'urgent'
  if (buffer <= 14) return 'high'
  if (buffer <= 30) return 'medium'
  return 'watch'
}

function computeDOCProjection(
  currentInventory: number,
  ads: number,
  erpPOs: ERPPOLine[],
  today: Date,
  days = 30,
): Array<{ date: string; doc: number }> {
  if (ads <= 0) {
    // New product — just show flat line with PO arrival
    const proj: Array<{ date: string; doc: number }> = []
    const sortedPOs = [...erpPOs].sort((a, b) => a.eta.getTime() - b.eta.getTime())
    let stock = currentInventory
    let poIdx = 0
    for (let i = 0; i < days; i++) {
      const d = addDays(today, i)
      while (poIdx < sortedPOs.length && sortedPOs[poIdx].eta <= d) {
        stock += sortedPOs[poIdx].qty
        poIdx++
      }
      proj.push({ date: d.toISOString().split('T')[0], doc: stock })
    }
    return proj
  }

  const sortedPOs = [...erpPOs].sort((a, b) => a.eta.getTime() - b.eta.getTime())
  const proj: Array<{ date: string; doc: number }> = []
  let stock = currentInventory
  let poIdx = 0

  for (let i = 0; i < days; i++) {
    const d = addDays(today, i)
    // Apply PO arrivals on or before this day
    while (poIdx < sortedPOs.length && sortedPOs[poIdx].eta <= d) {
      stock += sortedPOs[poIdx].qty
      poIdx++
    }
    // Subtract daily sales (not on day 0)
    if (i > 0) stock -= ads
    proj.push({ date: d.toISOString().split('T')[0], doc: Math.max(0, stock / ads) })
  }
  return proj
}

export interface Recommendation {
  id: string
  urgency: Urgency
  actionType: ActionType
  company: 'FTX' | 'SBYL'
  sku: string
  productName: string
  currentInventory: number
  ads: number
  currentDOC: number
  daysUntilCritical: number
  criticalDate: string | null
  recommendedQty: number
  recommendedETA: string
  feasibilityStatus: 'Full' | 'Partial' | 'None' | 'NoRecipe' | 'Unknown'
  existingPO: { poNumber: string; eta: string; qty: number; poId: number; poItemId: number } | null
  docProjection: Array<{ date: string; doc: number }>
  ingredientDetails: any[]
  reasoning: string
}

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const cutoffDate = new Date(today)
    cutoffDate.setMonth(cutoffDate.getMonth() + config.poReview.defaultMonthsAhead)

    const minDOC = config.poSchedule.minDOC
    const etaDiffThreshold = config.poSchedule.etaDiffThresholdDays
    const qtyDiffThreshold = config.poSchedule.qtyDiffThresholdPct

    // ── Parallel DB fetch ───────────────────────────────────────────────
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

    // ── Lookup maps ─────────────────────────────────────────────────────
    const ftxInvBySKU = new Map(ftxInventory.map(i => [i.sku, i.totalUnits]))
    const ftxADSByItemId = new Map(ftxADS.map(a => [a.itemId, a.ads]))
    const sbylInvBySKU = new Map(sbylInventory.map(i => [i.sku, i.totalUnits]))
    const sbylADSByItemId = new Map(sbylADS.map(a => [a.itemId, a.ads]))

    const skuToProductName = new Map<string, string>()
    for (const po of [...ftxOpenPOs, ...sbylOpenPOs]) {
      if (po.productName && !skuToProductName.has(po.sku)) skuToProductName.set(po.sku, po.productName)
    }

    // ── Established items (ADS > 0 + linked to TFM) ─────────────────────
    const ftxEstablished = ftxInventory
      .filter(i => (ftxADSByItemId.get(i.itemId) ?? 0) > 0 && ftxTFMItemIds.has(i.itemId))
      .map(i => ({
        itemId: i.itemId, sku: i.sku, company: 'FTX' as const,
        productName: skuToProductName.get(i.sku) ?? i.sku,
        currentInventory: i.totalUnits,
        ads: ftxADSByItemId.get(i.itemId)!,
      }))

    const sbylEstablished = sbylInventory
      .filter(i => (sbylADSByItemId.get(i.itemId) ?? 0) > 0 && sbylTFMItemIds.has(i.itemId))
      .map(i => ({
        itemId: i.itemId, sku: i.sku, company: 'SBYL' as const,
        productName: skuToProductName.get(i.sku) ?? i.sku,
        currentInventory: i.totalUnits,
        ads: sbylADSByItemId.get(i.itemId)!,
      }))

    // ── Run generator ────────────────────────────────────────────────────
    const generator = new POScheduleGenerator({
      minDOC,
      maxDOC: config.poSchedule.maxDOC,
      minOrderQty: config.poSchedule.minOrderQty,
      maxOrderQty: config.poSchedule.maxOrderQty,
      cutoffDate,
    })
    const ftxGenerated = generator.generate(ftxEstablished)
    const sbylGenerated = generator.generate(sbylEstablished)

    // First generated order per SKU
    const ftxNextBySKU = new Map<string, typeof ftxGenerated[0]>()
    for (const g of ftxGenerated) { if (!ftxNextBySKU.has(g.sku)) ftxNextBySKU.set(g.sku, g) }
    const sbylNextBySKU = new Map<string, typeof sbylGenerated[0]>()
    for (const g of sbylGenerated) { if (!sbylNextBySKU.has(g.sku)) sbylNextBySKU.set(g.sku, g) }

    // ── ERP POs by SKU ───────────────────────────────────────────────────
    const ftxERPBySKU = new Map<string, ERPPOLine[]>()
    for (const po of ftxOpenPOs) {
      const arr = ftxERPBySKU.get(po.sku) ?? []; arr.push(po); ftxERPBySKU.set(po.sku, arr)
    }
    const sbylERPBySKU = new Map<string, ERPPOLine[]>()
    for (const po of sbylOpenPOs) {
      const arr = sbylERPBySKU.get(po.sku) ?? []; arr.push(po); sbylERPBySKU.set(po.sku, arr)
    }

    // ── TFM lookups for feasibility ──────────────────────────────────────
    const allSKUs = Array.from(new Set([
      ...ftxEstablished.map(e => e.sku),
      ...sbylEstablished.map(e => e.sku),
    ]))
    const tfmItemMap = await getTFMItemsBySKU(allSKUs)
    const tfmIds = Array.from(tfmItemMap.values()).map(v => v.tfmItemId)
    const recipes = await getRecipes(tfmIds)
    const supplyItems = await buildSupplyItems()
    const feasibilityAnalyzer = new ProductionFeasibilityAnalyzer(supplyItems, { alwaysDeductAvailable: false })

    // ── Build recommendation ─────────────────────────────────────────────
    function buildRec(
      item: { itemId: number; sku: string; productName: string; currentInventory: number; ads: number; company: 'FTX' | 'SBYL' },
      erpPOs: ERPPOLine[],
      nextOrder: typeof ftxGenerated[0] | undefined,
    ): Recommendation {
      const currentDOC = item.ads > 0 ? item.currentInventory / item.ads : 999
      const urgency = classifyUrgency(currentDOC, minDOC)
      const daysUntilCritical = Math.max(0, Math.floor(currentDOC - minDOC))
      const criticalDate = item.ads > 0 ? addDays(today, daysUntilCritical).toISOString().split('T')[0] : null

      // Match existing PO to next generator order
      let existingPO: Recommendation['existingPO'] = null
      let actionType: ActionType = 'on_track'

      if (nextOrder) {
        // Find closest ERP PO by ETA
        const sorted = [...erpPOs].sort((a, b) =>
          Math.abs(a.eta.getTime() - nextOrder.arrivalDate.getTime()) -
          Math.abs(b.eta.getTime() - nextOrder.arrivalDate.getTime())
        )
        const match = sorted[0]

        if (!match) {
          actionType = 'create'
        } else {
          existingPO = { poNumber: match.poNumber, eta: match.eta.toISOString(), qty: match.qty, poId: match.poId, poItemId: match.poItemId }
          const etaDiffDays = Math.abs((match.eta.getTime() - nextOrder.arrivalDate.getTime()) / 86400000)
          const qtyDiffPct = match.qty > 0 ? Math.abs(match.qty - nextOrder.orderedQty) / match.qty * 100 : 100
          const etaOff = etaDiffDays > etaDiffThreshold
          const qtyOff = qtyDiffPct > qtyDiffThreshold
          actionType = etaOff && qtyOff ? 'update_both' : etaOff ? 'update_eta' : qtyOff ? 'update_qty' : 'on_track'
        }
      } else if (erpPOs.length > 0) {
        actionType = 'consider_cancel'
        const first = [...erpPOs].sort((a, b) => a.eta.getTime() - b.eta.getTime())[0]
        existingPO = { poNumber: first.poNumber, eta: first.eta.toISOString(), qty: first.qty, poId: first.poId, poItemId: first.poItemId }
      }

      // Feasibility on next order
      let feasibilityStatus: Recommendation['feasibilityStatus'] = 'Unknown'
      let ingredientDetails: any[] = []
      if (nextOrder) {
        const tfmId = tfmItemMap.get(item.sku)?.tfmItemId
        if (tfmId) {
          const recipe = recipes.get(tfmId) ?? []
          if (recipe.length) {
            const r = feasibilityAnalyzer.checkFeasibility(nextOrder.orderedQty, nextOrder.arrivalDate, recipe, nextOrder.arrivalDate)
            feasibilityStatus = r.status
            ingredientDetails = r.ingredientDetails
          } else {
            feasibilityStatus = 'NoRecipe'
          }
        } else {
          feasibilityStatus = 'NoRecipe'
        }
      }

      // DOC projection
      const docProjection = computeDOCProjection(item.currentInventory, item.ads, erpPOs, today, 30)

      // Reasoning
      const parts: string[] = [
        `Current stock: ${item.currentInventory.toLocaleString()} units @ ${item.ads.toFixed(1)} ADS = ${currentDOC.toFixed(1)} days of cover (min: ${minDOC}d).`,
      ]
      if (urgency === 'critical') parts.push('⚠️ Already at or below safety stock — immediate action required.')
      else if (urgency === 'urgent') parts.push(`Stock hits safety minimum in ${daysUntilCritical} days (${criticalDate}).`)
      else if (urgency === 'high') parts.push(`Stock hits safety minimum in ~${daysUntilCritical} days.`)

      if (nextOrder) parts.push(`Generator recommends ordering ${nextOrder.orderedQty.toLocaleString()} units for arrival ${nextOrder.arrivalDate.toISOString().split('T')[0]}.`)

      if (actionType === 'create') parts.push('No matching open PO found — create a new PO.')
      else if (actionType === 'on_track') parts.push(`PO #${existingPO?.poNumber} for ${existingPO?.qty} units (${existingPO?.eta?.split('T')[0]}) aligns with recommendation.`)
      else if (actionType === 'update_eta') parts.push(`PO #${existingPO?.poNumber} ETA needs to be updated.`)
      else if (actionType === 'update_qty') parts.push(`PO #${existingPO?.poNumber} quantity needs adjustment.`)
      else if (actionType === 'update_both') parts.push(`PO #${existingPO?.poNumber} ETA and quantity both need updating.`)
      else if (actionType === 'consider_cancel') parts.push('No replenishment needed now; existing open PO may be early/unnecessary.')

      if (feasibilityStatus === 'None') parts.push('⚠️ Supply infeasible — TFM cannot produce this quantity with current on-hand components.')
      else if (feasibilityStatus === 'Partial') parts.push('⚠️ Only partial production feasible with current supply.')

      return {
        id: `${item.company}-${item.sku}`,
        urgency, actionType, company: item.company,
        sku: item.sku,
        productName: item.productName !== item.sku ? item.productName : item.sku,
        currentInventory: item.currentInventory,
        ads: item.ads, currentDOC, daysUntilCritical, criticalDate,
        recommendedQty: nextOrder?.orderedQty ?? 0,
        recommendedETA: nextOrder?.arrivalDate.toISOString() ?? '',
        feasibilityStatus, existingPO, docProjection, ingredientDetails,
        reasoning: parts.join(' '),
      }
    }

    const recommendations: Recommendation[] = []

    for (const item of ftxEstablished) {
      recommendations.push(buildRec(item, ftxERPBySKU.get(item.sku) ?? [], ftxNextBySKU.get(item.sku)))
    }
    for (const item of sbylEstablished) {
      recommendations.push(buildRec(item, sbylERPBySKU.get(item.sku) ?? [], sbylNextBySKU.get(item.sku)))
    }

    // ── New product items (ADS=0 with open POs) ──────────────────────────
    const ftxADSItemIds = new Set(ftxADS.filter(a => a.ads > 0).map(a => a.itemId))
    const sbylADSItemIds = new Set(sbylADS.filter(a => a.ads > 0).map(a => a.itemId))
    const ftxNewPOs = ftxOpenPOs.filter(po => !ftxADSItemIds.has(po.itemId))
    const sbylNewPOs = sbylOpenPOs.filter(po => !sbylADSItemIds.has(po.itemId))

    const addNewProductRec = (po: ERPPOLine, company: 'FTX' | 'SBYL', allPOs: ERPPOLine[]) => {
      const inv = company === 'FTX' ? (ftxInvBySKU.get(po.sku) ?? 0) : (sbylInvBySKU.get(po.sku) ?? 0)
      recommendations.push({
        id: `${company}-new-${po.sku}`,
        urgency: 'medium', actionType: 'new_product', company,
        sku: po.sku, productName: po.productName ?? po.sku,
        currentInventory: inv, ads: 0, currentDOC: 999, daysUntilCritical: 999, criticalDate: null,
        recommendedQty: po.qty, recommendedETA: po.eta.toISOString(),
        feasibilityStatus: 'Unknown',
        existingPO: { poNumber: po.poNumber, eta: po.eta.toISOString(), qty: po.qty, poId: po.poId, poItemId: po.poItemId },
        docProjection: computeDOCProjection(inv, 0, allPOs, today, 30),
        ingredientDetails: [],
        reasoning: `New product with no ADS history. Open PO #${po.poNumber} for ${po.qty.toLocaleString()} units expected ${po.eta.toISOString().split('T')[0]}.`,
      })
    }

    const ftxNewBySKU = new Map<string, boolean>()
    for (const po of ftxNewPOs) {
      if (!ftxNewBySKU.has(po.sku)) {
        ftxNewBySKU.set(po.sku, true)
        addNewProductRec(po, 'FTX', ftxNewPOs.filter(p => p.sku === po.sku))
      }
    }
    const sbylNewBySKU = new Map<string, boolean>()
    for (const po of sbylNewPOs) {
      if (!sbylNewBySKU.has(po.sku)) {
        sbylNewBySKU.set(po.sku, true)
        addNewProductRec(po, 'SBYL', sbylNewPOs.filter(p => p.sku === po.sku))
      }
    }

    // ── Sort ─────────────────────────────────────────────────────────────
    const urgencyOrder: Record<Urgency, number> = { critical: 0, urgent: 1, high: 2, medium: 3, watch: 4 }
    recommendations.sort((a, b) => {
      const ud = urgencyOrder[a.urgency] - urgencyOrder[b.urgency]
      return ud !== 0 ? ud : a.currentDOC - b.currentDOC
    })

    // ── Health metrics ────────────────────────────────────────────────────
    const established = recommendations.filter(r => r.actionType !== 'new_product')
    const ftxRecs = established.filter(r => r.company === 'FTX')
    const sbylRecs = established.filter(r => r.company === 'SBYL')

    const healthMetrics = {
      criticalCount: recommendations.filter(r => r.urgency === 'critical').length,
      urgentCount: recommendations.filter(r => r.urgency === 'urgent').length,
      highCount: recommendations.filter(r => r.urgency === 'high').length,
      mediumCount: recommendations.filter(r => r.urgency === 'medium').length,
      watchCount: recommendations.filter(r => r.urgency === 'watch').length,
      totalItems: recommendations.length,
      avgFTXDOC: ftxRecs.length > 0 ? ftxRecs.reduce((s, r) => s + Math.min(r.currentDOC, 999), 0) / ftxRecs.length : 0,
      avgSBYLDOC: sbylRecs.length > 0 ? sbylRecs.reduce((s, r) => s + Math.min(r.currentDOC, 999), 0) / sbylRecs.length : 0,
      actionsNeeded: recommendations.filter(r => r.actionType !== 'on_track' && r.actionType !== 'new_product').length,
    }

    return NextResponse.json(serializeDates({
      generatedAt: new Date().toISOString(),
      recommendations,
      healthMetrics,
    }))
  } catch (err: any) {
    console.error('command-center/data error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
