'use client'

import { useState, useEffect } from 'react'
import { X, Zap, RotateCcw } from 'lucide-react'
import { StatusBadge } from './StatusBadge'
import { SupplyLink } from './SupplyLink'

interface ConflictingItem {
  demandId: string
  sku: string
  productName: string
  company: string
  sourceRef: string
  priorityScore: number
  isNewProduct: boolean
  requestedQty: number
  allocatedQty: number
}

interface SupplyPool {
  supplyItemId: number
  supplySKU: string
  supplyName: string
  totalAvailable: number
  qtyPerUnitA: number
  qtyPerUnitB: number
}

interface Props {
  date: string
  items: ConflictingItem[]
  supplyPools: SupplyPool[]
  optimizerWarning?: string
  onConfirm: (allocations: Record<string, number>) => void
  onClose: () => void
}

export function ConflictResolutionPanel({ date, items, supplyPools, optimizerWarning, onConfirm, onClose }: Props) {
  const [qtys, setQtys] = useState<Record<string, number>>(
    Object.fromEntries(items.map(i => [i.demandId, i.allocatedQty]))
  )

  const setQty = (demandId: string, qty: number) => {
    setQtys(prev => ({ ...prev, [demandId]: Math.max(0, qty) }))
  }

  const resetToOptimizer = () => {
    setQtys(Object.fromEntries(items.map(i => [i.demandId, i.allocatedQty])))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-[520px] h-full bg-surface border-l border-border overflow-y-auto flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border sticky top-0 bg-surface z-10">
          <div>
            <div className="font-mono text-xs text-text-secondary uppercase tracking-widest">Supply Conflict</div>
            <div className="font-mono text-sm font-semibold text-text-primary">{date}</div>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 p-5 space-y-6">
          {/* Supply Pools */}
          {supplyPools.map(pool => {
            const totalUsed = items.reduce((s, item) => {
              const q = qtys[item.demandId] ?? 0
              const qpu = item === items[0] ? pool.qtyPerUnitA : pool.qtyPerUnitB
              return s + q * qpu
            }, 0)
            const remaining = pool.totalAvailable - totalUsed
            const pct = pool.totalAvailable > 0 ? (totalUsed / pool.totalAvailable) * 100 : 0

            return (
              <div key={pool.supplyItemId} className="card p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-mono text-xs text-text-secondary uppercase tracking-wider">Contested Supply</div>
                    <SupplyLink sku={pool.supplySKU} name={pool.supplyName} />
                    <div className="text-xs text-text-secondary">{pool.supplyName}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-xs text-text-secondary">Available</div>
                    <div className="font-mono font-semibold">{pool.totalAvailable.toLocaleString()}</div>
                  </div>
                </div>
                <div className="h-3 bg-bg rounded-full overflow-hidden flex">
                  {items.map((item, idx) => {
                    const q = qtys[item.demandId] ?? 0
                    const qpu = idx === 0 ? pool.qtyPerUnitA : pool.qtyPerUnitB
                    const used = q * qpu
                    const w = pool.totalAvailable > 0 ? (used / pool.totalAvailable) * 100 : 0
                    return (
                      <div
                        key={item.demandId}
                        className={`h-full transition-all ${idx === 0 ? 'bg-accent' : 'bg-warning'}`}
                        style={{ width: `${Math.min(w, 100)}%` }}
                      />
                    )
                  })}
                </div>
                <div className="flex justify-between text-xs font-mono text-text-secondary">
                  {items.map((item, idx) => {
                    const q = qtys[item.demandId] ?? 0
                    const qpu = idx === 0 ? pool.qtyPerUnitA : pool.qtyPerUnitB
                    return (
                      <span key={item.demandId} className={idx === 0 ? 'text-accent' : 'text-warning'}>
                        {item.sku}: {(q * qpu).toFixed(0)}
                      </span>
                    )
                  })}
                  <span className={remaining < 0 ? 'text-danger' : 'text-text-secondary'}>
                    Remaining: {remaining.toFixed(0)}
                  </span>
                </div>
              </div>
            )
          })}

          {/* Competing Items */}
          <div className="grid grid-cols-2 gap-3">
            {items.map((item, idx) => (
              <div key={item.demandId} className={`card p-4 space-y-3 border-t-2 ${idx === 0 ? 'border-t-accent' : 'border-t-warning'}`}>
                <div>
                  <div className="font-mono font-semibold text-text-primary text-sm">{item.sku}</div>
                  <div className="text-xs text-text-secondary">{item.productName}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs font-mono text-text-secondary">{item.company}</span>
                    <span className="text-xs font-mono text-text-secondary">{item.sourceRef}</span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-text-secondary mb-1">Priority</div>
                  <div className="font-mono text-xs">
                    {item.isNewProduct
                      ? `New Product — due in ${item.priorityScore}d`
                      : `DOC: ${item.priorityScore.toFixed(1)} days`}
                  </div>
                </div>
                <div>
                  <label className="text-xs text-text-secondary block mb-1">Qty to produce</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={item.requestedQty}
                      value={qtys[item.demandId] ?? item.allocatedQty}
                      onChange={e => setQty(item.demandId, parseInt(e.target.value) || 0)}
                      className="bg-bg border border-border rounded px-2 py-1 text-sm font-mono text-text-primary focus:outline-none focus:border-accent w-24"
                    />
                    <span className="text-xs text-text-secondary">/ {item.requestedQty}</span>
                  </div>
                  <div className="mt-1">
                    <StatusBadge
                      status={
                        (qtys[item.demandId] ?? 0) >= item.requestedQty ? 'Full'
                        : (qtys[item.demandId] ?? 0) > 0 ? 'Partial'
                        : 'None'
                      }
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Optimizer reasoning */}
          {optimizerWarning && (
            <div className="bg-warning/10 border border-warning/30 rounded p-3">
              <div className="flex items-center gap-2 mb-1">
                <Zap size={12} className="text-warning" />
                <span className="text-xs font-mono text-warning uppercase tracking-wider">Optimizer Warning</span>
              </div>
              <p className="text-xs text-text-secondary">{optimizerWarning}</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 p-4 border-t border-border sticky bottom-0 bg-surface">
          <button onClick={() => onConfirm(qtys)} className="btn-primary flex-1 flex items-center justify-center gap-2">
            <Zap size={14} />
            Confirm & Re-optimize
          </button>
          <button onClick={resetToOptimizer} className="btn-secondary flex items-center gap-1">
            <RotateCcw size={12} />
            Reset
          </button>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
        </div>
      </div>
    </div>
  )
}
