'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { Search, AlertTriangle, Zap, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { SummaryBar } from '@/components/shared/SummaryBar'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { SupplyLink } from '@/components/shared/SupplyLink'
import { fmtDate } from '@/lib/utils/dates'

interface SupplyPO {
  poId: number
  poNumber: string
  eta: string
  qty: number
}

interface Component {
  itemId: number
  sku: string
  name: string
  category: string
  onHandQty: number
  committedQty: number
  availableQty: number
  futurePOs: SupplyPO[]
  allocations: any[]
  projectedTimeline: { date: string; stock: number; arrivals: number; consumed: number }[]
  hasShortageRisk: boolean
  warnings: any[]
}

const CATEGORY_COLORS: Record<string, string> = {
  'Foam': 'text-warning',
  'Cover': 'text-accent',
  'Fire Sock': 'text-success',
  'Box': 'text-text-secondary',
  'Packet': 'text-locked',
}

const ZOOM_OPTIONS = [
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '6M', days: 180 },
  { label: 'All', days: 0 },
]

function InventoryProjectionChart({ timeline }: { timeline: { date: string; stock: number; arrivals: number; consumed: number }[] }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [zoom, setZoom]     = useState(0)   // 0 = all
  const [hovered, setHovered] = useState<{ idx: number; svgX: number; svgY: number } | null>(null)

  if (!timeline.length) return null

  const display = zoom > 0 ? timeline.slice(0, zoom) : timeline

  const W = 800, H = 110
  const PAD = { top: 10, bottom: 20, left: 6, right: 6 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom

  const stocks  = display.map(t => t.stock)
  const minStock = Math.min(...stocks, 0)
  const maxStock = Math.max(...stocks, 1)
  const range   = maxStock - minStock || 1

  const xOf = (i: number) => PAD.left + (i / Math.max(display.length - 1, 1)) * plotW
  const yOf = (v: number) => PAD.top  + (1 - (v - minStock) / range) * plotH
  const y0  = yOf(0)

  const points  = display.map((t, i) => ({ x: xOf(i), y: yOf(t.stock) }))
  const lineD   = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const posAreaD = `M ${points[0].x.toFixed(1)} ${Math.min(y0, points[0].y).toFixed(1)} ` +
    points.map(p => `L ${p.x.toFixed(1)} ${Math.min(y0, p.y).toFixed(1)}`).join(' ') +
    ` L ${points[points.length-1].x.toFixed(1)} ${y0.toFixed(1)} L ${points[0].x.toFixed(1)} ${y0.toFixed(1)} Z`
  const negAreaD = `M ${points[0].x.toFixed(1)} ${Math.max(y0, points[0].y).toFixed(1)} ` +
    points.map(p => `L ${p.x.toFixed(1)} ${Math.max(y0, p.y).toFixed(1)}`).join(' ') +
    ` L ${points[points.length-1].x.toFixed(1)} ${y0.toFixed(1)} L ${points[0].x.toFixed(1)} ${y0.toFixed(1)} Z`

  const endStock = display[display.length - 1]?.stock ?? 0
  const lineColor = endStock < 0 ? '#dc2626' : '#16a34a'

  // Axis date labels (every ~30 days)
  const dateLabels: { x: number; label: string }[] = []
  const step = Math.max(1, Math.floor(display.length / 6))
  for (let i = 0; i < display.length; i += step) {
    dateLabels.push({ x: xOf(i), label: fmtDate(display[i].date) })
  }

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const relX = (e.clientX - rect.left) / rect.width * W
    const idx = Math.round(Math.max(0, Math.min((relX - PAD.left) / plotW * (display.length - 1), display.length - 1)))
    setHovered({ idx, svgX: relX, svgY: (e.clientY - rect.top) / rect.height * H })
  }

  const hovDay = hovered ? display[hovered.idx] : null
  const tooltipLeft = hovered ? `${Math.min(hovered.svgX / W * 100, 72)}%` : '0'
  const tooltipAlign = hovered && hovered.svgX / W > 0.7 ? 'right' : 'left'

  return (
    <div className="space-y-1.5">
      {/* Zoom controls */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] font-mono text-text-secondary mr-1">Zoom:</span>
        {ZOOM_OPTIONS.map(z => (
          <button key={z.label} onClick={() => setZoom(z.days)}
            className={`text-[10px] px-2 py-0.5 rounded border font-mono transition-colors ${
              zoom === z.days ? 'border-accent text-accent bg-accent/8' : 'border-border text-text-secondary hover:text-text-primary'
            }`}>
            {z.label}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div className="relative select-none">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full rounded bg-bg/50 border border-border/40"
          preserveAspectRatio="none"
          style={{ height: 110 }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHovered(null)}>

          {/* Zero line */}
          <line x1={PAD.left} y1={y0} x2={W - PAD.right} y2={y0}
            stroke="#94a3b8" strokeWidth="0.8" strokeDasharray="4,3" />
          {minStock < 0 && <text x={PAD.left + 2} y={y0 - 2} fontSize="7" fontFamily="monospace" fill="#94a3b8">0</text>}

          {/* Areas */}
          <path d={posAreaD} fill="rgba(22,163,74,0.10)" />
          <path d={negAreaD} fill="rgba(220,38,38,0.10)" />

          {/* PO arrival ticks */}
          {display.map((t, i) => t.arrivals > 0 ? (
            <line key={`po-${i}`} x1={xOf(i)} y1={PAD.top} x2={xOf(i)} y2={H - PAD.bottom}
              stroke="rgba(22,163,74,0.4)" strokeWidth="1.5" />
          ) : null)}

          {/* Consumption ticks */}
          {display.map((t, i) => (t.consumed ?? 0) > 0 ? (
            <line key={`con-${i}`} x1={xOf(i)} y1={PAD.top} x2={xOf(i)} y2={H - PAD.bottom}
              stroke="rgba(234,88,12,0.25)" strokeWidth="1" />
          ) : null)}

          {/* Stock line */}
          <path d={lineD} fill="none" stroke={lineColor} strokeWidth="1.8" strokeLinejoin="round" />

          {/* Start / end labels */}
          <text x={xOf(0)} y={yOf(display[0].stock) - 4} textAnchor="start"
            fontSize="9" fontFamily="monospace" fill={display[0].stock < 0 ? '#dc2626' : '#16a34a'} fontWeight="600">
            {display[0].stock.toLocaleString()}
          </text>
          <text x={xOf(display.length-1)} y={yOf(endStock) - 4} textAnchor="end"
            fontSize="9" fontFamily="monospace" fill={endStock < 0 ? '#dc2626' : '#16a34a'} fontWeight="600">
            {endStock.toLocaleString()}
          </text>

          {/* Hover crosshair */}
          {hovered && (
            <>
              <line x1={xOf(hovered.idx)} y1={PAD.top} x2={xOf(hovered.idx)} y2={H - PAD.bottom}
                stroke="#64748b" strokeWidth="1" strokeDasharray="3,2" />
              <circle cx={xOf(hovered.idx)} cy={yOf(display[hovered.idx].stock)} r="3.5"
                fill="white" stroke={lineColor} strokeWidth="1.5" />
            </>
          )}

          {/* Date axis */}
          {dateLabels.map((dl, i) => (
            <text key={i} x={dl.x} y={H - 4} textAnchor="middle"
              fontSize="7.5" fontFamily="monospace" fill="#94a3b8">
              {dl.label}
            </text>
          ))}
        </svg>

        {/* Hover tooltip */}
        {hovered && hovDay && (
          <div className="absolute top-8 pointer-events-none z-20"
            style={{ [tooltipAlign]: tooltipLeft, maxWidth: 200 }}>
            <div className="bg-surface border border-border rounded-lg shadow-lg px-3 py-2 text-xs font-mono space-y-1">
              <div className="font-semibold text-text-primary">{fmtDate(hovDay.date)}</div>
              <div className={hovDay.stock < 0 ? 'text-danger font-bold' : hovDay.stock < 100 ? 'text-warning' : 'text-success'}>
                Stock: {hovDay.stock.toLocaleString()} units
              </div>
              {hovDay.arrivals > 0 && (
                <div className="text-success">↑ +{hovDay.arrivals.toLocaleString()} arriving</div>
              )}
              {(hovDay.consumed ?? 0) > 0 && (
                <div className="text-orange-400">↓ -{hovDay.consumed.toLocaleString()} consumed</div>
              )}
              {hovDay.stock < 0 && (
                <div className="text-danger font-semibold">⚠ Shortage: {Math.abs(hovDay.stock).toLocaleString()} short</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ComponentCard({ component, defaultOpen }: { component: Component; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false)

  return (
    <div className={`card ${component.hasShortageRisk ? 'border border-danger/40' : ''}`}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-start justify-between px-4 py-3 hover:bg-white/5 transition-colors text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-mono font-bold text-sm text-text-primary">{component.sku}</span>
            <span className={`text-xs font-mono chip border border-border ${CATEGORY_COLORS[component.category] ?? 'text-text-secondary'}`}>
              {component.category}
            </span>
            {component.hasShortageRisk && (
              <span className="chip text-xs text-danger border border-danger/30 bg-danger/10">
                <AlertTriangle size={10} /> Shortage Risk
              </span>
            )}
            {component.warnings.length > 0 && (
              <span className="chip text-xs text-warning border border-warning/30 bg-warning/10">
                <Zap size={10} /> {component.warnings.length} Warning{component.warnings.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="text-xs text-text-secondary mt-0.5">{component.name}</div>
          <div className="flex items-center gap-4 mt-2 text-xs font-mono">
            <span>On-Hand: <span className="text-text-primary font-semibold">{component.onHandQty.toLocaleString()}</span></span>
            <span>Available: <span className={`font-semibold ${component.availableQty < 0 ? 'text-danger' : 'text-success'}`}>{component.availableQty.toLocaleString()}</span></span>
            {component.futurePOs.length > 0 && (
              <span className="text-text-secondary">{component.futurePOs.length} incoming PO{component.futurePOs.length > 1 ? 's' : ''}</span>
            )}
          </div>
        </div>
        <div className="ml-4 shrink-0">
          {open ? <ChevronDown size={14} className="text-text-secondary" /> : <ChevronRight size={14} className="text-text-secondary" />}
        </div>
      </button>

      {open && (
        <div className="border-t border-border px-4 pb-4 space-y-4">
          {/* Incoming POs + Consumption side by side */}
          {(component.futurePOs.length > 0 || (component as any).consumptionEvents?.length > 0) && (
            <div className="grid grid-cols-1 gap-3 mt-3" style={{ gridTemplateColumns: component.futurePOs.length > 0 && (component as any).consumptionEvents?.length > 0 ? '1fr 1fr' : '1fr' }}>

              {/* Incoming supply POs */}
              {component.futurePOs.length > 0 && (
                <div>
                  <div className="section-header">Incoming Supply POs</div>
                  <div className="flex flex-wrap gap-1.5">
                    {component.futurePOs.map((po: any) => (
                      <div key={po.poId}
                        className={`chip border text-xs font-mono flex items-center gap-1.5 ${
                          po.isOverdue ? 'border-warning/50 bg-warning/5 text-warning' : 'border-success/40 bg-success/5 text-success'
                        }`}
                        title={po.isOverdue ? `Original ETA: ${fmtDate(po.originalEta)} — past due` : undefined}
                      >
                        {po.isOverdue ? '⚠' : '↑'} {po.poNumber} · {po.isOverdue ? <span><span className="line-through opacity-60">{fmtDate(po.originalEta)}</span> Today</span> : fmtDate(po.eta)} · +{po.qty.toLocaleString()}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Consumption by production orders */}
              {(component as any).consumptionEvents?.length > 0 && (
                <div>
                  <div className="section-header">Consumed by Production Orders</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(component as any).consumptionEvents.map((ev: any, i: number) => (
                      <div key={i}
                        className="chip border border-danger/40 bg-danger/5 text-danger text-xs font-mono flex items-center gap-1"
                        title={`${ev.productName} — consumes ${ev.qty} supply units`}
                      >
                        ↓ {fmtDate(ev.date)} · {ev.orderNumber} · {ev.productSku} · {ev.orderedQty} units · {Math.round(ev.qty)} supply
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Legacy incoming POs section — hidden now (replaced above) */}
          {false && component.futurePOs.length > 0 && (
            <div>
              <div className="section-header mt-3">Incoming POs (old)</div>
              <div className="flex flex-wrap gap-2">
                {component.futurePOs.map((po: any) => (
                  <div key={po.poId}
                    className={`chip border text-xs font-mono flex items-center gap-1.5 ${
                      po.isOverdue
                        ? 'border-warning/50 bg-warning/5 text-warning'
                        : 'border-border text-text-secondary'
                    }`}
                    title={po.isOverdue
                      ? `Original ETA: ${fmtDate(po.originalEta)} — past due, treated as arriving today`
                      : undefined}
                  >
                    {po.isOverdue && <span title="Past ETA — treating as today">⚠</span>}
                    {po.poNumber}
                    {' · '}
                    {po.isOverdue
                      ? <span><span className="line-through opacity-60">{fmtDate(po.originalEta)}</span> → Today</span>
                      : fmtDate(po.eta)
                    }
                    {' · +' + po.qty.toLocaleString()}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Timeline */}
          {component.projectedTimeline.length > 0 && (
            <div>
              <div className="section-header">Inventory Projection</div>
              <InventoryProjectionChart timeline={component.projectedTimeline} />
              <div className="flex justify-between text-xs font-mono text-text-secondary mt-1">
                <span>Today</span>
                <span>→</span>
                <span>{component.projectedTimeline.length > 0 ? fmtDate(component.projectedTimeline[component.projectedTimeline.length - 1].date) : ''}</span>
              </div>
            </div>
          )}

          {/* Allocations */}
          {component.allocations && component.allocations.length > 0 && (
            <div>
              <div className="section-header mt-3">Demand Allocations</div>
              <div className="overflow-auto rounded border border-border">
                <table className="data-table text-xs w-full">
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th>SKU</th>
                      <th>Reference</th>
                      <th className="text-right">Qty Allocated</th>
                      <th>Due Date</th>
                      <th>Status</th>
                      <th style={{ width: 36 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...component.allocations]
                      .sort((a: any, b: any) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())
                      .map((alloc: any, i: number) => {
                        const poScheduleUrl = `/po-schedule?sku=${encodeURIComponent(alloc.sku)}&company=${encodeURIComponent(alloc.company)}`
                        return (
                        <tr key={i}>
                          <td>
                            <span className="font-semibold text-xs" style={{ color: alloc.company === 'FTX' ? '#4f46e5' : '#7c3aed' }}>
                              {alloc.company}
                            </span>
                          </td>
                          <td className="font-mono-num font-semibold">{alloc.sku}</td>
                          <td className="text-text-secondary">{alloc.reference || '—'}</td>
                          <td className="text-right font-mono-num">{alloc.qtyAllocated.toLocaleString()}</td>
                          <td className="font-mono-num">{fmtDate(alloc.dueDate)}</td>
                          <td>
                            <span className={`chip text-xs ${
                              alloc.feasibilityStatus === 'Full' ? 'text-success bg-success/10 border-success/20' :
                              alloc.feasibilityStatus === 'Partial' ? 'text-warning bg-warning/10 border-warning/20' :
                              'text-danger bg-danger/10 border-danger/20'
                            } border`}>
                              {alloc.feasibilityStatus}
                            </span>
                          </td>
                          <td>
                            <a
                              href={poScheduleUrl}
                              title={`Open PO Schedule for ${alloc.sku} (${alloc.company})`}
                              className="flex items-center justify-center text-text-secondary hover:text-accent transition-colors"
                            >
                              <ExternalLink size={11} />
                            </a>
                          </td>
                        </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-4 mt-2 text-xs font-mono text-text-secondary">
                <span>Total committed: <span className="text-text-primary font-semibold">{component.committedQty.toLocaleString()}</span></span>
                <span>Available after: <span className={`font-semibold ${component.availableQty < 0 ? 'text-danger' : 'text-success'}`}>{component.availableQty.toLocaleString()}</span></span>
              </div>
            </div>
          )}

          {/* Warnings */}
          {component.warnings.map((w: any, i: number) => (
            <div key={i} className="bg-warning/10 border border-warning/30 rounded p-3">
              <p className="text-xs text-text-secondary">{w.message}</p>
              <p className="text-xs text-text-secondary italic mt-1">{w.recommendedAction}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function SupplyPage() {
  const searchParams = useSearchParams()
  const preFilterSKU = searchParams.get('sku') ?? ''

  const [search, setSearch] = useState(preFilterSKU)
  const [categoryFilter, setCategoryFilter] = useState<string[]>([])
  const [showFilter, setShowFilter] = useState<'all' | 'allocated' | 'shortage'>('all')
  const [throughDate, setThroughDate] = useState(() => {
    const d = new Date()
    d.setMonth(d.getMonth() + 4)
    return d.toISOString().split('T')[0]
  })
  const [data, setData] = useState<Component[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [includeAllocations, setIncludeAllocations] = useState(false)

  useEffect(() => {
    fetchData()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [throughDate, includeAllocations])

  async function fetchData() {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ throughDate })
      if (includeAllocations) params.set('includeAllocations', 'true')
      const res = await fetch(`/api/supply/data?${params}`)
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      const json = await res.json()
      setData(json.components ?? [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const categories = useMemo(() => Array.from(new Set(data.map(c => c.category))).sort(), [data])

  const filtered = useMemo(() => {
    let list = data
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(c => c.sku.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    }
    if (categoryFilter.length > 0) {
      list = list.filter(c => categoryFilter.includes(c.category))
    }
    if (showFilter === 'shortage') list = list.filter(c => c.hasShortageRisk)
    if (showFilter === 'allocated') list = list.filter(c => c.committedQty > 0)
    return list
  }, [data, search, categoryFilter, showFilter])

  const shortageCount = data.filter(c => c.hasShortageRisk).length
  const warningCount = data.reduce((s, c) => s + c.warnings.length, 0)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-surface border-b border-border px-4 py-3 space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="font-mono text-sm font-bold tracking-widest uppercase text-text-primary">
            Supply Intelligence
          </h1>
          <div className="flex items-center gap-2">
            <label className="text-xs text-text-secondary font-mono">Through:</label>
            <input
              type="date"
              value={throughDate}
              onChange={e => setThroughDate(e.target.value)}
              className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
            />
            <button onClick={fetchData} disabled={loading} className="btn-secondary text-xs">
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search SKU or name…"
              className="bg-bg border border-border rounded pl-7 pr-3 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent w-52"
            />
          </div>

          {/* Category filter */}
          <div className="flex flex-wrap gap-1">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(f =>
                  f.includes(cat) ? f.filter(c => c !== cat) : [...f, cat]
                )}
                className={`chip text-xs border transition-colors ${
                  categoryFilter.includes(cat)
                    ? 'border-accent text-accent bg-accent/10'
                    : 'border-border text-text-secondary hover:border-accent/50'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Show filter */}
          <div className="flex rounded border border-border overflow-hidden">
            {(['all', 'shortage', 'allocated'] as const).map(f => (
              <button
                key={f}
                onClick={() => setShowFilter(f)}
                className={`px-3 py-1 text-xs font-mono capitalize transition-colors ${
                  showFilter === f ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          {/* Allocation toggle */}
          <button
            onClick={() => setIncludeAllocations(a => !a)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
              includeAllocations
                ? 'bg-accent text-white border-accent'
                : 'text-text-secondary border-border hover:border-accent/50'
            }`}
            title={includeAllocations ? 'Allocations shown (slower)' : 'Show allocation data (runs full optimizer)'}
          >
            <Zap size={11} />
            {includeAllocations ? 'Allocations ON' : 'Show Allocations'}
          </button>
        </div>
      </div>

      <SummaryBar stats={[
        { label: 'Total Components', value: data.length },
        { label: 'Showing', value: filtered.length },
        { label: 'Shortage Risk', value: shortageCount, color: shortageCount > 0 ? 'danger' : 'default' },
        { label: 'Warnings', value: warningCount, color: warningCount > 0 ? 'warning' : 'default' },
      ]} />

      {error && (
        <div className="mx-4 my-2 bg-danger/10 border border-danger/30 rounded px-3 py-2 text-xs text-danger font-mono flex items-center gap-2">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 space-y-2">
        {filtered.length === 0 && !loading && (
          <div className="text-center text-text-secondary font-mono text-sm py-16">
            No supply components match your filters
          </div>
        )}
        {filtered.map(component => (
          <ComponentCard
            key={component.itemId}
            component={component}
            defaultOpen={preFilterSKU === component.sku}
          />
        ))}
      </div>
    </div>
  )
}
