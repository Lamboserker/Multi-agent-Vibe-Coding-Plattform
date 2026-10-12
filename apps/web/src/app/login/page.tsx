'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Script from 'next/script'
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from 'react'
import { ArrowRight, Cloud, KeyRound, Mail, ShieldCheck, UserRound } from 'lucide-react'
import { ApiError, apiRequest } from '@/lib/api'
import { persistAuthSession } from '@/lib/auth-storage'

declare global {
  interface Window {
    VANTA?: {
      CLOUDS: (options: {
        el: HTMLElement
        mouseControls: boolean
        touchControls: boolean
        gyroControls: boolean
        minHeight: number
        minWidth: number
      }) => { destroy: () => void }
    }
  }
}

export default function LoginPage() {
  const router = useRouter()
  const backgroundRef = useRef<HTMLDivElement | null>(null)
  const vantaEffectRef = useRef<{ destroy: () => void } | null>(null)
  const [threeReady, setThreeReady] = useState(false)
  const [vantaReady, setVantaReady] = useState(false)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [form, setForm] = useState({ name: '', email: '', password: '', keepSession: true })
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('reason')
    if (reason === 'inactive') setStatus('Session ended after 30 minutes of inactivity.')
    if (reason === 'session-expired') setStatus('Session expired. Please sign in again.')
    if (reason === 'logout') setStatus('You have been logged out.')
  }, [])

  useEffect(() => {
    if (!threeReady || !vantaReady || !backgroundRef.current || !window.VANTA?.CLOUDS || vantaEffectRef.current) {
      return
    }

    vantaEffectRef.current = window.VANTA.CLOUDS({
      el: backgroundRef.current,
      mouseControls: true,
      touchControls: true,
      gyroControls: false,
      minHeight: 200.0,
      minWidth: 200.0,
    })

    return () => {
      vantaEffectRef.current?.destroy()
      vantaEffectRef.current = null
    }
  }, [threeReady, vantaReady])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setStatus(null)
    setSubmitting(true)

    try {
      const result = await apiRequest<AuthResponse>(mode === 'register' ? '/auth/register' : '/auth/login', {
        method: 'POST',
        body: JSON.stringify(form),
      })
      persistAuthSession(result)
      setStatus(mode === 'register' ? 'Account created. Opening workspace.' : 'Signed in. Opening workspace.')
      router.push('/workspace')
    } catch (submitError) {
      setError(formatAuthError(submitError))
    } finally {
      setSubmitting(false)
    }
  }

  function updateField(event: ChangeEvent<HTMLInputElement>) {
    const { name, value, checked, type } = event.target
    setForm((current) => ({ ...current, [name]: type === 'checkbox' ? checked : value }))
  }

  return (
    <main className="login-page">
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r134/three.min.js" strategy="afterInteractive" onLoad={() => setThreeReady(true)} />
      {threeReady ? (
        <Script src="https://cdn.jsdelivr.net/npm/vanta@latest/dist/vanta.clouds.min.js" strategy="afterInteractive" onLoad={() => setVantaReady(true)} />
      ) : null}

      <div ref={backgroundRef} className="login-vanta-bg" aria-hidden="true" />
      <div className="login-grid-overlay" aria-hidden="true" />

      <section className="login-shell" aria-label="Multi-AI Coder Login">
        <div className="login-brand">
          <div className="login-mark">AI</div>
          <div>
            <strong>Multi-AI Coder</strong>
            <span>Cost-Aware Coding Platform</span>
          </div>
        </div>

        <div className="login-copy">
          <Cloud size={22} />
          <h1>{mode === 'register' ? 'Create operator access' : 'Secure cockpit access'}</h1>
          <p>{mode === 'register' ? 'Register an operator account for this local orchestration cockpit.' : 'Authenticate before opening the orchestration workspace, provider controls, run history, and project context.'}</p>
        </div>

        <div className="login-mode-switch" role="tablist" aria-label="Auth mode">
          <button className={mode === 'login' ? 'active' : ''} type="button" onClick={() => setMode('login')}>Login</button>
          <button className={mode === 'register' ? 'active' : ''} type="button" onClick={() => setMode('register')}>Register</button>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          {mode === 'register' ? (
            <label>
              <span>Name</span>
              <div>
                <UserRound size={16} />
                <input name="name" value={form.name} onChange={updateField} autoComplete="name" placeholder="Max Mustermann" required />
              </div>
            </label>
          ) : null}

          <label>
            <span>Email</span>
            <div>
              <Mail size={16} />
              <input name="email" type="email" value={form.email} onChange={updateField} autoComplete="email" placeholder="operator@example.com" required />
            </div>
          </label>

          <label>
            <span>Password</span>
            <div>
              <KeyRound size={16} />
              <input name="password" type="password" value={form.password} onChange={updateField} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} placeholder={mode === 'register' ? 'Minimum 8 characters' : 'Access key'} minLength={8} required />
            </div>
          </label>

          <div className="login-options">
            <label>
              <input name="keepSession" type="checkbox" checked={form.keepSession} onChange={updateField} />
              Keep session
            </label>
            <Link href="/workspace">Workspace</Link>
          </div>

          {error ? <p className="login-message error">{error}</p> : null}
          {status ? <p className="login-message ok">{status}</p> : null}

          <button type="submit" disabled={submitting}>
            {submitting ? 'Processing' : mode === 'register' ? 'Create account' : 'Sign in'}
            <ArrowRight size={17} />
          </button>
        </form>

        <div className="login-trust">
          <span><ShieldCheck size={15} /> Server-side provider keys</span>
          <span>Local-first routing</span>
          <span>Premium gated</span>
        </div>
      </section>
    </main>
  )
}

interface AuthResponse {
  token: string
  user: {
    id: string
    email: string
    name: string
    createdAt: string
  }
  expiresAt: string
}

function formatAuthError(error: unknown) {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return 'Authentication failed.'
}
