import { getPool, sql } from '@/lib/db/connections'
import type { SupplyItem, SupplyPOArrival } from '@/lib/engine/types'
import { config } from '@/lib/config'

export interface TFMItemRecord {
  tfmItemId: number
  tfmSKU: string
  tfmProductName: string
  category: string
}

export async function getTFMItemsBySKU(skus: string[]): Promise<Map<string, TFMItemRecord>> {
  if (!skus.length) return new Map()
  const pool = await getPool('LCDataTFM')
  const skuList = skus.map(s => `'${s.replace(/'/g, "''")}'`).join(',')
  const result = await pool.request().query(`
    SELECT i.ITEM_ID AS tfmItemId, i.ITEM_SKUUS AS tfmSKU,
           ISNULL(i.ITEM_PurchasingName, i.ITEM_ProductName) AS tfmProductName,
           c.CTGY_Category AS category
    FROM ITEM i
    LEFT JOIN CTGY c ON c.CTGY_ID = i.ITEM_CTGY_ID
    WHERE i.ITEM_SKUUS IN (${skuList})
  `)
  const map = new Map<string, TFMItemRecord>()
  for (const r of result.recordset) {
    map.set(r.tfmSKU, {
      tfmItemId: r.tfmItemId,
      tfmSKU: r.tfmSKU,
      tfmProductName: r.tfmProductName ?? '',
      category: r.category ?? '',
    })
  }
  return map
}

export interface SupplyOnHand {
  itemId: number
  sku: string
  name: string
  category: string
  onHandQty: number
}

export async function getSupplyOnHand(): Promise<SupplyOnHand[]> {
  const pool = await getPool('LCDataTFM')
  const ignoredCats = config.production.feasibilityIgnoredCategories.map(c => `'${c}'`).join(',')
  const ignoredSKUs = config.production.feasibilityIgnoredSKUs.map(s => `'${s}'`).join(',')
  const result = await pool.request().query(`
    SELECT
      i.ITEM_ID   AS itemId,
      i.ITEM_SKUUS  AS sku,
      ISNULL(i.ITEM_PurchasingName, i.ITEM_ProductName) AS name,
      c.CTGY_Category AS category,
      ISNULL(w.TotalUnits, 0) AS onHandQty
    FROM ITEM i
    LEFT JOIN CTGY c ON c.CTGY_ID = i.ITEM_CTGY_ID
    LEFT JOIN WPCO_Inventory w ON w.ITEM_ID = i.ITEM_ID
    WHERE c.CTGY_Category NOT IN (${ignoredCats})
      AND i.ITEM_SKUUS NOT IN (${ignoredSKUs})
  `)
  return result.recordset.map((r: any) => ({
    itemId: r.itemId,
    sku: r.sku ?? '',
    name: r.name ?? '',
    category: r.category ?? '',
    onHandQty: r.onHandQty ?? 0,
  }))
}

export async function getAllSupplyOnHand(): Promise<SupplyOnHand[]> {
  const pool = await getPool('LCDataTFM')
  const result = await pool.request().query(`
    SELECT
      i.ITEM_ID   AS itemId,
      i.ITEM_SKUUS  AS sku,
      ISNULL(i.ITEM_PurchasingName, i.ITEM_ProductName) AS name,
      c.CTGY_Category AS category,
      ISNULL(w.TotalUnits, 0) AS onHandQty
    FROM ITEM i
    LEFT JOIN CTGY c ON c.CTGY_ID = i.ITEM_CTGY_ID
    LEFT JOIN WPCO_Inventory w ON w.ITEM_ID = i.ITEM_ID
  `)
  return result.recordset.map((r: any) => ({
    itemId: r.itemId,
    sku: r.sku ?? '',
    name: r.name ?? '',
    category: r.category ?? '',
    onHandQty: r.onHandQty ?? 0,
  }))
}

export interface SupplyPORecord {
  itemId: number
  poId: number
  poNumber: string
  eta: Date
  qty: number
}

/**
 * Fetch ALL open (not received, not deleted) supply POs regardless of ETA date.
 * POs with a past ETA that haven't arrived yet are still real stock commitments
 * and must be included in supply planning with effective ETA = today.
 */
export async function getSupplyFuturePOs(): Promise<SupplyPORecord[]> {
  const pool = await getPool('LCDataTFM')
  const result = await pool.request()
    .query(`
      SELECT
        pi.ITPI_ITEM_ID  AS itemId,
        pi.ITPI_ID       AS poId,    -- use ITPI_ID (line level) not ITPO_ID so multi-line POs
        po.ITPO_PONumber AS poNumber, -- don't block each other in creditedPoIds
        po.ITPO_EstimatedArrival AS eta,
        pi.ITPI_QtyCases * ISNULL(pi.ITPI_QtyPerCase, 1) AS qty
      FROM ITPO po
      JOIN ITPI pi ON pi.ITPI_ITPO_ID = po.ITPO_ID
                  AND pi.ITPI_Excluded = 0
      WHERE po.ITPO_Received = 0
        AND po.ITPO_EstimatedArrival IS NOT NULL
      ORDER BY po.ITPO_EstimatedArrival
    `)
  return result.recordset.map((r: any) => ({
    itemId:    r.itemId,
    poId:      r.poId,
    poNumber:  r.poNumber ?? '',
    eta:       new Date(r.eta),
    qty:       r.qty ?? 0,
  }))
}

export interface TFMSupplyPOSummary {
  poId: number
  poNumber: string
  vendorName: string
  poDate: Date | null
  submitDate: Date | null
  eta: Date | null
  etd: Date | null
  isReceived: boolean
  receivedDate: Date | null
  isDraftCompleted: boolean
  isFinal: boolean
  isForecast: boolean
  bookingNumber: string | null
  containerSize: string | null
  lineCount: number
  totalQty: number
}

export interface TFMSupplyPOLine {
  lineId: number
  itpoId: number
  itemId: number
  sku: string
  itemName: string
  category: string
  qty: number
  costPerUnit: number | null
  note: string | null
}

export async function getTFMSupplyPOList(): Promise<TFMSupplyPOSummary[]> {
  const pool = await getPool('LCDataTFM')
  const result = await pool.request().query(`
    SELECT
      po.ITPO_ID                                                    AS poId,
      po.ITPO_PONumber                                              AS poNumber,
      ISNULL(v.VNDR_Name, po.ITPO_Vendor)                          AS vendorName,
      po.ITPO_Date                                                  AS poDate,
      po.ITPO_SubmitDate                                            AS submitDate,
      po.ITPO_EstimatedArrival                                      AS eta,
      po.ITPO_ETD                                                   AS etd,
      po.ITPO_Received                                              AS isReceived,
      po.ITPO_ReceivedDate                                          AS receivedDate,
      po.ITPO_DraftCompleted                                        AS isDraftCompleted,
      po.ITPO_Final                                                 AS isFinal,
      po.ITPO_IsForecast                                            AS isForecast,
      po.ITPO_BookingNumber                                         AS bookingNumber,
      po.ITPO_ContainerSize                                         AS containerSize,
      (SELECT COUNT(*)
       FROM ITPI pi
       WHERE pi.ITPI_ITPO_ID = po.ITPO_ID
         AND pi.ITPI_Excluded = 0)                                  AS lineCount,
      ISNULL(
        (SELECT SUM(pi2.ITPI_QtyCases * ISNULL(pi2.ITPI_QtyPerCase, 1))
         FROM ITPI pi2
         WHERE pi2.ITPI_ITPO_ID = po.ITPO_ID
           AND pi2.ITPI_Excluded = 0), 0)                           AS totalQty
    FROM ITPO po
    LEFT JOIN VNDR v ON v.VNDR_ID = po.ITPO_VNDR_ID
    ORDER BY po.ITPO_EstimatedArrival DESC, po.ITPO_ID DESC
  `)
  return result.recordset.map((r: any) => ({
    poId:            r.poId,
    poNumber:        r.poNumber ?? '',
    vendorName:      r.vendorName ?? 'Unknown Vendor',
    poDate:          r.poDate    ? new Date(r.poDate)    : null,
    submitDate:      r.submitDate ? new Date(r.submitDate) : null,
    eta:             r.eta        ? new Date(r.eta)        : null,
    etd:             r.etd        ? new Date(r.etd)        : null,
    isReceived:      !!r.isReceived,
    receivedDate:    r.receivedDate ? new Date(r.receivedDate) : null,
    isDraftCompleted: !!r.isDraftCompleted,
    isFinal:         !!r.isFinal,
    isForecast:      !!r.isForecast,
    bookingNumber:   r.bookingNumber  ?? null,
    containerSize:   r.containerSize  ?? null,
    lineCount:       r.lineCount      ?? 0,
    totalQty:        r.totalQty       ?? 0,
  }))
}

export async function getTFMSupplyPOLines(itpoId: number): Promise<TFMSupplyPOLine[]> {
  const pool = await getPool('LCDataTFM')
  const result = await pool.request()
    .input('PoId', sql.Int, itpoId)
    .query(`
      SELECT
        pi.ITPI_ID                                                          AS lineId,
        pi.ITPI_ITPO_ID                                                     AS itpoId,
        pi.ITPI_ITEM_ID                                                     AS itemId,
        i.ITEM_SKUUS                                                        AS sku,
        ISNULL(pi.ITPI_PurchasingName,
          ISNULL(i.ITEM_PurchasingName, i.ITEM_ProductName))                AS itemName,
        ISNULL(c.CTGY_Category, '')                                         AS category,
        pi.ITPI_QtyCases * ISNULL(pi.ITPI_QtyPerCase, 1)                   AS qty,
        pi.ITPI_CostPerUnit                                                 AS costPerUnit,
        pi.ITPI_Note                                                        AS note
      FROM ITPI pi
      JOIN ITEM i ON i.ITEM_ID = pi.ITPI_ITEM_ID
      LEFT JOIN CTGY c ON c.CTGY_ID = i.ITEM_CTGY_ID
      WHERE pi.ITPI_ITPO_ID = @PoId
        AND pi.ITPI_Excluded = 0
      ORDER BY pi.ITPI_ID
    `)
  return result.recordset.map((r: any) => ({
    lineId:      r.lineId,
    itpoId:      r.itpoId,
    itemId:      r.itemId,
    sku:         r.sku         ?? '',
    itemName:    r.itemName    ?? '',
    category:    r.category    ?? '',
    qty:         r.qty         ?? 0,
    costPerUnit: r.costPerUnit ?? null,
    note:        r.note        ?? null,
  }))
}

export async function getSupplyFuturePOsExcluding(excludeItpoId: number): Promise<SupplyPORecord[]> {
  const pool = await getPool('LCDataTFM')
  const result = await pool.request()
    .input('ExcludeItpoId', sql.Int, excludeItpoId)
    .query(`
      SELECT
        pi.ITPI_ITEM_ID                                           AS itemId,
        pi.ITPI_ID                                               AS poId,
        po.ITPO_PONumber                                         AS poNumber,
        po.ITPO_EstimatedArrival                                 AS eta,
        pi.ITPI_QtyCases * ISNULL(pi.ITPI_QtyPerCase, 1)        AS qty
      FROM ITPO po
      JOIN ITPI pi ON pi.ITPI_ITPO_ID = po.ITPO_ID
                  AND pi.ITPI_Excluded = 0
      WHERE po.ITPO_Received = 0
        AND po.ITPO_EstimatedArrival IS NOT NULL
        AND po.ITPO_ID <> @ExcludeItpoId
      ORDER BY po.ITPO_EstimatedArrival
    `)
  return result.recordset.map((r: any) => ({
    itemId:   r.itemId,
    poId:     r.poId,
    poNumber: r.poNumber ?? '',
    eta:      new Date(r.eta),
    qty:      r.qty ?? 0,
  }))
}

export interface VendorLeadTime {
  itemId: number
  leadTimeDays: number
}

export async function getVendorLeadTimes(): Promise<Map<number, number>> {
  const pool = await getPool('LCDataTFM')
  const result = await pool.request().query(`
    SELECT
      vi.VNIT_ITEM_ID AS itemId,
      MIN(v.VNDR_LeadTime) AS leadTimeDays
    FROM VNIT vi
    JOIN VNDR v ON v.VNDR_ID = vi.VNIT_VNDR_ID
    WHERE v.VNDR_LeadTime IS NOT NULL
    GROUP BY vi.VNIT_ITEM_ID
  `)
  const map = new Map<number, number>()
  for (const r of result.recordset) {
    map.set(r.itemId, r.leadTimeDays ?? 30)
  }
  return map
}

export interface VendorInfo {
  leadTimeDays: number
  targetDocDays: number
  vendorName: string
  isDefault: boolean   // false = no default set; fell back to an arbitrary vendor
}

export async function getVendorInfo(): Promise<Map<number, VendorInfo>> {
  const pool = await getPool('LCDataTFM')
  // ROW_NUMBER ordered by VNIT_IsDefault DESC so the default vendor row is always rn=1.
  // If no default exists for an item, any vendor is chosen (VNIT_ID ASC for stability).
  const result = await pool.request().query(`
    SELECT
      vi.VNIT_ITEM_ID  AS itemId,
      v.VNDR_LeadTime  AS leadTimeDays,
      v.VNDR_PreferredDOC AS targetDocDays,
      v.VNDR_Name      AS vendorName,
      vi.VNIT_IsDefault AS isDefault
    FROM (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY VNIT_ITEM_ID
          ORDER BY VNIT_IsDefault DESC, VNIT_ID ASC
        ) AS rn
      FROM VNIT
    ) vi
    JOIN VNDR v ON v.VNDR_ID = vi.VNIT_VNDR_ID
    WHERE vi.rn = 1
  `)
  const map = new Map<number, VendorInfo>()
  for (const r of result.recordset) {
    map.set(r.itemId, {
      leadTimeDays:  r.leadTimeDays  ?? 30,
      targetDocDays: r.targetDocDays ?? 0,
      vendorName:    r.vendorName    ?? 'Unknown Vendor',
      isDefault:     !!r.isDefault,
    })
  }
  return map
}

// ── Vendor options for supply purchasing modal ────────────────────────────────

export interface VendorOption {
  vndrId: number
  vndrName: string
  isDefault: boolean
  cost: number | null
  partNumber: string | null
  leadTimeDays: number | null
  minimum: number | null
}

export async function getVendorOptionsForItems(
  itemIds: number[],
): Promise<Map<number, { vendors: VendorOption[]; itemPartNumber: string | null; qtyPerCase: number | null }>> {
  if (!itemIds.length) return new Map()
  const pool = await getPool('LCDataTFM')
  const idList = itemIds.join(',')

  const [vnResult, itemResult] = await Promise.all([
    pool.request().query(`
      SELECT
        vi.VNIT_ITEM_ID   AS itemId,
        vi.VNIT_VNDR_ID   AS vndrId,
        v.VNDR_Name        AS vndrName,
        vi.VNIT_IsDefault  AS isDefault,
        vi.VNIT_Cost       AS cost,
        vi.VNIT_PartNumber AS partNumber,
        v.VNDR_LeadTime    AS leadTimeDays,
        vi.VNIT_Minimum    AS minimum
      FROM VNIT vi
      JOIN VNDR v ON v.VNDR_ID = vi.VNIT_VNDR_ID
      WHERE vi.VNIT_ITEM_ID IN (${idList})
      ORDER BY vi.VNIT_ITEM_ID, vi.VNIT_IsDefault DESC, vi.VNIT_ID ASC
    `),
    pool.request().query(`
      SELECT ITEM_ID, ITEM_ManufacturerPartNumber, ITEM_QtyPerCase
      FROM ITEM
      WHERE ITEM_ID IN (${idList})
    `),
  ])

  const itemMeta = new Map<number, { partNumber: string | null; qtyPerCase: number | null }>()
  for (const r of itemResult.recordset) {
    itemMeta.set(r.ITEM_ID, {
      partNumber: r.ITEM_ManufacturerPartNumber ?? null,
      qtyPerCase: r.ITEM_QtyPerCase > 0 ? r.ITEM_QtyPerCase : null,
    })
  }

  const out = new Map<number, { vendors: VendorOption[]; itemPartNumber: string | null; qtyPerCase: number | null }>()
  for (const id of itemIds) {
    const meta = itemMeta.get(id)
    out.set(id, { vendors: [], itemPartNumber: meta?.partNumber ?? null, qtyPerCase: meta?.qtyPerCase ?? null })
  }
  for (const r of vnResult.recordset) {
    const entry = out.get(r.itemId)
    if (entry) {
      entry.vendors.push({
        vndrId: r.vndrId,
        vndrName: r.vndrName ?? '',
        isDefault: !!r.isDefault,
        cost: r.cost ?? null,
        partNumber: r.partNumber ?? null,
        leadTimeDays: r.leadTimeDays ?? null,
        minimum: r.minimum ?? null,
      })
    }
  }
  return out
}

// ── Create supply PO in TFM LCData ───────────────────────────────────────────

export interface SupplyPOLine {
  itemId: number
  qtyCases: number
  qtyPerCase: number
  costPerUnit: number | null
  partNumber: string | null
  purchasingName: string | null
}

export async function createTFMSupplyPO(
  vendorId: number,
  submitDate: Date | null,
  eta: Date | null,
  etd: Date | null,
  readyDate: Date | null,
  lines: SupplyPOLine[],
): Promise<number> {
  if (!lines.length) throw new Error('No lines provided')
  const pool = await getPool('LCDataTFM')
  const transaction = pool.transaction()
  await transaction.begin()
  try {
    const hdrReq = transaction.request()
      .input('VndrId',     sql.Int,           vendorId)
      .input('SubmitDate', sql.DateTime,       submitDate)
      .input('ETA',        sql.DateTime,       eta)
      .input('ETD',        sql.DateTime,       etd)
      .input('ReadyDate',  sql.DateTime,       readyDate)
      .input('WhseId',     sql.Int,            config.supplyPurchasing.tfmWarehouseId)
      .input('Source',     sql.NVarChar(100),  config.supplyPurchasing.source)

    const hdrResult = await hdrReq.query(`
      INSERT INTO tITPO (
        ITPO_Deleted, ITPO_DateEntered, ITPO_EnteredBy,
        ITPO_DraftCompleted, ITPO_Received, ITPO_Automated,
        ITPO_Final, ITPO_IsForecast, ITPO_PrintPrices, ITPO_AttnBilling,
        ITPO_VNDR_ID, ITPO_WHSE_ID, ITPO_Source,
        ITPO_Date, ITPO_SubmitDate, ITPO_EstimatedArrival, ITPO_ETD, ITPO_ReadyDate
      )
      VALUES (
        0, GETDATE(), 5,
        0, 0, 0,
        0, 0, 0, 0,
        @VndrId, @WhseId, @Source,
        GETDATE(), @SubmitDate, @ETA, @ETD, @ReadyDate
      );
      DECLARE @newId INT = SCOPE_IDENTITY();
      UPDATE tITPO SET ITPO_PONumber = CAST(@newId AS NVARCHAR(20)) WHERE ITPO_ID = @newId;
      SELECT @newId AS newId;
    `)
    const poId: number = hdrResult.recordset[0].newId

    for (const line of lines) {
      await transaction.request()
        .input('PoId',          sql.Int,           poId)
        .input('ItemId',        sql.Int,            line.itemId)
        .input('QtyCases',      sql.Int,            line.qtyCases)
        .input('QtyPerCase',    sql.Int,            line.qtyPerCase)
        .input('Cost',          sql.Money,          line.costPerUnit)
        .input('PartNumber',    sql.NVarChar(50),   line.partNumber)
        .input('PurchasingName', sql.NVarChar(250), line.purchasingName)
        .query(`
          INSERT INTO tITPI (
            ITPI_Deleted, ITPI_DateEntered, ITPI_EnteredBy,
            ITPI_Excluded, ITPI_Reviewed, ITPI_PriceReviewed, ITPI_PIReviewed,
            ITPI_ITPO_ID, ITPI_ITEM_ID,
            ITPI_QtyCases, ITPI_QtyPerCase, ITPI_Units,
            ITPI_CostPerUnit, ITPI_PartNumber, ITPI_PurchasingName
          )
          VALUES (
            0, GETDATE(), 5,
            0, 0, 0, 0,
            @PoId, @ItemId,
            @QtyCases, @QtyPerCase, -1,
            @Cost, @PartNumber, @PurchasingName
          )
        `)
    }

    await transaction.commit()
    return poId
  } catch (err) {
    await transaction.rollback()
    throw err
  }
}
