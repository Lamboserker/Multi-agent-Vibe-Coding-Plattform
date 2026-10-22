import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DuoOrchestrator, type ExecutionPlan } from '@multi-ai-coder/engine'
import { ExecutionService, premiumByProvider } from './execution.service.js'

const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 10, cachedInputTokens: 0, measured: true, billing: 'subscription' as const })
const plannedTask = (id: string) => ({
  id, title: `Task ${id}`, description: 'Write the docs', category: 'docs', complexity: 1, risk: 1, relevantFiles: ['README.md'], newFiles: [], dependsOn: [], capabilities: [],
  acceptanceCriteria: ['Docs updated.'], testStrategy: 'none', expectedInputTokens: 1000, suggestedExecutor: 'local' as const, rationale: 'r', agent: '', skills: [],
})
const plan = (summary: string, tasks: number): ExecutionPlan => ({
  summary,
  analysis: { summary: 's', taskType: 'docs', complexity: 1, risk: 1, securitySensitive: false, affectedAreas: [], needsDecomposition: false, openQuestions: [] },
  tasks: Array.from({ length: tasks }, (_, index) => plannedTask(`task-00${index + 1}`)),
  warnings: [],
})

/** A duo of two fake CLIs (no process); the lead cannot reconcile, so its own plan is used. */
function duo() {
  const side = (id: 'claude-code' | 'codex', displayName: string, result: ExecutionPlan, tokens: number) => ({ id, displayName, createPlan: vi.fn().mockResolvedValue({ result, meta: { sessionId: `${id}-s`, model: `${id}-m`, durationMs: 3, usage: usage(tokens) } }) })
  return new DuoOrchestrator(side('claude-code', 'Claude Code', plan('Lead plan', 2), 100) as never, side('codex', 'Codex', plan('Partner plan', 1), 50) as never)
}

function fixture(resolved: { adapter?: unknown; notice?: string }) {
  const chat = vi.fn().mockResolvedValue(undefined)
  const modelCallCreate = vi.fn().mockResolvedValue({})
  const taskPlanCreate = vi.fn().mockResolvedValue({ id: 'plan' })
  const prisma = {
    task: { update: vi.fn().mockResolvedValue({}), findUniqueOrThrow: vi.fn().mockResolvedValue({ projectId: 'p', project: { name: 'repo', repoPath: 'C:/repo' }, userPrompt: 'Schreibe die Doku' }) },
    chatMessage: { findMany: vi.fn().mockResolvedValue([{ metadata: { orchestrator: 'duo' } }]) },
    modelCall: { create: modelCallCreate },
    subtask: { deleteMany: vi.fn().mockResolvedValue({}), create: vi.fn().mockImplementation(async ({ data }) => data) },
    taskPlan: { create: taskPlanCreate },
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  }
  const activeWithNotice = vi.fn().mockResolvedValue(resolved)
  const settings = { get: vi.fn().mockResolvedValue({ modelRoles: {}, fastPath: false, costMode: 'balanced', maxTasks: 8, planApproval: true, autoStartSmallPlans: false }) }
  const localModels = { warmup: vi.fn().mockResolvedValue(undefined), engineProfiles: vi.fn().mockResolvedValue([]) }
  const repoContext = { digest: vi.fn().mockResolvedValue({ index: { files: [] }, checks: [], digest: { summary: 'digest', tokenEstimate: 1 } }) }
  const events = { publish: vi.fn() }
  const service = new ExecutionService(prisma as never, settings as never, { activeWithNotice, invalidate: vi.fn() } as never, localModels as never, repoContext as never, {} as never, events as never)
  Object.assign(service as object, { previewRouting: vi.fn().mockResolvedValue({ assignments: [] }), chat })
  return { service, prisma, chat, modelCallCreate, taskPlanCreate, activeWithNotice, events }
}

describe('duo planning', () => {
  it("plans with the task's choice, posts the duo reconciliation and labels the plan source", async () => {
    const { service, chat, modelCallCreate, taskPlanCreate, activeWithNotice, events } = fixture({ adapter: duo() })
    const result = await service.plan('task')
    expect(activeWithNotice).toHaveBeenCalledWith('duo')
    expect(result.source).toBe('duo:claude-code+codex')
    expect(taskPlanCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ source: 'duo:claude-code+codex' }) })
    expect(events.publish).toHaveBeenCalledWith('run', 'plan_context_ready', expect.objectContaining({ orchestrator: 'duo:claude-code+codex' }))
    const reconciled = chat.mock.calls.find((call) => call[3]?.kind === 'duo_reconciled')!
    expect(reconciled[1]).toBe('assistant')
    expect(reconciled[2]).toContain('**Duo-Abgleich (Plan)** – Claude Code + Codex')
    expect(reconciled[3]).toMatchObject({
      phase: 'plan',
      lead: 'claude-code',
      partner: 'codex',
      proposals: [{ provider: 'claude-code', summary: expect.stringContaining('2 Task(s): Lead plan') }, { provider: 'codex', summary: expect.stringContaining('1 Task(s): Partner plan') }],
      winner: 'claude-code',
      fallback: expect.stringContaining('kann Pläne nicht zusammenführen'),
    })
    const planMessage = chat.mock.calls.find((call) => call[3]?.kind === 'task_plan')!
    expect(planMessage[2]).toContain('**Plan von Claude Code + Codex**')
    // the reconciliation comes before the plan in the chat
    expect(chat.mock.calls.indexOf(reconciled)).toBeLessThan(chat.mock.calls.indexOf(planMessage))
    // one booking per CLI call
    expect(modelCallCreate.mock.calls.map(([{ data }]) => [data.provider, data.inputTokens])).toEqual([['claude-code', 100], ['codex', 50]])
  })

  it('posts the duo hint once and plans with the remaining CLI', async () => {
    const createPlan = vi.fn().mockResolvedValue({ result: plan('Solo', 1), meta: { durationMs: 1, usage: usage(5) } })
    const notice = 'Duo-Modus nicht möglich: Codex ist nicht angemeldet – Claude Code arbeitet allein.'
    const { service, chat, taskPlanCreate } = fixture({ adapter: { id: 'claude-code', displayName: 'Claude Code', createPlan }, notice })
    await service.plan('task')
    expect(chat).toHaveBeenCalledWith('task', 'system', notice, { kind: 'orchestrator_notice' })
    expect(chat.mock.calls.some((call) => call[3]?.kind === 'duo_reconciled')).toBe(false)
    expect(taskPlanCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ source: 'claude-code' }) })
  })
})

describe('duo runs', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'mac-duo-run-'))
  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  it("stores 'duo:<lead>+<partner>' as the run's orchestrator", async () => {
    writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: repo })
    const created = vi.fn().mockImplementation(async ({ data }) => ({ id: 'run-1', ...data }))
    const active = vi.fn().mockResolvedValue(duo())
    const prisma = {
      task: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'task', projectId: 'p', currentStep: 'awaiting_plan_approval', subtasks: [{ id: 's' }], project: { repoPath: repo } }), update: vi.fn().mockResolvedValue({}) },
      executionRun: { findFirst: vi.fn().mockResolvedValue(null), create: created },
      subtask: { updateMany: vi.fn().mockResolvedValue({}) },
      chatMessage: { findMany: vi.fn().mockResolvedValue([{ metadata: { orchestrator: 'duo' } }]) },
    }
    const settings = { get: vi.fn().mockResolvedValue({ costMode: 'balanced', approvalMode: 'manual', premiumExecutionAllowed: true }) }
    const jobs = { enqueue: vi.fn().mockResolvedValue({ id: 'job' }) }
    const service = new ExecutionService(prisma as never, settings as never, { active } as never, {} as never, {} as never, jobs as never, { publish: vi.fn() } as never)
    await service.start('task')
    expect(active).toHaveBeenCalledWith('duo')
    expect(created).toHaveBeenCalledWith({ data: expect.objectContaining({ orchestrator: 'duo:claude-code+codex' }) })
  })
})

describe('premiumByProvider', () => {
  it('sums premium calls per provider and ignores local calls', () => {
    const call = (kind: 'orchestrator' | 'local', provider: string, status: string, inputTokens: number) => ({ kind, provider, status, inputTokens, outputTokens: 1, cachedInputTokens: 0 })
    expect(premiumByProvider([call('orchestrator', 'claude-code', 'ok', 10), call('orchestrator', 'codex', 'error', 5), call('orchestrator', 'claude-code', 'ok', 3), call('local', 'ollama', 'ok', 99)])).toEqual({
      'claude-code': { calls: 2, failedCalls: 0, inputTokens: 13, outputTokens: 2, cachedInputTokens: 0 },
      codex: { calls: 1, failedCalls: 1, inputTokens: 5, outputTokens: 1, cachedInputTokens: 0 },
    })
  })
})
