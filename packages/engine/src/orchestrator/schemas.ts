import { normalizeRelative } from '../security/paths.js'
import { OrchestratorError, type ExecutionPlan, type PlannedTask, type ReviewResult, type TaskAnalysis } from './types.js'

// Strict JSON schemas (every property required, no additional properties) so that both
// Claude Code (--json-schema) and Codex (--output-schema, strict mode) accept them.

const stringArray = { type: 'array', items: { type: 'string' } }

export const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'taskType', 'complexity', 'risk', 'securitySensitive', 'affectedAreas', 'needsDecomposition', 'openQuestions'],
  properties: {
    summary: { type: 'string' },
    taskType: { type: 'string', enum: ['frontend', 'backend', 'database', 'fullstack', 'devops', 'test', 'refactor', 'documentation', 'unknown'] },
    complexity: { type: 'integer', minimum: 1, maximum: 5 },
    risk: { type: 'integer', minimum: 1, maximum: 5 },
    securitySensitive: { type: 'boolean' },
    affectedAreas: stringArray,
    needsDecomposition: { type: 'boolean' },
    openQuestions: stringArray,
  },
}

export const TASK_CATEGORIES = [
  'react-ui',
  'styling',
  'frontend-logic',
  'api-endpoint',
  'backend-service',
  'database-schema',
  'database-migration',
  'auth-security',
  'validation',
  'refactor',
  'tests',
  'documentation',
  'config',
  'devops',
  'bugfix',
  'general',
] as const

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'analysis', 'tasks', 'warnings'],
  properties: {
    summary: { type: 'string' },
    analysis: ANALYSIS_SCHEMA,
    warnings: stringArray,
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id', 'title', 'description', 'category', 'complexity', 'risk', 'relevantFiles', 'newFiles', 'dependsOn',
          'capabilities', 'expectedInputTokens', 'testStrategy', 'acceptanceCriteria', 'suggestedExecutor', 'rationale',
        ],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          category: { type: 'string', enum: [...TASK_CATEGORIES] },
          complexity: { type: 'integer', minimum: 1, maximum: 5 },
          risk: { type: 'integer', minimum: 1, maximum: 5 },
          relevantFiles: stringArray,
          newFiles: stringArray,
          dependsOn: stringArray,
          capabilities: stringArray,
          expectedInputTokens: { type: 'integer', minimum: 0 },
          testStrategy: { type: 'string' },
          acceptanceCriteria: stringArray,
          suggestedExecutor: { type: 'string', enum: ['local', 'premium'] },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'score', 'summary', 'issues', 'requiredFixes'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request_changes', 'reject'] },
    score: { type: 'integer', minimum: 0, maximum: 100 },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'message'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
    requiredFixes: stringArray,
  },
}

export const EXECUTION_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'filesChanged', 'openIssues'],
  properties: {
    summary: { type: 'string' },
    filesChanged: stringArray,
    openIssues: stringArray,
  },
}

export const CHAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer'],
  properties: { answer: { type: 'string' } },
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OrchestratorError(`${what} is not an object.`, 'invalid_output')
  return value as Record<string, unknown>
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function strList(value: unknown, limit = 50): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()).slice(0, limit) : []
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, number))
}

function cleanPath(value: string): string | undefined {
  const normalized = normalizeRelative(value).replace(/^\/+/, '')
  if (!normalized || normalized.split('/').includes('..') || /^[a-zA-Z]:/.test(normalized)) return undefined
  return normalized
}

export function normalizeAnalysis(raw: unknown): TaskAnalysis {
  const data = asRecord(raw, 'Analysis')
  return {
    summary: str(data.summary),
    taskType: str(data.taskType, 'unknown'),
    complexity: clampInt(data.complexity, 1, 5, 3),
    risk: clampInt(data.risk, 1, 5, 2),
    securitySensitive: data.securitySensitive === true,
    affectedAreas: strList(data.affectedAreas, 20),
    needsDecomposition: data.needsDecomposition !== false,
    openQuestions: strList(data.openQuestions, 10),
  }
}

/**
 * Validates and repairs a plan from a model: unique ids, known dependencies only, safe paths,
 * clamped scores. Throws when nothing usable remains.
 */
export function normalizePlan(raw: unknown, maxTasks = 12): ExecutionPlan {
  const data = asRecord(raw, 'Plan')
  const rawTasks = Array.isArray(data.tasks) ? data.tasks : []
  const warnings = strList(data.warnings, 20)
  const tasks: PlannedTask[] = []
  const idMap = new Map<string, string>()

  for (const [index, item] of rawTasks.entries()) {
    if (tasks.length >= maxTasks) {
      warnings.push(`Plan truncated to ${maxTasks} tasks.`)
      break
    }
    if (!item || typeof item !== 'object') continue
    const task = item as Record<string, unknown>
    const id = `task-${String(tasks.length + 1).padStart(3, '0')}`
    const originalId = str(task.id) || id
    if (idMap.has(originalId)) continue
    idMap.set(originalId, id)
    const category = TASK_CATEGORIES.includes(str(task.category) as (typeof TASK_CATEGORIES)[number]) ? str(task.category) : 'general'
    const title = str(task.title) || `Task ${index + 1}`
    tasks.push({
      id,
      title: title.slice(0, 160),
      description: str(task.description).slice(0, 4000) || title,
      category,
      complexity: clampInt(task.complexity, 1, 5, 3),
      risk: clampInt(task.risk, 1, 5, 2),
      relevantFiles: strList(task.relevantFiles, 30).map(cleanPath).filter((value): value is string => Boolean(value)),
      newFiles: strList(task.newFiles, 30).map(cleanPath).filter((value): value is string => Boolean(value)),
      dependsOn: strList(task.dependsOn, 20),
      capabilities: strList(task.capabilities, 10),
      expectedInputTokens: clampInt(task.expectedInputTokens, 0, 400_000, 4000),
      testStrategy: str(task.testStrategy).slice(0, 1000),
      acceptanceCriteria: strList(task.acceptanceCriteria, 12),
      suggestedExecutor: task.suggestedExecutor === 'premium' ? 'premium' : 'local',
      rationale: str(task.rationale).slice(0, 1000),
    })
  }

  for (const task of tasks) {
    const mapped = task.dependsOn.map((dependency) => idMap.get(dependency)).filter((value): value is string => Boolean(value) && value !== task.id)
    const dropped = task.dependsOn.length - mapped.length
    if (dropped > 0) warnings.push(`${task.id}: ${dropped} unknown dependency reference(s) removed.`)
    task.dependsOn = [...new Set(mapped)]
  }

  if (!tasks.length) throw new OrchestratorError('The plan contained no usable tasks.', 'invalid_output')
  return {
    summary: str(data.summary),
    analysis: normalizeAnalysis(data.analysis ?? {}),
    tasks,
    warnings,
  }
}

export function normalizeReview(raw: unknown): ReviewResult {
  const data = asRecord(raw, 'Review')
  const verdict = data.verdict === 'approve' || data.verdict === 'reject' ? data.verdict : 'request_changes'
  const issues = Array.isArray(data.issues)
    ? data.issues
        .filter((issue): issue is Record<string, unknown> => Boolean(issue) && typeof issue === 'object')
        .map((issue): ReviewResult['issues'][number] => ({
          severity: issue.severity === 'blocker' ? 'blocker' : issue.severity === 'minor' ? 'minor' : 'major',
          file: str(issue.file),
          message: str(issue.message),
        }))
        .slice(0, 40)
    : []
  return {
    verdict,
    score: clampInt(data.score, 0, 100, 50),
    summary: str(data.summary),
    issues,
    requiredFixes: strList(data.requiredFixes, 20),
  }
}

/** Extracts a JSON object from model text (handles fenced blocks and leading prose). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // continue
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim())
    } catch {
      // continue
    }
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      // fall through
    }
  }
  throw new OrchestratorError('Model output is not valid JSON.', 'invalid_output')
}
