import { isSecurityCriticalPath } from '../security/paths.js'
import { rankFiles, type FileEntry, type RepoIndex } from '../index/repo-index.js'
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

/** "Baue alles auf Tailwind um", "convert the entire app to …": the goal applies to the whole project. */
const PROJECT_SCOPE = /\b(alles|alle|komplett\w*|gesamt\w*|ganze[nmrs]?|überall|sämtlich\w*|entire|whole|everything|all files|every)\b/i
/** Switching a technology: needs dependencies/configuration before the files can be converted. */
const CONVERSION = /\b(umbauen|umstellen|umschreiben|portieren|migrat\w*|convert|port to|switch to)\b|\b(baue?|stelle?|schreibe?)\b[^.!?\n]*\bum\s*[.!]?\s*$/im

/**
 * Acceptance criterion that marks a per-file task of a project-wide goal: finishing without a change
 * (the file does not concern the goal) or with a pure removal counts as a valid result.
 */
export const FILE_SCOPED_CRITERION = 'If this file does not concern the goal, no change is the correct result.'

export function isProjectWide(goal: string): boolean {
  return PROJECT_SCOPE.test(goal)
}

function estimateComplexity(goal: string, files: number, category: string): number {
  let score = 1
  if (goal.length > 300) score += 1
  if (goal.length > 900) score += 1
  if (files > 4) score += 1
  if (/\b(system|architecture|architektur|vollständig|complete|full|rewrite|from scratch|migrat)/i.test(goal)) score += 1
  if (isProjectWide(goal)) score += 2
  if (CONVERSION.test(goal)) score += 1
  if (category === 'auth-security' || category === 'database-migration') score += 1
  return Math.min(5, score)
}

const SOURCE_LANGUAGES = new Set(['typescript', 'javascript', 'css', 'html', 'vue', 'svelte', 'python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'ruby', 'php', 'swift', 'c', 'cpp'])
const STYLING_LANGUAGES = new Set(['css', 'html', 'vue', 'svelte'])
const CONFIG_FILE = /(^|\/)(package\.json|[^/]*\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|postcss[^/]*|tailwind[^/]*)$/i
const SKIPPED_PATH = /(^|\/)(dist|build|out|coverage|vendor|\.[^/]+)\/|(\.test|\.spec)\.[^/]+$|\.d\.ts$|\.min\.(js|css)$/i

/** Repository-relative file paths a request names (e.g. `src/components/StatCard.tsx`); URLs excluded. */
export function mentionedPaths(goal: string): string[] {
  const files = new Set<string>()
  const pattern = /(?<![\w/.:-])((?:\.\/)?(?:[\w.-]+\/)*[\w-]+(?:\.[\w-]+)*\.(?:tsx?|jsx?|mjs|cjs|css|scss|sass|less|html|vue|svelte|json|md|py|go|rs|java|cs))(?![\w/-])/g
  for (const match of goal.matchAll(pattern)) files.add(match[1]!.replace(/^\.\//, ''))
  return [...files]
}

function fileComplexity(entry: FileEntry | undefined): number {
  const lines = entry?.lines ?? 0
  return lines > 400 ? 4 : lines > 150 ? 3 : 2
}

/**
 * Deterministic plan used when no premium orchestrator is connected (or planning failed).
 * It never claims capabilities it does not have. A project-wide goal is split into one setup task
 * plus one task per file, each with precise rules, because small local models only succeed on
 * narrow, single-file instructions; anything else is a single scoped task.
 */
export function deterministicPlan(goal: string, index: RepoIndex, options: { maxTasks?: number } = {}): ExecutionPlan {
  const category = categorize(goal)
  if (isProjectWide(goal) && category !== 'auth-security' && category !== 'database-migration') {
    const plan = decomposedPlan(goal, index, category, Math.max(2, options.maxTasks ?? 12))
    if (plan) return plan
  }
  // files the request names explicitly are the task's scope: existing ones to edit, the others to create
  const named = mentionedPaths(goal)
  const existing = new Set(index.files.map((entry) => entry.path))
  const namedExisting = named.filter((file) => existing.has(file))
  const namedNew = named.filter((file) => !existing.has(file))
  const ranked = named.length ? namedExisting : rankFiles(index, goal).slice(0, 6).map((entry) => entry.path)
  const complexity = estimateComplexity(goal, ranked.length + namedNew.length, category)
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
    newFiles: namedNew,
    dependsOn: [],
    capabilities: index.frameworks.slice(0, 4).map((framework) => framework.toLowerCase()),
    expectedInputTokens: 3000 + ranked.length * 800,
    testStrategy: 'Run the project validation commands (typecheck/tests) in the task worktree.',
    acceptanceCriteria: ['The requested change is implemented.', ...(named.length ? [`Only these files are created or changed: ${named.join(', ')}.`] : []), 'Existing validation commands pass.'],
    suggestedExecutor: complexity >= 4 || securityCritical ? 'premium' : 'local',
    rationale: 'Deterministic fallback plan (no orchestrator planning call).',
    agent: '',
    skills: [],
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

function decomposedPlan(goal: string, index: RepoIndex, category: string, maxTasks: number): ExecutionPlan | undefined {
  const byPath = new Map(index.files.map((entry) => [entry.path, entry]))
  const scores = new Map(rankFiles(index, goal).map((entry) => [entry.path, entry.score]))
  const candidates = index.files.filter((entry) => !SKIPPED_PATH.test(entry.path) && !isSecurityCriticalPath(entry.path))
  const configs = candidates.filter((entry) => CONFIG_FILE.test(entry.path)).map((entry) => entry.path)
  const preferred = (entry: FileEntry) => (category === 'styling' && STYLING_LANGUAGES.has(entry.language) ? 1 : 0)
  const sources = candidates
    .filter((entry) => SOURCE_LANGUAGES.has(entry.language) && !CONFIG_FILE.test(entry.path))
    .sort((a, b) => preferred(b) - preferred(a) || (scores.get(b.path) ?? 0) - (scores.get(a.path) ?? 0) || a.path.localeCompare(b.path))
    .map((entry) => entry.path)
  if (sources.length < 2) return undefined

  const capabilities = index.frameworks.slice(0, 4).map((framework) => framework.toLowerCase())
  const setup = CONVERSION.test(goal) && configs.length > 0
  const room = maxTasks - (setup ? 1 : 0)
  const covered = sources.slice(0, room)
  const skipped = sources.slice(room)
  const tasks: PlannedTask[] = []

  if (setup) {
    tasks.push({
      id: 'task-001',
      title: 'Projekt-Setup: Abhängigkeiten und Konfiguration',
      description: [
        `Overall goal of the user: "${goal}".`,
        'Your part: ONLY the project infrastructure the goal needs – dependencies, build and tool configuration, and the global entry point that loads it.',
        `Edit only these existing files: ${configs.join(', ')}. You may create new configuration files the tool requires (e.g. a config file or a global stylesheet entry).`,
        'Rules:',
        '- Add the new dependency/configuration; remove what the goal replaces only if the replacement is in place.',
        '- Do NOT change markup, components or other source files – separate tasks convert each file afterwards.',
        '- Keep existing scripts and settings unless the goal requires changing them.',
      ].join('\n'),
      category: 'config',
      complexity: 2,
      risk: 2,
      relevantFiles: configs,
      newFiles: [],
      dependsOn: [],
      capabilities,
      expectedInputTokens: 2500 + configs.length * 600,
      testStrategy: 'Run the project validation commands (build/typecheck) in the task worktree.',
      acceptanceCriteria: ['The dependency/configuration required by the goal is present.', 'The project still builds.', 'No source/markup file was changed.'],
      suggestedExecutor: 'local',
      rationale: 'Fallback decomposition: infrastructure first so per-file tasks only convert code.',
      agent: '',
      skills: [],
    })
  }

  for (const file of covered) {
    const id = `task-${String(tasks.length + 1).padStart(3, '0')}`
    const others = covered.filter((other) => other !== file)
    tasks.push({
      id,
      title: `${file}: ${goal.replace(/\s+/g, ' ').slice(0, 70)}`,
      description: [
        `Overall goal of the user: "${goal}".`,
        `Your part: apply this goal to exactly ONE file: ${file}.`,
        'Rules:',
        `- Edit only ${file}.${others.length ? ` The other files (${others.slice(0, 8).join(', ')}${others.length > 8 ? ', …' : ''}) are handled by separate tasks.` : ''}`,
        '- Convert everything in this file that the goal concerns; do not leave it half done.',
        '- Replace code instead of just deleting it: every removed piece needs its equivalent that fulfils the goal. Only what the goal makes obsolete (e.g. the old library\'s import) may be removed without replacement.',
        '- Keep texts, content, structure and behaviour unchanged apart from what the goal requires.',
        ...(setup ? ['- Dependencies and configuration were already set up by task-001; do not edit package.json or config files.'] : []),
        '- If nothing in this file concerns the goal, make no change and call finish explaining why.',
      ].join('\n'),
      category,
      complexity: fileComplexity(byPath.get(file)),
      risk: 2,
      relevantFiles: [file],
      newFiles: [],
      dependsOn: setup ? ['task-001'] : [],
      capabilities,
      expectedInputTokens: 2000 + Math.min(12_000, (byPath.get(file)?.size ?? 2000) / 3),
      testStrategy: 'Run the project validation commands in the task worktree.',
      acceptanceCriteria: [`${file} fulfils the goal completely.`, 'Nothing was removed without a replacement.', 'Existing validation commands pass.', FILE_SCOPED_CRITERION],
      suggestedExecutor: 'local',
      rationale: 'Fallback decomposition: one precise single-file task per affected file.',
      agent: '',
      skills: [],
    })
  }

  const complexity = estimateComplexity(goal, sources.length, category)
  return {
    summary: `Deterministic plan (${category}): ${setup ? 'setup + ' : ''}${covered.length} single-file task(s).`,
    analysis: {
      summary: 'Project-wide goal split per file by the repository index (heuristic, no orchestrator).',
      taskType: category,
      complexity,
      risk: 2,
      securitySensitive: false,
      affectedAreas: [category],
      needsDecomposition: true,
      openQuestions: [],
    },
    tasks,
    warnings: [
      'No premium orchestrator was used for planning; the goal was split per file heuristically.',
      ...(skipped.length ? [`${skipped.length} further file(s) are not covered (task limit ${maxTasks}): ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? ', …' : ''}.`] : []),
    ],
  }
}
