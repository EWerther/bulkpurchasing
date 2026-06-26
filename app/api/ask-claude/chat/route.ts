import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import Anthropic from '@anthropic-ai/sdk'

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'

// ── Context formatters (text tables — more token-efficient than JSON) ────────

function fmtInventory(inv: any): string {
  if (!inv) return ''
  const rows = (company: string, items: any[]) => {
    const limited = items.slice(0, 120)
    return [
      `## ${company} Inventory (${items.length} SKUs, sorted by DOC — most urgent first)`,
      'SKU | On-Hand | ADS/d | DOC',
      ...limited.map((r: any) =>
        `${r.sku} | ${r.onHand.toLocaleString()} | ${r.ads} | ${r.doc != null ? `${r.doc}d${r.doc <= 15 ? ' ⚠️' : ''}` : 'no ADS'}`
      ),
      limited.length < items.length ? `…and ${items.length - limited.length} more` : '',
    ].filter(Boolean).join('\n')
  }
  return [
    rows('FTX', inv.ftx ?? []),
    rows('SBYL', inv.sbyl ?? []),
  ].join('\n\n')
}

function fmtOpenPos(pos: any): string {
  if (!pos) return ''
  const rows = (company: string, lines: any[]) => {
    if (!lines.length) return `## Open ITPO Lines — ${company}\n(none)`
    return [
      `## Open ITPO Lines — ${company} (${lines.length} lines)`,
      'PO# | SKU | Qty | ETA',
      ...lines.slice(0, 200).map((l: any) => `${l.poNumber} | ${l.sku} | ${l.qty.toLocaleString()} | ${l.eta}`),
    ].join('\n')
  }
  return [rows('FTX', pos.ftx ?? []), rows('SBYL', pos.sbyl ?? [])].join('\n\n')
}

function fmtSupply(supply: any[]): string {
  if (!supply?.length) return ''
  const grouped: Record<string, any[]> = {}
  for (const i of supply) {
    ;(grouped[i.category] ??= []).push(i)
  }
  const lines = ['## TFM Raw Material / Component Inventory', 'SKU | Name | Category | On-Hand | Incoming POs | Next Arrival']
  for (const [cat, items] of Object.entries(grouped)) {
    for (const i of items) {
      lines.push(`${i.sku} | ${i.name} | ${cat} | ${i.onHand.toLocaleString()} | ${i.incomingPos} | ${i.nextArrival ?? '—'}${i.onHand === 0 ? ' ⚠️ ZERO STOCK' : ''}`)
    }
  }
  return lines.join('\n')
}

function fmtPoSchedule(sched: any): string {
  if (!sched) return ''
  const rows = (company: string, lines: any[]) => {
    if (!lines.length) return `## Recommended PO Schedule — ${company}\n(none needed within 1 year)`
    return [
      `## Recommended PO Schedule — ${company} (next ${lines.length} orders)`,
      'SKU | Recommended Qty | Target ETA | DOC at trigger',
      ...lines.map((l: any) => `${l.sku} | ${l.qty.toLocaleString()} | ${l.eta} | ${l.docAtTrigger}d`),
    ].join('\n')
  }
  return [rows('FTX', sched.ftx ?? []), rows('SBYL', sched.sbyl ?? [])].join('\n\n')
}

// ── System prompt builder ────────────────────────────────────────────────────

function buildSystemPrompt(context?: any): string {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

  const sections: string[] = []

  // Health overview (always included when available)
  if (context?.healthMetrics && context?.recommendations) {
    const m = context.healthMetrics
    const critical    = context.recommendations.filter((r: any) => r.urgency === 'critical')
    const urgent      = context.recommendations.filter((r: any) => r.urgency === 'urgent')
    const actionsNeeded = context.recommendations.filter((r: any) =>
      r.actionType !== 'on_track' && r.actionType !== 'new_product'
    )
    sections.push(`## Operational Health Snapshot (${today})
Tracking ${m.totalItems} SKUs | 🔴 Critical: ${m.criticalCount} | 🟠 Urgent: ${m.urgentCount} | 🟡 High: ${m.highCount} | 🔵 Medium: ${m.mediumCount}
Avg DOC: FTX ${m.avgFTXDOC?.toFixed(1)}d · SBYL ${m.avgSBYLDOC?.toFixed(1)}d | Actions needed: ${m.actionsNeeded}
${critical.length > 0 ? `\nCRITICAL:\n${critical.slice(0, 15).map((r: any) => `  ${r.company} ${r.sku}: ${r.currentDOC.toFixed(1)}d DOC — ${r.actionType.replace(/_/g, ' ')}`).join('\n')}` : ''}
${urgent.length > 0 ? `\nURGENT:\n${urgent.slice(0, 15).map((r: any) => `  ${r.company} ${r.sku}: ${r.currentDOC.toFixed(1)}d DOC (${r.daysUntilCritical}d buffer)`).join('\n')}` : ''}
${actionsNeeded.length > 0 ? `\nAll recommended actions:\n${actionsNeeded.slice(0, 30).map((r: any) => `  ${r.company} ${r.sku}: ${r.actionType.replace(/_/g, ' ')} — ${r.reasoning?.split('.')[0]}`).join('\n')}` : ''}`)
  } else {
    sections.push(`## Context\nToday is ${today}. No live health data provided — answer from general supply chain knowledge.`)
  }

  // Optional data modules
  if (context?.inventory)   sections.push(fmtInventory(context.inventory))
  if (context?.open_pos)    sections.push(fmtOpenPos(context.open_pos))
  if (context?.supply)      sections.push(fmtSupply(context.supply))
  if (context?.po_schedule) sections.push(fmtPoSchedule(context.po_schedule))

  const loadedModules = [
    context?.inventory   ? 'Full Inventory & DOC' : null,
    context?.open_pos    ? 'Open ITPO Lines'       : null,
    context?.supply      ? 'Raw Material Stock'    : null,
    context?.po_schedule ? 'PO Schedule Recs'      : null,
  ].filter(Boolean)

  return `You are an expert supply chain analyst and purchasing advisor for TFM (The Foam Manufacturer), embedded in the BulkPurchasing operations tool.

BulkPurchasing manages production scheduling and purchasing for two distribution companies — FTX and SBYL — that both source finished goods from TFM's single manufacturing facility.

**Key concepts:**
- DOC (Days of Cover): inventory ÷ average daily sales. Safety minimum: ${process.env.POSCHEDULE_MIN_DOC ?? 15} days.
- POScheduleGenerator: day-by-day DOC simulation determining PO arrival dates and quantities.
- TFM daily production capacity: ${process.env.PRODUCTION_DAILY_CAPACITY ?? 600} units.
- FTX and SBYL compete for the same TFM supply pool.
- ITPO (Inter-company Transfer PO): the mechanism by which FTX/SBYL order from TFM.
- RPKG items: components (e.g. mattresses) whose effective inventory = assembled units + loose component units.
- New products (ADS = 0): have ERP POs but no sales history yet.

**Live data loaded:** ${loadedModules.length > 0 ? loadedModules.join(', ') : 'Health overview only'}

${sections.join('\n\n')}

**How to respond:**
- Be concise and actionable. Lead with the most critical items.
- Reference specific SKUs, quantities, and dates from the data above when possible.
- When you don't have specific data for something asked, say so and offer general guidance.
- You cannot take direct ERP action — your role is analysis and recommendations.
- Use DOC terminology naturally.`
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not configured. Add it to .env.local to enable AI chat.' },
      { status: 503 }
    )
  }

  try {
    const body = await req.json()
    const { messages = [], context } = body

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'messages array is required' }, { status: 400 })
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    // Build Anthropic message format
    const anthropicMessages = messages.map((m: any) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content as string,
    }))

    // Stream back to client
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 8192,
            system: buildSystemPrompt(context),
            messages: anthropicMessages,
            stream: true,
          })

          for await (const chunk of response) {
            if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
              controller.enqueue(encoder.encode(chunk.delta.text))
            }
          }
          controller.close()
        } catch (err: any) {
          controller.enqueue(encoder.encode(`\n\n[Error: ${err.message}]`))
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (err: any) {
    console.error('ask-claude/chat error:', err)
    return NextResponse.json({ error: err.message ?? 'Server error' }, { status: 500 })
  }
}
