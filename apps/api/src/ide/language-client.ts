import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { ProjectLanguageService } from './ts-language.js'

const CALL_TIMEOUT_MS = 120_000

/** Worker script: bundled next to the runtime (desktop) or compiled by tsc (dist/ide). */
function workerScript(): string | undefined {
  if (process.env.MAC_TS_IN_PROCESS === '1') return undefined
  const here = path.dirname(fileURLToPath(import.meta.url))
  return [path.join(here, 'ts-worker-boot.cjs'), path.join(here, 'ts-worker.cjs'), path.join(here, 'ts-worker.js')].find((candidate) => existsSync(candidate))
}

/**
 * Calls the TypeScript language services in a worker thread (so a slow program build never blocks
 * the runtime). Without a compiled worker script (tests run from src) the services run in-process.
 */
export class LanguageClient {
  private worker?: Worker
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private readonly inProcess = new Map<string, ProjectLanguageService>()
  private readonly script: string | undefined
  private nextId = 1

  constructor(script: string | undefined | null = workerScript()) {
    this.script = script ?? undefined
  }

  get mode() {
    return this.script ? 'worker' : 'in-process'
  }

  private ensureWorker() {
    if (this.worker) return this.worker
    const worker = new Worker(this.script!)
    worker.on('message', (message: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.ok) waiter.resolve(message.value)
      else waiter.reject(new Error(message.error))
    })
    const fail = (error: Error) => {
      if (this.worker === worker) this.worker = undefined
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
      this.pending.clear()
    }
    worker.on('error', fail)
    worker.on('exit', (code) => fail(new Error(`TypeScript worker exited (${code}).`)))
    worker.unref()
    this.worker = worker
    return worker
  }

  call<T>(root: string, method: string, args: unknown[] = []): Promise<T> {
    if (!this.script) return Promise.resolve().then(() => this.callInProcess<T>(root, method, args))
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`TypeScript service did not answer within ${CALL_TIMEOUT_MS / 1000} s.`))
        // a stuck program build: start over with a fresh worker
        void worker.terminate()
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      worker.postMessage({ id, root, method, args })
    })
  }

  private callInProcess<T>(root: string, method: string, args: unknown[]): T {
    if (method === 'dispose') {
      this.inProcess.get(root)?.dispose()
      this.inProcess.delete(root)
      return undefined as T
    }
    if (method === 'invalidate') {
      this.inProcess.get(root)?.invalidate(args[0] as string[])
      return undefined as T
    }
    let service = this.inProcess.get(root)
    if (!service) {
      service = new ProjectLanguageService(root)
      this.inProcess.set(root, service)
    }
    if (method === 'info') return { semantic: service.semantic, typescript: service.tsSource } as T
    return (service[method as 'definition'] as (...values: unknown[]) => unknown).apply(service, args) as T
  }

  async dispose() {
    for (const service of this.inProcess.values()) service.dispose()
    this.inProcess.clear()
    await this.worker?.terminate()
    this.worker = undefined
  }
}
