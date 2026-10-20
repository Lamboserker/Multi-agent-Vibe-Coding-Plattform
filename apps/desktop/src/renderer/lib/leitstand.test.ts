import { describe, expect, it } from 'vitest'
import { addedLines, parseUnifiedDiff } from './diff'
import { agentCards, decisions, localizeReason, milestones, shortModel, stageInfo, tokenShare } from './leitstand'
import type { ExecutionRun, RunEvent, Subtask, Task, TaskPlan } from './types'

const subtask = (key: string, patch: Partial<Subtask> = {}): Subtask => ({
  id: `id-${key}`, taskId: 'task', key, title: `Aufgabe ${key}`, goal: '', status: 'planned', selectedModelClass: 'local_llm', selectedModelName: 'qwen2.5-coder:14b', allowedFiles: [`src/${key}.ts`], newFiles: [], dependsOn: [],
  category: 'implementation', complexityScore: 2, riskScore: 1, acceptanceCriteria: [], expectedInputTokens: 0, suggestedExecutor: 'local', attempts: 0, patchStats: {}, validation: {}, ...patch,
})
const event = (type: string, message: string, patch: Partial<RunEvent> = {}): RunEvent => ({ id: type + message, level: 'info', type, message, data: {}, createdAt: '2026-10-16T08:00:00.000Z', ...patch })
const plan: TaskPlan = { id: 'plan', summary: '', source: 'claude-code', classification: {}, dag: {}, createdAt: '2026-10-16T07:59:00.000Z', modelAssignments: [
  { key: 'T1', subtaskId: 'id-T1', executor: 'local', model: 'qwen2.5-coder:14b', tier: 'balanced', reasons: ['Moderate complexity/risk (3/2).'], requiresApproval: false },
  { key: 'T2', subtaskId: 'id-T2', executor: 'premium', tier: 'premium', reasons: ['High risk (4/5, security-critical files, category security).'], requiresApproval: false },
] }

describe('parseUnifiedDiff', () => {
  it('splits files and numbers added/removed lines', () => {
    const files = parseUnifiedDiff([
      'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,3 +1,4 @@', ' import x', '-const a = 1', '+const a = 2', '+const b = 3', ' export {}',
      'diff --git a/test/new.test.ts b/test/new.test.ts', 'new file mode 100644', '--- /dev/null', '+++ b/test/new.test.ts', '@@ -0,0 +1,2 @@', '+it()', '+it()',
    ].join('\n'))
    expect(files.map((file) => [file.path, file.status, file.added, file.deleted])).toEqual([['src/a.ts', 'modified', 2, 1], ['test/new.test.ts', 'added', 2, 0]])
    expect(files[0]!.lines.find((line) => line.kind === 'del')).toMatchObject({ oldLine: 2 })
    expect(addedLines(files[0]!)).toEqual([2, 3])
    expect(addedLines(files[1]!)).toEqual([1, 2])
  })

  it('handles renames, binaries and empty input', () => {
    const files = parseUnifiedDiff('diff --git a/old.png b/new.png\nsimilarity index 100%\nrename from old.png\nrename to new.png\nBinary files a/old.png and b/new.png differ')
    expect(files[0]).toMatchObject({ path: 'new.png', oldPath: 'old.png', status: 'renamed', binary: true })
    expect(parseUnifiedDiff(undefined)).toEqual([])
  })
})

describe('leitstand derivations', () => {
  it('maps the workflow to stage label, tone and phase', () => {
    expect(stageInfo(undefined, undefined)).toMatchObject({ state: 'draft', label: 'Neue Sitzung', phase: 0 })
    const task = { id: 'task', currentStep: 'planning', subtasks: [] } as unknown as Task
    expect(stageInfo(task, undefined)).toMatchObject({ state: 'planning', tone: 'accent', phase: 1 })
    const run = { taskId: 'task', status: 'awaiting_approval' } as ExecutionRun
    expect(stageInfo({ ...task, currentStep: 'awaiting_approval' }, run)).toMatchObject({ state: 'approval', phase: 3 })
    expect(stageInfo({ ...task, currentStep: 'plan_clarification' }, run)).toMatchObject({ state: 'plan_questions', tone: 'tool', phase: 1 })
  })

  it('builds agent cards with kind, role, forecast wait and checks', () => {
    const cards = agentCards({
      subtasks: [subtask('T1', { status: 'completed', commitSha: 'abc', validation: { ok: true, testsPassed: 4, testsFailed: 0, summary: '', results: [{ id: 'test', kind: 'test', command: 'vitest', status: 'passed', blocking: true, durationMs: 1, testsPassed: 4, testsFailed: 0, output: '' }] } }), subtask('T2', { selectedModelClass: 'premium_llm', selectedModelName: 'Claude Code' }), subtask('T3', { dependsOn: ['T1'] })],
      plan,
      events: [event('worktree_created', 'T1: worktree at abc.', { subtaskId: 'id-T1', data: { path: 'C:/wt/t1' } }), event('task_integrated', 'T1: integrated (1 file(s), tests 4 passed).', { subtaskId: 'id-T1' })],
      forecast: { waves: [], tasks: { T3: { wave: 1, reason: 'dependencies', waitsFor: ['T1'], detail: 'wartet auf T1', critical: true } }, criticalPath: ['T3'], estimatedMs: 0, maxParallel: 1, warnings: [], slots: { local: 1, premium: 1 }, vramBytes: null, measuredDurations: 0, generatedAt: '' },
    })
    expect(cards[0]).toMatchObject({ kind: 'local', agent: 'Coder Balanced', role: 'Balanced (lokal)', short: '14b', worktree: 'C:/wt/t1', progress: 1, statusTone: 'ok' })
    expect(cards[0]!.checks).toEqual([{ label: 'Patch-Check', state: 'ok', detail: 'ok' }, { label: 'Tests', state: 'ok', detail: '4/4' }])
    expect(cards[1]).toMatchObject({ kind: 'premium', tone: 'accent', short: 'Premium' })
    expect(cards[1]!.role).toContain('hohes Risiko (4/5, sicherheitskritische Dateien')
    expect(cards[2]).toMatchObject({ waitDetail: 'wartet auf T1', lastLog: 'wartet auf T1', wave: 1, critical: true })
  })

  it('treats a manual premium escalation as premium work', () => {
    const [card] = agentCards({ subtasks: [subtask('T1', { manualModel: 'premium' })] })
    expect(card).toMatchObject({ kind: 'premium', escalated: true, role: 'Eskaliert an Premium (manuell)' })
  })

  it('collects decisions and chat milestones from plan and events', () => {
    const subtasks = [subtask('T1'), subtask('T2', { selectedModelClass: 'premium_llm' }), subtask('T3', { dependsOn: ['T1', 'T2'] })]
    const events = [event('validation_failed', 'T2: typecheck failed', { subtaskId: 'id-T2', createdAt: '2026-10-16T08:05:00.000Z' }), event('task_integrated', 'T1: integrated (2 file(s), tests 12 passed).', { subtaskId: 'id-T1' })]
    const list = decisions({ plan, subtasks, events }).map((entry) => entry.text)
    expect(list[0]).toContain('T2 an Premium: hohes Risiko')
    expect(list).toContain('T3 wartet auf T1, T2, weil es deren Ergebnis braucht.')
    expect(list.at(-1)).toContain('T2: Prüfung rot')
    expect(milestones(events, subtasks)).toEqual([
      { at: events[0]!.createdAt, key: 'T2', text: 'Prüfung fehlgeschlagen, Reparatur folgt', tone: 'tool' },
      { at: events[1]!.createdAt, key: 'T1', text: 'fertig · integriert · 2 Datei(en) · 12 Tests ok', tone: 'local' },
    ])
  })

  it('formats model names, reasons and the local token share', () => {
    expect(shortModel('qwen2.5-coder:14b', 'local')).toBe('14b')
    expect(shortModel('anything', 'premium')).toBe('Premium')
    expect(localizeReason('Complexity 5/5.')).toBe('Komplexität 5/5')
    expect(localizeReason('Something else.')).toBe('Something else')
    const usage = { local: { inputTokens: 800, outputTokens: 60 }, premium: { inputTokens: 100, outputTokens: 40 } }
    expect(tokenShare({ usage } as unknown as ExecutionRun)).toEqual({ localPct: 86, total: 1000 })
    expect(tokenShare(undefined)).toEqual({ localPct: 0, total: 0 })
  })
})
