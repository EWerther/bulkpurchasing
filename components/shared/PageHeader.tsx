'use client'

import { useState } from 'react'
import { Play, Loader2, ChevronDown, ChevronUp } from 'lucide-react'

interface Field {
  id: string
  label: string
  type: 'date' | 'number' | 'toggle'
  value: any
  onChange: (v: any) => void
  options?: { label: string; value: any }[]
  min?: number
  max?: number
  placeholder?: string
  optional?: boolean
}

interface Props {
  title: string
  subtitle?: string
  fields?: Field[]
  onRun: () => void
  runLabel?: string
  loading?: boolean
  company?: 'FTX' | 'SBYL'
  onCompanyChange?: (c: 'FTX' | 'SBYL') => void
  showCompanyToggle?: boolean
}

export function PageHeader({
  title,
  subtitle,
  fields = [],
  onRun,
  runLabel = 'Run Analysis',
  loading = false,
  company = 'FTX',
  onCompanyChange,
  showCompanyToggle = true,
}: Props) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div
      className="border-b shrink-0"
      style={{ background: '#ffffff', borderColor: 'var(--border)' }}
    >
      {/* Title row */}
      <div className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-base font-semibold" style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
              {title}
            </h1>
            {subtitle && (
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>
            )}
          </div>

          {showCompanyToggle && onCompanyChange && (
            <div
              className="flex rounded-lg border overflow-hidden text-xs font-semibold"
              style={{ borderColor: 'var(--border-light)', background: 'var(--bg)' }}
            >
              {(['FTX', 'SBYL'] as const).map(c => (
                <button
                  key={c}
                  onClick={() => onCompanyChange(c)}
                  className="px-4 py-1.5 transition-all duration-150"
                  style={
                    company === c
                      ? { background: 'var(--accent)', color: '#fff' }
                      : { color: 'var(--text-secondary)', background: 'transparent' }
                  }
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={() => setCollapsed(c => !c)}
          className="rounded-md p-1.5 transition-colors"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--surface-hover)'}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
        >
          {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
      </div>

      {/* Controls row */}
      {!collapsed && (fields.length > 0 || true) && (
        <div
          className="px-6 pb-4 flex flex-wrap items-end gap-5 border-t"
          style={{ borderColor: 'var(--border)', background: '#f8fafc' }}
        >
          <div className="pt-4 flex flex-wrap items-end gap-5">
            {fields.map(field => (
              <div key={field.id} className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
                  {field.label}
                  {field.optional && <span className="ml-1 opacity-60 normal-case tracking-normal font-normal">optional</span>}
                </label>

                {field.type === 'toggle' && field.options ? (
                  <div
                    className="flex rounded-lg border overflow-hidden text-xs font-medium"
                    style={{ borderColor: 'var(--border-light)', background: 'var(--surface)' }}
                  >
                    {field.options.map(opt => (
                      <button
                        key={String(opt.value)}
                        onClick={() => field.onChange(opt.value)}
                        className="px-3 py-1.5 transition-all duration-150"
                        style={
                          field.value === opt.value
                            ? { background: 'var(--accent)', color: '#fff' }
                            : { color: 'var(--text-secondary)', background: 'transparent' }
                        }
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                ) : field.type === 'date' ? (
                  <input
                    type="date"
                    value={field.value ? (field.value instanceof Date ? field.value.toISOString().split('T')[0] : field.value) : ''}
                    onChange={e => field.onChange(e.target.value || undefined)}
                    className="input text-xs py-1.5"
                    style={{ width: 150 }}
                  />
                ) : (
                  <input
                    type="number"
                    value={field.value ?? ''}
                    min={field.min}
                    max={field.max}
                    placeholder={field.placeholder}
                    onChange={e => field.onChange(Number(e.target.value))}
                    className="input text-xs py-1.5 font-mono-num"
                    style={{ width: 90 }}
                  />
                )}
              </div>
            ))}

            <div>
              <button
                onClick={onRun}
                disabled={loading}
                className="btn-primary"
              >
                {loading
                  ? <Loader2 size={14} className="animate-spin" />
                  : <Play size={13} strokeWidth={2.5} />
                }
                {loading ? 'Running…' : runLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
