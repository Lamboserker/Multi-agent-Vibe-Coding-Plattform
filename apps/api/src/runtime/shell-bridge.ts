/**
 * Requests from the runtime to the desktop shell (Electron main process) over the utility-process
 * parent port. Used for things only the shell can do, e.g. reading secrets that are encrypted with
 * the OS keychain (safeStorage). Without a shell (standalone runtime, tests) requests fail clearly.
 */
interface ParentPort {
  on: (event: 'message', listener: (message: { data: unknown }) => void) => void
  postMessage: (message: unknown) => void
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
let nextId = 1
let listening = false

function listen() {
  if (listening || !parentPort) return
  listening = true
  parentPort.on('message', (message) => {
    const data = message.data as { type?: string; id?: number; ok?: boolean; value?: unknown; error?: string }
    if (data?.type !== 'shell-response' || typeof data.id !== 'number') return
    const waiter = pending.get(data.id)
    if (!waiter) return
    pending.delete(data.id)
    clearTimeout(waiter.timer)
    if (data.ok) waiter.resolve(data.value)
    else waiter.reject(new Error(data.error ?? 'Shell request failed.'))
  })
}

export function shellAvailable() {
  return Boolean(parentPort)
}

export function shellRequest<T>(method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
  if (!parentPort) return Promise.reject(new Error('This feature needs the desktop app (no shell connection).'))
  listen()
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Shell request ${method} timed out.`))
    }, timeoutMs)
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
    parentPort.postMessage({ type: 'shell-request', id, method, params })
  })
}
