import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { upsertFactorySessions, deleteFactorySession } from '@/lib/db/queries/factory'
import { config } from '@/lib/config'
import type { AssignmentInput } from '@/lib/db/queries/factory'

// POST /api/factory/assign
// Body: { sessionDate: 'YYYY-MM-DD', assignments: AssignmentInput[] }
// Replaces all sessions for that date with the provided assignments (transactional).
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
    const { sessionDate, assignments } = body as {
      sessionDate: string
      assignments: AssignmentInput[]
    }

    if (!sessionDate || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
      return NextResponse.json({ error: 'Invalid or missing sessionDate (YYYY-MM-DD)' }, { status: 400 })
    }
    if (!Array.isArray(assignments)) {
      return NextResponse.json({ error: 'assignments must be an array' }, { status: 400 })
    }

    // Validate each assignment
    for (const a of assignments) {
      if (!a.whoiId || !a.lineNumber || !a.shiftNumber || !a.targetQty) {
        return NextResponse.json(
          { error: 'Each assignment must have whoiId, lineNumber, shiftNumber, targetQty' },
          { status: 400 },
        )
      }
      if (a.lineNumber < 1 || a.lineNumber > config.factory.lines) {
        return NextResponse.json(
          { error: `lineNumber must be between 1 and ${config.factory.lines}` },
          { status: 400 },
        )
      }
      if (a.shiftNumber < 1 || a.shiftNumber > 2) {
        return NextResponse.json({ error: 'shiftNumber must be 1 or 2' }, { status: 400 })
      }
      if (a.targetQty <= 0) {
        return NextResponse.json({ error: 'targetQty must be greater than 0' }, { status: 400 })
      }
    }

    await upsertFactorySessions(sessionDate, assignments.map(a => ({ ...a, sessionDate })))
    return NextResponse.json({ success: true, count: assignments.length })
  } catch (err: any) {
    console.error('factory/assign error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}

// DELETE /api/factory/assign
// Body: { sessionDate, whoiId, lineNumber, shiftNumber }
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!config.features.enableFactoryWrites) {
    return NextResponse.json({ error: 'Factory writes are disabled.' }, { status: 403 })
  }

  try {
    const { sessionDate, whoiId, lineNumber, shiftNumber } = await req.json()
    if (!sessionDate || !whoiId || !lineNumber || !shiftNumber) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    await deleteFactorySession(sessionDate, whoiId, lineNumber, shiftNumber)
    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('factory/assign DELETE error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
