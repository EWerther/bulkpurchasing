import { getPool, sql } from '@/lib/db/connections'
import type { CustomerOrder, ProductionBoardItem, ProductionBoardDay } from '@/lib/engine/types'
import { config } from '@/lib/config'

export async function getCustomerOrders(fromDate: Date, throughDate: Date): Promise<CustomerOrder[]> {
  const pool = await getPool('CSGWebPortal')
  const allowedCats = config.production.boardAllowedCategories.map(c => `'${c}'`).join(',')

  const result = await pool.request()
    .input('FromDate', sql.DateTime, fromDate)
    .input('ThroughDate', sql.DateTime, throughDate)
    .query(`
      SELECT
        h.WHOD_ID                                             AS orderId,
        h.WHOD_OrderNumber                                    AS orderNumber,
        ISNULL(cstr.CSTR_Name, '')                            AS company,
        i.ITEM_SKUUS                                          AS sku,
        l.WHOI_ITEM_ID                                        AS itemId,
        ISNULL(i.ITEM_PurchasingName, i.ITEM_ProductName)    AS productName,
        c.CTGY_Category                                       AS category,
        h.WHOD_ReadyByDate                                    AS readyByDate,
        l.WHOI_QtyCases * ISNULL(l.WHOI_QtyPerCase, 1)       AS orderedQty,
        CASE WHEN l.WHOI_Received = 1 THEN 'Received' ELSE 'Open' END AS lineStatus,
        h.WHOD_Deleted                                        AS isDeleted,
        h.WHOD_Completed                                      AS isCompleted,
        h.WHOD_Received                                       AS isReceived
      FROM WP_WHOD h
      JOIN WP_WHOI l ON l.WHOI_WHOD_ID = h.WHOD_ID
                    AND l.WHOI_Deleted = 0
      LEFT JOIN WP_CSTR cstr ON cstr.CSTR_ID = h.WHOD_CSTR_ID
      JOIN LCData.dbo.ITEM i ON i.ITEM_ID = l.WHOI_ITEM_ID
      LEFT JOIN LCData.dbo.CTGY c ON c.CTGY_ID = i.ITEM_CTGY_ID
      WHERE h.WHOD_Deleted = 0
        AND h.WHOD_ReadyByDate BETWEEN @FromDate AND @ThroughDate
        AND c.CTGY_Category IN (${allowedCats})
      ORDER BY h.WHOD_ReadyByDate, cstr.CSTR_Name, i.ITEM_SKUUS
    `)

  return result.recordset
    .filter((r: any) => !r.isCompleted && !r.isReceived)
    .map((r: any) => ({
      orderId: r.orderId,
      orderNumber: r.orderNumber ?? '',
      company: r.company ?? '',
      sku: r.sku ?? '',
      itemId: r.itemId,
      productName: r.productName ?? '',
      category: r.category ?? '',
      readyByDate: new Date(r.readyByDate),
      orderedQty: r.orderedQty ?? 0,
      status: r.lineStatus ?? 'Open',
      isCompleted: !!r.isCompleted,
      isReceived: !!r.isReceived,
    }))
}

/**
 * Like getCustomerOrders but with NO category filter and NO completed/received exclusion.
 * Used for supply purchasing — we want every open order to count against supply, regardless
 * of product category or whether the header was marked completed/received in the portal.
 */
export async function getAllCustomerOrdersForPurchasing(fromDate: Date, throughDate: Date): Promise<CustomerOrder[]> {
  const pool = await getPool('CSGWebPortal')

  const result = await pool.request()
    .input('FromDate', sql.DateTime, fromDate)
    .input('ThroughDate', sql.DateTime, throughDate)
    .query(`
      SELECT
        h.WHOD_ID                                             AS orderId,
        h.WHOD_OrderNumber                                    AS orderNumber,
        ISNULL(cstr.CSTR_Name, '')                            AS company,
        i.ITEM_SKUUS                                          AS sku,
        l.WHOI_ITEM_ID                                        AS itemId,
        ISNULL(i.ITEM_PurchasingName, i.ITEM_ProductName)    AS productName,
        c.CTGY_Category                                       AS category,
        h.WHOD_ReadyByDate                                    AS readyByDate,
        l.WHOI_QtyCases * ISNULL(l.WHOI_QtyPerCase, 1)       AS orderedQty,
        CASE WHEN l.WHOI_Received = 1 THEN 'Received' ELSE 'Open' END AS lineStatus,
        h.WHOD_Deleted                                        AS isDeleted,
        h.WHOD_Completed                                      AS isCompleted,
        h.WHOD_Received                                       AS isReceived
      FROM WP_WHOD h
      JOIN WP_WHOI l ON l.WHOI_WHOD_ID = h.WHOD_ID
                    AND l.WHOI_Deleted = 0
      LEFT JOIN WP_CSTR cstr ON cstr.CSTR_ID = h.WHOD_CSTR_ID
      JOIN LCData.dbo.ITEM i ON i.ITEM_ID = l.WHOI_ITEM_ID
      LEFT JOIN LCData.dbo.CTGY c ON c.CTGY_ID = i.ITEM_CTGY_ID
      WHERE h.WHOD_Deleted = 0
        AND h.WHOD_Completed IS NULL
        AND (h.WHOD_Received IS NULL OR h.WHOD_Received = 0)
        AND h.WHOD_ReadyByDate BETWEEN @FromDate AND @ThroughDate
      ORDER BY h.WHOD_ReadyByDate, cstr.CSTR_Name, i.ITEM_SKUUS
    `)

  return result.recordset.map((r: any) => ({
    orderId:     r.orderId,
    orderNumber: r.orderNumber ?? '',
    company:     r.company ?? '',
    sku:         r.sku ?? '',
    itemId:      r.itemId,
    productName: r.productName ?? '',
    category:    r.category ?? '',
    readyByDate: new Date(r.readyByDate),
    orderedQty:  r.orderedQty ?? 0,
    status:      r.lineStatus ?? 'Open',
    isCompleted: !!r.isCompleted,
    isReceived:  !!r.isReceived,
  }))
}

export async function getProductionBoardData(throughDate: Date): Promise<ProductionBoardDay[]> {
  const pool = await getPool('CSGWebPortal')
  const allowedCats = config.production.boardAllowedCategories.map(c => `'${c}'`).join(',')
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const result = await pool.request()
    .input('FromDate', sql.DateTime, today)
    .input('ThroughDate', sql.DateTime, throughDate)
    .query(`
      SELECT
        h.WHOD_ID                                             AS orderId,
        h.WHOD_OrderNumber                                    AS orderNumber,
        ISNULL(cstr.CSTR_Name, '')                            AS company,
        i.ITEM_SKUUS                                          AS sku,
        ISNULL(i.ITEM_PurchasingName, i.ITEM_ProductName)    AS productName,
        l.WHOI_QtyCases * ISNULL(l.WHOI_QtyPerCase, 1)       AS qty,
        h.WHOD_ReadyByDate                                    AS readyByDate,
        CASE WHEN l.WHOI_Received = 1 THEN 'Received' ELSE 'Open' END AS lineStatus,
        h.WHOD_Completed                                      AS isCompleted,
        h.WHOD_Received                                       AS isReceived,
        h.WHOD_Deleted                                        AS isDeleted
      FROM WP_WHOD h
      JOIN WP_WHOI l ON l.WHOI_WHOD_ID = h.WHOD_ID
                    AND l.WHOI_Deleted = 0
      LEFT JOIN WP_CSTR cstr ON cstr.CSTR_ID = h.WHOD_CSTR_ID
      JOIN LCData.dbo.ITEM i ON i.ITEM_ID = l.WHOI_ITEM_ID
      LEFT JOIN LCData.dbo.CTGY c ON c.CTGY_ID = i.ITEM_CTGY_ID
      WHERE h.WHOD_Deleted = 0
        AND h.WHOD_ReadyByDate BETWEEN @FromDate AND @ThroughDate
        AND c.CTGY_Category IN (${allowedCats})
      ORDER BY h.WHOD_ReadyByDate, cstr.CSTR_Name, i.ITEM_SKUUS
    `)

  const dayMap = new Map<string, ProductionBoardItem[]>()
  for (const r of result.recordset) {
    const dateKey = new Date(r.readyByDate).toISOString().split('T')[0]
    const items = dayMap.get(dateKey) ?? []
    const status: 'Received' | 'Completed' | 'Open' = r.isReceived ? 'Received' : r.isCompleted ? 'Completed' : 'Open'
    items.push({
      orderId: r.orderId,
      orderNumber: r.orderNumber ?? '',
      company: r.company ?? '',
      sku: r.sku ?? '',
      productName: r.productName ?? '',
      qty: r.qty ?? 0,
      readyByDate: new Date(r.readyByDate),
      status,
    })
    dayMap.set(dateKey, items)
  }

  const days: ProductionBoardDay[] = []
  for (const [, items] of Array.from(dayMap.entries())) {
    const totalQty = items.reduce((s: number, i: ProductionBoardItem) => s + i.qty, 0)
    days.push({
      date: items[0].readyByDate,
      items,
      totalQty,
      isOverCapacity: totalQty > config.production.dailyCapacity,
    })
  }
  return days.sort((a, b) => a.date.getTime() - b.date.getTime())
}
