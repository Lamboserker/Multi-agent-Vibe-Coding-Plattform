export const AUTH_STORAGE_KEY = 'multi-ai-coder.auth'
export const AUTH_TOKEN_STORAGE_KEY = 'multi-ai-coder.auth-token'
export const AUTH_LAST_ACTIVITY_STORAGE_KEY = 'multi-ai-coder.auth-last-activity'
export const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000

export interface StoredAuthSession {
  token: string
  user: {
    id: string
    email: string
    name: string
    createdAt: string
  }
  expiresAt: string
}

export function persistAuthSession(session: StoredAuthSession) {
  if (!isBrowser()) return
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session))
  window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, session.token)
  markAuthActivity()
}

export function readAuthToken(): string | null {
  if (!isBrowser()) return null
  return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)
}

export function readLastAuthActivity(): number | null {
  if (!isBrowser()) return null
  const value = Number(window.localStorage.getItem(AUTH_LAST_ACTIVITY_STORAGE_KEY))
  return Number.isFinite(value) && value > 0 ? value : null
}

export function markAuthActivity(timestamp = Date.now()) {
  if (!isBrowser()) return
  window.localStorage.setItem(AUTH_LAST_ACTIVITY_STORAGE_KEY, String(timestamp))
}

export function clearAuthSession() {
  if (!isBrowser()) return
  window.localStorage.removeItem(AUTH_STORAGE_KEY)
  window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
  window.localStorage.removeItem(AUTH_LAST_ACTIVITY_STORAGE_KEY)
}

export function isAuthTimedOut(now = Date.now()) {
  const lastActivity = readLastAuthActivity()
  return lastActivity !== null && now - lastActivity >= INACTIVITY_TIMEOUT_MS
}

function isBrowser() {
  return typeof window !== 'undefined'
}
