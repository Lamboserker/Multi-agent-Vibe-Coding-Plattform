import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { currentBranch, git, headCommit, status } from '../git/git.js'
import { WorktreeManager } from '../git/worktrees.js'
import { buildRepoIndex } from '../index/repo-index.js'
import { applyChangeSet, revertChangeSet } from '../integration/integrator.js'
import { OllamaClient } from '../ollama/client.js'
import { startFakeOllama, type FakeChatReply, type FakeChatRequest, type FakeOllama } from '../testing/fake-ollama.js'
import { createTempRepo, tempDir } from '../test-utils.js'
import { detectValidationChecks } from '../validation/checks.js'
import {
  DEFAULT_ENGINE_SETTINGS,
  ExecutionRunner,
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
    settings: { ...DEFAULT_ENGINE_SETTINGS, premiumReviewPolicy: 'never' as const, localSlots: 1 },
  }
  return { repo, store, worktrees, deps }
}

describe('ExecutionRunner (real git, real validation, scripted model)', () => {
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
    expect(await fs.readFile(path.join(repo, 'src', 'math.js'), 'utf8')).toContain('my local edit')

    // fast-forward is refused as well; the branch mode leaves the checkout untouched
    expect((await applyChangeSet({ repoPath: repo, integrationWorktree: run.integrationWorktree as string, integrationBranch: run.integrationBranch as string, baseCommit: run.baseCommit as string, mode: 'fast_forward' })).ok).toBe(false)
    const branch = await applyChangeSet({ repoPath: repo, integrationWorktree: run.integrationWorktree as string, integrationBranch: run.integrationBranch as string, baseCommit: run.baseCommit as string, mode: 'branch' })
    expect(branch.ok).toBe(true)
    expect(await headCommit(repo)).toBe(run.baseCommit)
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
