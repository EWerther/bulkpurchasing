'use client'

import { useState, useEffect, useMemo, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Search, RefreshCw, AlertTriangle, ChevronUp, ChevronDown, ChevronsUpDown, Package2 } from 'lucide-react'
import { SummaryBar } from '@/components/shared/SummaryBar'
import { fmtDate } from '@/lib/utils/dates'

interface InventoryItem {
  itemId: number
  sku: string
  productName: string
  company: 'FTX' | 'SBYL'
  onHand: number
  ads: number
  doc: number | null
  incomingPos: { poNumber: string; eta: string; qty: number }[]
}

const MIN_DOC = 15  // safety threshold for colour coding

function docColor(doc: number | null) {
  if (doc === null) return 'text-text-secondary'
  if (doc <= 0)    return 'text-danger font-bold'
  if (doc < MIN_DOC) return 'text-danger'
  if (doc < 30)   return 'text-warning'
  return 'text-success'
}

function docBadge(doc: number | null) {
  if (doc === null) return null
  if (doc <= 0)    return <span className="chip text-[10px] border border-danger/40 text-danger bg-danger/10">ZERO STOCK</span>
  if (doc < MIN_DOC) return <span className="chip text-[10px] border border-danger/40 text-danger bg-danger/10">Critical</span>
  if (doc < 30)   return <span className="chip text-[10px] border border-warning/40 text-warning bg-warning/10">Low</span>
  return null
}

function InventoryPageInner() {
  const searchParams = useSearchParams()
  const preFilterSKU     = searchParams.get('sku') ?? ''
  const preFilterCompany = searchParams.get('company') ?? 'ALL'

  const [data, setData]         = useState<InventoryItem[]>([])
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [search, setSearch]     = useState(preFilterSKU)
  const [company, setCompany]   = useState<'ALL' | 'FTX' | 'SBYL'>(
    preFilterCompany === 'FTX' ? 'FTX' : preFilterCompany === 'SBYL' ? 'SBYL' : 'ALL'
  )
  const [showZeroADS, setShowZeroADS] = useState(false)
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'critical' | 'low' | 'zero' | 'none'>('ALL')
  const [sortCol, setSortCol]   = useState<keyof InventoryItem | null>('doc')
  const [sortDir, setSortDir]   = useState<'asc' | 'desc'>('asc')

  async function load() {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/inventory')
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      const json = await res.json()
      setData(json.items ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  function toggleSort(col: keyof InventoryItem) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const filtered = useMemo(() => {
    let list = data
    // RPKG components always shown — they have effective ADS via their master item
    if (!showZeroADS) list = list.filter((i: any) => i.ads > 0 || i.isRpkg)
    if (company !== 'ALL') list = list.filter(i => i.company === company)
    if (statusFilter !== 'ALL') {
      list = list.filter(i => {
        if (statusFilter === 'zero')     return i.doc !== null && i.doc <= 0
        if (statusFilter === 'critical') return i.doc !== null && i.doc > 0 && i.doc < MIN_DOC
        if (statusFilter === 'low')      return i.doc !== null && i.doc >= MIN_DOC && i.doc < 30
        if (statusFilter === 'none')     return i.doc === null || i.doc >= 30
        return true
      })
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(i =>
        i.sku.toLowerCase().includes(q) ||
        i.productName.toLowerCase().includes(q)
      )
    }
    if (!sortCol) return list
    return [...list].sort((a, b) => {
      const av = a[sortCol] ?? (sortCol === 'doc' ? 99999 : '')
      const bv = b[sortCol] ?? (sortCol === 'doc' ? 99999 : '')
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [data, showZeroADS, company, statusFilter, search, sortCol, sortDir])

  const criticalCount = filtered.filter(i => i.doc !== null && i.doc < MIN_DOC && i.ads > 0).length
  const zeroCount     = filtered.filter(i => i.onHand === 0 && i.ads > 0).length

  function SortTh({ col, label, right }: { col: keyof InventoryItem; label: string; right?: boolean }) {
    return (
      <th
        className={`cursor-pointer select-none hover:text-text-primary transition-colors ${right ? 'text-right' : ''}`}
        onClick={() => toggleSort(col)}
      >
        <span className={`inline-flex items-center gap-1 ${right ? 'flex-row-reverse' : ''}`}>
          {label}
          {sortCol === col
            ? sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />
            : <ChevronsUpDown size={10} className="opacity-30" />}
        </span>
      </th>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-surface border-b border-border px-4 py-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Package2 size={16} className="text-accent" />
          <div>
            <h1 className="font-mono text-sm font-bold tracking-widest uppercase text-text-primary">Inventory</h1>
            <p className="text-[11px] text-text-secondary font-mono">FTX + SBYL finished goods — pulled from customer warehouses</p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {/* Company toggle */}
          <div className="flex rounded border border-border overflow-hidden text-xs font-mono">
            {(['ALL', 'FTX', 'SBYL'] as const).map(c => (
              <button key={c} onClick={() => setCompany(c)}
                className={`px-3 py-1.5 transition-colors ${company === c ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
                {c}
              </button>
            ))}
          </div>

          {/* Status filter */}
          <div className="flex rounded border border-border overflow-hidden text-xs font-mono">
            <button onClick={() => setStatusFilter('ALL')}
              className={`px-3 py-1.5 transition-colors ${statusFilter === 'ALL' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
              All
            </button>
            <button onClick={() => setStatusFilter('critical')}
              className={`px-3 py-1.5 transition-colors ${statusFilter === 'critical' ? 'bg-danger text-white' : 'text-danger/70 hover:text-danger'}`}>
              Critical
            </button>
            <button onClick={() => setStatusFilter('low')}
              className={`px-3 py-1.5 transition-colors ${statusFilter === 'low' ? 'bg-warning text-white' : 'text-warning/70 hover:text-warning'}`}>
              Low
            </button>
            <button onClick={() => setStatusFilter('zero')}
              className={`px-3 py-1.5 transition-colors ${statusFilter === 'zero' ? 'bg-danger text-white' : 'text-danger/70 hover:text-danger'}`}>
              Zero Stock
            </button>
            <button onClick={() => setStatusFilter('none')}
              className={`px-3 py-1.5 transition-colors ${statusFilter === 'none' ? 'bg-surface-secondary text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}>
              No Status
            </button>
          </div>

          {/* Zero-ADS toggle */}
          <button
            onClick={() => setShowZeroADS(v => !v)}
            className={`chip text-xs border transition-colors ${showZeroADS ? 'border-accent text-accent bg-accent/10' : 'border-border text-text-secondary'}`}
          >
            {showZeroADS ? 'All items' : 'Active SKUs only'}
          </button>

          {/* Search */}
          <div className="relative">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search SKU or product…"
              className="bg-bg border border-border rounded pl-6 pr-3 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent w-52"
            />
          </div>

          <button onClick={load} disabled={loading} className="btn-secondary text-xs flex items-center gap-1.5">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      <SummaryBar stats={[
        { label: 'Total Items',   value: filtered.length },
        { label: 'Critical DOC',  value: criticalCount, color: criticalCount > 0 ? 'danger'  : 'default' },
        { label: 'Zero Stock',    value: zeroCount,     color: zeroCount > 0     ? 'warning' : 'default' },
        { label: 'FTX Items',     value: filtered.filter(i => i.company === 'FTX').length  },
        { label: 'SBYL Items',    value: filtered.filter(i => i.company === 'SBYL').length },
      ]} />

      {error && (
        <div className="mx-4 my-2 bg-danger/10 border border-danger/30 rounded px-3 py-2 text-xs text-danger font-mono flex items-center gap-2">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="data-table">
          <thead>
            <tr>
              <SortTh col="company"     label="Co."     />
              <SortTh col="sku"         label="SKU"     />
              <SortTh col="productName" label="Product" />
              <SortTh col="onHand"      label="On-Hand"    right />
              <SortTh col="ads"         label="ADS/day"    right />
              <SortTh col="doc"         label="DOC"        right />
              <th>Status</th>
              <th>Incoming POs</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="text-center py-12 text-text-secondary font-mono text-sm">Loading…</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={8} className="text-center py-12 text-text-secondary font-mono text-sm">No items match your filters</td></tr>
            )}
            {filtered.map(item => (
              <tr key={`${item.company}-${item.sku}`} className={`table-row-comfortable ${item.doc !== null && item.doc < MIN_DOC && item.ads > 0 ? 'bg-danger/3' : ''}`}>
                <td className="font-mono text-xs text-text-secondary">{item.company}</td>
                <td className="font-mono text-xs font-semibold">
                  {item.sku}
                  {(item as any).isRpkg && (
                    <div className="text-[10px] font-mono text-purple-400 font-normal">
                      RPKG → {(item as any).masterSku}
                    </div>
                  )}
                </td>
                <td className="text-xs text-text-secondary max-w-[280px] truncate" title={item.productName}>{item.productName}</td>
                <td className={`font-mono text-right ${item.onHand === 0 ? 'text-danger' : ''}`}>
                  {(item as any).isRpkg ? (
                    <div className="space-y-0.5">
                      <div title="Effective total (assembled beds + loose mattresses)">
                        {item.onHand.toLocaleString()}
                      </div>
                      <div className="text-[10px] text-text-secondary font-mono leading-tight">
                        <span title={`${(item as any).masterOnHand} assembled ${(item as any).masterSku}`}>
                          🛏 {(item as any).masterOnHand} assembled
                        </span>
                        <span className="mx-1">+</span>
                        <span title={`${(item as any).looseOnHand} loose ${item.sku}`}>
                          📦 {(item as any).looseOnHand} loose
                        </span>
                      </div>
                    </div>
                  ) : item.onHand.toLocaleString()}
                </td>
                <td className="font-mono text-right text-text-secondary">
                  {item.ads > 0 ? item.ads : <span className="opacity-40">—</span>}
                </td>
                <td className={`font-mono text-right ${docColor(item.doc)}`}>
                  {item.doc !== null ? `${item.doc}d` : <span className="opacity-40">—</span>}
                </td>
                <td>{docBadge(item.doc)}</td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {item.incomingPos.slice(0, 3).map((po, j) => (
                      <span key={j} className="chip text-[10px] border border-border font-mono text-text-secondary">
                        {po.poNumber} · {fmtDate(po.eta)} · +{po.qty.toLocaleString()}
                      </span>
                    ))}
                    {item.incomingPos.length > 3 && (
                      <span className="chip text-[10px] border border-border font-mono text-text-secondary">
                        +{item.incomingPos.length - 3} more
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function InventoryPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full" style={{ width: 28, height: 28, border: '3px solid #e8edf5', borderTopColor: '#4f46e5' }} />
      </div>
    }>
      <InventoryPageInner />
    </Suspense>
  )
}
