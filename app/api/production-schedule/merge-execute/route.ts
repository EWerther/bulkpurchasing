/**
 * POST /api/production-schedule/merge-execute
 *
 * Executes a set of MergeActions against FTX and/or SBYL ERP.
 * Gated by ENABLE_WRITE_ACTIONS.
 *
 * Body:
 *   actions: MergeAction[]   — the actions to execute (from merge-preview)
 *
 * Only insert / update_qty / update_eta / update_both are executed.
 * match / locked / skip / no_sku are silently skipped.
 *
 * Returns:
 *   results: Array<{ demandId, action, ok, error?, newPoNumber? }>
 *   summary: { succeeded, failed, skipped }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { config } from '@/lib/config'
import { insertITPO, insertITPI, updateITPIQty, updateITPOETA, excludeITPI } from '@/lib/db/writes/itpo'
import type { MergeAction, MergeActionType } from '@/app/api/production-schedule/merge-preview/route'

const VENDOR_ID: Record<'FTX' | 'SBYL', number> = {
  FTX:  config.poSchedule.tfmVendorIdFTX,
  SBYL: config.poSchedule.tfmVendorIdSBYL,
}
const POOL: Record<'FTX' | 'SBYL', 'LCDataFTX' | 'LCDataSBYL'> = {
  FTX:  'LCDataFTX',
  SBYL: 'LCDataSBYL',
}

const EXECUTABLE: MergeActionType[] = ['insert', 'update_qty', 'update_eta', 'update_both', 'split', 'exclude']

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!config.features.enableWriteActions) {
    return NextResponse.json({ error: 'Write actions are disabled (ENABLE_WRITE_ACTIONS)' }, { status: 403 })
  }

  try {
    const body = await req.json()
    const { actions = [] } = body as { actions: MergeAction[] }

    type ExecuteResult = {
      demandId: string
      action: MergeActionType
      ok: boolean
      error?: string
      newPoNumber?: string
    }

    const results: ExecuteResult[] = []
    let succeeded = 0
    let failed = 0
    let skipped = 0

    for (const action of actions) {
      if (!EXECUTABLE.includes(action.action)) {
        skipped++
        continue
      }

      const pool = POOL[action.company]
      const vendorId = VENDOR_ID[action.company]
      const eta = new Date(action.scheduledDate)

      try {
        if (action.action === 'insert') {
          if (!action.erpItemId) {
            results.push({ demandId: action.demandId, action: action.action, ok: false, error: 'No ERP item ID' })
            failed++
            continue
          }
          const doc = isFinite(action.docAtDate) && action.docAtDate > 0
            ? Math.round(action.docAtDate)
            : null
          const { itpoId, poNumber } = await insertITPO(pool, vendorId, eta, doc)
          await insertITPI(pool, itpoId, action.erpItemId, action.scheduledQty)
          results.push({ demandId: action.demandId, action: action.action, ok: true, newPoNumber: poNumber })
          succeeded++

        } else if (action.action === 'update_qty') {
          if (!action.existingItpiId) {
            results.push({ demandId: action.demandId, action: action.action, ok: false, error: 'No ITPI ID' })
            failed++
            continue
          }
          await updateITPIQty(pool, action.existingItpiId, action.scheduledQty)
          results.push({ demandId: action.demandId, action: action.action, ok: true })
          succeeded++

        } else if (action.action === 'update_eta') {
          if (!action.existingItpoId) {
            results.push({ demandId: action.demandId, action: action.action, ok: false, error: 'No ITPO ID' })
            failed++
            continue
          }
          await updateITPOETA(pool, action.existingItpoId, eta)
          results.push({ demandId: action.demandId, action: action.action, ok: true })
          succeeded++

        } else if (action.action === 'update_both') {
          if (!action.existingItpiId || !action.existingItpoId) {
            results.push({ demandId: action.demandId, action: action.action, ok: false, error: 'Missing ITPO/ITPI ID' })
            failed++
            continue
          }
          await Promise.all([
            updateITPIQty(pool, action.existingItpiId, action.scheduledQty),
            updateITPOETA(pool, action.existingItpoId, eta),
          ])
          results.push({ demandId: action.demandId, action: action.action, ok: true })
          succeeded++

        } else if (action.action === 'split') {
          // Split: exclude this ITPI from its current multi-line ITPO,
          // then create a new ITPO with the correct ETA and add a new ITPI for this item.
          if (!action.existingItpiId || !action.erpItemId) {
            results.push({ demandId: action.demandId, action: action.action, ok: false, error: 'Missing ITPI ID or ERP item ID' })
            failed++
            continue
          }
          const doc = isFinite(action.docAtDate) && action.docAtDate > 0
            ? Math.round(action.docAtDate)
            : null
          // Exclude from original PO first
          await excludeITPI(pool, action.existingItpiId)
          // Create new PO with correct ETA
          const { itpoId: newItpoId, poNumber: newPoNumber } = await insertITPO(pool, vendorId, eta, doc)
          // Add item to new PO (use scheduled qty if qty also changed, else existing qty)
          const qty = action.existingItpoLineCount > 0 ? action.scheduledQty : (action.existingQty ?? action.scheduledQty)
          await insertITPI(pool, newItpoId, action.erpItemId, qty)
          results.push({ demandId: action.demandId, action: action.action, ok: true, newPoNumber })
          succeeded++

        } else if (action.action === 'exclude') {
          if (!action.existingItpiId) {
            results.push({ demandId: action.demandId, action: action.action, ok: false, error: 'No ITPI ID' })
            failed++
            continue
          }
          await excludeITPI(pool, action.existingItpiId)
          results.push({ demandId: action.demandId, action: action.action, ok: true })
          succeeded++
        }

      } catch (err: any) {
        results.push({ demandId: action.demandId, action: action.action, ok: false, error: err.message ?? 'DB error' })
        failed++
      }
    }

    return NextResponse.json({ results, summary: { succeeded, failed, skipped } })

  } catch (err: any) {
    console.error('merge-execute error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
