/**
 * Worker thread for the TypeScript language services: building a program is synchronous and can take
 * seconds in large projects, so it must not run on the runtime's main thread (it would delay every
 * other request). One service per project root; the main thread disposes idle ones.
 */
import * as nodeModule from 'node:module'
import { parentPort } from 'node:worker_threads'
import { ProjectLanguageService } from './ts-language.js'

type Request = { id: number; root: string; method: string; args: unknown[] }

const services = new Map<string, ProjectLanguageService>()
let flushed = false

function service(root: string) {
  let entry = services.get(root)
  if (!entry) {
    entry = new ProjectLanguageService(root)
    services.set(root, entry)
  }
  return entry
}

parentPort?.on('message', (request: Request) => {
  try {
    let value: unknown
    if (request.method === 'dispose') {
      services.get(request.root)?.dispose()
      services.delete(request.root)
    } else if (request.method === 'invalidate') {
      services.get(request.root)?.invalidate(request.args[0] as string[])
    } else {
      const target = service(request.root)
      if (request.method === 'info') value = { semantic: target.semantic, typescript: target.tsSource }
      else value = (target[request.method as 'definition'] as (...args: unknown[]) => unknown).apply(target, request.args)
    }
    parentPort!.postMessage({ id: request.id, ok: true, value })
    if (!flushed) {
      // persist the compile cache of this large bundle (the worker is terminated, not exited)
      flushed = true
      ;(nodeModule as { flushCompileCache?: () => void }).flushCompileCache?.()
    }
  } catch (error) {
    parentPort!.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
