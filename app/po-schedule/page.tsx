'use client'

import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { AlertTriangle, Zap, Plus, Pencil, Trash2, CalendarClock } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { SummaryBar } from '@/components/shared/SummaryBar'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { FilterableGrid, Column } from '@/components/shared/FilterableGrid'
import { SupplyLink } from '@/components/shared/SupplyLink'
import { config } from '@/lib/config'
import { fmtDate } from '@/lib/utils/dates'

const WRITE_ACTIONS_ENABLED = false // pulled from env via config server-side, toggled via API response

function DisabledTooltip({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative group inline-block">
      {children}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 whitespace-nowrap bg-surface border border-border rounded px-2 py-1 text-xs font-mono text-text-secondary invisible group-hover:visible z-50">
        Write actions not yet enabled
      </div>
    </div>
  )
}

function ActionButton({ label, icon: Icon, onClick, variant = 'secondary', disabled = false }: any) {
  const btn = (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`flex items-center gap-1 text-xs px-2 py-1 rounded font-mono transition-colors
        ${disabled ? 'opacity-40 cursor-not-allowed' : ''}
        ${variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : 'btn-secondary'}
      `}
    >
      <Icon size={11} />
      {label}
    </button>
  )
  return disabled ? <DisabledTooltip>{btn}</DisabledTooltip> : btn
}

export default function POSchedulePage() {
  const searchParams = useSearchParams()
  const urlSku     = searchParams.get('sku') ?? ''
  const urlCompany = (searchParams.get('company') ?? '') as 'FTX' | 'SBYL' | ''
  const autoRan    = useRef(false)

  const [company, setCompany] = useState<'FTX' | 'SBYL'>(urlCompany === 'SBYL' ? 'SBYL' : 'FTX')
  const [cutoffDate, setCutoffDate] = useState(() => {
    const d = new Date()
    d.setMonth(d.getMonth() + 4)
    return d.toISOString().split('T')[0]
  })
  const [minDOC, setMinDOC] = useState(15)
  const [maxDOC, setMaxDOC] = useState(70)
  const [etaThreshold, setEtaThreshold] = useState(2)
  const [qtyThreshold, setQtyThreshold] = useState(10)
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState(0)
  const [writeEnabled, setWriteEnabled] = useState(false)
  const [confirmAction, setConfirmAction] = useState<any>(null)

  // Auto-run when arriving from a deep link (e.g. from Supply Intelligence)
  useEffect(() => {
    if (urlSku && !autoRan.current) {
      autoRan.current = true
      runPipeline()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runPipeline() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/po-schedule/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company, cutoffDate, minDOC, maxDOC, etaDiffThresholdDays: etaThreshold, qtyDiffThresholdPct: qtyThreshold }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      const json = await res.json()
      setData(json)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function executeAction(endpoint: string, body: object) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, company }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error ?? 'Action failed')
    }
    runPipeline()
  }

  const createActions = data?.createActions ?? []
  const updateActions = data?.updateActions ?? []
  const excessActions = data?.excessActions ?? []
  const notFeasibleItems = data?.notFeasibleItems ?? []
  const newProductItems = data?.newProductItems ?? []
  const optimizerWarnings = data?.optimizerWarnings ?? []
  const generatedLines = data?.generatedLines ?? []
  const summary = data?.summary

  const createCols: Column<any>[] = [
    { key: 'sku', header: 'SKU', getValue: r => r.sku, render: r => <span className="font-mono text-xs font-semibold">{r.sku}</span> },
    { key: 'productName', header: 'Item Name', getValue: r => r.productName },
    { key: 'recommendedETA', header: 'Recommended Arrival', getValue: r => fmtDate(r.recommendedETA), render: r => <span className="font-mono text-xs">{fmtDate(r.recommendedETA)}</span> },
    { key: 'recommendedQty', header: 'Recommended Qty', getValue: r => r.recommendedQty ?? 0, render: r => <span className="font-mono text-right block">{(r.recommendedQty ?? 0).toLocaleString()}</span> },
    { key: 'reason', header: 'Reason', getValue: r => r.reason },
    { key: 'currentInventory', header: 'Inventory', getValue: r => r.currentInventory, render: r => <span className="font-mono text-right block">{r.currentInventory.toLocaleString()}</span> },
    { key: 'currentDOC', header: 'DOC', getValue: r => r.currentDOC, render: r => <span className="font-mono text-right block">{isFinite(r.currentDOC) ? r.currentDOC.toFixed(1) : '∞'}</span> },
    { key: 'ads', header: 'ADS', getValue: r => r.ads, render: r => <span className="font-mono text-right block">{r.ads.toFixed(1)}</span> },
    { key: 'action', header: '', sortable: false, filterable: false, render: r => (
      <ActionButton label="Create PO" icon={Plus} variant="primary" disabled={!writeEnabled}
        onClick={() => setConfirmAction({ label: `Create PO for ${r.sku} — Qty ${r.recommendedQty}`, fn: () => executeAction('/api/po-schedule/create-po', { itemId: r.itemId, arrivalDate: r.recommendedETA, qty: r.recommendedQty }) })}
      />
    )},
  ]

  const updateCols: Column<any>[] = [
    { key: 'sku', header: 'SKU', getValue: r => r.sku, render: r => <span className="font-mono text-xs font-semibold">{r.sku}</span> },
    { key: 'poNumber', header: 'PO #', getValue: r => r.poNumber ?? '', render: r => <span className="font-mono text-xs">{r.poNumber}</span> },
    { key: 'actionType', header: 'Change', getValue: r => r.actionType, render: r => <StatusBadge status={r.actionType === 'UpdateETA' ? 'Push Off' : r.actionType === 'UpdateQty' ? 'Rush' : 'On Track'} /> },
    { key: 'currentETA', header: 'Current ETA', getValue: r => fmtDate(r.currentETA), render: r => <span className="font-mono text-xs">{fmtDate(r.currentETA)}</span> },
    { key: 'recommendedETA', header: 'Rec. ETA', getValue: r => fmtDate(r.recommendedETA), render: r => <span className="font-mono text-xs text-accent">{fmtDate(r.recommendedETA)}</span> },
    { key: 'currentQty', header: 'Curr Qty', getValue: r => r.currentQty ?? 0, render: r => <span className="font-mono text-right block">{(r.currentQty ?? 0).toLocaleString()}</span> },
    { key: 'recommendedQty', header: 'Rec. Qty', getValue: r => r.recommendedQty ?? 0, render: r => <span className="font-mono text-right block text-accent">{(r.recommendedQty ?? 0).toLocaleString()}</span> },
    { key: 'reason', header: 'Reason', getValue: r => r.reason },
    { key: 'currentInventory', header: 'Inv', getValue: r => r.currentInventory, render: r => <span className="font-mono text-right block">{r.currentInventory.toLocaleString()}</span> },
    { key: 'action', header: '', sortable: false, filterable: false, render: r => (
      <ActionButton label="Apply" icon={Pencil} disabled={!writeEnabled}
        onClick={() => setConfirmAction({ label: `Update PO ${r.poNumber}`, fn: () => executeAction('/api/po-schedule/apply-update', { poId: r.poId, poItemId: r.poItemId, newEta: r.recommendedETA, newQty: r.recommendedQty }) })}
      />
    )},
  ]

  const excessCols: Column<any>[] = [
    { key: 'sku', header: 'SKU', getValue: r => r.sku, render: r => <span className="font-mono text-xs font-semibold">{r.sku}</span> },
    { key: 'poNumber', header: 'PO #', getValue: r => r.poNumber ?? '', render: r => <span className="font-mono text-xs">{r.poNumber}</span> },
    { key: 'currentETA', header: 'Current ETA', getValue: r => fmtDate(r.currentETA), render: r => <span className="font-mono text-xs">{fmtDate(r.currentETA)}</span> },
    { key: 'currentQty', header: 'Qty', getValue: r => r.currentQty ?? 0, render: r => <span className="font-mono text-right block">{(r.currentQty ?? 0).toLocaleString()}</span> },
    { key: 'reason', header: 'Reason', getValue: r => r.reason },
    { key: 'currentInventory', header: 'Inv', getValue: r => r.currentInventory, render: r => <span className="font-mono text-right block">{r.currentInventory.toLocaleString()}</span> },
    { key: 'action', header: '', sortable: false, filterable: false, render: r => (
      <div className="flex gap-1">
        <ActionButton label="Push ETA" icon={CalendarClock} disabled={!writeEnabled}
          onClick={() => setConfirmAction({ label: `Push ETA for PO ${r.poNumber}`, fn: () => executeAction('/api/po-schedule/push-eta', { poId: r.poId, newEta: r.recommendedETA }) })}
        />
        <ActionButton label="Delete" icon={Trash2} variant="danger" disabled={!writeEnabled}
          onClick={() => setConfirmAction({ label: `Delete PO ${r.poNumber}?`, fn: () => executeAction('/api/po-schedule/delete-po', { poId: r.poId, poItemId: r.poItemId }) })}
        />
      </div>
    )},
  ]

  const TABS = [
    { label: `PO Actions (${createActions.length + updateActions.length + excessActions.length})` },
    { label: `Not Feasible (${notFeasibleItems.length})` },
    { label: `New Products (${newProductItems.length})` },
    { label: `Full Schedule (${generatedLines.length})` },
    { label: `Optimizer Warnings (${optimizerWarnings.length})` },
  ]

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="PO Schedule"
        company={company}
        onCompanyChange={setCompany}
        onRun={runPipeline}
        runLabel="Run"
        loading={loading}
        fields={[
          { id: 'cutoff', label: 'Cutoff Date', type: 'date', value: cutoffDate, onChange: setCutoffDate },
          { id: 'minDoc', label: 'Min DOC', type: 'number', value: minDOC, onChange: setMinDOC, min: 1, max: 365 },
          { id: 'maxDoc', label: 'Max DOC', type: 'number', value: maxDOC, onChange: setMaxDOC, min: 1, max: 365 },
          { id: 'etaThreshold', label: 'ETA Diff (days)', type: 'number', value: etaThreshold, onChange: setEtaThreshold, min: 0 },
          { id: 'qtyThreshold', label: 'Qty Diff (%)', type: 'number', value: qtyThreshold, onChange: setQtyThreshold, min: 0 },
        ]}
      />

      {data && (
        <SummaryBar stats={[
          { label: 'Generated', value: summary?.totalGenerated ?? 0 },
          { label: 'Create', value: createActions.length, color: createActions.length > 0 ? 'accent' : 'default' },
          { label: 'Update', value: updateActions.length, color: updateActions.length > 0 ? 'warning' : 'default' },
          { label: 'Excess', value: excessActions.length, color: excessActions.length > 0 ? 'warning' : 'default' },
          { label: 'New Products', value: newProductItems.length },
          { label: 'Warnings', value: optimizerWarnings.length, color: optimizerWarnings.length > 0 ? 'warning' : 'default' },
        ]} />
      )}

      {error && (
        <div className="mx-4 my-2 bg-danger/10 border border-danger/30 rounded px-3 py-2 text-xs text-danger font-mono flex items-center gap-2">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      {!data && !loading && (
        <div className="flex-1 flex items-center justify-center text-text-secondary font-mono text-sm">
          Select a company and click Run
        </div>
      )}

      {data && (
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Tabs */}
          <div className="flex border-b border-border px-4 bg-surface">
            {TABS.map((tab, i) => (
              <button
                key={i}
                onClick={() => setActiveTab(i)}
                className={`px-4 py-2 text-xs font-mono border-b-2 transition-colors whitespace-nowrap
                  ${activeTab === i
                    ? 'border-accent text-accent'
                    : 'border-transparent text-text-secondary hover:text-text-primary'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-4">
            {/* Tab 0: PO Actions */}
            {activeTab === 0 && (
              <div className="space-y-6">
                {createActions.length > 0 && (
                  <div>
                    <div className="section-header text-success mb-2">Create ({createActions.length})</div>
                    <FilterableGrid columns={createCols} data={createActions} rowKey={r => `${r.sku}-${r.recommendedETA}`} initialFilter={urlSku ? { sku: urlSku } : undefined} />
                  </div>
                )}
                {updateActions.length > 0 && (
                  <div>
                    <div className="section-header text-warning mb-2">Update ({updateActions.length})</div>
                    <FilterableGrid columns={updateCols} data={updateActions} rowKey={r => `${r.poId}-${r.poItemId}`} initialFilter={urlSku ? { sku: urlSku } : undefined} />
                  </div>
                )}
                {excessActions.length > 0 && (
                  <div>
                    <div className="section-header text-text-secondary mb-2">Excess ({excessActions.length})</div>
                    <FilterableGrid columns={excessCols} data={excessActions} rowKey={r => `${r.poId}-${r.poItemId}`} />
                  </div>
                )}
                {createActions.length === 0 && updateActions.length === 0 && excessActions.length === 0 && (
                  <div className="text-center text-text-secondary font-mono text-sm py-16">All POs are on track</div>
                )}
              </div>
            )}

            {/* Tab 1: Not Feasible */}
            {activeTab === 1 && (
              <div className="card">
                {notFeasibleItems.length === 0 ? (
                  <div className="text-center text-text-secondary font-mono text-sm py-16">All items are feasible</div>
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th>Product</th>
                        <th>Arrival Date</th>
                        <th>Sched Qty</th>
                        <th>Ordered Qty</th>
                        <th>Shortage On</th>
                      </tr>
                    </thead>
                    <tbody>
                      {notFeasibleItems.map((item: any, i: number) => (
                        <tr key={i} className="table-row-comfortable"
                          style={{ borderLeft: `3px solid hsl(${(item.shortageGroupKey.length * 37) % 360}, 60%, 50%)` }}>
                          <td className="font-mono text-xs font-semibold">{item.sku}</td>
                          <td className="text-xs">{item.productName}</td>
                          <td className="font-mono text-xs">{fmtDate(item.arrivalDate)}</td>
                          <td className="font-mono text-right">{item.scheduledQty.toLocaleString()}</td>
                          <td className="font-mono text-right">{item.orderedQty.toLocaleString()}</td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {item.ingredientDetails.filter((d: any) => d.shortage > 0).map((d: any) => (
                                <SupplyLink key={d.supplyItemId} sku={d.supplySKU} name={d.supplyName} />
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* Tab 2: New Products */}
            {activeTab === 2 && (
              <div className="card">
                {newProductItems.length === 0 ? (
                  <div className="text-center text-text-secondary font-mono text-sm py-16">No new products</div>
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th>Open PO Lines</th>
                        <th>ETAs</th>
                        <th>Total Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {newProductItems.map((item: any) => (
                        <tr key={item.sku} className="table-row-comfortable">
                          <td className="font-mono text-xs font-semibold">
                            {item.sku} <StatusBadge status="New Product" />
                          </td>
                          <td className="font-mono text-xs">{item.openPOLines.length}</td>
                          <td className="text-xs">
                            {item.openPOLines.map((p: any) => fmtDate(p.eta)).join(', ')}
                          </td>
                          <td className="font-mono text-right">
                            {item.openPOLines.reduce((s: number, p: any) => s + p.qty, 0).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* Tab 3: Full Generated Schedule */}
            {activeTab === 3 && (
              <div className="card">
                {generatedLines.length === 0 ? (
                  <div className="text-center text-text-secondary font-mono text-sm py-16">No schedule generated</div>
                ) : (
                  <FilterableGrid
                    columns={[
                      { key: 'sku', header: 'SKU', getValue: r => r.sku, render: r => <span className="font-mono text-xs font-semibold">{r.sku}</span> },
                      { key: 'productName', header: 'Item Name', getValue: r => r.productName },
                      { key: 'arrivalDate', header: 'Arrival Date', getValue: r => fmtDate(r.arrivalDate), render: r => <span className="font-mono text-xs">{fmtDate(r.arrivalDate)}</span> },
                      { key: 'orderedQty', header: 'Qty', getValue: r => r.orderedQty, render: r => <span className="font-mono text-right block">{r.orderedQty.toLocaleString()}</span> },
                      { key: 'ads', header: 'ADS', getValue: r => r.ads, render: r => <span className="font-mono text-right block">{r.ads.toFixed(1)}</span> },
                      { key: 'projectedDOCAtTrigger', header: 'DOC at Trigger', getValue: r => r.projectedDOCAtTrigger, render: r => <span className="font-mono text-right block">{r.projectedDOCAtTrigger.toFixed(1)}</span> },
                      { key: 'currentInventory', header: 'Curr Inv', getValue: r => r.currentInventory, render: r => <span className="font-mono text-right block">{r.currentInventory.toLocaleString()}</span> },
                    ] as Column<any>[]}
                    data={generatedLines}
                    rowKey={(r: any) => `${r.sku}-${r.arrivalDate}`}
                  />
                )}
              </div>
            )}

            {/* Tab 4: Optimizer Warnings */}
            {activeTab === 4 && (
              <div className="space-y-2">
                {optimizerWarnings.length === 0 ? (
                  <div className="text-center text-text-secondary font-mono text-sm py-16">No optimizer warnings</div>
                ) : (
                  optimizerWarnings.map((w: any, i: number) => (
                    <div key={i} className="bg-warning/10 border border-warning/30 rounded p-4">
                      <div className="flex items-center gap-2 mb-1">
                        <Zap size={12} className="text-warning" />
                        <span className="text-xs font-mono text-warning uppercase tracking-wider">{w.type}</span>
                      </div>
                      <p className="text-xs text-text-secondary mb-2">{w.message}</p>
                      <p className="text-xs text-text-secondary italic mb-2">{w.recommendedAction}</p>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-secondary">Supply:</span>
                        <SupplyLink sku={w.supplySKU} />
                        <span className="text-xs text-danger font-mono">At risk: {w.qtyAtRisk.toLocaleString()}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confirm dialog */}
      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setConfirmAction(null)} />
          <div className="relative card p-6 w-80 space-y-4">
            <div className="font-mono font-semibold text-text-primary">{confirmAction.label}</div>
            <p className="text-xs text-text-secondary">Are you sure?</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmAction(null)} className="btn-secondary">Cancel</button>
              <button onClick={() => { confirmAction.fn(); setConfirmAction(null) }} className="btn-primary">Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
