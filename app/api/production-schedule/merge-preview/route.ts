/**
 * POST /api/production-schedule/merge-preview
 *
 * Accepts the flat list of scheduled items from the production schedule
 * and returns proposed ERP actions WITHOUT executing anything.
 *
 * Body:
 *   lockDate:  string (YYYY-MM-DD) — items on/before this date are locked
 *   etaWindow: number              — days tolerance for ETA matching (default 2)
 *   items:     ScheduledItemInput[]
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getOpenITPOLines, getItemIdsBySKU } from '@/lib/db/queries/itpo'
import { config } from '@/lib/config'

export type MergeActionType =
  | 'insert'
  | 'update_qty'
  | 'update_eta'
  | 'update_both'
  | 'split'       // ETA change needed but ITPO has multiple lines — split off onto new PO
  | 'exclude'     // Existing open PO line has no matching schedule item — suggest cancelling
  | 'match'
  | 'locked'
  | 'skip'
  | 'no_sku'

export interface MergeAction {
  demandId: string
  company: 'FTX' | 'SBYL'
  sku: string
  productName: string
  scheduledDate: string   // ISO — for exclude actions this is the existing ETA
  scheduledQty: number    // for exclude actions this is the existing qty
  docAtDate: number
  feasibilityStatus: string
  isNewProduct: boolean
  action: MergeActionType
  erpItemId: number | null
  existingItpoId: number | null
  existingItpiId: number | null
  existingPoNumber: string | null
  existingEta: string | null
  existingQty: number | null
  existingItpoLineCount: number  // total active ITPI lines on the existing ITPO (used for split detection)
  description: string
}

function serializeDates(obj: any): any {
  if (obj instanceof Date) return obj.toISOString()
  if (Array.isArray(obj)) return obj.map(serializeDates)
  if (obj && typeof obj === 'object') {
    const out: any = {}
    for (const [k, v] of Object.entries(obj)) out[k] = serializeDates(v)
    return out
  }
  return obj
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const {
      lockDate: lockDateStr,
      cutoffDate: cutoffDateStr,
      etaWindow = config.poSchedule.etaDiffThresholdDays,
      items = [],
    } = body as {
      lockDate?: string
      cutoffDate?: string
      etaWindow?: number
      items: Array<{
        demandId: string
        company: 'FTX' | 'SBYL'
        sku: string
        productName: string
        scheduledQty: number
        scheduledDate: string
        isLocked: boolean
        isNewProduct: boolean
        docAtDate: number
        feasibilityStatus: string
        poId: number
        poItemId: number
        poNumber: string
      }>
    }

    const lockDate = lockDateStr ? new Date(lockDateStr) : null
    if (lockDate) lockDate.setHours(0, 0, 0, 0)

    const cutoffDate = cutoffDateStr ? new Date(cutoffDateStr) : null
    if (cutoffDate) cutoffDate.setHours(23, 59, 59, 999) // include full cutoff day

    const ftxItems  = items.filter(i => i.company === 'FTX')
    const sbylItems = items.filter(i => i.company === 'SBYL')

    const today = new Date(); today.setHours(0, 0, 0, 0)
    // Always fetch from today — lockDate only determines which actions are editable,
    // not which existing ITPO lines we need to see. Fetching from lockDate would hide
    // pre-lockDate lines that should be pushed out to match later schedule items.
    const fetchFrom = today

    const [ftxLines, sbylLines] = await Promise.all([
      ftxItems.length > 0
        ? getOpenITPOLines('LCDataFTX', config.poSchedule.tfmVendorIdFTX, fetchFrom)
        : Promise.resolve([]),
      sbylItems.length > 0
        ? getOpenITPOLines('LCDataSBYL', config.poSchedule.tfmVendorIdSBYL, fetchFrom)
        : Promise.resolve([]),
    ])

    const ftxGenSKUs  = ftxItems.filter(i => i.poId === 0).map(i => i.sku)
    const sbylGenSKUs = sbylItems.filter(i => i.poId === 0).map(i => i.sku)

    const [ftxItemIdMap, sbylItemIdMap] = await Promise.all([
      getItemIdsBySKU('LCDataFTX',  ftxGenSKUs),
      getItemIdsBySKU('LCDataSBYL', sbylGenSKUs),
    ])

    // ── Lookup maps ────────────────────────────────────────────────────────────

    // itemId → matching ITPO lines (for finding a match by ETA)
    const buildLineMap = (lines: typeof ftxLines) => {
      const map = new Map<number, typeof lines>()
      for (const line of lines) {
        const arr = map.get(line.itemId) ?? []
        arr.push(line)
        map.set(line.itemId, arr)
      }
      return map
    }

    // itpoId → all ITPI lines on that PO header (to detect multi-line POs)
    const buildItpoMap = (lines: typeof ftxLines) => {
      const map = new Map<number, typeof lines>()
      for (const line of lines) {
        const arr = map.get(line.itpoId) ?? []
        arr.push(line)
        map.set(line.itpoId, arr)
      }
      return map
    }

    const ftxLineMap  = buildLineMap(ftxLines)
    const sbylLineMap = buildLineMap(sbylLines)
    const ftxItpoMap  = buildItpoMap(ftxLines)
    const sbylItpoMap = buildItpoMap(sbylLines)

    const etaWindowMs = etaWindow * 24 * 60 * 60 * 1000

    function findMatch(
      itemId: number,
      scheduledDate: Date,
      lineMap: Map<number, typeof ftxLines>,
    ) {
      // Filter out lines already consumed by an earlier schedule item.
      // Always pick the nearest line regardless of ETA distance —
      // etaWindow only determines the action type (match vs update_eta),
      // not whether a match exists at all.
      const candidates = (lineMap.get(itemId) ?? [])
        .filter(c => !matchedItpiIds.has(c.itpiId))
      let best: (typeof ftxLines)[0] | null = null
      let bestDiff = Infinity
      for (const c of candidates) {
        const diff = Math.abs(c.eta.getTime() - scheduledDate.getTime())
        if (diff < bestDiff) {
          best = c
          bestDiff = diff
        }
      }
      return best
    }

    // Track which ITPI IDs are consumed by schedule items (so we can find unmatched ones)
    const matchedItpiIds = new Set<number>()

    function buildAction(item: typeof items[0]): MergeAction {
      const scheduledDate = new Date(item.scheduledDate)
      const company  = item.company
      const lineMap  = company === 'FTX' ? ftxLineMap  : sbylLineMap
      const itpoMap  = company === 'FTX' ? ftxItpoMap  : sbylItpoMap
      const itemIdMap = company === 'FTX' ? ftxItemIdMap : sbylItemIdMap

      // Locked — never touch, but still consume the matching ITPO line so it isn't
      // mistakenly flagged as unmatched or grabbed by a later non-locked schedule item.
      if (item.isLocked || (lockDate && scheduledDate <= lockDate)) {
        if (item.poItemId > 0) {
          // New-product item: we know the exact ITPI ID
          matchedItpiIds.add(item.poItemId)
        } else {
          // Generated item: find and consume the nearest ITPO line for this SKU
          const erpId = itemIdMap.get(item.sku) ?? null
          if (erpId) {
            const lockedMatch = findMatch(erpId, scheduledDate, lineMap)
            if (lockedMatch) matchedItpiIds.add(lockedMatch.itpiId)
          }
        }
        return {
          demandId: item.demandId, company, sku: item.sku,
          productName: item.productName, scheduledDate: item.scheduledDate,
          scheduledQty: item.scheduledQty, docAtDate: item.docAtDate,
          feasibilityStatus: item.feasibilityStatus, isNewProduct: item.isNewProduct,
          action: 'locked', erpItemId: null,
          existingItpoId: item.poId || null, existingItpiId: item.poItemId || null,
          existingPoNumber: item.poNumber || null, existingEta: null, existingQty: null,
          existingItpoLineCount: 0,
          description: 'Before lock date — will not be modified',
        }
      }

      // ── NewProductPO items (poId/poItemId known) ────────────────────────────
      if (item.isNewProduct && item.poId > 0 && item.poItemId > 0) {
        const existingLine = [...ftxLines, ...sbylLines]
          .find(l => l.itpiId === item.poItemId)

        if (!existingLine) {
          return {
            demandId: item.demandId, company, sku: item.sku,
            productName: item.productName, scheduledDate: item.scheduledDate,
            scheduledQty: item.scheduledQty, docAtDate: item.docAtDate,
            feasibilityStatus: item.feasibilityStatus, isNewProduct: true,
            action: 'skip', erpItemId: null,
            existingItpoId: item.poId, existingItpiId: item.poItemId,
            existingPoNumber: item.poNumber, existingEta: null, existingQty: null,
            existingItpoLineCount: 0,
            description: 'Existing PO no longer open — skipped',
          }
        }

        matchedItpiIds.add(existingLine.itpiId)

        const itpoLines = itpoMap.get(existingLine.itpoId) ?? []
        const lineCount = itpoLines.length

        const qtyDiffPct = existingLine.qty > 0 ? Math.abs(existingLine.qty - item.scheduledQty) / existingLine.qty * 100 : 0
        const qtyMatch   = qtyDiffPct <= config.poSchedule.qtyDiffThresholdPct
        const etaDiff    = Math.abs(existingLine.eta.getTime() - scheduledDate.getTime())
        const etaMatch   = etaDiff <= etaWindowMs

        let action: MergeActionType = qtyMatch && etaMatch ? 'match'
          : qtyMatch ? 'update_eta'
          : etaMatch ? 'update_qty'
          : 'update_both'

        // If ETA needs to change and the PO has multiple lines → split
        if (!etaMatch && lineCount > 1) {
          action = 'split'
        }

        const desc = action === 'match'
          ? `✓ Matches existing PO ${existingLine.poNumber}`
          : action === 'update_qty'
          ? `Update qty ${existingLine.qty} → ${item.scheduledQty} on ${existingLine.poNumber}`
          : action === 'update_eta'
          ? `Update ETA on ${existingLine.poNumber}`
          : action === 'split'
          ? `Split from ${existingLine.poNumber} (${lineCount} items) — ETA change`
          : `Update qty & ETA on ${existingLine.poNumber}`

        return {
          demandId: item.demandId, company, sku: item.sku,
          productName: item.productName, scheduledDate: item.scheduledDate,
          scheduledQty: item.scheduledQty, docAtDate: item.docAtDate,
          feasibilityStatus: item.feasibilityStatus, isNewProduct: true,
          action, erpItemId: existingLine.itemId,
          existingItpoId: existingLine.itpoId, existingItpiId: existingLine.itpiId,
          existingPoNumber: existingLine.poNumber,
          existingEta: existingLine.eta.toISOString(),
          existingQty: existingLine.qty,
          existingItpoLineCount: lineCount,
          description: desc,
        }
      }

      // ── Generated items — look up ERP item ID + search for matching ITPO ────
      const erpItemId = itemIdMap.get(item.sku) ?? null
      if (!erpItemId) {
        return {
          demandId: item.demandId, company, sku: item.sku,
          productName: item.productName, scheduledDate: item.scheduledDate,
          scheduledQty: item.scheduledQty, docAtDate: item.docAtDate,
          feasibilityStatus: item.feasibilityStatus, isNewProduct: false,
          action: 'no_sku', erpItemId: null,
          existingItpoId: null, existingItpiId: null,
          existingPoNumber: null, existingEta: null, existingQty: null,
          existingItpoLineCount: 0,
          description: `SKU ${item.sku} not found in ${company} ERP — cannot create PO`,
        }
      }

      const match = findMatch(erpItemId, scheduledDate, lineMap)

      if (!match) {
        return {
          demandId: item.demandId, company, sku: item.sku,
          productName: item.productName, scheduledDate: item.scheduledDate,
          scheduledQty: item.scheduledQty, docAtDate: item.docAtDate,
          feasibilityStatus: item.feasibilityStatus, isNewProduct: false,
          action: 'insert', erpItemId,
          existingItpoId: null, existingItpiId: null,
          existingPoNumber: null, existingEta: null, existingQty: null,
          existingItpoLineCount: 0,
          description: `Create new PO for ${item.scheduledQty} units, ETA ${scheduledDate.toLocaleDateString()}`,
        }
      }

      matchedItpiIds.add(match.itpiId)

      const itpoLines = itpoMap.get(match.itpoId) ?? []
      const lineCount = itpoLines.length

      const qtyDiffPct = match.qty > 0 ? Math.abs(match.qty - item.scheduledQty) / match.qty * 100 : 0
      const qtyMatch   = qtyDiffPct <= config.poSchedule.qtyDiffThresholdPct
      const etaDiff    = Math.abs(match.eta.getTime() - scheduledDate.getTime())
      const etaMatch   = etaDiff <= etaWindowMs

      let action: MergeActionType = qtyMatch && etaMatch ? 'match'
        : qtyMatch ? 'update_eta'
        : etaMatch ? 'update_qty'
        : 'update_both'

      // If ETA needs to change and the PO has multiple lines → split
      if (!etaMatch && lineCount > 1) {
        action = 'split'
      }

      const desc = action === 'match'
        ? `✓ Matches existing PO ${match.poNumber} (${match.qty} units)`
        : action === 'update_qty'
        ? `Update qty ${match.qty} → ${item.scheduledQty} on ${match.poNumber}`
        : action === 'update_eta'
        ? `Update ETA on ${match.poNumber}`
        : action === 'split'
        ? `Split from ${match.poNumber} (${lineCount} items) — ETA change`
        : `Update qty & ETA on ${match.poNumber}`

      return {
        demandId: item.demandId, company, sku: item.sku,
        productName: item.productName, scheduledDate: item.scheduledDate,
        scheduledQty: item.scheduledQty, docAtDate: item.docAtDate,
        feasibilityStatus: item.feasibilityStatus, isNewProduct: false,
        action, erpItemId,
        existingItpoId: match.itpoId, existingItpiId: match.itpiId,
        existingPoNumber: match.poNumber,
        existingEta: match.eta.toISOString(),
        existingQty: match.qty,
        existingItpoLineCount: lineCount,
        description: desc,
      }
    }

    const actions = items.map(buildAction)

    // ── Unmatched existing ITPO lines → suggest exclude ────────────────────────
    const ftxTagged  = ftxLines.map(l  => ({ ...l, company: 'FTX'  as const }))
    const sbylTagged = sbylLines.map(l => ({ ...l, company: 'SBYL' as const }))

    for (const line of [...ftxTagged, ...sbylTagged]) {
      if (matchedItpiIds.has(line.itpiId)) continue
      actions.push({
        demandId: `exclude-${line.itpiId}`,
        company: line.company,
        sku: line.sku,
        productName: line.sku,
        scheduledDate: line.eta.toISOString(),  // no schedule date — show existing ETA
        scheduledQty: line.qty,                 // no schedule qty — show existing qty
        docAtDate: 0,
        feasibilityStatus: '',
        isNewProduct: false,
        action: 'exclude',
        erpItemId: line.itemId,
        existingItpoId: line.itpoId,
        existingItpiId: line.itpiId,
        existingPoNumber: line.poNumber,
        existingEta: line.eta.toISOString(),
        existingQty: line.qty,
        existingItpoLineCount: (line.company === 'FTX' ? ftxItpoMap : sbylItpoMap)
          .get(line.itpoId)?.length ?? 1,
        description: `No schedule item — unmatched open PO line (Qty ${line.qty}, ETA ${line.eta.toLocaleDateString()})`,
      })
    }

    // ── Cutoff date filter ─────────────────────────────────────────────────────
    // Show actions relevant to the cutoff window in both directions:
    //   • scheduledDate ≤ cutoffDate  — schedule item is within the window (insert, update, match, locked, generated items)
    //   • existingEta   ≤ cutoffDate  — existing ERP PO is within the window (may need pushing past cutoff, or is an unmatched exclude)
    // Actions with neither date within the window are beyond scope and are hidden.
    const filteredActions = cutoffDate
      ? actions.filter(a => {
          const sched = new Date(a.scheduledDate)
          const exist = a.existingEta ? new Date(a.existingEta) : null
          return sched <= cutoffDate || (exist !== null && exist <= cutoffDate)
        })
      : actions

    const summary = {
      insert:  filteredActions.filter(a => a.action === 'insert').length,
      update:  filteredActions.filter(a => ['update_qty','update_eta','update_both'].includes(a.action)).length,
      split:   filteredActions.filter(a => a.action === 'split').length,
      exclude: filteredActions.filter(a => a.action === 'exclude').length,
      match:   filteredActions.filter(a => a.action === 'match').length,
      locked:  filteredActions.filter(a => a.action === 'locked').length,
      skip:    filteredActions.filter(a => ['skip','no_sku'].includes(a.action)).length,
    }

    return NextResponse.json(serializeDates({ actions: filteredActions, summary }))
  } catch (err: any) {
    console.error('merge-preview error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
