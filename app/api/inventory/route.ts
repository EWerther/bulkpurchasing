/**
 * GET /api/inventory
 * Returns full finished-goods inventory for FTX and SBYL with ADS and DOC.
 * Pulls from LCDataFTX and LCDataSBYL (customer-side warehouses) — NOT TFM.
 * RPKG items (components assembled into a master product) show effective inventory:
 *   effectiveOnHand = masterOnHand + floor(compOnHand / quantity)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getPool, sql } from '@/lib/db/connections'
import { config } from '@/lib/config'

async function fetchInventory(poolName: 'LCDataFTX' | 'LCDataSBYL', vendorId: number, company: 'FTX' | 'SBYL') {
  const pool = await getPool(poolName)

  // Main inventory query — all TFM-linked items
  const result = await pool.request()
    .input('VendorId', sql.Int, vendorId)
    .query(`
      SELECT
        i.ITEM_ID                                                             AS itemId,
        i.ITEM_SKUUS                                                          AS sku,
        ISNULL(i.ITEM_PurchasingName, ISNULL(i.ITEM_ProductName, i.ITEM_SKUUS)) AS productName,
        ISNULL(inv.TotalUnits, 0)                                             AS onHand,
        ISNULL(SUM(a.ADSW_AverageDailySales), 0)                             AS ads
      FROM ITEM i
      JOIN VNIT vi ON vi.VNIT_ITEM_ID = i.ITEM_ID
                  AND vi.VNIT_VNDR_ID = @VendorId
                  AND vi.VNIT_Deleted = 0
      LEFT JOIN WPCO_Inventory inv ON inv.ITEM_ID = i.ITEM_ID
      LEFT JOIN ADSW a ON a.ADSW_ITEM_ID = i.ITEM_ID AND a.ADSW_Deleted = 0
      WHERE i.ITEM_Deleted = 0
        AND i.ITEM_SKUUS IS NOT NULL
      GROUP BY
        i.ITEM_ID, i.ITEM_SKUUS,
        i.ITEM_PurchasingName, i.ITEM_ProductName,
        inv.TotalUnits
      ORDER BY
        CASE WHEN ISNULL(SUM(a.ADSW_AverageDailySales), 0) = 0 THEN 1 ELSE 0 END,
        ISNULL(inv.TotalUnits, 0) / NULLIF(SUM(a.ADSW_AverageDailySales), 0)
    `)

  // RPKG mappings (SBYL only — RPKG table is empty in FTX)
  let rpkgMap = new Map<number, { masterItemId: number; masterSku: string; masterName: string; quantity: number }>()
  let masterInvMap = new Map<number, number>()
  let masterAdsMap = new Map<number, number>()

  if (poolName === 'LCDataSBYL') {
    const rpkgResult = await pool.request()
      .input('VendorId', sql.Int, vendorId)
      .query(`
        SELECT DISTINCT
          r.RPKG_From_ITEM_ID AS componentItemId,
          r.RPKG_To_ITEM_ID   AS masterItemId,
          toItem.ITEM_SKUUS   AS masterSku,
          ISNULL(toItem.ITEM_PurchasingName, ISNULL(toItem.ITEM_ProductName, toItem.ITEM_SKUUS)) AS masterName,
          ISNULL(r.RPKG_Quantity, 1) AS quantity,
          ISNULL(masterInv.TotalUnits, 0) AS masterOnHand,
          ISNULL(SUM(masterAds.ADSW_AverageDailySales), 0) AS masterAds
        FROM RPKG r
        JOIN ITEM fromItem ON fromItem.ITEM_ID = r.RPKG_From_ITEM_ID AND fromItem.ITEM_Deleted = 0
        JOIN ITEM toItem   ON toItem.ITEM_ID   = r.RPKG_To_ITEM_ID   AND toItem.ITEM_Deleted   = 0
        JOIN VNIT vi       ON vi.VNIT_ITEM_ID  = r.RPKG_From_ITEM_ID
                          AND vi.VNIT_VNDR_ID  = @VendorId
                          AND vi.VNIT_Deleted  = 0
        LEFT JOIN WPCO_Inventory masterInv ON masterInv.ITEM_ID = r.RPKG_To_ITEM_ID
        LEFT JOIN ADSW masterAds ON masterAds.ADSW_ITEM_ID = r.RPKG_To_ITEM_ID AND masterAds.ADSW_Deleted = 0
        WHERE r.RPKG_Deleted = 0
        GROUP BY
          r.RPKG_From_ITEM_ID, r.RPKG_To_ITEM_ID,
          toItem.ITEM_SKUUS, toItem.ITEM_PurchasingName, toItem.ITEM_ProductName,
          r.RPKG_Quantity, masterInv.TotalUnits
      `)

    for (const r of rpkgResult.recordset) {
      rpkgMap.set(r.componentItemId, {
        masterItemId: r.masterItemId,
        masterSku:    r.masterSku,
        masterName:   r.masterName,
        quantity:     r.quantity,
      })
      masterInvMap.set(r.componentItemId, r.masterOnHand ?? 0)
      masterAdsMap.set(r.componentItemId, r.masterAds ?? 0)
    }
  }

  // Open incoming POs (ITPO from TFM vendor)
  const poResult = await pool.request()
    .input('VendorId', sql.Int, vendorId)
    .query(`
      SELECT
        pi.ITPI_ITEM_ID                                         AS itemId,
        ISNULL(po.ITPO_PONumber, '')                            AS poNumber,
        po.ITPO_EstimatedArrival                                AS eta,
        ISNULL(pi.ITPI_QtyCases, 0) * ISNULL(pi.ITPI_QtyPerCase, 1) AS qty
      FROM ITPO po
      JOIN ITPI pi ON pi.ITPI_ITPO_ID = po.ITPO_ID
                  AND pi.ITPI_Deleted  = 0
                  AND pi.ITPI_Excluded = 0
      WHERE po.ITPO_VNDR_ID  = @VendorId
        AND po.ITPO_Deleted  = 0
        AND po.ITPO_Received = 0
      ORDER BY po.ITPO_EstimatedArrival
    `)

  const poByItem = new Map<number, { poNumber: string; eta: string; qty: number }[]>()
  for (const r of poResult.recordset) {
    const arr = poByItem.get(r.itemId) ?? []
    arr.push({ poNumber: r.poNumber, eta: new Date(r.eta).toISOString(), qty: r.qty })
    poByItem.set(r.itemId, arr)
  }

  return result.recordset.map((r: any) => {
    const onHand = r.onHand ?? 0
    const ads    = r.ads    ?? 0
    const rpkg   = rpkgMap.get(r.itemId)

    if (rpkg) {
      // RPKG component: show effective inventory breakdown
      const masterOnHand   = masterInvMap.get(r.itemId) ?? 0
      const effectiveOnHand = masterOnHand + Math.floor(onHand / rpkg.quantity)
      const masterAds      = masterAdsMap.get(r.itemId) ?? 0
      const effectiveDOC   = masterAds > 0 ? Math.round((effectiveOnHand / masterAds) * 10) / 10 : null
      return {
        itemId:         r.itemId,
        sku:            r.sku,
        productName:    r.productName,
        company,
        onHand:         effectiveOnHand,   // effective total shown as main figure
        ads:            Math.round(masterAds * 10) / 10,
        doc:            effectiveDOC,
        incomingPos:    poByItem.get(r.itemId) ?? [],
        isRpkg:         true,
        masterSku:      rpkg.masterSku,
        masterName:     rpkg.masterName,
        masterOnHand,                      // assembled units (inside master product)
        looseOnHand:    onHand,            // raw component units not yet assembled
        quantity:       rpkg.quantity,     // components per master unit
      }
    }

    const doc = ads > 0 ? Math.round((onHand / ads) * 10) / 10 : null
    return {
      itemId:      r.itemId,
      sku:         r.sku,
      productName: r.productName,
      company,
      onHand,
      ads:         Math.round(ads * 10) / 10,
      doc,
      incomingPos: poByItem.get(r.itemId) ?? [],
      isRpkg:      false,
    }
  })
}

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const [ftx, sbyl] = await Promise.all([
      fetchInventory('LCDataFTX',  config.poSchedule.tfmVendorIdFTX,  'FTX'),
      fetchInventory('LCDataSBYL', config.poSchedule.tfmVendorIdSBYL, 'SBYL'),
    ])

    return NextResponse.json({ items: [...ftx, ...sbyl] })
  } catch (err: any) {
    console.error('inventory GET error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
