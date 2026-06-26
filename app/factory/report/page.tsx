'use client'

import React, { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { ChevronLeft, BarChart2, RefreshCw, Pencil, X, Trash2, Check, Plus, Loader2 } from 'lucide-react'

// ── Config ────────────────────────────────────────────────────────────────────

const COMBOS = [
  { line: 1, shift: 1, label: 'Line 1 · Shift 1' },
  { line: 1, shift: 2, label: 'Line 1 · Shift 2' },
  { line: 2, shift: 1, label: 'Line 2 · Shift 1' },
  { line: 2, shift: 2, label: 'Line 2 · Shift 2' },
] as const

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthBounds(ym: string): { from: string; through: string } {
  const [y, m] = ym.split('-').map(Number)
  const from    = `${y}-${String(m).padStart(2, '0')}-01`
  const lastDay = new Date(y, m, 0).getDate()
  const through = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  return { from, through }
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function getDatesInRange(from: string, through: string): string[] {
  const dates: string[] = []
  const cur = new Date(from + 'T00:00:00')
  const end = new Date(through + 'T00:00:00')
  while (cur <= end) {
    dates.push(cur.toISOString().split('T')[0])
    cur.setDate(cur.getDate() + 1)
  }
  return dates
}

function isWeekend(d: string) {
  const day = new Date(d + 'T00:00:00').getDay()
  return day === 0 || day === 6
}

function dayLabel(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' })
}

function fmtMD(d: string) {
  const dt = new Date(d + 'T00:00:00')
  return `${dt.getMonth() + 1}/${dt.getDate()}`
}

interface PctResult { label: string; color: string }

function pct(target: number, produced: number): PctResult {
  if (target === 0) return { label: '—', color: 'var(--text-muted)' }
  const p = Math.round((produced / target) * 100)
  return {
    label: `${p}%`,
    color: p >= 100 ? '#16a34a' : p >= 90 ? '#d97706' : '#dc2626',
  }
}

function delta(target: number, produced: number): PctResult {
  if (target === 0) return { label: '—', color: 'var(--text-muted)' }
  const d = produced - target
  return {
    label: d === 0 ? '—' : d > 0 ? `+${d.toLocaleString()}` : d.toLocaleString(),
    color: d >= 0 ? '#16a34a' : '#dc2626',
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface CellData {
  skus: string[]
  target: number
  produced: number
  skuData: { sku: string; target: number; produced: number }[]
}
type Cells   = Record<string, Record<string, CellData>>
type Totals  = Record<string, { target: number; produced: number }>

interface LogEntry {
  id: number
  sessionId: number
  qtyAdded: number
  operatorName: string | null
  note: string | null
  recordedAt: string
}

interface SessionInCell {
  id: number
  orderNumber: string
  sku: string
  productName: string
  targetQty: number
  producedQty: number
  status: string
  logs: LogEntry[]
}

interface EditCell { date: string; line: number; shift: number; label: string }

// ── CellEditModal ─────────────────────────────────────────────────────────────

function CellEditModal({ cell, onClose, onRefresh }: {
  cell: EditCell
  onClose: () => void
  onRefresh: () => void
}) {
  const [sessions, setSessions] = useState<SessionInCell[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')

  // inline edit state (one log at a time)
  const [editingLogId, setEditingLogId] = useState<number | null>(null)
  const [editQty, setEditQty]           = useState('')
  const [actionLogId, setActionLogId]   = useState<number | null>(null)

  // per-session add form
  const [addQty, setAddQty]           = useState<Record<number, string>>({})
  const [addOp,  setAddOp]            = useState<Record<number, string>>({})
  const [addBusy, setAddBusy]         = useState<number | null>(null)
  const [formError, setFormError]     = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(
        `/api/factory/sessions-by-cell?date=${cell.date}&line=${cell.line}&shift=${cell.shift}`,
      )
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Server error')
      setSessions(json.sessions ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [cell.date, cell.line, cell.shift])

  useEffect(() => { load() }, [load])

  function applySessionUpdate(sessionId: number, newTotal: number, logUpdater: (logs: LogEntry[]) => LogEntry[]) {
    setSessions(prev => prev.map(s => s.id !== sessionId ? s : {
      ...s,
      producedQty: newTotal,
      logs: logUpdater(s.logs),
    }))
    onRefresh()
  }

  async function handleDelete(logId: number, sessionId: number) {
    setActionLogId(logId)
    setFormError('')
    try {
      const res = await fetch('/api/factory/log', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      applySessionUpdate(sessionId, json.producedQty, logs => logs.filter(l => l.id !== logId))
    } catch (e: any) {
      setFormError(e.message)
    } finally {
      setActionLogId(null)
    }
  }

  async function handleEdit(logId: number, sessionId: number) {
    const n = parseInt(editQty, 10)
    if (!n || n <= 0) { setFormError('Enter a valid quantity'); return }
    setActionLogId(logId)
    setFormError('')
    try {
      const res = await fetch('/api/factory/log', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logId, qtyAdded: n }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      applySessionUpdate(sessionId, json.producedQty,
        logs => logs.map(l => l.id === logId ? { ...l, qtyAdded: n } : l),
      )
      setEditingLogId(null)
    } catch (e: any) {
      setFormError(e.message)
    } finally {
      setActionLogId(null)
    }
  }

  async function handleAdd(sessionId: number) {
    const n = parseInt(addQty[sessionId] ?? '', 10)
    if (!n || n <= 0) { setFormError('Enter a valid quantity'); return }
    setAddBusy(sessionId)
    setFormError('')
    try {
      const res = await fetch('/api/factory/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          qtyAdded: n,
          operatorName: addOp[sessionId]?.trim() || null,
          note: null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      const newLog: LogEntry = {
        id: Date.now(),
        sessionId,
        qtyAdded: n,
        operatorName: addOp[sessionId]?.trim() || null,
        note: null,
        recordedAt: new Date().toISOString(),
      }
      applySessionUpdate(sessionId, json.producedQty, logs => [newLog, ...logs])
      setAddQty(prev => ({ ...prev, [sessionId]: '' }))
      setAddOp(prev =>  ({ ...prev, [sessionId]: '' }))
    } catch (e: any) {
      setFormError(e.message)
    } finally {
      setAddBusy(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl shadow-2xl flex flex-col"
        style={{ background: '#fff', border: '1px solid #e2e8f0', maxHeight: '88vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b flex items-center justify-between shrink-0"
          style={{ borderColor: '#e2e8f0', background: '#f8fafc' }}>
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#94a3b8' }}>
              {fmtMD(cell.date)} · {cell.label}
            </p>
            <h2 className="text-lg font-bold mt-0.5" style={{ color: '#0f172a' }}>Edit Production Logs</h2>
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 transition-colors hover:bg-slate-100">
            <X size={16} style={{ color: '#64748b' }} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {loading && (
            <div className="flex items-center justify-center py-12 gap-2 text-sm" style={{ color: '#94a3b8' }}>
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          )}
          {error && (
            <p className="text-sm font-medium text-center" style={{ color: '#ef4444' }}>{error}</p>
          )}
          {!loading && sessions.length === 0 && (
            <p className="text-sm text-center py-8" style={{ color: '#94a3b8' }}>No sessions found for this cell.</p>
          )}

          {sessions.map(sess => (
            <div key={sess.id} className="rounded-xl border" style={{ borderColor: '#e2e8f0' }}>
              {/* Session header */}
              <div className="px-4 py-3 border-b flex items-center justify-between"
                style={{ borderColor: '#e2e8f0', background: '#f8fafc', borderRadius: '12px 12px 0 0' }}>
                <div>
                  <p className="text-sm font-bold" style={{ color: '#0f172a' }}>{sess.sku}</p>
                  <p className="text-xs" style={{ color: '#64748b' }}>{sess.productName} · WO {sess.orderNumber}</p>
                </div>
                <div className="text-right text-xs font-mono" style={{ color: '#475569' }}>
                  <span className="font-bold" style={{ color: '#0f172a', fontSize: 15 }}>
                    {sess.producedQty.toLocaleString()}
                  </span>
                  <span style={{ color: '#94a3b8' }}> / {sess.targetQty.toLocaleString()}</span>
                </div>
              </div>

              <div className="px-4 py-3 space-y-3">
                {/* Existing log entries */}
                {sess.logs.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-widest mb-1" style={{ color: '#94a3b8' }}>
                      Logged Entries
                    </p>
                    {sess.logs.map(log => {
                      const t = new Date(log.recordedAt)
                      const isEditing = editingLogId === log.id
                      const isBusy   = actionLogId === log.id
                      return (
                        <div key={log.id} className="rounded-lg px-3 py-2 flex items-center gap-2"
                          style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                          <span className="text-xs font-mono shrink-0" style={{ color: '#94a3b8' }}>
                            {t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                          {isEditing ? (
                            <input
                              type="number" min="1"
                              value={editQty}
                              onChange={e => setEditQty(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') handleEdit(log.id, sess.id)
                                if (e.key === 'Escape') setEditingLogId(null)
                              }}
                              autoFocus
                              className="rounded-lg border px-2 py-1 text-sm font-bold text-center focus:outline-none"
                              style={{ borderColor: '#818cf8', color: '#0f172a', width: 80 }}
                            />
                          ) : (
                            <span className="flex-1 text-sm font-bold" style={{ color: '#0f172a' }}>
                              +{log.qtyAdded.toLocaleString()}
                            </span>
                          )}
                          {log.operatorName && !isEditing && (
                            <span className="text-xs truncate" style={{ color: '#64748b', maxWidth: 90 }}>
                              {log.operatorName}
                            </span>
                          )}
                          {isEditing ? (
                            <>
                              <button onClick={() => handleEdit(log.id, sess.id)} disabled={isBusy}
                                className="shrink-0 rounded-lg p-1.5" style={{ background: 'rgba(34,197,94,0.1)', color: '#16a34a' }}
                                title="Save">
                                <Check size={13} strokeWidth={2.5} />
                              </button>
                              <button onClick={() => setEditingLogId(null)}
                                className="shrink-0 rounded-lg p-1.5" style={{ background: '#f1f5f9', color: '#64748b' }}
                                title="Cancel">
                                <X size={13} />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => { setEditingLogId(log.id); setEditQty(String(log.qtyAdded)) }}
                                disabled={isBusy}
                                className="shrink-0 rounded-lg p-1.5"
                                style={{ background: 'rgba(79,70,229,0.08)', color: '#4f46e5' }}
                                title="Edit quantity">
                                <Pencil size={12} />
                              </button>
                              <button
                                onClick={() => handleDelete(log.id, sess.id)}
                                disabled={isBusy}
                                className="shrink-0 rounded-lg p-1.5"
                                style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444' }}
                                title="Delete entry">
                                {isBusy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                              </button>
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Add new entry */}
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#94a3b8' }}>
                    {sess.logs.length > 0 ? 'Add Entry' : 'Log Production'}
                  </p>
                  <div className="flex gap-2 items-center">
                    <input
                      type="number" min="1"
                      placeholder="Qty"
                      value={addQty[sess.id] ?? ''}
                      onChange={e => setAddQty(prev => ({ ...prev, [sess.id]: e.target.value }))}
                      onKeyDown={e => e.key === 'Enter' && handleAdd(sess.id)}
                      className="rounded-lg border px-3 py-2 text-sm font-bold text-center focus:outline-none focus:ring-2"
                      style={{ borderColor: '#cbd5e1', color: '#0f172a', width: 90 }}
                    />
                    <input
                      type="text"
                      placeholder="Operator (opt.)"
                      value={addOp[sess.id] ?? ''}
                      onChange={e => setAddOp(prev => ({ ...prev, [sess.id]: e.target.value }))}
                      className="flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2"
                      style={{ borderColor: '#cbd5e1', color: '#0f172a' }}
                    />
                    <button
                      onClick={() => handleAdd(sess.id)}
                      disabled={addBusy === sess.id || !addQty[sess.id]}
                      className="shrink-0 rounded-lg px-3 py-2 text-sm font-bold flex items-center gap-1.5 transition-all"
                      style={{
                        background: '#4f46e5', color: '#fff',
                        opacity: (!addQty[sess.id] || addBusy === sess.id) ? 0.6 : 1,
                      }}>
                      {addBusy === sess.id
                        ? <Loader2 size={13} className="animate-spin" />
                        : <Plus size={13} strokeWidth={2.5} />}
                      Add
                    </button>
                  </div>
                  {/* Quick-add chips */}
                  <div className="flex gap-1.5 mt-2">
                    {[25, 50, 75, 100].map(n => (
                      <button key={n}
                        onClick={() => setAddQty(prev => ({ ...prev, [sess.id]: String(n) }))}
                        className="flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all"
                        style={{
                          background: addQty[sess.id] === String(n) ? '#4f46e5' : '#f1f5f9',
                          color: addQty[sess.id] === String(n) ? '#fff' : '#475569',
                          border: '1px solid',
                          borderColor: addQty[sess.id] === String(n) ? '#4f46e5' : '#e2e8f0',
                        }}>
                        +{n}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}

          {formError && (
            <p className="text-sm font-medium text-center" style={{ color: '#ef4444' }}>{formError}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t shrink-0" style={{ borderColor: '#e2e8f0' }}>
          <button
            onClick={onClose}
            className="w-full py-3 rounded-xl text-sm font-semibold"
            style={{ background: '#f1f5f9', color: '#64748b', border: '1px solid #e2e8f0' }}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ProductionReportPage() {
  const [selectedMonth, setSelectedMonth] = useState(currentMonth)
  const [cells,         setCells]         = useState<Cells>({})
  const [totals,        setTotals]        = useState<Totals>({})
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState('')
  const [editMode,      setEditMode]      = useState(false)
  const [editCell,      setEditCell]      = useState<EditCell | null>(null)

  const fetchReport = useCallback(async () => {
    setLoading(true)
    setError('')
    const { from, through } = monthBounds(selectedMonth)
    try {
      const res = await fetch(`/api/factory/report?fromDate=${from}&throughDate=${through}`)
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      const json = await res.json()
      setCells(json.cells ?? {})
      setTotals(json.totals ?? {})
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [selectedMonth])

  useEffect(() => { fetchReport() }, [fetchReport])

  const { from: fromDate, through: throughDate } = monthBounds(selectedMonth)
  const dates = getDatesInRange(fromDate, throughDate)
  let rowNum = 0

  return (
    <div className="flex flex-col h-full">

      {/* Header */}
      <div className="bg-surface border-b border-border px-4 py-3 shrink-0">
        <div className="flex items-center gap-3 mb-3">
          <Link href="/factory" className="text-xs text-accent hover:underline font-mono flex items-center gap-1">
            <ChevronLeft size={12} /> Factory Floor
          </Link>
          <span className="text-xs text-text-secondary font-mono">·</span>
          <BarChart2 size={14} className="text-accent" />
          <h1 className="font-mono text-sm font-bold tracking-widest uppercase text-text-primary">
            Production Efficiency Report
          </h1>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-xs text-text-secondary font-mono">Month:</label>
          <input type="month" value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}
            className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent" />
          <button onClick={fetchReport} disabled={loading}
            className="btn-secondary text-xs flex items-center gap-1.5">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>

          {/* Edit Mode toggle */}
          <button
            onClick={() => setEditMode(m => !m)}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all ml-auto"
            style={editMode
              ? { background: '#4f46e5', color: '#fff', borderColor: '#4f46e5' }
              : { background: 'transparent', color: 'var(--text-secondary)', borderColor: 'var(--border)' }
            }
          >
            <Pencil size={11} />
            {editMode ? 'Edit Mode ON' : 'Edit Mode'}
          </button>
        </div>

        {editMode && (
          <p className="text-[10px] font-mono mt-2" style={{ color: '#818cf8' }}>
            Click the pencil icon on any cell to edit log entries for that session.
          </p>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mx-4 my-2 bg-danger/10 border border-danger/30 rounded px-3 py-2 text-xs text-danger font-mono">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto p-4">
        <div className="overflow-x-auto">
          <table className="text-xs font-mono border-collapse" style={{ minWidth: 980 }}>
            <thead>
              {/* Row 1 — group labels */}
              <tr>
                <th className="border border-border px-2 py-1.5 bg-surface text-text-muted text-center" rowSpan={2}>#</th>
                <th className="border border-border px-2 py-1.5 bg-surface text-text-secondary text-center font-semibold" rowSpan={2}>Date</th>
                <th className="border border-border px-2 py-1.5 bg-surface text-text-muted text-center" rowSpan={2}>Day</th>
                {COMBOS.map(c => (
                  <th key={`grp-${c.line}-${c.shift}`} colSpan={5}
                    className="border border-border px-2 py-1.5 text-center font-bold text-text-primary"
                    style={{ background: c.line === 1 ? 'rgba(79,70,229,0.09)' : 'rgba(124,58,237,0.09)', borderLeft: '3px solid #475569' }}>
                    {c.label}
                  </th>
                ))}
              </tr>
              {/* Row 2 — column sub-headers */}
              <tr>
                {COMBOS.map(c => (
                  <React.Fragment key={`sub-${c.line}-${c.shift}`}>
                    <th className="border border-border px-2 py-1 bg-surface text-text-secondary font-semibold text-left" style={{ minWidth: 130, borderLeft: '3px solid #475569' }}>SKU</th>
                    <th className="border border-border px-2 py-1 bg-surface text-text-secondary font-semibold text-right" style={{ minWidth: 55 }}>Target</th>
                    <th className="border border-border px-2 py-1 bg-surface text-text-secondary font-semibold text-right" style={{ minWidth: 55 }}>Actual</th>
                    <th className="border border-border px-2 py-1 bg-surface text-text-secondary font-semibold text-right" style={{ minWidth: 48 }}>Δ</th>
                    <th className="border border-border px-2 py-1 bg-surface text-text-secondary font-semibold text-right" style={{ minWidth: 42 }}>%</th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>

            <tbody>
              {dates.map(date => {
                const weekend   = isWeekend(date)
                const dateCells = cells[date] ?? {}
                const hasData   = Object.keys(dateCells).length > 0
                if (!weekend) rowNum++

                if (weekend) {
                  return (
                    <tr key={date} style={{ background: 'rgba(100,116,139,0.05)' }}>
                      <td className="border border-border px-2 py-1 text-text-muted text-center">—</td>
                      <td className="border border-border px-2 py-1 text-text-muted text-center">{fmtMD(date)}</td>
                      <td className="border border-border px-2 py-1 text-text-muted text-center">{dayLabel(date)}</td>
                      <td colSpan={20} className="border border-border px-3 py-1 text-text-muted font-semibold tracking-widest uppercase text-[10px]">
                        Weekend
                      </td>
                    </tr>
                  )
                }

                return (
                  <tr key={date} style={{ opacity: hasData ? 1 : 0.4 }}>
                    <td className="border border-border px-2 py-1.5 text-text-muted text-center">{rowNum}</td>
                    <td className="border border-border px-2 py-1.5 text-text-primary text-center font-semibold">{fmtMD(date)}</td>
                    <td className="border border-border px-2 py-1.5 text-text-secondary text-center">{dayLabel(date)}</td>
                    {COMBOS.map(c => {
                      const cell = dateCells[`${c.line}-${c.shift}`]
                      if (!cell) return (
                        <React.Fragment key={`${date}-${c.line}-${c.shift}-empty`}>
                          <td className="border border-border px-2 py-1.5" style={{ borderLeft: '3px solid #475569' }} />
                          <td className="border border-border px-2 py-1.5" />
                          <td className="border border-border px-2 py-1.5" />
                          <td className="border border-border px-2 py-1.5" />
                          <td className="border border-border px-2 py-1.5" />
                        </React.Fragment>
                      )
                      const isFuture = date > today()
                      const skuData  = cell.skuData ?? []
                      const multiSku = skuData.length > 1
                      const d = delta(cell.target, cell.produced)
                      const p = pct(cell.target, cell.produced)
                      return (
                        <React.Fragment key={`${date}-${c.line}-${c.shift}`}>
                          {/* SKU cell — shows edit button when editMode is on */}
                          <td className="border border-border px-2 py-1.5 text-text-primary" title={cell.skus.join(', ')} style={{ borderLeft: '3px solid #475569' }}>
                            <div className="flex items-center gap-1">
                              <span className="flex-1">
                                {cell.skus.length === 1
                                  ? cell.skus[0]
                                  : cell.skus.map((s, i) => <span key={i} className="block leading-tight">{s}</span>)
                                }
                              </span>
                              {editMode && (
                                <button
                                  onClick={() => setEditCell({ date, line: c.line, shift: c.shift, label: c.label })}
                                  className="shrink-0 rounded p-1 transition-colors hover:bg-indigo-50"
                                  style={{ color: '#4f46e5' }}
                                  title={`Edit logs: ${c.label} · ${fmtMD(date)}`}
                                >
                                  <Pencil size={10} />
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="border border-border px-2 py-1.5 text-right text-text-secondary">
                            {multiSku
                              ? skuData.map((s, i) => <span key={i} className="block leading-tight">{s.target.toLocaleString()}</span>)
                              : cell.target.toLocaleString()
                            }
                          </td>
                          <td className="border border-border px-2 py-1.5 text-right font-bold text-text-primary">
                            {isFuture ? '' : multiSku
                              ? skuData.map((s, i) => <span key={i} className="block leading-tight">{s.produced.toLocaleString()}</span>)
                              : cell.produced.toLocaleString()
                            }
                          </td>
                          <td className="border border-border px-2 py-1.5 text-right font-semibold" style={{ color: isFuture ? undefined : d.color }}>
                            {isFuture ? '' : d.label}
                          </td>
                          <td className="border border-border px-2 py-1.5 text-right font-bold" style={{ color: isFuture ? undefined : p.color }}>
                            {isFuture ? '' : p.label}
                          </td>
                        </React.Fragment>
                      )
                    })}
                  </tr>
                )
              })}

              {/* Totals row */}
              <tr style={{ background: '#0f172a' }}>
                <td colSpan={3} className="border border-border px-3 py-2 text-right font-bold text-white text-[10px] tracking-widest uppercase">
                  Totals
                </td>
                {COMBOS.map(c => {
                  const t = totals[`${c.line}-${c.shift}`]
                  if (!t) return (
                    <React.Fragment key={`tot-${c.line}-${c.shift}-empty`}>
                      {[0,1,2,3,4].map(i => <td key={i} className="border border-border px-2 py-2" style={{ background: '#0f172a', borderLeft: i === 0 ? '3px solid #475569' : undefined }} />)}
                    </React.Fragment>
                  )
                  const d = delta(t.target, t.produced)
                  const p = pct(t.target, t.produced)
                  return (
                    <React.Fragment key={`tot-${c.line}-${c.shift}`}>
                      <td className="border border-border px-2 py-2" style={{ background: '#0f172a', borderLeft: '3px solid #475569' }} />
                      <td className="border border-border px-2 py-2 text-right font-bold text-white">{t.target.toLocaleString()}</td>
                      <td className="border border-border px-2 py-2 text-right font-black" style={{ color: '#fbbf24' }}>{t.produced.toLocaleString()}</td>
                      <td className="border border-border px-2 py-2 text-right font-bold" style={{ color: d.color }}>{d.label}</td>
                      <td className="border border-border px-2 py-2 text-right font-black" style={{ color: p.color }}>{p.label}</td>
                    </React.Fragment>
                  )
                })}
              </tr>
            </tbody>
          </table>
        </div>

        <p className="text-[10px] font-mono mt-3" style={{ color: 'var(--text-muted)' }}>
          % = Actual ÷ Target · Δ = Actual − Target · Green ≥ 100% · Amber ≥ 90% · Red &lt; 90%
        </p>
      </div>

      {/* Edit modal */}
      {editCell && (
        <CellEditModal
          cell={editCell}
          onClose={() => setEditCell(null)}
          onRefresh={fetchReport}
        />
      )}
    </div>
  )
}
