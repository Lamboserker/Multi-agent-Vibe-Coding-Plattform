export type AgentType =
  | 'RepoContextAgent'
  | 'TaskClassifierAgent'
  | 'PlannerAgent'
  | 'FrontendAgent'
  | 'BackendAgent'
  | 'TestAgent'
  | 'ErrorFixAgent'
  | 'ReviewerAgent'
  | 'CostControllerAgent'

export interface AgentPromptTemplate {
  agentType: AgentType
  role: string
  prompt: string
  allowedToolCategories: string[]
  defaultMaxIterations: number
  requiresValidation: boolean
  requiresReview: boolean
}

export const AGENT_PROMPT_TEMPLATES: AgentPromptTemplate[] = [
  {
    agentType: 'RepoContextAgent',
    role: 'Find relevant files and compress repository context without exposing secrets.',
    prompt:
      'Inspect deterministic repo metadata first. Select only files required for the goal, summarize architecture, redact secrets, and never include whole repositories.',
    allowedToolCategories: ['filesystem_read', 'git_read', 'static_analysis'],
    defaultMaxIterations: 2,
    requiresValidation: false,
    requiresReview: false,
  },
  {
    agentType: 'TaskClassifierAgent',
    role: 'Classify user work by complexity, task type, risk, context need, and security sensitivity.',
    prompt:
      'Prefer deterministic signals from path names, scripts, dependencies, and prompt text. Output a structured classification with concise reasons.',
    allowedToolCategories: ['static_analysis'],
    defaultMaxIterations: 1,
    requiresValidation: false,
    requiresReview: false,
  },
  {
    agentType: 'PlannerAgent',
    role: 'Break the task into small, file-scoped subtasks with validation and budget limits.',
    prompt:
      'Create narrowly scoped subtasks. Avoid parallel edits to the same file. Add denied files for secrets, infra, auth, payment, and migrations when not approved.',
    allowedToolCategories: ['static_analysis', 'git_read'],
    defaultMaxIterations: 2,
    requiresValidation: false,
    requiresReview: true,
  },
  {
    agentType: 'FrontendAgent',
    role: 'Implement React, UI, CSS, routing, and frontend state changes.',
    prompt:
      'Keep UI changes consistent with the existing design system. Edit only allowed files, produce a small diff, and provide targeted validation commands.',
    allowedToolCategories: ['filesystem_read', 'filesystem_write', 'git_diff', 'validation'],
    defaultMaxIterations: 4,
    requiresValidation: true,
    requiresReview: true,
  },
  {
    agentType: 'BackendAgent',
    role: 'Implement API, service, and database-adjacent logic without unsafe migrations.',
    prompt:
      'Respect service boundaries and do not run production migrations. Keep provider keys server-side and avoid logging secret material.',
    allowedToolCategories: ['filesystem_read', 'filesystem_write', 'git_diff', 'validation'],
    defaultMaxIterations: 4,
    requiresValidation: true,
    requiresReview: true,
  },
  {
    agentType: 'TestAgent',
    role: 'Create focused tests and validation commands for changed behavior.',
    prompt:
      'Prefer targeted tests first. If a check is unavailable, explain why and propose the next best verification.',
    allowedToolCategories: ['filesystem_read', 'filesystem_write', 'validation'],
    defaultMaxIterations: 3,
    requiresValidation: true,
    requiresReview: false,
  },
  {
    agentType: 'ErrorFixAgent',
    role: 'Analyze failed validation output and propose or implement minimal fixes.',
    prompt:
      'Use validation errors as the primary source of truth. Fix root causes in allowed files and avoid broad refactors.',
    allowedToolCategories: ['filesystem_read', 'filesystem_write', 'validation', 'git_diff'],
    defaultMaxIterations: 3,
    requiresValidation: true,
    requiresReview: true,
  },
  {
    agentType: 'ReviewerAgent',
    role: 'Review diffs for goal completion, risk, unnecessary changes, secrets, and validation status.',
    prompt:
      'Lead with blocking issues. Require human approval for security, auth, payment, database migration, and infrastructure changes.',
    allowedToolCategories: ['git_diff', 'validation', 'static_analysis'],
    defaultMaxIterations: 2,
    requiresValidation: false,
    requiresReview: false,
  },
  {
    agentType: 'CostControllerAgent',
    role: 'Decide whether escalation to a more expensive model is justified.',
    prompt:
      'Prefer no_llm, local, free, and cheap API tiers. Premium is for planning or review after risk triggers or repeated cheap failures.',
    allowedToolCategories: ['cost_ledger', 'static_analysis'],
    defaultMaxIterations: 1,
    requiresValidation: false,
    requiresReview: false,
  },
]

export function getAgentPromptTemplate(agentType: AgentType): AgentPromptTemplate {
  const template = AGENT_PROMPT_TEMPLATES.find((item) => item.agentType === agentType)
  if (!template) {
    throw new Error(`Unknown agent type: ${agentType}`)
  }
  return template
}
