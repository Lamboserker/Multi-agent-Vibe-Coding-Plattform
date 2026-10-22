import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { currentBranch, git, headCommit, status } from '../git/git.js'
import { WorktreeManager } from '../git/worktrees.js'
import { buildRepoIndex } from '../index/repo-index.js'
import { applyChangeSet, revertChangeSet } from '../integration/integrator.js'
import { OllamaClient } from '../ollama/client.js'
import { startFakeOllama, type FakeChatReply, type FakeChatRequest, type FakeOllama } from '../testing/fake-ollama.js'
import { OrchestratorError } from '../orchestrator/types.js'
import { DuoOrchestrator } from '../orchestrator/duo.js'
import { createTempRepo, tempDir } from '../test-utils.js'
import { detectValidationChecks } from '../validation/checks.js'
import {
  DEFAULT_ENGINE_SETTINGS,
  ExecutionRunner,
  hollowChange,
  type AttemptFinish,
  type AttemptStart,
  type EngineEvent,
  type EngineStore,
  type EngineTask,
  type LocalModelRuntime,
  type ModelCallRecord,
} from './execution.js'

class MemoryStore implements EngineStore {
  runs: Record<string, unknown>[] = []
  tasks = new Map<string, Record<string, unknown>>()
  attempts: Array<AttemptStart & Partial<AttemptFinish> & { id: string }> = []
  calls: ModelCallRecord[] = []
  events: EngineEvent[] = []
  async updateRun(_id: string, patch: Record<string, unknown>) {
    this.runs.push(patch)
  }
  async updateTask(id: string, patch: Record<string, unknown>) {
    this.tasks.set(id, { ...(this.tasks.get(id) ?? {}), ...patch })
  }
  async startAttempt(input: AttemptStart) {
    const id = `att-${this.attempts.length + 1}`
    this.attempts.push({ ...input, id })
    return id
  }
  async finishAttempt(id: string, input: AttemptFinish) {
    Object.assign(this.attempts.find((attempt) => attempt.id === id)!, input)
  }
  async recordModelCall(call: ModelCallRecord) {
    this.calls.push(call)
  }
  emit(event: EngineEvent) {
    this.events.push(event)
  }
  lastRun() {
    return Object.assign({}, ...this.runs) as Record<string, unknown>
  }
}

const REPO_FILES = {
  'package.json': JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/math.js': 'export const add = (a, b) => a + b\n',
  'src/index.js': "export { add } from './math.js'\n",
  'test/math.test.js': "import test from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/math.js'\ntest('add', () => assert.equal(add(1, 2), 3))\n",
}

const GREET = 'export const greet = (name) => `Hello ${name}`\n'
const GREET_TEST = "import test from 'node:test'\nimport assert from 'node:assert'\nimport { greet } from '../src/greet.js'\ntest('greet', () => assert.equal(greet('Ada'), 'Hello Ada'))\n"

function task(key: string, overrides: Partial<EngineTask> = {}): EngineTask {
  return {
    id: `db-${key}`,
    key,
    title: key,
    description: `Implement ${key}`,
    category: 'general',
    complexity: 2,
    risk: 1,
    relevantFiles: [],
    newFiles: [],
    dependsOn: [],
    acceptanceCriteria: [],
    expectedInputTokens: 2000,
    suggestedExecutor: 'local',
    priority: 0,
    status: 'planned',
    ...overrides,
  }
}

const write = (file: string, content: string): FakeChatReply => ({ toolCalls: [{ name: 'write_file', arguments: { path: file, content } }] })
const finish: FakeChatReply = { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] }
const taskKeyOf = (request: FakeChatRequest) => request.messages.find((message) => message.role === 'user')?.content.match(/# Task (task-\d+)/)?.[1]
const toolResults = (request: FakeChatRequest) => request.messages.filter((message) => message.role === 'tool').length

let fake: FakeOllama | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

async function setup(chat: (request: FakeChatRequest) => FakeChatReply, models: LocalModelRuntime[] = [{ model: 'fake-coder:1b', roles: ['fast', 'balanced', 'advanced'], toolCalling: true, contextWindow: 32768, available: true }]) {
  const repo = await createTempRepo(REPO_FILES)
  fake = await startFakeOllama({ models: models.map((model) => ({ name: model.model, size: 1e9, capabilities: ['tools'] })), chat })
  const store = new MemoryStore()
  const worktrees = new WorktreeManager({ root: tempDir('mac-engine-wt-') })
  const deps = {
    store,
    worktrees,
    ollama: new OllamaClient(fake.url),
    localModels: models,
    checks: detectValidationChecks(repo),
    index: await buildRepoIndex(repo),
    stats: [],
    // These scenarios specifically exercise tool round-trips. Auto mode is covered below.
    settings: { ...DEFAULT_ENGINE_SETTINGS, premiumReviewPolicy: 'never' as const, localSlots: 1, localExecutionMode: 'tools' as 'auto' | 'tools' },
  }
  return { repo, store, worktrees, deps }
}

describe('ExecutionRunner (real git, real validation, scripted model)', () => {
  it('does not call a model when required agent instructions cannot be loaded', async () => {
    const { repo, deps } = await setup(() => write('src/greet.js', GREET))
    const outcome = await new ExecutionRunner({ id: 'run-missing-instructions', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [task('task-001', { newFiles: ['src/greet.js'] })], {
      ...deps, agentResources: async () => { throw new Error('Required skill unavailable') },
    }).execute()
    expect(outcome.status).toBe('failed')
    expect(fake!.requests).toHaveLength(0)
    expect(existsSync(path.join(repo, 'src/greet.js'))).toBe(false)
  }, 60_000)

  it('asks for inline skills (supportsTools false) when the agent has no external tools, even for a tool-calling model', async () => {
    const { repo, deps } = await setup(request => (toolResults(request) ? finish : write('src/greet.js', GREET)))
    const seen: boolean[] = []
    const agentResources = async (input: { supportsTools: boolean }) => { seen.push(input.supportsTools); return { tools: [] } }
    const agent = { id: 'a', name: 'NoTools', escalation: 'none' as const, permissions: { externalTools: false } }
    await new ExecutionRunner({ id: 'run-no-external-tools', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [task('task-001', { newFiles: ['src/greet.js'], agent })], { ...deps, agentResources }).execute()
    expect(seen).toEqual([false])
    await fake?.close()
    const { repo: repo2, deps: deps2 } = await setup(request => (toolResults(request) ? finish : write('src/greet.js', GREET)))
    seen.length = 0
    await new ExecutionRunner({ id: 'run-external-tools', projectKey: 'demo', repoPath: repo2, goal: 'Add greet' }, [task('task-001', { newFiles: ['src/greet.js'] })], { ...deps2, agentResources }).execute()
    expect(seen).toEqual([true])
  }, 60_000)

  it('never integrates an unfinished partial change even if existing tests would pass', async () => {
    const { repo, deps, store } = await setup(() => write('src/greet.js', GREET))
    deps.settings.maxLocalRepairs = 0
    deps.settings.maxEscalationSteps = 0
    const outcome = await new ExecutionRunner({ id: 'run-incomplete', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [task('task-001', {
      newFiles: ['src/greet.js'], agent: { id: 'bounded', name: 'Bounded', escalation: 'none', maxSteps: 1 },
    })], deps).execute()
    expect(outcome.status).toBe('failed')
    expect(store.attempts[0]).toMatchObject({ outcome: 'error', patchStatus: 'incomplete' })
    expect(existsSync(path.join(repo, 'src/greet.js'))).toBe(false)
    expect(store.events.some(event => event.type === 'task_integrated')).toBe(false)
  }, 60_000)

  it('falls back to tools after a model cannot return structured operations', async () => {
    const { repo, deps, store } = await setup(request => {
      if (request.format) return { content: 'invalid json' }
      return toolResults(request) ? finish : write('src/greet.js', GREET)
    })
    deps.settings.localExecutionMode = 'auto'
    const outcome = await new ExecutionRunner({ id: 'run-auto-fallback', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [task('task-001', { newFiles: ['src/greet.js'] })], deps).execute()
    expect(outcome.status).toBe('awaiting_approval')
    expect(store.attempts.map(attempt => attempt.outcome)).toEqual(['error', 'success'])
    expect(fake!.requests.map(request => Boolean(request.format))).toEqual([true, true, false, false])
    expect(store.events.some(event => event.type === 'structured_fallback')).toBe(true)
  }, 60_000)

  it('uses current files and bounded structured output to repair a failed validation', async () => {
    let calls = 0
    const { repo, deps, store } = await setup(request => {
      expect(request.format).toBeDefined()
      if (calls++ === 0) return { content: JSON.stringify({ summary: 'Changed add', operations: [{ action: 'write', path: 'src/math.js', content: 'export const add = (a, b) => a - b\n' }] }) }
      expect(request.messages[1]!.content).toContain('previous attempt failed validation')
      expect(request.messages[1]!.content).toContain('a - b')
      return { content: JSON.stringify({ summary: 'Repaired add', operations: [{ action: 'write', path: 'src/math.js', content: 'export const add = (a, b) => Number(a) + Number(b)\n' }] }) }
    })
    deps.settings.localExecutionMode = 'auto'
    const outcome = await new ExecutionRunner({ id: 'run-auto-repair', projectKey: 'demo', repoPath: repo, goal: 'Fix add' }, [task('task-001', { relevantFiles: ['src/math.js'] })], deps).execute()
    expect(outcome.status).toBe('awaiting_approval')
    expect(store.attempts.map(attempt => attempt.outcome)).toEqual(['validation_failed', 'success'])
    expect(outcome.finalValidation?.ok).toBe(true)
    expect(fake!.requests.map(request => Boolean(request.format))).toEqual([true, true])
  }, 60_000)
  it('fails the run when task checks pass but the final integration check fails', async () => {
    const { repo, deps, store } = await setup(request => toolResults(request) ? finish : write('src/greet.js', GREET))
    let validations = 0
    deps.checks = [{ id: 'integration-check', kind: 'test', command: 'plugin check', blocking: true, timeoutMs: 5000, source: 'test', execute: async () => { validations += 1; const red = validations === 2 /* only the final check fails; the baseline run (3rd) is green */; return { passed: red ? 0 : 1, failed: red ? 1 : 0, output: 'integration check' } } }]
    const runner = new ExecutionRunner({ id: 'run-final-failure', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [task('task-001', { newFiles: ['src/greet.js'] })], deps)
    const outcome = await runner.execute()
    expect(store.attempts[0]?.outcome).toBe('success')
    expect(outcome.status).toBe('failed')
    expect(outcome.finalValidation?.ok).toBe(false)
    expect(store.lastRun().errorMessage).toContain('Final validation failed')
  }, 60_000)
  it('does not fail a task for a blocking check that already fails on the base commit', async () => {
    const { repo, deps, store } = await setup(request => toolResults(request) ? finish : write('src/greet.js', GREET))
    deps.checks = [{ id: 'e2e', kind: 'test', command: 'plugin check', blocking: true, timeoutMs: 5000, source: 'test', execute: async () => ({ passed: 0, failed: 3, output: 'Running 3 tests using 2 workers\n  3 failed' }) }]
    const outcome = await new ExecutionRunner({ id: 'run-baseline-red', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [task('task-001', { newFiles: ['src/greet.js'] })], deps).execute()
    expect(outcome.status).toBe('awaiting_approval')
    expect(outcome.integratedTasks).toEqual(['task-001'])
    expect(outcome.finalValidation?.ok).toBe(true)
    expect(store.events.some(event => event.type === 'baseline_failing')).toBe(true)
  }, 60_000)
  it('still fails a task when a check passes on the base commit but fails after the change', async () => {
    const { repo, deps, store } = await setup(request => toolResults(request) ? finish : write('src/greet.js', GREET))
    deps.settings.maxLocalRepairs = 0
    deps.settings.maxEscalationSteps = 0
    deps.checks = [{ id: 'e2e', kind: 'test', command: 'plugin check', blocking: true, timeoutMs: 5000, source: 'test', execute: async (cwd: string) => {
      const broken = existsSync(path.join(cwd, 'src/greet.js'))
      return { passed: broken ? 0 : 1, failed: broken ? 3 : 0, output: broken ? 'Running 3 tests using 2 workers\n  3 failed' : 'ok' }
    } }]
    const outcome = await new ExecutionRunner({ id: 'run-baseline-green', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [task('task-001', { newFiles: ['src/greet.js'] })], deps).execute()
    expect(outcome.status).toBe('failed')
    expect(store.events.some(event => event.type === 'task_integrated')).toBe(false)
    expect(store.events.some(event => event.type === 'baseline_failing')).toBe(false)
  }, 60_000)
  it('uses one structured edit for a small fully supplied task and validates it twice', async () => {
    const { repo, deps, store } = await setup(request => {
      expect(request.format).toBeDefined()
      return { content: JSON.stringify({ summary: 'Added subtract', operations: [{ action: 'edit', path: 'src/math.js', search: 'export const add = (a, b) => a + b', replace: 'export const add = (a, b) => a + b\nexport const subtract = (a, b) => a - b' }] }) }
    })
    deps.settings.localExecutionMode = 'auto'
    const runner = new ExecutionRunner({ id: 'run-auto-structure', projectKey: 'demo', repoPath: repo, goal: 'Add subtract' }, [task('task-001', { relevantFiles: ['src/math.js'] })], deps)
    const outcome = await runner.execute()
    expect(outcome.status).toBe('awaiting_approval')
    expect(store.attempts[0]?.validation?.ok).toBe(true)
    expect(outcome.finalValidation?.ok).toBe(true)
    expect(fake!.requests).toHaveLength(1)
    expect(store.attempts[0]?.logs[0]).toContain('structured mode')
  }, 60_000)
  it('runs dependent tasks in isolated worktrees, integrates them and applies with undo', async () => {
    const { repo, store, deps } = await setup((request) => {
      const key = taskKeyOf(request)
      const step = toolResults(request)
      if (key === 'task-001') return [write('src/greet.js', GREET), write('test/greet.test.js', GREET_TEST), finish][step] ?? finish
      // task-002 depends on task-001 and must see src/greet.js in its worktree
      if (step === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'src/greet.js' } }] }
      if (step === 1) return { toolCalls: [{ name: 'edit_file', arguments: { path: 'src/index.js', search: "export { add } from './math.js'", replace: "export { add } from './math.js'\nexport { greet } from './greet.js'" } }] }
      return finish
    })
    const tasks = [
      task('task-001', { newFiles: ['src/greet.js', 'test/greet.test.js'] }),
      task('task-002', { relevantFiles: ['src/index.js'], dependsOn: ['task-001'] }),
    ]
    const runner = new ExecutionRunner({ id: 'run-happy-path-0001', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, tasks, deps)
    const outcome = await runner.execute()

    expect(outcome.status).toBe('awaiting_approval')
    expect(outcome.integratedTasks).toEqual(['task-001', 'task-002'])
    expect(outcome.finalValidation?.ok).toBe(true)
    expect(outcome.finalValidation?.testsPassed).toBe(2)
    expect(outcome.diff).toContain('src/greet.js')
    expect(outcome.diff).toContain("export { greet } from './greet.js'")
    // task-002 read the file created by task-001 (dependency results are visible)
    const readResult = fake!.requests.find((request) => taskKeyOf(request) === 'task-002' && toolResults(request) === 1)!
    expect(readResult.messages.at(-1)!.content).toContain('Hello')
    // every attempt was validated and recorded with measured local tokens
    expect(store.attempts.map((attempt) => attempt.outcome)).toEqual(['success', 'success'])
    expect(store.calls.every((call) => call.kind === 'local' && call.usage.measured)).toBe(true)
    // the user's checkout is untouched until approval
    expect(existsSync(path.join(repo, 'src', 'greet.js'))).toBe(false)
    expect(await currentBranch(repo)).toBe('main')

    const run = store.lastRun()
    const applied = await applyChangeSet({ repoPath: repo, integrationWorktree: run.integrationWorktree as string, integrationBranch: run.integrationBranch as string, baseCommit: run.baseCommit as string, mode: 'working_tree' })
    expect(applied.ok).toBe(true)
    expect(await fs.readFile(path.join(repo, 'src', 'greet.js'), 'utf8')).toContain('Hello')
    const undo = await revertChangeSet({ repoPath: repo, mode: 'working_tree', patch: applied.patch!, files: applied.files })
    expect(undo.ok).toBe(true)
    expect(existsSync(path.join(repo, 'src', 'greet.js'))).toBe(false)
    // No content difference remains. (With core.autocrlf=true, git may rewrite LF files written by
    // this test as CRLF; real checkouts are already CRLF, so only content equality is asserted.)
    expect((await git(repo, ['diff', '--ignore-cr-at-eol', '--stat'])).stdout.trim()).toBe('')
    expect((await status(repo)).filter((entry) => entry.untracked)).toEqual([])
  }, 60_000)

  it('repairs a failing attempt with the validation output, then succeeds', async () => {
    let round = 0
    const { store, deps, repo } = await setup((request) => {
      const step = toolResults(request)
      if (step === 0 && request.messages.length === 2) round += 1
      if (round === 1) return [write('src/greet.js', 'export const greet = (name) => `Hi ${name}`\n'), write('test/greet.test.js', GREET_TEST), finish][step] ?? finish
      // repair round: the prompt must contain the failing test output
      expect(request.messages[1]!.content).toContain('previous attempt failed validation')
      // the model sees its own previous (failing) version of the new file
      expect(request.messages[1]!.content).toContain('Hi ${name}')
      return [write('src/greet.js', GREET), finish][step] ?? finish
    })
    const runner = new ExecutionRunner({ id: 'run-repair-0002', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [task('task-001', { newFiles: ['src/greet.js', 'test/greet.test.js'] })], deps)
    const outcome = await runner.execute()
    expect(outcome.status).toBe('awaiting_approval')
    expect(store.attempts.map((attempt) => [attempt.outcome, attempt.repairRound])).toEqual([['validation_failed', 0], ['success', 1]])
    expect(store.events.some((event) => event.type === 'validation_failed')).toBe(true)
  }, 60_000)

  it('rejects unsafe/broken patches and escalates to a stronger local model', async () => {
    const models: LocalModelRuntime[] = [
      { model: 'small:1b', roles: ['fast'], toolCalling: true, contextWindow: 32768, available: true },
      { model: 'big:7b', roles: ['balanced'], toolCalling: true, contextWindow: 32768, available: true },
    ]
    const { store, deps, repo } = await setup((request) => {
      const step = toolResults(request)
      if (request.model === 'small:1b') return [write('src/greet.js', 'export const greet = (name => {\n'), finish][step] ?? finish
      return [write('src/greet.js', GREET), finish][step] ?? finish
    }, models)
    deps.settings = { ...deps.settings, maxLocalRepairs: 1 }
    const runner = new ExecutionRunner({ id: 'run-escalate-0003', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [task('task-001', { newFiles: ['src/greet.js'] })], deps)
    const outcome = await runner.execute()
    expect(outcome.status).toBe('awaiting_approval')
    expect(store.attempts.map((attempt) => [attempt.model, attempt.outcome])).toEqual([
      ['small:1b', 'invalid_patch'],
      ['small:1b', 'invalid_patch'],
      ['big:7b', 'success'],
    ])
    expect(store.events.some((event) => event.type === 'task_escalated')).toBe(true)
    expect(store.attempts[0]!.errorMessage).toContain('syntax_error')
  }, 60_000)

  it('hands a compact result of finished tasks to dependent tasks and applies the assigned agent', async () => {
    const { deps, repo } = await setup((request) => {
      const key = taskKeyOf(request)
      const step = toolResults(request)
      if (key === 'task-001') return [write('src/greet.js', GREET), { toolCalls: [{ name: 'finish', arguments: { summary: 'Added greet(name) in src/greet.js returning "Hello <name>".' } }] }][step] ?? finish
      return [{ toolCalls: [{ name: 'edit_file', arguments: { path: 'src/index.js', search: "export { add } from './math.js'", replace: "export { add } from './math.js'\nexport { greet } from './greet.js'" } }] }, finish][step] ?? finish
    })
    const tasks = [
      task('task-001', { newFiles: ['src/greet.js'] }),
      task('task-002', { relevantFiles: ['src/index.js'], dependsOn: ['task-001'], agent: { id: 'a1', name: 'Frontend-Agent', escalation: 'none', maxSteps: 5, instructions: 'Always export new helpers from src/index.js.' } }),
    ]
    const outcome = await new ExecutionRunner({ id: 'run-handoff-0009', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, tasks, deps).execute()
    expect(outcome.status).toBe('awaiting_approval')
    const second = fake!.requests.find((request) => taskKeyOf(request) === 'task-002')!
    const prompt = second.messages[1]!.content
    expect(prompt).toContain('## Results of prerequisite tasks')
    expect(prompt).toContain('task-001 "task-001": Added greet(name) in src/greet.js returning "Hello <name>". Files: src/greet.js')
    expect(second.messages[0]!.content).toContain('## Your role: Frontend-Agent\nAlways export new helpers from src/index.js.')
  }, 60_000)

  it('an agent with escalation "none" does not escalate to a stronger model', async () => {
    const models: LocalModelRuntime[] = [
      { model: 'small:1b', roles: ['fast'], toolCalling: true, contextWindow: 32768, available: true },
      { model: 'big:7b', roles: ['balanced'], toolCalling: true, contextWindow: 32768, available: true },
    ]
    const { store, deps, repo } = await setup((request) => [write('src/greet.js', 'export const greet = (name => {\n'), finish][toolResults(request)] ?? finish, models)
    deps.settings = { ...deps.settings, maxLocalRepairs: 2 }
    const runner = new ExecutionRunner(
      { id: 'run-noescalate-0010', projectKey: 'demo', repoPath: repo, goal: 'Add greet' },
      [task('task-001', { newFiles: ['src/greet.js'], agent: { id: 'a2', name: 'Sparsam', escalation: 'none', maxRepairs: 0 } })],
      deps,
    )
    const outcome = await runner.execute()
    expect(outcome.status).toBe('failed')
    // one attempt only: maxRepairs 0 and no escalation to big:7b
    expect(store.attempts.map((attempt) => attempt.model)).toEqual(['small:1b'])
  }, 60_000)

  it('blocks writes outside the task scope and to secrets at the tool layer', async () => {
    const { store, deps, repo } = await setup((request) => {
      const step = toolResults(request)
      return [write('.env', 'X=1'), write('package.json', '{}'), write('src/greet.js', GREET), finish][step] ?? finish
    })
    const runner = new ExecutionRunner({ id: 'run-scope-0004', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [task('task-001', { newFiles: ['src/greet.js'] })], deps)
    const outcome = await runner.execute()
    expect(outcome.status).toBe('awaiting_approval')
    expect(outcome.diff).not.toContain('.env')
    expect(outcome.diff).not.toContain('package.json')
    const toolMessages = fake!.requests.at(-1)!.messages.filter((message) => message.role === 'tool').map((message) => message.content)
    expect(toolMessages[0]).toMatch(/secret/i)
    expect(toolMessages[1]).toMatch(/writable scope/)
    expect(store.attempts).toHaveLength(1)
  }, 60_000)

  it('refuses to apply over uncommitted user changes in the same files', async () => {
    const { deps, store, repo } = await setup((request) => [{ toolCalls: [{ name: 'edit_file', arguments: { path: 'src/math.js', search: 'export const add = (a, b) => a + b', replace: 'export const add = (a, b) => a + b\nexport const sub = (a, b) => a - b' } }] }, finish][toolResults(request)] ?? finish)
    const runner = new ExecutionRunner({ id: 'run-dirty-0005', projectKey: 'demo', repoPath: repo, goal: 'Add sub' }, [task('task-001', { relevantFiles: ['src/math.js'] })], deps)
    expect((await runner.execute()).status).toBe('awaiting_approval')
    await fs.writeFile(path.join(repo, 'src', 'math.js'), 'export const add = (a, b) => a + b // my local edit\n')
    const run = store.lastRun()
    const result = await applyChangeSet({ repoPath: repo, integrationWorktree: run.integrationWorktree as string, integrationBranch: run.integrationBranch as string, baseCommit: run.baseCommit as string, mode: 'working_tree' })
    expect(result.ok).toBe(false)
    expect(result.blockedBy).toEqual(['src/math.js'])
    expect(result.reason).toBe('dirty')
    expect(result.message).toContain('src/math.js')
    expect(await fs.readFile(path.join(repo, 'src', 'math.js'), 'utf8')).toContain('my local edit')

    // fast-forward is refused as well; the branch mode leaves the checkout untouched
    expect((await applyChangeSet({ repoPath: repo, integrationWorktree: run.integrationWorktree as string, integrationBranch: run.integrationBranch as string, baseCommit: run.baseCommit as string, mode: 'fast_forward' })).ok).toBe(false)
    const branch = await applyChangeSet({ repoPath: repo, integrationWorktree: run.integrationWorktree as string, integrationBranch: run.integrationBranch as string, baseCommit: run.baseCommit as string, mode: 'branch' })
    expect(branch.ok).toBe(true)
    expect(await headCommit(repo)).toBe(run.baseCommit)
  }, 60_000)

  it('commits the result onto the checked-out branch: fast-forward, merge after newer commits, clean abort on conflict, undo', async () => {
    const run = async (id: string) => {
      const { deps, store, repo } = await setup((request) => [write('src/greet.js', GREET), finish][toolResults(request)] ?? finish)
      const runner = new ExecutionRunner({ id, projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [task('task-001', { newFiles: ['src/greet.js'] })], deps)
      expect((await runner.execute()).status).toBe('awaiting_approval')
      const last = store.lastRun()
      const apply = (repoPath = repo) => applyChangeSet({ repoPath, integrationWorktree: last.integrationWorktree as string, integrationBranch: last.integrationBranch as string, baseCommit: last.baseCommit as string, mode: 'commit', commitMessage: 'Multi-AI Coder: Add greet' })
      return { repo, apply }
    }
    const commit = (repo: string, message: string) => git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message])
    const branchOf = async (repo: string) => (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()

    // 1. branch unchanged: fast-forward; an unrelated uncommitted change stays as it is
    const first = await run('run-commit-0008')
    await fs.writeFile(path.join(first.repo, 'src', 'math.js'), 'export const add = (a, b) => a + b // local\n')
    const forward = await first.apply()
    expect(forward).toMatchObject({ ok: true, mode: 'commit', targetBranch: await branchOf(first.repo) })
    expect(await headCommit(first.repo)).toBe(forward.afterHead)
    expect((await git(first.repo, ['show', 'HEAD:src/greet.js'])).stdout).toBe(GREET)
    expect(await fs.readFile(path.join(first.repo, 'src', 'math.js'), 'utf8')).toContain('// local')
    // undo moves the branch back, the local change stays
    expect((await revertChangeSet({ repoPath: first.repo, mode: 'commit', patch: forward.patch!, files: forward.files, beforeHead: forward.beforeHead, afterHead: forward.afterHead })).ok).toBe(true)
    expect(await headCommit(first.repo)).toBe(forward.beforeHead)
    expect(await fs.readFile(path.join(first.repo, 'src', 'math.js'), 'utf8')).toContain('// local')

    // 2. the user committed meanwhile (other file): merge commit on top of the newer state
    const second = await run('run-commit-0009')
    await fs.writeFile(path.join(second.repo, 'NOTES.md'), 'meanwhile\n')
    await git(second.repo, ['add', 'NOTES.md'])
    await commit(second.repo, 'notes meanwhile')
    const userHead = await headCommit(second.repo)
    const merged = await second.apply()
    expect(merged.ok).toBe(true)
    expect((await git(second.repo, ['log', '-1', '--format=%s'])).stdout.trim()).toBe('Multi-AI Coder: Add greet')
    expect((await git(second.repo, ['rev-list', '--parents', '-n', '1', 'HEAD'])).stdout).toContain(userHead!)
    expect((await git(second.repo, ['show', 'HEAD:src/greet.js'])).stdout).toBe(GREET)
    expect((await git(second.repo, ['show', 'HEAD:NOTES.md'])).stdout).toBe('meanwhile\n')

    // 3. the user committed an own version of the same file: nothing changes, no half merge
    const third = await run('run-commit-0010')
    const mine = 'export const greet = () => "mine"\n'
    await fs.writeFile(path.join(third.repo, 'src', 'greet.js'), mine)
    await git(third.repo, ['add', '-A'])
    await commit(third.repo, 'own greet')
    const before = await headCommit(third.repo)
    const refused = await third.apply()
    expect(refused).toMatchObject({ ok: false, reason: 'conflict' })
    expect(refused.message).toContain('src/greet.js')
    expect(await headCommit(third.repo)).toBe(before)
    expect(await fs.readFile(path.join(third.repo, 'src', 'greet.js'), 'utf8')).toBe(mine)
    expect((await git(third.repo, ['status', '--porcelain'])).stdout.trim()).toBe('')
    expect((await git(third.repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFailure: true })).exitCode).not.toBe(0)
  }, 180_000)

  it('rolls back a conflicting 3-way apply completely: no conflict markers, no unmerged index', async () => {
    const { deps, store, repo } = await setup((request) => [write('src/greet.js', GREET), finish][toolResults(request)] ?? finish)
    const runner = new ExecutionRunner({ id: 'run-conflict-0007', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [task('task-001', { newFiles: ['src/greet.js'] })], deps)
    expect((await runner.execute()).status).toBe('awaiting_approval')
    // meanwhile the user commits an own src/greet.js (the reported case: an earlier result committed by hand)
    const mine = 'export const greet = () => "mine"\n'
    await fs.writeFile(path.join(repo, 'src', 'greet.js'), mine)
    await git(repo, ['add', '-A'])
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'own greet'])
    const run = store.lastRun()
    const result = await applyChangeSet({ repoPath: repo, integrationWorktree: run.integrationWorktree as string, integrationBranch: run.integrationBranch as string, baseCommit: run.baseCommit as string, mode: 'working_tree' })
    expect(result).toMatchObject({ ok: false, reason: 'conflict' })
    expect(result.message).toContain('Nothing was changed')
    expect(await fs.readFile(path.join(repo, 'src', 'greet.js'), 'utf8')).toBe(mine)
    expect((await git(repo, ['status', '--porcelain'])).stdout.trim()).toBe('')
  }, 60_000)

  it('explains a refused apply when the branch moved and the changed files are gone', async () => {
    const { deps, store, repo } = await setup((request) => [{ toolCalls: [{ name: 'edit_file', arguments: { path: 'src/math.js', search: 'export const add = (a, b) => a + b', replace: 'export const add = (a, b) => a + b\nexport const sub = (a, b) => a - b' } }] }, finish][toolResults(request)] ?? finish)
    const runner = new ExecutionRunner({ id: 'run-moved-0006', projectKey: 'demo', repoPath: repo, goal: 'Add sub' }, [task('task-001', { relevantFiles: ['src/math.js'] })], deps)
    expect((await runner.execute()).status).toBe('awaiting_approval')
    // meanwhile the user commits the deletion of the file the change modifies
    await fs.rm(path.join(repo, 'src', 'math.js'))
    await git(repo, ['add', '-A'])
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'remove math'])
    const run = store.lastRun()
    const result = await applyChangeSet({ repoPath: repo, integrationWorktree: run.integrationWorktree as string, integrationBranch: run.integrationBranch as string, baseCommit: run.baseCommit as string, mode: 'working_tree' })
    expect(result).toMatchObject({ ok: false, reason: 'base_moved', missingFiles: ['src/math.js'] })
    expect(result.message).toMatch(/moved since the run started[\s\S]*missing in the working copy: src\/math\.js[\s\S]*branch/)
    expect(result.message).not.toContain('Falling back')
    // the result stays available as a branch
    expect((await applyChangeSet({ repoPath: repo, integrationWorktree: run.integrationWorktree as string, integrationBranch: run.integrationBranch as string, baseCommit: run.baseCommit as string, mode: 'branch' })).ok).toBe(true)
  }, 60_000)

  it('fast-forwards a clean branch and can undo it', async () => {
    const { deps, store, repo } = await setup((request) => [write('src/greet.js', GREET), finish][toolResults(request)] ?? finish)
    const runner = new ExecutionRunner({ id: 'run-ff-0006', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [task('task-001', { newFiles: ['src/greet.js'] })], deps)
    await runner.execute()
    const run = store.lastRun()
    const result = await applyChangeSet({ repoPath: repo, integrationWorktree: run.integrationWorktree as string, integrationBranch: run.integrationBranch as string, baseCommit: run.baseCommit as string, mode: 'fast_forward' })
    expect(result.ok).toBe(true)
    expect(await headCommit(repo)).toBe(result.afterHead)
    const undo = await revertChangeSet({ repoPath: repo, mode: 'fast_forward', patch: result.patch!, files: result.files, beforeHead: result.beforeHead, afterHead: result.afterHead })
    expect(undo.ok).toBe(true)
    expect(await headCommit(repo)).toBe(run.baseCommit)
  }, 60_000)

  it('resumes idempotently: a task already integrated before the interruption is not executed again', async () => {
    let phase: 'first' | 'resume' = 'first'
    const executedInResume: string[] = []
    const { repo, store, deps } = await setup((request) => {
      const key = taskKeyOf(request)
      const step = toolResults(request)
      if (phase === 'resume' && step === 0) executedInResume.push(key ?? '?')
      if (key === 'task-001') return [write('src/greet.js', GREET), finish][step] ?? finish
      // task-002 produces nothing in the first run (the run "breaks off" before it is integrated)
      if (phase === 'first') return finish
      return [write('src/shout.js', 'export const shout = (s) => s.toUpperCase()\n'), finish][step] ?? finish
    })
    deps.settings = { ...deps.settings, maxLocalRepairs: 0, maxEscalationSteps: 0 }
    const first = await new ExecutionRunner({ id: 'run-resume-0008', projectKey: 'demo', repoPath: repo, goal: 'x' }, [task('task-001', { newFiles: ['src/greet.js'] }), task('task-002', { newFiles: ['src/shout.js'] })], deps).execute()
    expect(first.integratedTasks).toEqual(['task-001'])
    const run = store.lastRun()

    // Simulated crash: the database never learned that task-001 was integrated.
    phase = 'resume'
    const resumeStore = new MemoryStore()
    const resumed = await new ExecutionRunner(
      { id: 'run-resume-0008', projectKey: 'demo', repoPath: repo, goal: 'x', baseCommit: run.baseCommit as string, integrationBranch: run.integrationBranch as string, integrationWorktree: run.integrationWorktree as string },
      [task('task-001', { newFiles: ['src/greet.js'] }), task('task-002', { newFiles: ['src/shout.js'] })],
      { ...deps, store: resumeStore },
    ).execute()

    expect(executedInResume).toEqual(['task-002'])
    expect(resumed.status).toBe('awaiting_approval')
    expect(resumed.integratedTasks.sort()).toEqual(['task-001', 'task-002'])
    expect(resumeStore.events.some((event) => event.type === 'task_recovered')).toBe(true)
    expect(resumeStore.tasks.get('db-task-001')).toMatchObject({ status: 'completed' })
    // the change of task-001 is in the diff exactly once
    expect(resumed.diff!.match(/\+\+\+ b\/src\/greet\.js/g)).toHaveLength(1)
  }, 90_000)

  it('fast path: a deterministic tool task is integrated without any model call', async () => {
    const { repo, store, deps } = await setup(() => {
      throw new Error('no model must be called')
    })
    const tool = { kind: 'rename' as const, files: ['src/math.js'], from: 'add', to: 'sum' }
    const outcome = await new ExecutionRunner({ id: 'run-fastpath-0009', projectKey: 'demo', repoPath: repo, goal: 'Rename add to sum' }, [task('task-001', { relevantFiles: ['src/math.js'], tool })], deps).execute()
    expect(outcome.status).toBe('awaiting_approval')
    expect(outcome.finalValidation?.ok).toBe(true) // the renamed call sites in the tests still pass
    expect(outcome.diff).toContain('export const sum')
    expect(outcome.diff).toContain('export { sum }')
    expect(store.attempts.map((attempt) => [attempt.executor, attempt.model, attempt.outcome])).toEqual([['deterministic', 'tool:rename', 'success']])
    expect(fake!.requests).toHaveLength(0)
    expect(store.calls).toHaveLength(0)
  }, 60_000)

  it('fast path: write-files integrates approved content without any model call', async () => {
    const { repo, store, deps } = await setup(() => {
      throw new Error('no model must be called')
    })
    const tool = { kind: 'write-files' as const, files: ['design/tokens.css'], contents: [':root{}\n'] }
    const outcome = await new ExecutionRunner({ id: 'run-writefiles-0001', projectKey: 'demo', repoPath: repo, goal: 'Write tokens' }, [task('task-001', { newFiles: ['design/tokens.css'], tool })], deps).execute()
    expect(outcome.status).toBe('awaiting_approval')
    const run = store.lastRun()
    expect((await git(repo, ['show', `${run.integrationBranch as string}:design/tokens.css`])).stdout).toBe(':root{}\n')
    expect(store.tasks.get('db-task-001')?.selectedModelName).toBe('Werkzeug: write-files')
    expect(fake!.requests).toHaveLength(0)
    expect(store.calls).toHaveLength(0)
  }, 60_000)

  it('fast path: write-files with identical existing content completes without commit or fallback and lets dependents run', async () => {
    const { repo, store, deps } = await setup(() => {
      throw new Error('no model must be called')
    })
    await fs.mkdir(path.join(repo, 'design'), { recursive: true })
    await fs.writeFile(path.join(repo, 'design/tokens.css'), ':root{}\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'add tokens'])
    deps.index = await buildRepoIndex(repo)
    const tool = { kind: 'write-files' as const, files: ['design/tokens.css'], contents: [':root{}\n'] }
    const rename = { kind: 'rename' as const, files: ['src/math.js'], from: 'add', to: 'sum' }
    const tasks = [
      task('task-001', { relevantFiles: ['design/tokens.css'], tool }),
      task('task-002', { relevantFiles: ['src/math.js'], dependsOn: ['task-001'], tool: rename }),
    ]
    const outcome = await new ExecutionRunner({ id: 'run-writefiles-0002', projectKey: 'demo', repoPath: repo, goal: 'Tokens exist' }, tasks, deps).execute()
    expect(store.tasks.get('db-task-001')?.status).toBe('completed')
    expect(store.tasks.get('db-task-001')?.commitSha).toBeUndefined()
    expect(store.tasks.get('db-task-002')?.status).toBe('completed')
    expect(outcome.status).toBe('awaiting_approval')
    expect(store.events.some((event) => event.type === 'fast_path_fallback')).toBe(false)
    expect(store.attempts.find((attempt) => attempt.taskId === 'db-task-001')?.outcome).toBe('no_changes')
    expect(fake!.requests).toHaveLength(0)
  }, 60_000)

  it('fast path: write-files with an invalid path fails the task instead of falling back to an agent', async () => {
    const { repo, store, deps } = await setup(() => {
      throw new Error('no model must be called')
    })
    const tool = { kind: 'write-files' as const, files: ['../x'], contents: ['x\n'] }
    const outcome = await new ExecutionRunner({ id: 'run-writefiles-0003', projectKey: 'demo', repoPath: repo, goal: 'Bad path' }, [task('task-001', { newFiles: ['design/x.css'], tool })], deps).execute()
    expect(outcome.status).toBe('failed')
    expect(store.tasks.get('db-task-001')?.status).toBe('failed')
    expect(store.events.some((event) => event.type === 'fast_path_fallback')).toBe(false)
    expect(fake!.requests).toHaveLength(0)
    expect(store.attempts.map((attempt) => attempt.executor)).toEqual(['deterministic'])
  }, 60_000)

  it('cancels a running run and leaves no task worktrees behind', async () => {
    const { deps, worktrees, repo } = await setup(() => ({ content: '', stallMs: 5000 }))
    const runner = new ExecutionRunner({ id: 'run-cancel-0007', projectKey: 'demo', repoPath: repo, goal: 'x' }, [task('task-001'), task('task-002')], deps)
    const pending = runner.execute()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    runner.cancel()
    const outcome = await pending
    expect(outcome.status).toBe('cancelled')
    const remaining = await worktrees.listManaged(repo)
    expect(remaining.every((entry) => entry.branch?.endsWith('/integration'))).toBe(true)
  }, 60_000)
})

describe('agent limits are enforced during real execution', () => {
  const toolMessages = () => fake!.requests.at(-1)!.messages.filter((message) => message.role === 'tool').map((message) => message.content)

  it('local agent: no write permission → every write is refused, nothing is integrated', async () => {
    const { deps, repo } = await setup((request) => [write('src/greet.js', GREET), finish][toolResults(request)] ?? finish)
    const runner = new ExecutionRunner({ id: 'run-noperm-0101', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [task('task-001', { newFiles: ['src/greet.js'], agent: { id: 'ro', name: 'Leser', escalation: 'none', maxRepairs: 0, permissions: { write: false } } })], deps)
    const outcome = await runner.execute()
    expect(outcome.status).toBe('failed')
    expect(toolMessages()[0]).toMatch(/no write permission/)
    expect(existsSync(path.join(repo, 'src/greet.js'))).toBe(false)
  }, 60_000)

  it('local agent: file limit, context budget and output token limit reach the model call', async () => {
    const { deps, repo } = await setup((request) => [write('src/greet.js', GREET), write('src/other.js', 'export const x = 1\n'), finish][toolResults(request)] ?? finish)
    const runner = new ExecutionRunner(
      { id: 'run-limits-0102', projectKey: 'demo', repoPath: repo, goal: 'Add greet' },
      [task('task-001', { newFiles: ['src/greet.js', 'src/other.js'], agent: { id: 'lim', name: 'Begrenzt', escalation: 'none', maxRepairs: 0, maxContextTokens: 4096, resources: { maxFiles: 1, maxOutputTokens: 2000 } } })],
      deps,
    )
    const outcome = await runner.execute()
    expect(toolMessages()[1]).toMatch(/file resource limit/)
    const options = (fake!.requests[0] as unknown as { options: { num_ctx: number; num_predict: number } }).options
    expect(options.num_ctx).toBe(4096)
    expect(options.num_predict).toBeLessThanOrEqual(2000)
    expect(outcome.diff ?? '').not.toContain('src/other.js')
  }, 60_000)

  it('local agent: the time limit of the agent ends a stalled model call', async () => {
    const { deps, repo, store } = await setup(() => ({ content: '', stallMs: 20_000 }))
    const started = Date.now()
    const runner = new ExecutionRunner({ id: 'run-timeout-0103', projectKey: 'demo', repoPath: repo, goal: 'x' }, [task('task-001', { newFiles: ['src/greet.js'], agent: { id: 'fast', name: 'Eilig', escalation: 'none', maxRepairs: 0, resources: { timeoutMs: 2000 } } })], deps)
    const outcome = await runner.execute()
    expect(outcome.status).toBe('failed')
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(store.attempts[0]!.errorMessage ?? JSON.stringify(store.attempts[0])).toMatch(/time|timeout|stall/i)
  }, 60_000)

  function premium(onCall: (cwd: string) => Promise<void>) {
    const calls: Array<{ mcpServers?: string[]; timeoutMs?: number }> = []
    const orchestrator = {
      id: 'codex', displayName: 'Fake Premium',
      async executeComplexTask(_input: unknown, ctx: { cwd: string; mcpServers?: string[]; timeoutMs?: number }) {
        calls.push({ mcpServers: ctx.mcpServers, timeoutMs: ctx.timeoutMs })
        await onCall(ctx.cwd)
        return { result: { summary: 'done', filesChanged: ['src/greet.js'], commandsRun: [] }, meta: { durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, measured: true, billing: 'subscription' } } }
      },
    }
    return { calls, orchestrator }
  }

  it('premium agent: time limit and "no external tools" (no MCP servers) reach the CLI call', async () => {
    const { deps, repo } = await setup(() => finish, [])
    const { calls, orchestrator } = premium((cwd) => fs.writeFile(path.join(cwd, 'src/greet.js'), GREET))
    const runner = new ExecutionRunner(
      { id: 'run-premium-0104', projectKey: 'demo', repoPath: repo, goal: 'Add greet' },
      [task('task-001', { suggestedExecutor: 'premium', complexity: 4, newFiles: ['src/greet.js'], agent: { id: 'p', name: 'Premium', escalation: 'none', maxRepairs: 0, mcpServers: ['srv-1'], permissions: { externalTools: false }, resources: { timeoutMs: 7000 } } })],
      { ...deps, orchestrator: orchestrator as never },
    )
    const outcome = await runner.execute()
    expect(calls).toEqual([{ mcpServers: [], timeoutMs: 7000 }])
    expect(outcome.status).toBe('awaiting_approval')
  }, 60_000)

  it('review fix round runs with a class-based store (events keep working)', async () => {
    const { deps, repo, store } = await setup(() => finish, [])
    const { orchestrator } = premium((cwd) => fs.writeFile(path.join(cwd, 'src/greet.js'), GREET))
    const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, measured: true, billing: 'subscription' }
    let reviews = 0
    const reviewing = {
      ...orchestrator,
      async reviewResult() {
        reviews += 1
        const result = reviews === 1
          ? { verdict: 'request_changes', score: 40, summary: 'needs a fix', issues: [{ severity: 'blocker', file: 'src/greet.js', message: 'fix it' }], requiredFixes: ['fix greet'] }
          : { verdict: 'approve', score: 90, summary: 'ok', issues: [], requiredFixes: [] }
        return { result, meta: { durationMs: 1, usage } }
      },
      async cancelRun() {},
    }
    const runner = new ExecutionRunner(
      { id: 'run-review-fix', projectKey: 'demo', repoPath: repo, goal: 'Add greet' },
      [task('task-001', { suggestedExecutor: 'premium', complexity: 4, newFiles: ['src/greet.js'] })],
      { ...deps, orchestrator: reviewing as never, settings: { ...deps.settings, premiumReviewPolicy: 'always' as const, reviewFixRounds: 1 } },
    )
    await runner.execute()
    expect(reviews).toBeGreaterThanOrEqual(1)
    expect(store.events.some((event) => event.type === 'review_fix_started')).toBe(true)
    expect(store.events.some((event) => /is not a function/.test(event.message))).toBe(false)
  }, 60_000)

  const failingExecute = (error: Error) => ({ id: 'codex', displayName: 'Fake Premium', async executeComplexTask(): Promise<never> { throw error }, async cancelRun() {} })

  it('premium agent: a rejected CLI output still books the measured usage from the error meta', async () => {
    const { deps, repo, store } = await setup(() => finish, [])
    const error = new OrchestratorError('Codex returned no structured output.', 'invalid_output', {
      retryable: true,
      meta: { model: 'gpt-x', sessionId: 's-1', durationMs: 5, usage: { inputTokens: 900, outputTokens: 40, cachedInputTokens: 100, measured: true, billing: 'subscription' } },
    })
    const runner = new ExecutionRunner(
      { id: 'run-premium-meta', projectKey: 'demo', repoPath: repo, goal: 'Add greet' },
      [task('task-001', { suggestedExecutor: 'premium', complexity: 4, newFiles: ['src/greet.js'], agent: { id: 'p', name: 'Premium', escalation: 'none', maxRepairs: 0 } })],
      { ...deps, orchestrator: failingExecute(error) as never },
    )
    await runner.execute()
    const call = store.calls.find((entry) => entry.kind === 'orchestrator' && entry.purpose === 'execute')
    expect(call).toMatchObject({ status: 'error', errorClass: 'invalid_output', model: 'gpt-x', sessionId: 's-1' })
    expect(call!.usage).toMatchObject({ inputTokens: 900, outputTokens: 40, measured: true })
  }, 60_000)

  it('premium agent: a failure without meta books unmeasured zero usage', async () => {
    const { deps, repo, store } = await setup(() => finish, [])
    const runner = new ExecutionRunner(
      { id: 'run-premium-nometa', projectKey: 'demo', repoPath: repo, goal: 'Add greet' },
      [task('task-001', { suggestedExecutor: 'premium', complexity: 4, newFiles: ['src/greet.js'], agent: { id: 'p', name: 'Premium', escalation: 'none', maxRepairs: 0 } })],
      { ...deps, orchestrator: failingExecute(new Error('boom')) as never },
    )
    await runner.execute()
    const call = store.calls.find((entry) => entry.kind === 'orchestrator' && entry.purpose === 'execute')
    expect(call).toMatchObject({ status: 'error', errorClass: 'process_failed' })
    expect(call!.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, measured: false })
  }, 60_000)

  it('premium review: a rejected review output still books the measured usage from the error meta', async () => {
    const { deps, repo, store } = await setup(() => finish, [])
    const { orchestrator } = premium((cwd) => fs.writeFile(path.join(cwd, 'src/greet.js'), GREET))
    const reviewing = {
      ...orchestrator,
      async reviewResult(): Promise<never> {
        throw new OrchestratorError('Codex review was not an object.', 'invalid_output', {
          retryable: true,
          meta: { model: 'gpt-r', sessionId: 's-r', durationMs: 5, usage: { inputTokens: 700, outputTokens: 30, cachedInputTokens: 0, measured: true, billing: 'subscription' } },
        })
      },
      async cancelRun() {},
    }
    const runner = new ExecutionRunner(
      { id: 'run-review-meta', projectKey: 'demo', repoPath: repo, goal: 'Add greet' },
      [task('task-001', { suggestedExecutor: 'premium', complexity: 4, newFiles: ['src/greet.js'] })],
      { ...deps, orchestrator: reviewing as never, settings: { ...deps.settings, premiumReviewPolicy: 'always' as const } },
    )
    await runner.execute()
    const call = store.calls.find((entry) => entry.purpose === 'review')
    expect(call).toMatchObject({ kind: 'orchestrator', status: 'error', errorClass: 'invalid_output', model: 'gpt-r', sessionId: 's-r' })
    expect(call!.usage).toMatchObject({ inputTokens: 700, outputTokens: 30, measured: true })
  }, 60_000)

  it('premium review: a rejected review after a fix round is booked as review_fix with its measured usage', async () => {
    const { deps, repo, store } = await setup(() => finish, [])
    let executions = 0
    // the fix round must change something, otherwise it is not re-reviewed
    const { orchestrator } = premium((cwd) => fs.writeFile(path.join(cwd, 'src/greet.js'), ++executions === 1 ? GREET : `// reviewed\n${GREET}`))
    let reviews = 0
    const reviewing = {
      ...orchestrator,
      async reviewResult() {
        reviews += 1
        if (reviews === 1) {
          const result = { verdict: 'request_changes', score: 40, summary: 'needs a fix', issues: [{ severity: 'blocker', file: 'src/greet.js', message: 'fix it' }], requiredFixes: ['fix greet'] }
          return { result, meta: { durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, measured: true, billing: 'subscription' } } }
        }
        throw new OrchestratorError('Review is not an object.', 'invalid_output', {
          meta: { model: 'gpt-f', sessionId: 's-f', durationMs: 5, usage: { inputTokens: 600, outputTokens: 20, cachedInputTokens: 0, measured: true, billing: 'subscription' } },
        })
      },
      async cancelRun() {},
    }
    const runner = new ExecutionRunner(
      { id: 'run-review-fix-meta', projectKey: 'demo', repoPath: repo, goal: 'Add greet' },
      [task('task-001', { suggestedExecutor: 'premium', complexity: 4, newFiles: ['src/greet.js'] })],
      { ...deps, orchestrator: reviewing as never, settings: { ...deps.settings, premiumReviewPolicy: 'always' as const, reviewFixRounds: 1 } },
    )
    await runner.execute()
    expect(reviews).toBe(2)
    const call = store.calls.find((entry) => entry.purpose === 'review_fix')
    expect(call).toMatchObject({ kind: 'orchestrator', status: 'error', errorClass: 'invalid_output', model: 'gpt-f', sessionId: 's-f' })
    expect(call!.usage).toMatchObject({ inputTokens: 600, outputTokens: 20, measured: true })
  }, 60_000)

  it('premium agent: without write permission a change by the CLI is rejected before integration', async () => {
    const { deps, repo } = await setup(() => finish, [])
    const { calls, orchestrator } = premium((cwd) => fs.writeFile(path.join(cwd, 'src/greet.js'), GREET))
    const runner = new ExecutionRunner(
      { id: 'run-premium-0105', projectKey: 'demo', repoPath: repo, goal: 'Add greet' },
      [task('task-001', { suggestedExecutor: 'premium', complexity: 4, newFiles: ['src/greet.js'], agent: { id: 'p', name: 'Nur lesen', escalation: 'none', maxRepairs: 0, permissions: { write: false } } })],
      { ...deps, orchestrator: orchestrator as never },
    )
    const outcome = await runner.execute()
    expect(calls).toHaveLength(1)
    expect(outcome.status).toBe('failed')
    expect(outcome.diff ?? '').not.toContain('greet')
  }, 60_000)

  it('premium agent: "no read permission" cannot be enforced for a CLI and is refused before the call', async () => {
    const { deps, repo, store } = await setup(() => finish, [])
    const { calls, orchestrator } = premium(async () => undefined)
    const runner = new ExecutionRunner(
      { id: 'run-premium-0106', projectKey: 'demo', repoPath: repo, goal: 'x' },
      [task('task-001', { suggestedExecutor: 'premium', complexity: 4, newFiles: ['src/greet.js'], agent: { id: 'p', name: 'Blind', escalation: 'none', maxRepairs: 0, permissions: { read: false } } })],
      { ...deps, orchestrator: orchestrator as never },
    )
    const outcome = await runner.execute()
    expect(calls).toHaveLength(0)
    expect(outcome.status).toBe('failed')
    expect(store.events.some((event) => event.type === 'agent_permission')).toBe(true)
  }, 60_000)
})

describe('premium advises, local executes (repair hint before premium execution)', () => {
  const models: LocalModelRuntime[] = [
    { model: 'small:1b', roles: ['fast'], toolCalling: true, contextWindow: 32768, available: true },
    { model: 'big:7b', roles: ['balanced'], toolCalling: true, contextWindow: 32768, available: true },
  ]
  const usage = { inputTokens: 300, outputTokens: 50, cachedInputTokens: 0, measured: true, billing: 'subscription' as const }
  const WRONG = 'export const greet = (name) => `Hi ${name}`\n'
  const isHintRound = (request: FakeChatRequest) => request.messages.some((message) => message.content?.includes('The lead engineer reviewed your previous attempt'))
  const greetTask = () => task('task-001', { newFiles: ['src/greet.js', 'test/greet.test.js'] })

  /** Local models write a failing greet; the hint round writes `hintReply` (the correct greet by default). */
  async function hintSetup(options: { hintFixes?: boolean; premiumHints?: boolean; hint?: () => Promise<unknown>; settings?: Record<string, unknown> } = {}) {
    const order: string[] = []
    const hintRequests: FakeChatRequest[] = []
    const { repo, store, deps } = await setup((request) => {
      const step = toolResults(request)
      if (step === 0) order.push(isHintRound(request) ? `${request.model}+hint` : request.model)
      if (isHintRound(request)) {
        hintRequests.push(request)
        return [write('src/greet.js', options.hintFixes === false ? WRONG.replace('Hi', 'Hey') : GREET), finish][step] ?? finish
      }
      return [write('src/greet.js', WRONG), write('test/greet.test.js', GREET_TEST), finish][step] ?? finish
    }, models)
    const hintInputs: Array<{ input: { diff: string; failures: string; files: string[] }; restored: string }> = []
    const orchestrator = {
      id: 'codex', displayName: 'Fake Premium',
      async repairHint(input: { diff: string; failures: string; files: string[] }, ctx: { cwd: string }) {
        order.push('hint')
        // the failed attempt is restored in the worktree, so "find" text matches the files
        hintInputs.push({ input, restored: await fs.readFile(path.join(ctx.cwd, 'src/greet.js'), 'utf8').catch(() => '') })
        if (options.hint) return options.hint()
        return { result: { diagnosis: 'Der Gruß lautet „Hi" statt „Hello".', edits: [{ file: 'src/greet.js', find: '`Hi ${name}`', replace: '`Hello ${name}`', note: 'Test erwartet Hello' }], confidence: 'high' }, meta: { model: 'gpt-h', sessionId: 's-h', durationMs: 3, usage } }
      },
      async executeComplexTask(_input: unknown, ctx: { cwd: string }) {
        order.push('premium')
        await fs.writeFile(path.join(ctx.cwd, 'src/greet.js'), GREET)
        await fs.writeFile(path.join(ctx.cwd, 'test/greet.test.js'), GREET_TEST)
        return { result: { summary: 'done', filesChanged: ['src/greet.js'], commandsRun: [] }, meta: { durationMs: 1, usage } }
      },
      async cancelRun() {},
    }
    deps.settings = { ...deps.settings, maxLocalRepairs: 0, ...(options.premiumHints === undefined ? {} : { premiumHints: options.premiumHints }), ...options.settings }
    const runner = new ExecutionRunner({ id: `run-hint-${Math.random().toString(36).slice(2, 8)}`, projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [greetTask()], { ...deps, orchestrator: orchestrator as never })
    return { runner, store, order, hintInputs, hintRequests }
  }

  it('asks for a hint after the stronger local model failed and integrates the hinted local repair without premium execution', async () => {
    const { runner, store, order, hintInputs, hintRequests } = await hintSetup()
    const outcome = await runner.execute()
    expect(outcome.status).toBe('awaiting_approval')
    expect(order).toEqual(['small:1b', 'big:7b', 'hint', 'big:7b+hint'])
    expect(store.attempts.map((attempt) => [attempt.model, attempt.outcome, attempt.repairRound])).toEqual([
      ['small:1b', 'validation_failed', 0],
      ['big:7b', 'validation_failed', 0],
      ['big:7b', 'success', 1],
    ])
    // the orchestrator got the failed diff, the failing check output and the task files
    expect(hintInputs[0]!.input.diff).toContain('Hi ${name}')
    expect(hintInputs[0]!.input.failures).toMatch(/test failed/)
    expect(hintInputs[0]!.input.files).toEqual(['src/greet.js', 'test/greet.test.js'])
    expect(hintInputs[0]!.restored.replace(/\r\n/g, '\n')).toBe(WRONG)
    // the local model receives the hint as exact old → new instructions
    const prompt = hintRequests[0]!.messages.map((message) => message.content).join('\n')
    expect(prompt).toContain('Diagnosis: Der Gruß lautet')
    expect(prompt).toMatch(/old:\n```\n`Hi \$\{name\}`\n```\nnew:\n```\n`Hello \$\{name\}`\n```/)
    // booked as repair_hint with its usage; the local hint round counts as a repair
    expect(store.calls.find((call) => call.purpose === 'repair_hint')).toMatchObject({ kind: 'orchestrator', provider: 'codex', model: 'gpt-h', status: 'ok', sessionId: 's-h', usage: { inputTokens: 300, outputTokens: 50 } })
    expect(store.calls.filter((call) => call.kind === 'local').map((call) => call.purpose)).toEqual(['execute', 'execute', 'repair'])
    expect(store.calls.some((call) => call.purpose === 'execute' && call.kind === 'orchestrator')).toBe(false)
    expect(store.events.find((event) => event.type === 'premium_hint')).toMatchObject({ data: { diagnosis: 'Der Gruß lautet „Hi" statt „Hello".', confidence: 'high', files: ['src/greet.js'] } })
  }, 60_000)

  it('escalates to premium execution only when the hinted local round fails as well', async () => {
    const { runner, store, order } = await hintSetup({ hintFixes: false })
    const outcome = await runner.execute()
    expect(outcome.status).toBe('awaiting_approval')
    expect(order).toEqual(['small:1b', 'big:7b', 'hint', 'big:7b+hint', 'premium'])
    expect(store.attempts.map((attempt) => [attempt.model, attempt.outcome])).toEqual([
      ['small:1b', 'validation_failed'],
      ['big:7b', 'validation_failed'],
      ['big:7b', 'validation_failed'],
      ['codex', 'success'],
    ])
    expect(store.calls.filter((call) => call.kind === 'orchestrator').map((call) => call.purpose)).toEqual(['repair_hint', 'execute'])
  }, 60_000)

  it('still lets premium advise when premium execution is not allowed, and ends the chain with the hinted local round', async () => {
    const { runner, store, order } = await hintSetup({ settings: { premiumExecutionAllowed: false } })
    expect((await runner.execute()).status).toBe('awaiting_approval')
    expect(order).toEqual(['small:1b', 'big:7b', 'hint', 'big:7b+hint'])
    expect(store.calls.filter((call) => call.kind === 'orchestrator').map((call) => call.purpose)).toEqual(['repair_hint'])
  }, 60_000)

  it('never falls back to premium execution when it is not allowed, even if the hinted round fails', async () => {
    const { runner, store, order } = await hintSetup({ hintFixes: false, settings: { premiumExecutionAllowed: false } })
    await runner.execute()
    expect(order).toEqual(['small:1b', 'big:7b', 'hint', 'big:7b+hint'])
    expect(store.calls.some((call) => call.kind === 'orchestrator' && call.purpose === 'execute')).toBe(false)
  }, 60_000)

  it('skips the hint step when premiumHints is off', async () => {
    const { runner, store, order } = await hintSetup({ premiumHints: false })
    await runner.execute()
    expect(order).toEqual(['small:1b', 'big:7b', 'premium'])
    expect(store.calls.some((call) => call.purpose === 'repair_hint')).toBe(false)
  }, 60_000)

  it('goes straight to premium execution on a low-confidence hint or a hint without edits', async () => {
    for (const result of [
      { diagnosis: 'Unklar.', edits: [{ file: 'src/greet.js', find: 'a', replace: 'b', note: '' }], confidence: 'low' },
      { diagnosis: 'Keine Idee.', edits: [], confidence: 'high' },
    ]) {
      await fake?.close()
      const { runner, store, order } = await hintSetup({ hint: async () => ({ result, meta: { durationMs: 1, usage } }) })
      expect((await runner.execute()).status).toBe('awaiting_approval')
      expect(order).toEqual(['small:1b', 'big:7b', 'hint', 'premium'])
      expect(store.calls.find((call) => call.purpose === 'repair_hint')).toMatchObject({ status: 'ok' })
      expect(store.events.some((event) => event.type === 'premium_hint_skipped')).toBe(true)
    }
  }, 120_000)

  it('books a failed hint call with the measured usage from the error meta and continues with premium execution', async () => {
    const error = new OrchestratorError('Repair hint is not an object.', 'invalid_output', { retryable: true, meta: { model: 'gpt-h', sessionId: 's-e', durationMs: 4, usage: { ...usage, inputTokens: 800 } } })
    const { runner, store, order } = await hintSetup({ hint: async () => { throw error } })
    expect((await runner.execute()).status).toBe('awaiting_approval')
    expect(order).toEqual(['small:1b', 'big:7b', 'hint', 'premium'])
    expect(store.calls.find((call) => call.purpose === 'repair_hint')).toMatchObject({ status: 'error', errorClass: 'invalid_output', model: 'gpt-h', sessionId: 's-e', usage: { inputTokens: 800, measured: true } })
    expect(store.events.some((event) => event.type === 'premium_hint_failed')).toBe(true)
  }, 60_000)
})

describe('duo premium execution (lead and partner in sibling worktrees)', () => {
  const WRONG = 'export const greet = (name) => `Hi ${name}`\n'
  const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 10, cachedInputTokens: 0, measured: true, billing: 'subscription' as const })
  const premiumTask = () => task('task-001', { suggestedExecutor: 'premium', complexity: 4, newFiles: ['src/greet.js', 'test/greet.test.js'], agent: { id: 'p', name: 'Premium', escalation: 'none', maxRepairs: 0 } })

  /** A fake CLI that writes `greet` (and its test) into the worktree it is given. */
  function cli(id: 'claude-code' | 'codex', greetOf: string | Error | ((call: number) => string | Error), options: { choose?: () => Promise<{ result: unknown; meta: unknown }> } = {}) {
    const cwds: string[] = []
    const chooseRequests: Array<{ prompt: string; schema: unknown }> = []
    const adapter = {
      id,
      displayName: id === 'claude-code' ? 'Claude Code' : 'Codex',
      async executeComplexTask(_input: unknown, ctx: { cwd: string }) {
        const greet = typeof greetOf === 'function' ? greetOf(cwds.length) : greetOf
        cwds.push(ctx.cwd)
        if (greet instanceof Error) {
          // partial edit before the failure: must not end up in the integrated change
          await fs.writeFile(path.join(ctx.cwd, 'src/greet.js'), 'partial\n')
          throw greet
        }
        await fs.writeFile(path.join(ctx.cwd, 'src/greet.js'), greet)
        await fs.writeFile(path.join(ctx.cwd, 'test/greet.test.js'), GREET_TEST)
        return { result: { summary: `${id} wrote greet`, filesChanged: ['src/greet.js'], commandsRun: [], sessionId: `s-${id}` }, meta: { model: `${id}-model`, sessionId: `s-${id}`, durationMs: 3, usage: usage(id === 'claude-code' ? 1000 : 2000) } }
      },
      ...(options.choose ? { async structuredCall(request: { prompt: string; schema: unknown }) { chooseRequests.push(request); return options.choose!() } } : {}),
      async reviewResult(): Promise<never> { throw new Error('no review') },
      async cancelRun() {},
    }
    return { adapter, cwds, chooseRequests }
  }

  async function runDuo(lead: ReturnType<typeof cli>, partner: ReturnType<typeof cli>, tasks: EngineTask[] = [premiumTask()]) {
    const { deps, repo, store, worktrees } = await setup(() => finish, [])
    const orchestrator = new DuoOrchestrator(lead.adapter as never, partner.adapter as never)
    const runner = new ExecutionRunner({ id: `run-duo-${Math.random().toString(36).slice(2, 8)}`, projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, tasks, { ...deps, orchestrator })
    const outcome = await runner.execute()
    const leftovers = (await worktrees.listManaged(repo)).filter((entry) => entry.branch?.endsWith('-duo'))
    return { outcome, store, leftovers }
  }

  it('runs both in separate worktrees, the one with green checks wins and its change is integrated', async () => {
    const lead = cli('claude-code', WRONG)
    const partner = cli('codex', GREET)
    const { outcome, store, leftovers } = await runDuo(lead, partner)
    expect(outcome.status).toBe('awaiting_approval')
    expect(lead.cwds).toHaveLength(1)
    expect(partner.cwds).toHaveLength(1)
    expect(lead.cwds[0]).not.toBe(partner.cwds[0])
    // the partner won: its change (not the lead's) is in the integrated diff
    expect(outcome.diff).toContain('Hello ${name}')
    expect(outcome.diff).not.toContain('Hi ${name}')
    expect(leftovers).toHaveLength(0)
    expect(existsSync(partner.cwds[0]!)).toBe(false)
    // one execute row per CLI, each with its own provider and usage; no choose call
    expect(store.calls.filter((call) => call.kind === 'orchestrator').map((call) => [call.provider, call.purpose, call.status, call.model, call.usage.inputTokens]).sort()).toEqual([
      ['claude-code', 'execute', 'ok', 'claude-code-model', 1000],
      ['codex', 'execute', 'ok', 'codex-model', 2000],
    ])
    expect(store.events.find((event) => event.type === 'duo_reconciled')).toMatchObject({ data: { phase: 'execute', winner: 'codex' } })
    expect(store.events.filter((event) => event.type === 'duo_proposal')).toHaveLength(2)
    expect(store.attempts.at(-1)).toMatchObject({ model: 'claude-code', outcome: 'success', inputTokens: 3000 })
  }, 120_000)

  it('on a tie the lead chooses (duo_choose call) and the chosen partner change is applied', async () => {
    const lead = cli('claude-code', GREET, { choose: async () => ({ result: { winner: 'B', reason: 'Codex ist knapper.' }, meta: { model: 'chooser', durationMs: 2, usage: usage(500) } }) })
    const partner = cli('codex', `// codex\n${GREET}`)
    const { outcome, store, leftovers } = await runDuo(lead, partner)
    expect(outcome.status).toBe('awaiting_approval')
    expect(lead.chooseRequests).toHaveLength(1)
    expect(lead.chooseRequests[0]!.prompt).toContain('Change A (Claude Code)')
    expect(lead.chooseRequests[0]!.prompt).toContain('Change B (Codex)')
    expect(lead.chooseRequests[0]!.prompt).toContain('// codex')
    expect(outcome.diff).toContain('// codex')
    expect(leftovers).toHaveLength(0)
    expect(store.calls.find((call) => call.purpose === 'duo_choose')).toMatchObject({ kind: 'orchestrator', provider: 'claude-code', model: 'chooser', status: 'ok', usage: { inputTokens: 500 } })
    expect(store.events.find((event) => event.type === 'duo_reconciled')).toMatchObject({ data: { winner: 'codex', notes: [expect.stringContaining('Codex ist knapper.')] } })
  }, 120_000)

  it('a failed partner leaves the lead change; the failure is booked and the sibling is removed', async () => {
    const lead = cli('claude-code', GREET)
    const partner = cli('codex', new OrchestratorError('Codex quota', 'quota_exhausted', { meta: { model: 'gpt-q', durationMs: 1, usage: usage(300) } }))
    const { outcome, store, leftovers } = await runDuo(lead, partner)
    expect(outcome.status).toBe('awaiting_approval')
    expect(outcome.diff).toContain('Hello ${name}')
    expect(outcome.diff).not.toContain('partial')
    expect(leftovers).toHaveLength(0)
    expect(store.calls.filter((call) => call.kind === 'orchestrator').map((call) => [call.provider, call.status, call.errorClass ?? null, call.usage.inputTokens]).sort()).toEqual([
      ['claude-code', 'ok', null, 1000],
      ['codex', 'error', 'quota_exhausted', 300],
    ])
    // one unavailable side does not block premium execution for the run
    expect(store.events.some((event) => event.type === 'premium_blocked')).toBe(false)
    expect(store.events.find((event) => event.type === 'duo_reconciled')).toMatchObject({ data: { winner: 'claude-code', fallback: expect.stringContaining('Codex ist fehlgeschlagen') } })
  }, 120_000)

  it('a failed lead: the partner change replaces the partial lead edit', async () => {
    const lead = cli('claude-code', new OrchestratorError('Claude timeout', 'timeout'))
    const partner = cli('codex', GREET)
    const { outcome, leftovers } = await runDuo(lead, partner)
    expect(outcome.status).toBe('awaiting_approval')
    expect(outcome.diff).toContain('Hello ${name}')
    expect(outcome.diff).not.toContain('partial')
    expect(leftovers).toHaveLength(0)
  }, 120_000)

  it('a partner blocked by its usage limit is not called again in the run; the lead works alone', async () => {
    const lead = cli('claude-code', (call) => (call === 0 ? GREET : `// v2\n${GREET}`))
    const partner = cli('codex', new OrchestratorError('Codex quota', 'quota_exhausted'))
    const second = task('task-002', { suggestedExecutor: 'premium', complexity: 4, relevantFiles: ['src/greet.js'], dependsOn: ['task-001'], agent: { id: 'p', name: 'Premium', escalation: 'none', maxRepairs: 0 } })
    const { outcome, store, leftovers } = await runDuo(lead, partner, [premiumTask(), second])
    expect(outcome.status).toBe('awaiting_approval')
    expect(lead.cwds).toHaveLength(2)
    expect(partner.cwds).toHaveLength(1)
    expect(outcome.diff).toContain('// v2')
    expect(leftovers).toHaveLength(0)
    expect(store.events.filter((event) => event.type === 'duo_partner_unavailable')).toHaveLength(1)
    expect(store.events.some((event) => event.type === 'premium_blocked')).toBe(false)
  }, 120_000)

  it('premium is blocked only when both duo sides are blocked', async () => {
    const lead = cli('claude-code', (call) => (call === 0 ? GREET : new OrchestratorError('Claude limit', 'quota_exhausted')))
    const partner = cli('codex', new OrchestratorError('Codex logged out', 'not_authenticated'))
    const second = task('task-002', { suggestedExecutor: 'premium', complexity: 4, relevantFiles: ['src/greet.js'], dependsOn: ['task-001'], agent: { id: 'p', name: 'Premium', escalation: 'none', maxRepairs: 0 } })
    const { store } = await runDuo(lead, partner, [premiumTask(), second])
    expect(partner.cwds).toHaveLength(1)
    expect(lead.cwds).toHaveLength(2)
    expect(store.events.filter((event) => event.type === 'premium_blocked')).toHaveLength(1)
  }, 120_000)

  it('duo review: one ModelCall per reviewer with its provider, stricter verdict, duo events forwarded', async () => {
    const { deps, repo, store } = await setup(() => finish, [])
    const lead = cli('claude-code', GREET)
    const partner = cli('codex', GREET)
    const reviewer = (verdict: string, inputTokens: number) => async () => ({ result: { verdict, score: verdict === 'approve' ? 90 : 60, summary: verdict, issues: [], requiredFixes: [] }, meta: { model: `m-${inputTokens}`, durationMs: 2, usage: usage(inputTokens) } })
    const orchestrator = new DuoOrchestrator({ ...lead.adapter, reviewResult: reviewer('approve', 700) } as never, { ...partner.adapter, reviewResult: reviewer('request_changes', 800) } as never)
    const runner = new ExecutionRunner({ id: 'run-duo-review', projectKey: 'demo', repoPath: repo, goal: 'Add greet' }, [premiumTask()], { ...deps, orchestrator, settings: { ...deps.settings, premiumReviewPolicy: 'always' as const, reviewFixRounds: 0 } })
    const outcome = await runner.execute()
    expect(outcome.review?.result?.verdict).toBe('request_changes')
    expect(store.calls.filter((call) => call.purpose === 'review').map((call) => [call.provider, call.model, call.status, call.usage.inputTokens])).toEqual([
      ['claude-code', 'm-700', 'ok', 700],
      ['codex', 'm-800', 'ok', 800],
    ])
    expect(store.events.filter((event) => event.type === 'duo_proposal' && event.data?.phase === 'review')).toHaveLength(2)
    expect(store.events.find((event) => event.type === 'duo_reconciled' && event.data?.phase === 'review')).toMatchObject({ data: { winner: 'merged' } })
  }, 120_000)

  it('both failing fails the task, books both calls and removes the sibling', async () => {
    const lead = cli('claude-code', new OrchestratorError('Claude timeout', 'timeout'))
    const partner = cli('codex', new Error('codex crashed'))
    const { outcome, store, leftovers } = await runDuo(lead, partner)
    expect(outcome.status).toBe('failed')
    expect(leftovers).toHaveLength(0)
    expect(store.calls.filter((call) => call.kind === 'orchestrator').map((call) => [call.provider, call.status, call.errorClass]).sort()).toEqual([
      ['claude-code', 'error', 'timeout'],
      ['codex', 'error', 'process_failed'],
    ])
  }, 120_000)
})

describe('load: parallel local agents (measured)', () => {
  // 12 independent tasks, each agent call takes 400 ms in the fake model; real git worktrees and
  // real validation (node --test) per task. Same work with 1 and with 4 local slots.
  const runWith = async (slots: number) => {
    const { deps, repo, worktrees, store } = await setup((request) => {
      const key = taskKeyOf(request) ?? 'task-000'
      const index = Number(key.slice(5))
      return [{ ...write(`src/part${index}.js`, `export const part${index} = ${index}\n`), stallMs: 400 }, finish][toolResults(request)] ?? finish
    })
    deps.settings = { ...deps.settings, localSlots: slots }
    const tasks = Array.from({ length: 12 }, (_, index) => task(`task-${String(index + 1).padStart(3, '0')}`, { newFiles: [`src/part${index + 1}.js`] }))
    const heapBefore = process.memoryUsage().heapUsed
    const started = Date.now()
    const outcome = await new ExecutionRunner({ id: `run-load-${slots}-0200`, projectKey: 'demo', repoPath: repo, goal: 'parts' }, tasks, deps).execute()
    const ms = Date.now() - started
    const left = (await worktrees.listManaged(repo)).filter((entry) => !entry.branch?.endsWith('/integration'))
    await fake?.close()
    fake = undefined
    return { outcome, ms, heapDeltaMb: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024), events: store.events.length, leftoverWorktrees: left.length }
  }

  it('4 slots run the agents concurrently, integrate all 12 results and leave no worktrees', async () => {
    const sequential = await runWith(1)
    const parallel = await runWith(4)
    const metrics = { sequentialMs: sequential.ms, parallelMs: parallel.ms, speedup: Math.round((sequential.ms / parallel.ms) * 100) / 100, events: parallel.events, heapDeltaMb: parallel.heapDeltaMb }
    // measured values for the acceptance report (console output is silenced in the test config)
    if (process.env.MAC_LOAD_RESULT) await fs.writeFile(process.env.MAC_LOAD_RESULT, JSON.stringify(metrics))
    for (const result of [sequential, parallel]) {
      expect(result.outcome.status).toBe('awaiting_approval')
      for (let index = 1; index <= 12; index++) expect(result.outcome.diff).toContain(`src/part${index}.js`)
      expect(result.leftoverWorktrees).toBe(0)
    }
    expect(parallel.ms).toBeLessThan(sequential.ms)
  }, 600_000)
})

describe('hollowChange', () => {
  const diff = (...lines: string[]) => ['--- a/src/style.css', '+++ b/src/style.css', '@@ -1,2 +1,2 @@', ...lines].join('\n')

  it('rejects an attempt that only replaced code with punctuation', () => {
    expect(hollowChange(diff('-@import "bootstrap/dist/css/bootstrap.css";', '+;'), 'Baue alles auf TailwindCSS um')).toContain('only removed code')
  })

  it('accepts real replacements and explicit removal tasks', () => {
    expect(hollowChange(diff('-@import "bootstrap/dist/css/bootstrap.css";', '+@import "tailwindcss";'), 'Baue alles auf TailwindCSS um')).toBeUndefined()
    expect(hollowChange(diff('-import "bootstrap";'), 'Entferne Bootstrap')).toBeUndefined()
  })
})
