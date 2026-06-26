'use client'

type Status =
  | 'Full' | 'Partial' | 'None' | 'NoRecipe'
  | 'On Track' | 'Rush' | 'Push Off' | 'Locked'
  | 'New Product' | 'Via Sub' | 'Via New PO'
  | 'Received' | 'Completed' | 'Open'

interface StyleDef {
  bg: string
  text: string
  border: string
  dot?: string
}

const STATUS_STYLES: Record<Status, StyleDef> = {
  'Full':        { bg: 'rgba(22,163,74,0.09)',  text: '#15803d', border: 'rgba(22,163,74,0.22)',  dot: '#16a34a' },
  'On Track':    { bg: 'rgba(22,163,74,0.09)',  text: '#15803d', border: 'rgba(22,163,74,0.22)',  dot: '#16a34a' },
  'Completed':   { bg: 'rgba(22,163,74,0.09)',  text: '#15803d', border: 'rgba(22,163,74,0.22)',  dot: '#16a34a' },
  'Partial':     { bg: 'rgba(217,119,6,0.09)',  text: '#b45309', border: 'rgba(217,119,6,0.25)',  dot: '#d97706' },
  'Push Off':    { bg: 'rgba(217,119,6,0.09)',  text: '#b45309', border: 'rgba(217,119,6,0.25)',  dot: '#d97706' },
  'None':        { bg: 'rgba(220,38,38,0.07)',  text: '#b91c1c', border: 'rgba(220,38,38,0.2)',   dot: '#dc2626' },
  'Rush':        { bg: 'rgba(220,38,38,0.07)',  text: '#b91c1c', border: 'rgba(220,38,38,0.2)',   dot: '#dc2626' },
  'NoRecipe':    { bg: 'rgba(100,116,139,0.09)',text: '#64748b', border: 'rgba(100,116,139,0.2)' },
  'Locked':      { bg: 'rgba(100,116,139,0.09)',text: '#64748b', border: 'rgba(100,116,139,0.2)' },
  'Received':    { bg: 'rgba(100,116,139,0.09)',text: '#64748b', border: 'rgba(100,116,139,0.2)' },
  'New Product': { bg: 'rgba(79,70,229,0.08)',  text: '#4f46e5', border: 'rgba(79,70,229,0.22)', dot: '#4f46e5' },
  'Via Sub':     { bg: 'rgba(217,119,6,0.08)',  text: '#b45309', border: 'rgba(217,119,6,0.22)' },
  'Via New PO':  { bg: 'rgba(79,70,229,0.08)',  text: '#4f46e5', border: 'rgba(79,70,229,0.2)' },
  'Open':        { bg: 'rgba(71,85,105,0.07)',  text: '#475569', border: 'rgba(71,85,105,0.18)' },
}

const STATUS_LABELS: Partial<Record<Status, string>> = {
  'NoRecipe': 'No Recipe',
}

interface Props {
  status: Status | string
  size?: 'sm' | 'md'
  showDot?: boolean
}

export function StatusBadge({ status, size = 'sm', showDot = false }: Props) {
  const s = status as Status
  const styles = STATUS_STYLES[s] ?? {
    bg: 'rgba(71,85,105,0.07)', text: '#475569', border: 'rgba(71,85,105,0.18)',
  }
  const label = STATUS_LABELS[s] ?? status
  const padding = size === 'sm' ? '2px 8px' : '4px 10px'
  const fontSize = size === 'sm' ? '11px' : '12px'

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full font-semibold whitespace-nowrap"
      style={{
        background: styles.bg,
        color: styles.text,
        border: `1px solid ${styles.border}`,
        padding,
        fontSize,
        letterSpacing: '0.01em',
      }}
    >
      {(showDot || styles.dot) && (
        <span
          className="rounded-full shrink-0"
          style={{ width: 5, height: 5, background: styles.dot ?? styles.text, opacity: 0.8 }}
        />
      )}
      {label}
    </span>
  )
}
