import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getSessionsWithLogsByCell } from '@/lib/db/queries/factory'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const date  = searchParams.get('date')
  const line  = parseInt(searchParams.get('line')  ?? '', 10)
  const shift = parseInt(searchParams.get('shift') ?? '', 10)

  if (!date || !line || !shift)
    return NextResponse.json({ error: 'date, line, shift required' }, { status: 400 })

  try {
    const sessions = await getSessionsWithLogsByCell(date, line, shift)
    return NextResponse.json({ sessions })
  } catch (err: any) {
    console.error('factory/sessions-by-cell error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
