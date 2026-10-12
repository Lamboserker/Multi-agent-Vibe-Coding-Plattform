import { Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma.service.js'

@Injectable()
export class CostsService {
  constructor(private readonly prisma: PrismaService) {}

  async taskCost(taskId: string) {
    const runs = await this.prisma.agentRun.findMany({ where: { taskId }, include: { provider: true } })
    const totalEstimated = runs.reduce((sum, run) => sum + Number(run.estimatedCostEuro), 0)
    const totalActual = runs.reduce((sum, run) => sum + Number(run.actualCostEuro ?? 0), 0)
    return {
      taskId,
      totalEstimatedCostEuro: this.round(totalEstimated),
      totalActualCostEuro: this.round(totalActual),
      byModelClass: this.groupBy(runs, (run) => run.selectedModelClass, (run) => Number(run.estimatedCostEuro)),
      byProvider: this.groupBy(runs, (run) => run.provider?.name ?? 'unassigned', (run) => Number(run.estimatedCostEuro)),
      runs,
    }
  }

  async summary() {
    const runs = await this.prisma.agentRun.findMany({ include: { provider: true } })
    return {
      totalEstimatedCostEuro: this.round(runs.reduce((sum, run) => sum + Number(run.estimatedCostEuro), 0)),
      totalActualCostEuro: this.round(runs.reduce((sum, run) => sum + Number(run.actualCostEuro ?? 0), 0)),
      totalRuns: runs.length,
      byModelClass: this.groupBy(runs, (run) => run.selectedModelClass, (run) => Number(run.estimatedCostEuro)),
      byProvider: this.groupBy(runs, (run) => run.provider?.name ?? 'unassigned', (run) => Number(run.estimatedCostEuro)),
      premiumRuns: runs.filter((run) => run.selectedModelClass === 'premium_llm').length,
      freeOrLocalRuns: runs.filter((run) => ['no_llm', 'local_llm', 'free_llm'].includes(run.selectedModelClass)).length,
    }
  }

  private groupBy<T>(items: T[], key: (item: T) => string, value: (item: T) => number) {
    const grouped: Record<string, number> = {}
    for (const item of items) {
      const group = key(item)
      grouped[group] = this.round((grouped[group] ?? 0) + value(item))
    }
    return grouped
  }

  private round(value: number) {
    return Math.round(value * 100_000) / 100_000
  }
}
