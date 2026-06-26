import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { logFactoryProduction, deleteFactoryLog, updateFactoryLog } from '@/lib/db/queries/factory'
import { config } from '@/lib/config'

// POST /api/factory/log
// Body: { sessionId: number, qtyAdded: number, operatorName?: string, note?: string }
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!config.features.enableFactoryWrites) {
    return NextResponse.json(
      { error: 'Factory writes are disabled. Set ENABLE_FACTORY_WRITES=true in .env.local.' },
      { status: 403 },
    )
  }

  try {
    const body = await req.json()
    const { sessionId, qtyAdded, operatorName, note } = body as {
      sessionId: number
      qtyAdded: number
      operatorName?: string
      note?: string
    }

    if (!sessionId || typeof sessionId !== 'number') {
      return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 })
    }
    if (!qtyAdded || typeof qtyAdded !== 'number' || qtyAdded <= 0) {
      return NextResponse.json({ error: 'qtyAdded must be a positive number' }, { status: 400 })
    }

    const newTotal = await logFactoryProduction(
      sessionId,
      qtyAdded,
      operatorName?.trim() || null,
      note?.trim() || null,
    )

    return NextResponse.json({ success: true, producedQty: newTotal })
  } catch (err: any) {
    console.error('factory/log error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}

// DELETE /api/factory/log  Body: { logId: number }
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!config.features.enableFactoryWrites)
    return NextResponse.json({ error: 'Factory writes are disabled.' }, { status: 403 })

  try {
    const { logId } = await req.json() as { logId: number }
    if (!logId || typeof logId !== 'number')
      return NextResponse.json({ error: 'Invalid logId' }, { status: 400 })

    const { newTotal } = await deleteFactoryLog(logId)
    return NextResponse.json({ success: true, producedQty: newTotal })
  } catch (err: any) {
    console.error('factory/log DELETE error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}

// PATCH /api/factory/log  Body: { logId: number, qtyAdded: number }
export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!config.features.enableFactoryWrites)
    return NextResponse.json({ error: 'Factory writes are disabled.' }, { status: 403 })

  try {
    const { logId, qtyAdded } = await req.json() as { logId: number; qtyAdded: number }
    if (!logId || typeof logId !== 'number')
      return NextResponse.json({ error: 'Invalid logId' }, { status: 400 })
    if (!qtyAdded || typeof qtyAdded !== 'number' || qtyAdded <= 0)
      return NextResponse.json({ error: 'qtyAdded must be a positive number' }, { status: 400 })

    const { newTotal } = await updateFactoryLog(logId, qtyAdded)
    return NextResponse.json({ success: true, producedQty: newTotal })
  } catch (err: any) {
    console.error('factory/log PATCH error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
