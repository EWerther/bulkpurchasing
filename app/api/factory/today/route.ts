import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getFactorySessionsForDate } from '@/lib/db/queries/factory'

function serializeDates(obj: any): any {
  if (obj instanceof Date) return obj.toISOString()
  if (Array.isArray(obj)) return obj.map(serializeDates)
  if (obj && typeof obj === 'object') {
    const result: any = {}
    for (const [k, v] of Object.entries(obj)) result[k] = serializeDates(v)
    return result
  }
  return obj
}

// GET /api/factory/today?date=YYYY-MM-DD (defaults to today)
// Returns all factory sessions for the given date with their production logs
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const dateStr = searchParams.get('date') ?? new Date().toLocaleDateString('en-CA')

  try {
    const sessions = await getFactorySessionsForDate(dateStr)
    return NextResponse.json(serializeDates({ sessions, date: dateStr }))
  } catch (err: any) {
    console.error('factory/today error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
