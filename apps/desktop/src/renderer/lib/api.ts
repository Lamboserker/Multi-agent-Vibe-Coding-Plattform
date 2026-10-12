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

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const response = await bridge().api<T>(method, path, body)
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
