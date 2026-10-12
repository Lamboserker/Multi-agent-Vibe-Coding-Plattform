import { Injectable } from '@nestjs/common'
import type { CostTier, TaskClassification, TaskType } from '@multi-ai-coder/shared'
import type { RepoScanSummary } from './repo-scanner.service.js'

@Injectable()
export class TaskAnalyzerService {
  analyze(userPrompt: string, repo?: RepoScanSummary): TaskClassification {
    const prompt = userPrompt.trim()
    const lower = prompt.toLowerCase()
    const affectedAreas = this.detectAffectedAreas(lower, repo)
    const taskType = this.detectTaskType(lower, affectedAreas)
    const securitySensitive = affectedAreas.some((area) => ['auth', 'payment', 'security'].includes(area))
    const deterministicOnly = this.isDeterministicOnly(lower)
    const complexity = this.detectComplexity(lower, taskType, affectedAreas, deterministicOnly)
    const riskLevel = this.detectRisk(lower, taskType, complexity, securitySensitive, affectedAreas)
    const contextNeed = this.detectContextNeed(lower, taskType, complexity, affectedAreas)
    const estimatedCostTier = this.toCostTier(complexity, riskLevel, deterministicOnly, securitySensitive)

    return {
      normalizedGoal: this.normalizeGoal(prompt),
      complexity,
      taskType,
      riskLevel,
      contextNeed,
      securitySensitive,
      estimatedCostTier,
      deterministicOnly,
      affectedAreas,
      reason: this.explain(complexity, taskType, riskLevel, contextNeed, affectedAreas, deterministicOnly),
    }
  }

  private detectAffectedAreas(prompt: string, repo?: RepoScanSummary): string[] {
    const areas = new Set<string>()
    const matches: Array<[string, RegExp]> = [
      ['frontend', /\b(ui|react|component|css|style|page|form|button|dashboard|frontend)\b/],
      ['backend', /\b(api|controller|service|endpoint|server|backend|nest|express)\b/],
      ['database', /\b(database|db|prisma|schema|migration|query|sql|postgres)\b/],
      ['auth', /\b(auth|login|jwt|session|oauth|permission|role|password)\b/],
      ['payment', /\b(payment|stripe|billing|iap|apple|credit|checkout|invoice)\b/],
      ['security', /\b(secret|token|csrf|xss|injection|encryption|security|vulnerability)\b/],
      ['devops', /\b(docker|ci|deploy|pipeline|kubernetes|redis|queue|bullmq)\b/],
      ['test', /\b(test|spec|coverage|vitest|jest|playwright|lint|typecheck)\b/],
      ['documentation', /\b(readme|docs|documentation|adr|comment)\b/],
      ['architecture', /\b(architecture|orchestrator|routing|design|refactor|module boundary)\b/],
    ]

    for (const [area, pattern] of matches) {
      if (pattern.test(prompt)) areas.add(area)
    }

    if (repo?.databaseSchemas.length && /\b(database|db|prisma|schema|migration|query|sql|postgres)\b/.test(prompt)) {
      areas.add('database')
    }
    if (areas.size === 0) areas.add('code')
    return [...areas]
  }

  private detectTaskType(prompt: string, areas: string[]): TaskType {
    if (areas.includes('database')) return 'database'
    if (areas.includes('devops')) return 'devops'
    if (areas.includes('test')) return 'test'
    if (areas.includes('documentation')) return 'documentation'
    if (/\brefactor|rename|cleanup|extract\b/.test(prompt)) return 'refactor'
    if (areas.includes('frontend') && areas.includes('backend')) return 'fullstack'
    if (areas.includes('frontend')) return 'frontend'
    if (areas.includes('backend') || areas.includes('auth') || areas.includes('payment')) return 'backend'
    return 'unknown'
  }

  private detectComplexity(prompt: string, taskType: TaskType, areas: string[], deterministicOnly: boolean) {
    if (deterministicOnly) return 'trivial' as const
    let score = 0
    if (prompt.length > 500) score += 2
    if (prompt.length > 1200) score += 2
    if (areas.length >= 3) score += 2
    if (taskType === 'fullstack' || taskType === 'database') score += 2
    if (areas.includes('architecture') || areas.includes('payment') || areas.includes('auth')) score += 2
    if (/\b(new system|from scratch|rewrite|migration|multi-step|complex|critical)\b/.test(prompt)) score += 3
    if (/\b(fix|bug|add|create|implement)\b/.test(prompt)) score += 1

    if (score >= 8) return 'critical' as const
    if (score >= 6) return 'complex' as const
    if (score >= 3) return 'medium' as const
    return 'small' as const
  }

  private detectRisk(
    prompt: string,
    taskType: TaskType,
    complexity: TaskClassification['complexity'],
    securitySensitive: boolean,
    areas: string[],
  ) {
    if (securitySensitive || areas.includes('payment') || /\b(secret|permission|prod|production)\b/.test(prompt)) {
      return 'critical' as const
    }
    if (taskType === 'database' || areas.includes('devops') || complexity === 'critical') return 'high' as const
    if (complexity === 'complex' || taskType === 'fullstack') return 'medium' as const
    return 'low' as const
  }

  private detectContextNeed(prompt: string, taskType: TaskType, complexity: TaskClassification['complexity'], areas: string[]) {
    if (complexity === 'critical' || taskType === 'fullstack' || areas.includes('architecture')) return 'high' as const
    if (complexity === 'complex' || taskType === 'database' || prompt.length > 500) return 'high' as const
    if (complexity === 'medium' || areas.length > 1) return 'medium' as const
    return 'low' as const
  }

  private isDeterministicOnly(prompt: string): boolean {
    const asksForStaticAction = /\b(scan|analyze|analyse|list|find|show|detect|run tests|typecheck|lint|diff)\b/.test(prompt)
    const asksForCodeChange = /\b(add|create|implement|fix|change|update|refactor|remove|build)\b/.test(prompt)
    return asksForStaticAction && !asksForCodeChange
  }

  private toCostTier(
    complexity: TaskClassification['complexity'],
    riskLevel: TaskClassification['riskLevel'],
    deterministicOnly: boolean,
    securitySensitive: boolean,
  ): CostTier {
    if (deterministicOnly) return 'free'
    if (securitySensitive || riskLevel === 'critical') return 'premium'
    if (complexity === 'complex' || riskLevel === 'high') return 'medium'
    if (complexity === 'medium') return 'low'
    return 'free'
  }

  private normalizeGoal(prompt: string): string {
    return prompt.replace(/\s+/g, ' ').slice(0, 500)
  }

  private explain(
    complexity: TaskClassification['complexity'],
    taskType: TaskType,
    riskLevel: TaskClassification['riskLevel'],
    contextNeed: TaskClassification['contextNeed'],
    affectedAreas: string[],
    deterministicOnly: boolean,
  ): string {
    if (deterministicOnly) {
      return 'The request can be handled through deterministic repository inspection or validation commands.'
    }

    return `Classified as ${complexity} ${taskType} work with ${riskLevel} risk, ${contextNeed} context need, and affected areas: ${affectedAreas.join(', ')}.`
  }
}
