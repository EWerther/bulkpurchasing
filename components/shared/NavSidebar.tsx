'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from 'next-auth/react'
import {
  ShoppingCart, Calendar, CheckCircle, Layers, Package,
  ChevronLeft, ChevronRight, LogOut, Zap, Info, X, Bot,
  LayoutDashboard, Factory, BookOpen, Package2, Truck, FileText, BarChart2,
} from 'lucide-react'

interface NavItem {
  href: string
  label: string
  icon: React.ElementType
  desc: string
  overview: {
    tagline: string
    bullets: string[]
  }
}

const NAV_ITEMS: NavItem[] = [
  {
    href: '/command-center',
    label: 'Command Center',
    icon: LayoutDashboard,
    desc: 'Live operational intelligence',
    overview: {
      tagline: 'Auto-updating dashboard showing exactly what TFM should make and when — no user input required.',
      bullets: [
        'Runs the full DOC generator for both FTX and SBYL on every load, producing a live priority-ranked recommendation list',
        'Items classified by urgency tier: Critical (below safety stock), Urgent (≤7d buffer), High (≤14d), Medium (≤30d), Watch',
        'Each recommendation shows current DOC, ADS, recommended action, and a 30-day DOC projection sparkline',
        'Drill-down per item reveals reasoning, existing PO comparison, and ingredient-level supply feasibility',
        'Auto-refreshes every 5 minutes — designed to stay open on a monitor without user interaction',
        'Filter by company, urgency tier, action type, or search by SKU',
      ],
    },
  },
  {
    href: '/ask-claude',
    label: 'Ask Claude',
    icon: Bot,
    desc: 'AI supply chain analyst',
    overview: {
      tagline: 'Conversational AI assistant with live context from your supply chain — ask anything about inventory, POs, or recommendations.',
      bullets: [
        'Powered by Anthropic\'s Claude API with a system prompt injected with today\'s live operational context',
        'Claude knows your current DOC levels, urgency breakdown, critical SKUs, and recommended actions',
        'Ask plain-English questions: "What should I prioritize today?" or "Why is SKU X critical?"',
        'Streaming responses — text appears word by word for a natural conversation experience',
        'Context automatically refreshed from the Command Center data on every session start',
        'Requires ANTHROPIC_API_KEY in .env.local to enable',
      ],
    },
  },
  {
    href: '/inventory',
    label: 'Inventory',
    icon: Package2,
    desc: 'FTX + SBYL finished goods inventory',
    overview: {
      tagline: 'Full current inventory for all finished goods — pulled from FTX and SBYL customer warehouses, not TFM.',
      bullets: [
        'Shows on-hand units, average daily sales, and days-of-cover for every active SKU',
        'Color-coded DOC status: Critical (< 15 days), Low (< 30 days), OK',
        'Incoming POs shown inline per SKU with ETA and quantity',
        'Deep-linked from Order Feasibility and other pages — click any finished-good SKU to land here filtered',
        'Toggle between FTX, SBYL, or combined view',
        'Sort by any column — default sorted by DOC ascending (most urgent first)',
      ],
    },
  },
  {
    href: '/po-schedule',
    label: 'PO Schedule',
    icon: ShoppingCart,
    desc: 'Plan purchase orders',
    overview: {
      tagline: 'Generate a forward purchase order schedule and reconcile it against existing ERP POs.',
      bullets: [
        'Runs a DOC-based generator (days-of-cover) to calculate what should be ordered per SKU across the planning horizon',
        'Compares generated orders against open ERP POs — flags items to Create, Update ETA/Qty, or Consider Cancelling',
        'Checks supply feasibility with TFM (can they actually make it given current components?)',
        'Surfaces new products (ADS = 0) that already have POs on order',
        'Full Schedule tab shows the raw generator output before any ERP comparison',
        'Optimizer warnings highlight supply contention across competing demand items',
      ],
    },
  },
  {
    href: '/production-schedule',
    label: 'Production Schedule',
    icon: Calendar,
    desc: 'Schedule TFM production',
    overview: {
      tagline: 'Build a capacity-constrained production calendar for TFM from the full FTX + SBYL demand picture.',
      bullets: [
        'Always runs both FTX and SBYL together — both companies draw from the same TFM supply pool',
        'Demand comes from two sources: the PO Schedule generator output (established items) and existing ERP POs (new products with ADS = 0)',
        'Phase 1 — Demand Review: shows all planned demand, lets you override individual ETAs before scheduling',
        'Phase 2 — Production Calendar: places items day-by-day, checks supply feasibility, cascades over-capacity days forward',
        'Items that cannot be produced due to supply shortages are either moved to the first feasible date or flagged as infeasible-locked',
      ],
    },
  },
  {
    href: '/order-feasibility',
    label: 'Order Feasibility',
    icon: CheckCircle,
    desc: 'Check order feasibility',
    overview: {
      tagline: 'Check whether TFM can fulfill upcoming customer orders given available supply.',
      bullets: [
        'Pulls real customer orders from the CSGWebPortal database (actual orders with ReadyByDate)',
        'Runs FTX and SBYL orders together — they compete for the same TFM supply components',
        'Reports Full / Partial / Not Feasible per order with ingredient-level shortage detail',
        'Tracks substitute components — shows when a shortage is covered by an approved alternate',
        'Flags orders where feasibility requires placing a new supply PO (lead-time based)',
        'Day accordion view groups orders by due date with color-coded day headers (green/amber/red)',
      ],
    },
  },
  {
    href: '/production-board',
    label: 'Production Board',
    icon: Layers,
    desc: 'Live production board',
    overview: {
      tagline: 'Factory floor display of customer orders grouped by due date.',
      bullets: [
        'Designed for viewing from a distance — large, clean typography, no clutter',
        'Shows all open customer orders grouped by ReadyByDate, sorted by Company then SKU',
        'Flags over-capacity days (when total qty exceeds the configured daily capacity)',
        'Auto-refreshes every 5 minutes to stay current with the production system',
        'Read-only — no actions, no drill-downs, no analysis',
      ],
    },
  },
  {
    href: '/factory',
    label: 'Factory Floor',
    icon: Factory,
    desc: 'Production tracking by line & shift',
    overview: {
      tagline: 'Real-time production floor dashboard — tracks progress per line and shift against assigned production orders.',
      bullets: [
        'Supervisor assigns open TFM production orders (from WP_WHOD/WP_WHOI) to a specific line, shift, and target qty',
        'Floor workers see big, bold progress for their line and shift — designed to be readable across the room',
        'Workers log production throughout the day with a single tap; each entry is timestamped and attributed',
        'Pace indicator shows whether each session is Ahead, On Track, or Behind based on shift time elapsed',
        'Live shift countdown timer and progress bar with elapsed-time marker so the team can self-manage',
        'Dashboard auto-refreshes every 60 seconds — no user interaction needed on the floor',
        'Historical log of every production entry stored in CustomData — enables future per-shift performance reports',
      ],
    },
  },
  {
    href: '/factory/report',
    label: 'Production Report',
    icon: BarChart2,
    desc: 'Manager efficiency report by line & shift',
    overview: {
      tagline: 'Daily production efficiency — target vs actual by line and shift, with running totals for any date range.',
      bullets: [
        'One row per production day, 4 column groups: Line 1 Shift 1, Line 1 Shift 2, Line 2 Shift 1, Line 2 Shift 2',
        'Each group shows SKU(s), Target, Actual, Δ (units over/under), and % completion',
        'Color-coded %: green ≥ 100%, amber ≥ 90%, red < 90%',
        'Weekend rows automatically grayed — only production days get a row number',
        'Totals row at bottom aggregates the full selected period per line and shift',
        'Default view: current month to today — change date range and refresh at any time',
      ],
    },
  },
  {
    href: '/recipes',
    label: 'Recipe Manager',
    icon: BookOpen,
    desc: 'Manage supply-to-product recipes',
    overview: {
      tagline: 'View and manage the DSSuppliesToProductsCovers table — which supply components are required to produce each finished product.',
      bullets: [
        'Shows all recipe lines grouped by finished product SKU',
        'Edit the quantity-per-unit for any ingredient inline',
        'Add new recipe lines — link any supply component to any product',
        'Delete lines that are no longer needed (with confirmation)',
        'Changes take effect immediately in the production scheduler and feasibility checks',
        'Left panel filters by product; search bar filters across all products and components',
      ],
    },
  },
  {
    href: '/supply-purchasing',
    label: 'Supply Purchasing',
    icon: Truck,
    desc: 'What to order and when',
    overview: {
      tagline: 'Purchasing decision engine — shows exactly what supply components need to be ordered, by when, and flags existing POs that should be expedited.',
      bullets: [
        'Runs a day-by-day stock simulation per component using upcoming production orders as demand',
        'Calculates Run Out Date (when stock hits zero) and Alert Date (latest date to place an order given vendor lead time)',
        'Qty to Purchase = total upcoming consumption minus current stock and open orders',
        'Expedite panel shows open supply POs that arrive too late and should be pulled in — with exact suggested new ETA',
        'Category filters and "Needs Attention" toggle to focus on what matters',
        'Select multiple SKUs and generate a consolidated PO (coming soon)',
        'Links to Supply Intelligence for full component detail, and directly to open POs in ERP',
      ],
    },
  },
  {
    href: '/tfm-pos',
    label: 'TFM Supply POs',
    icon: FileText,
    desc: 'Vendor POs placed by TFM',
    overview: {
      tagline: 'All purchase orders TFM has placed with suppliers — with impact analysis showing what breaks if a PO is skipped or delayed.',
      bullets: [
        'Lists every non-deleted supply PO across all vendors — filter by Open, Draft, Received, or Forecast status',
        'Click any PO to run an impact analysis: simulates day-by-day stock without that PO and identifies which production orders would run short',
        'Per-line breakdown: each supply item on the PO is analyzed independently with its own stock projection',
        'Shows stock level with and without the PO for every upcoming production order consuming that supply',
        'Verdict per line: Safe to push / Orders at risk / Short regardless — so you can make an informed decision quickly',
        'Past-due ETAs highlighted in red; overdue open POs flagged in the main table',
      ],
    },
  },
  {
    href: '/supply',
    label: 'Supply Intelligence',
    icon: Package,
    desc: 'Supply component visibility',
    overview: {
      tagline: 'Full visibility into TFM\'s supply components — on-hand, incoming, and committed.',
      bullets: [
        'Shows every supply component (foam, covers, fire socks, boxes, etc.) with current on-hand quantity',
        'Displays all open supply POs with their ETAs — the future supply picture',
        'Runs the full allocation optimizer to show exactly where each unit is committed across all scheduled demand',
        'Projects stock levels day-by-day to identify shortage risks before they become problems',
        'Cross-linked from every other page — click any supply SKU anywhere to jump here pre-filtered',
        'Filterable by category and searchable by SKU or name',
      ],
    },
  },
]

export function NavSidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const [activeModal, setActiveModal] = useState<NavItem | null>(null)
  const pathname = usePathname()

  return (
    <>
      <aside
        className="flex flex-col border-r shrink-0 transition-all duration-200"
        style={{
          width: collapsed ? 60 : 228,
          background: 'linear-gradient(180deg, #1e293b 0%, #0f172a 100%)',
          borderColor: '#334155',
        }}
      >
        {/* Logo */}
        <div
          className="flex items-center border-b shrink-0"
          style={{ height: 56, padding: collapsed ? '0 14px' : '0 16px', borderColor: '#334155' }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="shrink-0 flex items-center justify-center rounded-lg"
              style={{
                width: 30, height: 30,
                background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
                boxShadow: '0 0 12px rgba(79,70,229,0.5)',
              }}
            >
              <Zap size={15} className="text-white" strokeWidth={2.5} />
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <div className="text-sm font-bold text-white leading-none truncate" style={{ letterSpacing: '-0.01em' }}>
                  BulkBuy
                </div>
                <div className="text-[10px] mt-0.5 truncate font-medium" style={{ color: '#94a3b8' }}>TFM Operations</div>
              </div>
            )}
          </div>
          <button
            onClick={() => setCollapsed(c => !c)}
            className="shrink-0 ml-auto rounded-md p-1 transition-colors"
            style={{ color: '#64748b' }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = '#94a3b8'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = '#64748b'}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 space-y-0.5 px-2 overflow-y-auto">
          {!collapsed && (
            <div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-widest" style={{ color: '#475569' }}>
              Navigation
            </div>
          )}
          {NAV_ITEMS.map(item => {
            // Active if this item's href matches the current path, but no other nav
            // item is a more-specific (longer) prefix match — prevents /factory
            // staying active when /factory/report is open.
            const active = pathname.startsWith(item.href) &&
              !NAV_ITEMS.some(other =>
                other.href !== item.href &&
                pathname.startsWith(other.href) &&
                other.href.length > item.href.length,
              )
            const Icon = item.icon
            return (
              <div key={item.href} className="relative group/row flex items-center gap-1">
                <Link
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  className="flex items-center gap-3 rounded-lg px-2.5 py-2 transition-all duration-150 flex-1 min-w-0"
                  style={{
                    background: active
                      ? 'rgba(79,70,229,0.18)'
                      : 'transparent',
                    color: active ? '#a5b4fc' : '#94a3b8',
                    boxShadow: active ? 'inset 0 0 0 1px rgba(79,70,229,0.25)' : 'none',
                  }}
                  onMouseEnter={e => {
                    if (!active) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)'
                  }}
                  onMouseLeave={e => {
                    if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent'
                  }}
                >
                  {active && (
                    <span
                      className="absolute rounded-full"
                      style={{ width: 3, height: 20, background: 'linear-gradient(180deg, #4f46e5, #7c3aed)', left: -1, top: '50%', transform: 'translateY(-50%)' }}
                    />
                  )}
                  <Icon
                    size={15}
                    className="shrink-0 transition-colors"
                    style={{ color: active ? '#818cf8' : '#64748b' }}
                    strokeWidth={active ? 2.2 : 1.8}
                  />
                  {!collapsed && (
                    <span className="text-sm font-medium truncate" style={{ color: active ? '#c7d2fe' : '#94a3b8' }}>
                      {item.label}
                    </span>
                  )}
                </Link>

                {/* Info button — only when sidebar is expanded */}
                {!collapsed && (
                  <button
                    onClick={() => setActiveModal(item)}
                    className="shrink-0 rounded-md p-1 transition-all duration-150 opacity-0 group-hover/row:opacity-100"
                    style={{ color: '#64748b' }}
                    title={`About ${item.label}`}
                    onMouseEnter={e => {
                      (e.currentTarget as HTMLElement).style.color = '#94a3b8'
                      ;(e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)'
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLElement).style.color = '#64748b'
                      ;(e.currentTarget as HTMLElement).style.background = 'transparent'
                    }}
                  >
                    <Info size={13} />
                  </button>
                )}
              </div>
            )
          })}
        </nav>

        {/* Footer */}
        <div className="border-t px-2 py-3" style={{ borderColor: '#334155' }}>
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            title="Sign out"
            className="flex items-center gap-3 w-full px-2.5 py-2 rounded-lg text-sm transition-all duration-150"
            style={{ color: '#64748b' }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.color = '#f87171'
              ;(e.currentTarget as HTMLElement).style.background = 'rgba(220,38,38,0.08)'
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.color = '#64748b'
              ;(e.currentTarget as HTMLElement).style.background = 'transparent'
            }}
          >
            <LogOut size={14} className="shrink-0" strokeWidth={1.8} />
            {!collapsed && <span className="font-medium">Sign out</span>}
          </button>
        </div>
      </aside>

      {/* Page Overview Modal */}
      {activeModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(4px)' }}
          onClick={() => setActiveModal(null)}
        >
          <div
            className="relative w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden"
            style={{ background: '#ffffff', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Modal header */}
            <div
              className="flex items-center justify-between px-6 py-5 border-b"
              style={{ borderColor: 'var(--border)', background: '#f8fafc' }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="flex items-center justify-center rounded-xl"
                  style={{
                    width: 38, height: 38,
                    background: 'linear-gradient(135deg, rgba(79,70,229,0.12), rgba(124,58,237,0.08))',
                    border: '1px solid rgba(79,70,229,0.2)',
                  }}
                >
                  <activeModal.icon size={18} style={{ color: 'var(--accent)' }} strokeWidth={1.8} />
                </div>
                <div>
                  <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {activeModal.label}
                  </h2>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{activeModal.desc}</p>
                </div>
              </div>
              <button
                onClick={() => setActiveModal(null)}
                className="rounded-lg p-1.5 transition-colors"
                style={{ color: 'var(--text-muted)' }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--surface-hover)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
              >
                <X size={16} />
              </button>
            </div>

            {/* Modal body */}
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {activeModal.overview.tagline}
              </p>
              <ul className="space-y-2.5">
                {activeModal.overview.bullets.map((bullet, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span
                      className="shrink-0 rounded-full mt-1.5"
                      style={{ width: 6, height: 6, background: 'var(--accent)', opacity: 0.7 }}
                    />
                    <span className="text-sm" style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                      {bullet}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Modal footer */}
            <div
              className="flex justify-between items-center px-6 py-4 border-t"
              style={{ borderColor: 'var(--border)', background: '#f8fafc' }}
            >
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Click anywhere outside to close
              </span>
              <Link
                href={activeModal.href}
                onClick={() => setActiveModal(null)}
                className="btn-primary text-xs px-4 py-1.5"
              >
                Go to {activeModal.label}
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
