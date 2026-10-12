import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  candidateModelNames,
  CATALOG_RESEARCHED_AT,
  contextLengthFromShow,
  detectHardware,
  detectOllama,
  diskInfo,
  lookupRegistryModel,
  OllamaClient,
  recoverTextToolCalls,
  ollamaInstallPlan,
  recommendModels,
  runOllamaInstall,
  startOllamaServer,
  usableVramMb,
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
export class LocalModelsService implements OnModuleInit {
  private readonly logger = new Logger('LocalModels')
  private hardwareCache?: HardwareProfile
  private registryCache?: { at: number; data: RegistryModelInfo[] }
  private showCache = new Map<string, { capabilities: string[]; contextLength?: number; digest: string }>()

  constructor(
    private readonly settings: SettingsService,
    private readonly events: EventBusService,
    private readonly jobs: JobQueueService,
  ) {}

  onModuleInit() {
    this.jobs.register('model.pull', (payload, ctx) => this.runPull(String(payload.model), ctx.signal, ctx.progress), { concurrency: 1, onRecover: 'requeue' })
    this.jobs.register('ollama.install', (_payload, ctx) => this.runInstall(ctx.signal), { concurrency: 1, onRecover: 'interrupt' })
  }

  async client(): Promise<OllamaClient> {
    return new OllamaClient((await this.settings.get()).ollamaBaseUrl)
  }

  async hardware(refresh = false): Promise<HardwareProfile> {
    const settings = await this.settings.get()
    if (!this.hardwareCache || refresh) this.hardwareCache = await detectHardware({ appDataDir: runtimeConfig().dataDir, ollamaModelsDir: settings.ollamaModelsDir ?? undefined })
    return this.hardwareCache
  }

  async ollamaStatus() {
    const settings = await this.settings.get()
    const installation = await detectOllama(settings.ollamaBaseUrl)
    return { ...installation, installPlan: installation.installed ? undefined : await ollamaInstallPlan() }
  }

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

  async installed(): Promise<InstalledModel[]> {
    const client = await this.client()
    const settings = await this.settings.get()
    const [models, running] = await Promise.all([client.list(), client.running().catch(() => [])])
    const result: InstalledModel[] = []
    for (const model of models) {
      let show = this.showCache.get(model.name)
      if (!show || show.digest !== model.digest) {
        try {
          const details = await client.show(model.name)
          show = { capabilities: details.capabilities ?? [], contextLength: contextLengthFromShow(details), digest: model.digest }
          this.showCache.set(model.name, show)
        } catch {
          show = { capabilities: [], digest: model.digest }
        }
      }
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
        roles: (['fast', 'balanced', 'advanced'] as LocalRole[]).filter((role) => settings.modelRoles[role] === model.name),
        selfTest: settings.modelSelfTests[model.name],
      })
    }
    return result
  }

  async registryInfo(refresh = false, extra: string[] = []): Promise<RegistryModelInfo[]> {
    if (!refresh && this.registryCache && Date.now() - this.registryCache.at < 6 * 3600_000 && extra.every((model) => this.registryCache!.data.some((entry) => entry.model === model))) {
      return this.registryCache.data
    }
    const cacheFile = path.join(runtimeConfig().cacheDir, 'registry.json')
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
    this.events.publish('models', 'pull_finished', { model }, model)
  }

  async deleteModel(model: string) {
    if (!MODEL_NAME.test(model)) throw new BadRequestException('Invalid model name.')
    await (await this.client()).delete(model)
    const settings = await this.settings.get()
    const cleared: Partial<AppSettings['modelRoles']> = {}
    for (const role of ['fast', 'balanced', 'advanced'] as const) if (settings.modelRoles[role] === model) cleared[role] = null
    await this.settings.update({ modelRoles: cleared as AppSettings['modelRoles'], modelSelfTests: { [model]: null } as unknown as AppSettings['modelSelfTests'] })
    this.events.publish('models', 'deleted', { model }, model)
    return { ok: true }
  }

  async load(model: string) {
    const settings = await this.settings.get()
    await (await this.client()).load(model, '15m', settings.numCtx)
    this.events.publish('models', 'loaded', { model }, model)
    return { ok: true }
  }

  async unload(model: string) {
    await (await this.client()).unload(model)
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

  /** Local model profiles for the execution engine (roles, verified tool calling, context). */
  async engineProfiles(): Promise<LocalModelRuntime[]> {
    const settings = await this.settings.get()
    let installed: InstalledModel[] = []
    try {
      installed = await this.installed()
    } catch {
      return []
    }
    const byModel = new Map<string, LocalModelRuntime>()
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
        contextWindow: Math.min(model?.contextLength ?? settings.numCtx, settings.numCtx),
        available: Boolean(model),
      })
    }
    return [...byModel.values()]
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
    const total = names.reduce((sum, name) => sum + (installed.find((model) => model.name === name)?.sizeBytes ?? Infinity) * 1.25, 0)
    return names.length > 1 && total < vram * 1024 * 1024 * 0.9 ? Math.min(2, names.length) : 1
  }

  async diskForModels() {
    const profile = await this.hardware()
    return diskInfo(profile.ollamaModelsDir)
  }
}
