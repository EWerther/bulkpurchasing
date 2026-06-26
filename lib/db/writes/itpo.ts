/**
 * ITPO / ITPI write operations for FTX and SBYL.
 * All writes are gated by ENABLE_WRITE_ACTIONS in the calling route.
 *
 * Convention:
 *   ITPI_Units = -1  (sentinel — real qty lives in QtyCases × QtyPerCase)
 *   ITPI_QtyPerCase  = 1  (each)
 *   ITPI_QtyCases    = the actual unit count for our purposes
 *   ITPO_Automated   = 1  (marks these as app-generated)
 *   ITPO_Source      = 'BulkPurchasing'
 */

import { getPool, sql } from '@/lib/db/connections'

type PoolName = 'LCDataFTX' | 'LCDataSBYL'

const ENTERED_BY: Record<PoolName, number> = {
  LCDataFTX: 5,
  LCDataSBYL: 2,
}
const PO_PREFIX: Record<PoolName, string> = {
  LCDataFTX: 'FTX',
  LCDataSBYL: 'SBYL',
}
// TFM warehouse IDs — required for the ERP to open the PO correctly.
// FTX  → 47 ("TFM USA LLC", Lansdale PA)
// SBYL → 7  ("TFM", Landsdale PA)
const WAREHOUSE_ID: Record<PoolName, number> = {
  LCDataFTX:  47,
  LCDataSBYL: 7,
}
const SOURCE = 'BulkPurchasing'

/**
 * Insert a new ITPO header and return its ID.
 * PONumber is set to `{prefix}{ITPO_ID}` immediately after insert.
 */
export async function insertITPO(
  poolName: PoolName,
  vendorId: number,
  eta: Date,
  doc: number | null,
): Promise<{ itpoId: number; poNumber: string }> {
  const pool = await getPool(poolName)
  const eb = ENTERED_BY[poolName]

  // Use SCOPE_IDENTITY() instead of OUTPUT INSERTED.ITPO_ID because the ITPO
  // table has triggers enabled, and SQL Server disallows OUTPUT without INTO
  // when triggers are present on the target table.
  const insertResult = await pool.request()
    .input('VendorId',  sql.Int,      vendorId)
    .input('ETA',       sql.DateTime, eta)
    .input('DOC',       sql.Int,      doc)
    .input('EnteredBy', sql.Int,      eb)
    .input('WhseId',    sql.Int,      WAREHOUSE_ID[poolName])
    .input('Source',    sql.NVarChar(100), SOURCE)
    .query(`
      INSERT INTO ITPO (
        ITPO_Deleted, ITPO_Date, ITPO_DateEntered, ITPO_SubmitDate, ITPO_EnteredBy,
        ITPO_VNDR_ID, ITPO_WHSE_ID,
        ITPO_EstimatedArrival, ITPO_DraftCompleted,
        ITPO_Automated, ITPO_DOC, ITPO_Source,
        ITPO_Received, ITPO_Final,
        ITPO_PrintPrices, ITPO_AttnBilling, ITPO_IsForecast
      )
      VALUES (
        0, GETDATE(), GETDATE(), GETDATE(), @EnteredBy,
        @VendorId, @WhseId,
        @ETA, 0,
        1, @DOC, @Source,
        0, 0,
        0, 0, 0
      )
      SELECT SCOPE_IDENTITY() AS ITPO_ID
    `)

  const itpoId: number = insertResult.recordset[0].ITPO_ID
  const poNumber = `${PO_PREFIX[poolName]}${itpoId}`

  await pool.request()
    .input('ITPO_ID',   sql.Int,          itpoId)
    .input('PONumber',  sql.NVarChar(50), poNumber)
    .query(`UPDATE ITPO SET ITPO_PONumber = @PONumber WHERE ITPO_ID = @ITPO_ID`)

  return { itpoId, poNumber }
}

/**
 * Insert a new ITPI line item under an ITPO.
 */
export async function insertITPI(
  poolName: PoolName,
  itpoId: number,
  itemId: number,
  qtyCases: number,
): Promise<number> {
  const pool = await getPool(poolName)
  const eb = ENTERED_BY[poolName]

  const result = await pool.request()
    .input('ITPO_ID',   sql.Int,          itpoId)
    .input('ITEM_ID',   sql.Int,          itemId)
    .input('QtyCases',  sql.Int,          qtyCases)
    .input('EnteredBy', sql.Int,          eb)
    .input('Source',    sql.NVarChar(100), SOURCE)
    .query(`
      INSERT INTO ITPI (
        ITPI_Deleted, ITPI_DateEntered, ITPI_EnteredBy,
        ITPI_ITPO_ID, ITPI_ITEM_ID,
        ITPI_Units, ITPI_QtyCases, ITPI_QtyPerCase,
        ITPI_Excluded, ITPI_Reviewed,
        ITPI_PriceReviewed, ITPI_PIReviewed, ITPI_Source
      )
      VALUES (
        0, GETDATE(), @EnteredBy,
        @ITPO_ID, @ITEM_ID,
        -1, @QtyCases, 1,
        0, 0,
        0, 0, @Source
      )
      SELECT SCOPE_IDENTITY() AS ITPI_ID
    `)

  return result.recordset[0].ITPI_ID
}

/** Update qty on an existing ITPI. */
export async function updateITPIQty(
  poolName: PoolName,
  itpiId: number,
  qtyCases: number,
): Promise<void> {
  const pool = await getPool(poolName)
  await pool.request()
    .input('ITPI_ID',   sql.Int, itpiId)
    .input('QtyCases',  sql.Int, qtyCases)
    .input('UpdatedBy', sql.Int, ENTERED_BY[poolName])
    .query(`
      UPDATE ITPI
      SET ITPI_QtyCases  = @QtyCases,
          ITPI_LastUpdate = GETDATE(),
          ITPI_UpdatedBy  = @UpdatedBy
      WHERE ITPI_ID = @ITPI_ID
    `)
}

/** Update ETA on an existing ITPO header. */
export async function updateITPOETA(
  poolName: PoolName,
  itpoId: number,
  eta: Date,
): Promise<void> {
  const pool = await getPool(poolName)
  await pool.request()
    .input('ITPO_ID',   sql.Int,      itpoId)
    .input('ETA',       sql.DateTime, eta)
    .input('UpdatedBy', sql.Int,      ENTERED_BY[poolName])
    .query(`
      UPDATE ITPO
      SET ITPO_EstimatedArrival = @ETA,
          ITPO_LastUpdate        = GETDATE(),
          ITPO_UpdatedBy         = @UpdatedBy
      WHERE ITPO_ID = @ITPO_ID
    `)
}

/**
 * Soft-delete an ITPI line: set ITPI_Deleted = 1.
 * This is the correct ERP soft-delete mechanism — ITPI_Excluded is a different concept.
 * We never issue a real SQL DELETE on ERP data.
 */
export async function excludeITPI(
  poolName: PoolName,
  itpiId: number,
): Promise<void> {
  const pool = await getPool(poolName)
  await pool.request()
    .input('ITPI_ID',   sql.Int, itpiId)
    .input('UpdatedBy', sql.Int, ENTERED_BY[poolName])
    .query(`
      UPDATE ITPI
      SET ITPI_Deleted    = 1,
          ITPI_LastUpdate  = GETDATE(),
          ITPI_UpdatedBy   = @UpdatedBy
      WHERE ITPI_ID = @ITPI_ID
    `)
}
