import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import type { OrchestratorId } from '@multi-ai-coder/engine'
import { bool, oneOf, str } from '../common/validate.js'
import { PrismaService } from '../common/prisma.service.js'
import { RepoContextService } from '../execution/repo-context.service.js'
import { asJson } from '../common/json.js'
import { OrchestratorService } from './orchestrator.service.js'
import { failedCallRows, modelCallRows } from './model-call.js'
import { answerMetadata, SessionsService } from '../sessions/sessions.service.js'
import { ORCHESTRATOR_OVERRIDES } from './orchestrator-choice.js'

const IDS = ['claude-code', 'codex'] as const

@Controller('orchestrator')
export class OrchestratorController {
  constructor(
    private readonly orchestrators: OrchestratorService,
    private readonly prisma: PrismaService,
    private readonly repoContext: RepoContextService,
    private readonly sessions: SessionsService,
  ) {}

  @Get()
  overview(@Query('refresh') refresh?: string) {
    return this.orchestrators.overview(refresh === '1')
  }

  @Post('select')
  select(@Body() body: unknown) {
    const value = (body as { orchestrator?: unknown })?.orchestrator
    return this.orchestrators.select(value === null ? null : oneOf(body, 'orchestrator', IDS))
  }

  @Post(':id/connect')
  connect(@Param('id') id: string) {
    return this.orchestrators.connect(oneOf({ id }, 'id', IDS))
  }

  @Post(':id/logout')
  logout(@Param('id') id: string) {
    return this.orchestrators.logout(oneOf({ id }, 'id', IDS))
  }

  @Get(':id/status')
  status(@Param('id') id: string) {
    return this.orchestrators.status(oneOf({ id }, 'id', IDS) as OrchestratorId, true)
  }

  /** liveCall=true performs one tiny real model call (consumes a little subscription quota). */
  @Post(':id/diagnose')
  diagnose(@Param('id') id: string, @Body() body: unknown) {
    return this.orchestrators.diagnose(oneOf({ id }, 'id', IDS), bool(body, 'liveCall'))
  }

  @Get(':id/capabilities')
  capabilities(@Param('id') id: string) {
    return this.orchestrators.capabilities(oneOf({ id }, 'id', IDS))
  }

  /**
   * Free-form question, answered synchronously (web UI). The desktop app uses POST /sessions/:id/messages
   * with mode "ask", which runs as a job and survives window reloads. Both persist into a session.
   */
  @Post('chat')
  async chat(@Body() body: unknown) {
    const projectId = str(body, 'projectId', { max: 64 })
    const question = str(body, 'question', { max: 20_000 })
    const taskId = str(body, 'taskId', { optional: true, max: 64 }) || undefined
    const override = (body as { orchestrator?: unknown } | undefined)?.orchestrator == null ? undefined : oneOf(body, 'orchestrator', ORCHESTRATOR_OVERRIDES)
    const { adapter, notice } = await this.orchestrators.activeWithNotice(override)
    if (!adapter) return { ok: false, answer: notice ?? 'Kein Orchestrator verbunden. Bitte Claude Code oder Codex im Einrichtungsassistenten verbinden.' }
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } })
    const { digest } = await this.repoContext.digest(project.id, project.repoPath, question, 4000)
    const history = taskId
      ? (await this.prisma.chatMessage.findMany({ where: { taskId }, orderBy: { createdAt: 'desc' }, take: 8 }))
          .reverse()
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content.slice(0, 2000) }))
      : []
    const sessionId = await this.sessions.sessionForMessage(projectId, taskId)
    await this.prisma.chatMessage.create({ data: { projectId, taskId, sessionId, role: 'user', content: question, metadata: asJson({ kind: 'question', ...(override ? { askOrchestrator: override } : {}) }) } })
    const started = Date.now()
    try {
      const { result, meta } = await adapter.chat({ question, context: digest, history }, { runId: `chat-${projectId}-${Date.now()}`, cwd: project.repoPath, timeoutMs: 5 * 60_000, effort: 'low' })
      for (const data of modelCallRows(adapter.id, meta, { kind: 'orchestrator', purpose: 'chat', status: 'ok', durationMs: meta.durationMs })) {
        await this.prisma.modelCall.create({ data })
      }
      await this.prisma.chatMessage.create({ data: { projectId, taskId, sessionId, role: 'assistant', content: result.answer, metadata: asJson(answerMetadata(adapter, result, meta)) } })
      return { ok: true, answer: result.answer, usage: meta.usage, ...(result.duo ? { duo: result.duo } : {}), ...(notice ? { notice } : {}) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const data of failedCallRows(adapter.id, error, { kind: 'orchestrator', purpose: 'chat', durationMs: Date.now() - started })) {
        await this.prisma.modelCall.create({ data })
      }
      return { ok: false, answer: `Fehler: ${message}` }
    }
  }
}
