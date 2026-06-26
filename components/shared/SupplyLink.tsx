'use client'

interface Props {
  sku: string
  name?: string
  className?: string
}

export function SupplyLink({ sku, name, className = '' }: Props) {
  return (
    <a
      href={`/supply?sku=${encodeURIComponent(sku)}`}
      target="_blank"
      rel="noopener noreferrer"
      className={`font-mono text-accent hover:text-blue-400 hover:underline transition-colors ${className}`}
      title={name ? `${sku} — ${name}` : sku}
    >
      {sku}
    </a>
  )
}
