import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { PluginsService } from '../plugins/plugins.service.js'
import path from 'node:path'
import type { Subscription } from 'rxjs'
import {
  buildContextDigest,
  buildRepoIndex,
  detectValidationChecks,
  headCommit,
  loadIndexCache,
  refreshRepoIndex,
  saveIndexCache,
  type RepoIndex,
  type ValidationCheck,
} from '@multi-ai-coder/engine'
import { EventBusService } from '../runtime/event-bus.service.js'
import { runtimeConfig } from '../runtime/runtime-config.js'
import { WorkspaceFsService } from '../workspace-fs/workspace-fs.service.js'

interface IndexState {
  head?: string
  /** Paths reported by the file watcher since the last index update. */
  dirty: Set<string>
  /** The watcher dropped paths (large batch): the next update scans everything. */
  fullScan: boolean
}

export interface IndexCounters {
  hits: number
  incremental: number
  full: number
  lastMs: number
  lastMode?: 'hit' | 'incremental' | 'full'
}

/**
 * Deterministic repository analysis with a per-project index. The index is kept current from the
 * project's file watcher and the git HEAD: without changes nothing is read from disk, reported paths
 * are re-indexed individually, and only a branch switch, an incomplete change list or a missing
 * watcher triggers the (incremental, hash-based) full scan.
 */
@Injectable()
export class RepoContextService implements OnModuleInit, OnModuleDestroy {
  private readonly memory = new Map<string, RepoIndex>()
  private readonly state = new Map<string, IndexState>()
  private readonly inFlight = new Map<string, Promise<RepoIndex>>()
  private subscription?: Subscription
  readonly counters: IndexCounters = { hits: 0, incremental: 0, full: 0, lastMs: 0 }

  constructor(
    private readonly events: EventBusService,
    private readonly files: WorkspaceFsService,
    @Optional() private readonly plugins?: PluginsService,
  ) {}

  onModuleInit() {
    this.subscription = this.events.stream().subscribe((event) => {
      if (event.channel === 'project' && event.type === 'watch_started' && typeof event.data.repoPath === 'string') {
        const { projectId, repoPath } = event.data as { projectId: string; repoPath: string }
        // background warm-up; a plan started meanwhile joins the same in-flight update
        if (!this.memory.has(projectId)) setTimeout(() => void this.index(projectId, repoPath).catch(() => undefined), 1000).unref?.()
        return
      }
      if (event.channel !== 'project' || event.type !== 'files_changed') return
      const projectId = String(event.data.projectId)
      const state = this.stateFor(projectId)
      if (event.data.truncated) state.fullScan = true
      for (const file of (event.data.files as string[]) ?? []) state.dirty.add(file)
    })
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe()
  }

  private stateFor(projectId: string): IndexState {
    let state = this.state.get(projectId)
    if (!state) {
      state = { dirty: new Set(), fullScan: true }
      this.state.set(projectId, state)
    }
    return state
  }

  async index(projectId: string, repoPath: string): Promise<RepoIndex> {
    // concurrent callers (planning + run) share one update
    const running = this.inFlight.get(projectId)
    if (running) return running
    const promise = this.update(projectId, repoPath).finally(() => this.inFlight.delete(projectId))
    this.inFlight.set(projectId, promise)
    return promise
  }

  private async update(projectId: string, repoPath: string): Promise<RepoIndex> {
    const started = Date.now()
    const state = this.stateFor(projectId)
    const cacheFile = path.join(runtimeConfig().cacheDir, `index-${projectId}.json`)
    const previous = this.memory.get(projectId) ?? (await loadIndexCache(cacheFile))
    const head = await headCommit(repoPath).catch(() => undefined)
    const watching = this.files.isWatching(projectId)
    const pending = [...state.dirty]
    state.dirty.clear()

    let index: RepoIndex
    let mode: IndexCounters['lastMode']
    if (previous && this.memory.has(projectId) && watching && !state.fullScan && state.head === head) {
      index = pending.length ? await refreshRepoIndex(repoPath, previous, pending) : previous
      mode = pending.length ? 'incremental' : 'hit'
    } else {
      // Changes reported meanwhile are covered by the scan (it stats every file).
      state.fullScan = false
      index = await buildRepoIndex(repoPath, previous)
      mode = 'full'
    }
    state.head = head
    this.memory.set(projectId, index)
    this.counters[mode === 'hit' ? 'hits' : mode] += 1
    this.counters.lastMs = Date.now() - started
    this.counters.lastMode = mode
    if (index !== previous) void saveIndexCache(cacheFile, index).catch(() => undefined)
    return index
  }

  checks(repoPath: string): ValidationCheck[] {
    return detectValidationChecks(repoPath)
  }

  async digest(projectId: string, repoPath: string, goal: string, budgetTokens = 6000, excerpts: { excerptFiles?: number; excerptChars?: number; excerptMaxLines?: number; fillUnranked?: boolean } = {}) {
    const [index, checks] = await Promise.all([this.index(projectId, repoPath), this.runChecks(projectId, repoPath, goal)])
    const digest = await buildContextDigest(index, goal, { budgetTokens, validationCommands: checks.map((check) => check.command), ...excerpts })
    const project = { id: projectId, name: path.basename(repoPath), repoPath }
    // a plugin analyzer may enrich the digest, but it must not stall planning
    const analysis = await withTimeout(this.plugins?.invokeSelected<{ summary: string; relevantFiles?: string[] }>('repositoryAnalyzers', 'analyze', { project, goal }), ANALYZER_TIMEOUT_MS).catch(() => undefined)
    if (analysis && typeof analysis.summary === 'string') digest.summary += `\n\nPlugin repository analysis:\n${analysis.summary.slice(0, 8000)}`
    return { index, checks, digest }
  }

  /** What a run needs: the index and the validation checks (no digest, no analyzer call). */
  async runContext(projectId: string, repoPath: string, goal: string) {
    const [index, checks] = await Promise.all([this.index(projectId, repoPath), this.runChecks(projectId, repoPath, goal)])
    return { index, checks }
  }

  /** Detected project checks plus the selected plugin test runner. */
  private async runChecks(projectId: string, repoPath: string, goal: string): Promise<ValidationCheck[]> {
    const checks = this.checks(repoPath)
    const project = { id: projectId, name: path.basename(repoPath), repoPath }
    const runner = await this.plugins?.selectedExtension('testRunners')
    if (runner) checks.push({ id: `plugin:${runner.plugin}:${runner.id}`, kind: 'test', command: `Plugin ${runner.title}`, blocking: true, timeoutMs: 10 * 60_000, source: 'plugin', execute: async (cwd, signal) => {
      if (signal?.aborted) throw new Error('Test run cancelled.')
      return this.plugins!.invokeExtension(runner.plugin, 'testRunners', runner.id, 'run', { project, cwd, goal }, { signal, timeoutMs: 10 * 60_000 })
    } })
    return checks
  }
}

const ANALYZER_TIMEOUT_MS = 5000

function withTimeout<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!promise) return Promise.resolve(undefined)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
