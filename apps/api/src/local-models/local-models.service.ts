import { BadRequestException, Injectable, Logger, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common'
import { PluginsService } from '../plugins/plugins.service.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  candidateModelNames,
  CATALOG_RESEARCHED_AT,
  contextLengthFromShow,
  detectHardware,
  detectOllama,
  diskInfo,
  lookupRegistryModel,
  OllamaClient,
  OllamaError,
  recoverTextToolCalls,
  ollamaInstallPlan,
  recommendModels,
  runOllamaInstall,
  startOllamaServer,
  stopOwnedOllamaServers,
  usableVramMb,
  estimateRuntimeMemory,
  runtimeContextTokens,
  type HardwareProfile,
  type LocalModelRuntime,
  type LocalRole,
  type RegistryModelInfo,
} from '@multi-ai-coder/engine'
import { EventBusService } from '../runtime/event-bus.service.js'
import { JobQueueService } from '../runtime/job-queue.service.js'
import { runtimeConfig } from '../runtime/runtime-config.js'
import { SettingsService, type AppSettings, type ModelSelfTest } from '../runtime/settings.service.js'

export interface InstalledModel {
  name: string
  sizeBytes: number
  family?: string
  parameterSize?: string
  quantization?: string
  capabilities: string[]
  contextLength?: number
  loaded: boolean
  vramBytes?: number
  roles: LocalRole[]
  selfTest?: ModelSelfTest
}

const MODEL_NAME = /^[a-z0-9][a-z0-9._/-]{0,80}(:[a-z0-9._-]{1,60})?$/i

@Injectable()
export class LocalModelsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('LocalModels')
  private hardwareCache?: HardwareProfile
  private registryCache?: { at: number; data: RegistryModelInfo[] }
  private showCache = new Map<string, { capabilities: string[]; contextLength?: number; digest: string }>()

  constructor(
    private readonly settings: SettingsService,
    private readonly events: EventBusService,
    private readonly jobs: JobQueueService,
    @Optional() private readonly plugins?: PluginsService,
  ) {}

  onModuleInit() {
    this.jobs.register('model.pull', (payload, ctx) => this.runPull(String(payload.model), ctx.signal, ctx.progress), { concurrency: 1, onRecover: 'requeue' })
    this.jobs.register('ollama.install', (_payload, ctx) => this.runInstall(ctx.signal), { concurrency: 1, onRecover: 'interrupt' })
  }

  async onApplicationShutdown() { await stopOwnedOllamaServers() }

  async client(): Promise<OllamaClient> {
    return new OllamaClient((await this.settings.get()).ollamaBaseUrl)
  }

  private hardwareRefresh?: Promise<HardwareProfile>

  /**
   * Hardware profile. Detection takes seconds on Windows (CIM/nvidia-smi), so the last profile is kept
   * on disk: it is returned immediately and refreshed in the background when older than an hour.
   */
  async hardware(refresh = false): Promise<HardwareProfile> {
    const settings = await this.settings.get()
    const cacheFile = path.join(runtimeConfig().cacheDir, 'hardware.json')
    const detect = () => {
      this.hardwareRefresh ??= detectHardware({ appDataDir: runtimeConfig().dataDir, ollamaModelsDir: settings.ollamaModelsDir ?? undefined })
        .then(async (profile) => {
          this.hardwareCache = profile
          await fs.writeFile(cacheFile, JSON.stringify({ modelsDir: settings.ollamaModelsDir, profile })).catch(() => undefined)
          return profile
        })
        .finally(() => {
          this.hardwareRefresh = undefined
        })
      return this.hardwareRefresh
    }
    if (refresh) return detect()
    if (!this.hardwareCache) {
      try {
        const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as { modelsDir: string | null; profile: HardwareProfile }
        // the disk part of the profile depends on the configured model folder
        if (cached.modelsDir === settings.ollamaModelsDir) this.hardwareCache = cached.profile
      } catch {
        // no cached profile yet
      }
    }
    if (!this.hardwareCache) return detect()
    if (Date.now() - new Date(this.hardwareCache.detectedAt).getTime() > 3600_000) void detect().catch(() => undefined)
    return this.hardwareCache
  }

  async ollamaStatus() {
    const settings = await this.settings.get()
    const installation = await detectOllama(settings.ollamaBaseUrl)
    return { ...installation, installPlan: installation.installed ? undefined : await ollamaInstallPlan() }
  }

  /** Starts Ollama when it is installed but not reachable (local models are needed right now). */
  async ensureOllama() {
    const client = await this.client()
    if (await client.isReachable()) return true
    // a failed start (not installed, port taken) is not retried on every plan/run
    if (Date.now() - this.ollamaStartFailedAt < 60_000) return false
    const started = await this.startOllama()
    if (started.started || (await client.isReachable())) {
      this.invalidateInstalled()
      return true
    }
    this.ollamaStartFailedAt = Date.now()
    this.logger.warn(`Ollama could not be started: ${started.message}`)
    return false
  }

  private ollamaStartFailedAt = 0

  async startOllama() {
    const settings = await this.settings.get()
    const result = await startOllamaServer({ baseUrl: settings.ollamaBaseUrl, modelsDir: settings.ollamaModelsDir ?? undefined })
    this.events.publish('models', 'ollama_started', { ...result })
    return result
  }

  async requestInstall(consent: boolean) {
    if (!consent) throw new BadRequestException('Installing Ollama requires explicit consent.')
    const plan = await ollamaInstallPlan()
    if (!plan.command) return { started: false, plan }
    const job = await this.jobs.enqueue('ollama.install', {}, { dedupeKey: 'ollama' })
    return { started: true, jobId: job.id, plan }
  }

  private async runInstall(signal: AbortSignal) {
    const plan = await ollamaInstallPlan()
    const result = await runOllamaInstall(plan, (line) => this.events.publish('models', 'install_output', { line }), signal)
    this.events.publish('models', 'install_finished', { ok: result.ok, exitCode: result.exitCode })
    if (!result.ok) throw new Error(`Ollama installation failed (exit ${result.exitCode}).`)
  }

  /**
   * Installed models with capabilities and load state. One submitted task asks for this 4-5 times
   * within seconds (planning, warmups, routing, run start): concurrent and immediately following
   * callers share one Ollama round trip. Changes made through this service invalidate it.
   */
  async installed(): Promise<InstalledModel[]> {
    let cached = this.installedCache
    if (!cached || Date.now() - cached.at >= LocalModelsService.INSTALLED_TTL_MS) {
      const value = this.loadInstalled()
      cached = { at: Date.now(), value }
      this.installedCache = cached
      value.catch(() => {
        if (this.installedCache?.value === value) this.installedCache = undefined
      })
    }
    // roles and self-test results come from the settings and are never served from the cache
    const [models, settings] = await Promise.all([cached.value, this.settings.get()])
    return models.map((model) => ({ ...model, roles: (['fast', 'balanced', 'advanced'] as LocalRole[]).filter((role) => settings.modelRoles[role] === model.name), selfTest: settings.modelSelfTests[model.name] }))
  }

  private installedCache?: { at: number; value: Promise<Array<Omit<InstalledModel, 'roles' | 'selfTest'>>> }
  private static readonly INSTALLED_TTL_MS = 2000

  private invalidateInstalled() {
    this.installedCache = undefined
  }

  private async loadInstalled(): Promise<Array<Omit<InstalledModel, 'roles' | 'selfTest'>>> {
    const client = await this.client()
    const [models, running] = await Promise.all([client.list(), client.running().catch(() => [])])
    // details of new/changed models are fetched concurrently (cached by digest)
    await Promise.all(
      models
        .filter((model) => this.showCache.get(model.name)?.digest !== model.digest)
        .map(async (model) => {
          try {
            const details = await client.show(model.name)
            this.showCache.set(model.name, { capabilities: details.capabilities ?? [], contextLength: contextLengthFromShow(details), digest: model.digest })
          } catch {
            // not cached: retried on the next call
          }
        }),
    )
    const result: Array<Omit<InstalledModel, 'roles' | 'selfTest'>> = []
    for (const model of models) {
      const cachedShow = this.showCache.get(model.name)
      const show = cachedShow && cachedShow.digest === model.digest ? cachedShow : { capabilities: [] as string[], contextLength: undefined, digest: model.digest }
      const loaded = running.find((entry) => entry.name === model.name)
      result.push({
        name: model.name,
        sizeBytes: model.size,
        family: model.details?.family,
        parameterSize: model.details?.parameter_size,
        quantization: model.details?.quantization_level,
        capabilities: show.capabilities,
        contextLength: show.contextLength,
        loaded: Boolean(loaded),
        vramBytes: loaded?.size_vram,
      })
    }
    return result
  }

  async registryInfo(refresh = false, extra: string[] = []): Promise<RegistryModelInfo[]> {
    if (!refresh && this.registryCache && Date.now() - this.registryCache.at < 6 * 3600_000 && extra.every((model) => this.registryCache!.data.some((entry) => entry.model === model))) {
      return this.registryCache.data
    }
    const cacheFile = path.join(runtimeConfig().cacheDir, 'registry.json')
    if (!refresh && !this.registryCache) {
      // A recent lookup from a previous app start is used as is (registry data changes rarely).
      try {
        const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as { at: number; data: RegistryModelInfo[] }
        if (Date.now() - cached.at < 6 * 3600_000 && extra.every((model) => cached.data.some((entry) => entry.model === model))) {
          this.registryCache = cached
          return cached.data
        }
      } catch {
        // no cache yet
      }
    }
    const names = [...new Set([...candidateModelNames(), ...extra])]
    const data: RegistryModelInfo[] = []
    for (let index = 0; index < names.length; index += 6) {
      data.push(...(await Promise.all(names.slice(index, index + 6).map((name) => lookupRegistryModel(name)))))
    }
    const reachable = data.some((entry) => entry.exists)
    if (reachable) {
      this.registryCache = { at: Date.now(), data }
      await fs.writeFile(cacheFile, JSON.stringify(this.registryCache)).catch(() => undefined)
      return data
    }
    // Offline: fall back to the last successful lookup (marked by its timestamp).
    try {
      this.registryCache = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as { at: number; data: RegistryModelInfo[] }
      return this.registryCache.data
    } catch {
      return data
    }
  }

  async recommendations(refresh = false) {
    const [profile, registry] = await Promise.all([this.hardware(refresh), this.registryInfo(refresh)])
    let installed: InstalledModel[] = []
    try {
      installed = await this.installed()
    } catch {
      installed = []
    }
    return {
      researchedAt: CATALOG_RESEARCHED_AT,
      registryCheckedAt: this.registryCache ? new Date(this.registryCache.at).toISOString() : undefined,
      hardware: profile,
      recommendations: recommendModels({ profile, registry, installed: installed.map((model) => ({ name: model.name, size: model.sizeBytes, capabilities: model.capabilities })) }),
      note: 'Download sizes and tool templates come from registry.ollama.ai; memory needs are estimates until the model is loaded.',
    }
  }

  async requestPull(model: string, consent: boolean) {
    if (!MODEL_NAME.test(model)) throw new BadRequestException('Invalid model name.')
    if (!consent) throw new BadRequestException('Downloading a model requires explicit consent.')
    const [info] = await this.registryInfo(false, [model]).then((data) => data.filter((entry) => entry.model === model))
    const profile = await this.hardware(true)
    const free = profile.disks.ollamaModels?.freeBytes
    if (info?.downloadBytes && free !== undefined && free < info.downloadBytes + 2 * 1024 ** 3) {
      throw new BadRequestException(
        `Not enough disk space in ${profile.ollamaModelsDir}: ${(free / 1024 ** 3).toFixed(1)} GB free, ${(info.downloadBytes / 1024 ** 3).toFixed(1)} GB needed (+2 GB reserve). Choose a model folder on a larger drive in the model settings (Multi-AI Coder then starts its own Ollama instance with it).`,
      )
    }
    const job = await this.jobs.enqueue('model.pull', { model, expectedBytes: info?.downloadBytes ?? null }, { dedupeKey: `pull:${model}`, maxAttempts: 3 })
    return { jobId: job.id, model, expectedBytes: info?.downloadBytes }
  }

  private async runPull(model: string, signal: AbortSignal, progress: (data: Record<string, unknown>) => void) {
    const client = await this.client()
    if (!(await client.isReachable())) {
      const started = await this.startOllama()
      if (!started.started && !(await client.isReachable())) throw new Error(`Ollama is not reachable: ${started.message}`)
    }
    const layers = new Map<string, { total: number; completed: number }>()
    let lastEmit = 0
    await client.pull(
      model,
      (event) => {
        if (event.digest && event.total) layers.set(event.digest, { total: event.total, completed: event.completed ?? 0 })
        const total = [...layers.values()].reduce((sum, layer) => sum + layer.total, 0)
        const completed = [...layers.values()].reduce((sum, layer) => sum + layer.completed, 0)
        if (Date.now() - lastEmit > 400 || event.status === 'success') {
          lastEmit = Date.now()
          const data = { model, status: event.status, total, completed, percent: total ? Math.round((completed / total) * 1000) / 10 : undefined }
          progress(data)
          this.events.publish('models', 'pull_progress', data, model)
        }
      },
      signal,
    )
    this.showCache.delete(model)
    this.invalidateInstalled()
    this.events.publish('models', 'pull_finished', { model }, model)
  }

  async deleteModel(model: string) {
    if (!MODEL_NAME.test(model)) throw new BadRequestException('Invalid model name.')
    await (await this.client()).delete(model)
    const settings = await this.settings.get()
    const cleared: Partial<AppSettings['modelRoles']> = {}
    for (const role of ['fast', 'balanced', 'advanced'] as const) if (settings.modelRoles[role] === model) cleared[role] = null
    await this.settings.update({ modelRoles: cleared as AppSettings['modelRoles'], modelSelfTests: { [model]: null } as unknown as AppSettings['modelSelfTests'] })
    this.invalidateInstalled()
    this.events.publish('models', 'deleted', { model }, model)
    return { ok: true }
  }

  async load(model: string) {
    const settings = await this.settings.get()
    await (await this.client()).load(model, '15m', settings.numCtx)
    this.invalidateInstalled()
    this.events.publish('models', 'loaded', { model }, model)
    return { ok: true }
  }

  async unload(model: string) {
    await (await this.client()).unload(model)
    this.invalidateInstalled()
    this.events.publish('models', 'unloaded', { model }, model)
    return { ok: true }
  }

  async running() {
    return (await this.client()).running()
  }

  async assignRoles(roles: Partial<Record<LocalRole, string | null>>) {
    // Only the roles named in the request change (merge semantics in SettingsService).
    const next: Partial<AppSettings['modelRoles']> = {}
    for (const role of ['fast', 'balanced', 'advanced'] as const) {
      if (roles[role] === undefined) continue
      if (roles[role] !== null && !MODEL_NAME.test(String(roles[role]))) throw new BadRequestException(`Invalid model for ${role}.`)
      next[role] = roles[role] ?? null
    }
    return this.settings.update({ modelRoles: next as AppSettings['modelRoles'] })
  }

  /**
   * Real inference self-test: a short completion (latency, tokens/s) and a tool-call round trip.
   * Tool calling is only marked "verified" when the model actually emits a correct tool call.
   */
  async selfTest(model: string): Promise<ModelSelfTest> {
    const client = await this.client()
    const at = new Date().toISOString()
    let result: ModelSelfTest
    try {
      const show = await client.show(model)
      const supportsTools = (show.capabilities ?? []).includes('tools')
      const think = (show.capabilities ?? []).includes('thinking') ? false : undefined
      const completion = await client.chat(
        { model, messages: [{ role: 'user', content: 'Write a TypeScript function `add(a: number, b: number): number`. Reply with code only.' }], options: { num_ctx: 4096, temperature: 0, num_predict: 200 }, think },
        { timeoutMs: 5 * 60_000, idleTimeoutMs: 120_000 },
      )
      const generationMs = Math.max(1, completion.totalDurationMs - completion.loadDurationMs)
      let toolCalling: ModelSelfTest['toolCalling'] = 'not_supported'
      if (supportsTools) {
        const toolReply = await client.chat(
          {
            model,
            messages: [{ role: 'user', content: 'Create the file "hello.txt" with the content "hi" using the write_file tool.' }],
            tools: [{ type: 'function', function: { name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }],
            options: { num_ctx: 4096, temperature: 0 },
            think,
          },
          { timeoutMs: 3 * 60_000, idleTimeoutMs: 120_000 },
        )
        const call = toolReply.message.tool_calls?.[0]
        const args = typeof call?.function.arguments === 'string' ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : call?.function.arguments
        const recovered = call ? undefined : recoverTextToolCalls(toolReply.message.content)[0]
        const recoveredArgs = typeof recovered?.function.arguments === 'string' ? (JSON.parse(recovered.function.arguments) as Record<string, unknown>) : recovered?.function.arguments
        toolCalling = call?.function.name === 'write_file' && args?.path === 'hello.txt' ? 'verified' : recovered?.function.name === 'write_file' && recoveredArgs?.path === 'hello.txt' ? 'text_format' : 'failed'
      }
      const structured = await client.chat(
        { model, messages: [{ role: 'user', content: 'Return {"ok": true}.' }], format: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, options: { num_ctx: 2048, temperature: 0 }, think },
        { timeoutMs: 2 * 60_000, idleTimeoutMs: 90_000 },
      )
      let structuredOutput = false
      try {
        structuredOutput = (JSON.parse(structured.message.content) as { ok?: boolean }).ok === true
      } catch {
        structuredOutput = false
      }
      result = {
        at,
        ok: completion.message.content.includes('add') && (toolCalling !== 'failed' || structuredOutput),
        toolCalling,
        structuredOutput,
        tokensPerSecond: Math.round((completion.completionTokens / generationMs) * 1000 * 10) / 10,
        loadMs: completion.loadDurationMs,
        sampleOutput: completion.message.content.slice(0, 400),
      }
    } catch (error) {
      result = { at, ok: false, toolCalling: 'failed', structuredOutput: false, error: error instanceof Error ? error.message : String(error) }
    }
    // Only this model's entry is written: a self-test takes minutes and must not overwrite results of others.
    await this.settings.update({ modelSelfTests: { [model]: result } })
    this.events.publish('models', 'self_test', { model, ...result }, model)
    return result
  }

  private readonly warming = new Map<string, Promise<void>>()
  private readonly warmupReservations = new Map<string, number>()
  private warmupQueue: Promise<unknown> = Promise.resolve()
  /** Model load times measured by warm-ups (diagnostics). */
  readonly warmups: Array<{ model: string; reason: string; loadMs?: number; skipped?: string; at: string }> = []

  /**
   * Loads local models in the background so the first agent call does not wait for the model load
   * (~16 s for a 7B model from disk). Only models that fit into the remaining VRAM next to the models
   * already loaded are warmed (without a reliable VRAM figure: only if free RAM is ample), and the
   * context size equals the one the agent uses – a different num_ctx would make Ollama reload.
   */
  async warmup(models: Array<string | null | undefined>, reason: string): Promise<string[]> {
    // Serialize only preparation/reservation, never the background model load itself.
    const next = this.warmupQueue.then(() => this.prepareWarmup(models, reason))
    this.warmupQueue = next.catch(() => undefined)
    return next
  }

  private async prepareWarmup(models: Array<string | null | undefined>, reason: string): Promise<string[]> {
    const settings = await this.settings.get()
    const wanted = [...new Set(models.filter((model): model is string => Boolean(model)))]
    if (!settings.modelWarmup || !wanted.length) return []
    const client = await this.client()
    if (!(await client.isReachable().catch(() => false))) return []
    const [running, profiles, installed, hardware] = await Promise.all([client.running().catch(() => []), this.engineProfiles(), this.installed().catch(() => [] as InstalledModel[]), this.hardware()])
    const vramMb = usableVramMb(hardware)
    let usedMb = running.reduce((sum, entry) => sum + (entry.size_vram ?? 0), 0) / 1024 / 1024
    let pendingMb = 0
    for (const [model, bytes] of this.warmupReservations) if (!running.some(entry => entry.name === model)) pendingMb += bytes / 1024 ** 2
    usedMb += pendingMb
    const started: string[] = []
    for (const model of wanted) {
      if (running.some((entry) => entry.name === model) || this.warming.has(model)) continue
      const sizeMb = (installed.find((entry) => entry.name === model)?.sizeBytes ?? 0) / 1024 / 1024
      if (!sizeMb) continue
      const numCtx = profiles.find((profile) => profile.model === model)?.contextWindow ?? settings.numCtx
      const needBytes = estimateRuntimeMemory(sizeMb * 1024 ** 2, numCtx)
      const needMb = needBytes / 1024 ** 2
      const fits = vramMb ? usedMb + needMb <= vramMb * 0.85 : os.freemem() / 1024 ** 2 > pendingMb + needMb + 4096
      if (!fits) {
        this.events.publish('models', 'warmup_skipped', { model, reason, cause: 'memory' }, model)
        this.warmups.push({ model, reason, skipped: 'memory', at: new Date().toISOString() })
        continue
      }
      usedMb += needMb
      pendingMb += needMb
      this.warmupReservations.set(model, needBytes)
      const begin = Date.now()
      this.events.publish('models', 'warmup_started', { model, reason }, model)
      const promise = client
        .load(model, `${settings.keepAliveMinutes}m`, numCtx)
        .then(() => {
          this.warmups.push({ model, reason, loadMs: Date.now() - begin, at: new Date().toISOString() })
          if (this.warmups.length > 50) this.warmups.shift()
          this.events.publish('models', 'warmup_finished', { model, reason, loadMs: Date.now() - begin }, model)
        })
        .catch((error: unknown) => this.events.publish('models', 'warmup_failed', { model, reason, error: error instanceof Error ? error.message : String(error) }, model))
        .finally(() => { this.warming.delete(model); this.warmupReservations.delete(model) })
      this.warming.set(model, promise)
      started.push(model)
    }
    return started
  }

  /** Local model profiles for the execution engine (roles, verified tool calling, context). */
  async engineProfiles(): Promise<LocalModelRuntime[]> {
    const settings = await this.settings.get()
    const provider = await this.plugins?.selectedExtension('modelProviders')
    if (provider) {
      const models = await this.plugins!.invokeExtension<Array<{ id: string; contextTokens: number; toolCalling: boolean }>>(provider.plugin, 'modelProviders', provider.id, 'models', {})
      if (!Array.isArray(models) || models.some((model) => typeof model.id !== 'string' || !Number.isSafeInteger(model.contextTokens) || model.contextTokens < 1024)) throw new BadRequestException('Model provider returned an invalid model catalog.')
      return models.map((model) => ({ model: `plugin:${provider.plugin}:${provider.id}:${model.id}`, roles: ['balanced'], toolCalling: false, contextWindow: model.contextTokens, available: true }))
    }
    // roles are assigned but Ollama is not running (e.g. the app's own instance ended with the
    // previous app session): start it like a download does, instead of routing everything away
    if (Object.values(settings.modelRoles).some(Boolean)) await this.ensureOllama().catch(() => undefined)
    let installed: InstalledModel[] = []
    try {
      installed = await this.installed()
    } catch {
      return []
    }
    const byModel = new Map<string, LocalModelRuntime>()
    const hardware = await this.hardware()
    for (const role of ['fast', 'balanced', 'advanced'] as const) {
      const name = settings.modelRoles[role]
      if (!name) continue
      const model = installed.find((entry) => entry.name === name)
      const existing = byModel.get(name)
      if (existing) {
        existing.roles.push(role)
        continue
      }
      const selfTest = settings.modelSelfTests[name]
      byModel.set(name, {
        model: name,
        roles: [role],
        // template capability AND (if tested) a successful real tool call
        toolCalling: Boolean(model?.capabilities.includes('tools')) && selfTest?.toolCalling !== 'failed',
        thinking: Boolean(model?.capabilities.includes('thinking')),
        structuredOutput: selfTest?.structuredOutput,
        contextWindow: runtimeContextTokens(settings.numCtx, model?.contextLength, model?.sizeBytes ?? 0, hardware),
        available: Boolean(model),
      })
    }
    return [...byModel.values()]
  }

  clientFor(model: string, fallback: OllamaClient): Pick<OllamaClient, 'chat'> {
    if (!model.startsWith('plugin:')) return fallback
    const [, plugin, id, ...modelParts] = model.split(':')
    return { chat: async (request, options = {}) => {
      if (options.signal?.aborted) throw new OllamaError('Model call cancelled.', 'aborted')
      const started = Date.now()
      const result = await this.plugins!.invokeExtension<{ text: string; inputTokens?: number; outputTokens?: number }>(plugin!, 'modelProviders', id!, 'generate', { model: modelParts.join(':'), messages: request.messages, contextTokens: request.options?.num_ctx, maxTokens: request.options?.num_predict, format: request.format }, { signal: options.signal, timeoutMs: options.timeoutMs }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        throw new OllamaError(message, options.signal?.aborted ? 'aborted' : /Kontextlimit|Ausgabelimit|token limit/.test(message) ? 'resource_limit' : /timed out|did not answer/.test(message) ? 'timeout' : 'invalid_response')
      })
      if (typeof result.text !== 'string') throw new OllamaError('Model provider returned an invalid completion.', 'invalid_response')
      // This provider returns a complete response, not a token stream. Do not report it as TTFT.
      if (request.options?.num_ctx && (!Number.isSafeInteger(result.inputTokens) || result.inputTokens! < 0 || result.inputTokens! > request.options.num_ctx)) throw new OllamaError('Plugin provider could not verify the context token limit or exceeded it.', 'resource_limit')
      if (request.options?.num_predict && (!Number.isSafeInteger(result.outputTokens) || result.outputTokens! < 0 || result.outputTokens! > request.options.num_predict)) throw new OllamaError('Plugin provider could not verify the output token limit or exceeded it.', 'resource_limit')
      return { message: { role: 'assistant', content: result.text }, promptTokens: result.inputTokens ?? 0, completionTokens: result.outputTokens ?? 0, totalDurationMs: Date.now() - started, loadDurationMs: 0 }
    } }
  }

  /** Parallel local inference slots: >1 only when all role models fit into VRAM together. */
  async localSlots(): Promise<number> {
    const settings = await this.settings.get()
    if (typeof settings.localParallelism === 'number') return Math.max(1, Math.min(4, settings.localParallelism))
    const profile = await this.hardware()
    const vram = usableVramMb(profile)
    if (!vram) return 1
    let installed: InstalledModel[] = []
    try {
      installed = await this.installed()
    } catch {
      return 1
    }
    const names = [...new Set(Object.values(settings.modelRoles).filter((value): value is string => Boolean(value)))]
    const total = names.reduce((sum, name) => {
      const model = installed.find((entry) => entry.name === name)
      if (!model) return Infinity
      const context = runtimeContextTokens(settings.numCtx, model.contextLength, model.sizeBytes, profile)
      return sum + estimateRuntimeMemory(model.sizeBytes, context)
    }, 0)
    return names.length > 1 && total < vram * 1024 * 1024 * 0.9 ? Math.min(2, names.length) : 1
  }

  async diskForModels() {
    const profile = await this.hardware()
    return diskInfo(profile.ollamaModelsDir)
  }
}
