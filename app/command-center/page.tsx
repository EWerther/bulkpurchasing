'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  RefreshCw, ChevronDown, ChevronUp, AlertCircle, AlertTriangle,
  Clock, TrendingUp, CheckCircle2, XCircle,
  Zap, Filter, Search, ArrowRight, Bot, ExternalLink,
} from 'lucide-react'
import Link from 'next/link'
import type { Recommendation, Urgency, ActionType } from '@/app/api/command-center/data/route'

// ─── Types ────────────────────────────────────────────────────────────────────

interface HealthMetrics {
  criticalCount: number
  urgentCount: number
  highCount: number
  mediumCount: number
  watchCount: number
  totalItems: number
  avgFTXDOC: number
  avgSBYLDOC: number
  actionsNeeded: number
}

interface CommandCenterData {
  generatedAt: string
  recommendations: Recommendation[]
  healthMetrics: HealthMetrics
}

// ─── Constants ────────────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 5 * 60 * 1000 // 5 minutes

const URGENCY_CONFIG = {
  critical: { color: '#dc2626', bg: 'rgba(220,38,38,0.07)', border: 'rgba(220,38,38,0.2)', label: 'Critical', icon: XCircle },
  urgent:   { color: '#ea580c', bg: 'rgba(234,88,12,0.07)',  border: 'rgba(234,88,12,0.2)',  label: 'Urgent',   icon: AlertCircle },
  high:     { color: '#d97706', bg: 'rgba(217,119,6,0.07)',  border: 'rgba(217,119,6,0.2)',  label: 'High',     icon: AlertTriangle },
  medium:   { color: '#2563eb', bg: 'rgba(37,99,235,0.06)',  border: 'rgba(37,99,235,0.15)', label: 'Medium',   icon: Clock },
  watch:    { color: '#64748b', bg: 'rgba(100,116,139,0.05)', border: 'rgba(100,116,139,0.15)', label: 'Watch', icon: TrendingUp },
} satisfies Record<Urgency, { color: string; bg: string; border: string; label: string; icon: any }>

const ACTION_CONFIG: Record<ActionType, { label: string; color: string; bg: string }> = {
  create:          { label: 'Create PO',       color: '#16a34a', bg: 'rgba(22,163,74,0.1)' },
  update_eta:      { label: 'Update ETA',      color: '#d97706', bg: 'rgba(217,119,6,0.1)' },
  update_qty:      { label: 'Update Qty',      color: '#2563eb', bg: 'rgba(37,99,235,0.1)' },
  update_both:     { label: 'Update PO',       color: '#ea580c', bg: 'rgba(234,88,12,0.1)' },
  consider_cancel: { label: 'Consider Cancel', color: '#dc2626', bg: 'rgba(220,38,38,0.1)' },
  on_track:        { label: 'On Track',        color: '#64748b', bg: 'rgba(100,116,139,0.1)' },
  new_product:     { label: 'New Product',     color: '#7c3aed', bg: 'rgba(124,58,237,0.1)' },
}

const FEASIBILITY_CONFIG = {
  Full:     { color: '#16a34a', label: 'Supply OK' },
  Partial:  { color: '#d97706', label: 'Partial' },
  None:     { color: '#dc2626', label: 'Infeasible' },
  NoRecipe: { color: '#94a3b8', label: 'No Recipe' },
  Unknown:  { color: '#94a3b8', label: '—' },
}

// ─── Sparkline ────────────────────────────────────────────────────────────────

function Sparkline({ data, minDOC, w = 90, h = 32 }: { data: Array<{ doc: number }>; minDOC?: number; w?: number; h?: number }) {
  if (!data.length) return null
  const maxDoc = Math.max(...data.map(d => d.doc), (minDOC ?? 0) * 1.5, 1)
  const pts = data.map((d, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - (Math.min(d.doc, maxDoc) / maxDoc) * h
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const minY = minDOC ? h - (minDOC / maxDoc) * h : null

  return (
    <svg width={w} height={h} style={{ overflow: 'visible', display: 'block' }}>
      {minY !== null && (
        <line x1={0} y1={minY} x2={w} y2={minY} stroke="#dc2626" strokeWidth={0.75} strokeDasharray="3,2" opacity={0.6} />
      )}
      <polyline points={pts.join(' ')} fill="none" stroke="#4f46e5" strokeWidth={1.5} strokeLinejoin="round" />
      {/* Last point dot */}
      {pts.length > 0 && (() => {
        const last = pts[pts.length - 1].split(',')
        return <circle cx={last[0]} cy={last[1]} r={2} fill="#4f46e5" />
      })()}
    </svg>
  )
}

// ─── Ingredient Row ───────────────────────────────────────────────────────────

function IngredientTable({ ingredients }: { ingredients: any[] }) {
  const shortages = ingredients.filter(d => d.shortage > 0)
  if (!shortages.length) return null

  return (
    <div className="mt-3">
      <div className="text-[10px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#94a3b8' }}>
        Supply Shortages
      </div>
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            <th className="text-left py-1.5 px-2 font-medium border-b" style={{ color: '#64748b', borderColor: '#e2e8f0' }}>Component</th>
            <th className="text-right py-1.5 px-2 font-medium border-b" style={{ color: '#64748b', borderColor: '#e2e8f0' }}>Need</th>
            <th className="text-right py-1.5 px-2 font-medium border-b" style={{ color: '#64748b', borderColor: '#e2e8f0' }}>Available</th>
            <th className="text-right py-1.5 px-2 font-medium border-b" style={{ color: '#64748b', borderColor: '#e2e8f0' }}>Shortage</th>
          </tr>
        </thead>
        <tbody>
          {shortages.map((d, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
              <td className="py-1.5 px-2 font-mono-num" style={{ color: '#0f172a' }}>{d.supplySKU}</td>
              <td className="py-1.5 px-2 text-right font-mono-num" style={{ color: '#475569' }}>{d.qtyNeeded.toLocaleString()}</td>
              <td className="py-1.5 px-2 text-right font-mono-num" style={{ color: '#475569' }}>{d.qtyAvailable.toLocaleString()}</td>
              <td className="py-1.5 px-2 text-right font-mono-num font-semibold" style={{ color: '#dc2626' }}>
                −{d.shortage.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Recommendation Card ──────────────────────────────────────────────────────

function RecCard({ rec, minDOC }: { rec: Recommendation; minDOC: number }) {
  const [expanded, setExpanded] = useState(false)
  const urg = URGENCY_CONFIG[rec.urgency]
  const act = ACTION_CONFIG[rec.actionType]
  const feas = FEASIBILITY_CONFIG[rec.feasibilityStatus]
  const docStr = rec.ads > 0 ? rec.currentDOC.toFixed(1) : '—'
  const recETA = rec.recommendedETA ? new Date(rec.recommendedETA).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
  const existingETA = rec.existingPO ? new Date(rec.existingPO.eta).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null

  return (
    <div
      className="relative rounded-xl overflow-hidden transition-shadow duration-150"
      style={{
        background: rec.urgency === 'critical' ? 'rgba(254,242,242,0.5)' : rec.urgency === 'urgent' ? 'rgba(255,247,237,0.5)' : '#ffffff',
        border: `1px solid ${urg.border}`,
        boxShadow: '0 1px 3px rgba(15,23,42,0.06)',
      }}
    >
      {/* Urgency strip */}
      <div
        className="absolute left-0 top-0 bottom-0 rounded-l-xl"
        style={{ width: 3, background: urg.color }}
      />

      {/* Card header — always visible */}
      <button
        className="w-full text-left"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-3 px-4 py-3 pl-5">
          {/* Left: company + SKU + name */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="text-[10px] font-bold px-1.5 py-0.5 rounded-md"
                style={{
                  background: rec.company === 'FTX' ? 'rgba(79,70,229,0.1)' : 'rgba(124,58,237,0.1)',
                  color: rec.company === 'FTX' ? '#4f46e5' : '#7c3aed',
                }}
              >
                {rec.company}
              </span>
              <span className="font-mono-num text-sm font-semibold" style={{ color: '#0f172a' }}>
                {rec.sku}
              </span>
              {rec.productName !== rec.sku && (
                <span className="text-xs truncate" style={{ color: '#64748b' }}>
                  {rec.productName}
                </span>
              )}
            </div>

            {/* Metrics row */}
            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
              <span className="text-xs" style={{ color: '#94a3b8' }}>
                Stock: <span className="font-mono-num font-semibold" style={{ color: '#0f172a' }}>
                  {rec.currentInventory.toLocaleString()}
                </span>
              </span>
              {rec.ads > 0 && (
                <>
                  <span className="text-[10px]" style={{ color: '#c9d2e0' }}>·</span>
                  <span className="text-xs" style={{ color: '#94a3b8' }}>
                    ADS: <span className="font-mono-num font-semibold" style={{ color: '#475569' }}>
                      {rec.ads.toFixed(1)}
                    </span>
                  </span>
                  <span className="text-[10px]" style={{ color: '#c9d2e0' }}>·</span>
                  <span className="text-xs" style={{ color: '#94a3b8' }}>
                    DOC: <span className="font-mono-num font-bold" style={{ color: urg.color }}>
                      {docStr}d
                    </span>
                  </span>
                </>
              )}
              {rec.actionType !== 'on_track' && rec.recommendedETA && (
                <>
                  <span className="text-[10px]" style={{ color: '#c9d2e0' }}>·</span>
                  <span className="text-xs" style={{ color: '#94a3b8' }}>
                    Rec ETA: <span className="font-mono-num font-medium" style={{ color: '#0f172a' }}>{recETA}</span>
                  </span>
                  {rec.recommendedQty > 0 && (
                    <span className="text-xs font-mono-num" style={{ color: '#475569' }}>
                      × {rec.recommendedQty.toLocaleString()} units
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Right: sparkline + badges + chevron */}
          <div className="flex items-center gap-3 shrink-0">
            {/* DOC sparkline */}
            <div style={{ opacity: 0.85 }}>
              <Sparkline data={rec.docProjection} minDOC={minDOC} />
            </div>

            {/* Feasibility */}
            {rec.feasibilityStatus !== 'Unknown' && (
              <span
                className="text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap hidden sm:block"
                style={{ color: feas.color, background: `${feas.color}15` }}
              >
                {feas.label}
              </span>
            )}

            {/* Action badge */}
            <span
              className="text-[10px] font-bold px-2.5 py-1 rounded-lg whitespace-nowrap"
              style={{ color: act.color, background: act.bg }}
            >
              {act.label}
            </span>

            {expanded ? <ChevronUp size={14} style={{ color: '#94a3b8' }} /> : <ChevronDown size={14} style={{ color: '#94a3b8' }} />}
          </div>
        </div>
      </button>

      {/* Expanded drill-down */}
      {expanded && (
        <div
          className="px-5 pb-4 border-t"
          style={{ borderColor: urg.border, background: rec.urgency === 'critical' ? 'rgba(254,242,242,0.3)' : 'rgba(248,250,252,0.8)' }}
        >
          {/* Reasoning */}
          <div className="pt-3">
            <div className="text-[10px] font-semibold uppercase tracking-widest mb-1" style={{ color: '#94a3b8' }}>
              Analysis
            </div>
            <p className="text-xs leading-relaxed" style={{ color: '#475569' }}>
              {rec.reasoning}
            </p>
          </div>

          {/* Existing PO */}
          {rec.existingPO && (
            <div className="mt-3 p-2.5 rounded-lg border" style={{ borderColor: '#e2e8f0', background: '#ffffff' }}>
              <div className="text-[10px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#94a3b8' }}>
                Existing PO
              </div>
              <div className="flex items-center gap-4 flex-wrap text-xs">
                <span style={{ color: '#475569' }}>
                  PO# <span className="font-mono-num font-semibold" style={{ color: '#0f172a' }}>{rec.existingPO.poNumber}</span>
                </span>
                <span style={{ color: '#475569' }}>
                  Qty: <span className="font-mono-num font-semibold" style={{ color: '#0f172a' }}>{rec.existingPO.qty.toLocaleString()}</span>
                </span>
                <span style={{ color: '#475569' }}>
                  ETA: <span className="font-mono-num font-semibold" style={{ color: '#0f172a' }}>{existingETA}</span>
                </span>
                {rec.actionType !== 'on_track' && rec.recommendedETA && (
                  <>
                    <ArrowRight size={12} style={{ color: '#c9d2e0' }} />
                    <span style={{ color: act.color }} className="font-semibold">
                      Recommended: {rec.recommendedQty.toLocaleString()} units by {recETA}
                    </span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* If no existing PO but action is create */}
          {!rec.existingPO && rec.actionType === 'create' && rec.recommendedETA && (
            <div className="mt-3 p-2.5 rounded-lg border" style={{ borderColor: 'rgba(22,163,74,0.3)', background: 'rgba(22,163,74,0.05)' }}>
              <div className="text-[10px] font-semibold uppercase tracking-widest mb-1" style={{ color: '#16a34a' }}>
                Recommended New PO
              </div>
              <div className="flex items-center gap-4 text-xs font-semibold" style={{ color: '#16a34a' }}>
                <span>{rec.recommendedQty.toLocaleString()} units</span>
                <span>ETA: {recETA}</span>
              </div>
            </div>
          )}

          {/* Ingredient shortages */}
          {rec.ingredientDetails && rec.ingredientDetails.length > 0 && (
            <IngredientTable ingredients={rec.ingredientDetails} />
          )}

          {/* Ask Claude about this item */}
          <div className="mt-4 pt-3 border-t flex items-center gap-3" style={{ borderColor: urg.border }}>
            <Bot size={12} style={{ color: '#7c3aed', flexShrink: 0 }} />
            <span className="text-[11px]" style={{ color: '#94a3b8' }}>Want deeper analysis?</span>
            <Link
              href={`/ask-claude?q=${encodeURIComponent(`Tell me about ${rec.company} ${rec.sku}: ${rec.reasoning.split('.')[0]}.`)}`}
              className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1 rounded-lg transition-all"
              style={{ color: '#7c3aed', background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.2)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(124,58,237,0.15)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(124,58,237,0.08)' }}
            >
              <Bot size={11} />
              Ask Claude
              <ExternalLink size={10} />
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Urgency Section ──────────────────────────────────────────────────────────

function UrgencySection({ urgency, items, minDOC }: { urgency: Urgency; items: Recommendation[]; minDOC: number }) {
  const [collapsed, setCollapsed] = useState(urgency === 'watch')
  const urg = URGENCY_CONFIG[urgency]
  const Icon = urg.icon

  if (!items.length) return null

  return (
    <div>
      <button
        className="w-full flex items-center gap-3 px-1 py-2 mb-2 rounded-lg transition-colors"
        onClick={() => setCollapsed(c => !c)}
        style={{ color: urg.color }}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = urg.bg}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
      >
        <Icon size={14} strokeWidth={2} />
        <span className="text-xs font-bold uppercase tracking-widest">{urg.label}</span>
        <span
          className="text-[10px] font-bold px-2 py-0.5 rounded-full ml-1"
          style={{ background: urg.bg, color: urg.color, border: `1px solid ${urg.border}` }}
        >
          {items.length}
        </span>
        <div className="flex-1" />
        {collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
      </button>

      {!collapsed && (
        <div className="space-y-2 mb-6">
          {items.map(rec => (
            <RecCard key={rec.id} rec={rec} minDOC={minDOC} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Health Metric Card ───────────────────────────────────────────────────────

function MetricCard({
  label, value, color, sub,
}: { label: string; value: string | number; color?: string; sub?: string }) {
  return (
    <div
      className="rounded-xl px-4 py-3 flex flex-col gap-0.5 border"
      style={{ background: '#ffffff', borderColor: '#e8edf5' }}
    >
      <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: '#94a3b8' }}>{label}</span>
      <span className="font-mono-num text-xl font-bold" style={{ color: color ?? '#0f172a' }}>{value}</span>
      {sub && <span className="text-[10px]" style={{ color: '#94a3b8' }}>{sub}</span>}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const MIN_DOC = 15 // default; ideally from env

export default function CommandCenterPage() {
  const [data, setData] = useState<CommandCenterData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [refreshCountdown, setRefreshCountdown] = useState(REFRESH_INTERVAL / 1000)

  const [filterCompany, setFilterCompany] = useState<'all' | 'FTX' | 'SBYL'>('all')
  const [filterUrgency, setFilterUrgency] = useState<'all' | Urgency>('all')
  const [filterAction, setFilterAction] = useState<'all' | 'needs_action' | 'on_track'>('all')
  const [searchText, setSearchText] = useState('')

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/command-center/data')
      if (!res.ok) {
        const e = await res.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(e.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      setData(json)
      setLastRefreshed(new Date())
      setRefreshCountdown(REFRESH_INTERVAL / 1000)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load
  useEffect(() => { fetchData() }, [fetchData])

  // Auto-refresh timer
  useEffect(() => {
    const interval = setInterval(() => {
      setRefreshCountdown(c => {
        if (c <= 1) {
          fetchData()
          return REFRESH_INTERVAL / 1000
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [fetchData])

  // Filter recommendations
  const filtered = useMemo(() => {
    if (!data) return []
    let recs = data.recommendations
    if (filterCompany !== 'all') recs = recs.filter(r => r.company === filterCompany)
    if (filterUrgency !== 'all') recs = recs.filter(r => r.urgency === filterUrgency)
    if (filterAction === 'needs_action') recs = recs.filter(r => r.actionType !== 'on_track' && r.actionType !== 'new_product')
    else if (filterAction === 'on_track') recs = recs.filter(r => r.actionType === 'on_track')
    if (searchText.trim()) {
      const q = searchText.toLowerCase()
      recs = recs.filter(r => r.sku.toLowerCase().includes(q) || r.productName.toLowerCase().includes(q))
    }
    return recs
  }, [data, filterCompany, filterUrgency, filterAction, searchText])

  const grouped = useMemo(() => {
    const tiers: Urgency[] = ['critical', 'urgent', 'high', 'medium', 'watch']
    return tiers.map(u => ({ urgency: u, items: filtered.filter(r => r.urgency === u) }))
  }, [filtered])

  const m = data?.healthMetrics

  // Format last refresh time
  const lastRefreshedStr = lastRefreshed
    ? `${lastRefreshed.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    : '—'

  const progressPct = ((REFRESH_INTERVAL / 1000 - refreshCountdown) / (REFRESH_INTERVAL / 1000)) * 100

  return (
    <div className="flex flex-col h-full">
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <div
        className="shrink-0 flex items-center justify-between px-5 py-3 border-b"
        style={{ background: '#ffffff', borderColor: '#dde3ed' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center rounded-lg"
            style={{ width: 30, height: 30, background: 'linear-gradient(135deg, #4f46e5, #7c3aed)', boxShadow: '0 0 12px rgba(79,70,229,0.3)' }}
          >
            <Zap size={14} className="text-white" strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="text-sm font-bold" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>
              Command Center
            </h1>
            <p className="text-[11px]" style={{ color: '#94a3b8' }}>
              Auto-updating · Last refreshed {lastRefreshedStr}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Countdown bar */}
          <div className="flex items-center gap-2 hidden sm:flex">
            <span className="text-[10px]" style={{ color: '#94a3b8' }}>
              Next refresh {refreshCountdown}s
            </span>
            <div style={{ width: 60, height: 3, background: '#e8edf5', borderRadius: 2 }}>
              <div style={{ width: `${progressPct}%`, height: '100%', background: '#4f46e5', borderRadius: 2, transition: 'width 1s linear' }} />
            </div>
          </div>

          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg border transition-all"
            style={{ color: '#475569', borderColor: '#dde3ed', background: '#f8fafc' }}
            onMouseEnter={e => { if (!loading) (e.currentTarget as HTMLElement).style.borderColor = '#4f46e5' }}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = '#dde3ed'}
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── Health metrics ───────────────────────────────────────────── */}
      {m && (
        <div className="shrink-0 px-5 py-3 border-b flex flex-wrap gap-2.5" style={{ background: '#f8fafc', borderColor: '#dde3ed' }}>
          <MetricCard label="Critical" value={m.criticalCount} color={m.criticalCount > 0 ? '#dc2626' : '#64748b'} sub="below safety stock" />
          <MetricCard label="Urgent" value={m.urgentCount} color={m.urgentCount > 0 ? '#ea580c' : '#64748b'} sub="≤7d buffer" />
          <MetricCard label="High" value={m.highCount} color={m.highCount > 0 ? '#d97706' : '#64748b'} sub="≤14d buffer" />
          <MetricCard label="Medium" value={m.mediumCount} color="#2563eb" sub="≤30d buffer" />
          <MetricCard label="Watch" value={m.watchCount} color="#64748b" sub=">30d buffer" />
          <div className="h-full border-l mx-1" style={{ borderColor: '#dde3ed' }} />
          <MetricCard label="Actions Needed" value={m.actionsNeeded} color={m.actionsNeeded > 0 ? '#dc2626' : '#16a34a'} sub="POs to create/update" />
          <MetricCard label="FTX Avg DOC" value={`${m.avgFTXDOC.toFixed(1)}d`} sub="days of cover" />
          <MetricCard label="SBYL Avg DOC" value={`${m.avgSBYLDOC.toFixed(1)}d`} sub="days of cover" />
        </div>
      )}

      {/* ── Filter bar ───────────────────────────────────────────────── */}
      <div
        className="shrink-0 flex flex-wrap items-center gap-3 px-5 py-2.5 border-b"
        style={{ background: '#ffffff', borderColor: '#dde3ed' }}
      >
        <Filter size={12} style={{ color: '#94a3b8' }} />

        {/* Company filter */}
        <div className="flex rounded-lg border overflow-hidden text-xs font-semibold" style={{ borderColor: '#dde3ed' }}>
          {(['all', 'FTX', 'SBYL'] as const).map(c => (
            <button
              key={c}
              onClick={() => setFilterCompany(c)}
              className="px-3 py-1.5 transition-all"
              style={filterCompany === c ? { background: '#4f46e5', color: '#fff' } : { color: '#64748b', background: '#f8fafc' }}
            >
              {c === 'all' ? 'All' : c}
            </button>
          ))}
        </div>

        {/* Urgency filter */}
        <div className="flex rounded-lg border overflow-hidden text-xs font-semibold" style={{ borderColor: '#dde3ed' }}>
          {(['all', 'critical', 'urgent', 'high', 'medium', 'watch'] as const).map(u => (
            <button
              key={u}
              onClick={() => setFilterUrgency(u)}
              className="px-3 py-1.5 transition-all"
              style={filterUrgency === u ? { background: u === 'all' ? '#4f46e5' : URGENCY_CONFIG[u as Urgency]?.color ?? '#4f46e5', color: '#fff' } : { color: '#64748b', background: '#f8fafc' }}
            >
              {u === 'all' ? 'All' : URGENCY_CONFIG[u as Urgency].label}
            </button>
          ))}
        </div>

        {/* Action filter */}
        <div className="flex rounded-lg border overflow-hidden text-xs font-semibold" style={{ borderColor: '#dde3ed' }}>
          {([['all', 'All'], ['needs_action', 'Needs Action'], ['on_track', 'On Track']] as const).map(([v, l]) => (
            <button
              key={v}
              onClick={() => setFilterAction(v)}
              className="px-3 py-1.5 transition-all"
              style={filterAction === v ? { background: '#4f46e5', color: '#fff' } : { color: '#64748b', background: '#f8fafc' }}
            >
              {l}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 flex-1 min-w-[160px] max-w-xs">
          <Search size={12} style={{ color: '#94a3b8', flexShrink: 0 }} />
          <input
            type="text"
            placeholder="Search SKU or name…"
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            className="filter-input flex-1"
          />
        </div>

        <span className="text-xs ml-auto" style={{ color: '#94a3b8' }}>
          {filtered.length} items
        </span>
      </div>

      {/* ── Main content ─────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto px-5 py-4">
        {error && (
          <div className="rounded-xl p-4 mb-4 flex items-start gap-3" style={{ background: 'rgba(220,38,38,0.07)', border: '1px solid rgba(220,38,38,0.2)' }}>
            <AlertCircle size={16} style={{ color: '#dc2626', flexShrink: 0, marginTop: 1 }} />
            <div>
              <div className="text-sm font-semibold" style={{ color: '#dc2626' }}>Error loading data</div>
              <div className="text-xs mt-0.5" style={{ color: '#475569' }}>{error}</div>
            </div>
          </div>
        )}

        {loading && !data && (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div
              className="animate-spin rounded-full"
              style={{ width: 36, height: 36, border: '3px solid #e8edf5', borderTopColor: '#4f46e5' }}
            />
            <div className="text-sm" style={{ color: '#94a3b8' }}>Analyzing supply chain…</div>
            <div className="text-xs" style={{ color: '#c9d2e0' }}>Fetching inventory, running generator, checking feasibility</div>
          </div>
        )}

        {!loading && !error && filtered.length === 0 && data && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <CheckCircle2 size={40} style={{ color: '#16a34a', opacity: 0.6 }} />
            <div className="text-sm font-medium" style={{ color: '#475569' }}>No items match your filters</div>
            <button className="text-xs" style={{ color: '#4f46e5' }} onClick={() => { setFilterCompany('all'); setFilterUrgency('all'); setFilterAction('all'); setSearchText('') }}>
              Clear all filters
            </button>
          </div>
        )}

        {grouped.map(({ urgency, items }) => (
          <UrgencySection key={urgency} urgency={urgency} items={items} minDOC={MIN_DOC} />
        ))}
      </div>
    </div>
  )
}
