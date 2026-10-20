import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import type { OrchestratorId } from '@multi-ai-coder/engine'
import { bool, oneOf, str } from '../common/validate.js'
import { PrismaService } from '../common/prisma.service.js'
import { RepoContextService } from '../execution/repo-context.service.js'
import { asJson } from '../common/json.js'
import { Prisma } from '@prisma/client'
import { OrchestratorService } from './orchestrator.service.js'
import { failedCallFields } from './model-call.js'
import { SessionsService } from '../sessions/sessions.service.js'

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
    const adapter = await this.orchestrators.active()
    if (!adapter) return { ok: false, answer: 'Kein Orchestrator verbunden. Bitte Claude Code oder Codex im Einrichtungsassistenten verbinden.' }
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } })
    const { digest } = await this.repoContext.digest(project.id, project.repoPath, question, 4000)
    const history = taskId
      ? (await this.prisma.chatMessage.findMany({ where: { taskId }, orderBy: { createdAt: 'desc' }, take: 8 }))
          .reverse()
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content.slice(0, 2000) }))
      : []
    const sessionId = await this.sessions.sessionForMessage(projectId, taskId)
    await this.prisma.chatMessage.create({ data: { projectId, taskId, sessionId, role: 'user', content: question, metadata: asJson({ kind: 'question' }) } })
    const started = Date.now()
    try {
      const { result, meta } = await adapter.chat({ question, context: digest, history }, { runId: `chat-${projectId}-${Date.now()}`, cwd: project.repoPath, timeoutMs: 5 * 60_000, effort: 'low' })
      await this.prisma.modelCall.create({
        data: {
          kind: 'orchestrator', provider: adapter.id, model: meta.model ?? adapter.id, purpose: 'chat', status: 'ok', sessionId: meta.sessionId, durationMs: meta.durationMs,
          inputTokens: meta.usage.inputTokens, outputTokens: meta.usage.outputTokens, cachedInputTokens: meta.usage.cachedInputTokens, tokensMeasured: meta.usage.measured,
          apiEquivalentUsd: meta.usage.apiEquivalentUsd === undefined ? undefined : new Prisma.Decimal(meta.usage.apiEquivalentUsd), billing: meta.usage.billing,
        },
      })
      await this.prisma.chatMessage.create({ data: { projectId, taskId, sessionId, role: 'assistant', content: result.answer, metadata: asJson({ kind: 'answer', orchestrator: adapter.id }) } })
      return { ok: true, answer: result.answer, usage: meta.usage }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.prisma.modelCall.create({ data: { kind: 'orchestrator', provider: adapter.id, purpose: 'chat', status: 'error', errorClass: (error as { kind?: string }).kind, durationMs: Date.now() - started, ...failedCallFields(error, adapter.id) } })
      return { ok: false, answer: `Fehler: ${message}` }
    }
  }
}
