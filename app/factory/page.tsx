'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, Clock, TrendingUp, TrendingDown, Minus, Plus, ChevronRight, Settings, BarChart2, Pencil, Trash2, X, Check } from 'lucide-react'

// ── Shift helpers ─────────────────────────────────────────────────────────────

const SHIFT_CONFIG = [
  { shift: 1, label: 'Shift 1', start: 6, end: 14 },
  { shift: 2, label: 'Shift 2', start: 14, end: 22 },
]

function getCurrentShift(): number {
  const h = new Date().getHours()
  for (const s of SHIFT_CONFIG) {
    if (h >= s.start && h < s.end) return s.shift
  }
  return 0 // outside shift hours
}

function getShiftLabel(shift: number) {
  return SHIFT_CONFIG.find(s => s.shift === shift)?.label ?? `Shift ${shift}`
}

function getShiftTimeRemaining(shift: number): string {
  const now = new Date()
  const cfg = SHIFT_CONFIG.find(s => s.shift === shift)
  if (!cfg) return ''
  const end = new Date(now)
  end.setHours(cfg.end, 0, 0, 0)
  if (now >= end) return 'Shift ended'
  const diff = end.getTime() - now.getTime()
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`
}

function getShiftElapsedPct(shift: number): number {
  const now = new Date()
  const cfg = SHIFT_CONFIG.find(s => s.shift === shift)
  if (!cfg) return 0
  const start = new Date(now); start.setHours(cfg.start, 0, 0, 0)
  const end   = new Date(now); end.setHours(cfg.end,   0, 0, 0)
  if (now < start) return 0
  if (now >= end)  return 100
  return Math.min(100, ((now.getTime() - start.getTime()) / (end.getTime() - start.getTime())) * 100)
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Log {
  id: number
  sessionId: number
  qtyAdded: number
  operatorName: string | null
  note: string | null
  recordedAt: string
}

interface Session {
  id: number
  sessionDate: string
  lineNumber: number
  shiftNumber: number
  orderNumber: string
  sku: string
  productName: string
  targetQty: number
  producedQty: number
  status: 'pending' | 'active' | 'complete'
  updatedAt: string
  logs: Log[]
}

// ── Pace logic ────────────────────────────────────────────────────────────────

type Pace = 'ahead' | 'on-track' | 'behind' | 'complete' | 'not-started'

function getPace(session: Session): Pace {
  if (session.producedQty >= session.targetQty) return 'complete'
  if (session.producedQty === 0) return 'not-started'
  const donePct = session.producedQty / session.targetQty
  const elapsedPct = getShiftElapsedPct(session.shiftNumber) / 100
  if (elapsedPct <= 0) return 'not-started'
  const delta = donePct - elapsedPct
  if (delta >= 0.08) return 'ahead'
  if (delta <= -0.08) return 'behind'
  return 'on-track'
}

const PACE_CONFIG: Record<Pace, { label: string; color: string; bg: string; icon: React.ElementType }> = {
  'complete':    { label: 'Complete!',  color: '#22c55e', bg: 'rgba(34,197,94,0.12)',   icon: CheckCircle2 },
  'ahead':       { label: 'Ahead',      color: '#22c55e', bg: 'rgba(34,197,94,0.10)',   icon: TrendingUp   },
  'on-track':    { label: 'On Track',   color: '#f59e0b', bg: 'rgba(245,158,11,0.10)',  icon: Minus        },
  'behind':      { label: 'Behind',     color: '#ef4444', bg: 'rgba(239,68,68,0.10)',   icon: TrendingDown },
  'not-started': { label: 'Not Started',color: '#64748b', bg: 'rgba(100,116,139,0.10)', icon: Clock        },
}

function getPaceMessage(session: Session): string {
  const pace = getPace(session)
  const remaining = session.targetQty - session.producedQty
  if (pace === 'complete') return `All ${session.targetQty.toLocaleString()} units complete — great work!`
  if (pace === 'not-started') return `${session.targetQty.toLocaleString()} units to go — let's get started!`
  const elapsedPct = getShiftElapsedPct(session.shiftNumber) / 100
  const expectedByNow = Math.round(session.targetQty * elapsedPct)
  const diff = Math.abs(session.producedQty - expectedByNow)
  if (pace === 'ahead') return `${diff.toLocaleString()} units ahead of pace — keep it up!`
  if (pace === 'behind') return `${diff.toLocaleString()} units behind pace — ${remaining.toLocaleString()} to go, push hard!`
  return `Right on pace — ${remaining.toLocaleString()} units remaining`
}

// ── Log Production Modal ──────────────────────────────────────────────────────

function LogModal({ session, onClose, onLogged }: {
  session: Session
  onClose: () => void
  onLogged: (newTotal: number) => void
}) {
  const [localLogs, setLocalLogs] = useState<Log[]>(session.logs)
  const [localProduced, setLocalProduced] = useState(session.producedQty)
  const [qty, setQty] = useState('')
  const [operator, setOperator] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // edit state
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editQty, setEditQty] = useState('')
  const [actionId, setActionId] = useState<number | null>(null) // log id being saved/deleted

  function applyUpdate(newTotal: number, updater: (logs: Log[]) => Log[]) {
    setLocalProduced(newTotal)
    setLocalLogs(updater)
    onLogged(newTotal)
  }

  async function submit() {
    const n = parseInt(qty, 10)
    if (!n || n <= 0) { setError('Enter a valid quantity'); return }
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/factory/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, qtyAdded: n, operatorName: operator || null, note: null }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      // Add placeholder log to local list so user sees it immediately
      const newLog: Log = {
        id: Date.now(), // temp id; real id would come from a re-fetch
        sessionId: session.id,
        qtyAdded: n,
        operatorName: operator || null,
        note: null,
        recordedAt: new Date().toISOString(),
      }
      applyUpdate(json.producedQty, logs => [newLog, ...logs])
      setQty('')
      setOperator('')
      onClose()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(logId: number) {
    setActionId(logId)
    setError('')
    try {
      const res = await fetch('/api/factory/log', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      applyUpdate(json.producedQty, logs => logs.filter(l => l.id !== logId))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setActionId(null)
    }
  }

  async function handleEdit(logId: number) {
    const n = parseInt(editQty, 10)
    if (!n || n <= 0) { setError('Enter a valid quantity'); return }
    setActionId(logId)
    setError('')
    try {
      const res = await fetch('/api/factory/log', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logId, qtyAdded: n }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      applyUpdate(json.producedQty, logs => logs.map(l => l.id === logId ? { ...l, qtyAdded: n } : l))
      setEditingId(null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setActionId(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl shadow-2xl flex flex-col"
        style={{ background: '#fff', border: '1px solid #e2e8f0', maxHeight: '90vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b shrink-0" style={{ borderColor: '#e2e8f0', background: '#f8fafc' }}>
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#94a3b8' }}>
            Line {session.lineNumber} · {getShiftLabel(session.shiftNumber)}
          </p>
          <h2 className="text-xl font-bold mt-0.5" style={{ color: '#0f172a' }}>Log Production</h2>
          <p className="text-sm mt-1" style={{ color: '#64748b' }}>{session.sku} — {session.productName}</p>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Current progress */}
          <div className="rounded-xl p-3 flex items-center justify-between" style={{ background: '#f1f5f9' }}>
            <span className="text-sm font-medium" style={{ color: '#475569' }}>Current progress</span>
            <span className="font-bold text-lg" style={{ color: '#0f172a' }}>
              {localProduced.toLocaleString()} / {session.targetQty.toLocaleString()}
            </span>
          </div>

          {/* ── Existing log entries ── */}
          {localLogs.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#94a3b8' }}>
                Logged Entries
              </p>
              <div className="space-y-1.5">
                {localLogs.map(log => {
                  const t = new Date(log.recordedAt)
                  const isEditing = editingId === log.id
                  const isBusy = actionId === log.id
                  return (
                    <div
                      key={log.id}
                      className="rounded-xl px-3 py-2 flex items-center gap-2"
                      style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}
                    >
                      <span className="text-xs font-mono shrink-0" style={{ color: '#94a3b8' }}>
                        {t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {isEditing ? (
                        <input
                          type="number"
                          min="1"
                          value={editQty}
                          onChange={e => setEditQty(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleEdit(log.id); if (e.key === 'Escape') setEditingId(null) }}
                          autoFocus
                          className="flex-1 rounded-lg border px-2 py-1 text-sm font-bold text-center focus:outline-none"
                          style={{ borderColor: '#818cf8', color: '#0f172a', maxWidth: 80 }}
                        />
                      ) : (
                        <span className="flex-1 text-sm font-bold" style={{ color: '#0f172a' }}>
                          +{log.qtyAdded.toLocaleString()}
                        </span>
                      )}
                      {log.operatorName && (
                        <span className="text-xs truncate" style={{ color: '#64748b', maxWidth: 80 }}>
                          {log.operatorName}
                        </span>
                      )}
                      {/* Edit / Save / Cancel */}
                      {isEditing ? (
                        <>
                          <button
                            onClick={() => handleEdit(log.id)}
                            disabled={isBusy}
                            className="shrink-0 rounded-lg p-1.5 transition-colors"
                            style={{ background: 'rgba(34,197,94,0.1)', color: '#16a34a' }}
                            title="Save"
                          >
                            <Check size={13} strokeWidth={2.5} />
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="shrink-0 rounded-lg p-1.5 transition-colors"
                            style={{ background: '#f1f5f9', color: '#64748b' }}
                            title="Cancel"
                          >
                            <X size={13} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => { setEditingId(log.id); setEditQty(String(log.qtyAdded)) }}
                            disabled={isBusy}
                            className="shrink-0 rounded-lg p-1.5 transition-colors"
                            style={{ background: 'rgba(79,70,229,0.08)', color: '#4f46e5' }}
                            title="Edit quantity"
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            onClick={() => handleDelete(log.id)}
                            disabled={isBusy}
                            className="shrink-0 rounded-lg p-1.5 transition-colors"
                            style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444' }}
                            title="Delete entry"
                          >
                            {isBusy ? <span className="text-xs">…</span> : <Trash2 size={12} />}
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── Divider ── */}
          {localLogs.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-px" style={{ background: '#e2e8f0' }} />
              <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#94a3b8' }}>Add New Entry</span>
              <div className="flex-1 h-px" style={{ background: '#e2e8f0' }} />
            </div>
          )}

          {/* ── New entry form ── */}
          <div>
            <label className="block text-sm font-semibold mb-1.5" style={{ color: '#374151' }}>
              Units produced this entry *
            </label>
            <input
              type="number"
              min="1"
              value={qty}
              onChange={e => setQty(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}
              placeholder="e.g. 75"
              autoFocus={localLogs.length === 0}
              className="w-full rounded-xl border px-4 py-3 text-2xl font-bold text-center focus:outline-none focus:ring-2"
              style={{ borderColor: '#cbd5e1', color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}
            />
          </div>

          {/* Quick-add chips */}
          <div className="flex flex-wrap gap-2">
            {[25, 50, 75, 100].map(n => (
              <button
                key={n}
                onClick={() => setQty(String(n))}
                className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all"
                style={{
                  background: qty === String(n) ? '#4f46e5' : '#f1f5f9',
                  color: qty === String(n) ? '#fff' : '#475569',
                  border: '1px solid',
                  borderColor: qty === String(n) ? '#4f46e5' : '#e2e8f0',
                }}
              >
                +{n}
              </button>
            ))}
          </div>

          {/* Operator name */}
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: '#374151' }}>
              Your name <span style={{ color: '#94a3b8' }}>(optional)</span>
            </label>
            <input
              type="text"
              value={operator}
              onChange={e => setOperator(e.target.value)}
              placeholder="Operator name"
              className="w-full rounded-xl border px-4 py-2.5 text-sm focus:outline-none focus:ring-2"
              style={{ borderColor: '#cbd5e1', color: '#0f172a' }}
            />
          </div>

          {error && (
            <p className="text-sm text-center font-medium" style={{ color: '#ef4444' }}>{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 pt-3 flex gap-3 shrink-0 border-t" style={{ borderColor: '#e2e8f0' }}>
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-xl text-sm font-semibold transition-colors"
            style={{ background: '#f1f5f9', color: '#64748b', border: '1px solid #e2e8f0' }}
          >
            Close
          </button>
          <button
            onClick={submit}
            disabled={submitting || !qty}
            className="flex-1 py-3 rounded-xl text-sm font-bold transition-all"
            style={{
              background: submitting ? '#818cf8' : '#4f46e5',
              color: '#fff',
              opacity: !qty ? 0.6 : 1,
            }}
          >
            {submitting ? 'Saving…' : 'Log Units'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Session Card ──────────────────────────────────────────────────────────────

function SessionCard({ session, currentShift, onLog }: {
  session: Session
  currentShift: number
  onLog: (s: Session) => void
}) {
  const pace = getPace(session)
  const pCfg = PACE_CONFIG[pace]
  const PaceIcon = pCfg.icon
  const pct = session.targetQty > 0
    ? Math.min(100, (session.producedQty / session.targetQty) * 100)
    : 0
  const elapsedPct = getShiftElapsedPct(session.shiftNumber)
  const isCurrentShift = session.shiftNumber === currentShift
  const remaining = Math.max(0, session.targetQty - session.producedQty)

  // Milestone flash: detect milestone hits
  const milestones = [25, 50, 75, 100]
  const hitMilestone = milestones.find(m => pct >= m && pct < m + (session.targetQty > 0 ? 100 / session.targetQty * 2 : 5))

  const barColor = pace === 'complete' ? '#22c55e'
    : pace === 'behind' ? '#ef4444'
    : pace === 'ahead'  ? '#22c55e'
    : '#f59e0b'

  return (
    <div
      className="rounded-2xl overflow-hidden flex flex-col h-full"
      style={{
        background: '#fff',
        border: '1px solid',
        borderColor: pace === 'complete' ? 'rgba(34,197,94,0.3)'
          : pace === 'behind' ? 'rgba(239,68,68,0.25)'
          : '#e2e8f0',
        boxShadow: isCurrentShift
          ? '0 4px 24px rgba(79,70,229,0.08), 0 0 0 2px rgba(79,70,229,0.12)'
          : '0 2px 8px rgba(0,0,0,0.04)',
        opacity: !isCurrentShift ? 0.7 : 1,
      }}
    >
      {/* Card header */}
      <div
        className="px-6 py-4 flex items-center justify-between"
        style={{
          background: isCurrentShift ? 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)' : '#f8fafc',
          borderBottom: '1px solid #e2e8f0',
        }}
      >
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#64748b' }}>
              Line {session.lineNumber}
            </span>
            <span className="text-xs" style={{ color: '#cbd5e1' }}>·</span>
            <span className="text-xs font-semibold" style={{ color: isCurrentShift ? '#4f46e5' : '#94a3b8' }}>
              {getShiftLabel(session.shiftNumber)}
              {isCurrentShift && <span className="ml-1.5" style={{ color: '#94a3b8' }}>({getShiftTimeRemaining(session.shiftNumber)})</span>}
            </span>
          </div>
          <p className="text-sm font-semibold mt-0.5 truncate" style={{ color: '#0f172a', maxWidth: 220 }}>
            {session.sku} — {session.productName}
          </p>
          <p className="text-xs font-mono mt-0.5" style={{ color: '#94a3b8' }}>WO {session.orderNumber}</p>
        </div>

        {/* Pace badge */}
        <div
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold"
          style={{ background: pCfg.bg, color: pCfg.color }}
        >
          <PaceIcon size={12} strokeWidth={2.5} />
          {pCfg.label}
        </div>
      </div>

      {/* Numbers */}
      <div className="px-6 pt-6 pb-4 flex items-end justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#94a3b8' }}>Produced</p>
          <p className="font-black leading-none" style={{ fontSize: 56, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>
            {session.producedQty.toLocaleString()}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#94a3b8' }}>Target</p>
          <p className="font-bold leading-none" style={{ fontSize: 32, color: '#475569', fontVariantNumeric: 'tabular-nums' }}>
            {session.targetQty.toLocaleString()}
          </p>
          <p className="text-sm font-semibold mt-1" style={{ color: '#94a3b8' }}>
            {remaining > 0 ? `${remaining.toLocaleString()} to go` : 'Done!'}
          </p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="px-6 pb-2">
        <div className="relative h-5 rounded-full overflow-hidden" style={{ background: '#f1f5f9' }}>
          {/* Elapsed time marker */}
          {isCurrentShift && elapsedPct > 0 && elapsedPct < 100 && (
            <div
              className="absolute top-0 bottom-0 w-0.5 z-10"
              style={{ left: `${elapsedPct}%`, background: 'rgba(0,0,0,0.15)' }}
              title={`${elapsedPct.toFixed(0)}% of shift elapsed`}
            />
          )}
          {/* Production progress */}
          <div
            className="absolute left-0 top-0 bottom-0 rounded-full transition-all duration-700"
            style={{ width: `${pct}%`, background: barColor }}
          />
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-xs font-bold" style={{ color: barColor }}>{pct.toFixed(0)}%</span>
          {isCurrentShift && elapsedPct > 0 && (
            <span className="text-xs" style={{ color: '#94a3b8' }}>{elapsedPct.toFixed(0)}% of shift elapsed</span>
          )}
        </div>
      </div>

      {/* Pace message */}
      <div className="px-6 pb-4">
        <p className="text-sm font-medium" style={{ color: '#475569' }}>{getPaceMessage(session)}</p>
      </div>

      {/* Recent logs */}
      {session.logs.length > 0 && (
        <div className="px-6 pb-4 space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#94a3b8' }}>Recent</p>
          {session.logs.slice(0, 3).map(log => {
            const t = new Date(log.recordedAt)
            return (
              <div key={log.id} className="flex items-center gap-2 text-xs" style={{ color: '#64748b' }}>
                <span className="font-mono" style={{ color: '#94a3b8' }}>
                  {t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="font-semibold" style={{ color: '#374151' }}>
                  +{log.qtyAdded.toLocaleString()}
                </span>
                {log.operatorName && <span>· {log.operatorName}</span>}
                {log.note && <span className="italic truncate" style={{ maxWidth: 120 }}>{log.note}</span>}
              </div>
            )
          })}
        </div>
      )}

      {/* Log button — always visible so user can adjust after completion */}
      {(
        <div className="px-6 pb-6 mt-auto">
          <button
            onClick={() => onLog(session)}
            className="w-full py-4 rounded-xl font-bold text-base flex items-center justify-center gap-2 transition-all active:scale-95"
            style={{ background: '#4f46e5', color: '#fff', boxShadow: '0 4px 12px rgba(79,70,229,0.35)' }}
          >
            <Plus size={18} strokeWidth={2.5} /> Log Production
          </button>
        </div>
      )}

      {pace === 'complete' && (
        <div
          className="mx-6 mb-6 py-3 rounded-xl text-center font-bold text-sm flex items-center justify-center gap-2"
          style={{ background: 'rgba(34,197,94,0.12)', color: '#16a34a' }}
        >
          <CheckCircle2 size={16} /> Target reached!
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FactoryDashboardPage() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [now, setNow] = useState(new Date())
  const [logTarget, setLogTarget] = useState<Session | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const REFRESH_INTERVAL = 60 // seconds

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/factory/today')
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      const json = await res.json()
      setSessions(json.sessions ?? [])
      setLastRefresh(new Date())
      setError('')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSessions()
    const dataInterval = setInterval(fetchSessions, REFRESH_INTERVAL * 1000)
    return () => clearInterval(dataInterval)
  }, [fetchSessions])

  // Live clock
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  function handleLogged(sessionId: number, newTotal: number) {
    setSessions(prev => prev.map(s =>
      s.id === sessionId
        ? {
            ...s,
            producedQty: newTotal,
            status: newTotal >= s.targetQty ? 'complete' : newTotal > 0 ? 'active' : 'pending',
          }
        : s,
    ))
  }

  const currentShift = getCurrentShift()
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  // Group by line
  const lines = [1, 2]
  const sessionsByLine = (line: number) => sessions.filter(s => s.lineNumber === line)

  // Summary stats
  const totalTarget = sessions.reduce((s, x) => s + x.targetQty, 0)
  const totalProduced = sessions.reduce((s, x) => s + x.producedQty, 0)
  const overallPct = totalTarget > 0 ? Math.min(100, (totalProduced / totalTarget) * 100) : 0

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#f8fafc' }}>
      {/* Header */}
      <div
        className="px-8 py-5 flex items-center justify-between shrink-0"
        style={{
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
          borderBottom: '1px solid #334155',
        }}
      >
        <div>
          <h1 className="text-2xl font-black text-white tracking-tight">TFM Production Floor</h1>
          <p className="text-sm mt-0.5" style={{ color: '#94a3b8' }}>{dateStr}</p>
        </div>

        <div className="flex items-center gap-8">
          {/* Overall stats */}
          {totalTarget > 0 && (
            <div className="text-right">
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#64748b' }}>Today's Total</p>
              <p className="text-2xl font-black text-white" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {totalProduced.toLocaleString()}
                <span className="text-lg font-bold" style={{ color: '#64748b' }}>
                  {' '}/{' '}{totalTarget.toLocaleString()}
                </span>
              </p>
              <div className="h-1.5 rounded-full mt-1 overflow-hidden" style={{ background: '#334155', width: 160 }}>
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${overallPct}%`, background: overallPct >= 100 ? '#22c55e' : '#4f46e5' }}
                />
              </div>
            </div>
          )}

          {/* Clock + shift */}
          <div className="text-right">
            <p
              className="text-3xl font-black tabular-nums"
              style={{ color: '#fff', fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}
            >
              {timeStr}
            </p>
            {currentShift > 0 ? (
              <p className="text-xs font-semibold mt-0.5" style={{ color: '#818cf8' }}>
                {getShiftLabel(currentShift)} · {getShiftTimeRemaining(currentShift)}
              </p>
            ) : (
              <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>Outside shift hours</p>
            )}
          </div>

          {/* Nav */}
          <Link
            href="/factory/assign"
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
            style={{ background: 'rgba(255,255,255,0.08)', color: '#94a3b8', border: '1px solid #334155' }}
          >
            <Settings size={14} /> Assign Orders
          </Link>
          <Link
            href="/factory/report"
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
            style={{ background: 'rgba(255,255,255,0.08)', color: '#94a3b8', border: '1px solid #334155' }}
          >
            <BarChart2 size={14} /> Report
          </Link>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 p-6">
        {error && (
          <div className="mb-4 rounded-xl px-4 py-3 flex items-center gap-2 text-sm font-medium"
            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444' }}>
            <AlertTriangle size={14} /> {error}
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-24 text-sm font-medium" style={{ color: '#94a3b8' }}>
            Loading today's sessions…
          </div>
        )}

        {!loading && sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="text-5xl">🏭</div>
            <p className="text-xl font-bold" style={{ color: '#1e293b' }}>No sessions scheduled for today</p>
            <p className="text-sm" style={{ color: '#94a3b8' }}>A supervisor needs to assign production orders to lines and shifts.</p>
            <Link
              href="/factory/assign"
              className="flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm transition-colors"
              style={{ background: '#4f46e5', color: '#fff' }}
            >
              Go to Assignment <ChevronRight size={14} />
            </Link>
          </div>
        )}

        {!loading && sessions.length > 0 && (
          <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
            {lines.map(line => {
              const lineSessions = sessionsByLine(line)
              if (lineSessions.length === 0) return null
              return (
                <div key={line} className="flex flex-col gap-4 h-full">
                  {/* Line header */}
                  <div className="flex items-center gap-3">
                    <div
                      className="flex items-center justify-center rounded-xl font-black text-white text-lg"
                      style={{ width: 40, height: 40, background: line === 1 ? '#4f46e5' : '#7c3aed' }}
                    >
                      {line}
                    </div>
                    <div>
                      <h2 className="text-lg font-bold" style={{ color: '#0f172a' }}>Line {line}</h2>
                      <p className="text-xs" style={{ color: '#94a3b8' }}>
                        {lineSessions.length} session{lineSessions.length !== 1 ? 's' : ''} today
                      </p>
                    </div>
                  </div>

                  {/* Session cards sorted by shift */}
                  <div className="flex flex-col flex-1 gap-4">
                    {[...lineSessions]
                      .sort((a, b) => a.shiftNumber - b.shiftNumber)
                      .map(session => (
                        <SessionCard
                          key={session.id}
                          session={session}
                          currentShift={currentShift}
                          onLog={setLogTarget}
                        />
                      ))
                    }
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Refresh indicator */}
        {lastRefresh && (
          <p className="text-center text-xs mt-8" style={{ color: '#cbd5e1' }}>
            Last updated {lastRefresh.toLocaleTimeString()} · auto-refreshes every {REFRESH_INTERVAL}s
          </p>
        )}
      </div>

      {/* Log modal */}
      {logTarget && (
        <LogModal
          session={logTarget}
          onClose={() => setLogTarget(null)}
          onLogged={newTotal => handleLogged(logTarget.id, newTotal)}
        />
      )}
    </div>
  )
}
