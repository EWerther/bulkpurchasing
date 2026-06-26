import { getPool, sql } from '@/lib/db/connections'

export interface ExistingITPOLine {
  itpoId: number
  itpiId: number
  poNumber: string
  eta: Date
  itemId: number   // FTX or SBYL ITEM_ID
  sku: string
  qtyCases: number
  qty: number      // qtyCases × qtyPerCase
  isAutomated: boolean
  isDraftCompleted: boolean
  doc: number | null
}

/**
 * Fetch all open (not received, not deleted) ITPO lines for the given vendor
 * from fromDate onwards. Used to match against the generated schedule.
 */
export async function getOpenITPOLines(
  poolName: 'LCDataFTX' | 'LCDataSBYL',
  vendorId: number,
  fromDate: Date,
): Promise<ExistingITPOLine[]> {
  const pool = await getPool(poolName)
  const result = await pool.request()
    .input('VendorId', sql.Int, vendorId)
    .input('FromDate', sql.DateTime, fromDate)
    .query(`
      SELECT
        po.ITPO_ID                                          AS itpoId,
        pi.ITPI_ID                                          AS itpiId,
        ISNULL(po.ITPO_PONumber, '')                        AS poNumber,
        po.ITPO_EstimatedArrival                            AS eta,
        pi.ITPI_ITEM_ID                                     AS itemId,
        ISNULL(i.ITEM_SKUUS, '')                            AS sku,
        ISNULL(pi.ITPI_QtyCases, 0)                         AS qtyCases,
        ISNULL(pi.ITPI_QtyCases, 0) * ISNULL(pi.ITPI_QtyPerCase, 1) AS qty,
        po.ITPO_Automated                                   AS isAutomated,
        po.ITPO_DraftCompleted                              AS isDraftCompleted,
        po.ITPO_DOC                                         AS doc
      FROM ITPO po
      JOIN ITPI pi ON pi.ITPI_ITPO_ID = po.ITPO_ID
                  AND pi.ITPI_Deleted = 0
                  AND pi.ITPI_Excluded = 0
      JOIN ITEM i  ON i.ITEM_ID = pi.ITPI_ITEM_ID
      WHERE po.ITPO_VNDR_ID  = @VendorId
        AND po.ITPO_Deleted  = 0
        AND po.ITPO_Received = 0
        AND po.ITPO_EstimatedArrival >= @FromDate
      ORDER BY po.ITPO_EstimatedArrival, i.ITEM_SKUUS
    `)

  return result.recordset.map((r: any) => ({
    itpoId: r.itpoId,
    itpiId: r.itpiId,
    poNumber: r.poNumber,
    eta: new Date(r.eta),
    itemId: r.itemId,
    sku: r.sku,
    qtyCases: r.qtyCases,
    qty: r.qty,
    isAutomated: !!r.isAutomated,
    isDraftCompleted: !!r.isDraftCompleted,
    doc: r.doc ?? null,
  }))
}

/** Look up FTX/SBYL ITEM_IDs by SKU list in one query. */
export async function getItemIdsBySKU(
  poolName: 'LCDataFTX' | 'LCDataSBYL',
  skus: string[],
): Promise<Map<string, number>> {
  if (skus.length === 0) return new Map()
  const pool = await getPool(poolName)
  const placeholders = skus.map((_, i) => `@s${i}`).join(',')
  const req = pool.request()
  skus.forEach((s, i) => req.input(`s${i}`, sql.NVarChar(100), s))
  const result = await req.query(
    `SELECT ITEM_ID, ITEM_SKUUS FROM ITEM WHERE ITEM_SKUUS IN (${placeholders}) AND ITEM_Deleted = 0`
  )
  const map = new Map<string, number>()
  for (const r of result.recordset) {
    if (r.ITEM_SKUUS) map.set(r.ITEM_SKUUS, r.ITEM_ID)
  }
  return map
}
