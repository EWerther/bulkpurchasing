import { getPool, sql } from '@/lib/db/connections'
import { config } from '@/lib/config'
import type {
  OpenProductionOrderLine,
  FactorySession,
  FactoryProductionLog,
  FactorySessionWithLogs,
} from '@/lib/engine/types'

// ── Read: open production orders from CSGWebPortal ────────────────────────────

export async function getOpenProductionOrders(
  fromDate: Date,
  throughDate: Date,
): Promise<OpenProductionOrderLine[]> {
  const pool = await getPool('CSGWebPortal')
  const allowedCats = config.production.boardAllowedCategories
    .map(c => `'${c}'`)
    .join(',')

  const result = await pool.request()
    .input('FromDate', sql.DateTime, fromDate)
    .input('ThroughDate', sql.DateTime, throughDate)
    .query(`
      SELECT
        l.WHOI_ID                                             AS whoiId,
        h.WHOD_ID                                             AS whodId,
        h.WHOD_OrderNumber                                    AS orderNumber,
        ISNULL(cstr.CSTR_Name, '')                            AS company,
        i.ITEM_SKUUS                                          AS sku,
        l.WHOI_ITEM_ID                                        AS itemId,
        ISNULL(i.ITEM_PurchasingName, i.ITEM_ProductName)    AS productName,
        c.CTGY_Category                                       AS category,
        h.WHOD_ReadyByDate                                    AS readyByDate,
        l.WHOI_QtyCases * ISNULL(l.WHOI_QtyPerCase, 1)       AS orderedQty,
        CASE WHEN l.WHOI_Received = 1 THEN 'Received' ELSE 'Open' END AS lineStatus
      FROM WP_WHOD h
      JOIN WP_WHOI l ON l.WHOI_WHOD_ID = h.WHOD_ID
      LEFT JOIN WP_CSTR cstr ON cstr.CSTR_ID = h.WHOD_CSTR_ID
      JOIN LCData.dbo.ITEM i ON i.ITEM_ID = l.WHOI_ITEM_ID
      LEFT JOIN LCData.dbo.CTGY c ON c.CTGY_ID = i.ITEM_CTGY_ID
      WHERE h.WHOD_Deleted = 0
        AND l.WHOI_Deleted = 0
        AND h.WHOD_Completed IS NULL
        AND h.WHOD_Received = 0
        AND l.WHOI_Received = 0
        AND h.WHOD_ReadyByDate BETWEEN @FromDate AND @ThroughDate
        AND c.CTGY_Category IN (${allowedCats})
      ORDER BY h.WHOD_ReadyByDate, cstr.CSTR_Name, i.ITEM_SKUUS
    `)

  return result.recordset.map((r: any) => ({
    whoiId: r.whoiId,
    whodId: r.whodId,
    orderNumber: r.orderNumber ?? '',
    company: r.company ?? '',
    sku: r.sku ?? '',
    itemId: r.itemId,
    productName: r.productName ?? '',
    category: r.category ?? '',
    readyByDate: new Date(r.readyByDate),
    orderedQty: r.orderedQty ?? 0,
    lineStatus: r.lineStatus,
  }))
}

// ── Read: sessions from CustomDataTFMProd ─────────────────────────────────────

export async function getFactorySessionsForDate(
  dateStr: string,
): Promise<FactorySessionWithLogs[]> {
  const pool = await getPool('CustomDataTFMProd')

  const sessResult = await pool.request()
    .input('SessionDate', sql.Date, dateStr)
    .query(`
      SELECT
        id, session_date, line_number, shift_number,
        whoi_id, whod_id, order_number, sku, product_name,
        target_qty, produced_qty, status, created_at, updated_at
      FROM factory_production_sessions
      WHERE session_date = @SessionDate
      ORDER BY line_number, shift_number, id
    `)

  const sessions: FactorySessionWithLogs[] = sessResult.recordset.map(
    (r: any) => ({
      id: r.id,
      sessionDate: r.session_date instanceof Date
        ? r.session_date.toISOString().split('T')[0]
        : String(r.session_date).split('T')[0],
      lineNumber: r.line_number,
      shiftNumber: r.shift_number,
      whoiId: r.whoi_id,
      whodId: r.whod_id,
      orderNumber: r.order_number,
      sku: r.sku,
      productName: r.product_name,
      targetQty: r.target_qty,
      producedQty: r.produced_qty,
      status: r.status,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      logs: [],
    }),
  )

  if (sessions.length === 0) return sessions

  const sessionIds = sessions.map(s => s.id).join(',')
  const logResult = await pool.request().query(`
    SELECT id, session_id, qty_added, operator_name, note, recorded_at
    FROM factory_production_logs
    WHERE session_id IN (${sessionIds})
    ORDER BY recorded_at DESC
  `)

  const logsBySession = new Map<number, FactoryProductionLog[]>()
  for (const r of logResult.recordset) {
    const log: FactoryProductionLog = {
      id: r.id,
      sessionId: r.session_id,
      qtyAdded: r.qty_added,
      operatorName: r.operator_name ?? null,
      note: r.note ?? null,
      recordedAt: r.recorded_at instanceof Date ? r.recorded_at.toISOString() : String(r.recorded_at),
    }
    const arr = logsBySession.get(r.session_id) ?? []
    arr.push(log)
    logsBySession.set(r.session_id, arr)
  }

  for (const s of sessions) {
    s.logs = logsBySession.get(s.id) ?? []
  }

  return sessions
}

export async function getExistingAssignmentsForDate(date: Date): Promise<number[]> {
  const pool = await getPool('CustomDataTFMProd')
  const dateStr = date.toISOString().split('T')[0]
  const result = await pool.request()
    .input('SessionDate', sql.Date, dateStr)
    .query(`SELECT whoi_id FROM factory_production_sessions WHERE session_date = @SessionDate`)
  return result.recordset.map((r: any) => r.whoi_id)
}

// ── Read: total target qty already assigned per whoiId across all sessions ────

export async function getAssignedTotalsByWhoiId(
  whoiIds: number[],
): Promise<Map<number, number>> {
  if (!whoiIds.length) return new Map()
  const pool = await getPool('CustomDataTFMProd')
  const idList = whoiIds.join(',')
  const result = await pool.request().query(`
    SELECT whoi_id, SUM(target_qty) AS total_assigned
    FROM factory_production_sessions
    WHERE whoi_id IN (${idList})
    GROUP BY whoi_id
  `)
  const map = new Map<number, number>()
  for (const r of result.recordset) {
    map.set(r.whoi_id, r.total_assigned ?? 0)
  }
  return map
}

export interface SessionBreakdownRow {
  sessionDate: string
  lineNumber: number
  shiftNumber: number
  targetQty: number
  producedQty: number
  status: string
}

export async function getSessionBreakdownByWhoiIds(
  whoiIds: number[],
): Promise<Map<number, SessionBreakdownRow[]>> {
  if (!whoiIds.length) return new Map()
  const pool = await getPool('CustomDataTFMProd')
  const idList = whoiIds.join(',')
  const result = await pool.request().query(`
    SELECT whoi_id, session_date, line_number, shift_number, target_qty, produced_qty, status
    FROM factory_production_sessions
    WHERE whoi_id IN (${idList})
    ORDER BY whoi_id, session_date, line_number, shift_number
  `)
  const map = new Map<number, SessionBreakdownRow[]>()
  for (const r of result.recordset) {
    const row: SessionBreakdownRow = {
      sessionDate: r.session_date instanceof Date
        ? r.session_date.toISOString().split('T')[0]
        : String(r.session_date).split('T')[0],
      lineNumber: r.line_number,
      shiftNumber: r.shift_number,
      targetQty: r.target_qty,
      producedQty: r.produced_qty,
      status: r.status,
    }
    const arr = map.get(r.whoi_id) ?? []
    arr.push(row)
    map.set(r.whoi_id, arr)
  }
  return map
}

// ── Writes ────────────────────────────────────────────────────────────────────

export interface AssignmentInput {
  sessionDate: string   // YYYY-MM-DD
  lineNumber: number
  shiftNumber: number
  whoiId: number
  whodId: number
  orderNumber: string
  sku: string
  productName: string
  targetQty: number
}

/**
 * Additive upsert: INSERT new sessions, UPDATE existing ones. Never deletes.
 * To remove a session, call deleteFactorySession separately.
 */
export async function upsertFactorySessions(
  sessionDate: string,
  assignments: AssignmentInput[],
): Promise<void> {
  if (!assignments.length) return
  const pool = await getPool('CustomDataTFMProd')
  const transaction = pool.transaction()
  await transaction.begin()
  try {
    // Load all existing sessions for this date (keyed by whoiId-line-shift)
    const existingResult = await transaction.request()
      .input('SessionDate', sql.Date, sessionDate)
      .query(`
        SELECT id, whoi_id, line_number, shift_number
        FROM factory_production_sessions
        WHERE session_date = @SessionDate
      `)
    const existingMap = new Map<string, number>()
    for (const r of existingResult.recordset) {
      existingMap.set(`${r.whoi_id}-${r.line_number}-${r.shift_number}`, r.id)
    }

    for (const a of assignments) {
      const key = `${a.whoiId}-${a.lineNumber}-${a.shiftNumber}`
      const existingId = existingMap.get(key)

      if (existingId !== undefined) {
        // Session has logs — update in-place rather than delete+insert
        await transaction.request()
          .input('Id',          sql.Int,           existingId)
          .input('WhodId',      sql.Int,           a.whodId)
          .input('OrderNumber', sql.NVarChar(50),  a.orderNumber)
          .input('SKU',         sql.NVarChar(50),  a.sku)
          .input('ProductName', sql.NVarChar(200), a.productName)
          .input('TargetQty',   sql.Int,           a.targetQty)
          .query(`
            UPDATE factory_production_sessions
            SET whod_id = @WhodId, order_number = @OrderNumber, sku = @SKU,
                product_name = @ProductName, target_qty = @TargetQty
            WHERE id = @Id
          `)
      } else {
        // New session — insert fresh
        await transaction.request()
          .input('SessionDate',  sql.Date,         a.sessionDate)
          .input('Line',         sql.TinyInt,       a.lineNumber)
          .input('Shift',        sql.TinyInt,       a.shiftNumber)
          .input('WhoiId',       sql.Int,           a.whoiId)
          .input('WhodId',       sql.Int,           a.whodId)
          .input('OrderNumber',  sql.NVarChar(50),  a.orderNumber)
          .input('SKU',          sql.NVarChar(50),  a.sku)
          .input('ProductName',  sql.NVarChar(200), a.productName)
          .input('TargetQty',    sql.Int,           a.targetQty)
          .query(`
            INSERT INTO factory_production_sessions
              (session_date, line_number, shift_number, whoi_id, whod_id,
               order_number, sku, product_name, target_qty, produced_qty, status)
            VALUES
              (@SessionDate, @Line, @Shift, @WhoiId, @WhodId,
               @OrderNumber, @SKU, @ProductName, @TargetQty, 0, 'pending')
          `)
      }
    }

    await transaction.commit()
  } catch (err) {
    await transaction.rollback()
    throw err
  }
}

/**
 * Explicitly delete a session (and its logs) for a given date/order/line/shift.
 * Used when the user removes an assignment from the plan.
 */
export async function deleteFactorySession(
  sessionDate: string,
  whoiId: number,
  lineNumber: number,
  shiftNumber: number,
): Promise<void> {
  const pool = await getPool('CustomDataTFMProd')
  const transaction = pool.transaction()
  await transaction.begin()
  try {
    // Delete logs first (FK constraint)
    await transaction.request()
      .input('SessionDate', sql.Date,    sessionDate)
      .input('WhoiId',      sql.Int,     whoiId)
      .input('Line',        sql.TinyInt, lineNumber)
      .input('Shift',       sql.TinyInt, shiftNumber)
      .query(`
        DELETE l FROM factory_production_logs l
        JOIN factory_production_sessions s ON s.id = l.session_id
        WHERE s.session_date = @SessionDate
          AND s.whoi_id = @WhoiId
          AND s.line_number = @Line
          AND s.shift_number = @Shift
      `)
    // Then delete the session itself
    await transaction.request()
      .input('SessionDate', sql.Date,    sessionDate)
      .input('WhoiId',      sql.Int,     whoiId)
      .input('Line',        sql.TinyInt, lineNumber)
      .input('Shift',       sql.TinyInt, shiftNumber)
      .query(`
        DELETE FROM factory_production_sessions
        WHERE session_date = @SessionDate
          AND whoi_id = @WhoiId
          AND line_number = @Line
          AND shift_number = @Shift
      `)
    await transaction.commit()
  } catch (err) {
    await transaction.rollback()
    throw err
  }
}

// ── Read: production report (historical, aggregated by date/line/shift) ───────

export interface ProductionReportRow {
  sessionDate: string
  lineNumber: number
  shiftNumber: number
  sku: string
  targetQty: number
  producedQty: number
}

export async function getProductionReport(
  fromDate: Date,
  throughDate: Date,
): Promise<ProductionReportRow[]> {
  const pool = await getPool('CustomDataTFMProd')
  const result = await pool.request()
    .input('FromDate',   sql.Date, fromDate)
    .input('ThroughDate', sql.Date, throughDate)
    .query(`
      SELECT
        CAST(session_date AS DATE) AS session_date,
        line_number, shift_number, sku, target_qty, produced_qty
      FROM factory_production_sessions
      WHERE session_date >= @FromDate AND session_date <= @ThroughDate
      ORDER BY session_date, line_number, shift_number, id
    `)
  return result.recordset.map((r: any) => ({
    sessionDate: r.session_date instanceof Date
      ? r.session_date.toISOString().split('T')[0]
      : String(r.session_date).split('T')[0],
    lineNumber:  r.line_number,
    shiftNumber: r.shift_number,
    sku:         r.sku ?? '',
    targetQty:   r.target_qty ?? 0,
    producedQty: r.produced_qty ?? 0,
  }))
}

export async function getSessionsWithLogsByCell(
  date: string,
  lineNumber: number,
  shiftNumber: number,
): Promise<FactorySessionWithLogs[]> {
  const pool = await getPool('CustomDataTFMProd')
  const sessResult = await pool.request()
    .input('SessionDate', sql.Date, date)
    .input('Line', sql.TinyInt, lineNumber)
    .input('Shift', sql.TinyInt, shiftNumber)
    .query(`
      SELECT id, session_date, line_number, shift_number,
        whoi_id, whod_id, order_number, sku, product_name,
        target_qty, produced_qty, status, created_at, updated_at
      FROM factory_production_sessions
      WHERE session_date = @SessionDate
        AND line_number = @Line
        AND shift_number = @Shift
      ORDER BY id
    `)

  const sessions: FactorySessionWithLogs[] = sessResult.recordset.map((r: any) => ({
    id: r.id,
    sessionDate: r.session_date instanceof Date
      ? r.session_date.toISOString().split('T')[0]
      : String(r.session_date).split('T')[0],
    lineNumber: r.line_number,
    shiftNumber: r.shift_number,
    whoiId: r.whoi_id,
    whodId: r.whod_id,
    orderNumber: r.order_number,
    sku: r.sku,
    productName: r.product_name,
    targetQty: r.target_qty,
    producedQty: r.produced_qty,
    status: r.status,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    logs: [],
  }))

  if (sessions.length === 0) return sessions

  const sessionIds = sessions.map(s => s.id).join(',')
  const logResult = await pool.request().query(`
    SELECT id, session_id, qty_added, operator_name, note, recorded_at
    FROM factory_production_logs
    WHERE session_id IN (${sessionIds})
    ORDER BY recorded_at DESC
  `)

  const logsBySession = new Map<number, FactoryProductionLog[]>()
  for (const r of logResult.recordset) {
    const log: FactoryProductionLog = {
      id: r.id,
      sessionId: r.session_id,
      qtyAdded: r.qty_added,
      operatorName: r.operator_name ?? null,
      note: r.note ?? null,
      recordedAt: r.recorded_at instanceof Date ? r.recorded_at.toISOString() : String(r.recorded_at),
    }
    const arr = logsBySession.get(r.session_id) ?? []
    arr.push(log)
    logsBySession.set(r.session_id, arr)
  }

  for (const s of sessions) {
    s.logs = logsBySession.get(s.id) ?? []
  }

  return sessions
}

export async function deleteFactoryLog(logId: number): Promise<{ sessionId: number; newTotal: number }> {
  const pool = await getPool('CustomDataTFMProd')
  const t = pool.transaction()
  await t.begin()
  try {
    const lr = await t.request().input('Id', sql.Int, logId)
      .query('SELECT session_id FROM factory_production_logs WHERE id = @Id')
    if (!lr.recordset.length) throw new Error('Log entry not found')
    const sessionId: number = lr.recordset[0].session_id

    await t.request().input('Id', sql.Int, logId)
      .query('DELETE FROM factory_production_logs WHERE id = @Id')

    const ur = await t.request().input('Sid', sql.Int, sessionId).query(`
      DECLARE @tot INT = ISNULL((SELECT SUM(qty_added) FROM factory_production_logs WHERE session_id = @Sid), 0)
      UPDATE factory_production_sessions
      SET produced_qty = @tot,
          status = CASE WHEN @tot = 0 THEN 'pending' WHEN @tot >= target_qty THEN 'complete' ELSE 'active' END,
          updated_at = GETDATE()
      WHERE id = @Sid
      SELECT @tot AS newTotal
    `)
    await t.commit()
    return { sessionId, newTotal: ur.recordset[0].newTotal }
  } catch (err) { await t.rollback(); throw err }
}

export async function updateFactoryLog(logId: number, newQty: number): Promise<{ sessionId: number; newTotal: number }> {
  const pool = await getPool('CustomDataTFMProd')
  const t = pool.transaction()
  await t.begin()
  try {
    const lr = await t.request().input('Id', sql.Int, logId)
      .query('SELECT session_id FROM factory_production_logs WHERE id = @Id')
    if (!lr.recordset.length) throw new Error('Log entry not found')
    const sessionId: number = lr.recordset[0].session_id

    await t.request().input('Id', sql.Int, logId).input('Qty', sql.Int, newQty)
      .query('UPDATE factory_production_logs SET qty_added = @Qty WHERE id = @Id')

    const ur = await t.request().input('Sid', sql.Int, sessionId).query(`
      DECLARE @tot INT = ISNULL((SELECT SUM(qty_added) FROM factory_production_logs WHERE session_id = @Sid), 0)
      UPDATE factory_production_sessions
      SET produced_qty = @tot,
          status = CASE WHEN @tot = 0 THEN 'pending' WHEN @tot >= target_qty THEN 'complete' ELSE 'active' END,
          updated_at = GETDATE()
      WHERE id = @Sid
      SELECT @tot AS newTotal
    `)
    await t.commit()
    return { sessionId, newTotal: ur.recordset[0].newTotal }
  } catch (err) { await t.rollback(); throw err }
}

/**
 * Log a production update — increments produced_qty on the session and
 * inserts a log entry. Returns the updated produced_qty.
 */
export async function logFactoryProduction(
  sessionId: number,
  qtyAdded: number,
  operatorName: string | null,
  note: string | null,
): Promise<number> {
  const pool = await getPool('CustomDataTFMProd')
  const transaction = pool.transaction()
  await transaction.begin()
  try {
    // Insert log entry
    await transaction.request()
      .input('SessionId',    sql.Int,          sessionId)
      .input('QtyAdded',     sql.Int,          qtyAdded)
      .input('OperatorName', sql.NVarChar(100), operatorName)
      .input('Note',         sql.NVarChar(500), note)
      .query(`
        INSERT INTO factory_production_logs (session_id, qty_added, operator_name, note)
        VALUES (@SessionId, @QtyAdded, @OperatorName, @Note)
      `)

    // Update session
    const updateResult = await transaction.request()
      .input('SessionId', sql.Int, sessionId)
      .input('QtyAdded',  sql.Int, qtyAdded)
      .query(`
        UPDATE factory_production_sessions
        SET produced_qty = produced_qty + @QtyAdded,
            status = CASE
              WHEN produced_qty + @QtyAdded = 0               THEN 'pending'
              WHEN produced_qty + @QtyAdded >= target_qty     THEN 'complete'
              ELSE 'active'
            END,
            updated_at = GETDATE()
        OUTPUT INSERTED.produced_qty
        WHERE id = @SessionId
      `)

    await transaction.commit()
    return updateResult.recordset[0]?.produced_qty ?? 0
  } catch (err) {
    await transaction.rollback()
    throw err
  }
}
