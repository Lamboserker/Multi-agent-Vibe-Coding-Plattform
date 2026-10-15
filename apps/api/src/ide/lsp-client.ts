import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { killProcessTree, resolveInside, sanitizedEnv, spawnOwnedProcess } from '@multi-ai-coder/engine'

export interface LanguageServerConfig { command: string; args: string[]; extensions: string[]; languageId: string }
type Range = { start: { line: number; character: number }; end: { line: number; character: number } }
type Location = { uri?: string; range?: Range; targetUri?: string; targetSelectionRange?: Range }
type LspDiagnostic = { range: Range; severity?: number; code?: unknown; message: string; source?: string }

/** Quiet period after a publication: servers publish syntax and semantic results separately. */
const DIAGNOSTICS_SETTLE_MS = 300

/** Servers may spell the same file differently (file:///c%3A/… vs file:///C:/…). */
function uriKey(uri: string) {
  try {
    const file = path.resolve(fileURLToPath(uri))
    return process.platform === 'win32' ? file.toLowerCase() : file
  } catch {
    return uri
  }
}

/** LSP language id of a file: the TypeScript server parses JSX only for the *react ids. */
export function languageIdFor(configured: string, file: string) {
  if (configured !== 'typescript') return configured
  if (/\.tsx$/i.test(file)) return 'typescriptreact'
  if (/\.jsx$/i.test(file)) return 'javascriptreact'
  if (/\.[cm]?js$/i.test(file)) return 'javascript'
  return 'typescript'
}

/** Standard Content-Length JSON-RPC LSP client, one process per project/server. */
export class LspClient {
  private child?: ChildProcessWithoutNullStreams
  private nextId = 1
  private buffer = Buffer.alloc(0)
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  private documents = new Map<string, { text: string; version: number; changedAt: number }>()
  private diagnostics = new Map<string, { version?: number; at: number; items: LspDiagnostic[] }>()
  private diagnosticWaiters = new Set<() => void>()
  /** Set once the server published diagnostics: its semantic project is loaded. */
  private semanticReady = false
  /** Diagnostics published before this moment may be stale (another file changed on disk). */
  private invalidatedAt = 0
  private ready?: Promise<void>
  constructor(readonly root: string, readonly config: LanguageServerConfig) {}
  private send(message: unknown) {
    const body = Buffer.from(JSON.stringify(message))
    if (!this.child?.stdin.writable) throw new Error('Language server is not running.')
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.child.stdin.write(body)
  }
  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > 16 * 1024 * 1024) { this.fail(new Error('LSP message exceeds 16 MB.')); return }
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const size = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString())?.[1]
      if (!size) { this.fail(new Error('Invalid LSP frame.')); return }
      const end = headerEnd + 4 + Number(size)
      if (this.buffer.length < end) return
      const message = JSON.parse(this.buffer.subarray(headerEnd + 4, end).toString()) as { id?: number; method?: string; result?: unknown; error?: { message: string }; params?: Record<string, unknown> }
      this.buffer = this.buffer.subarray(end)
      if (message.method && message.id !== undefined) {
        const result = message.method === 'workspace/configuration' ? ((message.params?.items as unknown[] | undefined) ?? []).map(() => ({})) : null
        this.send({ jsonrpc: '2.0', id: message.id, result })
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result) }
      } else if (message.method === 'textDocument/publishDiagnostics') {
        const version = typeof message.params?.version === 'number' ? message.params.version : undefined
        this.diagnostics.set(uriKey(String(message.params?.uri)), { version, at: Date.now(), items: (message.params?.diagnostics ?? []) as LspDiagnostic[] })
        this.semanticReady = true
        this.wakeDiagnosticWaiters()
      }
    }
  }
  private wakeDiagnosticWaiters() {
    for (const wake of [...this.diagnosticWaiters]) wake()
  }
  private fail(error: Error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error) }
    this.pending.clear()
    this.ready = undefined
    this.documents.clear()
    this.diagnostics.clear()
    this.semanticReady = false
    this.buffer = Buffer.alloc(0)
    if (this.child) killProcessTree(this.child)
    this.child = undefined
    this.wakeDiagnosticWaiters()
  }
  request<T>(method: string, params?: unknown, timeoutMs = 20_000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.notify('$/cancelRequest', { id }); reject(new Error(`Language server ${method} timed out.`)) }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      try { this.send({ jsonrpc: '2.0', id, method, params }) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  notify(method: string, params?: unknown) { this.send({ jsonrpc: '2.0', method, params }) }
  async start() {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const child = spawnOwnedProcess(this.config.command, this.config.args, { cwd: this.root, env: { ...sanitizedEnv(), ELECTRON_RUN_AS_NODE: '1' } })
      this.child = child
      child.stdout.on('data', (chunk: Buffer) => { try { this.consume(chunk) } catch { this.fail(new Error('Invalid JSON from language server.')) } })
      child.stderr.resume()
      child.on('error', (error) => this.fail(new Error(`Language server could not start: ${error.message}`)))
      child.on('exit', () => { if (this.child === child) this.fail(new Error('Language server exited. The next request restarts it.')) })
      const require = createRequire(import.meta.url)
      const nearby = path.join(path.dirname(fileURLToPath(import.meta.url)), 'typescript/lib/tsserver.js')
      const tsserver = process.env.MAC_LSP_TSSERVER ?? (existsSync(nearby) ? nearby : require.resolve('typescript/lib/tsserver.js'))
      // publishDiagnostics must be announced: servers such as typescript-language-server only push
      // diagnostics to clients that declare support for them
      const capabilities = { workspace: { configuration: true, didChangeWatchedFiles: { dynamicRegistration: false } }, textDocument: { synchronization: { didSave: true }, hover: { contentFormat: ['markdown', 'plaintext'] }, publishDiagnostics: { versionSupport: true, relatedInformation: false } } }
      await this.request('initialize', { processId: process.pid, rootUri: pathToFileURL(this.root).href, capabilities, initializationOptions: { tsserver: { path: tsserver } }, workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }] })
      this.notify('initialized', {})
    })()
    return this.ready
  }
  async sync(file: string, content?: string) {
    await this.start()
    const absolute = resolveInside(this.root, file).absolute
    const uri = pathToFileURL(absolute).href
    const text = content ?? await fs.readFile(absolute, 'utf8')
    const previous = this.documents.get(uri)
    if (previous && previous.text === text) return { uri, version: previous.version, changedAt: previous.changedAt }
    const version = (previous?.version ?? 0) + 1
    if (!previous) this.notify('textDocument/didOpen', { textDocument: { uri, languageId: languageIdFor(this.config.languageId, file), version, text } })
    else this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] })
    const changedAt = Date.now()
    this.documents.set(uri, { text, version, changedAt })
    return { uri, version, changedAt }
  }
  /**
   * Diagnostics of exactly this document version: waits for a publication for that version (servers
   * without version support: one received after the change), then for a short quiet period.
   */
  private async currentDiagnostics(uri: string, version: number, changedAt: number, timeoutMs = 20_000): Promise<LspDiagnostic[]> {
    const fresh = () => {
      const entry = this.diagnostics.get(uriKey(uri))
      return entry && entry.at >= this.invalidatedAt && (entry.version !== undefined ? entry.version === version : entry.at >= changedAt) ? entry : undefined
    }
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (!this.child) throw new Error('Language server stopped.')
      const entry = fresh()
      if (entry && Date.now() - entry.at >= DIAGNOSTICS_SETTLE_MS) return entry.items
      if (Date.now() >= deadline) {
        if (entry) return entry.items
        throw new Error('Language server did not report diagnostics in time.')
      }
      const waitMs = entry ? DIAGNOSTICS_SETTLE_MS - (Date.now() - entry.at) : deadline - Date.now()
      await new Promise<void>((resolve) => {
        const wake = () => { clearTimeout(timer); this.diagnosticWaiters.delete(wake); resolve() }
        const timer = setTimeout(wake, Math.max(0, waitMs))
        this.diagnosticWaiters.add(wake)
      })
    }
  }
  /**
   * Files changed on disk (project watcher): open documents are re-synced from disk, the server is
   * told about the rest, and cached diagnostics become stale until the server republishes.
   */
  async filesChanged(relativePaths: string[], everything = false) {
    if (!this.child) return
    this.invalidatedAt = Date.now()
    const changes: Array<{ uri: string; type: number }> = []
    for (const file of relativePaths) {
      let absolute: string
      try { absolute = resolveInside(this.root, file).absolute } catch { continue }
      const uri = pathToFileURL(absolute).href
      const open = this.documents.get(uri)
      if (open && existsSync(absolute)) {
        const text = await fs.readFile(absolute, 'utf8')
        // unsaved editor content is synced with every request; only a disk change of an open file is new here
        if (text !== open.text) await this.sync(file, text)
      }
      changes.push({ uri, type: existsSync(absolute) ? 2 : 3 })
    }
    if (everything && !changes.length) changes.push({ uri: pathToFileURL(path.join(this.root, 'tsconfig.json')).href, type: 2 })
    if (changes.length) this.notify('workspace/didChangeWatchedFiles', { changes })
  }
  span(location: Location) {
    const uri = location.uri ?? location.targetUri!
    const range = location.range ?? location.targetSelectionRange!
    if (!uri.startsWith('file:') || !range) throw new Error('Unsupported LSP location.')
    const relative = path.relative(this.root, fileURLToPath(uri)).replaceAll('\\', '/')
    resolveInside(this.root, relative)
    return { path: relative, line: range.start.line + 1, column: range.start.character + 1, endLine: range.end.line + 1, endColumn: range.end.character + 1 }
  }
  async call(file: string, method: string, args: unknown[]) {
    const position = args[1] as { line: number; column: number } | undefined
    const content = method === 'diagnostics' ? args[1] : method === 'rename' ? args[3] : args[2]
    const { uri, version, changedAt } = await this.sync(file, typeof content === 'string' ? content : undefined)
    const params = { textDocument: { uri }, ...(position && typeof position === 'object' ? { position: { line: position.line - 1, character: position.column - 1 } } : {}) }
    if (method === 'info') return { semantic: true, typescript: 'bundled', protocol: 'lsp' }
    if (method === 'diagnostics') {
      return (await this.currentDiagnostics(uri, version, changedAt)).map((diagnostic) => ({ ...this.span({ uri, range: diagnostic.range }), severity: diagnostic.severity === 1 ? 'error' : diagnostic.severity === 2 ? 'warning' : 'info', code: diagnostic.code, message: diagnostic.message, source: diagnostic.source ?? 'lsp' }))
    }
    // While the semantic project loads, servers answer from a syntax-only view (a definition then
    // resolves to the import): wait until the project published its first results.
    if (!this.semanticReady) await this.currentDiagnostics(uri, version, changedAt).catch(() => undefined)
    if (method === 'definition' || method === 'references') {
      const result = await this.request<Location | Location[] | null>(`textDocument/${method}`, { ...params, ...(method === 'references' ? { context: { includeDeclaration: true } } : {}) })
      const locations = result ? (Array.isArray(result) ? result : [result]) : []
      return locations.flatMap((location) => { try { return [{ ...this.span(location), preview: '', isDefinition: false }] } catch { return [] } })
    }
    if (method === 'hover') {
      const result = await this.request<{ contents: unknown; range?: Range } | null>('textDocument/hover', params)
      if (!result) return null
      const contents = result.contents as { value?: string }
      return { ...this.span({ uri, range: result.range ?? { start: params.position!, end: params.position! } }), signature: typeof contents === 'string' ? contents : contents.value ?? JSON.stringify(contents), documentation: '' }
    }
    if (method === 'rename') {
      const result = await this.request<{ changes?: Record<string, Array<{ range: Range; newText: string }>>; documentChanges?: Array<{ textDocument: { uri: string }; edits: Array<{ range: Range; newText: string }> }> } | null>('textDocument/rename', { ...params, newName: args[2] })
      if (!result) return { canRename: false, reason: 'Language server cannot rename this symbol.' }
      const changes = { ...result.changes }
      for (const entry of result.documentChanges ?? []) changes[entry.textDocument.uri] = entry.edits
      return { canRename: true, displayName: String(args[2]), files: Object.entries(changes).map(([uri, edits]) => ({ path: this.span({ uri, range: edits[0]!.range }).path, edits: edits.map((edit) => ({ ...this.span({ uri, range: edit.range }), text: edit.newText })) })) }
    }
    if (method === 'completion') return this.request('textDocument/completion', params)
    throw new Error(`Unsupported LSP operation ${method}.`)
  }
  async close() {
    if (!this.child) return
    try { await this.request('shutdown', undefined, 2000); this.notify('exit') } catch { /* force cleanup below */ }
    this.fail(new Error('Language server stopped.'))
  }
}

export function bundledLanguageServer(): LanguageServerConfig {
  const require = createRequire(import.meta.url)
  const nearby = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lsp-server.mjs')
  const script = process.env.MAC_LSP_SERVER ?? (existsSync(nearby) ? nearby : require.resolve('typescript-language-server/lib/cli.mjs'))
  return { command: process.execPath, args: [script, '--stdio'], extensions: ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'], languageId: 'typescript' }
}
