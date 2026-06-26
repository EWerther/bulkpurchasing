'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronDown, ChevronRight, Search, AlertTriangle, CheckCircle2, Plus, Trash2, Send, RefreshCw } from 'lucide-react'
import { fmtDate } from '@/lib/utils/dates'

interface Order {
  whoiId: number
  whodId: number
  orderNumber: string
  company: string
  sku: string
  itemId: number
  productName: string
  category: string
  readyByDate: string
  orderedQty: number
  lineStatus: 'Open' | 'Received'
}

interface SessionBreakdown {
  sessionDate: string
  lineNumber: number
  shiftNumber: number
  targetQty: number
  producedQty: number
  status: string
}

interface Assignment {
  whoiId: number
  whodId: number
  orderNumber: string
  sku: string
  productName: string
  lineNumber: number
  shiftNumber: number
  targetQty: number
}

export default function FactoryAssignPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [assignedTotals, setAssignedTotals] = useState<Record<number, number>>({})
  const [sessionBreakdowns, setSessionBreakdowns] = useState<Record<number, SessionBreakdown[]>>({})
  const [expandedOrders, setExpandedOrders] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [fromDate, setFromDate] = useState(() => new Date().toISOString().split('T')[0])
  const [throughDate, setThroughDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 14)
    return d.toISOString().split('T')[0]
  })
  const [sessionDate, setSessionDate] = useState(() => new Date().toISOString().split('T')[0])
  const [search, setSearch] = useState('')

  // Assignments being built
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)

  // Inline assignment form state per order (whoiId → {line, shift, qty})
  const [assignForm, setAssignForm] = useState<Record<number, { line: number; shift: number; qty: string }>>({})

  const [submitting, setSubmitting] = useState(false)

  async function fetchOrders() {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ fromDate, throughDate })
      const res = await fetch(`/api/factory/orders?${params}`)
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      const json = await res.json()
      setOrders(json.orders ?? [])
      setAssignedTotals(json.assignedTotals ?? {})
      setSessionBreakdowns(json.sessionBreakdowns ?? {})
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const loadSessionsForDate = useCallback(async (date: string) => {
    setSessionsLoading(true)
    setSessionsLoaded(false)
    try {
      const res = await fetch(`/api/factory/today?date=${date}`)
      if (!res.ok) return
      const json = await res.json()
      const sessions: Array<{
        whoiId: number; whodId: number; orderNumber: string
        sku: string; productName: string; lineNumber: number
        shiftNumber: number; targetQty: number
      }> = json.sessions ?? []
      if (sessions.length > 0) {
        setAssignments(sessions.map(s => ({
          whoiId: s.whoiId,
          whodId: s.whodId,
          orderNumber: s.orderNumber,
          sku: s.sku,
          productName: s.productName,
          lineNumber: s.lineNumber,
          shiftNumber: s.shiftNumber,
          targetQty: s.targetQty,
        })))
      } else {
        setAssignments([])
      }
      setSessionsLoaded(true)
    } catch {
      // Non-fatal — user can still assign manually
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  useEffect(() => { fetchOrders() }, []) // eslint-disable-line
  useEffect(() => { loadSessionsForDate(sessionDate) }, [sessionDate, loadSessionsForDate])

  const filteredOrders = useMemo(() => {
    const q = search.toLowerCase()
    if (!q) return orders
    return orders.filter(o =>
      o.sku.toLowerCase().includes(q) ||
      o.productName.toLowerCase().includes(q) ||
      o.orderNumber.toLowerCase().includes(q) ||
      o.company.toLowerCase().includes(q)
    )
  }, [orders, search])

  const assignedWhoiIds = new Set(assignments.map(a => a.whoiId))

  function openForm(order: Order) {
    if (assignForm[order.whoiId]) {
      setAssignForm(f => { const n = { ...f }; delete n[order.whoiId]; return n })
    } else {
      const alreadyAssigned = assignedTotals[order.whoiId] ?? 0
      const remaining = Math.max(1, order.orderedQty - alreadyAssigned)
      setAssignForm(f => ({
        ...f,
        [order.whoiId]: { line: 1, shift: 1, qty: String(remaining) },
      }))
    }
  }

  function addAssignment(order: Order) {
    const form = assignForm[order.whoiId]
    if (!form) return
    const qty = parseInt(form.qty, 10)
    if (!qty || qty <= 0) return
    setAssignments(prev => [
      ...prev.filter(a => !(a.whoiId === order.whoiId && a.lineNumber === form.line && a.shiftNumber === form.shift)),
      {
        whoiId: order.whoiId,
        whodId: order.whodId,
        orderNumber: order.orderNumber,
        sku: order.sku,
        productName: order.productName,
        lineNumber: form.line,
        shiftNumber: form.shift,
        targetQty: qty,
      },
    ])
    setAssignForm(f => { const n = { ...f }; delete n[order.whoiId]; return n })
  }

  async function removeAssignment(whoiId: number, lineNumber: number, shiftNumber: number) {
    // Remove from local state immediately
    setAssignments(prev => prev.filter(
      a => !(a.whoiId === whoiId && a.lineNumber === lineNumber && a.shiftNumber === shiftNumber)
    ))
    // Also delete from DB if it was already published
    try {
      await fetch('/api/factory/assign', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionDate, whoiId, lineNumber, shiftNumber }),
      })
    } catch {}
  }

  async function publishAssignments() {
    if (assignments.length === 0) return
    setSubmitting(true)
    setError('')
    setSuccess('')
    try {
      const res = await fetch('/api/factory/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionDate, assignments }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Server error')
      setSuccess(`${json.count} session${json.count !== 1 ? 's' : ''} published to the floor for ${fmtDate(sessionDate)}.`)
      // Reload plan from DB — source of truth
      await loadSessionsForDate(sessionDate)
      // Refresh status chips
      fetch(`/api/factory/orders?${new URLSearchParams({ fromDate, throughDate })}`)
        .then(r => r.json())
        .then(j => {
          setAssignedTotals(j.assignedTotals ?? {})
          setSessionBreakdowns(j.sessionBreakdowns ?? {})
        })
        .catch(() => {})
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const SHIFT_LABELS = ['', 'Shift 1 (6am–2pm)', 'Shift 2 (2pm–10pm)']

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-surface border-b border-border px-4 py-3">
        <div className="flex items-center gap-3 mb-3">
          <Link href="/factory" className="text-xs text-accent hover:underline font-mono flex items-center gap-1">
            <ChevronLeft size={12} /> Floor Dashboard
          </Link>
          <span className="text-xs text-text-secondary font-mono">·</span>
          <h1 className="font-mono text-sm font-bold tracking-widest uppercase text-text-primary">
            Assign Orders to Lines & Shifts
          </h1>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          {/* Date range for orders */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-text-secondary font-mono whitespace-nowrap">Orders from:</label>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent" />
            <label className="text-xs text-text-secondary font-mono">to:</label>
            <input type="date" value={throughDate} onChange={e => setThroughDate(e.target.value)}
              className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent" />
            <button onClick={fetchOrders} disabled={loading} className="btn-secondary text-xs">
              {loading ? 'Loading…' : 'Fetch Orders'}
            </button>
          </div>

          {/* Session date */}
          <div className="flex items-center gap-2 ml-auto">
            <label className="text-xs font-semibold text-text-secondary font-mono whitespace-nowrap">Publishing for date:</label>
            <input type="date" value={sessionDate} onChange={e => setSessionDate(e.target.value)}
              className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent" />
          </div>
        </div>

        {/* Search */}
        <div className="relative mt-3">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by SKU, product, WO#, company…"
            className="bg-bg border border-border rounded pl-7 pr-3 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent w-72"
          />
        </div>
      </div>

      {/* Errors / success */}
      {error && (
        <div className="mx-4 my-2 bg-danger/10 border border-danger/30 rounded px-3 py-2 text-xs text-danger font-mono flex items-center gap-2">
          <AlertTriangle size={12} /> {error}
        </div>
      )}
      {success && (
        <div className="mx-4 my-2 bg-success/10 border border-success/30 rounded px-3 py-2 text-xs text-success font-mono flex items-center gap-2">
          <CheckCircle2 size={12} /> {success}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left: Order list */}
        <div className="flex-1 overflow-auto p-4">
          <div className="card">
            <div className="px-4 py-2 border-b border-border flex items-center gap-2">
              <span className="section-header">Open Production Orders</span>
              <span className="text-xs text-text-secondary font-mono">({filteredOrders.length} of {orders.length})</span>
            </div>

            {filteredOrders.length === 0 && !loading && (
              <div className="py-12 text-center text-text-secondary font-mono text-sm">
                No open production orders found for selected date range
              </div>
            )}

            {filteredOrders.length > 0 && (
              <table className="data-table text-xs w-full">
                <thead>
                  <tr>
                    <th>WO #</th>
                    <th>Company</th>
                    <th>SKU</th>
                    <th>Product</th>
                    <th>Ready By</th>
                    <th className="text-right">Order Qty</th>
                    <th>Status</th>
                    <th>Assign</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.map(order => {
                    const form = assignForm[order.whoiId]
                    const isAssigned = assignedWhoiIds.has(order.whoiId)
                    const orderAssignments = assignments.filter(a => a.whoiId === order.whoiId)
                    const alreadyAssigned = assignedTotals[order.whoiId] ?? 0
                    const remaining = order.orderedQty - alreadyAssigned
                    const isPartial = alreadyAssigned > 0 && remaining > 0
                    const isFullyAssigned = alreadyAssigned >= order.orderedQty
                    const breakdown = sessionBreakdowns[order.whoiId] ?? []
                    const isExpanded = expandedOrders.has(order.whoiId)
                    const toggleExpand = () => setExpandedOrders(prev => {
                      const next = new Set(prev)
                      next.has(order.whoiId) ? next.delete(order.whoiId) : next.add(order.whoiId)
                      return next
                    })
                    return (
                      <>
                        <tr
                          key={order.whoiId}
                          className={`table-row-comfortable ${isAssigned ? 'bg-success/5' : ''}`}
                        >
                          <td className="font-mono font-semibold">{order.orderNumber}</td>
                          <td className="text-text-secondary">{order.company}</td>
                          <td className="font-mono font-semibold">{order.sku}</td>
                          <td className="text-text-secondary">{order.productName}</td>
                          <td className="font-mono">{fmtDate(order.readyByDate)}</td>
                          <td className="font-mono text-right">{order.orderedQty.toLocaleString()}</td>
                          <td>
                            <div className="flex items-center gap-1.5">
                              {isFullyAssigned ? (
                                <span className="chip text-[10px] text-success border border-success/30 bg-success/10">Assigned</span>
                              ) : isPartial ? (
                                <span className="chip text-[10px] text-warning border border-warning/30 bg-warning/10">{remaining.toLocaleString()} remaining</span>
                              ) : isAssigned ? (
                                <span className="chip text-[10px] text-success border border-success/30 bg-success/10">Assigned</span>
                              ) : (
                                <span className="chip text-[10px] text-text-secondary border border-border">Open</span>
                              )}
                              {breakdown.length > 0 && (
                                <button
                                  onClick={toggleExpand}
                                  title="View assignment breakdown"
                                  className="text-text-secondary hover:text-accent transition-colors"
                                >
                                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                </button>
                              )}
                            </div>
                          </td>
                          <td>
                            <button
                              onClick={() => openForm(order)}
                              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold transition-colors ${
                                form
                                  ? 'bg-accent/10 text-accent border border-accent/30'
                                  : 'bg-bg text-text-secondary border border-border hover:border-accent/50 hover:text-accent'
                              }`}
                            >
                              <Plus size={10} /> {form ? 'Cancel' : 'Assign'}
                            </button>
                          </td>
                        </tr>

                        {/* Existing assignments for this order */}
                        {orderAssignments.map(a => (
                          <tr key={`assign-${a.whoiId}-${a.lineNumber}-${a.shiftNumber}`} style={{ background: 'rgba(34,197,94,0.04)' }}>
                            <td colSpan={6} />
                            <td colSpan={2}>
                              <div className="flex items-center gap-2 py-1">
                                <span className="chip text-[10px] font-mono border border-success/30 text-success bg-success/8">
                                  Line {a.lineNumber} · {SHIFT_LABELS[a.shiftNumber]} · {a.targetQty.toLocaleString()} units
                                </span>
                                <button
                                  onClick={() => removeAssignment(a.whoiId, a.lineNumber, a.shiftNumber)}
                                  className="text-danger hover:text-danger/80 transition-colors"
                                  title="Remove assignment"
                                >
                                  <Trash2 size={11} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}

                        {/* Breakdown of all sessions for this order */}
                        {isExpanded && breakdown.length > 0 && (
                          <tr key={`breakdown-${order.whoiId}`} style={{ background: 'rgba(79,70,229,0.03)' }}>
                            <td colSpan={8} className="px-6 py-3">
                              <p className="text-[10px] font-bold uppercase tracking-widest text-text-secondary mb-2">Assignment Breakdown</p>
                              <table className="w-full text-[10px] font-mono border-collapse">
                                <thead>
                                  <tr className="text-text-secondary">
                                    <th className="text-left pb-1 pr-4 font-semibold">Date</th>
                                    <th className="text-left pb-1 pr-4 font-semibold">Line</th>
                                    <th className="text-left pb-1 pr-4 font-semibold">Shift</th>
                                    <th className="text-right pb-1 pr-4 font-semibold">Target</th>
                                    <th className="text-right pb-1 pr-4 font-semibold">Produced</th>
                                    <th className="text-left pb-1 font-semibold">Status</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {breakdown.map((row, i) => (
                                    <tr key={i} className="border-t border-border/40">
                                      <td className="py-1 pr-4">{fmtDate(row.sessionDate)}</td>
                                      <td className="py-1 pr-4">Line {row.lineNumber}</td>
                                      <td className="py-1 pr-4">Shift {row.shiftNumber}</td>
                                      <td className="py-1 pr-4 text-right">{row.targetQty.toLocaleString()}</td>
                                      <td className="py-1 pr-4 text-right">{row.producedQty.toLocaleString()}</td>
                                      <td className="py-1">
                                        <span className={`chip text-[9px] ${
                                          row.status === 'complete' ? 'text-success border-success/30 bg-success/10' :
                                          row.status === 'active'   ? 'text-accent border-accent/30 bg-accent/10' :
                                          'text-text-secondary border-border'
                                        }`}>
                                          {row.status}
                                        </span>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}

                        {/* Inline assignment form */}
                        {form && (
                          <tr key={`form-${order.whoiId}`} style={{ background: 'rgba(79,70,229,0.04)' }}>
                            <td colSpan={8} className="px-4 py-3">
                              <div className="flex items-center gap-3 flex-wrap">
                                <div className="flex items-center gap-2">
                                  <label className="text-xs text-text-secondary font-mono">Line:</label>
                                  <select
                                    value={form.line}
                                    onChange={e => setAssignForm(f => ({ ...f, [order.whoiId]: { ...f[order.whoiId], line: Number(e.target.value) } }))}
                                    className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                                  >
                                    <option value={1}>Line 1</option>
                                    <option value={2}>Line 2</option>
                                  </select>
                                </div>
                                <div className="flex items-center gap-2">
                                  <label className="text-xs text-text-secondary font-mono">Shift:</label>
                                  <select
                                    value={form.shift}
                                    onChange={e => setAssignForm(f => ({ ...f, [order.whoiId]: { ...f[order.whoiId], shift: Number(e.target.value) } }))}
                                    className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                                  >
                                    <option value={1}>Shift 1 (6am–2pm)</option>
                                    <option value={2}>Shift 2 (2pm–10pm)</option>
                                  </select>
                                </div>
                                <div className="flex items-center gap-2">
                                  <label className="text-xs text-text-secondary font-mono">Target qty:</label>
                                  <input
                                    type="number"
                                    min="1"
                                    max={order.orderedQty}
                                    value={form.qty}
                                    onChange={e => setAssignForm(f => ({ ...f, [order.whoiId]: { ...f[order.whoiId], qty: e.target.value } }))}
                                    className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent w-24"
                                  />
                                  <span className="text-xs text-text-secondary font-mono">
                                    {alreadyAssigned > 0
                                      ? `of ${order.orderedQty.toLocaleString()} (${alreadyAssigned.toLocaleString()} already assigned)`
                                      : `of ${order.orderedQty.toLocaleString()}`}
                                  </span>
                                </div>
                                <button
                                  onClick={() => addAssignment(order)}
                                  disabled={!form.qty || parseInt(form.qty) <= 0}
                                  className="btn-primary text-xs flex items-center gap-1"
                                >
                                  <Plus size={10} /> Add to Plan
                                </button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right: Assignment summary / publish */}
        <div className="w-80 shrink-0 border-l border-border p-4 overflow-auto" style={{ background: 'var(--surface)' }}>
          <div className="section-header mb-3">
            Assignment Plan — {fmtDate(sessionDate)}
          </div>

          {sessionsLoading && (
            <div className="flex items-center gap-2 py-2 text-xs text-text-secondary font-mono">
              <RefreshCw size={11} className="animate-spin" /> Loading existing sessions…
            </div>
          )}

          {!sessionsLoading && sessionsLoaded && assignments.length > 0 && (
            <div className="mb-2 text-[10px] text-success font-mono flex items-center gap-1">
              <CheckCircle2 size={10} /> Loaded from DB — editing existing plan
            </div>
          )}

          {assignments.length === 0 && !sessionsLoading ? (
            <p className="text-xs text-text-secondary font-mono py-4">
              No assignments yet. Click "Assign" on any order to build the day's plan.
            </p>
          ) : (
            <div className="space-y-2 mb-4">
              {[1, 2].map(line => {
                const lineAssignments = assignments.filter(a => a.lineNumber === line)
                if (lineAssignments.length === 0) return null
                return (
                  <div key={line} className="card p-3 space-y-2">
                    <p className="text-xs font-bold text-text-primary">Line {line}</p>
                    {[1, 2].map(shift => {
                      const shiftItems = lineAssignments.filter(a => a.shiftNumber === shift)
                      if (shiftItems.length === 0) return null
                      return (
                        <div key={shift} className="space-y-1">
                          <p className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
                            {SHIFT_LABELS[shift]}
                          </p>
                          {shiftItems.map(a => (
                            <div key={`${a.whoiId}-${a.lineNumber}-${a.shiftNumber}`}
                              className="flex items-center justify-between gap-2 text-xs">
                              <div className="min-w-0">
                                <span className="font-mono font-semibold text-text-primary">{a.sku}</span>
                                <span className="text-text-secondary ml-1">·</span>
                                <span className="text-text-secondary ml-1">{a.targetQty.toLocaleString()} units</span>
                              </div>
                              <button
                                onClick={() => removeAssignment(a.whoiId, a.lineNumber, a.shiftNumber)}
                                className="shrink-0 text-danger hover:text-danger/80"
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          )}

          <div className="space-y-2">
            <div className="rounded-lg p-2 text-xs text-text-secondary font-mono" style={{ background: 'var(--bg)' }}>
              <p className="font-semibold text-text-primary mb-1">⚠ Note:</p>
              <p>Publishing adds/updates sessions for this date. Use the trash icon to remove an assignment. Workers see changes immediately.</p>
            </div>

            <button
              onClick={publishAssignments}
              disabled={assignments.length === 0 || submitting}
              className="w-full btn-primary flex items-center justify-center gap-2 py-3"
            >
              <Send size={13} />
              {submitting ? 'Publishing…' : `Publish ${assignments.length} Session${assignments.length !== 1 ? 's' : ''} to Floor`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
