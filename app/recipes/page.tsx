'use client'

import { useState, useEffect, useMemo } from 'react'
import { Search, Plus, Pencil, Trash2, Check, X, AlertTriangle, RefreshCw, BookOpen } from 'lucide-react'
import { SummaryBar } from '@/components/shared/SummaryBar'

interface RecipeLine {
  productItemId: number
  productSKU: string
  productName: string
  supplyItemId: number
  supplySKU: string
  supplyName: string
  supplyCategory: string
  qtyPerUnit: number
}

interface DropdownItem {
  itemId: number
  sku: string
  name: string
  category?: string
}

const CATEGORY_COLORS: Record<string, string> = {
  'Foam':      'text-warning bg-warning/10 border-warning/30',
  'Cover':     'text-accent bg-accent/10 border-accent/30',
  'Fire Sock': 'text-success bg-success/10 border-success/30',
  'Pillow':    'text-purple-400 bg-purple-500/10 border-purple-500/30',
  'Packet':    'text-text-secondary bg-surface border-border',
}

export default function RecipesPage() {
  const [data, setData]             = useState<{ recipes: RecipeLine[]; products: DropdownItem[]; supplies: DropdownItem[] } | null>(null)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')
  const [search, setSearch]         = useState('')
  const [selectedProduct, setSelectedProduct] = useState<string>('')   // productSKU filter
  const [editingLine, setEditingLine]   = useState<RecipeLine | null>(null)
  const [editQty, setEditQty]           = useState('')
  const [showAddForm, setShowAddForm]   = useState(false)
  const [addProduct, setAddProduct]     = useState('')
  const [addSupply, setAddSupply]       = useState('')
  const [addQty, setAddQty]             = useState('1')
  const [saving, setSaving]             = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<RecipeLine | null>(null)

  async function load() {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/recipes')
      if (!res.ok) throw new Error((await res.json()).error ?? 'Server error')
      setData(await res.json())
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  // Distinct products for left-panel filter
  const productGroups = useMemo(() => {
    if (!data) return []
    const seen = new Map<string, RecipeLine>()
    for (const r of data.recipes) if (!seen.has(r.productSKU)) seen.set(r.productSKU, r)
    return [...seen.values()].sort((a, b) => a.productSKU.localeCompare(b.productSKU))
  }, [data])

  const filteredRecipes = useMemo(() => {
    if (!data) return []
    let list = data.recipes
    if (selectedProduct) list = list.filter(r => r.productSKU === selectedProduct)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(r =>
        r.productSKU.toLowerCase().includes(q) ||
        r.productName.toLowerCase().includes(q) ||
        r.supplySKU.toLowerCase().includes(q) ||
        r.supplyName.toLowerCase().includes(q) ||
        r.supplyCategory.toLowerCase().includes(q)
      )
    }
    return list
  }, [data, selectedProduct, search])

  // Group filtered recipes by product
  const groupedByProduct = useMemo(() => {
    const groups = new Map<string, RecipeLine[]>()
    for (const r of filteredRecipes) {
      const arr = groups.get(r.productSKU) ?? []
      arr.push(r)
      groups.set(r.productSKU, arr)
    }
    return groups
  }, [filteredRecipes])

  async function saveEdit() {
    if (!editingLine) return
    const qty = parseFloat(editQty)
    if (isNaN(qty) || qty <= 0) return
    setSaving(true)
    try {
      const res = await fetch('/api/recipes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productItemId: editingLine.productItemId, supplyItemId: editingLine.supplyItemId, qty }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      setEditingLine(null)
      await load()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  async function doDelete(line: RecipeLine) {
    setSaving(true)
    try {
      const res = await fetch('/api/recipes', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productItemId: line.productItemId, supplyItemId: line.supplyItemId }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      setConfirmDelete(null)
      await load()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  async function doAdd() {
    const qty = parseFloat(addQty)
    if (!addProduct || !addSupply || isNaN(qty) || qty <= 0) return
    const pItem = data?.products.find(p => p.sku === addProduct)
    const sItem = data?.supplies.find(s => s.sku === addSupply)
    if (!pItem || !sItem) return
    setSaving(true)
    try {
      const res = await fetch('/api/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productItemId: pItem.itemId, supplyItemId: sItem.itemId, qty }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      setShowAddForm(false); setAddProduct(''); setAddSupply(''); setAddQty('1')
      await load()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="flex flex-col h-full">

      {/* Header */}
      <div className="bg-surface border-b border-border px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <BookOpen size={16} className="text-accent" />
          <div>
            <h1 className="font-mono text-sm font-bold tracking-widest uppercase text-text-primary">Recipe Manager</h1>
            <p className="text-[11px] text-text-secondary font-mono">DSSuppliesToProductsCovers — components per finished product</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading} className="btn-secondary text-xs flex items-center gap-1.5">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={() => setShowAddForm(true)} className="btn-primary text-xs flex items-center gap-1.5">
            <Plus size={11} /> Add Recipe Line
          </button>
        </div>
      </div>

      <SummaryBar stats={[
        { label: 'Total Products', value: productGroups.length },
        { label: 'Total Lines', value: data?.recipes.length ?? 0 },
        { label: 'Showing', value: filteredRecipes.length },
      ]} />

      {error && (
        <div className="mx-4 my-2 bg-danger/10 border border-danger/30 rounded px-3 py-2 text-xs text-danger font-mono flex items-center gap-2">
          <AlertTriangle size={12} /> {error}
          <button onClick={() => setError('')} className="ml-auto"><X size={12} /></button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">

        {/* ── Left panel: product list ──────────────────────── */}
        <div className="w-64 shrink-0 border-r border-border flex flex-col bg-surface">
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search…"
                className="bg-bg border border-border rounded pl-6 pr-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent w-full"
              />
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            <button
              onClick={() => setSelectedProduct('')}
              className={`w-full text-left px-3 py-2 text-xs font-mono transition-colors border-b border-border ${!selectedProduct ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-white/5'}`}
            >
              All Products ({productGroups.length})
            </button>
            {productGroups.map(p => {
              const count = data?.recipes.filter(r => r.productSKU === p.productSKU).length ?? 0
              return (
                <button
                  key={p.productSKU}
                  onClick={() => setSelectedProduct(p.productSKU)}
                  className={`w-full text-left px-3 py-2 border-b border-border/50 transition-colors ${selectedProduct === p.productSKU ? 'bg-accent/10 text-accent' : 'hover:bg-white/5'}`}
                >
                  <div className={`font-mono text-xs font-semibold ${selectedProduct === p.productSKU ? 'text-accent' : 'text-text-primary'}`}>{p.productSKU}</div>
                  <div className="text-[10px] text-text-secondary truncate">{p.productName}</div>
                  <div className="text-[10px] text-text-secondary">{count} component{count !== 1 ? 's' : ''}</div>
                </button>
              )
            })}
          </div>
        </div>

        {/* ── Right panel: recipe lines ─────────────────────── */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-16 text-text-secondary font-mono text-sm">Loading…</div>
          )}
          {!loading && groupedByProduct.size === 0 && (
            <div className="flex items-center justify-center py-16 text-text-secondary font-mono text-sm">No recipes match your filters</div>
          )}
          {[...groupedByProduct.entries()].map(([sku, lines]) => (
            <div key={sku} className="card overflow-hidden">
              {/* Product header */}
              <div className="px-4 py-3 border-b border-border bg-surface flex items-center justify-between">
                <div>
                  <span className="font-mono font-bold text-sm text-text-primary">{sku}</span>
                  <span className="ml-3 text-xs text-text-secondary">{lines[0].productName}</span>
                </div>
                <span className="chip text-[10px] border border-border font-mono text-text-secondary">
                  {lines.length} component{lines.length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Lines table */}
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Supply SKU</th>
                    <th>Name</th>
                    <th>Category</th>
                    <th className="text-right">Qty / Unit</th>
                    <th style={{ width: 100 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(line => {
                    const isEditing = editingLine?.productItemId === line.productItemId && editingLine?.supplyItemId === line.supplyItemId
                    return (
                      <tr key={`${line.productItemId}-${line.supplyItemId}`} className="table-row-comfortable">
                        <td className="font-mono text-xs font-semibold">{line.supplySKU}</td>
                        <td className="text-xs text-text-secondary">{line.supplyName}</td>
                        <td>
                          <span className={`chip text-[10px] border px-1.5 py-0.5 font-mono ${CATEGORY_COLORS[line.supplyCategory] ?? 'text-text-secondary bg-surface border-border'}`}>
                            {line.supplyCategory || '—'}
                          </span>
                        </td>
                        <td className="text-right">
                          {isEditing ? (
                            <input
                              type="number"
                              min="0.001"
                              step="0.001"
                              value={editQty}
                              onChange={e => setEditQty(e.target.value)}
                              className="bg-bg border border-accent rounded px-2 py-0.5 text-xs font-mono text-text-primary focus:outline-none w-20 text-right"
                              autoFocus
                              onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditingLine(null) }}
                            />
                          ) : (
                            <span className="font-mono text-xs">{line.qtyPerUnit}</span>
                          )}
                        </td>
                        <td>
                          <div className="flex items-center justify-end gap-1">
                            {isEditing ? (
                              <>
                                <button onClick={saveEdit} disabled={saving}
                                  className="text-[10px] px-2 py-0.5 rounded border border-success/40 text-success hover:bg-success/10 font-mono transition-colors">
                                  <Check size={10} />
                                </button>
                                <button onClick={() => setEditingLine(null)}
                                  className="text-[10px] px-2 py-0.5 rounded border border-border text-text-secondary hover:bg-white/5 font-mono transition-colors">
                                  <X size={10} />
                                </button>
                              </>
                            ) : (
                              <>
                                <button onClick={() => { setEditingLine(line); setEditQty(String(line.qtyPerUnit)) }}
                                  className="text-[10px] px-2 py-0.5 rounded border border-border text-text-secondary hover:text-accent hover:border-accent/40 font-mono transition-colors flex items-center gap-1">
                                  <Pencil size={9} /> Edit
                                </button>
                                <button onClick={() => setConfirmDelete(line)}
                                  className="text-[10px] px-2 py-0.5 rounded border border-border text-text-secondary hover:text-danger hover:border-danger/40 font-mono transition-colors flex items-center gap-1">
                                  <Trash2 size={9} /> Delete
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>

      {/* ── Add Recipe Line Modal ────────────────────────────── */}
      {showAddForm && data && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.6)' }}>
          <div className="bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-mono text-sm font-bold text-text-primary">Add Recipe Line</h2>
              <button onClick={() => setShowAddForm(false)} className="text-text-secondary hover:text-text-primary"><X size={16} /></button>
            </div>

            {error && <div className="text-xs text-danger font-mono bg-danger/10 border border-danger/30 rounded px-3 py-2">{error}</div>}

            <div className="space-y-3">
              <div>
                <label className="text-xs text-text-secondary font-mono block mb-1">Product (finished good)</label>
                <select
                  value={addProduct}
                  onChange={e => setAddProduct(e.target.value)}
                  className="bg-bg border border-border rounded px-2 py-1.5 text-xs font-mono text-text-primary focus:outline-none focus:border-accent w-full"
                >
                  <option value="">— select product —</option>
                  {data.products.map(p => (
                    <option key={p.itemId} value={p.sku}>{p.sku} — {p.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs text-text-secondary font-mono block mb-1">Supply Component</label>
                <select
                  value={addSupply}
                  onChange={e => setAddSupply(e.target.value)}
                  className="bg-bg border border-border rounded px-2 py-1.5 text-xs font-mono text-text-primary focus:outline-none focus:border-accent w-full"
                >
                  <option value="">— select component —</option>
                  {data.supplies.map(s => (
                    <option key={s.itemId} value={s.sku}>[{s.category}] {s.sku} — {s.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs text-text-secondary font-mono block mb-1">Qty per finished unit</label>
                <input
                  type="number"
                  min="0.001"
                  step="0.001"
                  value={addQty}
                  onChange={e => setAddQty(e.target.value)}
                  className="bg-bg border border-border rounded px-2 py-1.5 text-xs font-mono text-text-primary focus:outline-none focus:border-accent w-full"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={doAdd}
                disabled={saving || !addProduct || !addSupply}
                className="btn-primary flex-1 text-xs flex items-center justify-center gap-1.5"
              >
                <Plus size={11} /> {saving ? 'Saving…' : 'Add Line'}
              </button>
              <button onClick={() => setShowAddForm(false)} className="btn-secondary text-xs">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation ──────────────────────────────── */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.6)' }}>
          <div className="bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <h2 className="font-mono text-sm font-bold text-text-primary">Delete Recipe Line?</h2>
            <div className="bg-danger/10 border border-danger/30 rounded p-3 text-xs font-mono space-y-1">
              <div>Product: <strong>{confirmDelete.productSKU}</strong></div>
              <div>Component: <strong>{confirmDelete.supplySKU}</strong> — {confirmDelete.supplyName}</div>
              <div className="text-danger mt-2">This permanently removes the component from the recipe. The production scheduler will no longer check this supply for feasibility.</div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => doDelete(confirmDelete)} disabled={saving}
                className="btn-danger flex-1 text-xs flex items-center justify-center gap-1.5">
                <Trash2 size={11} /> {saving ? 'Deleting…' : 'Delete'}
              </button>
              <button onClick={() => setConfirmDelete(null)} className="btn-secondary text-xs">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
