'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, AlertTriangle, Zap } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { SummaryBar } from '@/components/shared/SummaryBar'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { SupplyLink } from '@/components/shared/SupplyLink'
import { InventoryLink } from '@/components/shared/InventoryLink'
import { fmtDate } from '@/lib/utils/dates'

interface IngredientDetail {
  supplyItemId: number
  supplySKU: string
  supplyName: string
  supplyCategory: string
  qtyPerUnit: number
  qtyNeeded: number
  qtyAvailable: number
  shortage: number
  canOrderInTime: boolean
  leadTimeDays: number
  daysUntilETA: number
  isSubstituted: boolean
  substituteSKU?: string
  substituteQtyUsed: number
  substituteStillShort: number
}

interface OrderResult {
  orderId: number
  orderNumber: string
  company: string
  sku: string
  productName: string
  readyByDate: string
  orderedQty: number
  canProduceQty: number
  status: 'Full' | 'Partial' | 'None' | 'NoRecipe'
  requiresNewSupplyPO: boolean
  usesSubstitute: boolean
  limitingComponent?: IngredientDetail
  ingredientDetails: IngredientDetail[]
  optimizerWarnings: any[]
}

interface DayGroup {
  date: string
  items: OrderResult[]
  fullCount: number
  partialCount: number
  noneCount: number
  isToday: boolean
}

function OrderRow({ order }: { order: OrderResult }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <tr className="table-row-comfortable cursor-pointer" onClick={() => setExpanded(e => !e)}>
        <td className="w-4">
          {expanded ? <ChevronDown size={12} className="text-text-secondary" /> : <ChevronRight size={12} className="text-text-secondary" />}
        </td>
        <td className="font-mono text-xs text-text-secondary">{order.company}</td>
        <td className="font-mono text-xs font-semibold">
          <InventoryLink sku={order.sku} company={order.company} name={order.productName} />
        </td>
        <td className="text-xs">{order.productName}</td>
        <td className="font-mono text-xs">{order.orderNumber}</td>
        <td className="font-mono text-right">{order.orderedQty.toLocaleString()}</td>
        <td className="font-mono text-right">{order.canProduceQty.toLocaleString()}</td>
        <td><StatusBadge status={order.status} /></td>
        <td>
          <div className="flex items-center gap-1">
            {order.usesSubstitute && <StatusBadge status="Via Sub" />}
            {order.requiresNewSupplyPO && <StatusBadge status="Via New PO" />}
          </div>
        </td>
        <td>
          {order.limitingComponent && (
            <SupplyLink sku={order.limitingComponent.supplySKU} name={order.limitingComponent.supplyName} />
          )}
        </td>
        <td>
          {order.optimizerWarnings.length > 0 && (
            <span title="Optimizer warning"><Zap size={12} className="text-warning" /></span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={11} className="px-4 pb-3 bg-bg/50">
            <table className="data-table text-xs mt-2">
              <thead>
                <tr>
                  <th>Supply SKU</th>
                  <th>Supply Name</th>
                  <th>Qty/Unit</th>
                  <th>Qty Needed</th>
                  <th>Qty Available</th>
                  <th>Shortage</th>
                  <th>Lead Time</th>
                  <th>Days Until ETA</th>
                </tr>
              </thead>
              <tbody>
                {order.ingredientDetails.map(d => {
                  const rowColor = d.shortage > 0 && !d.isSubstituted
                    ? 'bg-danger/5'
                    : d.isSubstituted ? 'bg-warning/5' : ''
                  return (
                    <tr key={d.supplyItemId} className={rowColor}>
                      <td><SupplyLink sku={d.supplySKU} name={d.supplyName} /></td>
                      <td className="text-text-secondary">{d.supplyName}</td>
                      <td className="font-mono text-right">{d.qtyPerUnit}</td>
                      <td className="font-mono text-right">{d.qtyNeeded.toLocaleString()}</td>
                      <td className={`font-mono text-right ${d.qtyAvailable < d.qtyNeeded ? 'text-danger' : 'text-success'}`}>
                        {d.qtyAvailable.toLocaleString()}
                      </td>
                      <td className={`font-mono text-right ${d.shortage > 0 ? 'text-danger' : 'text-success'}`}>
                        {d.shortage > 0 ? `-${d.shortage.toLocaleString()}` : '—'}
                      </td>
                      <td className="font-mono text-right">{d.leadTimeDays}d</td>
                      <td className="font-mono text-right">{d.daysUntilETA}d</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  )
}

export default function OrderFeasibilityPage() {
  const [throughDate, setThroughDate] = useState(() => {
    const d = new Date()
    d.setMonth(d.getMonth() + 1)
    return d.toISOString().split('T')[0]
  })
  const [data, setData] = useState<{ days: DayGroup[]; summary: any; optimizerWarnings: any[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())
  const [deductionMode, setDeductionMode] = useState<'ordered' | 'producible'>('ordered')

  async function runCheck() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/order-feasibility/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ throughDate, deductionMode }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      const json = await res.json()
      setData(json)
      // Open all days by default
      setOpenDays(new Set(json.days.map((d: DayGroup) => d.date)))
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const toggleDay = (date: string) => {
    setOpenDays(s => {
      const n = new Set(s)
      n.has(date) ? n.delete(date) : n.add(date)
      return n
    })
  }

  const todayKey = new Date().toISOString().split('T')[0]

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Order Feasibility"
        showCompanyToggle={false}
        onRun={runCheck}
        runLabel="Check Feasibility"
        loading={loading}
        fields={[{
          id: 'throughDate',
          label: 'Show Through Date',
          type: 'date',
          value: throughDate,
          onChange: setThroughDate,
        }]}
      />
      {/* Supply deduction mode toggle */}
      <div className="px-4 py-2 border-b border-border bg-surface flex items-center gap-3 flex-wrap">
        <span className="text-xs font-mono text-text-secondary">Supply deduction mode:</span>
        <div className="flex rounded border border-border overflow-hidden text-xs font-mono">
          <button
            onClick={() => setDeductionMode('ordered')}
            className={`px-3 py-1.5 transition-colors ${deductionMode === 'ordered' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
          >
            Full Order
          </button>
          <button
            onClick={() => setDeductionMode('producible')}
            className={`px-3 py-1.5 transition-colors ${deductionMode === 'producible' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
          >
            Realistic (producible only)
          </button>
        </div>
        <span className="text-[10px] text-text-secondary font-mono">
          {deductionMode === 'ordered'
            ? 'Deducts full ordered qty from supply — conservative, good for procurement planning'
            : 'Only deducts supply for units that can actually be produced — accurate for production sequencing'}
        </span>
        {data && (
          <span className="ml-auto text-[10px] text-warning font-mono">
            ⟳ Change mode and re-run to update results
          </span>
        )}
      </div>

      {data && (
        <SummaryBar stats={[
          { label: 'Total Checked', value: data.summary.totalChecked },
          { label: 'Full', value: data.summary.fullCount, color: 'success' },
          { label: 'Partial', value: data.summary.partialCount, color: 'warning' },
          { label: 'Not Feasible', value: data.summary.noneCount, color: 'danger' },
          { label: 'No Recipe', value: data.summary.noRecipeCount, color: 'default' },
          { label: 'Warnings', value: data.optimizerWarnings.length, color: data.optimizerWarnings.length > 0 ? 'warning' : 'default' },
        ]} />
      )}

      {error && (
        <div className="mx-4 my-2 bg-danger/10 border border-danger/30 rounded px-3 py-2 text-xs text-danger font-mono flex items-center gap-2">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      {!data && !loading && (
        <div className="flex-1 flex items-center justify-center text-text-secondary font-mono text-sm">
          Set a date range and click Check Feasibility
        </div>
      )}

      {data && (
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {data.days.map(day => {
            const isOpen = openDays.has(day.date)
            const dateLabel = fmtDate(day.date, { weekday: 'long', month: 'short', day: 'numeric' })
            const isToday = day.date.startsWith(todayKey)
            const headerColor =
              day.noneCount > 0 ? 'border-l-danger' :
              day.partialCount > 0 ? 'border-l-warning' :
              'border-l-success'

            const totalUnits = day.items.reduce((s, o) => s + o.orderedQty, 0)

            return (
              <div key={day.date} className={`card border-l-2 ${headerColor}`}>
                <button
                  onClick={() => toggleDay(day.date)}
                  className="w-full flex items-center justify-between px-4 py-2.5 border-b border-border hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    {isOpen ? <ChevronDown size={14} className="text-text-secondary" /> : <ChevronRight size={14} className="text-text-secondary" />}
                    <span className="font-mono font-semibold text-sm text-text-primary">
                      {dateLabel}
                      {isToday && <span className="ml-2 text-xs text-accent">(Today)</span>}
                    </span>
                    <span className="font-mono text-xs font-semibold text-accent bg-accent/10 border border-accent/30 rounded px-2.5 py-0.5">
                      {totalUnits.toLocaleString()} units
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs font-mono">
                    {day.fullCount > 0 && <span className="text-success">{day.fullCount} Full</span>}
                    {day.partialCount > 0 && <span className="text-warning">{day.partialCount} Partial</span>}
                    {day.noneCount > 0 && <span className="text-danger">{day.noneCount} Not Feasible</span>}
                  </div>
                </button>

                {isOpen && (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th style={{ width: 20 }}></th>
                        <th>Company</th>
                        <th>SKU</th>
                        <th>Product</th>
                        <th>Order #</th>
                        <th>Ordered Qty</th>
                        <th>Can Produce</th>
                        <th>Status</th>
                        <th>Flags</th>
                        <th>Limiting Component</th>
                        <th style={{ width: 24 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {day.items.map(order => (
                        <OrderRow key={`${order.orderId}-${order.sku}`} order={order} />
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}

          {/* Optimizer Warnings */}
          {data.optimizerWarnings.length > 0 && (
            <div className="card p-4">
              <div className="section-header flex items-center gap-2">
                <Zap size={12} className="text-warning" />
                Optimizer Warnings ({data.optimizerWarnings.length})
              </div>
              <div className="space-y-2 mt-2">
                {data.optimizerWarnings.map((w: any, i: number) => (
                  <div key={i} className="bg-warning/10 border border-warning/30 rounded p-3">
                    <div className="text-xs text-warning font-mono mb-1">{w.type}</div>
                    <p className="text-xs text-text-secondary">{w.message}</p>
                    <p className="text-xs text-text-secondary mt-1 italic">{w.recommendedAction}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-xs text-text-secondary">Supply:</span>
                      <SupplyLink sku={w.supplySKU} />
                      <span className="text-xs text-danger font-mono">At risk: {w.qtyAtRisk.toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
