import { Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma.service.js'
import { ExecutionService } from '../execution/execution.service.js'

@Injectable()
export class SubtasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly executions: ExecutionService,
  ) {}

  async run(id: string) {
    const subtask = await this.prisma.subtask.findUniqueOrThrow({ where: { id } })
    return this.executions.start(subtask.taskId)
  }

  async retry(id: string) {
    return this.executions.retryTask(id)
  }

  /** Assigns the task to the premium orchestrator (manual override). */
  async escalate(id: string) {
    return this.executions.setManualModel(id, 'premium')
  }

  /** Manual model assignment: a local model name, "premium", or null for automatic routing. */
  async changeModel(id: string, body: { selectedModelName?: string | null }) {
    return this.executions.setManualModel(id, body.selectedModelName ?? null)
  }
}
