'use client'

interface Props {
  current: number
  capacity: number
  showLabel?: boolean
}

export function CapacityBar({ current, capacity, showLabel = true }: Props) {
  const pct = capacity > 0 ? Math.min((current / capacity) * 100, 200) : 0
  const displayPct = Math.min(pct, 100)

  const color =
    pct > 100 ? 'bg-danger' :
    pct > 80  ? 'bg-warning' :
    'bg-success'

  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex-1 h-1.5 bg-surface rounded-full overflow-hidden min-w-[48px]">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${displayPct}%` }}
        />
      </div>
      {showLabel && (
        <span className={`font-mono text-xs whitespace-nowrap ${pct > 100 ? 'text-danger' : pct > 80 ? 'text-warning' : 'text-text-secondary'}`}>
          {current.toLocaleString()} / {capacity.toLocaleString()}
        </span>
      )}
    </div>
  )
}
