import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { estimateRuntimeMemory, forecastSchedule, runtimeContextTokens, showFileAt, usableVramMb, type ForecastExecutor, type ForecastTask } from '@multi-ai-coder/engine'
import { asJson, stringList } from '../common/json.js'
import { PrismaService } from '../common/prisma.service.js'
import { LocalModelsService } from '../local-models/local-models.service.js'
import { EventBusService } from '../runtime/event-bus.service.js'
import { SettingsService } from '../runtime/settings.service.js'
import { ExecutionService } from './execution.service.js'

const HINT_PREFIX = 'Hinweis vom Nutzer: '
const ACTIVE_RUNS = ['pending', 'running', 'paused', 'integrating']

/**
 * Planning insights on top of the plan and the run: execution forecast (waves, waiting reasons,
 * VRAM), user hints for single subtasks and the agent version of a changed file.
 */
@Injectable()
export class PlanInsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly localModels: LocalModelsService,
    private readonly executions: ExecutionService,
    private readonly events: EventBusService,
  ) {}

  async forecast(taskId: string) {
    const subtasks = await this.prisma.subtask.findMany({ where: { taskId }, orderBy: [{ createdAt: 'asc' }, { priority: 'desc' }] })
    if (!subtasks.length) throw new NotFoundException('The task has no plan yet.')
    const [settings, hardware, localSlots, installed, stats] = await Promise.all([
      this.settings.get(),
      this.localModels.hardware(),
      this.localModels.localSlots().catch(() => 1),
      this.localModels.installed().catch(() => []),
      this.executions.suitability().catch(() => []),
    ])
    const tasks: ForecastTask[] = subtasks.map((subtask) => {
      const executor: ForecastExecutor = subtask.fastPath ? 'none' : subtask.manualModel === 'premium' || subtask.selectedModelClass === 'premium_llm' ? 'premium' : subtask.selectedModelClass === 'local_llm' ? 'local' : 'blocked'
      const model = executor === 'local' ? subtask.manualModel ?? subtask.selectedModelName ?? undefined : undefined
      const weights = installed.find((entry) => entry.name === model)
      const measured = stats.filter((entry) => entry.model === (executor === 'premium' ? 'premium' : model) && entry.attempts >= 2)
      const sameCategory = measured.find((entry) => entry.category === subtask.category)
      const average = sameCategory?.avgDurationMs ?? (measured.length ? measured.reduce((sum, entry) => sum + entry.avgDurationMs, 0) / measured.length : undefined)
      return {
        id: subtask.key || subtask.id,
        dependsOn: stringList(subtask.dependsOn),
        writes: [...stringList(subtask.allowedFiles), ...stringList(subtask.newFiles)],
        executor,
        model,
        memoryBytes: weights ? estimateRuntimeMemory(weights.sizeBytes, runtimeContextTokens(settings.numCtx, weights.contextLength, weights.sizeBytes, hardware)) : undefined,
        estimatedMs: average ? Math.round(average) : undefined,
        status: subtask.status,
      }
    })
    const vramMb = usableVramMb(hardware)
    const slots = { local: localSlots, premium: settings.premiumParallelism }
    return {
      ...forecastSchedule({ tasks, slots, vramBytes: vramMb ? vramMb * 1024 * 1024 : undefined }),
      slots,
      vramBytes: vramMb ? vramMb * 1024 * 1024 : null,
      measuredDurations: tasks.filter((task) => task.estimatedMs !== undefined).length,
      generatedAt: new Date().toISOString(),
    }
  }

  /**
   * A hint for one subtask. It becomes an acceptance criterion and therefore part of the agent's
   * task description. A running run keeps the task it loaded at start: there the hint applies to the
   * next attempt that is started from the database (retry, resume, next run).
   */
  async addHint(subtaskId: string, text: string) {
    const hint = text.trim().replace(/\s+/g, ' ')
    if (!hint) throw new BadRequestException('The hint is empty.')
    const subtask = await this.prisma.subtask.findUnique({ where: { id: subtaskId }, include: { task: { select: { id: true, sessionId: true, executions: { where: { status: { in: ACTIVE_RUNS as never } }, select: { id: true } } } } } })
    if (!subtask) throw new NotFoundException('Subtask not found.')
    const criteria = stringList(subtask.acceptanceCriteria).filter((entry) => entry !== `${HINT_PREFIX}${hint}`)
    const updated = await this.prisma.subtask.update({ where: { id: subtaskId }, data: { acceptanceCriteria: asJson([...criteria, `${HINT_PREFIX}${hint}`]) } })
    const runActive = subtask.task.executions.length > 0
    const appliesTo = runActive ? 'next_attempt' : subtask.status === 'completed' ? 'retry' : 'start'
    this.events.publish('run', 'subtask_hint', { taskId: subtask.taskId, subtaskId, sessionId: subtask.task.sessionId, key: subtask.key, appliesTo }, subtask.taskId)
    return {
      subtask: updated,
      appliesTo,
      message: appliesTo === 'start' ? 'Der Hinweis ist Teil der Aufgabe, sobald sie startet.' : appliesTo === 'retry' ? 'Die Teilaufgabe ist fertig; der Hinweis wirkt, wenn du sie wiederholst.' : 'Der laufende Agent arbeitet mit dem Stand vom Start; der Hinweis wirkt beim nächsten Versuch (Wiederholen, Fortsetzen oder nächste Ausführung).',
    }
  }

  async removeHint(subtaskId: string, text: string) {
    const subtask = await this.prisma.subtask.findUnique({ where: { id: subtaskId } })
    if (!subtask) throw new NotFoundException('Subtask not found.')
    const criteria = stringList(subtask.acceptanceCriteria).filter((entry) => entry !== `${HINT_PREFIX}${text.trim()}` && entry !== text)
    return this.prisma.subtask.update({ where: { id: subtaskId }, data: { acceptanceCriteria: asJson(criteria) } })
  }

  /** The file as the agents left it on the integration branch, next to its state at the run's base. */
  async executionFile(executionId: string, file: string) {
    const relative = file.replaceAll('\\', '/').replace(/^\.\/+/, '')
    if (!relative || relative.startsWith('/') || /^[a-z]:/i.test(relative) || relative.split('/').some((part) => part === '..' || part === '.git')) throw new BadRequestException('Invalid path.')
    const run = await this.prisma.executionRun.findUnique({ where: { id: executionId }, include: { project: { select: { repoPath: true } } } })
    if (!run) throw new NotFoundException('Execution not found.')
    const revision = run.integrationCommit ?? run.integrationBranch ?? undefined
    const [base, result] = await Promise.all([
      run.baseCommit ? showFileAt(run.project.repoPath, run.baseCommit, relative) : Promise.resolve(undefined),
      revision ? showFileAt(run.project.repoPath, revision, relative) : Promise.resolve(undefined),
    ])
    return { path: relative, base: base ?? null, result: result ?? null, revision: revision ?? null, baseCommit: run.baseCommit ?? null }
  }
}
