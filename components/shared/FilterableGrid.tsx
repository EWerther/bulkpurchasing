'use client'

import { useState, useMemo, useCallback } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'

export interface Column<T> {
  key: string
  header: string
  render?: (row: T) => React.ReactNode
  getValue?: (row: T) => string | number
  sortable?: boolean
  filterable?: boolean
  width?: string
  groupBorder?: (row: T) => string
}

interface Props<T> {
  columns: Column<T>[]
  data: T[]
  rowKey: (row: T) => string
  density?: 'comfortable' | 'compact'
  emptyMessage?: string
  className?: string
  onRowClick?: (row: T) => void
  initialFilter?: Record<string, string>
}

export function FilterableGrid<T>({
  columns,
  data,
  rowKey,
  density = 'comfortable',
  emptyMessage = 'No data',
  className = '',
  onRowClick,
  initialFilter,
}: Props<T>) {
  const [filters, setFilters] = useState<Record<string, string>>(initialFilter ?? {})
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const handleSort = useCallback((key: string) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }, [sortKey])

  const filtered = useMemo(() => {
    let rows = [...data]
    for (const col of columns) {
      const f = filters[col.key]?.toLowerCase()
      if (!f) continue
      rows = rows.filter(row => {
        const val = col.getValue ? String(col.getValue(row)) : ''
        return val.toLowerCase().includes(f)
      })
    }
    if (sortKey) {
      const col = columns.find(c => c.key === sortKey)
      if (col?.getValue) {
        rows.sort((a, b) => {
          const va = col.getValue!(a)
          const vb = col.getValue!(b)
          if (typeof va === 'number' && typeof vb === 'number') {
            return sortDir === 'asc' ? va - vb : vb - va
          }
          return sortDir === 'asc'
            ? String(va).localeCompare(String(vb))
            : String(vb).localeCompare(String(va))
        })
      }
    }
    return rows
  }, [data, filters, sortKey, sortDir, columns])

  const rowHeight = density === 'compact' ? 'h-7' : 'h-9'

  return (
    <div className={`flex flex-col ${className}`}>
      <div className="text-xs text-text-secondary mb-1 font-mono">
        {filtered.length.toLocaleString()} row{filtered.length !== 1 ? 's' : ''}
        {filtered.length !== data.length && ` (of ${data.length.toLocaleString()})`}
      </div>
      <div className="overflow-auto rounded border border-border">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map(col => (
                <th
                  key={col.key}
                  style={col.width ? { width: col.width } : undefined}
                  onClick={col.sortable !== false ? () => handleSort(col.key) : undefined}
                  className={col.sortable !== false ? 'cursor-pointer select-none' : ''}
                >
                  <div className="flex items-center gap-1">
                    {col.header}
                    {col.sortable !== false && (
                      sortKey === col.key
                        ? sortDir === 'asc' ? <ChevronUp size={12} className="text-accent" /> : <ChevronDown size={12} className="text-accent" />
                        : <ChevronsUpDown size={12} className="opacity-30" />
                    )}
                  </div>
                </th>
              ))}
            </tr>
            <tr>
              {columns.map(col => (
                <th key={col.key} className="py-1 px-2 bg-bg">
                  {col.filterable !== false ? (
                    <input
                      className="filter-input"
                      placeholder="filter…"
                      value={filters[col.key] ?? ''}
                      onChange={e => setFilters(f => ({ ...f, [col.key]: e.target.value }))}
                    />
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="text-center text-text-secondary py-8">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              filtered.map(row => {
                const borderColor = columns[0]?.groupBorder?.(row)
                return (
                  <tr
                    key={rowKey(row)}
                    className={`${rowHeight} ${onRowClick ? 'cursor-pointer' : ''}`}
                    style={borderColor ? { borderLeft: `3px solid ${borderColor}` } : undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                  >
                    {columns.map(col => (
                      <td key={col.key}>
                        {col.render ? col.render(row) : col.getValue ? String(col.getValue(row)) : ''}
                      </td>
                    ))}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
