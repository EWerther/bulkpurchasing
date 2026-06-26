'use client'

import { useState, useEffect, useRef, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Send, Loader2, Bot, User, Zap, AlertCircle, Sparkles, X, ChevronDown, ChevronUp, Database, RefreshCw, Check } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant'
  content: string
  id: string
}

const STORAGE_KEY = 'ask-claude-messages'
const MAX_STORED  = 40   // max messages persisted to localStorage

// ─── Context module definitions ───────────────────────────────────────────────

const MODULES = [
  {
    id: 'inventory',
    label: 'Inventory & DOC',
    icon: '📦',
    description: 'Full FTX + SBYL inventory with days-of-cover per SKU, sorted most-urgent first',
  },
  {
    id: 'open_pos',
    label: 'Open POs',
    icon: '📋',
    description: 'All open intercompany PO lines — PO numbers, quantities, ETAs',
  },
  {
    id: 'supply',
    label: 'Raw Materials',
    icon: '🏭',
    description: 'TFM component inventory (foam, covers, fire socks, etc.) with incoming POs',
  },
  {
    id: 'po_schedule',
    label: 'PO Schedule',
    icon: '📅',
    description: 'Algorithm-recommended PO actions for the next 12 months',
  },
] as const

type ModuleId = typeof MODULES[number]['id']

// ─── Markdown renderer ────────────────────────────────────────────────────────

function formatInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i} style={{ color: '#0f172a', fontWeight: 600 }}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
      return <em key={i} style={{ color: '#334155' }}>{part.slice(1, -1)}</em>
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="font-mono text-xs px-1.5 py-0.5 rounded" style={{ background: '#f1f5f9', color: '#4f46e5' }}>{part.slice(1, -1)}</code>
    return part
  })
}

function isTableRow(line: string) {
  return line.trim().startsWith('|') && line.trim().endsWith('|')
}
function isSeparatorRow(line: string) {
  return isTableRow(line) && /^\|[\s\-:|]+\|$/.test(line.trim().replace(/\|[\s\-:|]+/g, '|').replace(/\|$/,'|'))
}

function renderContent(text: string) {
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // Headings
    if (line.startsWith('### ')) {
      elements.push(<div key={i} className="text-xs font-bold mt-3 mb-1 uppercase tracking-wider" style={{ color: '#64748b' }}>{formatInline(line.slice(4))}</div>)
    } else if (line.startsWith('## ')) {
      elements.push(<div key={i} className="text-sm font-bold mt-4 mb-1" style={{ color: '#0f172a' }}>{formatInline(line.slice(3))}</div>)
    } else if (line.startsWith('# ')) {
      elements.push(<div key={i} className="text-base font-bold mt-4 mb-1" style={{ color: '#0f172a' }}>{formatInline(line.slice(2))}</div>)

    // Pipe table — collect all rows
    } else if (isTableRow(line)) {
      const tableRows: string[][] = []
      let isHeader = true
      while (i < lines.length && isTableRow(lines[i])) {
        if (isSeparatorRow(lines[i])) { i++; isHeader = false; continue }
        const cells = lines[i].trim().slice(1, -1).split('|').map(c => c.trim())
        tableRows.push(cells)
        i++
      }
      elements.push(
        <div key={`table-${i}`} className="overflow-auto my-2 rounded-lg border" style={{ borderColor: '#dde3ed' }}>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {tableRows[0]?.map((cell, ci) => (
                  <th key={ci} className="px-3 py-2 text-left font-semibold border-b" style={{ color: '#475569', borderColor: '#dde3ed' }}>
                    {formatInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.slice(1).map((row, ri) => (
                <tr key={ri} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-1.5 font-mono" style={{ color: '#334155' }}>
                      {formatInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue

    // Numbered list
    } else if (/^\d+\.\s/.test(trimmed)) {
      const num = trimmed.match(/^(\d+)\./)?.[1]
      const content = trimmed.replace(/^\d+\.\s/, '')
      elements.push(
        <div key={i} className="flex gap-2 my-0.5">
          <span className="shrink-0 font-mono text-xs font-bold" style={{ color: '#4f46e5', minWidth: 18 }}>{num}.</span>
          <span className="text-sm" style={{ color: '#475569', lineHeight: 1.6 }}>{formatInline(content)}</span>
        </div>
      )

    // Bullet list
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(
        <div key={i} className="flex gap-2 my-0.5">
          <span style={{ color: '#4f46e5', flexShrink: 0, marginTop: 2 }}>•</span>
          <span className="text-sm" style={{ color: '#475569', lineHeight: 1.6 }}>{formatInline(line.slice(2))}</span>
        </div>
      )

    // Horizontal rule
    } else if (trimmed === '---' || trimmed === '***') {
      elements.push(<hr key={i} className="my-3" style={{ borderColor: '#e8edf5' }} />)

    // Blank line
    } else if (trimmed === '') {
      elements.push(<div key={i} className="h-2" />)

    // Regular paragraph
    } else {
      elements.push(<p key={i} className="text-sm leading-relaxed" style={{ color: '#475569' }}>{formatInline(line)}</p>)
    }
    i++
  }
  return elements
}

// ─── Context Selector ─────────────────────────────────────────────────────────

function ContextSelector({
  healthCtx,
  moduleData,
  loadingModules,
  onToggle,
}: {
  healthCtx: any
  moduleData: Record<string, any>
  loadingModules: Set<string>
  onToggle: (id: ModuleId) => void
}) {
  const [open, setOpen] = useState(true)
  const m = healthCtx?.healthMetrics

  return (
    <div className="shrink-0 border-b" style={{ background: '#f8fafc', borderColor: '#dde3ed' }}>
      <button
        className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-semibold"
        onClick={() => setOpen(o => !o)}
        style={{ color: '#475569' }}
      >
        <Database size={12} style={{ color: '#4f46e5' }} />
        Context
        {m && (
          <span className="text-[10px] font-mono" style={{ color: '#94a3b8' }}>
            — Health: {m.totalItems} SKUs · {m.criticalCount > 0 ? `🔴 ${m.criticalCount} critical` : '✓ no critical'}
          </span>
        )}
        <div className="flex-1" />
        <span className="text-[10px]" style={{ color: '#94a3b8' }}>
          {Object.keys(moduleData).length} extra module{Object.keys(moduleData).length !== 1 ? 's' : ''} loaded
        </span>
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {open && (
        <div className="px-4 pb-3 space-y-2">
          {/* Health always-on chip */}
          <div className="flex flex-wrap gap-2 items-center">
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border"
              style={{ background: 'rgba(22,163,74,0.08)', borderColor: 'rgba(22,163,74,0.3)', color: '#16a34a' }}
            >
              <Sparkles size={9} /> Health Overview
              <span style={{ color: 'rgba(22,163,74,0.6)', fontSize: 9 }}>always on</span>
            </span>

            {/* Optional module chips */}
            {MODULES.map(mod => {
              const loaded  = !!moduleData[mod.id]
              const loading = loadingModules.has(mod.id)
              return (
                <button
                  key={mod.id}
                  onClick={() => onToggle(mod.id)}
                  disabled={loading}
                  title={mod.description}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all"
                  style={loaded ? {
                    background: 'rgba(79,70,229,0.08)',
                    borderColor: 'rgba(79,70,229,0.35)',
                    color: '#4f46e5',
                  } : {
                    background: '#ffffff',
                    borderColor: '#dde3ed',
                    color: '#94a3b8',
                  }}
                >
                  {loading
                    ? <Loader2 size={9} className="animate-spin" />
                    : loaded
                    ? <Check size={9} />
                    : <span style={{ fontSize: 10 }}>{mod.icon}</span>
                  }
                  {mod.label}
                </button>
              )
            })}
          </div>

          {/* Summary of what's loaded */}
          {Object.keys(moduleData).length > 0 && (
            <div className="text-[10px] font-mono" style={{ color: '#94a3b8' }}>
              {[
                moduleData.inventory   && `Inventory: ${(moduleData.inventory.ftx?.length ?? 0) + (moduleData.inventory.sbyl?.length ?? 0)} SKUs`,
                moduleData.open_pos    && `Open POs: ${(moduleData.open_pos.ftx?.length ?? 0) + (moduleData.open_pos.sbyl?.length ?? 0)} lines`,
                moduleData.supply      && `Materials: ${moduleData.supply?.length ?? 0} components`,
                moduleData.po_schedule && `PO Schedule: ${(moduleData.po_schedule.ftx?.length ?? 0) + (moduleData.po_schedule.sbyl?.length ?? 0)} recommended orders`,
              ].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Message Bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg, isStreaming }: { msg: Message; isStreaming?: boolean }) {
  const isUser = msg.role === 'user'
  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''} items-start`}>
      <div className="shrink-0 flex items-center justify-center rounded-full"
        style={{ width: 28, height: 28, background: isUser ? '#4f46e5' : 'linear-gradient(135deg, #1e293b, #0f172a)', border: isUser ? 'none' : '1px solid #334155' }}>
        {isUser ? <User size={13} className="text-white" /> : <Bot size={13} className="text-white" />}
      </div>
      <div className="flex-1 min-w-0 max-w-[85%] rounded-2xl px-4 py-3"
        style={{
          background: isUser ? 'linear-gradient(135deg, #4f46e5, #7c3aed)' : '#ffffff',
          border: isUser ? 'none' : '1px solid #dde3ed',
          boxShadow: isUser ? '0 2px 8px rgba(79,70,229,0.25)' : '0 1px 3px rgba(15,23,42,0.06)',
          borderRadius: isUser ? '18px 18px 4px 18px' : '4px 18px 18px 18px',
        }}
      >
        {isUser
          ? <p className="text-sm text-white leading-relaxed whitespace-pre-wrap">{msg.content}</p>
          : <div>
              {renderContent(msg.content)}
              {isStreaming && <span className="inline-block ml-0.5" style={{ width: 2, height: 14, background: '#4f46e5', verticalAlign: 'middle', animation: 'pulse 1s ease-in-out infinite' }} />}
            </div>
        }
      </div>
    </div>
  )
}

// ─── Suggestions ──────────────────────────────────────────────────────────────

const SUGGESTIONS = [
  'What should I prioritize today?',
  'Which SKUs are most at risk this week?',
  'Which items need a new PO created?',
  'Are there any supply feasibility concerns?',
  'Show me all FTX items below 15 days of cover',
  'Which existing POs need their ETA pushed out?',
]

// ─── Main Page ────────────────────────────────────────────────────────────────

function AskClaudePageInner() {
  const searchParams = useSearchParams()
  const [messages,       setMessages]       = useState<Message[]>([])
  const [input,          setInput]          = useState(() => searchParams.get('q') ?? '')
  const [streaming,      setStreaming]      = useState(false)
  const [streamingId,    setStreamingId]    = useState<string | null>(null)
  const [healthCtx,      setHealthCtx]      = useState<any>(null)
  const [healthLoading,  setHealthLoading]  = useState(true)
  const [moduleData,     setModuleData]     = useState<Record<string, any>>({})
  const [loadingModules, setLoadingModules] = useState<Set<string>>(new Set())
  const [apiError,       setApiError]       = useState<string | null>(null)
  const bottomRef  = useRef<HTMLDivElement>(null)
  const inputRef   = useRef<HTMLTextAreaElement>(null)
  const abortRef   = useRef<AbortController | null>(null)
  const autoSentRef = useRef(false)
  const didRestoreRef = useRef(false)

  // ── Restore messages from localStorage on mount ───────────────────────────
  useEffect(() => {
    if (didRestoreRef.current) return
    didRestoreRef.current = true
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed.slice(-MAX_STORED))
        }
      }
    } catch { /* ignore */ }
  }, [])

  // ── Persist messages to localStorage whenever they change ─────────────────
  useEffect(() => {
    if (!didRestoreRef.current) return
    try {
      if (messages.length > 0) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_STORED)))
      } else {
        localStorage.removeItem(STORAGE_KEY)
      }
    } catch { /* ignore */ }
  }, [messages])

  // ── Load health overview on mount ─────────────────────────────────────────
  useEffect(() => {
    fetch('/api/command-center/data')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setHealthCtx(d) })
      .catch(() => {})
      .finally(() => setHealthLoading(false))
  }, [])

  // ── Module toggle ─────────────────────────────────────────────────────────
  const toggleModule = useCallback(async (moduleId: ModuleId) => {
    if (moduleData[moduleId]) {
      // Unload
      setModuleData(prev => { const next = { ...prev }; delete next[moduleId]; return next })
      return
    }
    // Load
    setLoadingModules(prev => new Set([...prev, moduleId]))
    try {
      const res = await fetch(`/api/ask-claude/context?modules=${moduleId}`)
      if (res.ok) {
        const data = await res.json()
        setModuleData(prev => ({ ...prev, ...data }))
      }
    } finally {
      setLoadingModules(prev => { const next = new Set(prev); next.delete(moduleId); return next })
    }
  }, [moduleData])

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || streaming) return
    setApiError(null)

    const userMsg: Message      = { role: 'user',      content: text.trim(), id: `user-${Date.now()}` }
    const assistantId           = `assistant-${Date.now()}`
    const assistantMsg: Message = { role: 'assistant', content: '',          id: assistantId }

    setMessages(prev => [...prev, userMsg, assistantMsg])
    setInput('')
    setStreaming(true)
    setStreamingId(assistantId)

    const allMessages = [...messages, userMsg]

    try {
      const ctrl = new AbortController()
      abortRef.current = ctrl

      const contextPayload = {
        healthMetrics:   healthCtx?.healthMetrics,
        recommendations: healthCtx?.recommendations?.slice(0, 50),
        ...moduleData,
      }

      const res = await fetch('/api/ask-claude/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: allMessages.map(m => ({ role: m.role, content: m.content })),
          context: contextPayload,
        }),
        signal: ctrl.signal,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }))
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }

      const reader  = res.body!.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        accumulated += decoder.decode(value, { stream: true })
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: accumulated } : m))
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: m.content + '\n\n*[Stopped]*' } : m))
      } else {
        setApiError(err.message ?? 'Something went wrong')
        setMessages(prev => prev.filter(m => m.id !== assistantId))
      }
    } finally {
      setStreaming(false)
      setStreamingId(null)
      abortRef.current = null
      inputRef.current?.focus()
    }
  }, [streaming, messages, healthCtx, moduleData])

  // Auto-send if ?q= param is present
  useEffect(() => {
    const q = searchParams.get('q')
    if (q && !autoSentRef.current && !healthLoading) {
      autoSentRef.current = true
      sendMessage(q)
    }
  }, [healthLoading, searchParams, sendMessage])

  // Scroll to bottom on new messages
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const clearChat = () => {
    if (streaming) abortRef.current?.abort()
    setMessages([])
    setApiError(null)
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  }

  const isEmpty = messages.length === 0

  return (
    <div className="flex flex-col h-full">

      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b"
        style={{ background: '#ffffff', borderColor: '#dde3ed' }}>
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center rounded-lg"
            style={{ width: 30, height: 30, background: 'linear-gradient(135deg, #1e293b, #0f172a)', border: '1px solid #334155' }}>
            <Bot size={14} className="text-white" />
          </div>
          <div>
            <h1 className="text-sm font-bold" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Ask Claude</h1>
            <p className="text-[11px]" style={{ color: '#94a3b8' }}>AI analyst with live supply chain context</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {healthLoading
            ? <div className="flex items-center gap-1.5 text-[11px]" style={{ color: '#94a3b8' }}><Loader2 size={11} className="animate-spin" /> Loading…</div>
            : healthCtx
            ? <div className="flex items-center gap-1.5 text-[11px]" style={{ color: '#16a34a' }}><Zap size={11} /> Context ready</div>
            : null
          }

          {/* Memory indicator */}
          {messages.length > 0 && (
            <div className="flex items-center gap-1.5 text-[11px]" style={{ color: '#64748b' }}>
              <RefreshCw size={9} />
              {messages.filter(m => m.role === 'user').length} saved
            </div>
          )}

          {messages.length > 0 && (
            <button
              onClick={clearChat}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors"
              style={{ color: '#94a3b8', borderColor: '#dde3ed' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#dc2626'; (e.currentTarget as HTMLElement).style.borderColor = '#dc2626' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#94a3b8'; (e.currentTarget as HTMLElement).style.borderColor = '#dde3ed' }}
              title="Clear chat history (also clears saved memory)"
            >
              <X size={11} /> Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Context selector ─────────────────────────────────────────── */}
      {!healthLoading && (
        <ContextSelector
          healthCtx={healthCtx}
          moduleData={moduleData}
          loadingModules={loadingModules}
          onToggle={toggleModule}
        />
      )}

      {/* ── API error ────────────────────────────────────────────────── */}
      {apiError && (
        <div className="shrink-0 mx-5 mt-3 p-3 rounded-xl flex items-start gap-2"
          style={{ background: 'rgba(220,38,38,0.07)', border: '1px solid rgba(220,38,38,0.2)' }}>
          <AlertCircle size={14} style={{ color: '#dc2626', flexShrink: 0, marginTop: 1 }} />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold" style={{ color: '#dc2626' }}>Error</div>
            <div className="text-xs mt-0.5" style={{ color: '#475569' }}>{apiError}</div>
          </div>
          <button onClick={() => setApiError(null)} style={{ color: '#94a3b8' }}><X size={13} /></button>
        </div>
      )}

      {/* ── Messages ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto px-4 py-4">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center min-h-[60%] gap-6">
            <div className="text-center">
              <div className="mx-auto mb-3 flex items-center justify-center rounded-2xl"
                style={{ width: 52, height: 52, background: 'linear-gradient(135deg, #1e293b, #0f172a)', border: '1px solid #334155', boxShadow: '0 4px 20px rgba(0,0,0,0.15)' }}>
                <Bot size={24} className="text-white" />
              </div>
              <h2 className="text-base font-bold mb-1" style={{ color: '#0f172a' }}>How can I help?</h2>
              <p className="text-xs max-w-sm text-center" style={{ color: '#94a3b8' }}>
                Toggle the data modules above to give me access to inventory, open POs, raw materials, and PO recommendations.
                My memory of our past conversations is saved automatically.
              </p>
            </div>
            <div className="w-full max-w-lg space-y-2">
              {SUGGESTIONS.map((s, i) => (
                <button key={i} onClick={() => sendMessage(s)}
                  className="w-full text-left text-sm px-4 py-3 rounded-xl border transition-all"
                  style={{ color: '#475569', borderColor: '#dde3ed', background: '#ffffff' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = '#4f46e5'; (e.currentTarget as HTMLElement).style.background = 'rgba(79,70,229,0.03)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = '#dde3ed'; (e.currentTarget as HTMLElement).style.background = '#ffffff' }}
                >
                  <span style={{ color: '#c9d2e0', marginRight: 8 }}>↗</span>{s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-4 pb-4">
            {messages.map(msg => (
              <MessageBubble key={msg.id} msg={msg} isStreaming={streaming && msg.id === streamingId} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* ── Input ────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t px-4 py-3" style={{ background: '#ffffff', borderColor: '#dde3ed' }}>
        <form onSubmit={e => { e.preventDefault(); sendMessage(input) }} className="max-w-3xl mx-auto">
          <div className="flex items-end gap-2 rounded-2xl border px-3 py-2 transition-all"
            style={{ borderColor: '#dde3ed', background: '#f8fafc' }}
            onFocusCapture={e => (e.currentTarget as HTMLElement).style.borderColor = '#4f46e5'}
            onBlurCapture={e => (e.currentTarget as HTMLElement).style.borderColor = '#dde3ed'}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input) } }}
              placeholder="Ask about inventory, purchasing recommendations, supply chain…"
              rows={1}
              disabled={streaming}
              className="flex-1 resize-none bg-transparent text-sm outline-none py-1 leading-relaxed"
              style={{ color: '#0f172a', maxHeight: 120, minHeight: 24, fontFamily: 'inherit' }}
              onInput={e => { const el = e.currentTarget; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 120)}px` }}
            />
            <div className="flex items-center gap-2 shrink-0">
              {streaming ? (
                <button type="button" onClick={() => abortRef.current?.abort()}
                  className="flex items-center justify-center rounded-xl transition-all"
                  style={{ width: 32, height: 32, background: 'rgba(220,38,38,0.1)', color: '#dc2626' }}>
                  <X size={14} />
                </button>
              ) : (
                <button type="submit" disabled={!input.trim()}
                  className="flex items-center justify-center rounded-xl transition-all"
                  style={{ width: 32, height: 32, background: input.trim() ? 'linear-gradient(135deg, #4f46e5, #7c3aed)' : '#e8edf5', color: input.trim() ? '#ffffff' : '#94a3b8' }}>
                  <Send size={13} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
          <div className="text-[10px] mt-1.5 text-center" style={{ color: '#c9d2e0' }}>
            Enter to send · Shift+Enter for new line · Conversation saved automatically
          </div>
        </form>
      </div>
    </div>
  )
}

export default function AskClaudePage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full" style={{ width: 32, height: 32, border: '3px solid #e8edf5', borderTopColor: '#4f46e5' }} />
      </div>
    }>
      <AskClaudePageInner />
    </Suspense>
  )
}
