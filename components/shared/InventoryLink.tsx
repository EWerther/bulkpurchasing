'use client'

interface Props {
  sku: string
  company?: string
  name?: string
  className?: string
}

function normalizeCompany(company?: string): string | undefined {
  if (!company) return undefined
  const u = company.toUpperCase()
  if (u.includes('SBYL') || u.includes('MILLIARD')) return 'SBYL'
  if (u.includes('FTX') || u.includes('FOAMTEX')) return 'FTX'
  return undefined
}

export function InventoryLink({ sku, company, name, className = '' }: Props) {
  const params = new URLSearchParams({ sku })
  const normalized = normalizeCompany(company)
  if (normalized) params.set('company', normalized)
  return (
    <a
      href={`/inventory?${params.toString()}`}
      target="_blank"
      rel="noopener noreferrer"
      className={`font-mono text-accent hover:text-blue-400 hover:underline transition-colors ${className}`}
      title={name ? `View inventory: ${sku} — ${name}` : `View inventory for ${sku}`}
    >
      {sku}
    </a>
  )
}
