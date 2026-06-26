'use client'

interface StatChip {
  label: string
  value: string | number
  color?: 'default' | 'success' | 'warning' | 'danger' | 'accent'
}

const COLOR_MAP = {
  default: '#0f172a',
  success: '#15803d',
  warning: '#b45309',
  danger:  '#b91c1c',
  accent:  '#4f46e5',
}

interface Props {
  stats: StatChip[]
}

export function SummaryBar({ stats }: Props) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-1 gap-y-2 px-5 py-2.5 border-b"
      style={{ background: '#f8fafc', borderColor: 'var(--border)' }}
    >
      {stats.map((s, i) => (
        <span key={i} className="flex items-center">
          {i > 0 && (
            <span className="mx-3 select-none" style={{ color: 'var(--border-light)' }}>·</span>
          )}
          <span className="text-xs mr-1.5" style={{ color: 'var(--text-muted)' }}>{s.label}</span>
          <span
            className="font-mono-num text-sm font-semibold"
            style={{ color: COLOR_MAP[s.color ?? 'default'] }}
          >
            {typeof s.value === 'number' ? s.value.toLocaleString() : s.value}
          </span>
        </span>
      ))}
    </div>
  )
}
