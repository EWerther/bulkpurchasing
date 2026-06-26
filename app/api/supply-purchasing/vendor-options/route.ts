import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getVendorOptionsForItems } from '@/lib/db/queries/tfm'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const raw = req.nextUrl.searchParams.get('itemIds') ?? ''
  const itemIds = raw.split(',').map(Number).filter(n => n > 0)
  if (!itemIds.length) return NextResponse.json({ options: {} })

  try {
    const map = await getVendorOptionsForItems(itemIds)
    const options: Record<number, { vendors: any[]; itemPartNumber: string | null; qtyPerCase: number | null }> = {}
    for (const [id, val] of map) {
      options[id] = val
    }
    return NextResponse.json({ options })
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
