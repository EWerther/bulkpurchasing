import { getPool } from '@/lib/db/connections'
import type { RecipeLine } from '@/lib/engine/types'
import { config } from '@/lib/config'

export async function getRecipes(tfmItemIds: number[]): Promise<Map<number, RecipeLine[]>> {
  if (!tfmItemIds.length) return new Map()
  const pool = await getPool('CustomDataTFMProd')
  const idList = tfmItemIds.join(',')
  const ignoredCats = config.production.feasibilityIgnoredCategories.map(c => `'${c}'`).join(',')
  const ignoredSKUs = config.production.feasibilityIgnoredSKUs.map(s => `'${s}'`).join(',')

  // DSSuppliesToProductsCovers can cross-join to LCData.dbo.ITEM for supply names
  const result = await pool.request().query(`
    SELECT
      r.Product    AS ProductItemId,
      r.Supply     AS SupplyItemId,
      i.ITEM_SKUUS AS supplySKU,
      ISNULL(i.ITEM_PurchasingName, i.ITEM_ProductName) AS supplyName,
      c.CTGY_Category AS supplyCategory,
      r.Qty        AS QtyPerUnit
    FROM DSSuppliesToProductsCovers r
    JOIN LCData.dbo.ITEM i ON i.ITEM_ID = r.Supply
    LEFT JOIN LCData.dbo.CTGY c ON c.CTGY_ID = i.ITEM_CTGY_ID
    WHERE r.Product IN (${idList})
      AND (c.CTGY_Category NOT IN (${ignoredCats}) OR c.CTGY_Category IS NULL)
      AND i.ITEM_SKUUS NOT IN (${ignoredSKUs})
  `)

  const map = new Map<number, RecipeLine[]>()
  for (const r of result.recordset) {
    const lines = map.get(r.ProductItemId) ?? []
    lines.push({
      supplyItemId: r.SupplyItemId,
      supplySKU: r.supplySKU ?? '',
      supplyName: r.supplyName ?? '',
      supplyCategory: r.supplyCategory ?? '',
      qtyPerUnit: r.QtyPerUnit ?? 1,
    })
    map.set(r.ProductItemId, lines)
  }
  return map
}

export async function getAllRecipes(): Promise<Map<number, RecipeLine[]>> {
  const pool = await getPool('CustomDataTFMProd')
  const ignoredCats = config.production.feasibilityIgnoredCategories.map(c => `'${c}'`).join(',')
  const ignoredSKUs = config.production.feasibilityIgnoredSKUs.map(s => `'${s}'`).join(',')

  const result = await pool.request().query(`
    SELECT
      r.Product    AS ProductItemId,
      r.Supply     AS SupplyItemId,
      i.ITEM_SKUUS AS supplySKU,
      ISNULL(i.ITEM_PurchasingName, i.ITEM_ProductName) AS supplyName,
      c.CTGY_Category AS supplyCategory,
      r.Qty        AS QtyPerUnit
    FROM DSSuppliesToProductsCovers r
    JOIN LCData.dbo.ITEM i ON i.ITEM_ID = r.Supply
    LEFT JOIN LCData.dbo.CTGY c ON c.CTGY_ID = i.ITEM_CTGY_ID
    WHERE (c.CTGY_Category NOT IN (${ignoredCats}) OR c.CTGY_Category IS NULL)
      AND i.ITEM_SKUUS NOT IN (${ignoredSKUs})
  `)

  const map = new Map<number, RecipeLine[]>()
  for (const r of result.recordset) {
    const lines = map.get(r.ProductItemId) ?? []
    lines.push({
      supplyItemId: r.SupplyItemId,
      supplySKU: r.supplySKU ?? '',
      supplyName: r.supplyName ?? '',
      supplyCategory: r.supplyCategory ?? '',
      qtyPerUnit: r.QtyPerUnit ?? 1,
    })
    map.set(r.ProductItemId, lines)
  }
  return map
}
