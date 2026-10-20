import { mkdtempSync, promises as fs, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '../util/process.js'
import { classifyCliFailure, CliOrchestratorBase, type CliAdapterOptions } from './cli-base.js'
import { analysisPrompt, chatFollowUpPrompt, chatPrompt, executionPrompt, ORCHESTRATOR_SYSTEM_PROMPT, planningPrompt, reviewPrompt } from './prompts.js'
import { ANALYSIS_SCHEMA, CHAT_SCHEMA, EXECUTION_SUMMARY_SCHEMA, extractJson, normalizeAnalysis, normalizePlan, normalizeReview, PLAN_SCHEMA, REVIEW_SCHEMA } from './schemas.js'
import {
  normalizeWithMeta,
  OrchestratorError,
  type AnalysisInput,
  type CallContext,
  type CallMeta,
  type ChatInput,
  type ConnectionResult,
  type ConnectionStatus,
  type DiagnosticReport,
  type ExecutionInput,
  type OrchestratorAdapter,
  type OrchestratorCapabilities,
  type PlanningInput,
  type ReviewInput,
  type RuntimeDetection,
  type UsageReport,
} from './types.js'

interface CodexModel {
  slug: string
  displayName: string
  listed: boolean
  priority: number
}

interface CodexCallOptions {
  schema: Record<string, unknown>
  sandbox: 'read-only' | 'workspace-write'
  ephemeral: boolean
  resumeSessionId?: string
}

/**
 * OpenAI Codex adapter. Uses the official CLI in non-interactive mode (`codex exec --json`)
 * with `--output-schema` for structured results. Authentication is the user's own
 * `codex login` (ChatGPT sign-in); the app never touches auth.json.
 */
export class CodexAdapter extends CliOrchestratorBase implements OrchestratorAdapter {
  readonly id = 'codex' as const
  readonly displayName = 'OpenAI Codex'
  protected readonly binaryName = 'codex'
  protected readonly apiBillingEnvKeys = ['OPENAI_API_KEY', 'CODEX_API_KEY']
  protected readonly knownLocations = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    path.join(process.env.APPDATA ?? '', 'npm', 'codex.cmd'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ]

  private modelCache?: { at: number; models: CodexModel[] }
  /** Model chosen after a "model not supported for this account" failure (only when the user pinned none). */
  private fallbackModel?: string
  onModelFallback?: (from: string | undefined, to: string) => void

  constructor(options: CliAdapterOptions = {}) {
    super(options)
  }

  private codexHome(): string {
    return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
  }

  /** Model configured in the user's own ~/.codex/config.toml (read-only; never modified). */
  configuredModel(): string | undefined {
    try {
      const config = readFileSync(path.join(this.codexHome(), 'config.toml'), 'utf8')
      const header = config.split(/^\[/m)[0] ?? ''
      return header.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1]
    } catch {
      return undefined
    }
  }

  async listModels(): Promise<CodexModel[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.models
    const binary = this.resolveBinary()
    if (!binary) return []
    const result = await runProcess(binary, ['debug', 'models'], { timeoutMs: 30_000, env: this.childEnv() })
    try {
      const parsed = JSON.parse(result.stdout) as unknown
      const rows = (Array.isArray(parsed) ? parsed : ((parsed as { models?: unknown[] }).models ?? [])) as Array<Record<string, unknown>>
      const models = rows
        .map((row) => ({
          slug: String(row.slug ?? row.id ?? ''),
          displayName: String(row.display_name ?? row.slug ?? ''),
          listed: row.visibility === 'list',
          priority: typeof row.priority === 'number' ? row.priority : 99,
        }))
        .filter((model) => model.slug)
      this.modelCache = { at: Date.now(), models }
      return models
    } catch {
      return []
    }
  }

  private effectiveModel(): string | undefined {
    return this.options.model || this.fallbackModel || undefined
  }

  async detect(): Promise<RuntimeDetection> {
    const binary = this.resolveBinary()
    return {
      installed: Boolean(binary),
      binary,
      version: binary ? await this.version(binary) : undefined,
      installHint: {
        docsUrl: 'https://developers.openai.com/codex/cli',
        commands: [{ label: 'npm', command: ['npm', 'install', '-g', '@openai/codex'] }],
      },
    }
  }

  async capabilities(): Promise<OrchestratorCapabilities> {
    const models = (await this.listModels()).filter((model) => model.listed).sort((a, b) => a.priority - b.priority)
    const configured = this.configuredModel()
    return {
      structuredOutput: true,
      streaming: true,
      sessionResume: true,
      fileEditing: true,
      sandbox:
        process.platform === 'win32'
          ? 'Isolated git worktree + Codex workspace-write sandbox (Windows sandbox support in Codex is limited; treat as policy isolation).'
          : 'Isolated git worktree + Codex workspace-write sandbox (OS-enforced: Seatbelt on macOS, Landlock/seccomp on Linux; network off).',
      models: [
        { id: '', label: configured ? `Codex config default (${configured})` : 'Codex default', default: true },
        ...models.map((model) => ({ id: model.slug, label: model.displayName })),
      ],
      typicalOverheadTokens: 13_000,
    }
  }

  async getStatus(): Promise<ConnectionStatus> {
    const checkedAt = new Date().toISOString()
    const binary = this.resolveBinary()
    if (!binary) return { orchestrator: this.id, installed: false, authenticated: false, usesApiKeyBilling: false, checkedAt, message: 'Codex CLI is not installed.' }
    const [version, result] = await Promise.all([this.version(binary), runProcess(binary, ['login', 'status'], { timeoutMs: 20_000, env: this.childEnv() })])
    const text = `${result.stdout}\n${result.stderr}`.trim()
    const chatgpt = /logged in using chatgpt/i.test(text)
    const apiKey = /logged in using an api key|api key/i.test(text) && !chatgpt
    const authenticated = result.exitCode === 0 && /logged in/i.test(text) && !/not logged in/i.test(text)
    return {
      orchestrator: this.id,
      installed: true,
      version,
      authenticated,
      authMethod: authenticated ? (chatgpt ? 'ChatGPT' : apiKey ? 'API key' : 'unknown') : undefined,
      usesApiKeyBilling: authenticated && apiKey,
      checkedAt,
      message: authenticated
        ? apiKey
          ? 'Logged in with an API key: calls are billed per token.'
          : 'Logged in with ChatGPT.'
        : 'Not logged in. Run the official login.',
    }
  }

  async connect(): Promise<ConnectionResult> {
    const binary = this.resolveBinary()
    if (!binary) return { status: 'needs_install', message: 'Install the Codex CLI first.' }
    const status = await this.getStatus()
    if (status.authenticated) return { status: 'already_connected', message: status.message }
    return { status: 'login_required', loginCommand: [binary, 'login'], message: 'Run the official Codex login. It opens the browser for your ChatGPT account.' }
  }

  async logout(): Promise<void> {
    const binary = this.requireBinary()
    await runProcess(binary, ['logout'], { timeoutMs: 30_000, env: this.childEnv() })
  }

  async diagnose(options: { liveCall?: boolean; cwd?: string } = {}): Promise<DiagnosticReport> {
    const checks: DiagnosticReport['checks'] = []
    const detection = await this.detect()
    checks.push({ name: 'CLI installed', ok: detection.installed, detail: detection.installed ? `${detection.binary} (${detection.version ?? 'unknown version'})` : 'codex not found' })
    if (detection.installed) {
      const status = await this.getStatus()
      checks.push({ name: 'Authenticated', ok: status.authenticated, detail: status.message })
      checks.push({ name: 'Subscription billing', ok: !status.usesApiKeyBilling, detail: status.usesApiKeyBilling ? 'API-key billing is active.' : 'No API key is used by the app (API key variables are stripped).' })
      const models = await this.listModels()
      const configured = this.configuredModel()
      const pinned = this.options.model
      if (pinned || configured) {
        const target = pinned ?? configured!
        const known = models.find((model) => model.slug === target)
        checks.push({
          name: 'Model',
          ok: Boolean(known),
          detail: known ? `${target} is in the Codex model catalog.` : `${target} is not in the Codex model catalog; choose one of: ${models.filter((model) => model.listed).map((model) => model.slug).join(', ')}`,
        })
      }
      if (options.liveCall && status.authenticated) {
        try {
          const call = await this.callStructured('Reply with ok=true. Do not run commands.', { schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }, sandbox: 'read-only', ephemeral: true }, {
            runId: `diagnose-${Date.now()}`,
            cwd: options.cwd ?? os.tmpdir(),
            timeoutMs: 180_000,
            effort: 'low',
          })
          checks.push({ name: 'Live model call', ok: (call.structured as { ok?: boolean })?.ok === true, detail: `${call.meta.model ?? 'model'} answered in ${call.meta.durationMs} ms (${call.meta.usage.inputTokens}+${call.meta.usage.outputTokens} tokens).` })
        } catch (error) {
          checks.push({ name: 'Live model call', ok: false, detail: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    return { orchestrator: this.id, ok: checks.every((check) => check.ok), checks }
  }

  async analyzeTask(input: AnalysisInput, ctx: CallContext) {
    const call = await this.callStructured(withSystem(analysisPrompt(input)), { schema: ANALYSIS_SCHEMA, sandbox: 'read-only', ephemeral: true }, ctx)
    return { result: normalizeAnalysis(call.structured), meta: call.meta }
  }

  async createPlan(input: PlanningInput, ctx: CallContext) {
    const call = await this.callStructured(withSystem(planningPrompt(input)), { schema: PLAN_SCHEMA, sandbox: 'read-only', ephemeral: true }, ctx)
    return { result: normalizeWithMeta(call.meta, () => normalizePlan(call.structured, input.maxTasks)), meta: call.meta }
  }

  async reviewResult(input: ReviewInput, ctx: CallContext) {
    const call = await this.callStructured(withSystem(reviewPrompt(input)), { schema: REVIEW_SCHEMA, sandbox: 'read-only', ephemeral: true }, ctx)
    return { result: normalizeReview(call.structured), meta: call.meta }
  }

  async chat(input: ChatInput, ctx: CallContext) {
    // Threads are kept (not ephemeral) so a follow-up question can resume them.
    let call: Awaited<ReturnType<CodexAdapter['callStructured']>>
    if (input.resumeSessionId) {
      try {
        call = await this.callStructured(chatFollowUpPrompt(input), { schema: CHAT_SCHEMA, sandbox: 'read-only', ephemeral: false, resumeSessionId: input.resumeSessionId }, ctx)
      } catch (error) {
        if (error instanceof OrchestratorError && ['cancelled', 'not_authenticated', 'session_expired', 'quota_exhausted', 'rate_limited'].includes(error.kind)) throw error
        call = await this.callStructured(withSystem(chatPrompt(input)), { schema: CHAT_SCHEMA, sandbox: 'read-only', ephemeral: false }, ctx)
      }
    } else {
      call = await this.callStructured(withSystem(chatPrompt(input)), { schema: CHAT_SCHEMA, sandbox: 'read-only', ephemeral: false }, ctx)
    }
    const answer = (call.structured as { answer?: unknown })?.answer
    return { result: { answer: typeof answer === 'string' ? answer : call.text }, meta: call.meta }
  }

  async executeComplexTask(input: ExecutionInput, ctx: CallContext) {
    const commandsRun: string[] = []
    const call = await this.callStructured(
      executionPrompt(input),
      { schema: EXECUTION_SUMMARY_SCHEMA, sandbox: 'workspace-write', ephemeral: false, resumeSessionId: input.resumeSessionId },
      { ...ctx, onEvent: (event) => {
        if (event.type === 'command') commandsRun.push(event.command)
        ctx.onEvent?.(event)
      } },
    )
    const data = (call.structured ?? {}) as { summary?: string; filesChanged?: string[] }
    return {
      result: {
        summary: typeof data.summary === 'string' ? data.summary : call.text,
        filesChanged: Array.isArray(data.filesChanged) ? data.filesChanged.filter((file): file is string => typeof file === 'string') : [],
        commandsRun,
        sessionId: call.meta.sessionId,
      },
      meta: call.meta,
    }
  }

  private async callStructured(prompt: string, options: CodexCallOptions, ctx: CallContext): Promise<{ structured: unknown; text: string; meta: CallMeta }> {
    try {
      return await this.callOnce(prompt, options, ctx)
    } catch (error) {
      if (error instanceof OrchestratorError && error.kind === 'model_unavailable' && !this.options.model && !this.fallbackModel) {
        const listed = (await this.listModels()).filter((model) => model.listed).sort((a, b) => a.priority - b.priority)
        const configured = this.configuredModel()
        const candidate = listed.find((model) => model.slug !== configured)
        if (candidate) {
          this.fallbackModel = candidate.slug
          this.onModelFallback?.(configured, candidate.slug)
          this.emit(ctx, { type: 'error', message: `Configured Codex model "${configured ?? 'default'}" is not available for this account; using "${candidate.slug}".` })
          return this.callOnce(prompt, options, ctx)
        }
      }
      throw error
    }
  }

  private mcpServersCache?: { at: number; names: string[] }

  /**
   * MCP servers from the user's Codex configuration that would still be active with plugins disabled
   * (`codex mcp list --json` reads configuration only; no model call). Cached for 5 minutes.
   */
  private async userMcpServers(): Promise<string[]> {
    if (this.mcpServersCache && Date.now() - this.mcpServersCache.at < 5 * 60_000) return this.mcpServersCache.names
    const binary = this.resolveBinary()
    let names: string[] = []
    if (binary) {
      const result = await runProcess(binary, ['mcp', 'list', '--json', '--disable', 'plugins'], { timeoutMs: 20_000, env: this.childEnv() }).catch(() => undefined)
      try {
        names = (JSON.parse(result?.stdout ?? '[]') as Array<{ name?: unknown; enabled?: unknown }>).filter((entry) => typeof entry.name === 'string' && entry.enabled !== false).map((entry) => entry.name as string)
      } catch {
        names = []
      }
    }
    this.mcpServersCache = { at: Date.now(), names }
    return names
  }

  private async callOnce(prompt: string, options: CodexCallOptions, ctx: CallContext): Promise<{ structured: unknown; text: string; meta: CallMeta }> {
    const schemaDir = mkdtempSync(path.join(os.tmpdir(), 'mac-codex-'))
    const schemaFile = path.join(schemaDir, 'schema.json')
    await fs.writeFile(schemaFile, JSON.stringify(options.schema), 'utf8')

    const shared = ['--json', '--output-schema', schemaFile, '--skip-git-repo-check', '--sandbox', options.sandbox]
    // MCP isolation (verified with `codex mcp list --json`): a `-c mcp_servers={…}` table override only
    // merges, so the user's own servers would stay active. Instead plugin-provided servers are switched
    // off with the `plugins` feature and every remaining configured server with `enabled=false` – all
    // per call, ~/.codex/config.toml is never written. The gateway then exposes only three small tools.
    shared.push('--disable', 'plugins')
    for (const name of await this.userMcpServers()) if (name !== 'app') shared.push('-c', `mcp_servers.${tomlKey(name)}.enabled=false`)
    if (ctx.mcpGateway) {
      shared.push('-c', `mcp_servers.app.url=${JSON.stringify(ctx.mcpGateway.url)}`, '-c', 'mcp_servers.app.enabled_tools=["search_tools","call_tool","read_result"]')
      // codex exec runs with approval policy "never": tools needing approval are rejected. Only the three
      // gateway tools are pre-approved; behind call_tool are only tools the app allows for agents
      // ("confirm" tools never reach agents) and every call is re-checked by the app.
      for (const tool of ['search_tools', 'call_tool', 'read_result']) shared.push('-c', `mcp_servers.app.tools.${tool}.approval_mode="approve"`)
    }
    const model = this.effectiveModel()
    if (model) shared.push('-m', model)
    if (ctx.effort) shared.push('-c', `model_reasoning_effort="${ctx.effort}"`)
    if (options.ephemeral) shared.push('--ephemeral')
    const args = options.resumeSessionId
      ? ['exec', 'resume', ...shared, options.resumeSessionId, '-']
      : ['exec', ...shared, '-C', ctx.cwd, '-']

    let sessionId: string | undefined
    let lastMessage = ''
    let usage: UsageReport | undefined
    let failure: string | undefined
    const errors: string[] = []

    try {
      const processResult = await this.runJsonl(args, ctx, prompt, (event) => {
        const type = String(event.type ?? '')
        if (type === 'thread.started' && typeof event.thread_id === 'string') {
          sessionId = event.thread_id
          this.emit(ctx, { type: 'session', sessionId, model })
        } else if (type === 'item.completed' || type === 'item.started') {
          const item = (event.item ?? {}) as Record<string, unknown>
          const itemType = String(item.type ?? '')
          if (itemType === 'agent_message' || itemType === 'reasoning') this.markFirstOutput(ctx, 'event')
          if (itemType === 'agent_message' && type === 'item.completed' && typeof item.text === 'string') {
            lastMessage = item.text
            this.emit(ctx, { type: 'text', text: item.text })
          } else if (itemType === 'command_execution' && type === 'item.completed') {
            this.emit(ctx, { type: 'command', command: String(item.command ?? ''), exitCode: typeof item.exit_code === 'number' ? item.exit_code : null })
          } else if (itemType === 'file_change' && type === 'item.completed') {
            for (const change of (item.changes ?? []) as Array<{ path?: string; kind?: string }>) {
              if (change.path) this.emit(ctx, { type: 'file_change', path: change.path, kind: String(change.kind ?? 'update') })
            }
          } else if (itemType === 'error' && typeof item.message === 'string') {
            errors.push(item.message)
          } else if (itemType && type === 'item.started' && itemType !== 'reasoning') {
            this.emit(ctx, { type: 'tool', name: itemType, detail: String(item.command ?? item.query ?? '') })
          }
        } else if (type === 'turn.completed') {
          const raw = (event.usage ?? {}) as Record<string, unknown>
          usage = {
            inputTokens: Number(raw.input_tokens ?? 0),
            outputTokens: Number(raw.output_tokens ?? 0) + Number(raw.reasoning_output_tokens ?? 0),
            cachedInputTokens: Number(raw.cached_input_tokens ?? 0),
            measured: true,
            billing: this.options.authMode === 'api_key' ? 'api_key' : 'subscription',
          }
          this.emit(ctx, { type: 'usage', usage })
        } else if (type === 'turn.failed') {
          failure = String((event.error as { message?: unknown } | undefined)?.message ?? 'turn failed')
        } else if (type === 'error') {
          failure = String(event.message ?? 'error')
        }
      })

      if (failure || !usage) {
        throw classifyCliFailure(`${failure ?? ''}\n${errors.join('\n')}\n${processResult.stderr.slice(-3000)}`, 'codex')
      }
      let structured: unknown
      try {
        structured = extractJson(lastMessage)
      } catch {
        throw new OrchestratorError('Codex returned no structured output.', 'invalid_output', { retryable: true })
      }
      return { structured, text: lastMessage, meta: { sessionId, model, usage, durationMs: processResult.durationMs } }
    } finally {
      rmSync(schemaDir, { recursive: true, force: true })
    }
  }
}

/** TOML key for a dotted `-c` path (bare keys allow letters, digits, "_" and "-"). */
export function tomlKey(name: string) {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)
}

function withSystem(prompt: string): string {
  return `${ORCHESTRATOR_SYSTEM_PROMPT}\n\n${prompt}`
}
