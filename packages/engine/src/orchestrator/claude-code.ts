import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '../util/process.js'
import { classifyCliFailure, CliOrchestratorBase, type CliAdapterOptions } from './cli-base.js'
import { analysisPrompt, chatPrompt, executionPrompt, ORCHESTRATOR_SYSTEM_PROMPT, planningPrompt, reviewPrompt } from './prompts.js'
import { ANALYSIS_SCHEMA, CHAT_SCHEMA, EXECUTION_SUMMARY_SCHEMA, extractJson, normalizeAnalysis, normalizePlan, normalizeReview, PLAN_SCHEMA, REVIEW_SCHEMA } from './schemas.js'
import {
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
  type RateLimitInfo,
  type ReviewInput,
  type RuntimeDetection,
  type UsageReport,
} from './types.js'

interface ClaudeCallOptions {
  schema: Record<string, unknown>
  /** Built-in tools to expose ("" = none). */
  tools: string
  systemPrompt?: string
  appendSystemPrompt?: string
  permissionMode?: 'default' | 'acceptEdits'
  persistSession?: boolean
  resumeSessionId?: string
}

interface ClaudeCallResult {
  structured: unknown
  text: string
  meta: CallMeta
}

/**
 * Claude Code adapter. Uses the official CLI in headless print mode (`claude -p`) with
 * `--output-format stream-json` and `--json-schema`. Authentication is whatever the user
 * established with the official `claude auth login` flow (claude.ai subscription); the app never
 * reads or forwards tokens.
 */
export class ClaudeCodeAdapter extends CliOrchestratorBase implements OrchestratorAdapter {
  readonly id = 'claude-code' as const
  readonly displayName = 'Claude Code'
  protected readonly binaryName = 'claude'
  protected readonly apiBillingEnvKeys = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ]
  protected readonly knownLocations = [
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    path.join(os.homedir(), '.claude', 'local', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]

  private lastRateLimit?: RateLimitInfo

  constructor(options: CliAdapterOptions = {}) {
    super(options)
  }

  async detect(): Promise<RuntimeDetection> {
    const binary = this.resolveBinary()
    return {
      installed: Boolean(binary),
      binary,
      version: binary ? await this.version(binary) : undefined,
      installHint: {
        docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
        commands:
          process.platform === 'win32'
            ? [
                { label: 'winget', command: ['winget', 'install', '--id', 'Anthropic.ClaudeCode', '-e'] },
                { label: 'npm', command: ['npm', 'install', '-g', '@anthropic-ai/claude-code'] },
              ]
            : [
                { label: 'Official installer', command: ['bash', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'] },
                { label: 'npm', command: ['npm', 'install', '-g', '@anthropic-ai/claude-code'] },
              ],
      },
    }
  }

  async capabilities(): Promise<OrchestratorCapabilities> {
    return {
      structuredOutput: true,
      streaming: true,
      sessionResume: true,
      fileEditing: true,
      sandbox: 'Isolated git worktree; edit tools limited to Read/Edit/Write/Glob/Grep (no shell) with acceptEdits inside the worktree.',
      models: [
        { id: '', label: 'CLI default', default: true },
        { id: 'sonnet', label: 'Sonnet (alias)' },
        { id: 'opus', label: 'Opus (alias)' },
        { id: 'haiku', label: 'Haiku (alias)' },
      ],
      typicalOverheadTokens: 1500,
    }
  }

  async getStatus(): Promise<ConnectionStatus> {
    const checkedAt = new Date().toISOString()
    const binary = this.resolveBinary()
    if (!binary) {
      return { orchestrator: this.id, installed: false, authenticated: false, usesApiKeyBilling: false, checkedAt, message: 'Claude Code CLI is not installed.' }
    }
    const version = await this.version(binary)
    const result = await runProcess(binary, ['auth', 'status', '--json'], { timeoutMs: 20_000, env: this.childEnv() })
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>
    } catch {
      parsed = undefined
    }
    if (!parsed) {
      return {
        orchestrator: this.id,
        installed: true,
        version,
        authenticated: false,
        usesApiKeyBilling: false,
        checkedAt,
        message: `Could not read auth status: ${(result.stderr || result.stdout).trim().slice(0, 300) || 'no output'}`,
      }
    }
    const loggedIn = parsed.loggedIn === true
    const authMethod = typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined
    const subscription = typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : undefined
    const usesApiKeyBilling = loggedIn && authMethod !== undefined && !/claude\.ai|oauth|subscription/i.test(authMethod)
    return {
      orchestrator: this.id,
      installed: true,
      version,
      authenticated: loggedIn,
      authMethod: authMethod ? `${authMethod}${subscription ? ` (${subscription})` : ''}` : undefined,
      account: typeof parsed.email === 'string' ? parsed.email : undefined,
      usesApiKeyBilling,
      checkedAt,
      message: loggedIn
        ? usesApiKeyBilling
          ? 'Logged in with an API key/console account: calls are billed per token.'
          : 'Logged in with a Claude subscription.'
        : 'Not logged in. Run the official login.',
      rateLimit: this.lastRateLimit,
    }
  }

  async connect(): Promise<ConnectionResult> {
    const binary = this.resolveBinary()
    if (!binary) return { status: 'needs_install', message: 'Install Claude Code first.' }
    const status = await this.getStatus()
    if (status.authenticated) return { status: 'already_connected', message: status.message }
    return {
      status: 'login_required',
      loginCommand: [binary, 'auth', 'login'],
      message: 'Run the official Claude Code login. It opens the browser for your claude.ai account.',
    }
  }

  async logout(): Promise<void> {
    const binary = this.requireBinary()
    await runProcess(binary, ['auth', 'logout'], { timeoutMs: 30_000, env: this.childEnv() })
  }

  async diagnose(options: { liveCall?: boolean; cwd?: string } = {}): Promise<DiagnosticReport> {
    const checks: DiagnosticReport['checks'] = []
    const detection = await this.detect()
    checks.push({ name: 'CLI installed', ok: detection.installed, detail: detection.installed ? `${detection.binary} (${detection.version ?? 'unknown version'})` : 'claude not found' })
    if (detection.installed) {
      const status = await this.getStatus()
      checks.push({ name: 'Authenticated', ok: status.authenticated, detail: status.message })
      checks.push({
        name: 'Subscription billing',
        ok: !status.usesApiKeyBilling,
        detail: status.usesApiKeyBilling ? 'API-key billing is active; premium calls cost money per token.' : 'No API key is used by the app (API key variables are stripped).',
      })
      if (options.liveCall && status.authenticated) {
        try {
          const call = await this.callStructured('Reply with ok=true.', { schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }, tools: '' }, {
            runId: `diagnose-${Date.now()}`,
            cwd: options.cwd ?? os.tmpdir(),
            timeoutMs: 120_000,
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
    const call = await this.callStructured(analysisPrompt(input), { schema: ANALYSIS_SCHEMA, tools: '' }, ctx)
    return { result: normalizeAnalysis(call.structured), meta: call.meta }
  }

  async createPlan(input: PlanningInput, ctx: CallContext) {
    // Read-only tools let the planner verify a file when the digest is insufficient.
    const call = await this.callStructured(planningPrompt(input), { schema: PLAN_SCHEMA, tools: 'Read,Glob,Grep' }, ctx)
    return { result: normalizePlan(call.structured, input.maxTasks), meta: call.meta }
  }

  async reviewResult(input: ReviewInput, ctx: CallContext) {
    const call = await this.callStructured(reviewPrompt(input), { schema: REVIEW_SCHEMA, tools: 'Read,Glob,Grep' }, ctx)
    return { result: normalizeReview(call.structured), meta: call.meta }
  }

  async chat(input: ChatInput, ctx: CallContext) {
    const call = await this.callStructured(chatPrompt(input), { schema: CHAT_SCHEMA, tools: 'Read,Glob,Grep' }, ctx)
    const answer = (call.structured as { answer?: unknown })?.answer
    return { result: { answer: typeof answer === 'string' ? answer : call.text }, meta: call.meta }
  }

  async executeComplexTask(input: ExecutionInput, ctx: CallContext) {
    const call = await this.callStructured(
      executionPrompt(input),
      {
        schema: EXECUTION_SUMMARY_SCHEMA,
        tools: 'Read,Edit,Write,Glob,Grep',
        appendSystemPrompt: 'You are working inside an isolated git worktree managed by Multi-AI Coder. Shell access is disabled; the engine runs validation after you finish.',
        permissionMode: 'acceptEdits',
        persistSession: true,
        resumeSessionId: input.resumeSessionId,
      },
      ctx,
    )
    const data = (call.structured ?? {}) as { summary?: string; filesChanged?: string[] }
    return {
      result: {
        summary: typeof data.summary === 'string' ? data.summary : call.text,
        filesChanged: Array.isArray(data.filesChanged) ? data.filesChanged.filter((file): file is string => typeof file === 'string') : [],
        commandsRun: [],
        sessionId: call.meta.sessionId,
      },
      meta: call.meta,
    }
  }

  private async callStructured(prompt: string, options: ClaudeCallOptions, ctx: CallContext): Promise<ClaudeCallResult> {
    // System prompts go through files: multi-line arguments cannot be passed safely to .cmd shims.
    const promptDir = mkdtempSync(path.join(os.tmpdir(), 'mac-claude-'))
    try {
      return await this.callWithPromptDir(prompt, options, ctx, promptDir)
    } finally {
      rmSync(promptDir, { recursive: true, force: true })
    }
  }

  private async callWithPromptDir(prompt: string, options: ClaudeCallOptions, ctx: CallContext, promptDir: string): Promise<ClaudeCallResult> {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands']
    const systemFile = path.join(promptDir, 'system.md')
    if (options.appendSystemPrompt) {
      writeFileSync(systemFile, options.appendSystemPrompt, 'utf8')
      args.push('--append-system-prompt-file', systemFile)
    } else {
      writeFileSync(systemFile, options.systemPrompt ?? ORCHESTRATOR_SYSTEM_PROMPT, 'utf8')
      args.push('--system-prompt-file', systemFile)
    }
    args.push('--tools', options.tools)
    args.push('--json-schema', JSON.stringify(options.schema))
    args.push('--permission-mode', options.permissionMode ?? 'default')
    if (!options.persistSession) args.push('--no-session-persistence')
    if (options.resumeSessionId) args.push('--resume', options.resumeSessionId)
    if (this.options.model) args.push('--model', this.options.model)
    if (ctx.effort) args.push('--effort', ctx.effort)

    let sessionId: string | undefined
    let model: string | undefined
    let structured: unknown
    let finalResult: Record<string, unknown> | undefined
    const texts: string[] = []

    const processResult = await this.runJsonl(args, ctx, prompt, (event) => {
      const type = event.type
      if (type === 'system' && event.subtype === 'init') {
        sessionId = typeof event.session_id === 'string' ? event.session_id : sessionId
        model = typeof event.model === 'string' ? event.model : model
        if (sessionId) this.emit(ctx, { type: 'session', sessionId, model })
      } else if (type === 'assistant') {
        const content = ((event.message as { content?: unknown[] } | undefined)?.content ?? []) as Array<Record<string, unknown>>
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text)
            this.emit(ctx, { type: 'text', text: block.text })
          } else if (block.type === 'tool_use') {
            const name = String(block.name ?? 'tool')
            if (name === 'StructuredOutput') {
              structured = block.input
              continue
            }
            const toolInput = (block.input ?? {}) as Record<string, unknown>
            const target = String(toolInput.file_path ?? toolInput.path ?? toolInput.pattern ?? '')
            this.emit(ctx, { type: 'tool', name, detail: target })
            if ((name === 'Edit' || name === 'Write' || name === 'MultiEdit') && target) this.emit(ctx, { type: 'file_change', path: target, kind: name.toLowerCase() })
          }
        }
      } else if (type === 'rate_limit_event') {
        const info = (event.rate_limit_info ?? {}) as Record<string, unknown>
        this.lastRateLimit = {
          status: String(info.status ?? 'unknown'),
          window: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
          resetsAt: typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : undefined,
          observedAt: new Date().toISOString(),
        }
        this.emit(ctx, { type: 'rate_limit', info: this.lastRateLimit })
      } else if (type === 'result') {
        finalResult = event
        if (event.structured_output !== undefined) structured = event.structured_output
        sessionId = typeof event.session_id === 'string' ? event.session_id : sessionId
      }
    })

    if (!finalResult) {
      throw classifyCliFailure(`${processResult.stderr}\n${processResult.stdout.slice(-2000)}`, 'claude')
    }
    if (finalResult.is_error === true || (typeof finalResult.subtype === 'string' && finalResult.subtype !== 'success')) {
      const text = `${String(finalResult.subtype ?? '')} ${String(finalResult.result ?? '')} ${processResult.stderr}`
      if (this.lastRateLimit?.status === 'rejected') {
        throw new OrchestratorError(text.trim(), 'quota_exhausted', { retryable: false, resetsAt: this.lastRateLimit.resetsAt })
      }
      throw classifyCliFailure(text, 'claude')
    }

    const usageRaw = (finalResult.usage ?? {}) as Record<string, unknown>
    const cached = Number(usageRaw.cache_read_input_tokens ?? 0) + Number(usageRaw.cache_creation_input_tokens ?? 0)
    const usage: UsageReport = {
      inputTokens: Number(usageRaw.input_tokens ?? 0) + cached,
      outputTokens: Number(usageRaw.output_tokens ?? 0),
      cachedInputTokens: Number(usageRaw.cache_read_input_tokens ?? 0),
      measured: true,
      apiEquivalentUsd: typeof finalResult.total_cost_usd === 'number' ? finalResult.total_cost_usd : undefined,
      billing: this.options.authMode === 'api_key' ? 'api_key' : 'subscription',
    }
    this.emit(ctx, { type: 'usage', usage })

    const text = typeof finalResult.result === 'string' ? finalResult.result : texts.join('\n')
    if (structured === undefined) {
      try {
        structured = extractJson(text)
      } catch {
        throw new OrchestratorError('Claude Code returned no structured output.', 'invalid_output', { retryable: true })
      }
    }
    return {
      structured,
      text,
      meta: { sessionId, model, usage, durationMs: Number(finalResult.duration_ms ?? processResult.durationMs) },
    }
  }
}
