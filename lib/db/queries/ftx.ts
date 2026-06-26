import { getPool, sql } from '@/lib/db/connections'
import type { InventoryRecord, ADSRecord, ERPPOLine } from '@/lib/engine/types'
import { config } from '@/lib/config'

export async function getInventoryFTX(): Promise<InventoryRecord[]> {
  const pool = await getPool('LCDataFTX')
  const result = await pool.request().query(`
    SELECT
      i.ITEM_ID,
      i.ITEM_SKUUS AS ITEM_SKU,
      ISNULL(inv.TotalUnits, 0) AS TotalUnits
    FROM ITEM i
    LEFT JOIN WPCO_Inventory inv ON inv.ITEM_ID = i.ITEM_ID
    WHERE i.ITEM_Deleted = 0
      AND i.ITEM_SKUUS IS NOT NULL
  `)
  return result.recordset.map((r: any) => ({
    itemId: r.ITEM_ID,
    sku: r.ITEM_SKU ?? '',
    totalUnits: r.TotalUnits ?? 0,
  }))
}

export async function getADSFTX(): Promise<ADSRecord[]> {
  const pool = await getPool('LCDataFTX')
  const result = await pool.request().query(`
    SELECT
      i.ITEM_ID AS ItemId,
      i.ITEM_SKUUS AS ItemSKU,
      ISNULL(SUM(a.ADSW_AverageDailySales), 0) AS ADS
    FROM ITEM i
    LEFT JOIN ADSW a ON a.ADSW_ITEM_ID = i.ITEM_ID AND a.ADSW_Deleted = 0
    WHERE i.ITEM_Deleted = 0
      AND i.ITEM_SKUUS IS NOT NULL
    GROUP BY i.ITEM_ID, i.ITEM_SKUUS
  `)
  return result.recordset.map((r: any) => ({
    itemId: r.ItemId,
    sku: r.ItemSKU ?? '',
    ads: r.ADS ?? 0,
  }))
}

export async function getOpenPOsFTX(cutoffDate?: Date): Promise<ERPPOLine[]> {
  const pool = await getPool('LCDataFTX')
  const vendorId = config.poSchedule.tfmVendorIdFTX
  const req = pool.request().input('VendorId', sql.Int, vendorId)
  if (cutoffDate) req.input('CutoffDate', sql.DateTime, cutoffDate)

  const query = `
    SELECT
      po.ITPO_ID          AS poId,
      pi.ITPI_ID          AS poItemId,
      po.ITPO_PONumber    AS poNumber,
      po.ITPO_EstimatedArrival AS eta,
      pi.ITPI_ITEM_ID     AS itemId,
      i.ITEM_SKUUS        AS sku,
      i.ITEM_ProductName  AS productName,
      pi.ITPI_QtyCases * ISNULL(pi.ITPI_QtyPerCase, 1) AS qty,
      po.ITPO_DraftCompleted AS draftCompleted
    FROM ITPO po
    JOIN ITPI pi ON pi.ITPI_ITPO_ID = po.ITPO_ID
    JOIN ITEM i  ON i.ITEM_ID = pi.ITPI_ITEM_ID
    WHERE po.ITPO_VNDR_ID = @VendorId
      AND po.ITPO_Received = 0
      AND po.ITPO_EstimatedArrival IS NOT NULL
      ${cutoffDate ? 'AND po.ITPO_EstimatedArrival <= @CutoffDate' : ''}
    ORDER BY po.ITPO_EstimatedArrival, i.ITEM_SKUUS
  `
  const result = await req.query(query)
  return result.recordset.map((r: any) => ({
    poId: r.poId,
    poItemId: r.poItemId,
    poNumber: r.poNumber ?? '',
    eta: new Date(r.eta),
    qty: r.qty ?? 0,
    itemId: r.itemId,
    sku: r.sku ?? '',
    productName: r.productName ?? '',
    category: '',
    isNewProduct: false,
  }))
}

export async function getTFMVendorItemIdsFTX(vendorId: number): Promise<Set<number>> {
  const pool = await getPool('LCDataFTX')
  const result = await pool.request()
    .input('VendorId', sql.Int, vendorId)
    .query(`
      SELECT DISTINCT VNIT_ITEM_ID
      FROM VNIT
      WHERE VNIT_VNDR_ID = @VendorId
        AND VNIT_Deleted = 0
    `)
  return new Set(result.recordset.map((r: any) => r.VNIT_ITEM_ID as number))
}

export async function createPOFTX(itemId: number, arrivalDate: Date, qty: number): Promise<void> {
  const pool = await getPool('LCDataFTX')
  const vendorId = config.poSchedule.tfmVendorIdFTX
  await pool.request()
    .input('ItemId', sql.Int, itemId)
    .input('ArrivalDate', sql.DateTime, arrivalDate)
    .input('Qty', sql.Int, qty)
    .input('VendorId', sql.Int, vendorId)
    .query(`
      INSERT INTO ITPO (ITPO_VNDR_ID, ITPO_EstimatedArrival, ITPO_Received, ITPO_DraftCompleted)
      VALUES (@VendorId, @ArrivalDate, 0, 0);
      DECLARE @NewPoId INT = SCOPE_IDENTITY();
      INSERT INTO ITPI (ITPI_ITPO_ID, ITPI_ITEM_ID, ITPI_QtyCases, ITPI_QtyPerCase, ITPI_Units)
      VALUES (@NewPoId, @ItemId, @Qty, 1, -1);
    `)
}

export async function updatePOEtaFTX(poId: number, newEta: Date): Promise<void> {
  const pool = await getPool('LCDataFTX')
  await pool.request()
    .input('PoId', sql.Int, poId)
    .input('NewEta', sql.DateTime, newEta)
    .query(`UPDATE ITPO SET ITPO_EstimatedArrival = @NewEta WHERE ITPO_ID = @PoId`)
}

export async function updatePOQtyFTX(poItemId: number, newQty: number): Promise<void> {
  const pool = await getPool('LCDataFTX')
  await pool.request()
    .input('PoItemId', sql.Int, poItemId)
    .input('NewQty', sql.Int, newQty)
    .query(`UPDATE ITPI SET ITPI_QtyCases = @NewQty WHERE ITPI_ID = @PoItemId`)
}

export async function deletePOFTX(poId: number, poItemId?: number): Promise<void> {
  const pool = await getPool('LCDataFTX')
  if (poItemId) {
    await pool.request()
      .input('PoItemId', sql.Int, poItemId)
      .query(`DELETE FROM ITPI WHERE ITPI_ID = @PoItemId`)
  } else {
    await pool.request()
      .input('PoId', sql.Int, poId)
      .query(`DELETE FROM ITPI WHERE ITPI_ITPO_ID = @PoId; DELETE FROM ITPO WHERE ITPO_ID = @PoId`)
  }
}
