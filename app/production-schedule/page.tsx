'use client'

import { useState, useMemo, useCallback } from 'react'
import { AlertTriangle, Zap, Lock, Search, RefreshCw, CheckCircle, XCircle, GitMerge, ChevronUp, ChevronDown, ChevronsUpDown, X, Package, PackagePlus, Loader2 } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { InventoryLink } from '@/components/shared/InventoryLink'
import { SummaryBar } from '@/components/shared/SummaryBar'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { CapacityBar } from '@/components/shared/CapacityBar'
import { ConflictResolutionPanel } from '@/components/shared/ConflictResolutionPanel'
import { fmtDate } from '@/lib/utils/dates'

type MergeActionType =
  | 'insert' | 'update_qty' | 'update_eta' | 'update_both'
  | 'split' | 'exclude'
  | 'match' | 'locked' | 'skip' | 'no_sku'

interface MergeAction {
  demandId: string
  company: 'FTX' | 'SBYL'
  sku: string
  productName: string
  scheduledDate: string
  scheduledQty: number
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
  description: string
}

const ACTION_COLOR: Record<MergeActionType, string> = {
  insert:      'text-accent bg-accent/10 border-accent/30',
  update_qty:  'text-warning bg-warning/10 border-warning/30',
  update_eta:  'text-warning bg-warning/10 border-warning/30',
  update_both: 'text-warning bg-warning/10 border-warning/30',
  split:       'text-purple-400 bg-purple-500/10 border-purple-500/30',
  exclude:     'text-danger bg-danger/10 border-danger/30',
  match:       'text-success bg-success/10 border-success/30',
  locked:      'text-locked bg-locked/10 border-locked/30',
  skip:        'text-text-secondary bg-surface border-border',
  no_sku:      'text-danger bg-danger/10 border-danger/30',
}

const ACTION_LABEL: Record<MergeActionType, string> = {
  insert:      'Create PO',
  update_qty:  'Update Qty',
  update_eta:  'Update ETA',
  update_both: 'Update Both',
  split:       'Split PO',
  exclude:     'Exclude',
  match:       'Match ✓',
  locked:      'Locked',
  skip:        'Skip',
  no_sku:      'No SKU',
}

const EXECUTABLE: MergeActionType[] = ['insert', 'update_qty', 'update_eta', 'update_both', 'split', 'exclude']

export default function ProductionSchedulePage() {
  const [cutoffDate, setCutoffDate] = useState(() => {
    const d = new Date()
    d.setMonth(d.getMonth() + 4)
    return d.toISOString().split('T')[0]
  })
  const [adjustFromDate, setAdjustFromDate] = useState('')
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [phase, setPhase] = useState<1 | 2>(1)
  const [etaOverrides, setEtaOverrides] = useState<Record<string, string>>({})
  const [conflictDay, setConflictDay] = useState<any>(null)
  const [drilldownItem, setDrilldownItem] = useState<any>(null)
  const [filterText, setFilterText] = useState('')

  // Phase 3 — ERP merge state
  const [lockDate, setLockDate] = useState(() => new Date().toISOString().split('T')[0])
  const [mergeData, setMergeData] = useState<{ actions: MergeAction[], summary: Record<string, number> } | null>(null)
  const [mergeLoading, setMergeLoading] = useState(false)
  const [mergeError, setMergeError] = useState('')
  // Per-row execution tracking: demandId → 'pending'|'ok'|'err'
  const [rowStatus, setRowStatus] = useState<Map<string, { state: 'pending'|'ok'|'err', msg?: string }>>(new Map())
  const [mergeAllLoading, setMergeAllLoading] = useState(false)
  const [mergeSortCol, setMergeSortCol] = useState<keyof MergeAction | null>(null)
  const [mergeSortDir, setMergeSortDir] = useState<'asc' | 'desc'>('asc')
  // Filter + multi-select state
  const [mergeTextFilter, setMergeTextFilter]     = useState('')
  const [mergeActionFilter, setMergeActionFilter] = useState<MergeActionType[]>([])
  const [mergeCompanyFilter, setMergeCompanyFilter] = useState<'ALL' | 'FTX' | 'SBYL'>('ALL')
  const [selectedIds, setSelectedIds]             = useState<Set<string>>(new Set())

  async function loadDemand() {
    setLoading(true)
    setError('')
    setEtaOverrides({})
    setFilterText('')
    setMergeData(null)
    setRowStatus(new Map())
    try {
      const res = await fetch('/api/production-schedule/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cutoffDate,
          adjustFromDate: adjustFromDate || undefined,
          generateSchedule: false,
          selectedOpenPOs,
        }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      setData(await res.json())
      setPhase(1)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Locked quantity allocations from ConflictResolutionPanel — persisted across regenerates
  const [qtyOverrides, setQtyOverrides] = useState<Record<string, number>>({})

  // Future POs modal (Next PO column)
  const [futurePOsModal, setFuturePOsModal] = useState<{ sku: string; company: string; productName: string; pos: any[] } | null>(null)

  // Select Open POs modal
  const [showPOModal, setShowPOModal]       = useState(false)
  const [availableOpenPOs, setAvailableOpenPOs] = useState<any[]>([])
  const [poModalLoading, setPoModalLoading] = useState(false)
  const [poModalError, setPoModalError]     = useState('')
  const [poModalFilter, setPoModalFilter]   = useState('')
  const [poModalCompany, setPoModalCompany] = useState<'ALL' | 'FTX' | 'SBYL'>('ALL')
  // User-selected open POs: passed to Load Demand to factor into DOC simulation
  const [selectedOpenPOs, setSelectedOpenPOs] = useState<Array<{ poId: number; poItemId: number; company: 'FTX' | 'SBYL' }>>([])

  // Phase 1 sort + column filters
  const [p1SortCol, setP1SortCol]       = useState<string | null>(null)
  const [p1SortDir, setP1SortDir]       = useState<'asc' | 'desc'>('asc')
  const [p1TypeFilter, setP1TypeFilter] = useState<'all' | 'Generated' | 'NewProductPO' | 'SelectedPO'>('all')
  const [p1CoFilter,   setP1CoFilter]   = useState<'ALL' | 'FTX' | 'SBYL'>('ALL')
  const [p1ColFilters, setP1ColFilters] = useState<Record<string, string>>({})

  // Phase 2 sort
  const [p2SortCol, setP2SortCol] = useState<string | null>(null)
  const [p2SortDir, setP2SortDir] = useState<'asc' | 'desc'>('asc')

  async function generateSchedule(extraQtyOverrides?: Record<string, number>) {
    const allQtyOverrides = { ...qtyOverrides, ...extraQtyOverrides }
    setLoading(true)
    setError('')
    setMergeData(null)
    setRowStatus(new Map())
    try {
      const res = await fetch('/api/production-schedule/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cutoffDate,
          adjustFromDate: adjustFromDate || undefined,
          generateSchedule: true,
          etaOverrides,
          qtyOverrides: allQtyOverrides,
          selectedOpenPOs,
        }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      setData(await res.json())
      setPhase(2)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function openPOModal() {
    setShowPOModal(true)
    setPoModalError('')
    setPoModalLoading(true)
    try {
      const params = new URLSearchParams()
      if (cutoffDate) params.set('cutoff', cutoffDate)
      const res = await fetch(`/api/production-schedule/open-pos?${params}`)
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      setAvailableOpenPOs(await res.json())
    } catch (err: any) {
      setPoModalError(err.message)
    } finally {
      setPoModalLoading(false)
    }
  }

  function togglePOSelection(po: any) {
    setSelectedOpenPOs(prev => {
      const exists = prev.some(p => p.company === po.company && p.poId === po.poId && p.poItemId === po.poItemId)
      return exists
        ? prev.filter(p => !(p.company === po.company && p.poId === po.poId && p.poItemId === po.poItemId))
        : [...prev, { poId: po.poId, poItemId: po.poItemId, company: po.company }]
    })
  }

  function isPOSelected(po: any) {
    return selectedOpenPOs.some(p => p.company === po.company && p.poId === po.poId && p.poItemId === po.poItemId)
  }

  async function loadMergePreview() {
    if (!data?.days) return
    setMergeLoading(true)
    setMergeError('')
    setRowStatus(new Map())
    try {
      // Build a map of demandId → best production-scheduled item from `days`.
      // Capacity cascade can split one demand across multiple days (same demandId) —
      // keep the latest scheduledDate so the ETA reflects when the full order is complete.
      const daysItemMap = new Map<string, any>()
      for (const day of data.days as any[]) {
        for (const item of day.items) {
          const existing = daysItemMap.get(item.demandId)
          if (!existing || new Date(item.scheduledDate) > new Date(existing.scheduledDate)) {
            daysItemMap.set(item.demandId, item)
          }
        }
      }

      // Use the full-year mergeItems as the matching set so every existing ITPO line
      // can be consumed (prevents spurious excludes for POs beyond the display cutoff).
      // For within-cutoff items, substitute the capacity-adjusted date from data.days.
      // The merge-preview API's cutoff filter then hides beyond-cutoff display actions.
      const rawMergeItems: any[] = (data as any).mergeItems ?? []
      const scheduledItems = rawMergeItems.length > 0
        ? rawMergeItems.map((item: any) => {
            const dayItem = daysItemMap.get(item.demandId)
            return dayItem ? {
              demandId:          dayItem.demandId,
              company:           dayItem.company,
              sku:               dayItem.sku,
              productName:       dayItem.productName,
              scheduledQty:      dayItem.orderedQty ?? dayItem.scheduledQty,
              scheduledDate:     typeof dayItem.scheduledDate === 'string'
                                   ? dayItem.scheduledDate
                                   : new Date(dayItem.scheduledDate).toISOString(),
              isLocked:          dayItem.isLocked ?? false,
              isNewProduct:      dayItem.isNewProduct ?? false,
              docAtDate:         dayItem.docAtDate ?? 0,
              feasibilityStatus: dayItem.feasibilityStatus ?? '',
              poId:              dayItem.poId ?? 0,
              poItemId:          dayItem.poItemId ?? 0,
              poNumber:          dayItem.poNumber ?? '',
            } : item  // beyond-cutoff: use raw generator values for matching only
          })
        : Array.from(daysItemMap.values()).map((item: any) => ({
            demandId:          item.demandId,
            company:           item.company,
            sku:               item.sku,
            productName:       item.productName,
            scheduledQty:      item.orderedQty ?? item.scheduledQty,
            scheduledDate:     typeof item.scheduledDate === 'string'
                                 ? item.scheduledDate
                                 : new Date(item.scheduledDate).toISOString(),
            isLocked:          item.isLocked ?? false,
            isNewProduct:      item.isNewProduct ?? false,
            docAtDate:         item.docAtDate ?? 0,
            feasibilityStatus: item.feasibilityStatus ?? '',
            poId:              item.poId ?? 0,
            poItemId:          item.poItemId ?? 0,
            poNumber:          item.poNumber ?? '',
          }))

      const res = await fetch('/api/production-schedule/merge-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lockDate, cutoffDate, items: scheduledItems }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      setMergeData(await res.json())
      setSelectedIds(new Set())
      setMergeTextFilter('')
      setMergeActionFilter([])
    } catch (err: any) {
      setMergeError(err.message)
    } finally {
      setMergeLoading(false)
    }
  }

  const executeActions = useCallback(async (actions: MergeAction[]) => {
    const executable = actions.filter(a => EXECUTABLE.includes(a.action))
    if (executable.length === 0) return

    // Mark all as pending
    setRowStatus(prev => {
      const next = new Map(prev)
      for (const a of executable) next.set(a.demandId, { state: 'pending' })
      return next
    })

    try {
      const res = await fetch('/api/production-schedule/merge-execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions: executable }),
      })
      if (!res.ok) {
        const errBody = await res.json()
        throw new Error(errBody.error ?? 'Server error')
      }
      const { results } = await res.json()
      setRowStatus(prev => {
        const next = new Map(prev)
        for (const r of results) {
          next.set(r.demandId, {
            state: r.ok ? 'ok' : 'err',
            msg: r.ok ? (r.newPoNumber ? `Created ${r.newPoNumber}` : undefined) : r.error,
          })
        }
        return next
      })
      // Refresh merge preview after successful execution
      if (results.some((r: any) => r.ok)) {
        setTimeout(() => loadMergePreview(), 800)
      }
    } catch (err: any) {
      setRowStatus(prev => {
        const next = new Map(prev)
        for (const a of executable) next.set(a.demandId, { state: 'err', msg: err.message })
        return next
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockDate, data])

  async function applyRow(action: MergeAction) {
    await executeActions([action])
  }

  async function applyAll() {
    if (!mergeData) return
    setMergeAllLoading(true)
    await executeActions(mergeData.actions)
    setMergeAllLoading(false)
  }

  const reviewItems: any[] = data?.reviewItems ?? []
  const days: any[] = data?.days ?? []
  const summary = data?.summary
  const CAPACITY: number = data?.dailyCapacity ?? 400

  function toggleMergeSort(col: keyof MergeAction) {
    if (mergeSortCol === col) {
      setMergeSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setMergeSortCol(col)
      setMergeSortDir('asc')
    }
  }

  const sortedMergeActions = useMemo(() => {
    const actions = mergeData?.actions ?? []
    if (!mergeSortCol) return actions
    return [...actions].sort((a, b) => {
      const av = a[mergeSortCol] ?? ''
      const bv = b[mergeSortCol] ?? ''
      let cmp = 0
      if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv
      } else {
        cmp = String(av ?? '').localeCompare(String(bv ?? ''))
      }
      return mergeSortDir === 'asc' ? cmp : -cmp
    })
  }, [mergeData?.actions, mergeSortCol, mergeSortDir])

  const filteredMergeActions = useMemo(() => {
    let list = sortedMergeActions
    if (mergeActionFilter.length > 0)
      list = list.filter(a => mergeActionFilter.includes(a.action))
    if (mergeCompanyFilter !== 'ALL')
      list = list.filter(a => a.company === mergeCompanyFilter)
    if (mergeTextFilter.trim()) {
      const q = mergeTextFilter.toLowerCase()
      list = list.filter(a =>
        a.sku.toLowerCase().includes(q) ||
        a.productName.toLowerCase().includes(q) ||
        (a.existingPoNumber ?? '').toLowerCase().includes(q)
      )
    }
    return list
  }, [sortedMergeActions, mergeActionFilter, mergeCompanyFilter, mergeTextFilter])

  // Rows that can actually be selected (executable + not already done)
  const selectableInView = useMemo(() =>
    filteredMergeActions.filter(a =>
      EXECUTABLE.includes(a.action) && rowStatus.get(a.demandId)?.state !== 'ok'
    ), [filteredMergeActions, rowStatus])

  const allSelected = selectableInView.length > 0 && selectableInView.every(a => selectedIds.has(a.demandId))
  const someSelected = selectableInView.some(a => selectedIds.has(a.demandId))

  function toggleSelectRow(demandId: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(demandId) ? next.delete(demandId) : next.add(demandId)
      return next
    })
  }

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        selectableInView.forEach(a => next.delete(a.demandId))
        return next
      })
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev)
        selectableInView.forEach(a => next.add(a.demandId))
        return next
      })
    }
  }

  async function applySelected() {
    const toApply = filteredMergeActions.filter(a => selectedIds.has(a.demandId))
    if (toApply.length === 0) return
    await executeActions(toApply)
    setSelectedIds(new Set())
  }

  const filteredReviewItems = useMemo(() => {
    const items: any[] = data?.reviewItems ?? []
    if (!filterText.trim()) return items
    const q = filterText.toLowerCase()
    return items.filter((item: any) =>
      item.sku.toLowerCase().includes(q) ||
      item.productName.toLowerCase().includes(q) ||
      item.company.toLowerCase().includes(q) ||
      (item.poNumber ?? '').toLowerCase().includes(q)
    )
  }, [data, filterText])

  function toggleP1Sort(col: string) {
    if (p1SortCol === col) setP1SortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setP1SortCol(col); setP1SortDir('asc') }
  }
  function toggleP2Sort(col: string) {
    if (p2SortCol === col) setP2SortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setP2SortCol(col); setP2SortDir('asc') }
  }

  const sortedFilteredReviewItems = useMemo(() => {
    let list = filteredReviewItems.map((i: any) => ({
      ...i,
      currentDOC: i.ads > 0 ? Math.round((i.currentInventory / i.ads) * 10) / 10 : null,
    }))
    if (p1TypeFilter !== 'all') list = list.filter((i: any) => i.type === p1TypeFilter)
    if (p1CoFilter !== 'ALL')   list = list.filter((i: any) => i.company === p1CoFilter)
    // Per-column filters
    for (const [col, val] of Object.entries(p1ColFilters)) {
      if (!val.trim()) continue
      const q = val.toLowerCase()
      list = list.filter((i: any) => {
        const v = i[col]
        if (v == null) return false
        return String(v).toLowerCase().includes(q)
      })
    }
    if (!p1SortCol) return list
    return [...list].sort((a: any, b: any) => {
      const av = a[p1SortCol] ?? ''
      const bv = b[p1SortCol] ?? ''
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))
      return p1SortDir === 'asc' ? cmp : -cmp
    })
  }, [filteredReviewItems, p1TypeFilter, p1CoFilter, p1ColFilters, p1SortCol, p1SortDir])

  const overrideCount = Object.keys(etaOverrides).length
  const qtyOverrideCount = Object.keys(qtyOverrides).length

  // Build a map of demandId → Set<demandId> for items that share supply components,
  // derived from optimizer warnings (CrossProductConflict / NewProductConflict).
  const competingItemsMap = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const w of (data?.optimizerWarnings ?? []) as Array<{ affectedDemandIds: string[]; supplySKU?: string; type?: string }>) {
      if (!w.affectedDemandIds?.length) continue
      for (const id of w.affectedDemandIds) {
        const others = w.affectedDemandIds.filter(x => x !== id)
        const existing = map.get(id) ?? new Set<string>()
        others.forEach(o => existing.add(o))
        map.set(id, existing)
      }
    }
    return map
  }, [data?.optimizerWarnings])

  // Build a lookup of demandId → review item (for ETA override impact preview)
  const reviewItemByDemandId = useMemo(() => {
    const map = new Map<string, any>()
    for (const item of (data?.reviewItems ?? [])) map.set(item.demandId, item)
    return map
  }, [data?.reviewItems])

  // Filtered PO list for the Select Open POs modal
  const filteredAvailablePOs = useMemo(() => {
    let list = availableOpenPOs
    if (poModalCompany !== 'ALL') list = list.filter((po: any) => po.company === poModalCompany)
    if (poModalFilter.trim()) {
      const q = poModalFilter.toLowerCase()
      list = list.filter((po: any) =>
        po.sku.toLowerCase().includes(q) ||
        po.productName.toLowerCase().includes(q) ||
        (po.poNumber ?? '').toLowerCase().includes(q)
      )
    }
    return list
  }, [availableOpenPOs, poModalCompany, poModalFilter])

  // Merge preview stats
  const pendingActionCount = mergeData
    ? mergeData.actions.filter(a => EXECUTABLE.includes(a.action) && !rowStatus.has(a.demandId)).length
    : 0
  const appliedCount = mergeData
    ? [...rowStatus.values()].filter(s => s.state === 'ok').length
    : 0

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Production Schedule"
        subtitle="FTX + SBYL combined — against shared TFM supply"
        onRun={loadDemand}
        runLabel="Load Demand"
        loading={loading}
        fields={[
          { id: 'cutoff', label: 'Cutoff Date', type: 'date', value: cutoffDate, onChange: setCutoffDate },
          { id: 'adjustFrom', label: 'Adjust-From Date', type: 'date', value: adjustFromDate, onChange: setAdjustFromDate, optional: true },
        ]}
      />

      {/* Select Open POs toolbar — always visible, before Load Demand */}
      <div className="px-5 py-2 border-b border-border bg-surface flex items-center gap-3">
        <button
          onClick={openPOModal}
          className="flex items-center gap-1.5 text-xs font-mono border border-border rounded px-3 py-1.5 text-text-secondary hover:text-text-primary hover:border-accent transition-colors"
        >
          <PackagePlus size={13} />
          Select Open POs
          {selectedOpenPOs.length > 0 && (
            <span className="ml-1 bg-accent text-white text-[10px] font-semibold rounded-full px-1.5 py-0.5 leading-none">
              {selectedOpenPOs.length}
            </span>
          )}
        </button>
        {selectedOpenPOs.length > 0 && (
          <>
            <span className="text-xs text-text-secondary font-mono">
              {selectedOpenPOs.length} PO{selectedOpenPOs.length !== 1 ? 's' : ''} selected — will be factored into Load Demand
            </span>
            <button
              onClick={() => setSelectedOpenPOs([])}
              className="text-xs text-danger/70 hover:text-danger font-mono transition-colors"
            >
              Clear
            </button>
          </>
        )}
        {selectedOpenPOs.length === 0 && (
          <span className="text-xs text-text-secondary/60 font-mono italic">
            Optionally pick open ERP POs to pre-load before running demand analysis
          </span>
        )}
      </div>

      {summary && (
        <SummaryBar stats={phase === 1 ? [
          { label: 'FTX Generated', value: summary.ftxEstablishedCount },
          { label: 'SBYL Generated', value: summary.sbylEstablishedCount },
          { label: 'FTX New Product POs', value: summary.ftxNewProductCount },
          { label: 'SBYL New Product POs', value: summary.sbylNewProductCount },
          { label: 'Total Demand Items', value: summary.totalDemandItems },
          { label: 'No Recipe', value: summary.noRecipeCount ?? 0, color: (summary.noRecipeCount ?? 0) > 0 ? 'warning' : 'default' },
        ] : [
          { label: 'Scheduled', value: summary.totalScheduled },
          { label: 'Moved', value: summary.movedItems, color: summary.movedItems > 0 ? 'warning' : 'default' },
          { label: 'Infeasible-Locked', value: summary.infeasibleLocked, color: summary.infeasibleLocked > 0 ? 'danger' : 'default' },
          { label: 'Over-Capacity Days', value: summary.overCapacityDays, color: summary.overCapacityDays > 0 ? 'danger' : 'default' },
          { label: 'Conflicts', value: summary.conflicts, color: summary.conflicts > 0 ? 'warning' : 'default' },
          { label: 'Dropped', value: summary.droppedCount, color: summary.droppedCount > 0 ? 'warning' : 'default' },
          { label: 'No Recipe', value: summary.noRecipeCount ?? 0, color: (summary.noRecipeCount ?? 0) > 0 ? 'warning' : 'default' },
        ]} />
      )}

      {error && (
        <div className="mx-4 my-2 bg-danger/10 border border-danger/30 rounded px-3 py-2 text-xs text-danger font-mono flex items-center gap-2">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      {!data && !loading && (
        <div className="flex-1 flex items-center justify-center text-text-secondary font-mono text-sm">
          Click "Load Demand" to fetch the full FTX + SBYL demand against TFM supply
        </div>
      )}

      {/* Phase 1: Demand Review */}
      {data && phase === 1 && (
        <div className="flex-1 overflow-auto p-4 space-y-4">
          <div className="card">
            <div className="px-4 py-2 border-b border-border flex flex-wrap items-center gap-2">
              <div className="section-header shrink-0">
                Demand Review — {sortedFilteredReviewItems.length}{sortedFilteredReviewItems.length !== reviewItems.length ? ` / ${reviewItems.length}` : ''} items
              </div>
              {/* Type filter */}
              <div className="flex rounded border border-border overflow-hidden text-[10px] font-mono">
                {(['all', 'Generated', 'NewProductPO', 'SelectedPO'] as const).map(f => (
                  <button key={f} onClick={() => setP1TypeFilter(f)}
                    className={`px-2 py-1 transition-colors ${p1TypeFilter === f ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
                    {f === 'all' ? 'All Types' : f === 'Generated' ? 'Generated' : f === 'NewProductPO' ? 'New Product' : 'Selected PO'}
                  </button>
                ))}
              </div>
              {/* Company filter */}
              <div className="flex rounded border border-border overflow-hidden text-[10px] font-mono">
                {(['ALL', 'FTX', 'SBYL'] as const).map(c => (
                  <button key={c} onClick={() => setP1CoFilter(c)}
                    className={`px-2 py-1 transition-colors ${p1CoFilter === c ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
                    {c}
                  </button>
                ))}
              </div>
              <div className="relative ml-auto">
                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none" />
                <input
                  type="text"
                  placeholder="Filter by SKU, product, company, PO#..."
                  value={filterText}
                  onChange={e => setFilterText(e.target.value)}
                  className="bg-bg border border-border rounded pl-7 pr-3 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent w-64"
                />
              </div>
            </div>
            <table className="data-table">
              <thead>
                {/* Sort header row */}
                <tr>
                  {([
                    { label: 'Type',            col: 'type'                         },
                    { label: 'Co.',             col: 'company'                      },
                    { label: 'SKU',             col: 'sku'                          },
                    { label: 'Product',         col: 'productName'                  },
                    { label: 'PO #',            col: 'poNumber'                     },
                    { label: 'Rec. ETA',        col: 'recommendedETA'               },
                    { label: 'Curr Inv',        col: 'currentInventory', right: true },
                    { label: 'Curr DOC',        col: 'currentDOC',       right: true },
                    { label: 'Qty',             col: 'qty',              right: true },
                    { label: 'ADS',             col: 'ads',              right: true },
                    { label: 'DOC @ Trigger',   col: 'projectedDOCAtTrigger', right: true },
                    { label: 'Next PO',         col: null                            },
                    { label: 'Override ETA',    col: null                            },
                  ] as { label: string; col: string | null; right?: boolean }[]).map(({ label, col, right }) =>
                    col ? (
                      <th key={col} className={`cursor-pointer select-none hover:text-text-primary transition-colors ${right ? 'text-right' : ''}`}
                        onClick={() => toggleP1Sort(col)}>
                        <span className={`inline-flex items-center gap-1 ${right ? 'flex-row-reverse' : ''}`}>
                          {label}
                          {p1SortCol === col
                            ? p1SortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />
                            : <ChevronsUpDown size={10} className="opacity-30" />}
                        </span>
                      </th>
                    ) : <th key={label} className={right ? 'text-right' : ''}>{label}</th>
                  )}
                </tr>
                {/* Column filter row — sticky below header (top: 35px) */}
                <tr>
                  {([
                    'type', 'company', 'sku', 'productName', 'poNumber',
                    'recommendedETA', 'currentInventory', 'currentDOC',
                    'qty', 'ads', 'projectedDOCAtTrigger', null, null,
                  ] as (string | null)[]).map((col, idx) => (
                    <th key={idx} style={{ padding: '3px 6px', top: '35px', position: 'sticky', zIndex: 9, background: '#edf2f8', borderBottom: '2px solid #b8c8da', boxShadow: '0 2px 4px rgba(15,23,42,0.08)' }}>
                      {col ? (
                        <input
                          value={p1ColFilters[col] ?? ''}
                          onChange={e => setP1ColFilters(prev => {
                            const next = { ...prev }
                            if (e.target.value) next[col] = e.target.value
                            else delete next[col]
                            return next
                          })}
                          placeholder="…"
                          className="w-full bg-white border border-border/60 rounded px-1.5 py-0.5 text-[10px] font-mono focus:outline-none focus:border-accent"
                          style={{ minWidth: 0, color: 'var(--text-primary)' }}
                        />
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedFilteredReviewItems.map((item: any) => {
                  const hasOverride = !!etaOverrides[item.demandId]
                  const noRecipe = item.tfmLinked && !item.hasRecipe
                  return (
                    <tr key={item.demandId} className={`table-row-comfortable ${noRecipe ? 'opacity-60' : ''}`}>
                      <td>
                        <div className="flex flex-col gap-1">
                          {item.type === 'Generated'
                            ? <span className="chip text-[10px] bg-accent/10 text-accent border border-accent/30 px-1.5 py-0.5">Generated</span>
                            : item.type === 'SelectedPO'
                            ? <span className="chip text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/30 px-1.5 py-0.5 flex items-center gap-1"><PackagePlus size={9} /> Selected PO</span>
                            : <span className="chip text-[10px] bg-surface text-text-secondary border border-border px-1.5 py-0.5">New Product PO</span>
                          }
                          {item.isRpkg && item.masterSku && (
                            <span className="chip text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/30 px-1.5 py-0.5" title={`Component of master item ${item.masterSku}`}>
                              RPKG · {item.masterSku}
                            </span>
                          )}
                          {noRecipe && (
                            <span className="chip text-[10px] bg-warning/10 text-warning border border-warning/30 px-1.5 py-0.5 flex items-center gap-1">
                              <AlertTriangle size={8} /> No Recipe
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="font-mono text-xs text-text-secondary">{item.company}</td>
                      <td className="font-mono text-xs font-semibold">
                        <InventoryLink sku={item.sku} company={item.company} name={item.productName} />
                      </td>
                      <td className="text-xs text-text-secondary">
                        {item.productName}
                        {noRecipe && (
                          <span className="ml-2 text-[10px] text-warning italic">— will be dropped from schedule</span>
                        )}
                      </td>
                      <td className="font-mono text-xs text-text-secondary">{item.poNumber || '—'}</td>
                      <td className={`font-mono text-xs ${hasOverride ? 'text-text-secondary line-through' : ''}`}>
                        {fmtDate(item.recommendedETA)}
                        {hasOverride && (
                          <span className="ml-2 text-warning no-underline" style={{ textDecoration: 'none' }}>
                            → {fmtDate(etaOverrides[item.demandId])}
                          </span>
                        )}
                      </td>
                      <td className="font-mono text-right">
                        {item.currentInventory != null ? item.currentInventory.toLocaleString() : '—'}
                      </td>
                      <td className="font-mono text-right text-xs" style={{
                        color: item.currentDOC === null ? 'var(--text-secondary)' :
                               item.currentDOC <= 0    ? 'var(--danger)' :
                               item.currentDOC < 15    ? 'var(--danger)' :
                               item.currentDOC < 30    ? 'var(--warning)' : 'var(--success)',
                        fontWeight: item.currentDOC !== null && item.currentDOC <= 0 ? 700 : undefined,
                      }}>
                        {item.currentDOC != null ? `${item.currentDOC}d` : '—'}
                      </td>
                      <td className="font-mono text-right">{item.qty.toLocaleString()}</td>
                      <td className="font-mono text-right text-text-secondary">
                        {item.ads > 0 ? item.ads.toFixed(1) : '—'}
                      </td>
                      <td className="font-mono text-right text-text-secondary">
                        {item.projectedDOCAtTrigger > 0 ? `${item.projectedDOCAtTrigger.toFixed(1)}d` : '—'}
                      </td>
                      <td>
                        {item.futurePOs?.length > 0 ? (
                          <button
                            onClick={() => setFuturePOsModal({ sku: item.sku, company: item.company, productName: item.productName, pos: item.futurePOs })}
                            className="text-accent hover:underline font-mono text-xs text-left whitespace-nowrap"
                          >
                            {item.futurePOs[0].poNumber || `PO${item.futurePOs[0].poId}`}
                            <span className="text-text-secondary ml-1">· {fmtDate(item.futurePOs[0].eta)}</span>
                            {item.futurePOs.length > 1 && (
                              <span className="ml-1 text-[10px] text-text-secondary">+{item.futurePOs.length - 1}</span>
                            )}
                          </button>
                        ) : (
                          <span className="text-text-secondary text-xs">—</span>
                        )}
                      </td>
                      <td>
                        <div className="space-y-1">
                          <input
                            type="date"
                            value={etaOverrides[item.demandId] ?? ''}
                            onChange={e => {
                              const val = e.target.value
                              setEtaOverrides(o => {
                                const n = { ...o }
                                if (val) n[item.demandId] = val
                                else delete n[item.demandId]
                                return n
                              })
                            }}
                            className="bg-bg border border-border rounded px-2 py-0.5 text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                          />
                          {/* Impact preview when an override is set */}
                          {hasOverride && item.ads > 0 && (() => {
                            const overrideDate = new Date(etaOverrides[item.demandId])
                            const originalDate = new Date(item.recommendedETA)
                            const daysDiff = Math.round((overrideDate.getTime() - originalDate.getTime()) / 86400000)
                            const estimatedDOC = item.projectedDOCAtTrigger - daysDiff
                            // Find other items whose ETA lands within ±5 days of the override date
                            const nearby = (data?.reviewItems ?? []).filter((other: any) =>
                              other.demandId !== item.demandId &&
                              Math.abs(new Date(etaOverrides[other.demandId] ?? other.recommendedETA).getTime() - overrideDate.getTime()) <= 5 * 86400000 &&
                              other.hasRecipe
                            )
                            return (
                              <div className="text-[10px] font-mono space-y-0.5">
                                <div className={estimatedDOC < 15 ? 'text-danger' : estimatedDOC < 30 ? 'text-warning' : 'text-success'}>
                                  DOC at arrival: ~{estimatedDOC.toFixed(0)}d
                                </div>
                                {nearby.length > 0 && (
                                  <div className="text-text-secondary" title={nearby.map((o: any) => o.sku).join(', ')}>
                                    ⚡ {nearby.length} other item{nearby.length !== 1 ? 's' : ''} near this date
                                  </div>
                                )}
                              </div>
                            )
                          })()}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-xs text-text-secondary font-mono">
              {overrideCount > 0 && <span className="text-warning">{overrideCount} ETA override{overrideCount !== 1 ? 's' : ''} applied</span>}
              {overrideCount > 0 && qtyOverrideCount > 0 && <span className="text-text-secondary"> · </span>}
              {qtyOverrideCount > 0 && <span className="text-purple-400">{qtyOverrideCount} qty allocation{qtyOverrideCount !== 1 ? 's' : ''} locked</span>}
              {overrideCount === 0 && qtyOverrideCount === 0 && 'Override individual ETAs above, or proceed with recommended dates'}
            </p>
            <button onClick={() => generateSchedule()} disabled={loading} className="btn-primary">
              Generate Schedule →
            </button>
          </div>
        </div>
      )}

      {/* Phase 2: Production Calendar */}
      {data && phase === 2 && (
        <div className="flex-1 overflow-auto p-4 space-y-3">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setPhase(1)}
              className="text-xs text-accent hover:underline font-mono"
            >
              ← Back to Demand Review
            </button>
            <span className="text-xs text-text-secondary font-mono">
              {days.length} production day{days.length !== 1 ? 's' : ''} scheduled
            </span>
          </div>

          {days.map((day: any) => (
            <div
              key={day.date}
              className={`card ${day.hasConflict ? 'border border-warning/40' : ''}`}
            >
              <div className={`flex items-center justify-between px-4 py-2 border-b border-border ${day.isOverCapacity ? 'bg-danger/5' : ''}`}>
                <div className="flex items-center gap-4">
                  <span className="font-mono font-semibold text-sm text-text-primary">
                    {fmtDate(day.date, { weekday: 'short', month: 'short', day: 'numeric' })}
                  </span>
                  <CapacityBar current={day.totalQty} capacity={CAPACITY} />
                  <span className="font-mono text-xs text-text-secondary">
                    {day.totalQty.toLocaleString()} units
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {day.isOverCapacity && (
                    <span className="chip text-xs text-danger bg-danger/10 border border-danger/20">
                      OVER +{(day.totalQty - CAPACITY).toLocaleString()}
                    </span>
                  )}
                  {day.hasConflict && (
                    <button
                      onClick={() => setConflictDay(day)}
                      className="chip text-xs text-warning bg-warning/10 border border-warning/30 hover:bg-warning/20 transition-colors flex items-center gap-1"
                    >
                      <Zap size={10} /> Resolve Conflict
                    </button>
                  )}
                </div>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    {([
                      { label: 'Co.',        col: 'company'          },
                      { label: 'SKU',        col: 'sku'              },
                      { label: 'Product',    col: 'productName'      },
                      { label: 'PO #',       col: 'poNumber'         },
                      { label: 'Sched Qty',  col: 'scheduledQty',  right: true },
                      { label: 'Ordered',    col: 'orderedQty',    right: true },
                      { label: 'DOC at Date',col: 'docAtDate',     right: true },
                      { label: 'Move Reason / Competing', col: null },
                      { label: 'Feasibility',col: 'feasibilityStatus' },
                    ] as { label: string; col: string | null; right?: boolean }[]).map(({ label, col, right }) =>
                      col ? (
                        <th key={col} className={`cursor-pointer select-none hover:text-text-primary transition-colors ${right ? 'text-right' : ''}`}
                          onClick={() => toggleP2Sort(col)}>
                          <span className={`inline-flex items-center gap-1 ${right ? 'flex-row-reverse' : ''}`}>
                            {label}
                            {p2SortCol === col
                              ? p2SortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />
                              : <ChevronsUpDown size={10} className="opacity-30" />}
                          </span>
                        </th>
                      ) : <th key={label}>{label}</th>
                    )}
                    <th style={{ width: 44 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {(p2SortCol
                    ? [...day.items].sort((a: any, b: any) => {
                        const av = a[p2SortCol] ?? ''; const bv = b[p2SortCol] ?? ''
                        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
                        return p2SortDir === 'asc' ? cmp : -cmp
                      })
                    : day.items
                  ).map((item: any) => (
                    <tr
                      key={item.demandId}
                      className={`table-row-comfortable ${item.isInfeasibleLocked ? 'bg-danger/5' : ''}`}
                    >
                      <td className="font-mono text-xs text-text-secondary">{item.company}</td>
                      <td
                        className="font-mono text-xs font-semibold text-accent hover:underline cursor-pointer"
                        onClick={() => {
                          const dd = (data as any)?.drilldown?.[item.demandId]
                          if (dd) setDrilldownItem({ ...item, components: dd })
                        }}
                        title="Click to view recipe & supply breakdown"
                      >{item.sku}</td>
                      <td className="text-xs text-text-secondary">{item.productName}</td>
                      <td className="font-mono text-xs text-text-secondary">{item.poNumber || '—'}</td>
                      <td className="font-mono text-right">{item.scheduledQty.toLocaleString()}</td>
                      <td className="font-mono text-right text-text-secondary">{item.orderedQty.toLocaleString()}</td>
                      <td className="font-mono text-xs text-right">
                        {item.isNewProduct
                          ? <StatusBadge status="New Product" />
                          : item.docAtDate != null && isFinite(item.docAtDate) ? `${item.docAtDate.toFixed(1)}d` : '—'
                        }
                      </td>
                      <td className="text-xs text-text-secondary">
                        <div className="space-y-0.5">
                          {item.moveReason && <div>{item.moveReason}</div>}
                          {(() => {
                            const competing = competingItemsMap.get(item.demandId)
                            if (!competing?.size) return null
                            // Resolve demandIds to SKUs for the tooltip
                            const competingSKUs = [...competing]
                              .map(id => reviewItemByDemandId.get(id)?.sku ?? id.replace(/^gen-(FTX|SBYL)-/, '').split('-202')[0])
                              .slice(0, 5)
                            return (
                              <div
                                className="text-[10px] font-mono text-warning flex items-center gap-1 cursor-help"
                                title={`Shares supply components with: ${competingSKUs.join(', ')}${competing.size > 5 ? ` +${competing.size - 5} more` : ''}`}
                              >
                                <Zap size={9} /> Competes with {competing.size} item{competing.size !== 1 ? 's' : ''} for supply
                              </div>
                            )
                          })()}
                        </div>
                      </td>
                      <td><StatusBadge status={item.feasibilityStatus} /></td>
                      <td>
                        <div className="flex items-center gap-1">
                          {item.isLocked && (
                            <span title="Locked — before adjust-from date">
                              <Lock size={10} className="text-locked" />
                            </span>
                          )}
                          {item.isInfeasibleLocked && (
                            <span title="Infeasible but locked — cannot move">
                              <AlertTriangle size={10} className="text-danger" />
                            </span>
                          )}
                          {item.optimizerWarnings?.length > 0 && (
                            <span title={`${item.optimizerWarnings.length} optimizer warning(s)`}>
                              <Zap size={10} className="text-warning" />
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {data.droppedItems?.length > 0 && (
            <div className="card p-4 space-y-2">
              <div className="section-header text-warning flex items-center gap-2">
                <Zap size={12} /> Dropped Items ({data.droppedItems.length})
              </div>
              <p className="text-xs text-text-secondary">
                These demand items could not be scheduled within the cutoff date after capacity cascading.
              </p>
              <div className="flex flex-wrap gap-2 mt-1">
                {data.droppedItems.map((item: any) => (
                  <span key={item.demandId} className="chip text-xs font-mono border border-warning/30 text-warning bg-warning/5">
                    {item.company} · {item.sku} · {item.qty?.toLocaleString() ?? '?'} units
                  </span>
                ))}
              </div>
            </div>
          )}

          {data.noRecipeItems?.length > 0 && (
            <div className="card">
              <div className="px-4 py-2 border-b border-border bg-warning/5 flex items-center gap-2">
                <AlertTriangle size={13} className="text-warning" />
                <span className="section-header text-warning">
                  No Recipe — Excluded from Schedule ({data.noRecipeItems.length})
                </span>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-text-secondary mb-3">
                  These items have demand but no manufacturing recipe in TFM. They cannot be scheduled until a recipe is set up.
                  They were included in the demand review above but excluded from production scheduling.
                </p>
                <div className="overflow-auto rounded border border-border">
                  <table className="data-table text-xs w-full">
                    <thead>
                      <tr>
                        <th>Co.</th>
                        <th>SKU</th>
                        <th>Product</th>
                        <th>PO #</th>
                        <th>Target ETA</th>
                        <th className="text-right">Qty</th>
                        <th>Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.noRecipeItems.map((item: any) => (
                        <tr key={item.demandId} className="table-row-comfortable">
                          <td className="font-mono text-xs text-text-secondary">{item.company}</td>
                          <td className="font-mono text-xs font-semibold">
                            <InventoryLink sku={item.sku} company={item.company} name={item.productName} />
                          </td>
                          <td className="text-xs text-text-secondary">{item.productName}</td>
                          <td className="font-mono text-xs text-text-secondary">{item.poNumber || '—'}</td>
                          <td className="font-mono text-xs">{fmtDate(item.recommendedETA)}</td>
                          <td className="font-mono text-right">{item.qty.toLocaleString()}</td>
                          <td>
                            <span className="chip text-[10px] bg-surface text-text-secondary border border-border px-1.5 py-0.5">
                              {item.isNewProduct ? 'New Product PO' : 'Generated'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ── Phase 3: ERP Sync ──────────────────────────────────────── */}
          <div className="card">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <GitMerge size={14} className="text-accent" />
                <span className="section-header">ERP Sync — Merge to FTX &amp; SBYL</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-text-secondary font-mono whitespace-nowrap">Lock orders on/before:</label>
                  <input
                    type="date"
                    value={lockDate}
                    onChange={e => { setLockDate(e.target.value); setMergeData(null); setRowStatus(new Map()) }}
                    className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                  />
                </div>
                <button
                  onClick={loadMergePreview}
                  disabled={mergeLoading}
                  className="btn-secondary flex items-center gap-1.5"
                >
                  {mergeLoading
                    ? <><RefreshCw size={11} className="animate-spin" /> Loading…</>
                    : <><RefreshCw size={11} /> Preview Changes</>
                  }
                </button>
              </div>
            </div>

            {mergeError && (
              <div className="px-4 py-2 bg-danger/5 border-b border-danger/20 flex items-center gap-2 text-xs text-danger font-mono">
                <AlertTriangle size={11} /> {mergeError}
              </div>
            )}

            {!mergeData && !mergeLoading && (
              <div className="px-4 py-6 text-center text-xs text-text-secondary font-mono">
                Click "Preview Changes" to compare the generated schedule against existing FTX &amp; SBYL purchase orders.
                Orders on/before the lock date will not be touched.
              </div>
            )}

            {mergeData && (
              <>
                {/* Merge summary chips */}
                <div className="px-4 py-2 border-b border-border flex items-center gap-3 flex-wrap">
                  {[
                    { key: 'insert',  label: 'Create',  color: 'text-accent bg-accent/10 border-accent/30' },
                    { key: 'update',  label: 'Update',  color: 'text-warning bg-warning/10 border-warning/30' },
                    { key: 'split',   label: 'Split',   color: 'text-purple-400 bg-purple-500/10 border-purple-500/30' },
                    { key: 'exclude', label: 'Exclude', color: 'text-danger bg-danger/10 border-danger/30' },
                    { key: 'match',   label: 'Match',   color: 'text-success bg-success/10 border-success/30' },
                    { key: 'locked',  label: 'Locked',  color: 'text-locked bg-locked/10 border-locked/30' },
                    { key: 'skip',    label: 'Skip',    color: 'text-text-secondary bg-surface border-border' },
                  ].map(({ key, label, color }) => (
                    <span key={key} className={`chip text-xs border font-mono ${color}`}>
                      {label}: {mergeData.summary[key] ?? 0}
                    </span>
                  ))}
                  {appliedCount > 0 && (
                    <span className="chip text-xs border border-success/30 text-success bg-success/10 font-mono ml-auto">
                      {appliedCount} applied this session
                    </span>
                  )}
                </div>

                {/* Filter bar */}
                <div className="px-4 py-2 border-b border-border flex flex-wrap items-center gap-2">
                  {/* Text search */}
                  <input
                    value={mergeTextFilter}
                    onChange={e => setMergeTextFilter(e.target.value)}
                    placeholder="Filter SKU, product, PO#…"
                    className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent w-48"
                  />
                  {/* Company toggle */}
                  <div className="flex rounded border border-border overflow-hidden text-xs font-mono">
                    {(['ALL', 'FTX', 'SBYL'] as const).map(c => (
                      <button key={c} onClick={() => setMergeCompanyFilter(c)}
                        className={`px-2 py-1 transition-colors ${mergeCompanyFilter === c ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
                        {c}
                      </button>
                    ))}
                  </div>
                  {/* Action type filter chips */}
                  {([
                    { type: 'insert' as MergeActionType,      label: 'Create',  color: 'text-accent border-accent/40' },
                    { type: 'update_qty' as MergeActionType,  label: 'Upd Qty', color: 'text-warning border-warning/40' },
                    { type: 'update_eta' as MergeActionType,  label: 'Upd ETA', color: 'text-warning border-warning/40' },
                    { type: 'update_both' as MergeActionType, label: 'Upd Both',color: 'text-warning border-warning/40' },
                    { type: 'split' as MergeActionType,       label: 'Split',   color: 'text-purple-400 border-purple-500/40' },
                    { type: 'exclude' as MergeActionType,     label: 'Exclude', color: 'text-danger border-danger/40' },
                    { type: 'match' as MergeActionType,       label: 'Match',   color: 'text-success border-success/40' },
                  ]).map(({ type, label, color }) => {
                    const active = mergeActionFilter.includes(type)
                    return (
                      <button key={type}
                        onClick={() => setMergeActionFilter(prev =>
                          prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
                        )}
                        className={`chip text-[10px] border transition-colors ${active ? `${color} bg-accent/5` : 'text-text-secondary border-border opacity-50'}`}>
                        {label}
                      </button>
                    )
                  })}
                  {(mergeTextFilter || mergeActionFilter.length > 0 || mergeCompanyFilter !== 'ALL') && (
                    <button onClick={() => { setMergeTextFilter(''); setMergeActionFilter([]); setMergeCompanyFilter('ALL') }}
                      className="text-[10px] text-text-secondary hover:text-danger transition-colors font-mono">
                      ✕ Clear filters
                    </button>
                  )}
                  <span className="ml-auto text-[10px] text-text-secondary font-mono">
                    {filteredMergeActions.length} / {mergeData.actions.length} rows
                  </span>
                </div>

                {/* Bulk action toolbar — shown when rows are selected */}
                {someSelected && (
                  <div className="px-4 py-2 border-b border-accent/20 bg-accent/5 flex items-center gap-3">
                    <span className="text-xs font-mono text-accent font-semibold">
                      {selectedIds.size} row{selectedIds.size !== 1 ? 's' : ''} selected
                    </span>
                    <button
                      onClick={applySelected}
                      disabled={mergeAllLoading}
                      className="text-xs px-3 py-1 rounded border border-accent/40 text-accent hover:bg-accent/10 font-mono transition-colors"
                    >
                      Apply Selected
                    </button>
                    <button
                      onClick={() => setSelectedIds(new Set())}
                      className="text-xs text-text-secondary hover:text-text-primary font-mono transition-colors"
                    >
                      Deselect all
                    </button>
                  </div>
                )}

                {/* Actions table */}
                <div className="overflow-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        {/* Select-all checkbox */}
                        <th style={{ width: 32 }}>
                          <input
                            type="checkbox"
                            checked={allSelected}
                            ref={el => { if (el) el.indeterminate = someSelected && !allSelected }}
                            onChange={toggleSelectAll}
                            className="cursor-pointer accent-accent"
                            title="Select all visible executable rows"
                          />
                        </th>
                        {([
                          { label: 'Action',      col: 'action'          },
                          { label: 'Co.',         col: 'company'         },
                          { label: 'SKU',         col: 'sku'             },
                          { label: 'Product',     col: 'productName'     },
                          { label: 'Sched Date',  col: 'scheduledDate'   },
                          { label: 'Sched Qty',   col: 'scheduledQty',   right: true },
                          { label: 'Existing PO', col: 'existingPoNumber'},
                          { label: 'Exist ETA',   col: 'existingEta'     },
                          { label: 'Exist Qty',   col: 'existingQty',    right: true },
                          { label: 'Description', col: null              },
                        ] as { label: string; col: keyof MergeAction | null; right?: boolean }[]).map(({ label, col, right }) =>
                          col ? (
                            <th
                              key={col}
                              className={`cursor-pointer select-none hover:text-text-primary transition-colors ${right ? 'text-right' : ''}`}
                              onClick={() => toggleMergeSort(col)}
                            >
                              <span className={`inline-flex items-center gap-1 ${right ? 'flex-row-reverse' : ''}`}>
                                {label}
                                {mergeSortCol === col
                                  ? mergeSortDir === 'asc'
                                    ? <ChevronUp size={10} />
                                    : <ChevronDown size={10} />
                                  : <ChevronsUpDown size={10} className="opacity-30" />
                                }
                              </span>
                            </th>
                          ) : (
                            <th key={label} className={right ? 'text-right' : ''}>{label}</th>
                          )
                        )}
                        <th style={{ width: 80 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredMergeActions.map((a: MergeAction) => {
                        const status = rowStatus.get(a.demandId)
                        const isExecutable = EXECUTABLE.includes(a.action)
                        const isPending = status?.state === 'pending'
                        const isDone = status?.state === 'ok'
                        const isFailed = status?.state === 'err'
                        const isSelected = selectedIds.has(a.demandId)
                        return (
                          <tr
                            key={a.demandId}
                            className={`table-row-comfortable ${isDone ? 'opacity-60' : ''} ${isSelected ? 'bg-accent/5' : ''}`}
                            onClick={() => isExecutable && !isDone && toggleSelectRow(a.demandId)}
                            style={{ cursor: isExecutable && !isDone ? 'pointer' : 'default' }}
                          >
                            <td onClick={e => e.stopPropagation()}>
                              {isExecutable && !isDone && (
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleSelectRow(a.demandId)}
                                  className="cursor-pointer accent-accent"
                                />
                              )}
                            </td>
                            <td>
                              <span className={`chip text-[10px] border px-1.5 py-0.5 ${ACTION_COLOR[a.action]}`}>
                                {ACTION_LABEL[a.action]}
                              </span>
                            </td>
                            <td className="font-mono text-xs text-text-secondary">{a.company}</td>
                            <td className="font-mono text-xs font-semibold">{a.sku}</td>
                            <td className="text-xs text-text-secondary max-w-[180px] truncate">{a.productName}</td>
                            <td className="font-mono text-xs">{fmtDate(a.scheduledDate)}</td>
                            <td className="font-mono text-right">{a.scheduledQty.toLocaleString()}</td>
                            <td className="font-mono text-xs text-text-secondary">{a.existingPoNumber || '—'}</td>
                            <td className="font-mono text-xs">
                              {a.existingEta
                                ? <span className={a.action === 'update_eta' || a.action === 'update_both' ? 'text-warning' : 'text-text-secondary'}>
                                    {fmtDate(a.existingEta)}
                                  </span>
                                : <span className="text-text-secondary">—</span>
                              }
                            </td>
                            <td className="font-mono text-right text-text-secondary">
                              {a.existingQty != null ? a.existingQty.toLocaleString() : '—'}
                            </td>
                            <td className="text-xs text-text-secondary">
                              {isFailed
                                ? <span className="text-danger">{status?.msg}</span>
                                : isDone
                                ? <span className="text-success">{status?.msg ?? '✓ Done'}</span>
                                : a.description
                              }
                            </td>
                            <td onClick={e => e.stopPropagation()}>
                              {isExecutable && !isDone && (
                                <button
                                  onClick={() => applyRow(a)}
                                  disabled={isPending}
                                  className={`text-[10px] px-2 py-0.5 rounded border font-mono transition-colors
                                    ${isPending
                                      ? 'text-text-secondary border-border cursor-wait'
                                      : isFailed
                                      ? 'text-danger border-danger/40 hover:bg-danger/10'
                                      : 'text-accent border-accent/40 hover:bg-accent/10'
                                    }`}
                                >
                                  {isPending ? '…' : isFailed ? 'Retry' : 'Apply'}
                                </button>
                              )}
                              {isDone && <CheckCircle size={13} className="text-success mx-auto" />}
                              {a.action === 'locked' && <Lock size={11} className="text-locked mx-auto" />}
                              {(a.action === 'no_sku' || a.action === 'skip') && <XCircle size={11} className="text-danger mx-auto" />}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Merge All footer */}
                {pendingActionCount > 0 && (
                  <div className="px-4 py-3 border-t border-border flex items-center justify-between">
                    <p className="text-xs text-text-secondary font-mono">
                      {pendingActionCount} pending action{pendingActionCount !== 1 ? 's' : ''} — locked &amp; matched rows will be skipped
                    </p>
                    <button
                      onClick={applyAll}
                      disabled={mergeAllLoading}
                      className="btn-primary flex items-center gap-1.5"
                    >
                      {mergeAllLoading
                        ? <><RefreshCw size={11} className="animate-spin" /> Merging…</>
                        : <><GitMerge size={11} /> Merge All Unlocked ({pendingActionCount})</>
                      }
                    </button>
                  </div>
                )}
                {pendingActionCount === 0 && appliedCount > 0 && (
                  <div className="px-4 py-3 border-t border-border text-xs text-success font-mono flex items-center gap-2">
                    <CheckCircle size={12} /> All actions applied — click "Preview Changes" to refresh.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Select Open POs Modal ─────────────────────────────── */}
      {showPOModal && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6"
          onClick={e => { if (e.target === e.currentTarget) setShowPOModal(false) }}
        >
          <div className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col">
            {/* Header */}
            <div className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <PackagePlus size={16} className="text-purple-400" />
                <span className="font-semibold text-sm text-text-primary">Select Open POs</span>
                <span className="text-xs text-text-secondary font-mono">— chosen POs will be factored into the DOC simulation when you click Load Demand</span>
              </div>
              <button onClick={() => setShowPOModal(false)} className="text-text-secondary hover:text-text-primary transition-colors">
                <X size={16} />
              </button>
            </div>

            {/* Filter bar */}
            <div className="px-5 py-3 border-b border-border flex items-center gap-3 shrink-0">
              <div className="relative">
                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none" />
                <input
                  type="text"
                  placeholder="Filter SKU, product, PO#..."
                  value={poModalFilter}
                  onChange={e => setPoModalFilter(e.target.value)}
                  className="bg-bg border border-border rounded pl-7 pr-3 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent w-56"
                />
              </div>
              <div className="flex rounded border border-border overflow-hidden text-xs font-mono">
                {(['ALL', 'FTX', 'SBYL'] as const).map(c => (
                  <button key={c} onClick={() => setPoModalCompany(c)}
                    className={`px-2 py-1 transition-colors ${poModalCompany === c ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
                    {c}
                  </button>
                ))}
              </div>
              <span className="ml-auto text-xs text-text-secondary font-mono">
                {filteredAvailablePOs.length} PO{filteredAvailablePOs.length !== 1 ? 's' : ''} · {selectedOpenPOs.length} selected
              </span>
            </div>

            {/* Table body */}
            <div className="flex-1 overflow-auto">
              {poModalLoading && (
                <div className="flex items-center justify-center py-12 gap-2 text-text-secondary font-mono text-sm">
                  <Loader2 size={16} className="animate-spin" /> Loading open POs…
                </div>
              )}
              {poModalError && (
                <div className="px-5 py-4 text-danger text-xs font-mono flex items-center gap-2">
                  <AlertTriangle size={12} /> {poModalError}
                </div>
              )}
              {!poModalLoading && !poModalError && filteredAvailablePOs.length === 0 && (
                <div className="flex items-center justify-center py-12 text-text-secondary font-mono text-sm">
                  No open POs found for the selected filters
                </div>
              )}
              {!poModalLoading && !poModalError && filteredAvailablePOs.length > 0 && (
                <table className="data-table w-full text-xs">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}></th>
                      <th>Co.</th>
                      <th>PO #</th>
                      <th>SKU</th>
                      <th>Product</th>
                      <th>ETA</th>
                      <th className="text-right">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAvailablePOs.map((po: any) => {
                      const selected = isPOSelected(po)
                      return (
                        <tr
                          key={`${po.company}-${po.poId}-${po.poItemId}`}
                          className={`table-row-comfortable cursor-pointer transition-colors ${selected ? 'bg-purple-500/5' : 'hover:bg-surface'}`}
                          onClick={() => togglePOSelection(po)}
                        >
                          <td onClick={e => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => togglePOSelection(po)}
                              className="cursor-pointer accent-purple-500"
                            />
                          </td>
                          <td className="font-mono text-text-secondary">{po.company}</td>
                          <td className="font-mono text-text-secondary">{po.poNumber || '—'}</td>
                          <td className="font-mono font-semibold">{po.sku}</td>
                          <td className="text-text-secondary max-w-[220px] truncate">{po.productName}</td>
                          <td className="font-mono">{po.eta ? new Date(po.eta).toLocaleDateString() : '—'}</td>
                          <td className="font-mono text-right">{po.qty?.toLocaleString() ?? '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-border flex items-center justify-between shrink-0 bg-bg/50">
              <div className="text-xs font-mono text-text-secondary">
                {selectedOpenPOs.length === 0
                  ? 'No POs selected — Load Demand will run without pre-selected arrivals'
                  : <span className="text-purple-400 font-semibold">{selectedOpenPOs.length} PO{selectedOpenPOs.length !== 1 ? 's' : ''} selected</span>
                }
              </div>
              <div className="flex items-center gap-2">
                {selectedOpenPOs.length > 0 && (
                  <button
                    onClick={() => setSelectedOpenPOs([])}
                    className="text-xs font-mono text-text-secondary hover:text-danger transition-colors px-2 py-1"
                  >
                    Clear All
                  </button>
                )}
                <button
                  onClick={() => setShowPOModal(false)}
                  className="btn-primary text-xs"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Component Drilldown Panel ──────────────────────────── */}
      {drilldownItem && (
        <div className="fixed inset-0 z-50 flex items-start justify-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDrilldownItem(null)} />
          <div className="relative w-[580px] h-full bg-surface border-l border-border overflow-y-auto flex flex-col shadow-2xl">
            {/* Header */}
            <div className="sticky top-0 bg-surface border-b border-border px-5 py-3 z-10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Package size={15} className="text-accent" />
                  <div>
                    <div className="font-mono text-sm font-bold text-text-primary">{drilldownItem.sku}</div>
                    <div className="text-xs text-text-secondary">{drilldownItem.productName}</div>
                  </div>
                  <span className="ml-2 chip text-[10px] border border-border font-mono text-text-secondary">{drilldownItem.company}</span>
                </div>
                <button onClick={() => setDrilldownItem(null)} className="text-text-secondary hover:text-text-primary transition-colors"><X size={18} /></button>
              </div>
              {/* Summary row */}
              <div className="flex items-center gap-4 mt-2 text-xs font-mono">
                <span>Sched: <span className="font-semibold">{fmtDate(drilldownItem.scheduledDate)}</span></span>
                <span>Ordered: <span className="font-semibold">{(drilldownItem.orderedQty ?? drilldownItem.scheduledQty)?.toLocaleString()}</span></span>
                <span>Scheduled: <span className="font-semibold">{drilldownItem.scheduledQty?.toLocaleString()}</span></span>
                <StatusBadge status={drilldownItem.feasibilityStatus} />
              </div>
              {drilldownItem.feasibilityStatus === 'Partial' && (
                <div className="mt-1.5 text-xs text-warning font-mono">
                  ⚠ Can produce <strong>{drilldownItem.scheduledQty?.toLocaleString()}</strong> of <strong>{(drilldownItem.orderedQty ?? drilldownItem.scheduledQty)?.toLocaleString()}</strong> ordered — limited by component stock below
                </div>
              )}
              {drilldownItem.feasibilityStatus === 'None' && (
                <div className="mt-1.5 text-xs text-danger font-mono">✗ Cannot produce — insufficient components</div>
              )}
            </div>

            {/* Recipe breakdown */}
            <div className="flex-1 p-5 space-y-4">
              {(!drilldownItem.components || drilldownItem.components.length === 0) ? (
                <div className="text-center text-text-secondary font-mono text-sm py-8">No recipe components found for this SKU</div>
              ) : (
                drilldownItem.components.map((comp: any, i: number) => {
                  const pct = comp.qtyNeeded > 0 ? Math.min(100, (comp.qtyAllocated / comp.qtyNeeded) * 100) : 100
                  return (
                    <div key={i} className={`card p-4 space-y-3 ${comp.isBottleneck ? 'border-warning/40 border' : ''}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-mono text-xs font-semibold text-text-primary">{comp.sku}</div>
                          <div className="text-xs text-text-secondary">{comp.name}</div>
                          <span className="chip text-[10px] border border-border text-text-secondary font-mono mt-1">{comp.category}</span>
                        </div>
                        <div className="text-right shrink-0">
                          {comp.isBottleneck
                            ? <span className="chip text-[10px] border border-warning/40 text-warning bg-warning/10 font-semibold">⚠ Bottleneck</span>
                            : <span className="chip text-[10px] border border-success/40 text-success bg-success/10">✓ Sufficient</span>
                          }
                        </div>
                      </div>

                      {/* Qty bar */}
                      <div>
                        <div className="flex justify-between text-[10px] font-mono text-text-secondary mb-1">
                          <span>Allocated: <strong className={comp.isBottleneck ? 'text-warning' : 'text-success'}>{comp.qtyAllocated.toLocaleString()}</strong></span>
                          <span>Needed: <strong>{comp.qtyNeeded.toLocaleString()}</strong></span>
                        </div>
                        <div className="h-2 bg-bg rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${comp.isBottleneck ? 'bg-warning' : 'bg-success'}`} style={{ width: `${pct}%` }} />
                        </div>
                        <div className="flex justify-between text-[10px] font-mono text-text-secondary mt-1">
                          <span>{comp.qtyPerUnit} per unit</span>
                          <span>On-hand: {comp.onHand.toLocaleString()}</span>
                        </div>
                      </div>

                      {/* Incoming POs for bottleneck */}
                      {comp.isBottleneck && comp.incomingPOs.length > 0 && (
                        <div>
                          <div className="text-[10px] font-mono text-text-secondary uppercase tracking-wider mb-1.5">Incoming Supply</div>
                          <div className="space-y-1">
                            {comp.incomingPOs.slice(0, 5).map((po: any, j: number) => (
                              <div key={j} className="flex items-center justify-between text-xs font-mono bg-bg rounded px-2 py-1">
                                <span className="text-accent">{po.poNumber}</span>
                                <span className="text-text-secondary">{fmtDate(po.eta)}</span>
                                <span className="font-semibold">+{po.qty.toLocaleString()}</span>
                              </div>
                            ))}
                            {comp.incomingPOs.length > 5 && (
                              <div className="text-[10px] text-text-secondary font-mono text-center">+{comp.incomingPOs.length - 5} more incoming POs</div>
                            )}
                          </div>
                          {comp.incomingPOs.length === 0 && (
                            <div className="text-xs text-danger font-mono">No incoming supply POs — order more {comp.sku}</div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Future POs modal — shows all upcoming open POs for a given SKU */}
      {futurePOsModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setFuturePOsModal(null)}>
          <div className="bg-surface rounded-xl shadow-2xl border border-border w-full max-w-lg max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-start justify-between p-4 border-b border-border">
              <div>
                <div className="font-mono text-sm font-semibold text-text-primary">{futurePOsModal.sku}</div>
                <div className="text-xs text-text-secondary mt-0.5">{futurePOsModal.productName}</div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="chip text-[10px] border border-border text-text-secondary font-mono">{futurePOsModal.company}</span>
                  <span className="text-[10px] text-text-secondary">{futurePOsModal.pos.length} open PO{futurePOsModal.pos.length !== 1 ? 's' : ''}</span>
                </div>
              </div>
              <button onClick={() => setFuturePOsModal(null)} className="text-text-secondary hover:text-text-primary transition-colors">
                <X size={16} />
              </button>
            </div>
            {/* PO list */}
            <div className="overflow-y-auto flex-1">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-text-secondary font-mono uppercase tracking-wider text-[10px] border-b border-border">
                    <th className="text-left px-4 py-2">PO Number</th>
                    <th className="text-left px-4 py-2">ETA</th>
                    <th className="text-right px-4 py-2">Qty</th>
                    <th className="text-left px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {futurePOsModal.pos.map((po: any, i: number) => (
                    <tr key={i} className={`border-b border-border/50 ${i === 0 ? 'bg-accent/5' : ''}`}>
                      <td className="px-4 py-2.5 font-mono font-semibold text-accent">
                        {po.poNumber || `PO${po.poId}`}
                        {i === 0 && <span className="ml-2 text-[10px] text-text-secondary font-normal">← next</span>}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-text-primary">{fmtDate(po.eta)}</td>
                      <td className="px-4 py-2.5 font-mono text-right font-semibold">{po.qty.toLocaleString()}</td>
                      <td className="px-4 py-2.5">
                        {po.draftCompleted
                          ? <span className="chip text-[10px] border border-success/40 text-success bg-success/10">Confirmed</span>
                          : <span className="chip text-[10px] border border-warning/40 text-warning bg-warning/10">Draft</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {conflictDay && (
        <ConflictResolutionPanel
          date={fmtDate(conflictDay.date)}
          items={conflictDay.conflicts?.flatMap((c: any) => c.competing) ?? []}
          supplyPools={conflictDay.conflicts ?? []}
          onConfirm={(qtys) => {
            // Lock the user's manual allocations and regenerate respecting them
            setQtyOverrides(prev => ({ ...prev, ...qtys }))
            setConflictDay(null)
            generateSchedule(qtys)  // pass directly to avoid stale-closure on state
          }}
          onClose={() => setConflictDay(null)}
        />
      )}
    </div>
  )
}
