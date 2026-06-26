import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { updatePOEtaFTX } from '@/lib/db/queries/ftx'
import { updatePOEtaSBYL } from '@/lib/db/queries/sbyl'
import { config } from '@/lib/config'

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!config.features.enableWriteActions) {
    return NextResponse.json({ error: 'Write actions not yet enabled' }, { status: 403 })
  }

  const { poId, newEta, company } = await req.json()
  try {
    if (company === 'FTX') await updatePOEtaFTX(poId, new Date(newEta))
    else await updatePOEtaSBYL(poId, new Date(newEta))
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
