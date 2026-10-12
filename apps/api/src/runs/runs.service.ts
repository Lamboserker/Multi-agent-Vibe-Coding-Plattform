import { Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma.service.js'

@Injectable()
export class RunsService {
  constructor(private readonly prisma: PrismaService) {}

  async findOne(id: string) {
    return this.prisma.agentRun.findUniqueOrThrow({
      where: { id },
      include: { provider: true, reviews: true, subtask: true, task: true },
    })
  }

  async logs(id: string) {
    const run = await this.prisma.agentRun.findUniqueOrThrow({ where: { id } })
    return {
      runId: id,
      currentStep: run.currentStep,
      status: run.status,
      logs: run.logs,
    }
  }

  async diff(id: string) {
    const run = await this.prisma.agentRun.findUniqueOrThrow({ where: { id } })
    return {
      runId: id,
      patchStatus: run.patchStatus,
      patchText: run.patchText,
      diffSummary: run.diffSummary,
    }
  }

  async validation(id: string) {
    const run = await this.prisma.agentRun.findUniqueOrThrow({ where: { id } })
    return {
      runId: id,
      validationStatus: run.validationStatus,
      validationResults: run.validationResults,
    }
  }
}
