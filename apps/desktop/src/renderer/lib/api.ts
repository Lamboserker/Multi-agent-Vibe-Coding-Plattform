import type { AppEvent, MacBridge } from '../../shared/bridge'

declare global {
  interface Window {
    mac?: MacBridge
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function bridge(): MacBridge {
  if (!window.mac) throw new Error('The desktop bridge is not available. Start the app through Electron.')
  return window.mac
}

/** Round-trip times of the last API calls (IPC + HTTP + runtime), for the diagnostics view. */
export const apiTimings: Array<{ method: string; route: string; ms: number; status: number }> = []

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const started = performance.now()
  const response = await bridge().api<T>(method, path, body)
  apiTimings.push({ method, route: (path.split('?')[0] ?? '').replace(/\/c[a-z0-9]{20,}/g, '/:id'), ms: Math.round((performance.now() - started) * 10) / 10, status: response.status })
  if (apiTimings.length > 500) apiTimings.shift()
  if (response.status >= 400) {
    const data = response.data as { message?: unknown } | undefined
    const message = Array.isArray(data?.message) ? data!.message.join(', ') : typeof data?.message === 'string' ? data.message : `Request failed (${response.status})`
    throw new ApiError(message, response.status, response.data)
  }
  return response.data
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}

export const enc = encodeURIComponent

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type { AppEvent }
