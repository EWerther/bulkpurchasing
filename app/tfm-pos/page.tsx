'use client'

import { useState, useEffect, useMemo } from 'react'
import { Search, AlertTriangle, CheckCircle, X, ChevronRight, Loader2 } from 'lucide-react'
import { SummaryBar } from '@/components/shared/SummaryBar'
import { fmtDate } from '@/lib/utils/dates'

// ── Types ──────────────────────────────────────────────────────────────────────

interface TFMSupplyPO {
  poId: number
  poNumber: string
  vendorName: string
  poDate: string | null
  submitDate: string | null
  eta: string | null
  etd: string | null
  isReceived: boolean
  receivedDate: string | null
  isDraftCompleted: boolean
  isFinal: boolean
  isForecast: boolean
  bookingNumber: string | null
  containerSize: string | null
  lineCount: number
  totalQty: number
}

interface ProductionOrderImpact {
  date: string
  orderNumber: string
  productSku: string
  productName: string
  orderedQty: number
  supplyNeeded: number
  stockWithoutPO: number
  stockWithPO: number
  isShortWithout: boolean
  isShortWith: boolean
}

interface LineImpact {
  lineId: number
  itemId: number
  sku: string
  itemName: string
  category: string
  poQty: number
  onHandQty: number
  otherPoArrivals: { poNumber: string; eta: string; qty: number }[]
  productionOrders: ProductionOrderImpact[]
  ordersAtRisk: number
  ordersShortBoth: number
  verdict: 'safe' | 'risky' | 'critical'
}

interface ImpactData {
  po: TFMSupplyPO
  lines: LineImpact[]
}

type POStatus = 'Open' | 'Received'

// ── Helpers ────────────────────────────────────────────────────────────────────

function getStatus(po: TFMSupplyPO): POStatus {
  if (po.isReceived) return 'Received'
  return 'Open'
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function POStatusBadge({ status }: { status: POStatus }) {
  const cls: Record<POStatus, string> = {
    Open:     'text-success border-success/30 bg-success/8',
    Received: 'text-accent border-accent/30 bg-accent/8',
  }
  return <span className={`chip text-xs border font-mono ${cls[status]}`}>{status}</span>
}

function VerdictBadge({ verdict, atRisk, shortBoth }: {
  verdict: 'safe' | 'risky' | 'critical'
  atRisk: number
  shortBoth: number
}) {
  if (verdict === 'safe') return (
    <span className="chip text-xs border text-success border-success/30 bg-success/8 flex items-center gap-1">
      <CheckCircle size={10} /> Safe to push
    </span>
  )
  if (verdict === 'risky') return (
    <span className="chip text-xs border text-warning border-warning/30 bg-warning/8 flex items-center gap-1">
      <AlertTriangle size={10} /> {atRisk} order{atRisk !== 1 ? 's' : ''} at risk
    </span>
  )
  return (
    <span className="chip text-xs border text-danger border-danger/30 bg-danger/8 flex items-center gap-1">
      <AlertTriangle size={10} /> {shortBoth} short regardless
    </span>
  )
}

// ── Impact modal content ───────────────────────────────────────────────────────

function ImpactContent({ data }: { data: ImpactData }) {
  const { po, lines } = data
  const totalAtRisk    = lines.reduce((s, l) => s + l.ordersAtRisk,    0)
  const totalShortBoth = lines.reduce((s, l) => s + l.ordersShortBoth, 0)
  const overallVerdict = totalShortBoth > 0 ? 'critical' : totalAtRisk > 0 ? 'risky' : 'safe'
  const riskLines      = lines.filter(l => l.ordersAtRisk > 0).length

  return (
    <div className="space-y-4">
      {/* Overall verdict banner */}
      <div className={`rounded-lg px-4 py-3 border text-xs font-mono ${
        overallVerdict === 'safe'
          ? 'bg-success/8 border-success/30 text-success'
          : overallVerdict === 'risky'
          ? 'bg-warning/8 border-warning/30 text-warning'
          : 'bg-danger/8 border-danger/30 text-danger'
      }`}>
        {overallVerdict === 'safe' &&
          '✅ All production orders are covered — this PO can be pushed without supply impact.'}
        {overallVerdict === 'risky' &&
          `⚠️ ${totalAtRisk} production order${totalAtRisk !== 1 ? 's' : ''} across ${riskLines} line${riskLines !== 1 ? 's' : ''} will be short without this PO.`}
        {overallVerdict === 'critical' &&
          `🚨 ${totalShortBoth} production order${totalShortBoth !== 1 ? 's' : ''} will be short even with this PO — additional action needed.`}
      </div>

      {/* Per-line cards */}
      {lines.map(line => (
        <div key={line.lineId} className={`card border ${
          line.verdict === 'critical' ? 'border-danger/40' :
          line.verdict === 'risky'    ? 'border-warning/40' :
          'border-border'
        }`}>
          {/* Line header */}
          <div className="px-4 py-3 border-b border-border flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono font-bold text-sm text-text-primary">{line.sku}</span>
                {line.category && (
                  <span className="text-xs font-mono chip border border-border text-text-secondary">{line.category}</span>
                )}
                <VerdictBadge verdict={line.verdict} atRisk={line.ordersAtRisk} shortBoth={line.ordersShortBoth} />
              </div>
              <div className="text-xs text-text-secondary mt-0.5">{line.itemName}</div>
            </div>
            <div className="flex items-center gap-4 text-xs font-mono shrink-0 flex-wrap">
              <span>This PO: <span className="text-success font-semibold">+{line.poQty.toLocaleString()}</span></span>
              <span>On Hand: <span className="text-text-primary font-semibold">{line.onHandQty.toLocaleString()}</span></span>
            </div>
          </div>

          {/* Other open POs for this item */}
          {line.otherPoArrivals.length > 0 && (
            <div className="px-4 py-2 border-b border-border/50 flex items-center gap-2 flex-wrap text-xs font-mono">
              <span className="text-text-secondary">Other open POs:</span>
              {line.otherPoArrivals.map((p, i) => (
                <span key={i} className="chip border border-success/40 bg-success/5 text-success">
                  ↑ {p.poNumber} · {fmtDate(p.eta)} · +{p.qty.toLocaleString()}
                </span>
              ))}
            </div>
          )}

          {/* Production orders table */}
          {line.productionOrders.length > 0 ? (
            <div className="overflow-auto">
              <table className="data-table text-xs w-full">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Order #</th>
                    <th>SKU</th>
                    <th>Product</th>
                    <th className="text-right">Units</th>
                    <th className="text-right">Supply Needed</th>
                    <th className="text-right">Stock w/o PO</th>
                    <th className="text-right">Stock w/ PO</th>
                    <th>Impact</th>
                  </tr>
                </thead>
                <tbody>
                  {line.productionOrders.map((order, i) => (
                    <tr
                      key={i}
                      className={
                        order.isShortWith    ? 'bg-danger/5'  :
                        order.isShortWithout ? 'bg-warning/5' : ''
                      }
                    >
                      <td className="font-mono-num">{fmtDate(order.date)}</td>
                      <td className="font-mono">{order.orderNumber}</td>
                      <td className="font-mono font-semibold">{order.productSku}</td>
                      <td className="text-text-secondary max-w-[130px] truncate" title={order.productName}>
                        {order.productName}
                      </td>
                      <td className="text-right font-mono-num">{order.orderedQty.toLocaleString()}</td>
                      <td className="text-right font-mono-num">{order.supplyNeeded.toLocaleString()}</td>
                      <td className={`text-right font-mono-num font-semibold ${order.isShortWithout ? 'text-danger' : 'text-success'}`}>
                        {Math.round(order.stockWithoutPO).toLocaleString()}
                      </td>
                      <td className={`text-right font-mono-num font-semibold ${order.isShortWith ? 'text-danger' : 'text-success'}`}>
                        {Math.round(order.stockWithPO).toLocaleString()}
                      </td>
                      <td>
                        {order.isShortWith ? (
                          <span className="chip text-xs text-danger border border-danger/30 bg-danger/8">Short</span>
                        ) : order.isShortWithout ? (
                          <span className="chip text-xs text-warning border border-warning/30 bg-warning/8">At Risk</span>
                        ) : (
                          <span className="chip text-xs text-success border border-success/30 bg-success/8">OK</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-4 py-3 text-xs text-text-secondary font-mono">
              No upcoming production orders consume this supply item in the next 180 days.
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function TFMPOsPage() {
  const [pos, setPos]               = useState<TFMSupplyPO[]>([])
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')
  const [search, setSearch]         = useState('')
  const [statusFilter, setStatusFilter] = useState<'All' | POStatus>('Open')
  const [sortKey, setSortKey] = useState<string>('eta')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  function SortTh({ col, label, className }: { col: string; label: string; className?: string }) {
    const active = sortKey === col
    return (
      <th className={`cursor-pointer select-none group ${className ?? ''}`} onClick={() => toggleSort(col)}>
        <span className="inline-flex items-center gap-1">
          {label}
          <span className={`transition-opacity ${active ? 'text-accent' : 'text-text-secondary opacity-0 group-hover:opacity-60'}`}>
            {active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
          </span>
        </span>
      </th>
    )
  }

  const [selectedPO, setSelectedPO]     = useState<TFMSupplyPO | null>(null)
  const [impactData, setImpactData]     = useState<ImpactData | null>(null)
  const [impactLoading, setImpactLoading] = useState(false)
  const [impactError, setImpactError]   = useState('')

  useEffect(() => { fetchPOs() }, [])

  async function fetchPOs() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/tfm-pos')
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      const json = await res.json()
      setPos(json.pos ?? [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function openImpact(po: TFMSupplyPO) {
    setSelectedPO(po)
    setImpactData(null)
    setImpactError('')
    setImpactLoading(true)
    try {
      const res = await fetch(`/api/tfm-pos/impact?poId=${po.poId}`)
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      setImpactData(await res.json())
    } catch (err: any) {
      setImpactError(err.message)
    } finally {
      setImpactLoading(false)
    }
  }

  const filtered = useMemo(() => {
    let list = pos
    if (statusFilter !== 'All') list = list.filter(p => getStatus(p) === statusFilter)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(p =>
        (p.poNumber ?? '').toLowerCase().includes(q) ||
        (p.vendorName ?? '').toLowerCase().includes(q)
      )
    }
    list = [...list].sort((a, b) => {
      let av: any, bv: any
      switch (sortKey) {
        case 'poNumber': av = a.poNumber ?? '';    bv = b.poNumber ?? '';    break
        case 'vendor':   av = a.vendorName ?? '';  bv = b.vendorName ?? '';  break
        case 'poDate':   av = a.poDate ?? '';      bv = b.poDate ?? '';      break
        case 'eta':      av = a.eta ?? '';         bv = b.eta ?? '';         break
        case 'etd':      av = a.etd ?? '';         bv = b.etd ?? '';         break
        case 'lines':    av = a.lineCount;         bv = b.lineCount;         break
        case 'qty':      av = a.totalQty;          bv = b.totalQty;          break
        case 'booking':  av = a.bookingNumber ?? ''; bv = b.bookingNumber ?? ''; break
        case 'status':   av = getStatus(a);        bv = getStatus(b);        break
        default:         av = ''; bv = ''
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return list
  }, [pos, statusFilter, search, sortKey, sortDir])

  const counts = useMemo(() => ({
    open:     pos.filter(p => getStatus(p) === 'Open').length,
    received: pos.filter(p => getStatus(p) === 'Received').length,
  }), [pos])

  const today = new Date(); today.setHours(0, 0, 0, 0)

  return (
    <div className="flex flex-col h-full">
      {/* ── Page header ── */}
      <div className="bg-surface border-b border-border px-4 py-3 space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="font-mono text-sm font-bold tracking-widest uppercase text-text-primary">
            TFM Supply POs
          </h1>
          <button onClick={fetchPOs} disabled={loading} className="btn-secondary text-xs">
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="PO number or vendor…"
              className="bg-bg border border-border rounded pl-7 pr-3 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent w-52"
            />
          </div>
          {/* Status filter */}
          <div className="flex rounded border border-border overflow-hidden">
            {(['All', 'Open', 'Received'] as const).map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1 text-xs font-mono transition-colors ${
                  statusFilter === s ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {s}
                {s !== 'All' && (
                  <span className="ml-1 opacity-60">
                    {counts[s.toLowerCase() as keyof typeof counts]}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      <SummaryBar stats={[
        { label: 'Total POs',   value: pos.length },
        { label: 'Showing',     value: filtered.length },
        { label: 'Open',        value: counts.open },
        { label: 'Received',    value: counts.received },
      ]} />

      {error && (
        <div className="mx-4 my-2 bg-danger/10 border border-danger/30 rounded px-3 py-2 text-xs text-danger font-mono flex items-center gap-2">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      {/* ── PO table ── */}
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 && !loading ? (
          <div className="text-center text-text-secondary font-mono text-sm py-16">
            No POs match your filters
          </div>
        ) : (
          <table className="data-table text-xs w-full">
            <thead className="sticky top-0 z-10">
              <tr>
                <SortTh col="poNumber" label="PO Number" />
                <SortTh col="vendor"   label="Vendor" />
                <SortTh col="poDate"   label="PO Date" />
                <SortTh col="eta"      label="ETA" />
                <SortTh col="etd"      label="ETD" />
                <SortTh col="lines"    label="Lines"     className="text-center" />
                <SortTh col="qty"      label="Total Qty" className="text-right" />
                <SortTh col="booking"  label="Booking #" />
                <SortTh col="status"   label="Status" />
                <th style={{ width: 28 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(po => {
                const status  = getStatus(po)
                const etaDate = po.eta ? new Date(po.eta) : null
                const pastDue = etaDate && etaDate < today && !po.isReceived
                return (
                  <tr
                    key={po.poId}
                    className="cursor-pointer hover:bg-white/5 transition-colors"
                    onClick={() => openImpact(po)}
                  >
                    <td className="font-mono font-semibold text-accent">
                      {po.poNumber || `PO-${po.poId}`}
                    </td>
                    <td>{po.vendorName}</td>
                    <td className="font-mono-num text-text-secondary">
                      {po.poDate ? fmtDate(po.poDate) : '—'}
                    </td>
                    <td className={`font-mono-num font-semibold ${pastDue ? 'text-danger' : etaDate ? 'text-text-primary' : 'text-text-secondary'}`}>
                      {po.eta ? fmtDate(po.eta) : '—'}
                      {pastDue && <span className="ml-1 text-danger">⚠</span>}
                    </td>
                    <td className="font-mono-num text-text-secondary">
                      {po.etd ? fmtDate(po.etd) : '—'}
                    </td>
                    <td className="text-center font-mono-num">{po.lineCount}</td>
                    <td className="text-right font-mono-num">
                      {Math.round(po.totalQty).toLocaleString()}
                    </td>
                    <td className="font-mono text-text-secondary">
                      {po.bookingNumber || '—'}
                    </td>
                    <td><POStatusBadge status={status} /></td>
                    <td>
                      <ChevronRight size={12} className="text-text-secondary mx-auto" />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Impact modal ── */}
      {selectedPO && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(15,23,42,0.65)', backdropFilter: 'blur(4px)' }}
          onClick={() => setSelectedPO(null)}
        >
          <div
            className="relative w-full max-w-5xl max-h-[90vh] flex flex-col rounded-2xl shadow-2xl overflow-hidden bg-surface border border-border"
            onClick={e => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-start justify-between px-6 py-4 border-b border-border bg-bg/50 shrink-0">
              <div>
                <div className="flex items-center gap-3 flex-wrap">
                  <h2 className="font-mono font-bold text-text-primary">
                    PO {selectedPO.poNumber || selectedPO.poId}
                  </h2>
                  <POStatusBadge status={getStatus(selectedPO)} />
                  <span className="text-xs font-mono text-text-muted">Impact Analysis</span>
                </div>
                <p className="text-xs text-text-secondary mt-1 font-mono">
                  {selectedPO.vendorName}
                  {selectedPO.eta && ` · ETA ${fmtDate(selectedPO.eta)}`}
                  {selectedPO.bookingNumber && ` · Booking ${selectedPO.bookingNumber}`}
                  {selectedPO.containerSize && ` · ${selectedPO.containerSize}`}
                  {` · ${selectedPO.lineCount} line${selectedPO.lineCount !== 1 ? 's' : ''}`}
                </p>
              </div>
              <button
                onClick={() => setSelectedPO(null)}
                className="shrink-0 rounded-lg p-1.5 text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors ml-4"
              >
                <X size={16} />
              </button>
            </div>

            {/* Modal body */}
            <div className="overflow-auto flex-1 p-6">
              {impactLoading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3 text-text-secondary">
                  <Loader2 size={24} className="animate-spin" />
                  <span className="text-sm font-mono">Running impact analysis…</span>
                </div>
              ) : impactError ? (
                <div className="bg-danger/10 border border-danger/30 rounded px-4 py-3 text-xs text-danger font-mono flex items-center gap-2">
                  <AlertTriangle size={12} /> {impactError}
                </div>
              ) : impactData ? (
                <ImpactContent data={impactData} />
              ) : null}
            </div>

            {/* Modal footer */}
            <div className="shrink-0 px-6 py-3 border-t border-border bg-bg/50 text-xs text-text-secondary font-mono">
              Analysis horizon: ETA + 2 weeks · Click outside to close
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
