import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getProductionBoardData } from '@/lib/db/queries/csgportal'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const throughDateParam = searchParams.get('throughDate')
  const throughDate = throughDateParam ? new Date(throughDateParam) : (() => {
    const d = new Date()
    d.setMonth(d.getMonth() + 1)
    return d
  })()

  try {
    const days = await getProductionBoardData(throughDate)
    return NextResponse.json({ days: days.map(d => ({
      ...d,
      date: d.date.toISOString(),
      items: d.items.map(i => ({ ...i, readyByDate: i.readyByDate.toISOString() })),
    })) })
  } catch (err: any) {
    console.error('production-board/data error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
