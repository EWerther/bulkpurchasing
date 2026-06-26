'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  AlertTriangle, RefreshCw, Search, Package,
  ChevronUp, ChevronDown, ChevronsUpDown, Truck, CheckSquare,
  Square, ArrowRight, Clock, ShoppingCart, Eye, X, Info, Check,
} from 'lucide-react'
import { SummaryBar } from '@/components/shared/SummaryBar'
import { fmtDate } from '@/lib/utils/dates'

// ── Types ────────────────────────────────────────────────────────────────────

interface FuturePO {
  poId: number
  poNumber: string
  eta: string
  qty: number
  isOverdue: boolean
}

interface ExpediteOption {
  poId: number
  poNumber: string
  currentEta: string
  suggestedEta: string
  qty: number
  daysToExpedite: number
}

interface ConsumptionEvent {
  date: string
  productSku: string
  productName: string
  orderNumber: string
  orderedQty: number
  consumedQty: number
}

interface PurchasingItem {
  itemId: number
  sku: string
  name: string
  category: string
  vendorName: string
  vendorIsDefault: boolean
  leadTimeDays: number
  targetDocDays: number
  forecastWindowDays: number
  onHandQty: number
  qtyOnOrder: number
  overduePoQty: number
  upcomingConsumption: number
  runOutDate: string | null
  alertDate: string | null
  qtyToPurchase: number
  hasSufficientStock: boolean
  futurePOs: FuturePO[]
  expediteOptions: ExpediteOption[]
  consumptionEvents: ConsumptionEvent[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────


function daysFromNow(dateStr: string | null): number | null {
  if (!dateStr) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.round((new Date(dateStr).getTime() - today.getTime()) / 86400000)
}

function alertStatus(item: PurchasingItem): 'order-now' | 'order-soon' | 'expedite-only' | 'ok' {
  if (item.qtyToPurchase > 0) {
    const days = daysFromNow(item.alertDate)
    if (days !== null && days <= 7) return 'order-now'
    return 'order-soon'
  }
  if (item.expediteOptions.length > 0) return 'expedite-only'
  return 'ok'
}

function StatusBadge({ item }: { item: PurchasingItem }) {
  const status = alertStatus(item)
  if (status === 'order-now')
    return <span className="chip text-[10px] bg-danger/10 text-danger border border-danger/30 font-semibold">Order Now</span>
  if (status === 'order-soon')
    return <span className="chip text-[10px] bg-warning/10 text-warning border border-warning/30 font-semibold">Order Soon</span>
  if (status === 'expedite-only')
    return <span className="chip text-[10px] bg-accent/10 text-accent border border-accent/30">Expedite</span>
  return <span className="chip text-[10px] text-success border border-success/30">OK</span>
}

function AlertDateCell({ item }: { item: PurchasingItem }) {
  if (!item.alertDate) return <span className="text-text-secondary opacity-40">—</span>
  const days = daysFromNow(item.alertDate)!
  const color = days <= 0 ? 'text-danger font-bold' : days <= 7 ? 'text-warning font-semibold' : 'text-text-primary'
  return (
    <span className={`font-mono text-xs ${color}`}>
      {fmtDate(item.alertDate)}
      {days <= 0
        ? <span className="ml-1 text-danger text-[10px]">(overdue)</span>
        : days <= 7
          ? <span className="ml-1 text-warning text-[10px]">({days}d)</span>
          : null}
    </span>
  )
}

// ── Forecast Modal ────────────────────────────────────────────────────────────

interface ForecastDay {
  date: string
  isToday: boolean
  incomingPOs: FuturePO[]
  overduePOs: FuturePO[]   // shown on today's row only
  production: ConsumptionEvent[]
  inventoryAfterArrival: number
  endingInventory: number
  missing: number
}

function ForecastModal({ item, onClose }: { item: PurchasingItem; onClose: () => void }) {
  // Day-by-day simulation — mirrors the old Forecast.cshtml logic
  const forecastDays = useMemo<ForecastDay[]>(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const todayStr = today.toISOString().split('T')[0]

    // Group consumption events by date
    const consumptionByDate = new Map<string, ConsumptionEvent[]>()
    for (const ev of item.consumptionEvents) {
      const arr = consumptionByDate.get(ev.date) ?? []
      arr.push(ev)
      consumptionByDate.set(ev.date, arr)
    }

    // Split overdue vs future POs; group future by ETA date
    const overduePOs = item.futurePOs.filter(p => p.isOverdue)
    const nonOverduePOs = item.futurePOs.filter(p => !p.isOverdue)
    const posByDate = new Map<string, FuturePO[]>()
    for (const po of nonOverduePOs) {
      const d = po.eta.split('T')[0]
      const arr = posByDate.get(d) ?? []
      arr.push(po)
      posByDate.set(d, arr)
    }

    // Starting stock = on-hand + overdue POs (overdue treated as arriving day 0)
    let stock = item.onHandQty + item.overduePoQty

    const result: ForecastDay[] = []
    const cur = new Date(today)
    const end = new Date(today)
    end.setDate(end.getDate() + item.forecastWindowDays)

    while (cur <= end) {
      const dateStr = cur.toISOString().split('T')[0]
      const isToday = dateStr === todayStr

      const dayPOs = posByDate.get(dateStr) ?? []
      const dayEvents = consumptionByDate.get(dateStr) ?? []
      const displayOverdue = isToday ? overduePOs : []

      const incomingQty = dayPOs.reduce((s, p) => s + p.qty, 0)
      const consumedQty = dayEvents.reduce((s, e) => s + e.consumedQty, 0)

      const inventoryAfterArrival = stock + incomingQty
      const endingInventory = inventoryAfterArrival - consumedQty
      const missing = endingInventory < 0 ? endingInventory : 0

      // Only include dates with activity (or today), matching old portal filter
      if (isToday || dayPOs.length > 0 || displayOverdue.length > 0 || dayEvents.length > 0) {
        result.push({
          date: dateStr,
          isToday,
          incomingPOs: dayPOs,
          overduePOs: displayOverdue,
          production: dayEvents,
          inventoryAfterArrival,
          endingInventory,
          missing,
        })
      }

      stock = endingInventory
      cur.setDate(cur.getDate() + 1)
    }

    return result
  }, [item])

  const totalIncoming = item.futurePOs.reduce((s, p) => s + p.qty, 0)
  const totalConsumed = forecastDays.reduce((s, d) => s + d.production.reduce((ss, e) => ss + e.consumedQty, 0), 0)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-border rounded-lg shadow-2xl flex flex-col"
        style={{ width: '92vw', maxWidth: 1100, maxHeight: '88vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Modal header ──────────────────────────────────────────────── */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-base font-bold text-accent">{item.sku}</span>
              <span className="text-text-secondary text-sm">{item.name}</span>
              <StatusBadge item={item} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] font-mono text-text-secondary">
              <span>
                Vendor: <span className={item.vendorIsDefault ? 'text-text-primary' : 'text-warning'}>{item.vendorName}</span>
                {!item.vendorIsDefault && <span className="ml-1 text-warning" title="No default vendor set">⚠ not default</span>}
              </span>
              <span>Lead time: <span className="text-text-primary">{item.leadTimeDays}d</span></span>
              <span>Target DOC: <span className="text-text-primary">{item.targetDocDays}d</span></span>
              <span>Window: <span className="text-text-primary">{item.forecastWindowDays}d</span></span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary transition-colors ml-4 shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {/* ── Summary strip ─────────────────────────────────────────────── */}
        <div className="grid grid-cols-5 divide-x divide-border border-b border-border shrink-0">
          {[
            { label: 'On Hand',         value: item.onHandQty.toLocaleString(),              color: '' },
            { label: 'On Order (all)',   value: item.qtyOnOrder.toLocaleString(),             color: 'text-success' },
            { label: `Consumption (${item.forecastWindowDays}d)`, value: item.upcomingConsumption.toLocaleString(), color: 'text-danger' },
            { label: 'Qty to Purchase', value: item.qtyToPurchase > 0 ? item.qtyToPurchase.toLocaleString() : '—', color: item.qtyToPurchase > 0 ? 'text-danger font-bold' : 'text-success' },
            { label: 'Run Out',         value: item.runOutDate ? fmtDate(item.runOutDate) : 'No shortage', color: item.runOutDate ? 'text-danger' : 'text-success' },
          ].map(s => (
            <div key={s.label} className="px-4 py-2.5 text-center">
              <div className="text-[10px] text-text-secondary font-mono uppercase tracking-wider">{s.label}</div>
              <div className={`font-mono text-sm font-semibold mt-0.5 ${s.color || 'text-text-primary'}`}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* ── Day-by-day forecast table ──────────────────────────────────── */}
        <div className="overflow-auto flex-1 px-5 py-4">
          <h4 className="font-mono text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <Info size={11} /> Stock Forecast — {item.forecastWindowDays}-day window
            {item.overduePoQty > 0 && (
              <span className="ml-2 text-warning text-[10px] normal-case font-normal">
                ⚠ {item.overduePoQty.toLocaleString()} units in overdue POs counted in starting inventory
              </span>
            )}
          </h4>

          <table className="data-table w-full text-xs">
            <thead>
              <tr>
                <th>Date</th>
                <th>Incoming Supply POs</th>
                <th className="text-right">Inventory</th>
                <th className="text-right">Qty for Production</th>
                <th className="text-right">Ending Inventory</th>
                <th className="text-right">Missing</th>
              </tr>
            </thead>
            <tbody>
              {forecastDays.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-text-secondary font-mono">
                    No activity in the forecast window
                  </td>
                </tr>
              )}
              {forecastDays.map(day => (
                <tr
                  key={day.date}
                  className={`
                    ${day.missing < 0 ? 'bg-danger/6' : ''}
                    ${day.isToday ? 'bg-accent/4 border-l-2 border-l-accent' : ''}
                  `}
                >
                  {/* Date */}
                  <td className="font-mono whitespace-nowrap">
                    {fmtDate(day.date)}
                    {day.isToday && <span className="ml-1 text-accent text-[10px]">(today)</span>}
                  </td>

                  {/* Incoming POs */}
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {day.overduePOs.map(po => (
                        <span key={`ovr-${po.poId}`} className="inline-flex items-center gap-1">
                          <span className="text-warning font-mono">#{po.poNumber}</span>
                          <span className="text-success font-mono">+{po.qty.toLocaleString()}</span>
                          <span className="text-warning text-[10px]">(overdue)</span>
                        </span>
                      ))}
                      {day.incomingPOs.map(po => (
                        <span key={po.poId} className="inline-flex items-center gap-1">
                          <span className="font-mono text-text-primary">#{po.poNumber}</span>
                          <span className="text-success font-mono">+{po.qty.toLocaleString()}</span>
                        </span>
                      ))}
                    </div>
                  </td>

                  {/* Inventory (after arrivals, before consumption) */}
                  <td className="font-mono text-right">
                    {day.inventoryAfterArrival.toLocaleString()}
                  </td>

                  {/* Qty for Production */}
                  <td className="text-right">
                    {day.production.length > 0 ? (
                      <div>
                        <span className="font-mono text-danger">
                          {day.production.reduce((s, e) => s + e.consumedQty, 0).toLocaleString()}
                        </span>
                        <div className="mt-0.5 space-y-0.5">
                          {day.production.map((ev, i) => (
                            <div key={i} className="text-[10px] text-text-secondary font-mono text-right">
                              #{ev.orderNumber} · {ev.productSku} · {ev.consumedQty.toLocaleString()}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : <span className="text-text-secondary opacity-40">—</span>}
                  </td>

                  {/* Ending inventory */}
                  <td className={`font-mono text-right ${day.endingInventory < 0 ? 'text-danger font-semibold' : 'text-text-primary'}`}>
                    {day.endingInventory.toLocaleString()}
                  </td>

                  {/* Missing */}
                  <td className="font-mono text-right">
                    {day.missing < 0
                      ? <span className="text-danger font-bold">{day.missing.toLocaleString()}</span>
                      : <span className="text-text-secondary opacity-30">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold border-t-2 border-border bg-surface">
                <td className="text-text-secondary">Total</td>
                <td className="font-mono text-success">+{totalIncoming.toLocaleString()}</td>
                <td />
                <td className="font-mono text-right text-danger">{totalConsumed.toLocaleString()}</td>
                <td />
                <td className="font-mono text-right">
                  {item.qtyToPurchase > 0
                    ? <span className="text-danger">Need: {item.qtyToPurchase.toLocaleString()}</span>
                    : <span className="text-success">✓ Covered</span>}
                </td>
              </tr>
            </tfoot>
          </table>

          {/* ── Expedite recommendations ─────────────────────────────────── */}
          {item.expediteOptions.length > 0 && (
            <div className="mt-6">
              <h4 className="font-mono text-xs font-semibold text-warning uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <Clock size={11} /> {item.expediteOptions.length} PO{item.expediteOptions.length !== 1 ? 's' : ''} Require Expediting
              </h4>
              <table className="data-table w-full text-xs">
                <thead>
                  <tr>
                    <th>PO #</th>
                    <th className="text-right">Qty</th>
                    <th>Current ETA</th>
                    <th>Expedite To</th>
                    <th className="text-right">Days Earlier</th>
                  </tr>
                </thead>
                <tbody>
                  {item.expediteOptions.map(opt => (
                    <tr key={opt.poId} className="bg-warning/4">
                      <td>
                        <span className="font-mono text-text-primary">#{opt.poNumber}</span>
                      </td>
                      <td className="font-mono text-right">{opt.qty.toLocaleString()}</td>
                      <td className="font-mono text-danger line-through opacity-70">{fmtDate(opt.currentEta)}</td>
                      <td className="font-mono text-success font-semibold">{fmtDate(opt.suggestedEta)}</td>
                      <td className="font-mono text-right text-warning font-semibold">{opt.daysToExpedite}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Create PO modal types ─────────────────────────────────────────────────────

interface VendorOption {
  vndrId: number
  vndrName: string
  isDefault: boolean
  cost: number | null
  partNumber: string | null
  leadTimeDays: number | null
  minimum: number | null
}

interface POLineState {
  itemId: number
  sku: string
  name: string
  qtyCases: number
  qtyPerCase: number
  vendorId: number
  vendorName: string
  costPerUnit: string   // string so input is freely editable
  partNumber: string
  purchasingName: string
  vendors: VendorOption[]
  itemPartNumber: string | null
}

// ── Create PO Modal ───────────────────────────────────────────────────────────

function CreatePOModal({
  items,
  onClose,
  onSuccess,
}: {
  items: PurchasingItem[]
  onClose: () => void
  onSuccess: (count: number) => void
}) {
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  // Header dates (shared across all POs)
  const today = new Date().toISOString().split('T')[0]
  const [submitDate, setSubmitDate] = useState(today)
  const [eta, setEta] = useState('')
  const [etd, setEtd] = useState('')
  const [readyDate, setReadyDate] = useState('')

  const [lines, setLines] = useState<POLineState[]>([])

  // Fetch vendor options for all selected items
  useEffect(() => {
    const itemIds = items.map(i => i.itemId).join(',')
    fetch(`/api/supply-purchasing/vendor-options?itemIds=${itemIds}`)
      .then(r => r.json())
      .then(json => {
        const opts = json.options ?? {}
        setLines(items.map(item => {
          const entry = opts[item.itemId] ?? { vendors: [], itemPartNumber: null, qtyPerCase: null }
          const vendors: VendorOption[] = entry.vendors
          const defaultVendor = vendors.find(v => v.isDefault) ?? vendors[0] ?? null
          const qtyPerCase: number = (entry.qtyPerCase != null && entry.qtyPerCase > 0) ? entry.qtyPerCase : 1
          const suggestedQty = item.qtyToPurchase > 0 ? item.qtyToPurchase : 1
          const qtyCases = Math.ceil(suggestedQty / qtyPerCase)
          return {
            itemId: item.itemId,
            sku: item.sku,
            name: item.name,
            qtyCases,
            qtyPerCase,
            vendorId: defaultVendor?.vndrId ?? 0,
            vendorName: defaultVendor?.vndrName ?? item.vendorName,
            costPerUnit: defaultVendor?.cost != null ? String(defaultVendor.cost) : '',
            partNumber: defaultVendor?.partNumber ?? entry.itemPartNumber ?? '',
            purchasingName: item.name,
            vendors,
            itemPartNumber: entry.itemPartNumber,
          }
        }))
        setLoading(false)
      })
      .catch(() => { setError('Failed to load vendor options'); setLoading(false) })
  }, [])

  function updateLine(idx: number, patch: Partial<POLineState>) {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l))
  }

  function changeVendor(idx: number, vndrId: number) {
    const line = lines[idx]
    const v = line.vendors.find(x => x.vndrId === vndrId)
    if (!v) return
    updateLine(idx, {
      vendorId: v.vndrId,
      vendorName: v.vndrName,
      costPerUnit: v.cost != null ? String(v.cost) : '',
      partNumber: v.partNumber ?? line.itemPartNumber ?? '',
    })
  }

  // Count distinct vendors (= number of POs that will be created)
  const vendorGroups = useMemo(() => {
    const seen = new Map<number, string>()
    for (const l of lines) if (l.vendorId) seen.set(l.vendorId, l.vendorName)
    return seen
  }, [lines])

  async function handleSubmit() {
    setError('')
    if (!eta) { setError('ETA is required'); return }
    for (const l of lines) {
      if (!l.vendorId) { setError(`No vendor selected for ${l.sku}`); return }
      if (l.qtyCases <= 0) { setError(`Cases must be > 0 for ${l.sku}`); return }
      if (l.qtyPerCase <= 0) { setError(`Units/case must be > 0 for ${l.sku}`); return }
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/supply-purchasing/create-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submitDate: submitDate || null,
          eta,
          etd: etd || null,
          readyDate: readyDate || null,
          lines: lines.map(l => ({
            itemId: l.itemId,
            vendorId: l.vendorId,
            vendorName: l.vendorName,
            qtyCases: l.qtyCases,
            qtyPerCase: l.qtyPerCase,
            costPerUnit: l.costPerUnit !== '' ? parseFloat(l.costPerUnit) : null,
            partNumber: l.partNumber || null,
            purchasingName: l.purchasingName || null,
          })),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Server error')
      setSuccess(true)
      setTimeout(() => { onSuccess(json.count); onClose() }, 1200)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-lg shadow-2xl flex flex-col"
        style={{ width: '96vw', maxWidth: 1200, maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <ShoppingCart size={15} className="text-accent" />
            <span className="font-mono text-sm font-bold text-text-primary tracking-wide">Create Supply PO</span>
            <span className="chip text-[10px] bg-accent/10 text-accent border border-accent/30">
              {items.length} SKU{items.length !== 1 ? 's' : ''} · {vendorGroups.size} PO{vendorGroups.size !== 1 ? 's' : ''}
            </span>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Date fields */}
        <div className="px-5 py-3 border-b border-border bg-surface/60 shrink-0">
          <p className="text-[10px] font-mono text-text-secondary uppercase tracking-wider mb-2">Dates — applied to all POs</p>
          <div className="flex flex-wrap gap-4">
            {[
              { label: 'Submit Date', val: submitDate, set: setSubmitDate, required: false },
              { label: 'ETA *',       val: eta,        set: setEta,        required: true  },
              { label: 'ETD',         val: etd,        set: setEtd,        required: false },
              { label: 'Ready Date',  val: readyDate,  set: setReadyDate,  required: false },
            ].map(f => (
              <label key={f.label} className="flex flex-col gap-1">
                <span className="text-[10px] font-mono text-text-secondary">{f.label}</span>
                <input
                  type="date"
                  value={f.val}
                  onChange={e => f.set(e.target.value)}
                  className={`bg-bg border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent ${f.required && !f.val ? 'border-danger' : 'border-border'}`}
                  style={{ width: 140 }}
                />
              </label>
            ))}
          </div>
        </div>

        {/* Lines table */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-text-secondary font-mono text-sm gap-2">
              <RefreshCw size={14} className="animate-spin" /> Loading vendor options…
            </div>
          ) : (
            <table className="data-table w-full text-xs">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Vendor</th>
                  <th>Purchasing Name</th>
                  <th className="text-right">Cases</th>
                  <th className="text-right">Units/Case</th>
                  <th className="text-right">Cost / Unit</th>
                  <th>Part #</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr key={line.itemId} className="table-row-comfortable">
                    <td className="font-mono font-semibold text-accent whitespace-nowrap">{line.sku}</td>

                    {/* Vendor dropdown */}
                    <td>
                      {line.vendors.length === 0 ? (
                        <span className="text-warning text-[10px]">No vendors in VNIT</span>
                      ) : (
                        <select
                          value={line.vendorId}
                          onChange={e => changeVendor(idx, Number(e.target.value))}
                          className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent w-full"
                          style={{ minWidth: 180 }}
                        >
                          {line.vendors.map(v => (
                            <option key={v.vndrId} value={v.vndrId}>
                              {v.vndrName}{v.isDefault ? ' ★' : ''}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>

                    {/* Purchasing Name */}
                    <td>
                      <input
                        type="text"
                        value={line.purchasingName}
                        onChange={e => updateLine(idx, { purchasingName: e.target.value })}
                        className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                        style={{ width: 200 }}
                      />
                    </td>

                    {/* Cases */}
                    <td className="text-right">
                      <input
                        type="number"
                        min={1}
                        value={line.qtyCases}
                        onChange={e => updateLine(idx, { qtyCases: Math.max(1, parseInt(e.target.value) || 1) })}
                        className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-right text-text-primary focus:outline-none focus:border-accent"
                        style={{ width: 70 }}
                      />
                    </td>

                    {/* Units per case */}
                    <td className="text-right">
                      <input
                        type="number"
                        min={1}
                        value={line.qtyPerCase}
                        onChange={e => updateLine(idx, { qtyPerCase: Math.max(1, parseInt(e.target.value) || 1) })}
                        className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-right text-text-primary focus:outline-none focus:border-accent"
                        style={{ width: 70 }}
                      />
                    </td>

                    {/* Cost */}
                    <td className="text-right">
                      <input
                        type="number"
                        step="0.01"
                        min={0}
                        value={line.costPerUnit}
                        onChange={e => updateLine(idx, { costPerUnit: e.target.value })}
                        placeholder="—"
                        className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-right text-text-primary focus:outline-none focus:border-accent"
                        style={{ width: 90 }}
                      />
                    </td>

                    {/* Part # */}
                    <td>
                      <input
                        type="text"
                        value={line.partNumber}
                        onChange={e => updateLine(idx, { partNumber: e.target.value })}
                        placeholder="—"
                        className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                        style={{ width: 130 }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex items-center gap-3 shrink-0">
          {error && (
            <span className="flex items-center gap-1.5 text-xs text-danger font-mono">
              <AlertTriangle size={12} /> {error}
            </span>
          )}
          {success && (
            <span className="flex items-center gap-1.5 text-xs text-success font-mono">
              <Check size={12} /> POs created successfully
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onClose} className="btn-secondary text-xs px-3 py-1.5">Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={submitting || loading || success}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded text-xs font-semibold bg-accent text-white border border-accent/80 hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting
                ? <><RefreshCw size={11} className="animate-spin" /> Creating…</>
                : <><ShoppingCart size={11} /> Create {vendorGroups.size} PO{vendorGroups.size !== 1 ? 's' : ''}</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Sort column type ──────────────────────────────────────────────────────────
type SortCol = 'sku' | 'category' | 'onHandQty' | 'qtyOnOrder' | 'upcomingConsumption' | 'alertDate' | 'runOutDate' | 'qtyToPurchase'

// ── Main page ────────────────────────────────────────────────────────────────

export default function SupplyPurchasingPage() {
  const [data, setData] = useState<PurchasingItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Filters
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string[]>([])
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(true)

  // Sorting
  const [sortCol, setSortCol] = useState<SortCol>('alertDate')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  // Selection (for future PO generation)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  // Forecast modal
  const [modalItem, setModalItem] = useState<PurchasingItem | null>(null)

  // Create PO modal
  const [showCreatePO, setShowCreatePO] = useState(false)

  // Expedite panel — which SKU is focused
  const [focusedSku, setFocusedSku] = useState<string | null>(null)

  async function load() {
    setLoading(true); setError('')
    setSelected(new Set()); setModalItem(null)
    try {
      const res = await fetch('/api/supply-purchasing/data')
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      const json = await res.json()
      setData(json.items ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  // ── Derived data ────────────────────────────────────────────────────────
  const categories = useMemo(() => Array.from(new Set(data.map(i => i.category))).sort(), [data])

  const filtered = useMemo(() => {
    let list = data
    if (needsAttentionOnly) list = list.filter(i => !i.hasSufficientStock || i.expediteOptions.length > 0)
    if (categoryFilter.length > 0) list = list.filter(i => categoryFilter.includes(i.category))
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(i => i.sku.toLowerCase().includes(q) || i.name.toLowerCase().includes(q))
    }
    return [...list].sort((a, b) => {
      let av: any, bv: any
      if (sortCol === 'alertDate' || sortCol === 'runOutDate') {
        av = a[sortCol] ? new Date(a[sortCol]!).getTime() : 99999999999
        bv = b[sortCol] ? new Date(b[sortCol]!).getTime() : 99999999999
      } else {
        av = a[sortCol] ?? ''
        bv = b[sortCol] ?? ''
      }
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv : String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [data, needsAttentionOnly, categoryFilter, search, sortCol, sortDir])

  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  // Selection helpers
  const allFilteredIds = filtered.map(i => i.itemId)
  const allSelected = allFilteredIds.length > 0 && allFilteredIds.every(id => selected.has(id))
  const someSelected = allFilteredIds.some(id => selected.has(id)) && !allSelected

  function toggleAll() {
    if (allSelected) {
      setSelected(s => { const n = new Set(s); allFilteredIds.forEach(id => n.delete(id)); return n })
    } else {
      setSelected(s => { const n = new Set(s); allFilteredIds.forEach(id => n.add(id)); return n })
    }
  }

  function toggleItem(id: number) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  // ── Expedite panel data ─────────────────────────────────────────────────
  const allExpediteOptions = useMemo(() => {
    const out: (ExpediteOption & { sku: string; name: string })[] = []
    for (const item of filtered) {
      for (const opt of item.expediteOptions) {
        out.push({ ...opt, sku: item.sku, name: item.name })
      }
    }
    return out.sort((a, b) => new Date(a.suggestedEta).getTime() - new Date(b.suggestedEta).getTime())
  }, [filtered])

  const expediteVisible = focusedSku
    ? allExpediteOptions.filter(e => e.sku === focusedSku)
    : allExpediteOptions

  // ── Summary counts ──────────────────────────────────────────────────────
  const needOrderCount = data.filter(i => i.qtyToPurchase > 0).length
  const expediteCount  = data.filter(i => i.expediteOptions.length > 0).length
  const okCount        = data.filter(i => i.hasSufficientStock && i.expediteOptions.length === 0).length

  // ── Sort header helper ──────────────────────────────────────────────────
  function SortTh({ col, label, right }: { col: SortCol; label: string; right?: boolean }) {
    return (
      <th
        className={`cursor-pointer select-none hover:text-text-primary transition-colors whitespace-nowrap ${right ? 'text-right' : ''}`}
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

  function rowBg(item: PurchasingItem) {
    const status = alertStatus(item)
    if (status === 'order-now') return 'bg-danger/4'
    if (status === 'order-soon') return 'bg-warning/4'
    return ''
  }

  return (
    <div className="flex flex-col h-full">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="bg-surface border-b border-border px-4 py-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Truck size={16} className="text-accent" />
          <div>
            <h1 className="font-mono text-sm font-bold tracking-widest uppercase text-text-primary">Supply Purchasing</h1>
            <p className="text-[11px] text-text-secondary font-mono">What to order, when, and how much — based on upcoming production demand</p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {/* Category filter */}
          <div className="flex flex-wrap gap-1">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(f => f.includes(cat) ? f.filter(c => c !== cat) : [...f, cat])}
                className={`chip text-xs border transition-colors ${categoryFilter.includes(cat) ? 'border-accent text-accent bg-accent/10' : 'border-border text-text-secondary hover:border-accent/50'}`}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Needs attention toggle */}
          <button
            onClick={() => setNeedsAttentionOnly(v => !v)}
            className={`chip text-xs border transition-colors ${needsAttentionOnly ? 'border-warning text-warning bg-warning/10' : 'border-border text-text-secondary'}`}
          >
            {needsAttentionOnly ? 'Needs Attention' : 'All Items'}
          </button>

          {/* Search */}
          <div className="relative">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search SKU or name…"
              className="bg-bg border border-border rounded pl-6 pr-3 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent w-48"
            />
          </div>

          <button onClick={load} disabled={loading} className="btn-secondary text-xs flex items-center gap-1.5">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      <SummaryBar stats={[
        { label: 'Total Tracked',    value: data.length },
        { label: 'Need to Order',    value: needOrderCount,  color: needOrderCount  > 0 ? 'danger'  : 'default' },
        { label: 'Expedite Actions', value: expediteCount,   color: expediteCount   > 0 ? 'warning' : 'default' },
        { label: 'Sufficient Stock', value: okCount,         color: 'success' },
        { label: 'Showing',          value: filtered.length },
      ]} />

      {error && (
        <div className="mx-4 my-2 bg-danger/10 border border-danger/30 rounded px-3 py-2 text-xs text-danger font-mono flex items-center gap-2">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      {loading && (
        <div className="flex-1 flex items-center justify-center text-text-secondary font-mono text-sm gap-3">
          <RefreshCw size={16} className="animate-spin" /> Calculating purchasing requirements…
        </div>
      )}

      {!loading && (
        <div className="flex-1 flex gap-0 overflow-hidden">

          {/* ── Left: main table ──────────────────────────────────────────── */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 32 }}>
                      <button onClick={toggleAll} className="text-text-secondary hover:text-text-primary transition-colors">
                        {allSelected
                          ? <CheckSquare size={13} className="text-accent" />
                          : someSelected
                            ? <CheckSquare size={13} className="text-text-secondary" />
                            : <Square size={13} />}
                      </button>
                    </th>
                    <th style={{ width: 28 }} title="View day-by-day forecast" />
                    <SortTh col="sku"                 label="SKU" />
                    <th>Name</th>
                    <SortTh col="category"            label="Category" />
                    <th>Vendor</th>
                    <SortTh col="onHandQty"           label="On-Hand"     right />
                    <SortTh col="qtyOnOrder"          label="On Order"    right />
                    <SortTh col="upcomingConsumption" label="Consumption" right />
                    <SortTh col="alertDate"           label="Order By" />
                    <SortTh col="runOutDate"          label="Run Out" />
                    <SortTh col="qtyToPurchase"       label="Qty to Buy"  right />
                    <th>Status</th>
                    <th style={{ width: 48 }}>Links</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={14} className="text-center py-12 text-text-secondary font-mono text-sm">
                        {data.length === 0 ? 'No data — click Refresh to load' : 'No items match your filters'}
                      </td>
                    </tr>
                  )}
                  {filtered.map(item => {
                    const isSel     = selected.has(item.itemId)
                    const isFocused = focusedSku === item.sku
                    return (
                      <tr
                        key={item.itemId}
                        className={`table-row-comfortable cursor-pointer transition-colors ${rowBg(item)} ${isFocused ? 'ring-1 ring-inset ring-accent/40' : ''} ${isSel ? 'bg-accent/6' : ''}`}
                        onClick={() => setFocusedSku(f => f === item.sku ? null : item.sku)}
                      >
                        {/* Checkbox */}
                        <td onClick={e => { e.stopPropagation(); toggleItem(item.itemId) }} className="cursor-pointer">
                          {isSel
                            ? <CheckSquare size={13} className="text-accent" />
                            : <Square size={13} className="text-text-secondary opacity-40 hover:opacity-100 transition-opacity" />}
                        </td>

                        {/* Eye — opens forecast modal */}
                        <td
                          onClick={e => { e.stopPropagation(); setModalItem(item) }}
                          className="cursor-pointer"
                          title="View day-by-day stock forecast"
                        >
                          <Eye size={13} className="text-text-secondary opacity-50 hover:opacity-100 hover:text-accent transition-all" />
                        </td>

                        {/* SKU */}
                        <td className="font-mono text-xs font-semibold text-accent">{item.sku}</td>

                        {/* Name */}
                        <td className="text-xs text-text-secondary max-w-[180px] truncate" title={item.name}>{item.name}</td>

                        {/* Category */}
                        <td>
                          <span className="chip text-[10px] border border-border text-text-secondary">{item.category}</span>
                        </td>

                        {/* Vendor */}
                        <td className="text-xs whitespace-nowrap">
                          <span className={item.vendorIsDefault ? 'text-text-secondary' : 'text-warning'}>
                            {item.vendorName}
                          </span>
                          {!item.vendorIsDefault && (
                            <span
                              className="ml-1 text-[9px] text-warning opacity-70"
                              title="No default vendor set — using an arbitrary vendor's lead time &amp; DOC"
                            >⚠</span>
                          )}
                        </td>

                        {/* On-Hand */}
                        <td className="font-mono text-right text-xs">{item.onHandQty.toLocaleString()}</td>

                        {/* On Order */}
                        <td className="font-mono text-right text-xs">
                          {item.qtyOnOrder > 0
                            ? (
                              <span className="text-success">
                                {item.qtyOnOrder.toLocaleString()}
                                {item.overduePoQty > 0 && (
                                  <span className="ml-1 text-warning text-[10px]" title={`${item.overduePoQty.toLocaleString()} units in overdue POs`}>⚠</span>
                                )}
                              </span>
                            )
                            : <span className="opacity-40">—</span>}
                        </td>

                        {/* Upcoming Consumption */}
                        <td className="font-mono text-right text-xs">
                          {item.upcomingConsumption > 0
                            ? item.upcomingConsumption.toLocaleString()
                            : <span className="opacity-40">—</span>}
                        </td>

                        {/* Alert Date */}
                        <td><AlertDateCell item={item} /></td>

                        {/* Run Out Date */}
                        <td>
                          {item.runOutDate
                            ? <span className={`font-mono text-xs ${daysFromNow(item.runOutDate)! <= 30 ? 'text-danger font-semibold' : 'text-text-secondary'}`}>
                                {fmtDate(item.runOutDate)}
                              </span>
                            : <span className="text-success text-xs opacity-60">No shortage</span>}
                        </td>

                        {/* Qty to Purchase */}
                        <td className="font-mono text-right">
                          {item.qtyToPurchase > 0
                            ? <span className="text-danger font-bold text-sm">{item.qtyToPurchase.toLocaleString()}</span>
                            : <span className="text-success text-xs opacity-60">—</span>}
                        </td>

                        {/* Status */}
                        <td><StatusBadge item={item} /></td>

                        {/* Links */}
                        <td>
                          <a
                            href={`/supply?sku=${encodeURIComponent(item.sku)}`}
                            title="View in Supply Intelligence"
                            onClick={e => e.stopPropagation()}
                            className="text-text-secondary hover:text-accent transition-colors"
                          >
                            <Package size={12} />
                          </a>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* ── Selection action bar ──────────────────────────────────── */}
            {selected.size > 0 && (
              <div className="border-t border-border bg-surface px-4 py-2.5 flex items-center gap-3">
                <span className="text-xs font-mono text-text-secondary">
                  <span className="text-accent font-semibold">{selected.size}</span> item{selected.size !== 1 ? 's' : ''} selected
                  {' · '}
                  {Array.from(selected).reduce((s, id) => {
                    const item = data.find(i => i.itemId === id)
                    return s + (item?.qtyToPurchase ?? 0)
                  }, 0).toLocaleString()} total units to purchase
                </span>
                <button
                  className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-accent/10 text-accent border border-accent/30 hover:bg-accent/20 transition-colors"
                  onClick={() => setShowCreatePO(true)}
                >
                  <ShoppingCart size={12} /> Create PO for {selected.size} SKU{selected.size !== 1 ? 's' : ''}
                </button>
                <button
                  className="text-xs text-text-secondary hover:text-text-primary transition-colors"
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </button>
              </div>
            )}
          </div>

          {/* ── Right: expedite panel ─────────────────────────────────────── */}
          <div className="w-80 shrink-0 border-l border-border flex flex-col overflow-hidden bg-surface/50">
            <div className="px-3 py-2.5 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock size={13} className="text-warning" />
                <span className="font-mono text-xs font-semibold text-text-primary">Expedite Actions</span>
                {expediteVisible.length > 0 && (
                  <span className="chip text-[10px] bg-warning/10 text-warning border border-warning/30">
                    {expediteVisible.length}
                  </span>
                )}
              </div>
              {focusedSku && (
                <button
                  className="text-[10px] font-mono text-text-secondary hover:text-text-primary transition-colors"
                  onClick={() => setFocusedSku(null)}
                >
                  Show all ×
                </button>
              )}
            </div>

            {focusedSku && (
              <div className="px-3 py-1.5 bg-accent/5 border-b border-border">
                <span className="text-[10px] font-mono text-accent">Filtered: {focusedSku}</span>
              </div>
            )}

            <div className="flex-1 overflow-auto">
              {expediteVisible.length === 0 ? (
                <div className="p-4 text-center text-xs text-text-secondary font-mono">
                  {allExpediteOptions.length === 0
                    ? 'No expedite actions needed'
                    : 'No expedite actions for this SKU'}
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {expediteVisible.map((opt, i) => (
                    <div key={i} className="px-3 py-2.5 hover:bg-white/5 transition-colors">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono text-xs font-semibold text-text-primary">
                          #{opt.poNumber}
                        </span>
                        <span className="chip text-[10px] bg-warning/10 text-warning border border-warning/30">
                          -{opt.daysToExpedite}d
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-text-secondary mb-1.5">{opt.sku}</div>
                      <div className="flex items-center gap-2 text-[10px] font-mono">
                        <span className="text-danger line-through opacity-60">{fmtDate(opt.currentEta)}</span>
                        <ArrowRight size={9} className="text-text-secondary" />
                        <span className="text-success font-semibold">{fmtDate(opt.suggestedEta)}</span>
                      </div>
                      <div className="text-[10px] font-mono text-text-secondary mt-0.5">
                        Qty: {opt.qty.toLocaleString()} units
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {!focusedSku && allExpediteOptions.length > 0 && (
              <div className="px-3 py-2 border-t border-border">
                <p className="text-[10px] text-text-secondary font-mono">Click any row to filter by SKU</p>
              </div>
            )}
          </div>

        </div>
      )}

      {/* ── Forecast modal ──────────────────────────────────────────────── */}
      {modalItem && <ForecastModal item={modalItem} onClose={() => setModalItem(null)} />}

      {/* ── Create PO modal ─────────────────────────────────────────────── */}
      {showCreatePO && (
        <CreatePOModal
          items={data.filter(i => selected.has(i.itemId))}
          onClose={() => setShowCreatePO(false)}
          onSuccess={(count) => {
            setSelected(new Set())
            setShowCreatePO(false)
          }}
        />
      )}

    </div>
  )
}
