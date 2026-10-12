import { Injectable } from '@nestjs/common'
import { type ModelProvider, ModelClass } from '@prisma/client'
import { defaultAvailability, estimateRunCostEuro, routeModel, type CostMode, type ModelClass as SharedModelClass, type TaskClassification } from '@multi-ai-coder/shared'
import { PrismaService } from '../common/prisma.service.js'

export interface CostRoutingOptions {
  costMode?: CostMode
  maxCostEuro?: number
  allowedModelClasses?: SharedModelClass[]
  premiumAllowed?: boolean
  validationAvailable?: boolean
}

@Injectable()
export class CostRouterService {
  constructor(private readonly prisma: PrismaService) {}

  async route(taskId: string, classification: TaskClassification, options: CostRoutingOptions = {}) {
    const providers = await this.prisma.modelProvider.findMany({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
    })
    const previousCheapFailures = await this.prisma.agentRun.count({
      where: {
        taskId,
        selectedModelClass: ModelClass.cheap_api_llm,
        status: 'failed',
      },
    })

    const availability = defaultAvailability({
      localAvailable: providers.some((provider) => provider.modelClass === ModelClass.local_llm),
      freeQuotaAvailable: providers.some((provider) => provider.modelClass === ModelClass.free_llm),
      cheapApiAvailable: providers.some((provider) => provider.modelClass === ModelClass.cheap_api_llm),
      premiumAllowed: options.premiumAllowed ?? false,
      previousCheapFailures,
    })

    const decision = routeModel({
      classification,
      costMode: options.costMode ?? 'balanced',
      maxCostEuro: options.maxCostEuro,
      allowedModelClasses: options.allowedModelClasses,
      availability,
      validationAvailable: options.validationAvailable ?? true,
    })

    const provider = await this.selectProvider(providers, decision.selectedModelClass)
    const estimatedCostEuro = estimateRunCostEuro(decision.selectedModelClass, decision.estimatedInputTokens, decision.estimatedOutputTokens, {
      modelClass: decision.selectedModelClass,
      costInputPerMillion: provider?.costInputPerMillion ? Number(provider.costInputPerMillion) : null,
      costOutputPerMillion: provider?.costOutputPerMillion ? Number(provider.costOutputPerMillion) : null,
    })

    return {
      ...decision,
      providerId: provider?.id,
      providerName: provider?.name,
      estimatedCostEuro,
    }
  }

  private async selectProvider(providers: ModelProvider[], modelClass: SharedModelClass) {
    if (modelClass === 'no_llm') return undefined

    const candidates = providers.filter((provider) => provider.modelClass === modelClass)
    if (!candidates.length) return undefined

    const usageCounts = await this.prisma.agentRun.groupBy({
      by: ['providerId'],
      where: { providerId: { in: candidates.map((provider) => provider.id) } },
      _count: { providerId: true },
    })
    const usageByProvider = new Map<string, number>()
    for (const row of usageCounts) {
      if (row.providerId) usageByProvider.set(row.providerId, row._count.providerId)
    }

    return [...candidates].sort((a, b) => {
      const usageDelta = (usageByProvider.get(a.id) ?? 0) - (usageByProvider.get(b.id) ?? 0)
      if (usageDelta !== 0) return usageDelta

      const costDelta = this.priceRank(a) - this.priceRank(b)
      if (costDelta !== 0) return costDelta

      return a.createdAt.getTime() - b.createdAt.getTime()
    })[0]
  }

  private priceRank(provider: ModelProvider): number {
    return Number(provider.costInputPerMillion ?? 0) + Number(provider.costOutputPerMillion ?? 0)
  }
}
