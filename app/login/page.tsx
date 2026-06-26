'use client'

import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Zap, AlertCircle } from 'lucide-react'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const callbackUrl = searchParams.get('callbackUrl') ?? '/po-schedule'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const result = await signIn('credentials', { username, password, redirect: false })
    setLoading(false)
    if (result?.error) setError('Invalid username or password')
    else router.push(callbackUrl)
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{
        background: 'radial-gradient(ellipse 80% 60% at 50% -10%, rgba(99,102,241,0.15) 0%, #070a12 60%)',
      }}
    >
      {/* Background grid */}
      <div
        className="fixed inset-0 pointer-events-none opacity-20"
        style={{
          backgroundImage: 'linear-gradient(rgba(99,102,241,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.06) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />

      <div className="relative w-full max-w-sm mx-4">
        {/* Logo */}
        <div className="text-center mb-8">
          <div
            className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-5"
            style={{
              background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
              boxShadow: '0 0 32px rgba(99,102,241,0.4), 0 0 64px rgba(99,102,241,0.15)',
            }}
          >
            <Zap size={26} className="text-white" strokeWidth={2.5} />
          </div>
          <h1
            className="text-2xl font-bold text-text-primary mb-1"
            style={{ letterSpacing: '-0.03em' }}
          >
            BulkBuy
          </h1>
          <p className="text-sm text-text-muted">TFM Operations · Internal Tool</p>
        </div>

        {/* Card */}
        <div
          className="rounded-2xl border border-border-light p-6"
          style={{
            background: 'linear-gradient(160deg, #111628 0%, #0c1020 100%)',
            boxShadow: '0 0 0 1px rgba(99,102,241,0.08), 0 8px 40px rgba(0,0,0,0.5), 0 0 80px rgba(99,102,241,0.05)',
          }}
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-widest text-text-muted mb-1.5">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
                placeholder="Enter username"
                className="input"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-widest text-text-muted mb-1.5">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                placeholder="••••••••"
                className="input"
              />
            </div>

            {error && (
              <div
                className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm"
                style={{
                  background: 'rgba(244,63,94,0.08)',
                  border: '1px solid rgba(244,63,94,0.25)',
                  color: '#fb7185',
                }}
              >
                <AlertCircle size={14} className="shrink-0" />
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full justify-center mt-2"
              style={{ height: 42 }}
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-text-muted mt-5 opacity-50">
          For authorized TFM personnel only
        </p>
      </div>
    </div>
  )
}
