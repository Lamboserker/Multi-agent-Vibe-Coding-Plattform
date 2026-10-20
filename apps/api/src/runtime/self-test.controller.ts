import { Controller, Get, Param, Post } from '@nestjs/common'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { git, initRepository } from '@multi-ai-coder/engine'
import { PrismaService } from '../common/prisma.service.js'
import { stringList } from '../common/json.js'
import { ExecutionService } from '../execution/execution.service.js'
import { ProjectsService } from '../projects/projects.service.js'
import { TasksService } from '../tasks/tasks.service.js'
import { runtimeConfig } from './runtime-config.js'

const SAMPLE_FILES: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: 'mac-function-test', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  'src/text.js': "/** Capitalizes the first letter of a string. */\nexport function capitalize(text) {\n  return text.charAt(0).toUpperCase() + text.slice(1)\n}\n",
  'test/text.test.js': "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { capitalize } from '../src/text.js'\n\ntest('capitalize', () => {\n  assert.equal(capitalize('hello'), 'Hello')\n})\n",
  'README.md': '# Multi-AI Coder function test\n\nSample repository used by the setup wizard. Safe to delete.\n',
  '.gitignore': 'node_modules\n',
}

export const SELF_TEST_PROMPT =
  'Add an exported function `slugify(text)` to src/text.js. It lowercases the text, trims it, replaces every run of characters that are not a-z or 0-9 with a single "-", and removes leading/trailing "-". Add test/slugify.test.js using node:test and node:assert/strict with at least three cases (e.g. "Hello World" → "hello-world", "  Multi--AI  Coder! " → "multi-ai-coder", "" → "").'

/**
 * Setup step 7: runs one real, small coding task end to end in a throwaway sample repository
 * (orchestrator planning, local model, patch, worktree, tests, diff). Nothing in the user's
 * projects is touched.
 */
@Controller('self-test')
export class SelfTestController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly tasks: TasksService,
    private readonly executions: ExecutionService,
  ) {}

  @Post()
  async start() {
    const dir = path.join(runtimeConfig().dataDir, 'function-test', `run-${Date.now()}`)
    for (const [file, content] of Object.entries(SAMPLE_FILES)) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
      await fs.writeFile(path.join(dir, file), content, 'utf8')
    }
    await initRepository(dir)
    await git(dir, ['add', '-A'], { internal: true })
    await git(dir, ['commit', '-q', '-m', 'Function test baseline'], { internal: true })
    const project = await this.projects.create({ name: 'Multi-AI Coder Funktionstest', repoPath: dir })
    const task = await this.tasks.create({ projectId: project.id, userPrompt: SELF_TEST_PROMPT })
    await this.executions.requestPlan(task.id, undefined, true)
    return { projectId: project.id, taskId: task.id, repoPath: dir }
  }

  /** Evaluates the checklist for a function-test task from persisted results. */
  @Get(':taskId')
  async status(@Param('taskId') taskId: string) {
    const task = await this.prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      include: { plans: { orderBy: { createdAt: 'desc' }, take: 1 }, subtasks: true, executions: { orderBy: { createdAt: 'desc' }, take: 1, include: { agentRuns: true, modelCalls: true } } },
    })
    const plan = task.plans[0]
    const execution = task.executions[0]
    const localSuccess = execution?.agentRuns.some((run) => run.selectedModelClass === 'local_llm' && run.outcome === 'success')
    const anySuccess = execution?.agentRuns.some((run) => run.outcome === 'success')
    const validation = (execution?.finalValidation ?? {}) as { ok?: boolean; testsPassed?: number; results?: Array<{ kind: string; status: string }> }
    const testsRan = Boolean(validation.results?.some((result) => result.kind === 'test' && result.status === 'passed'))
    const finished = execution ? ['awaiting_approval', 'failed', 'cancelled', 'applied', 'completed', 'interrupted'].includes(execution.status) : ['plan_failed', 'plan_clarification'].includes(task.currentStep)
    const checks = [
      { id: 'orchestrator', label: 'Orchestrator plant die Aufgabe', ok: Boolean(plan && plan.source !== 'deterministic-fallback'), detail: plan ? `Plan-Quelle: ${plan.source}` : 'noch kein Plan' },
      { id: 'local_model', label: 'Lokales Modell erzeugt Code', ok: Boolean(localSuccess), detail: execution ? `${execution.agentRuns.length} Versuch(e); lokal erfolgreich: ${localSuccess ? 'ja' : 'nein'}` : '–' },
      { id: 'patch', label: 'Patch wurde erstellt und geprüft', ok: Boolean(anySuccess && task.subtasks.some((subtask) => subtask.patchText)), detail: `${task.subtasks.filter((subtask) => subtask.patchText).length} Patch(es)` },
      { id: 'worktree', label: 'Isolierter Worktree', ok: Boolean(execution?.integrationBranch && execution.baseCommit), detail: execution?.integrationBranch ?? '–' },
      { id: 'tests', label: 'Tests liefen im Worktree', ok: testsRan && validation.ok === true, detail: validation.results ? `${validation.testsPassed ?? 0} Test(s) bestanden` : '–' },
      { id: 'diff', label: 'Diff liegt zur Anzeige vor', ok: Boolean(execution?.finalDiff), detail: execution?.finalDiff ? `${(execution.finalDiff.match(/^diff --git/gm) ?? []).length} Datei(en)` : '–' },
    ]
    return {
      taskId,
      executionId: execution?.id,
      status: execution?.status ?? task.currentStep,
      finished,
      ok: checks.every((check) => check.ok),
      checks,
      diff: execution?.finalDiff ?? null,
      error: execution?.errorMessage ?? (task.currentStep === 'plan_failed' ? 'Planung fehlgeschlagen' : task.currentStep === 'plan_clarification' ? 'Der Orchestrator hat Rückfragen statt eines Plans geliefert' : null),
      files: task.subtasks.flatMap((subtask) => [...stringList(subtask.allowedFiles), ...stringList(subtask.newFiles)]),
    }
  }
}
