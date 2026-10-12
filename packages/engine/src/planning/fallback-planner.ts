import { isSecurityCriticalPath } from '../security/paths.js'
import { rankFiles, type RepoIndex } from '../index/repo-index.js'
import type { ExecutionPlan, PlannedTask } from '../orchestrator/types.js'

const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/\b(auth|login|jwt|oauth|password|session|permission|role|token|security|encrypt)/i, 'auth-security'],
  [/\b(migration|migrate|schema\.prisma|alter table)/i, 'database-migration'],
  [/\b(prisma|database|db|sql|model|entity|repository)\b/i, 'database-schema'],
  [/\b(test|spec|vitest|jest|coverage|unit test|testfall)/i, 'tests'],
  [/\b(readme|docs?|documentation|dokumentation|comment|kommentar)\b/i, 'documentation'],
  [/\b(css|style|styling|tailwind|color|farbe|layout|theme|dark mode)/i, 'styling'],
  [/\b(component|komponente|react|button|form|formular|page|seite|modal|ui|view|dashboard)/i, 'react-ui'],
  [/\b(endpoint|controller|route|api|rest|graphql)\b/i, 'api-endpoint'],
  [/\b(service|backend|server|worker|queue)\b/i, 'backend-service'],
  [/\b(refactor|rename|umbenennen|extract|cleanup|aufräumen)/i, 'refactor'],
  [/\b(fix|bug|fehler|error|crash|broken)\b/i, 'bugfix'],
  [/\b(config|konfiguration|eslint|tsconfig|vite|webpack)\b/i, 'config'],
  [/\b(docker|ci|deploy|pipeline|kubernetes)\b/i, 'devops'],
]

export function categorize(text: string): string {
  return CATEGORY_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? 'general'
}

function estimateComplexity(goal: string, files: number, category: string): number {
  let score = 1
  if (goal.length > 300) score += 1
  if (goal.length > 900) score += 1
  if (files > 4) score += 1
  if (/\b(system|architecture|architektur|vollständig|complete|full|rewrite|from scratch|migrat)/i.test(goal)) score += 1
  if (category === 'auth-security' || category === 'database-migration') score += 1
  return Math.min(5, score)
}

/**
 * Deterministic single-task plan used when no premium orchestrator is connected (or planning
 * failed and the user chose to continue). It never claims capabilities it does not have:
 * the plan is a single scoped task with files chosen by the repository index.
 */
export function deterministicPlan(goal: string, index: RepoIndex): ExecutionPlan {
  const ranked = rankFiles(index, goal).slice(0, 6).map((entry) => entry.path)
  const category = categorize(goal)
  const complexity = estimateComplexity(goal, ranked.length, category)
  const securityCritical = ranked.some(isSecurityCriticalPath) || category === 'auth-security' || category === 'database-migration'
  const risk = securityCritical ? 4 : complexity >= 4 ? 3 : 2
  const task: PlannedTask = {
    id: 'task-001',
    title: goal.replace(/\s+/g, ' ').slice(0, 90),
    description: goal,
    category,
    complexity,
    risk,
    relevantFiles: ranked,
    newFiles: [],
    dependsOn: [],
    capabilities: index.frameworks.slice(0, 4).map((framework) => framework.toLowerCase()),
    expectedInputTokens: 3000 + ranked.length * 800,
    testStrategy: 'Run the project validation commands (typecheck/tests) in the task worktree.',
    acceptanceCriteria: ['The requested change is implemented.', 'Existing validation commands pass.'],
    suggestedExecutor: complexity >= 4 || securityCritical ? 'premium' : 'local',
    rationale: 'Deterministic fallback plan (no orchestrator planning call).',
  }
  return {
    summary: `Deterministic single-task plan (${category}).`,
    analysis: {
      summary: 'Heuristic analysis based on keywords and the repository index.',
      taskType: category,
      complexity,
      risk,
      securitySensitive: securityCritical,
      affectedAreas: [category],
      needsDecomposition: complexity >= 4,
      openQuestions: [],
    },
    tasks: [task],
    warnings: ['No premium orchestrator was used for planning; the task was not decomposed.'],
  }
}
