import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getOpenPOsFTX, getADSFTX } from '@/lib/db/queries/ftx'
import { getOpenPOsSBYL, getADSSBYL } from '@/lib/db/queries/sbyl'

function serializeDates(obj: any): any {
  if (obj instanceof Date) return obj.toISOString()
  if (Array.isArray(obj)) return obj.map(serializeDates)
  if (obj && typeof obj === 'object') {
    const r: any = {}
    for (const [k, v] of Object.entries(obj)) r[k] = serializeDates(v)
    return r
  }
  return obj
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const cutoffStr = searchParams.get('cutoff')
  const cutoffDate = cutoffStr ? new Date(cutoffStr) : (() => {
    const d = new Date(); d.setMonth(d.getMonth() + 4); return d
  })()

  const today = new Date(); today.setHours(0, 0, 0, 0)

  try {
    const [ftxPOs, sbylPOs, ftxADS, sbylADS] = await Promise.all([
      getOpenPOsFTX(cutoffDate),
      getOpenPOsSBYL(cutoffDate),
      getADSFTX(),
      getADSSBYL(),
    ])

    // Only show POs for established items (ADS > 0).
    // New product POs are already auto-included in Load Demand results — no need to select them.
    const ftxADSItemIds = new Set(ftxADS.filter(a => a.ads > 0).map(a => a.itemId))
    const sbylADSItemIds = new Set(sbylADS.filter(a => a.ads > 0).map(a => a.itemId))

    const openPOs = [
      ...ftxPOs
        .filter(po => po.eta >= today && ftxADSItemIds.has(po.itemId))
        .map(po => ({ ...po, company: 'FTX' as const })),
      ...sbylPOs
        .filter(po => po.eta >= today && sbylADSItemIds.has(po.itemId))
        .map(po => ({ ...po, company: 'SBYL' as const })),
    ].sort((a, b) => a.eta.getTime() - b.eta.getTime())

    return NextResponse.json(serializeDates(openPOs))
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
