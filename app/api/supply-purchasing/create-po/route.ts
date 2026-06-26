import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createTFMSupplyPO } from '@/lib/db/queries/tfm'
import { config } from '@/lib/config'

interface POLineInput {
  itemId: number
  vendorId: number
  vendorName: string
  qtyCases: number
  qtyPerCase: number
  costPerUnit: number | null
  partNumber: string | null
  purchasingName: string | null
}

interface POCreateRequest {
  submitDate: string | null
  eta: string | null
  etd: string | null
  readyDate: string | null
  lines: POLineInput[]
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!config.features.enableWriteActions) {
    return NextResponse.json(
      { error: 'Write actions are disabled. Set ENABLE_WRITE_ACTIONS=true in .env.local.' },
      { status: 403 },
    )
  }

  try {
    const body: POCreateRequest = await req.json()
    const { submitDate, eta, etd, readyDate, lines } = body

    if (!lines?.length) {
      return NextResponse.json({ error: 'No lines provided' }, { status: 400 })
    }
    if (!eta) {
      return NextResponse.json({ error: 'ETA is required' }, { status: 400 })
    }

    // Group lines by vendor — one ITPO per vendor
    const byVendor = new Map<number, { vendorName: string; lines: POLineInput[] }>()
    for (const line of lines) {
      const existing = byVendor.get(line.vendorId)
      if (existing) {
        existing.lines.push(line)
      } else {
        byVendor.set(line.vendorId, { vendorName: line.vendorName, lines: [line] })
      }
    }

    const toDate = (s: string | null) => (s ? new Date(s) : null)
    const createdPoIds: number[] = []

    for (const [vendorId, group] of byVendor) {
      const poId = await createTFMSupplyPO(
        vendorId,
        toDate(submitDate),
        toDate(eta),
        toDate(etd),
        toDate(readyDate),
        group.lines.map(l => ({
          itemId: l.itemId,
          qtyCases: l.qtyCases,
          qtyPerCase: l.qtyPerCase,
          costPerUnit: l.costPerUnit,
          partNumber: l.partNumber,
          purchasingName: l.purchasingName,
        })),
      )
      createdPoIds.push(poId)
    }

    return NextResponse.json({ success: true, poIds: createdPoIds, count: createdPoIds.length })
  } catch (err: any) {
    console.error('supply-purchasing/create-po error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
