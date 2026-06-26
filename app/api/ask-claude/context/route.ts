/**
 * GET /api/ask-claude/context?modules=inventory,open_pos,supply,po_schedule
 *
 * Fetches one or more data modules for the Ask Claude context panel.
 * Each module is fetched independently; failures are silently dropped.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getInventoryFTX, getADSFTX, getTFMVendorItemIdsFTX } from '@/lib/db/queries/ftx'
import { getInventorySBYL, getADSSBYL, getTFMVendorItemIdsSBYL } from '@/lib/db/queries/sbyl'
import { getOpenITPOLines } from '@/lib/db/queries/itpo'
import { buildSupplyItems } from '@/lib/engine/supplyPipeline'
import { POScheduleGenerator } from '@/lib/engine/POScheduleGenerator'
import { config } from '@/lib/config'

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn() } catch { return null }
}

// ── Module fetchers ─────────────────────────────────────────────────────────

async function fetchInventory() {
  const [ftxInv, ftxADS, sbylInv, sbylADS] = await Promise.all([
    getInventoryFTX(), getADSFTX(), getInventorySBYL(), getADSSBYL(),
  ])
  const ftxADSMap  = new Map(ftxADS.map(a  => [a.itemId, a.ads]))
  const sbylADSMap = new Map(sbylADS.map(a => [a.itemId, a.ads]))

  const toRow = (company: 'FTX' | 'SBYL', adsMap: Map<number, number>) =>
    (item: { itemId: number; sku: string; totalUnits: number }) => {
      const ads = adsMap.get(item.itemId) ?? 0
      const doc = ads > 0 ? Math.round((item.totalUnits / ads) * 10) / 10 : null
      return { company, sku: item.sku, onHand: item.totalUnits, ads: Math.round(ads * 10) / 10, doc }
    }

  return {
    ftx:  ftxInv.map(toRow('FTX',  ftxADSMap )).sort((a, b) => (a.doc ?? 9999) - (b.doc ?? 9999)),
    sbyl: sbylInv.map(toRow('SBYL', sbylADSMap)).sort((a, b) => (a.doc ?? 9999) - (b.doc ?? 9999)),
  }
}

async function fetchOpenPos() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const [ftxLines, sbylLines] = await Promise.all([
    getOpenITPOLines('LCDataFTX',  config.poSchedule.tfmVendorIdFTX,  today),
    getOpenITPOLines('LCDataSBYL', config.poSchedule.tfmVendorIdSBYL, today),
  ])
  const shape = (l: typeof ftxLines[0]) => ({
    poNumber: l.poNumber, sku: l.sku, qty: l.qty,
    eta: l.eta.toISOString().split('T')[0],
  })
  return {
    ftx:  ftxLines.map(shape),
    sbyl: sbylLines.map(shape),
  }
}

async function fetchSupply() {
  const supplyMap = await buildSupplyItems()
  return Array.from(supplyMap.values()).map(i => ({
    sku:        i.sku,
    name:       i.name,
    category:   i.category,
    onHand:     i.onHandQty,
    incomingPos: i.futurePOs.length,
    nextArrival: i.futurePOs.length > 0
      ? i.futurePOs.sort((a, b) => a.eta.getTime() - b.eta.getTime())[0].eta.toISOString().split('T')[0]
      : null,
  }))
}

async function fetchPoSchedule() {
  const [ftxInv, ftxADS, ftxTFMIds, sbylInv, sbylADS, sbylTFMIds] = await Promise.all([
    getInventoryFTX(), getADSFTX(), getTFMVendorItemIdsFTX(config.poSchedule.tfmVendorIdFTX),
    getInventorySBYL(), getADSSBYL(), getTFMVendorItemIdsSBYL(config.poSchedule.tfmVendorIdSBYL),
  ])
  const ftxADSMap  = new Map(ftxADS.map(a  => [a.itemId, a.ads]))
  const sbylADSMap = new Map(sbylADS.map(a => [a.itemId, a.ads]))

  const horizon = new Date()
  horizon.setFullYear(horizon.getFullYear() + 1)

  const gen = new POScheduleGenerator({
    minDOC: config.poSchedule.minDOC, maxDOC: config.poSchedule.maxDOC,
    minOrderQty: config.poSchedule.minOrderQty, maxOrderQty: config.poSchedule.maxOrderQty,
    cutoffDate: horizon,
  })

  const ftxEstablished = ftxInv
    .filter(i => (ftxADSMap.get(i.itemId) ?? 0) > 0 && ftxTFMIds.has(i.itemId))
    .map(i => ({ itemId: i.itemId, sku: i.sku, productName: i.sku, company: 'FTX' as const, currentInventory: i.totalUnits, ads: ftxADSMap.get(i.itemId)! }))

  const sbylEstablished = sbylInv
    .filter(i => (sbylADSMap.get(i.itemId) ?? 0) > 0 && sbylTFMIds.has(i.itemId))
    .map(i => ({ itemId: i.itemId, sku: i.sku, productName: i.sku, company: 'SBYL' as const, currentInventory: i.totalUnits, ads: sbylADSMap.get(i.itemId)! }))

  const shape = (g: ReturnType<typeof gen.generate>[0]) => ({
    sku: g.sku, qty: g.orderedQty,
    eta: g.arrivalDate.toISOString().split('T')[0],
    docAtTrigger: Math.round(g.projectedDOCAtTrigger * 10) / 10,
  })

  return {
    ftx:  gen.generate(ftxEstablished).slice(0, 150).map(shape),
    sbyl: gen.generate(sbylEstablished).slice(0, 150).map(shape),
  }
}

// ── Route ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const modules = (req.nextUrl.searchParams.get('modules') ?? '').split(',').filter(Boolean)
  const result: Record<string, any> = {}

  await Promise.all([
    modules.includes('inventory')   && safe(fetchInventory).then(d   => d && (result.inventory   = d)),
    modules.includes('open_pos')    && safe(fetchOpenPos).then(d     => d && (result.open_pos     = d)),
    modules.includes('supply')      && safe(fetchSupply).then(d      => d && (result.supply       = d)),
    modules.includes('po_schedule') && safe(fetchPoSchedule).then(d  => d && (result.po_schedule  = d)),
  ].filter(Boolean))

  return NextResponse.json(result)
}
