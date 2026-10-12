export const MODEL_CLASSES = [
  'no_llm',
  'local_llm',
  'free_llm',
  'cheap_api_llm',
  'premium_llm',
] as const

export type ModelClass = (typeof MODEL_CLASSES)[number]

export type CostMode = 'cheapest' | 'balanced' | 'quality'

export type Complexity = 'trivial' | 'small' | 'medium' | 'complex' | 'critical'
export type TaskType =
  | 'frontend'
  | 'backend'
  | 'database'
  | 'fullstack'
  | 'devops'
  | 'test'
  | 'refactor'
  | 'documentation'
  | 'unknown'
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type ContextNeed = 'low' | 'medium' | 'high'
export type CostTier = 'free' | 'low' | 'medium' | 'premium'

export interface TaskClassification {
  normalizedGoal: string
  complexity: Complexity
  taskType: TaskType
  riskLevel: RiskLevel
  contextNeed: ContextNeed
  securitySensitive: boolean
  estimatedCostTier: CostTier
  deterministicOnly: boolean
  affectedAreas: string[]
  reason: string
}

export interface ModelAvailability {
  localAvailable: boolean
  freeQuotaAvailable: boolean
  cheapApiAvailable: boolean
  premiumAllowed: boolean
  previousCheapFailures: number
}

export interface RoutingInput {
  classification: TaskClassification
  costMode: CostMode
  maxCostEuro?: number
  allowedModelClasses?: ModelClass[]
  availability: ModelAvailability
  validationAvailable: boolean
}

export interface RoutingDecision {
  selectedModelClass: ModelClass
  requiresHumanApproval: boolean
  estimatedInputTokens: number
  estimatedOutputTokens: number
  estimatedCostEuro: number
  reasons: string[]
  escalationRules: string[]
}

export interface SubtaskPlan {
  title: string
  goal: string
  allowedFiles: string[]
  deniedFiles: string[]
  expectedChange: string
  assignedAgentType: string
  selectedModelClass: ModelClass
  validationCommands: string[]
  budgetLimitEuro: number
  dependsOn: string[]
  requiresHumanApproval: boolean
  routingReasons: string[]
}

export interface ProviderPricing {
  modelClass: ModelClass
  costInputPerMillion?: number | null
  costOutputPerMillion?: number | null
}

export interface ValidationCommandPlan {
  commands: string[]
  unavailableReasons: string[]
}
