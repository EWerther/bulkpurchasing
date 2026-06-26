import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getOpenProductionOrders, getAssignedTotalsByWhoiId, getSessionBreakdownByWhoiIds } from '@/lib/db/queries/factory'

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

// GET /api/factory/orders?fromDate=YYYY-MM-DD&throughDate=YYYY-MM-DD
// Returns open production orders from WP_WHOD/WP_WHOI for supervisor assignment
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const fromDate = searchParams.get('fromDate')
    ? new Date(searchParams.get('fromDate')!)
    : today

  const throughDate = searchParams.get('throughDate')
    ? new Date(searchParams.get('throughDate')!)
    : (() => { const d = new Date(today); d.setDate(d.getDate() + 14); return d })()

  try {
    const orders = await getOpenProductionOrders(fromDate, throughDate)
    const whoiIds = orders.map(o => o.whoiId)
    const [assignedMap, breakdownMap] = await Promise.all([
      getAssignedTotalsByWhoiId(whoiIds),
      getSessionBreakdownByWhoiIds(whoiIds),
    ])
    const assignedTotals: Record<number, number> = {}
    for (const [id, qty] of assignedMap) assignedTotals[id] = qty
    const sessionBreakdowns: Record<number, any[]> = {}
    for (const [id, rows] of breakdownMap) sessionBreakdowns[id] = rows
    return NextResponse.json(serializeDates({ orders, assignedTotals, sessionBreakdowns }))
  } catch (err: any) {
    console.error('factory/orders error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
