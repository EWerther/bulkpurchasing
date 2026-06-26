import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getProductionReport } from '@/lib/db/queries/factory'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const fromStr    = searchParams.get('fromDate')
  const throughStr = searchParams.get('throughDate')
  if (!fromStr || !throughStr)
    return NextResponse.json({ error: 'fromDate and throughDate required' }, { status: 400 })

  try {
    const rows = await getProductionReport(new Date(fromStr), new Date(throughStr))

    // Aggregate by (date, line, shift)
    const cells: Record<string, Record<string, {
      skus: string[]
      target: number
      produced: number
      skuData: { sku: string; target: number; produced: number }[]
    }>> = {}
    for (const r of rows) {
      const lsKey = `${r.lineNumber}-${r.shiftNumber}`
      if (!cells[r.sessionDate]) cells[r.sessionDate] = {}
      if (!cells[r.sessionDate][lsKey]) cells[r.sessionDate][lsKey] = { skus: [], target: 0, produced: 0, skuData: [] }
      cells[r.sessionDate][lsKey].skus.push(r.sku)
      cells[r.sessionDate][lsKey].target   += r.targetQty
      cells[r.sessionDate][lsKey].produced += r.producedQty
      cells[r.sessionDate][lsKey].skuData.push({ sku: r.sku, target: r.targetQty, produced: r.producedQty })
    }

    // Totals per line/shift across all dates
    const totals: Record<string, { target: number; produced: number }> = {}
    for (const dateCells of Object.values(cells)) {
      for (const [lsKey, cell] of Object.entries(dateCells)) {
        if (!totals[lsKey]) totals[lsKey] = { target: 0, produced: 0 }
        totals[lsKey].target   += cell.target
        totals[lsKey].produced += cell.produced
      }
    }

    return NextResponse.json({ cells, totals })
  } catch (err: any) {
    console.error('factory/report error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
