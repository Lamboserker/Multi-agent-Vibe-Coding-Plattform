import { BadRequestException, Injectable } from '@nestjs/common'
import type { CostMode, ModelClass } from '@multi-ai-coder/shared'
import { PrismaService } from '../common/prisma.service.js'
import { SettingsService } from '../runtime/settings.service.js'
import { SessionsService } from '../sessions/sessions.service.js'
import { TasksService } from '../tasks/tasks.service.js'

interface WorkspaceChatInput {
  projectId: string
  taskId?: string
  sessionId?: string
  content: string
  /** "task" plans and executes; "ask" only asks the orchestrator a question. */
  mode?: 'task' | 'ask'
  costMode?: CostMode
  maxCostEuro?: number
  premiumAllowed?: boolean
  allowedModelClasses?: ModelClass[]
  autoRun?: boolean
  clientId?: string
}

/**
 * Task-centric chat entry point (used by the web UI). Every message goes through a persistent
 * session (SessionsService); the task the caller refers to becomes the session's active task.
 */
@Injectable()
export class WorkspaceOrchestratorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly settings: SettingsService,
    private readonly sessions: SessionsService,
  ) {}

  async handleWorkspaceChatMessage(input: WorkspaceChatInput) {
    const content = input.content?.trim()
    if (!content) throw new BadRequestException('Chat message content is required.')
    if (content.length > 50_000) throw new BadRequestException('Message is too long.')
    await this.prisma.project.findUniqueOrThrow({ where: { id: input.projectId } })
    if (input.costMode) await this.settings.update({ costMode: input.costMode })

    let sessionId = input.sessionId
    if (!sessionId && input.taskId) {
      const task = await this.prisma.task.findUniqueOrThrow({ where: { id: input.taskId } })
      sessionId = task.sessionId ?? (await this.sessions.create(input.projectId, task.userPrompt)).id
      await this.prisma.task.update({ where: { id: task.id }, data: { sessionId } })
      await this.prisma.chatSession.update({ where: { id: sessionId }, data: { activeTaskId: task.id } })
    }
    if (!sessionId) sessionId = (await this.sessions.create(input.projectId)).id

    const result = await this.sessions.send(sessionId, { content, mode: input.mode ?? 'task', autoRun: input.autoRun, clientId: input.clientId })
    const session = await this.prisma.chatSession.findUniqueOrThrow({ where: { id: sessionId } })
    const task = session.activeTaskId ? await this.tasks.findOne(session.activeTaskId) : undefined
    return { task, sessionId, messages: [result.message] }
  }

  isRunConfirmation(content: string) {
    return /^(start|run|go|execute|ausführen|ausfuehren|starte|los|ja|ok)\b/i.test(content.trim())
  }
}
