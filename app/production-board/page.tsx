'use client'

import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, AlertTriangle } from 'lucide-react'
import { SummaryBar } from '@/components/shared/SummaryBar'
import { CapacityBar } from '@/components/shared/CapacityBar'
import { fmtDate } from '@/lib/utils/dates'

interface BoardItem {
  orderId: number
  orderNumber: string
  company: string
  sku: string
  productName: string
  qty: number
  readyByDate: string
  status: 'Received' | 'Completed' | 'Open'
}

interface BoardDay {
  date: string
  items: BoardItem[]
  totalQty: number
  isOverCapacity: boolean
}

const STATUS_COLORS = {
  Received: 'bg-locked/15 text-locked',
  Completed: 'bg-success/15 text-success',
  Open: 'bg-surface text-text-secondary',
}

export default function ProductionBoardPage() {
  const [throughDate, setThroughDate] = useState(() => {
    const d = new Date()
    d.setMonth(d.getMonth() + 1)
    return d.toISOString().split('T')[0]
  })
  const [data, setData] = useState<BoardDay[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lastFetch, setLastFetch] = useState<Date | null>(null)

  const capacity = 600

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/production-board/data?throughDate=${throughDate}`)
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      const json = await res.json()
      setData(json.days ?? [])
      setLastFetch(new Date())
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [throughDate])

  useEffect(() => { fetchData() }, [fetchData])

  // Auto-refresh every 5 minutes
  useEffect(() => {
    const interval = setInterval(fetchData, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchData])

  const totalOrders = data.reduce((s, d) => s + d.items.length, 0)
  const overCapDays = data.filter(d => d.isOverCapacity).length
  const todayKey = new Date().toISOString().split('T')[0]

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-surface border-b border-border px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="font-mono text-sm font-bold tracking-widest uppercase text-text-primary">
            Production Board
          </h1>
          <div className="text-xs text-text-secondary font-mono mt-0.5">
            Daily Capacity: {capacity.toLocaleString()} units
          </div>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="date"
            value={throughDate}
            onChange={e => setThroughDate(e.target.value)}
            className="bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
          />
          <button onClick={fetchData} disabled={loading} className="btn-secondary flex items-center gap-1.5">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          {lastFetch && (
            <span className="text-xs text-text-secondary font-mono">
              {lastFetch.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      <SummaryBar stats={[
        { label: 'Orders', value: totalOrders },
        { label: 'Days', value: data.length },
        { label: 'Over Capacity', value: overCapDays, color: overCapDays > 0 ? 'danger' : 'default' },
      ]} />

      {error && (
        <div className="mx-4 my-2 bg-danger/10 border border-danger/30 rounded px-3 py-2 text-xs text-danger font-mono flex items-center gap-2">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      {/* Days */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {data.length === 0 && !loading && (
          <div className="text-center text-text-secondary font-mono text-sm py-16">
            No orders in selected range
          </div>
        )}
        {data.map(day => {
          const isToday = day.date.startsWith(todayKey)
          const dateLabel = fmtDate(day.date, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })

          return (
            <div key={day.date} className={`card ${isToday ? 'border-accent/50' : ''}`}>
              <div className={`flex items-center justify-between px-4 py-2.5 border-b border-border ${isToday ? 'bg-accent/10' : 'bg-surface'}`}>
                <div className="flex items-center gap-4">
                  <div className="font-mono font-semibold text-text-primary">
                    {dateLabel}
                    {isToday && <span className="ml-2 text-xs text-accent">(Today)</span>}
                  </div>
                  <CapacityBar current={day.totalQty} capacity={capacity} />
                </div>
                {day.isOverCapacity && (
                  <div className="flex items-center gap-1 text-xs font-mono text-danger bg-danger/10 border border-danger/30 rounded px-2 py-0.5">
                    <AlertTriangle size={10} />
                    OVER CAPACITY +{(day.totalQty - capacity).toLocaleString()}
                  </div>
                )}
              </div>

              <table className="data-table">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Order #</th>
                    <th>SKU</th>
                    <th>Product</th>
                    <th>Qty</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {day.items.map(item => (
                    <tr key={`${item.orderId}-${item.sku}`} className="table-row-comfortable">
                      <td className="font-mono text-xs text-text-secondary">{item.company}</td>
                      <td className="font-mono text-xs">{item.orderNumber}</td>
                      <td className="font-mono text-xs font-semibold">{item.sku}</td>
                      <td className="text-xs">{item.productName}</td>
                      <td className="font-mono font-semibold text-right">{item.qty.toLocaleString()}</td>
                      <td>
                        <span className={`chip text-xs font-mono ${STATUS_COLORS[item.status]}`}>
                          {item.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        })}
      </div>
    </div>
  )
}
