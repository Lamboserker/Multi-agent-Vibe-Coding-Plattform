import { clearAuthSession, readAuthToken } from './auth-storage'

export const API_BASE_URL = '/api/backend'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = readAuthToken()

  if (!headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  })

  const text = await response.text()
  const payload = text ? safeJson(text) : null

  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/login') && !path.startsWith('/auth/register')) {
      clearAuthSession()
      window.location.assign('/login?reason=session-expired')
    }

    const message =
      typeof payload === 'object' && payload && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : `API request failed with HTTP ${response.status}`
    throw new ApiError(message, response.status, payload)
  }

  return payload as T
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
