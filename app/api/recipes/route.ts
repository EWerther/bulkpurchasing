/**
 * /api/recipes — CRUD for DSSuppliesToProductsCovers (recipe / BOM table)
 *
 * GET    → all recipe lines with product + supply names
 * POST   → insert a new line { productItemId, supplyItemId, qty }
 * PUT    → update qty { productItemId, supplyItemId, qty }
 * DELETE → remove a line { productItemId, supplyItemId }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getPool, sql } from '@/lib/db/connections'

async function pool() { return getPool('CustomDataTFMProd') }

// ── GET — fetch everything ──────────────────────────────────────────────────

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const db = await pool()

    const [recipesRes, productsRes, suppliesRes] = await Promise.all([
      db.request().query(`
        SELECT
          r.Product                                         AS productItemId,
          pi.ITEM_SKUUS                                     AS productSKU,
          ISNULL(pi.ITEM_PurchasingName, pi.ITEM_ProductName) AS productName,
          r.Supply                                          AS supplyItemId,
          si.ITEM_SKUUS                                     AS supplySKU,
          ISNULL(si.ITEM_PurchasingName, si.ITEM_ProductName) AS supplyName,
          ISNULL(c.CTGY_Category, '')                       AS supplyCategory,
          r.Qty                                             AS qtyPerUnit
        FROM DSSuppliesToProductsCovers r
        JOIN LCData.dbo.ITEM pi ON pi.ITEM_ID = r.Product
        JOIN LCData.dbo.ITEM si ON si.ITEM_ID = r.Supply
        LEFT JOIN LCData.dbo.CTGY c ON c.CTGY_ID = si.ITEM_CTGY_ID
        ORDER BY pi.ITEM_SKUUS, c.CTGY_Category, si.ITEM_SKUUS
      `),
      // Distinct products that appear in TFM supply/production context
      db.request().query(`
        SELECT DISTINCT
          pi.ITEM_ID   AS itemId,
          pi.ITEM_SKUUS AS sku,
          ISNULL(pi.ITEM_PurchasingName, pi.ITEM_ProductName) AS name
        FROM DSSuppliesToProductsCovers r
        JOIN LCData.dbo.ITEM pi ON pi.ITEM_ID = r.Product
        WHERE pi.ITEM_Deleted = 0
        ORDER BY pi.ITEM_SKUUS
      `),
      // All TFM supply items (components) — for the add-line dropdown
      db.request().query(`
        SELECT
          i.ITEM_ID   AS itemId,
          i.ITEM_SKUUS AS sku,
          ISNULL(i.ITEM_PurchasingName, i.ITEM_ProductName) AS name,
          ISNULL(c.CTGY_Category, '') AS category
        FROM LCData.dbo.ITEM i
        LEFT JOIN LCData.dbo.CTGY c ON c.CTGY_ID = i.ITEM_CTGY_ID
        WHERE i.ITEM_Deleted = 0
          AND c.CTGY_Category IN ('Foam','Cover','Fire Sock','Packet','Pillow')
        ORDER BY c.CTGY_Category, i.ITEM_SKUUS
      `),
    ])

    return NextResponse.json({
      recipes:  recipesRes.recordset,
      products: productsRes.recordset,
      supplies: suppliesRes.recordset,
    })
  } catch (err: any) {
    console.error('recipes GET error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}

// ── POST — insert new line ─────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { productItemId, supplyItemId, qty } = await req.json()
    if (!productItemId || !supplyItemId || qty == null)
      return NextResponse.json({ error: 'productItemId, supplyItemId, qty are required' }, { status: 400 })

    const db = await pool()

    // Prevent duplicate
    const exists = await db.request()
      .input('P', sql.Int, productItemId)
      .input('S', sql.Int, supplyItemId)
      .query(`SELECT 1 FROM DSSuppliesToProductsCovers WHERE Product = @P AND Supply = @S`)
    if (exists.recordset.length > 0)
      return NextResponse.json({ error: 'Recipe line already exists for this product + supply combination' }, { status: 409 })

    await db.request()
      .input('P',   sql.Int,     productItemId)
      .input('S',   sql.Int,     supplyItemId)
      .input('Qty', sql.Decimal(10, 4), qty)
      .query(`INSERT INTO DSSuppliesToProductsCovers (Product, Supply, Qty) VALUES (@P, @S, @Qty)`)

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('recipes POST error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}

// ── PUT — update qty ────────────────────────────────────────────────────────

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { productItemId, supplyItemId, qty } = await req.json()
    if (!productItemId || !supplyItemId || qty == null)
      return NextResponse.json({ error: 'productItemId, supplyItemId, qty are required' }, { status: 400 })

    const db = await pool()
    await db.request()
      .input('P',   sql.Int,     productItemId)
      .input('S',   sql.Int,     supplyItemId)
      .input('Qty', sql.Decimal(10, 4), qty)
      .query(`UPDATE DSSuppliesToProductsCovers SET Qty = @Qty WHERE Product = @P AND Supply = @S`)

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('recipes PUT error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}

// ── DELETE — remove line ────────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { productItemId, supplyItemId } = await req.json()
    if (!productItemId || !supplyItemId)
      return NextResponse.json({ error: 'productItemId and supplyItemId are required' }, { status: 400 })

    const db = await pool()
    await db.request()
      .input('P', sql.Int, productItemId)
      .input('S', sql.Int, supplyItemId)
      .query(`DELETE FROM DSSuppliesToProductsCovers WHERE Product = @P AND Supply = @S`)

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('recipes DELETE error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
