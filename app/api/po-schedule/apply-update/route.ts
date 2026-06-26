import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { updatePOEtaFTX, updatePOQtyFTX } from '@/lib/db/queries/ftx'
import { updatePOEtaSBYL, updatePOQtySBYL } from '@/lib/db/queries/sbyl'
import { config } from '@/lib/config'

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!config.features.enableWriteActions) {
    return NextResponse.json({ error: 'Write actions not yet enabled' }, { status: 403 })
  }

  const { poId, poItemId, newEta, newQty, company } = await req.json()
  try {
    if (newEta) {
      if (company === 'FTX') await updatePOEtaFTX(poId, new Date(newEta))
      else await updatePOEtaSBYL(poId, new Date(newEta))
    }
    if (newQty !== undefined) {
      if (company === 'FTX') await updatePOQtyFTX(poItemId, newQty)
      else await updatePOQtySBYL(poItemId, newQty)
    }
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
