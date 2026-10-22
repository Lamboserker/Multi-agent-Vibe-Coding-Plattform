import { normalizeRelative } from '../security/paths.js'
import { DESIGN_TOKENS } from '../ui/design-normalize.js'
import { DESIGN_TOKEN_GROUPS, DESIGN_TYPES, OrchestratorError, type DesignComponent, type DesignDraft, type DesignScreen, type DesignToken, type DesignType, type ExecutionPlan, type PlannedTask, type RepairHint, type ReviewResult, type TaskAnalysis } from './types.js'

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
          'agent', 'skills',
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
          agent: { type: 'string' },
          skills: stringArray,
        },
      },
    },
  },
}

export const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'designType', 'direction', 'tokens', 'components', 'screens', 'mockupHtml', 'questions'],
  properties: {
    summary: { type: 'string' },
    designType: { type: 'string', enum: [...DESIGN_TYPES] },
    direction: { type: 'string' },
    tokens: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'value', 'darkValue', 'group'],
        properties: {
          name: { type: 'string' },
          value: { type: 'string' },
          darkValue: { type: 'string' },
          group: { type: 'string', enum: [...DESIGN_TOKEN_GROUPS] },
        },
      },
    },
    components: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'purpose', 'file', 'spec', 'tokens'],
        properties: {
          name: { type: 'string' },
          purpose: { type: 'string' },
          file: { type: 'string' },
          spec: { type: 'string' },
          tokens: stringArray,
        },
      },
    },
    screens: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'route', 'layout', 'components'],
        properties: {
          name: { type: 'string' },
          route: { type: 'string' },
          layout: { type: 'string' },
          components: stringArray,
        },
      },
    },
    mockupHtml: { type: 'string' },
    questions: stringArray,
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

export const REPAIR_HINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['diagnosis', 'edits', 'confidence'],
  properties: {
    diagnosis: { type: 'string' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'find', 'replace', 'note'],
        properties: {
          file: { type: 'string' },
          find: { type: 'string' },
          replace: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}

/** Duo mode: the lead merges two plans into one, with notes for the user. */
export const RECONCILE_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['plan', 'notes'],
  properties: {
    plan: PLAN_SCHEMA,
    notes: stringArray,
  },
}

/** Duo mode: the lead picks one of two premium executions whose checks tied. */
export const CHOOSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['winner', 'reason'],
  properties: {
    winner: { type: 'string', enum: ['A', 'B'] },
    reason: { type: 'string' },
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
      agent: str(task.agent).slice(0, 80),
      skills: strList(task.skills, 8),
    })
  }

  for (const task of tasks) {
    const mapped = task.dependsOn.map((dependency) => idMap.get(dependency)).filter((value): value is string => Boolean(value) && value !== task.id)
    const dropped = task.dependsOn.length - mapped.length
    if (dropped > 0) warnings.push(`${task.id}: ${dropped} unknown dependency reference(s) removed.`)
    task.dependsOn = [...new Set(mapped)]
  }

  const analysis = normalizeAnalysis(data.analysis ?? {})
  if (!tasks.length) {
    // No tasks but open questions: the planner needs input, so surface them instead of failing
    const questions = analysis.openQuestions.length ? analysis.openQuestions : warnings
    if (questions.length) {
      throw new OrchestratorError(`The planner returned no tasks and asks for clarification: ${questions.join('; ')}`, 'needs_clarification', { retryable: false, questions })
    }
    throw new OrchestratorError('The plan contained no usable tasks.', 'invalid_output')
  }
  return {
    summary: str(data.summary),
    analysis,
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

/**
 * Repair hint for a failed local attempt. Edits with an unsafe path or nothing to change are dropped; the
 * engine treats a hint without edits like confidence "low" (straight to premium execution).
 */
export function normalizeRepairHint(raw: unknown): RepairHint {
  const data = asRecord(raw, 'Repair hint')
  const confidence = data.confidence === 'high' || data.confidence === 'low' ? data.confidence : 'medium'
  const edits = Array.isArray(data.edits)
    ? data.edits
        .filter((edit): edit is Record<string, unknown> => Boolean(edit) && typeof edit === 'object')
        .map((edit) => ({
          file: cleanPath(str(edit.file)) ?? '',
          // find/replace are code: keep whitespace exactly as given
          find: typeof edit.find === 'string' ? edit.find : '',
          replace: typeof edit.replace === 'string' ? edit.replace : '',
          note: str(edit.note),
        }))
        .filter((edit) => edit.file && edit.find !== edit.replace)
        .slice(0, 12)
    : []
  return { diagnosis: str(data.diagnosis).slice(0, 2000), edits, confidence }
}

/** The lead's merge of two plans; the plan is validated like any plan (throws when nothing usable remains). */
export function normalizeReconciledPlan(raw: unknown, maxTasks = 12): { plan: ExecutionPlan; notes: string[] } {
  const data = asRecord(raw, 'Reconciled plan')
  return { plan: normalizePlan(data.plan, maxTasks), notes: strList(data.notes, 10).map((note) => note.slice(0, 500)) }
}

export function normalizeChoice(raw: unknown): { winner: 'A' | 'B'; reason: string } {
  const data = asRecord(raw, 'Choice')
  if (data.winner !== 'A' && data.winner !== 'B') throw new OrchestratorError('The choice names neither A nor B.', 'invalid_output')
  return { winner: data.winner, reason: str(data.reason).slice(0, 1000) }
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

const MAX_MOCKUP_CHARS = 200_000

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'background', 'data'])

/** Decodes numeric/simple named entities and drops whitespace and control characters, so obfuscated schemes become comparable. */
function normalizeAttrValue(value: string): string {
  let text = value.replace(/^["']|["']$/g, '')
  for (let round = 0; round < 3; round++) {
    text = text
      .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
      .replace(/&#(\d+);?/g, (_m, dec: string) => String.fromCodePoint(Math.min(parseInt(dec, 10), 0x10ffff)))
      .replace(/&(colon|tab|newline);/gi, (_m, name: string) => (name.toLowerCase() === 'colon' ? ':' : ''))
  }
  return text.replace(/[\u0000-\u0020\u007f-\u009f]+/g, '').toLowerCase()
}

/** Drops event handlers and replaces dangerous or external attribute values inside one tag with "#". */
function neutralizeTagUrls(tag: string): string {
  return tag.replace(/(\s*)([^\s=/"'<>]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>"']+)/g, (match, space: string, attr: string, eq: string, raw: string) => {
    const name = attr.toLowerCase()
    if (name.startsWith('on')) return ''
    attr = space + attr
    const value = normalizeAttrValue(raw)
    if (/^(?:javascript|vbscript):/.test(value) || value.startsWith('data:text/html')) return `${attr}${eq}"#"`
    if (URL_ATTRS.has(name) && /^(?:https?:)?\/\//.test(value)) return `${attr}${eq}"#"`
    if (name === 'srcset' && /(?:^|,)(?:https?:)?\/\//.test(value)) return `${attr}${eq}"#"`
    return match
  })
}

/**
 * Strips what could execute or load remote content from a model-written mockup (scripts, event handlers,
 * javascript: URLs, embeds, external links/assets). Regex-based; the preview is additionally rendered in a
 * sandboxed iframe without scripts. Returns '' when the result is too large to preview.
 */
export function sanitizeMockup(html: string): string {
  let out = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[\s\S]*$/i, '') // unterminated: drop the rest
    .replace(/<(iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(iframe|object|embed)\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<link\b[^>]*>/gi, (tag) => (/\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i.test(tag) ? '' : tag))
  // Attributes are parsed per tag (quote-aware), so text such as "online = true" stays intact; repeat so
  // removing a handler cannot assemble a new one.
  for (let previous = ''; previous !== out; ) {
    previous = out
    out = out.replace(/<[a-z](?:"[^"]*"|'[^']*'|[^>"'])*>/gi, neutralizeTagUrls)
  }
  out = out
    .replace(/url\(\s*(["']?)\s*(?:(?:https?:)?\/\/|javascript:|vbscript:)[^)]*\)/gi, 'url(#)')
    .replace(/(?:-webkit-)?image-set\([^)]*(?:https?:|\/\/)[^)]*\)/gi, 'none')
    .replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])[^;]*;?/gi, '')
  out = out.trim()
  return out.length > MAX_MOCKUP_CHARS ? '' : out
}

const TOKEN_NAME = /^--[a-z0-9-]+$/

/** A token value ends up in a CSS declaration: reject anything that could break out of it or load content. */
function isSafeTokenValue(value: string): boolean {
  return Boolean(value) && value.length <= 120 && !/[;{}<>\r\n@]|url\(/i.test(value)
}

function baseTokenGroup(name: string): DesignToken['group'] {
  if (name.startsWith('--radius')) return 'radius'
  if (name.startsWith('--shadow')) return 'shadow'
  if (name === '--font') return 'typography'
  return 'color'
}

/**
 * Validates and repairs a design draft from a model: well-formed unique tokens, every base token present,
 * capped lists, sanitized mockup. Throws when there are neither components nor questions.
 */
export function normalizeDesignDraft(raw: unknown): DesignDraft {
  const data = asRecord(raw, 'Design')
  const seen = new Set<string>()
  const tokens: DesignToken[] = []
  for (const item of Array.isArray(data.tokens) ? data.tokens : []) {
    if (!item || typeof item !== 'object') continue
    const token = item as Record<string, unknown>
    const name = str(token.name)
    const value = str(token.value)
    if (!TOKEN_NAME.test(name) || !isSafeTokenValue(value) || seen.has(name)) continue
    seen.add(name)
    const darkRaw = str(token.darkValue)
    const darkValue = isSafeTokenValue(darkRaw) ? darkRaw : ''
    const group = DESIGN_TOKEN_GROUPS.find((candidate) => candidate === token.group) ?? baseTokenGroup(name)
    tokens.push({ name, value, darkValue: darkValue === value ? '' : darkValue, group })
  }
  const missing: DesignToken[] = Object.entries(DESIGN_TOKENS)
    .filter(([name]) => !seen.has(name))
    .map(([name, base]) => ({ name, value: base.light, darkValue: base.dark ?? '', group: baseTokenGroup(name) }))

  const names = new Set<string>()
  const components: DesignComponent[] = []
  for (const item of Array.isArray(data.components) ? data.components : []) {
    if (components.length >= 16) break
    if (!item || typeof item !== 'object') continue
    const component = item as Record<string, unknown>
    const name = str(component.name)
    if (!name || names.has(name)) continue
    names.add(name)
    components.push({
      name: name.slice(0, 80),
      purpose: str(component.purpose).slice(0, 300),
      file: cleanPath(str(component.file)) ?? '',
      spec: str(component.spec).slice(0, 600),
      tokens: strList(component.tokens, 20),
    })
  }

  const screens: DesignScreen[] = []
  for (const item of Array.isArray(data.screens) ? data.screens : []) {
    if (screens.length >= 8) break
    if (!item || typeof item !== 'object') continue
    const screen = item as Record<string, unknown>
    const name = str(screen.name)
    if (!name) continue
    screens.push({ name: name.slice(0, 80), route: str(screen.route).slice(0, 120), layout: str(screen.layout).slice(0, 600), components: strList(screen.components, 20) })
  }

  const questions = strList(data.questions, 20)
  if (!components.length && !questions.length) throw new OrchestratorError('The design draft contained no components and no questions.', 'invalid_output')
  const designType: DesignType = DESIGN_TYPES.find((candidate) => candidate === data.designType) ?? 'other'
  return {
    summary: str(data.summary),
    designType,
    direction: str(data.direction),
    tokens: [...tokens.slice(0, Math.max(0, 40 - missing.length)), ...missing],
    components,
    screens,
    mockupHtml: sanitizeMockup(typeof data.mockupHtml === 'string' ? data.mockupHtml : ''),
    questions,
  }
}
