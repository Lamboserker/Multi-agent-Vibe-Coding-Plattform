import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { PluginsService } from '../plugins/plugins.service.js'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { Subscription } from 'rxjs'
import { isGitRepository, isSensitivePath, listFiles, localBin, resolveExecutable, resolveInside, runProcess, sanitizedEnv } from '@multi-ai-coder/engine'
import { PrismaService } from '../common/prisma.service.js'
import { KeyedMutex } from '../common/locks.js'
import { EventBusService } from '../runtime/event-bus.service.js'
import { SettingsService } from '../runtime/settings.service.js'
import { LocalModelsService } from '../local-models/local-models.service.js'
import { WorkspaceFsService } from '../workspace-fs/workspace-fs.service.js'
import { LocalHistoryService } from './local-history.service.js'
import { LanguageClient } from './language-client.js'
import { LspClient, bundledLanguageServer } from './lsp-client.js'
import { ProjectLanguageService, type Diagnostic, type Position, type Span } from './ts-language.js'

export interface SearchOptions {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  include?: string
  exclude?: string
  maxResults?: number
}

export interface SearchMatch {
  line: number
  column: number
  length: number
  preview: string
}

export interface Problem {
  path: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'info'
  message: string
  code?: string
  source: string
}

const SKIP_DIRS = ['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'out']
const IDLE_MS = 15 * 60_000
const MAX_SEARCH_FILE = 1024 * 1024

/** Builds the JavaScript regular expression for a search (also used to verify replacements). */
export function searchPattern(options: SearchOptions): RegExp {
  let source = options.regex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (options.wholeWord) source = `\\b${source}\\b`
  try {
    return new RegExp(source, options.caseSensitive ? 'g' : 'gi')
  } catch {
    throw new BadRequestException('Invalid regular expression.')
  }
}

/** Glob list ("src/**, *.ts") → predicate on repository-relative paths. */
export function globMatcher(globs: string | undefined): ((file: string) => boolean) | undefined {
  const patterns = (globs ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (!patterns.length) return undefined
  const regexes = patterns.map((pattern) => {
    const normalized = pattern.includes('/') ? pattern : `**/${pattern}`
    const source = normalized
      .split('**')
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
      .join('.*')
      .replace(/^\.\*\//, '(?:.*/)?')
    return new RegExp(`^${source}(?:/.*)?$`, 'i')
  })
  return (file) => regexes.some((regex) => regex.test(file))
}

/** Matches of a pattern in a text, line by line (column/length in UTF-16 units, 1-based). */
export function findMatches(text: string, pattern: RegExp, limit: number): SearchMatch[] {
  const matches: SearchMatch[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
    const line = lines[index]!
    pattern.lastIndex = 0
    for (let match = pattern.exec(line); match && matches.length < limit; match = pattern.exec(line)) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1
        continue
      }
      const start = Math.max(0, match.index - 60)
      matches.push({ line: index + 1, column: match.index + 1, length: match[0].length, preview: line.slice(start, start + 240) })
    }
  }
  return matches
}

/** IDE features of the runtime: files, search/replace, TypeScript language features, checks, formatting, history, AI edit. */
function isUnsupported(value: unknown): value is { unsupported: true } {
  return Boolean(value) && typeof value === 'object' && (value as { unsupported?: unknown }).unsupported === true
}

@Injectable()
export class IdeService implements OnModuleInit, OnModuleDestroy {
  /** Language services run in a worker thread; this tracks which project roots have one and when they were used. */
  private readonly language = new LanguageClient()
  private readonly lsp = new Map<string, { client: LspClient; lastUsed: number }>()
  private readonly languageRoots = new Map<string, { root: string; lastUsed: number }>()
  private readonly checks = new Map<string, { at: string; durationMs: number; problems: Problem[]; tools: string[]; running: boolean }>()
  private readonly locks = new KeyedMutex()
  private subscription?: Subscription
  private timer?: NodeJS.Timeout

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
    private readonly settings: SettingsService,
    private readonly files: WorkspaceFsService,
    private readonly history: LocalHistoryService,
    private readonly localModels: LocalModelsService,
    @Optional() private readonly plugins?: PluginsService,
  ) {}

  onModuleInit() {
    this.subscription = this.events.stream().subscribe((event) => {
      if (event.type !== 'files_changed' || typeof event.data.projectId !== 'string') return
      // language servers of this project learn about changes on disk (watched files)
      for (const [key, server] of this.lsp) if (key.startsWith(`${event.data.projectId}:`)) void server.client.filesChanged((event.data.files as string[] | undefined) ?? [], Boolean(event.data.truncated)).catch(() => undefined)
      const entry = this.languageRoots.get(event.data.projectId)
      if (!entry) return
      const changed = (event.data.files as string[] | undefined) ?? []
      // configuration changed (or too many files to tell): start over on the next request
      if (event.data.truncated || changed.some((file) => /(^|\/)(tsconfig[^/]*\.json|package\.json)$/.test(file))) {
        this.languageRoots.delete(event.data.projectId)
        void this.language.call(entry.root, 'dispose').catch(() => undefined)
      } else void this.language.call(entry.root, 'invalidate', [changed]).catch(() => undefined)
    })
    this.timer = setInterval(() => {
      for (const [key, entry] of this.lsp) if (Date.now() - entry.lastUsed > IDLE_MS) { this.lsp.delete(key); void entry.client.close() }
      for (const [id, entry] of this.languageRoots) {
        if (Date.now() - entry.lastUsed < IDLE_MS) continue
        this.languageRoots.delete(id)
        void this.language.call(entry.root, 'dispose').catch(() => undefined)
      }
    }, 60_000)
    this.timer.unref()
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe()
    if (this.timer) clearInterval(this.timer)
    void this.language.dispose()
    for (const entry of this.lsp.values()) void entry.client.close()
  }

  private root(projectId: string) {
    return this.files.root(projectId)
  }

  // ---------------------------------------------------------------------------
  // Files and search
  // ---------------------------------------------------------------------------

  /** All files of the project (git: tracked + untracked, ignored excluded) for quick open. */
  async fileList(projectId: string) {
    const root = await this.root(projectId)
    let files: string[]
    if (await isGitRepository(root)) files = await listFiles(root)
    else {
      files = []
      const walk = async (relative: string, depth: number) => {
        if (depth > 12 || files.length > 50_000) return
        for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch(() => [])) {
          const child = relative ? `${relative}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.includes(entry.name)) await walk(child, depth + 1)
          } else if (entry.isFile()) files.push(child)
        }
      }
      await walk('', 0)
    }
    return files.filter((file) => existsSync(path.join(root, file))).slice(0, 50_000)
  }

  async search(projectId: string, options: SearchOptions) {
    if (!options.query) return { files: [], total: 0, truncated: false }
    const root = await this.root(projectId)
    const pattern = searchPattern(options)
    const limit = Math.min(options.maxResults ?? 2000, 10_000)
    const include = globMatcher(options.include)
    const exclude = globMatcher(options.exclude)
    const results: Array<{ path: string; matches: SearchMatch[] }> = []
    let total = 0
    let candidates: string[] | undefined
    // ripgrep narrows the candidate files quickly when it is installed; matches are computed below
    const rg = resolveExecutable('rg')
    if (rg) {
      const args = ['--files-with-matches', '--max-filesize', '1M', options.caseSensitive ? '-s' : '-i']
      if (!options.regex) args.push('-F')
      if (options.wholeWord) args.push('-w')
      for (const dir of SKIP_DIRS) args.push('-g', `!${dir}`)
      args.push('--', options.query, '.')
      const result = await runProcess(rg, args, { cwd: root, timeoutMs: 30_000, maxOutputBytes: 8 * 1024 * 1024 })
      if (result.exitCode === 0 || result.exitCode === 1) candidates = result.stdout.split(/\r?\n/).filter(Boolean).map((file) => file.replace(/^\.[\\/]/, '').replaceAll('\\', '/')).sort()
    }
    candidates ??= (await this.fileList(projectId)).sort()
    for (const file of candidates) {
      if (total >= limit) break
      if (isSensitivePath(file) || (include && !include(file)) || exclude?.(file)) continue
      const absolute = path.join(root, file)
      const stat = await fs.stat(absolute).catch(() => undefined)
      if (!stat?.isFile() || stat.size > MAX_SEARCH_FILE) continue
      const buffer = await fs.readFile(absolute)
      if (buffer.subarray(0, 8000).includes(0)) continue
      const matches = findMatches(buffer.toString('utf8'), pattern, limit - total)
      if (!matches.length) continue
      results.push({ path: file, matches })
      total += matches.length
    }
    return { files: results, total, truncated: total >= limit }
  }

  /**
   * Replaces all matches in the given files (files open in the editor are replaced in the editor
   * instead, so unsaved changes and undo history stay intact). Every file keeps its previous version in
   * the local history.
   */
  async replace(projectId: string, options: SearchOptions & { replacement: string; files: string[] }) {
    const pattern = searchPattern(options)
    const changed: Array<{ path: string; replacements: number }> = []
    for (const file of options.files.slice(0, 5000)) {
      const current = await this.files.readFile(projectId, file)
      if (current.binary || current.tooLarge) continue
      let count = 0
      const next = current.content.replace(pattern, (...args: unknown[]) => {
        count += 1
        // $1, $& … only for regular-expression searches
        return options.regex ? expandReplacement(options.replacement, args) : options.replacement
      })
      if (!count) continue
      await this.files.writeFile(projectId, file, next, current.mtimeMs, 'replace')
      changed.push({ path: file, replacements: count })
    }
    this.events.publish('project', 'files_changed', { projectId, files: changed.map((entry) => entry.path), truncated: false }, projectId)
    return { changed, total: changed.reduce((sum, entry) => sum + entry.replacements, 0) }
  }

  // ---------------------------------------------------------------------------
  // TypeScript language features
  // ---------------------------------------------------------------------------

  async folderContext(projectId: string, relative: string) {
    const root = await this.root(projectId)
    if (relative) resolveInside(root, relative)
    const files = (await listFiles(root)).filter((file) => (!relative || file.startsWith(`${relative.replace(/\\/g, '/')}/`)) && !isSensitivePath(file))
    let text = ''
    let included = 0
    for (const file of files) {
      if (included >= 20 || text.length >= 30_000) break
      const absolute = resolveInside(root, file).absolute
      const stat = await fs.stat(absolute)
      if (stat.size > 64_000) continue
      const content = await fs.readFile(absolute, 'utf8')
      if (content.includes('\0')) continue
      text += `\n### ${file}\n${content.slice(0, Math.max(0, 30_000 - text.length))}\n`
      included++
    }
    return { text, included, total: files.length, truncated: included < files.length }
  }

  private async languageCall<T>(projectId: string, file: string, method: string, args: unknown[]): Promise<T> {
    const selected = await this.plugins?.selectedExtension('languageIntegrations')
    if (selected) {
      const root = await this.root(projectId)
      resolveInside(root, file)
      const result = await this.plugins!.invokeExtension<T | { unsupported: true }>(selected.plugin, 'languageIntegrations', selected.id, 'request', { project: { id: projectId, name: path.basename(root), repoPath: root }, method, params: { file, args } })
      // the integration declines this file/method: continue with the configured/bundled server
      if (!isUnsupported(result)) return result as T
    }
    const settings = await this.settings.get()
    const extension = path.extname(file).slice(1).toLowerCase()
    const config = settings.languageServers?.find((server) => server.extensions.includes(extension)) ?? (ProjectLanguageService.supports(file) ? bundledLanguageServer() : undefined)
    if (config) {
      const root = await this.root(projectId)
      const key = `${projectId}:${JSON.stringify(config)}`
      let entry = this.lsp.get(key)
      if (!entry) { entry = { client: new LspClient(root, config), lastUsed: Date.now() }; this.lsp.set(key, entry) }
      entry.lastUsed = Date.now()
      return await entry.client.call(file, method, args) as T
    }
    if (!ProjectLanguageService.supports(file)) throw new BadRequestException('No Language Server configured for this file extension.')
    const root = await this.root(projectId)
    resolveInside(root, file)
    this.languageRoots.set(projectId, { root, lastUsed: Date.now() })
    try {
      return await this.language.call<T>(root, method, args)
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error))
    }
  }

  async definition(projectId: string, file: string, position: Position, content?: string) {
    return this.languageCall<Span[]>(projectId, file, 'definition', [file, position, content])
  }

  async references(projectId: string, file: string, position: Position, content?: string) {
    return this.languageCall<Array<Span & { preview: string; isDefinition: boolean }>>(projectId, file, 'references', [file, position, content])
  }

  async rename(projectId: string, file: string, position: Position, newName: string, content?: string) {
    if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(newName)) throw new BadRequestException('Invalid identifier.')
    return this.languageCall<{ canRename: false; reason?: string } | { canRename: true; displayName: string; files: Array<{ path: string; edits: Array<Span & { text: string }> }> }>(projectId, file, 'rename', [file, position, newName, content])
  }

  async hover(projectId: string, file: string, position: Position, content?: string) {
    return this.languageCall<(Span & { signature: string; documentation: string }) | null>(projectId, file, 'hover', [file, position, content])
  }

  async fileDiagnostics(projectId: string, file: string, content?: string) {
    const diagnostics = await this.languageCall<Diagnostic[]>(projectId, file, 'diagnostics', [file, content])
    const info = await this.languageCall<{ semantic: boolean; typescript: 'project' | 'bundled' }>(projectId, file, 'info', [])
    return { ...info, diagnostics }
  }

  /** How the language services run (worker thread in the app, in-process in unit tests). */
  get languageMode() {
    return this.language.mode
  }

  // ---------------------------------------------------------------------------
  // Project check (problems), formatting
  // ---------------------------------------------------------------------------

  lastCheck(projectId: string) {
    return this.checks.get(projectId) ?? null
  }

  /** Runs the project's own TypeScript compiler and ESLint (when installed) and collects problems. */
  async check(projectId: string) {
    return this.locks.run(`check:${projectId}`, async () => {
      const root = await this.root(projectId)
      const started = Date.now()
      const previous = this.checks.get(projectId)
      this.checks.set(projectId, { at: previous?.at ?? new Date().toISOString(), durationMs: previous?.durationMs ?? 0, problems: previous?.problems ?? [], tools: previous?.tools ?? [], running: true })
      this.events.publish('project', 'problems_updated', { projectId, running: true }, projectId)
      const problems: Problem[] = []
      const tools: string[] = []
      const tsc = localBin(root, 'tsc')
      if (tsc && existsSync(path.join(root, 'tsconfig.json'))) {
        tools.push('tsc')
        const result = await runProcess(tsc, ['--noEmit', '--pretty', 'false', '-p', '.'], { cwd: root, env: sanitizedEnv(), timeoutMs: 180_000, maxOutputBytes: 8 * 1024 * 1024 })
        for (const line of result.stdout.split(/\r?\n/)) {
          const match = /^(.+?)\((\d+),(\d+)\): (error|warning) TS(\d+): (.*)$/.exec(line.trim())
          if (match) problems.push({ path: match[1]!.replaceAll('\\', '/'), line: Number(match[2]), column: Number(match[3]), severity: match[4] === 'error' ? 'error' : 'warning', code: `TS${match[5]}`, message: match[6]!, source: 'tsc' })
        }
        if (result.spawnError) problems.push({ path: '', line: 1, column: 1, severity: 'warning', message: `tsc konnte nicht gestartet werden: ${result.spawnError}`, source: 'tsc' })
      }
      const eslint = localBin(root, 'eslint')
      if (eslint) {
        tools.push('eslint')
        const result = await runProcess(eslint, ['.', '-f', 'json', '--no-error-on-unmatched-pattern'], { cwd: root, env: sanitizedEnv(), timeoutMs: 180_000, maxOutputBytes: 32 * 1024 * 1024 })
        try {
          const reports = JSON.parse(result.stdout) as Array<{ filePath: string; messages: Array<{ line?: number; column?: number; severity: number; message: string; ruleId?: string | null }> }>
          for (const report of reports) {
            for (const message of report.messages) problems.push({ path: path.relative(root, report.filePath).replaceAll('\\', '/'), line: message.line ?? 1, column: message.column ?? 1, severity: message.severity === 2 ? 'error' : 'warning', code: message.ruleId ?? undefined, message: message.message, source: 'eslint' })
          }
        } catch {
          const text = (result.stderr || result.stdout).trim()
          if (text) problems.push({ path: '', line: 1, column: 1, severity: 'warning', message: `ESLint: ${text.split(/\r?\n/)[0]!.slice(0, 300)}`, source: 'eslint' })
        }
      }
      const entry = { at: new Date().toISOString(), durationMs: Date.now() - started, problems: problems.slice(0, 5000), tools, running: false }
      this.checks.set(projectId, entry)
      this.events.publish('project', 'problems_updated', { projectId, running: false, count: problems.length }, projectId)
      return entry
    })
  }

  /** Formats a file's content with the project's Prettier (nothing is written). */
  async format(projectId: string, file: string, content: string) {
    const root = await this.root(projectId)
    const { relative } = resolveInside(root, file)
    const prettier = localBin(root, 'prettier')
    if (!prettier) return { available: false as const, message: 'Prettier ist im Projekt nicht installiert (node_modules/.bin/prettier).' }
    const result = await runProcess(prettier, ['--stdin-filepath', relative], { cwd: root, env: sanitizedEnv(), input: content, timeoutMs: 30_000, maxOutputBytes: 8 * 1024 * 1024 })
    if (result.exitCode !== 0) return { available: true as const, ok: false as const, message: (result.stderr || result.stdout).trim().split(/\r?\n/).slice(0, 5).join('\n') }
    return { available: true as const, ok: true as const, content: result.stdout, changed: result.stdout !== content }
  }

  // ---------------------------------------------------------------------------
  // Local history
  // ---------------------------------------------------------------------------

  async historyList(projectId: string, file: string) {
    const root = await this.root(projectId)
    return this.history.list(projectId, resolveInside(root, file).relative)
  }

  async historyEntry(projectId: string, file: string, id: string) {
    const root = await this.root(projectId)
    return this.history.read(projectId, resolveInside(root, file).relative, id)
  }

  // ---------------------------------------------------------------------------
  // AI edit (local model, no premium call)
  // ---------------------------------------------------------------------------

  /**
   * Rewrites a selection according to an instruction with the local model of the "balanced" role
   * (fallback: any assigned role). The result is returned for review; nothing is written.
   */
  async aiEdit(projectId: string, input: { path: string; language?: string; before: string; selection: string; after: string; instruction: string }, signal?: AbortSignal) {
    await this.root(projectId)
    const settings = await this.settings.get()
    const model = settings.modelRoles.balanced ?? settings.modelRoles.advanced ?? settings.modelRoles.fast
    if (!model) throw new BadRequestException('Kein lokales Modell zugewiesen (Modelle → Rollen).')
    const client = await this.localModels.client()
    const started = Date.now()
    const context = `${input.before.slice(-4000)}<<<SELECTION>>>${input.selection}<<<END>>>${input.after.slice(0, 2000)}`
    const response = await client.chat(
      {
        model,
        messages: [
          {
            role: 'system',
            content:
              'You edit code. You receive a file excerpt where the part to change is marked with <<<SELECTION>>> … <<<END>>>, and an instruction. ' +
              'Return ONLY JSON {"replacement": string} – the new text for the marked part (not the whole file), keeping indentation and style. ' +
              'If the instruction does not apply, return the selection unchanged.',
          },
          { role: 'user', content: `File: ${input.path}${input.language ? ` (${input.language})` : ''}\nInstruction: ${input.instruction}\n\n${context}` },
        ],
        format: { type: 'object', properties: { replacement: { type: 'string' } }, required: ['replacement'] },
        options: { num_ctx: Math.min(settings.numCtx, 16_384), temperature: 0.1 },
        keep_alive: `${settings.keepAliveMinutes}m`,
      },
      { signal, timeoutMs: 5 * 60_000, idleTimeoutMs: 120_000 },
    )
    let replacement: string
    try {
      replacement = String((JSON.parse(response.message.content) as { replacement?: unknown }).replacement ?? '')
    } catch {
      throw new BadRequestException('Das Modell hat keine gültige Antwort geliefert. Bitte erneut versuchen.')
    }
    await this.prisma.modelCall.create({
      data: { kind: 'local', provider: 'ollama', model, purpose: 'edit', status: 'ok', durationMs: Date.now() - started, inputTokens: response.promptTokens, outputTokens: response.completionTokens, tokensMeasured: true, billing: 'local' },
    }).catch(() => undefined)
    return { model, replacement, durationMs: Date.now() - started }
  }

  async projectExists(projectId: string) {
    if (!(await this.prisma.project.findUnique({ where: { id: projectId } }))) throw new NotFoundException('Project not found.')
  }
}

/** Applies $1…$9, $& and $$ of a replacement string to one regex match (String.replace callback args). */
function expandReplacement(replacement: string, args: unknown[]) {
  const match = String(args[0])
  const groups = args.slice(1, -2).map((value) => (value === undefined ? '' : String(value)))
  return replacement.replace(/\$(\$|&|\d)/g, (_token, key: string) => (key === '$' ? '$' : key === '&' ? match : (groups[Number(key) - 1] ?? '')))
}
