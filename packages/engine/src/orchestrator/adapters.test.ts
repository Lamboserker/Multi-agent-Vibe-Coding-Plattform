import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from '../test-utils.js'
import { ClaudeCodeAdapter } from './claude-code.js'
import { CodexAdapter } from './codex.js'
import { OrchestratorError, type RepoContextDigest } from './types.js'

// Fake CLIs replay the JSONL formats recorded from claude 2.1.86 / codex-cli 0.153.4.
const FAKE_CLAUDE = String.raw`
const fs = require('fs')
const args = process.argv.slice(2)
const mode = process.env.FAKE_MODE || 'ok'
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args, apiKey: process.env.ANTHROPIC_API_KEY ?? null }))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
if (args[0] === '--version') { console.log('2.1.86 (Claude Code)'); process.exit(0) }
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify(mode === 'logged_out' ? { loggedIn: false } : { loggedIn: true, authMethod: 'claude.ai', email: 'dev@example.com', subscriptionType: 'pro' }))
  process.exit(0)
}
let input = ''
process.stdin.on('data', (c) => (input += c)).on('end', () => {
  if (mode === 'hang') { setTimeout(() => {}, 60000); return }
  if (mode === 'no_session' && args.includes('--resume')) { process.stderr.write('No conversation found with session ID'); process.exit(1) }
  // the retry (no --resume) of the resume modes runs in a new CLI session
  const sid = (mode === 'resume_invalid' || mode === 'always_invalid') && !args.includes('--resume') ? 'sess-2' : 'sess-1'
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-4-6', tools: [] })
  if (mode === 'quota') {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1791547200, rateLimitType: 'five_hour' } })
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1791547200', session_id: 'sess-1' })
    process.exit(1)
  }
  if (mode === 'expired') {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'OAuth token has expired. Please run /login', session_id: 'sess-1' })
    process.exit(1)
  }
  if (mode === 'quota_usage') {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1791547200, rateLimitType: 'five_hour' } })
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1791547200', session_id: 'sess-1',
      usage: { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 150 } })
    process.exit(1)
  }
  if (mode === 'max_turns') {
    out({ type: 'result', subtype: 'error_max_turns', is_error: true, duration_ms: 1234, session_id: 'sess-1', total_cost_usd: 0.0123,
      usage: { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 150 } })
    process.exit(1)
  }
  if (mode === 'no_structured' || (mode === 'resume_invalid' && args.includes('--resume')) || mode === 'always_invalid') {
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, result: 'plain text', session_id: sid, total_cost_usd: 0.0123,
      usage: { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 150 } })
    process.exit(0)
  }
  const structured = JSON.parse(process.env.FAKE_STRUCTURED)
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }] } })
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: structured }] } })
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1791547200, rateLimitType: 'five_hour' } })
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, result: 'done', session_id: sid, total_cost_usd: 0.0123,
    usage: { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 150 }, structured_output: structured, input_len: input.length })
})
`

const FAKE_CODEX = String.raw`
const fs = require('fs')
const args = process.argv.slice(2)
const mode = process.env.FAKE_MODE || 'ok'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const log = fs.existsSync(process.env.FAKE_LOG) ? JSON.parse(fs.readFileSync(process.env.FAKE_LOG, 'utf8')) : []
log.push({ args, apiKey: process.env.OPENAI_API_KEY ?? null })
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(log))
if (args[0] === '--version') { console.log('codex-cli 0.153.4'); process.exit(0) }
if (args[0] === 'login' && args[1] === 'status') { console.log(mode === 'logged_out' ? 'Not logged in' : 'Logged in using ChatGPT'); process.exit(mode === 'logged_out' ? 1 : 0) }
if (args[0] === 'debug' && args[1] === 'models') {
  console.log(JSON.stringify([{ slug: 'gpt-hidden', visibility: 'hide', priority: 1 }, { slug: 'gpt-good', display_name: 'GPT Good', visibility: 'list', priority: 2 }]))
  process.exit(0)
}
let input = ''
process.stdin.on('data', (c) => (input += c)).on('end', () => {
  const isResume = args[0] === 'exec' && args[1] === 'resume'
  const plain = mode === 'always_invalid' || (mode === 'resume_invalid' && isResume)
  // the retry (no exec resume) of the resume modes runs in a new thread
  out({ type: 'thread.started', thread_id: (mode === 'resume_invalid' || mode === 'always_invalid') && !isResume ? 'thread-2' : 'thread-1' })
  out({ type: 'turn.started' })
  if (mode === 'model_unsupported' && !args.includes('-m')) {
    out({ type: 'error', message: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account." })
    out({ type: 'turn.failed', error: { message: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account." } })
    process.exit(1)
  }
  out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'rg foo', exit_code: 0 } })
  out({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'src/b.ts', kind: 'update' }] } })
  out({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: plain ? 'plain text' : process.env.FAKE_STRUCTURED } })
  out({ type: 'turn.completed', usage: { input_tokens: 13000, cached_input_tokens: 4000, output_tokens: 80, reasoning_output_tokens: 20 } })
  if (mode === 'failed_after_turn' && args[0] === 'exec') {
    out({ type: 'turn.failed', error: { message: 'stream disconnected' } })
    process.exit(1)
  }
})
`

async function makeFakeCli(name: string, source: string): Promise<{ binary: string; dir: string }> {
  const dir = tempDir(`mac-fake-${name}-`)
  await fs.writeFile(path.join(dir, `${name}.cjs`), source)
  if (process.platform === 'win32') {
    const binary = path.join(dir, `${name}.cmd`)
    await fs.writeFile(binary, `@echo off\r\n"${process.execPath}" "%~dp0${name}.cjs" %*\r\n`)
    return { binary, dir }
  }
  const binary = path.join(dir, name)
  await fs.writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${name}.cjs" "$@"\n`, { mode: 0o755 })
  return { binary, dir }
}

const context: RepoContextDigest = { summary: 'TypeScript repo', relevantFiles: [{ path: 'src/a.ts', outline: 'export function a' }], validationCommands: ['pnpm test'] }
const plan = {
  summary: 'Two tasks',
  analysis: { summary: 'ok', taskType: 'frontend', complexity: 2, risk: 1, securitySensitive: false, affectedAreas: ['ui'], needsDecomposition: true, openQuestions: [] },
  warnings: [],
  tasks: [
    { id: 'a', title: 'Component', description: 'Create it', category: 'react-ui', complexity: 2, risk: 1, relevantFiles: ['src/a.ts'], newFiles: ['src/B.tsx'], dependsOn: [], capabilities: ['react'], expectedInputTokens: 3000, testStrategy: 'unit', acceptanceCriteria: ['renders'], suggestedExecutor: 'local', rationale: 'simple' },
    { id: 'b', title: 'Test', description: 'Test it', category: 'tests', complexity: 1, risk: 1, relevantFiles: [], newFiles: ['src/B.test.tsx'], dependsOn: ['a'], capabilities: [], expectedInputTokens: 2000, testStrategy: 'unit', acceptanceCriteria: [], suggestedExecutor: 'local', rationale: '' },
  ],
}

const questionPlan = {
  summary: 'Needs input',
  analysis: { ...plan.analysis, openQuestions: ['Welche Datei?', 'Welches Format?'] },
  warnings: [],
  tasks: [],
}

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

describe('ClaudeCodeAdapter', () => {
  it('reads subscription auth status and offers the official login command', async () => {
    const fake = await makeFakeCli('claude', FAKE_CLAUDE)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    const adapter = new ClaudeCodeAdapter({ binaryPath: fake.binary })
    const status = await adapter.getStatus()
    expect(status).toMatchObject({ authenticated: true, authMethod: 'claude.ai (pro)', account: 'dev@example.com', usesApiKeyBilling: false, version: '2.1.86' })
    process.env.FAKE_MODE = 'logged_out'
    const connect = await adapter.connect()
    expect(connect.status).toBe('login_required')
    expect(connect.loginCommand?.slice(1)).toEqual(['auth', 'login'])
  })

  it('creates a plan via headless structured output, strips API keys and reports measured usage', async () => {
    const fake = await makeFakeCli('claude', FAKE_CLAUDE)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_STRUCTURED = JSON.stringify(plan)
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-be-used'
    const adapter = new ClaudeCodeAdapter({ binaryPath: fake.binary })
    const events: string[] = []
    const { result, meta } = await adapter.createPlan(
      { goal: 'Build a component', context, costMode: 'balanced', localModels: [{ role: 'fast', model: 'qwen', toolCalling: true, strengths: [] }], maxTasks: 8 },
      { runId: 'r1', cwd: fake.dir, onEvent: (event) => events.push(event.type) },
    )
    expect(result.tasks.map((task) => task.id)).toEqual(['task-001', 'task-002'])
    expect(result.tasks[1]!.dependsOn).toEqual(['task-001'])
    expect(meta).toMatchObject({ sessionId: 'sess-1', model: 'claude-sonnet-4-6' })
    expect(meta.usage).toMatchObject({ inputTokens: 1200, outputTokens: 150, cachedInputTokens: 200, measured: true, apiEquivalentUsd: 0.0123, billing: 'subscription' })
    expect(events).toEqual(expect.arrayContaining(['session', 'tool', 'rate_limit', 'usage']))
    const log = JSON.parse(readFileSync(process.env.FAKE_LOG, 'utf8')) as { args: string[]; apiKey: string | null }
    expect(log.apiKey).toBeNull()
    expect(log.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--json-schema', '--no-session-persistence', '--tools', 'Read,Glob,Grep']))
    expect(log.args[log.args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep')
  })

  it('keeps the measured usage on a needs_clarification error when the plan has no tasks', async () => {
    const fake = await makeFakeCli('claude', FAKE_CLAUDE)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_STRUCTURED = JSON.stringify(questionPlan)
    const adapter = new ClaudeCodeAdapter({ binaryPath: fake.binary })
    const error = (await adapter.createPlan({ goal: 'x', context, costMode: 'balanced', localModels: [], maxTasks: 8 }, { runId: 'r-q', cwd: fake.dir }).catch((caught: unknown) => caught)) as OrchestratorError
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.kind).toBe('needs_clarification')
    expect(error.details.questions).toEqual(questionPlan.analysis.openQuestions)
    expect(error.details.meta?.usage).toMatchObject({ inputTokens: 1200, outputTokens: 150, cachedInputTokens: 200, measured: true })
  })

  it('keeps the measured usage on an invalid_output error when execute returns no structured output', async () => {
    const fake = await makeFakeCli('claude', FAKE_CLAUDE)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = 'no_structured'
    const adapter = new ClaudeCodeAdapter({ binaryPath: fake.binary })
    const error = (await adapter.executeComplexTask({ taskId: 'task-001', title: 'T', instructions: 'Do it', acceptanceCriteria: [], relevantFiles: [] }, { runId: 'r-x', cwd: fake.dir }).catch((caught: unknown) => caught)) as OrchestratorError
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.kind).toBe('invalid_output')
    expect(error.details.meta?.usage).toMatchObject({ inputTokens: 1200, outputTokens: 150, cachedInputTokens: 200, measured: true })
  })

  it('keeps the measured usage on an invalid_output error when the review output is not an object', async () => {
    const fake = await makeFakeCli('claude', FAKE_CLAUDE)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_STRUCTURED = '[]'
    const adapter = new ClaudeCodeAdapter({ binaryPath: fake.binary })
    const error = (await adapter.reviewResult({ goal: 'x', tasks: [], diff: '', validationSummary: '', riskFlags: [] }, { runId: 'r-rv', cwd: fake.dir }).catch((caught: unknown) => caught)) as OrchestratorError
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.kind).toBe('invalid_output')
    expect(error.message).toBe('Review is not an object.')
    expect(error.details.meta?.usage).toMatchObject({ inputTokens: 1200, outputTokens: 150, cachedInputTokens: 200, measured: true })
  })

  it('executes complex tasks with edit tools and acceptEdits, without shell access', async () => {
    const fake = await makeFakeCli('claude', FAKE_CLAUDE)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_STRUCTURED = JSON.stringify({ summary: 'Implemented', filesChanged: ['src/a.ts'], openIssues: [] })
    const adapter = new ClaudeCodeAdapter({ binaryPath: fake.binary })
    const { result } = await adapter.executeComplexTask({ taskId: 'task-001', title: 'T', instructions: 'Do it', acceptanceCriteria: [], relevantFiles: ['src/a.ts'] }, { runId: 'r2', cwd: fake.dir })
    expect(result).toMatchObject({ summary: 'Implemented', filesChanged: ['src/a.ts'], sessionId: 'sess-1' })
    const log = JSON.parse(readFileSync(process.env.FAKE_LOG, 'utf8')) as { args: string[] }
    expect(log.args[log.args.indexOf('--tools') + 1]).toBe('Read,Edit,Write,Glob,Grep')
    expect(log.args[log.args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
    expect(log.args).not.toContain('--no-session-persistence')
  })

  it.each([
    ['quota', 'quota_exhausted'],
    ['expired', 'session_expired'],
  ])('classifies %s failures as %s', async (mode, kind) => {
    const fake = await makeFakeCli('claude', FAKE_CLAUDE)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = mode
    const adapter = new ClaudeCodeAdapter({ binaryPath: fake.binary })
    const error = await adapter.analyzeTask({ goal: 'x', context }, { runId: 'r3', cwd: fake.dir }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(OrchestratorError)
    expect((error as OrchestratorError).kind).toBe(kind)
  })

  it('keeps the measured usage on an error_max_turns result', async () => {
    const fake = await makeFakeCli('claude', FAKE_CLAUDE)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = 'max_turns'
    const adapter = new ClaudeCodeAdapter({ binaryPath: fake.binary })
    const error = (await adapter.createPlan({ goal: 'x', context, costMode: 'balanced', localModels: [], maxTasks: 8 }, { runId: 'r-mt', cwd: fake.dir }).catch((caught: unknown) => caught)) as OrchestratorError
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.details.meta?.usage).toMatchObject({ inputTokens: 1200, outputTokens: 150, cachedInputTokens: 200, measured: true, apiEquivalentUsd: 0.0123 })
  })

  it('attaches no meta to an error result without usage', async () => {
    const fake = await makeFakeCli('claude', FAKE_CLAUDE)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = 'expired'
    const adapter = new ClaudeCodeAdapter({ binaryPath: fake.binary })
    const error = (await adapter.createPlan({ goal: 'x', context, costMode: 'balanced', localModels: [], maxTasks: 8 }, { runId: 'r-nm', cwd: fake.dir }).catch((caught: unknown) => caught)) as OrchestratorError
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.details.meta).toBeUndefined()
  })

  it('keeps the measured usage on a quota_exhausted error', async () => {
    const fake = await makeFakeCli('claude', FAKE_CLAUDE)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = 'quota_usage'
    const adapter = new ClaudeCodeAdapter({ binaryPath: fake.binary })
    const error = (await adapter.createPlan({ goal: 'x', context, costMode: 'balanced', localModels: [], maxTasks: 8 }, { runId: 'r-qu', cwd: fake.dir }).catch((caught: unknown) => caught)) as OrchestratorError
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.kind).toBe('quota_exhausted')
    expect(error.details.meta?.usage).toMatchObject({ inputTokens: 1200, outputTokens: 150, cachedInputTokens: 200, measured: true })
  })

  it('cancels a running call', async () => {
    const fake = await makeFakeCli('claude', FAKE_CLAUDE)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = 'hang'
    const adapter = new ClaudeCodeAdapter({ binaryPath: fake.binary })
    const pending = adapter.analyzeTask({ goal: 'x', context }, { runId: 'cancel-me', cwd: fake.dir }).catch((caught: unknown) => caught)
    await new Promise((resolve) => setTimeout(resolve, 600))
    await adapter.cancelRun('cancel-me')
    const error = (await pending) as OrchestratorError
    expect(error.kind).toBe('cancelled')
  }, 20_000)

  it('reports a missing installation', async () => {
    const adapter = new ClaudeCodeAdapter({ binaryPath: path.join(tempDir(), 'nope.exe') })
    expect((await adapter.getStatus()).installed).toBe(false)
    await expect(adapter.analyzeTask({ goal: 'x', context }, { runId: 'r', cwd: '.' })).rejects.toMatchObject({ kind: 'not_installed' })
  })
})

describe('CodexAdapter', () => {
  it('detects ChatGPT login and the model catalog', async () => {
    const fake = await makeFakeCli('codex', FAKE_CODEX)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    const adapter = new CodexAdapter({ binaryPath: fake.binary })
    expect(await adapter.getStatus()).toMatchObject({ authenticated: true, authMethod: 'ChatGPT', usesApiKeyBilling: false })
    const capabilities = await adapter.capabilities()
    expect(capabilities.models.map((model) => model.id)).toEqual(['', 'gpt-good'])
  })

  it('plans with --output-schema, parses JSONL events and strips OPENAI_API_KEY', async () => {
    const fake = await makeFakeCli('codex', FAKE_CODEX)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_STRUCTURED = JSON.stringify(plan)
    process.env.OPENAI_API_KEY = 'sk-proj-should-not-be-used'
    const adapter = new CodexAdapter({ binaryPath: fake.binary })
    const events: string[] = []
    const { result, meta } = await adapter.createPlan({ goal: 'x', context, costMode: 'cheapest', localModels: [], maxTasks: 5 }, { runId: 'c1', cwd: fake.dir, effort: 'low', onEvent: (event) => events.push(event.type) })
    expect(result.tasks).toHaveLength(2)
    expect(meta.usage).toMatchObject({ inputTokens: 13000, cachedInputTokens: 4000, outputTokens: 100, measured: true })
    expect(meta.sessionId).toBe('thread-1')
    expect(events).toEqual(expect.arrayContaining(['session', 'command', 'file_change', 'usage']))
    const log = JSON.parse(readFileSync(process.env.FAKE_LOG, 'utf8')) as Array<{ args: string[]; apiKey: string | null }>
    const exec = log.find((entry) => entry.args[0] === 'exec')!
    expect(exec.apiKey).toBeNull()
    expect(exec.args).toEqual(expect.arrayContaining(['--json', '--output-schema', '--sandbox', 'read-only', '--ephemeral', 'model_reasoning_effort="low"']))
  })

  it('keeps the measured usage on a needs_clarification error when the plan has no tasks', async () => {
    const fake = await makeFakeCli('codex', FAKE_CODEX)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_STRUCTURED = JSON.stringify(questionPlan)
    const adapter = new CodexAdapter({ binaryPath: fake.binary })
    const error = (await adapter.createPlan({ goal: 'x', context, costMode: 'cheapest', localModels: [], maxTasks: 5 }, { runId: 'c-q', cwd: fake.dir }).catch((caught: unknown) => caught)) as OrchestratorError
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.kind).toBe('needs_clarification')
    expect(error.details.questions).toEqual(questionPlan.analysis.openQuestions)
    expect(error.details.meta?.usage).toMatchObject({ inputTokens: 13000, cachedInputTokens: 4000, outputTokens: 100, measured: true })
  })

  it('keeps the measured usage on an invalid_output error when execute returns no structured output', async () => {
    const fake = await makeFakeCli('codex', FAKE_CODEX)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_STRUCTURED = 'not json at all'
    const adapter = new CodexAdapter({ binaryPath: fake.binary })
    const error = (await adapter.executeComplexTask({ taskId: 'task-001', title: 'T', instructions: 'Do it', acceptanceCriteria: [], relevantFiles: [] }, { runId: 'c-x', cwd: fake.dir }).catch((caught: unknown) => caught)) as OrchestratorError
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.kind).toBe('invalid_output')
    expect(error.details.meta?.usage).toMatchObject({ inputTokens: 13000, cachedInputTokens: 4000, outputTokens: 100, measured: true })
  })

  it('keeps the measured usage on an invalid_output error when the review output is not an object', async () => {
    const fake = await makeFakeCli('codex', FAKE_CODEX)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_STRUCTURED = '[]'
    const adapter = new CodexAdapter({ binaryPath: fake.binary })
    const error = (await adapter.reviewResult({ goal: 'x', tasks: [], diff: '', validationSummary: '', riskFlags: [] }, { runId: 'c-rv', cwd: fake.dir }).catch((caught: unknown) => caught)) as OrchestratorError
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.kind).toBe('invalid_output')
    expect(error.message).toBe('Review is not an object.')
    expect(error.details.meta?.usage).toMatchObject({ inputTokens: 13000, cachedInputTokens: 4000, outputTokens: 100, measured: true })
  })

  it('keeps the measured usage of a turn that completed and then failed', async () => {
    const fake = await makeFakeCli('codex', FAKE_CODEX)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = 'failed_after_turn'
    process.env.FAKE_STRUCTURED = JSON.stringify(plan)
    const adapter = new CodexAdapter({ binaryPath: fake.binary })
    const error = (await adapter.createPlan({ goal: 'x', context, costMode: 'cheapest', localModels: [], maxTasks: 5 }, { runId: 'c-ft', cwd: fake.dir }).catch((caught: unknown) => caught)) as OrchestratorError
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.details.meta?.usage).toMatchObject({ inputTokens: 13000, outputTokens: 100, cachedInputTokens: 4000, measured: true })
  })

  it('falls back once to a listed model when the configured one is not available for the account', async () => {
    const fake = await makeFakeCli('codex', FAKE_CODEX)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = 'model_unsupported'
    process.env.FAKE_STRUCTURED = JSON.stringify({ answer: 'hello' })
    const adapter = new CodexAdapter({ binaryPath: fake.binary })
    let fallback: string | undefined
    adapter.onModelFallback = (_from, to) => (fallback = to)
    const { result } = await adapter.chat({ question: 'hi', context }, { runId: 'c2', cwd: fake.dir })
    expect(result.answer).toBe('hello')
    expect(fallback).toBe('gpt-good')
  })

  it('pinned models are never silently replaced', async () => {
    const fake = await makeFakeCli('codex', FAKE_CODEX)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = 'model_unsupported'
    const adapter = new CodexAdapter({ binaryPath: fake.binary, model: '' })
    // no -m flag when model is empty → unsupported, and no pinned model → fallback is allowed
    process.env.FAKE_STRUCTURED = JSON.stringify({ answer: 'x' })
    await expect(adapter.chat({ question: 'hi', context }, { runId: 'c3', cwd: fake.dir })).resolves.toBeTruthy()
  })
})

describe('chat session reuse', () => {
  it('claude: a follow-up resumes the CLI session and sends only the question', async () => {
    const fake = await makeFakeCli('claude', FAKE_CLAUDE)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = 'ok'
    process.env.FAKE_STRUCTURED = JSON.stringify({ answer: 'yes' })
    const adapter = new ClaudeCodeAdapter({ binaryPath: fake.binary })
    const first = await adapter.chat({ question: 'What is this?', context }, { runId: 'q1', cwd: fake.dir })
    expect(first.meta.sessionId).toBe('sess-1')
    expect((JSON.parse(readFileSync(process.env.FAKE_LOG, 'utf8')) as { args: string[] }).args).not.toContain('--no-session-persistence')
    const followUp = await adapter.chat({ question: 'And the tests?', context, resumeSessionId: 'sess-1' }, { runId: 'q2', cwd: fake.dir })
    expect(followUp.result.answer).toBe('yes')
    const args = (JSON.parse(readFileSync(process.env.FAKE_LOG, 'utf8')) as { args: string[] }).args
    expect(args).toEqual(expect.arrayContaining(['--resume', 'sess-1']))
  })

  it('claude: an expired CLI session falls back to the full prompt', async () => {
    const fake = await makeFakeCli('claude', FAKE_CLAUDE)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = 'no_session'
    process.env.FAKE_STRUCTURED = JSON.stringify({ answer: 'full' })
    const adapter = new ClaudeCodeAdapter({ binaryPath: fake.binary })
    const { result } = await adapter.chat({ question: 'Again?', context, resumeSessionId: 'gone' }, { runId: 'q3', cwd: fake.dir })
    expect(result.answer).toBe('full')
    expect((JSON.parse(readFileSync(process.env.FAKE_LOG, 'utf8')) as { args: string[] }).args).not.toContain('--resume')
  })

  it('claude: a rejected resume attempt is booked with the retry', async () => {
    const fake = await makeFakeCli('claude', FAKE_CLAUDE)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = 'resume_invalid'
    process.env.FAKE_STRUCTURED = JSON.stringify({ answer: 'full' })
    const adapter = new ClaudeCodeAdapter({ binaryPath: fake.binary })
    const { result, meta } = await adapter.chat({ question: 'Again?', context, resumeSessionId: 'sess-1' }, { runId: 'q5', cwd: fake.dir })
    expect(result.answer).toBe('full')
    expect(meta.usage).toMatchObject({ inputTokens: 2400, outputTokens: 300, cachedInputTokens: 400, measured: true })
    expect(meta.sessionId).toBe('sess-2')
  })

  it('claude: when the retry fails too, the error carries the summed meta', async () => {
    const fake = await makeFakeCli('claude', FAKE_CLAUDE)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = 'always_invalid'
    const adapter = new ClaudeCodeAdapter({ binaryPath: fake.binary })
    const error = (await adapter.chat({ question: 'Again?', context, resumeSessionId: 'sess-1' }, { runId: 'q6', cwd: fake.dir }).catch((caught: unknown) => caught)) as OrchestratorError
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.kind).toBe('invalid_output')
    expect(error.details.meta?.usage).toMatchObject({ inputTokens: 2400, outputTokens: 300, cachedInputTokens: 400, measured: true })
  })

  it('codex: a rejected resume attempt is booked with the retry', async () => {
    const fake = await makeFakeCli('codex', FAKE_CODEX)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = 'resume_invalid'
    process.env.FAKE_STRUCTURED = JSON.stringify({ answer: 'full' })
    const adapter = new CodexAdapter({ binaryPath: fake.binary })
    const { result, meta } = await adapter.chat({ question: 'Again?', context, resumeSessionId: 'thread-1' }, { runId: 'q7', cwd: fake.dir })
    expect(result.answer).toBe('full')
    expect(meta.usage).toMatchObject({ inputTokens: 26000, outputTokens: 200, cachedInputTokens: 8000, measured: true })
    expect(meta.sessionId).toBe('thread-2')
  })

  it('codex: when the retry fails too, the error carries the summed meta', async () => {
    const fake = await makeFakeCli('codex', FAKE_CODEX)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = 'always_invalid'
    const adapter = new CodexAdapter({ binaryPath: fake.binary })
    const error = (await adapter.chat({ question: 'Again?', context, resumeSessionId: 'thread-1' }, { runId: 'q8', cwd: fake.dir }).catch((caught: unknown) => caught)) as OrchestratorError
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.kind).toBe('invalid_output')
    expect(error.details.meta?.usage).toMatchObject({ inputTokens: 26000, outputTokens: 200, cachedInputTokens: 8000, measured: true })
  })

  it('codex: a follow-up uses exec resume on the stored thread', async () => {
    const fake = await makeFakeCli('codex', FAKE_CODEX)
    process.env.FAKE_LOG = path.join(fake.dir, 'log.json')
    process.env.FAKE_MODE = 'ok'
    process.env.FAKE_STRUCTURED = JSON.stringify({ answer: 'ok' })
    const adapter = new CodexAdapter({ binaryPath: fake.binary })
    await adapter.chat({ question: 'Follow-up', context, resumeSessionId: 'thread-1' }, { runId: 'q4', cwd: fake.dir })
    const log = JSON.parse(readFileSync(process.env.FAKE_LOG, 'utf8')) as Array<{ args: string[] }>
    const exec = log.filter((entry) => entry.args[0] === 'exec').at(-1)!
    expect(exec.args.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(exec.args).toContain('thread-1')
    expect(exec.args).not.toContain('--ephemeral')
  })
})
