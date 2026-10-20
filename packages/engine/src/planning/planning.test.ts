import { describe, expect, it } from 'vitest'
import { normalizePlan, extractJson, normalizeReview, PLAN_SCHEMA } from '../orchestrator/schemas.js'
import { analyzeDag, findCycle, transitiveDependents } from './dag.js'
import type { RepoIndex } from '../index/repo-index.js'
import { categorize, deterministicPlan, FILE_SCOPED_CRITERION, mentionedPaths } from './fallback-planner.js'

describe('analyzeDag', () => {
  it('computes parallel levels and topological order', () => {
    const nodes = [
      { id: 'a', dependsOn: [], writes: ['a.ts'] },
      { id: 'b', dependsOn: [], writes: ['b.ts'] },
      { id: 'c', dependsOn: ['a', 'b'], writes: ['c.ts'] },
    ]
    const result = analyzeDag(nodes)
    expect(result.levels).toEqual([['a', 'b'], ['c']])
    expect(result.order.indexOf('c')).toBe(2)
  })

  it('serializes independent tasks that write the same file', () => {
    const nodes = [
      { id: 'a', dependsOn: [], writes: ['shared.ts', 'a.ts'] },
      { id: 'b', dependsOn: [], writes: ['shared.ts'] },
    ]
    const result = analyzeDag(nodes)
    expect(result.conflictEdges).toEqual([{ from: 'b', to: 'a', files: ['shared.ts'] }])
    expect(result.levels).toEqual([['a'], ['b']])
  })

  it('breaks cycles deterministically and drops unknown/self dependencies', () => {
    const nodes = [
      { id: 'a', dependsOn: ['c', 'a', 'ghost'], writes: [] },
      { id: 'b', dependsOn: ['a'], writes: [] },
      { id: 'c', dependsOn: ['b'], writes: [] },
    ]
    const result = analyzeDag(nodes)
    expect(result.removedEdges.length).toBe(1)
    expect(findCycle(new Map(nodes.map((node) => [node.id, node.dependsOn])))).toBeUndefined()
    expect(result.order).toHaveLength(3)
  })

  it('finds transitive dependents', () => {
    const nodes = [
      { id: 'a', dependsOn: [], writes: [] },
      { id: 'b', dependsOn: ['a'], writes: [] },
      { id: 'c', dependsOn: ['b'], writes: [] },
      { id: 'd', dependsOn: [], writes: [] },
    ]
    expect(transitiveDependents(nodes, 'a').sort()).toEqual(['b', 'c'])
  })
})

describe('plan normalization', () => {
  it('renumbers ids, maps dependencies, removes unsafe paths and clamps scores', () => {
    const plan = normalizePlan({
      summary: 'Login',
      analysis: { summary: 's', taskType: 'backend', complexity: 9, risk: 0, securitySensitive: true, affectedAreas: ['auth'], needsDecomposition: true, openQuestions: [] },
      warnings: [],
      tasks: [
        { id: 'schema', title: 'Schema', description: 'd', category: 'database-schema', complexity: 3, risk: 4, relevantFiles: ['prisma/schema.prisma', '../etc/passwd'], newFiles: [], dependsOn: [], capabilities: [], expectedInputTokens: 5000, testStrategy: '', acceptanceCriteria: [], suggestedExecutor: 'premium', rationale: '' },
        { id: 'ui', title: 'Form', description: 'd', category: 'nonsense', complexity: 2, risk: 1, relevantFiles: ['src/Login.tsx'], newFiles: ['C:/evil.ts'], dependsOn: ['schema', 'missing'], capabilities: [], expectedInputTokens: -5, testStrategy: '', acceptanceCriteria: [], suggestedExecutor: 'local', rationale: '' },
      ],
    })
    expect(plan.tasks.map((task) => task.id)).toEqual(['task-001', 'task-002'])
    expect(plan.tasks[1]!.dependsOn).toEqual(['task-001'])
    expect(plan.tasks[0]!.relevantFiles).toEqual(['prisma/schema.prisma'])
    expect(plan.tasks[1]!.newFiles).toEqual([])
    expect(plan.tasks[1]!.category).toBe('general')
    expect(plan.tasks[1]!.expectedInputTokens).toBe(0)
    expect(plan.analysis.complexity).toBe(5)
    expect(plan.analysis.risk).toBe(1)
    expect(plan.warnings.some((warning) => warning.includes('unknown dependency'))).toBe(true)
  })

  it('keeps every task property required and strict, including agent and skills', () => {
    const items = PLAN_SCHEMA.properties.tasks.items as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean }
    expect(new Set(Object.keys(items.properties))).toEqual(new Set(items.required))
    expect(items.additionalProperties).toBe(false)
    expect(items.required).toEqual(expect.arrayContaining(['agent', 'skills']))
  })

  it('normalizes agent and skills of a task, defaulting to empty', () => {
    const base = { title: 'T', description: 'd', category: 'general', complexity: 2, risk: 1, relevantFiles: [], newFiles: [], dependsOn: [], capabilities: [], expectedInputTokens: 0, testStrategy: '', acceptanceCriteria: [], suggestedExecutor: 'local', rationale: '' }
    const skills = ['a', '', '  x ', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
    const plan = normalizePlan({ summary: 's', tasks: [{ ...base, id: 'a', agent: '  frontend-agent  ', skills }, { ...base, id: 'b' }] })
    expect(plan.tasks[0]!.agent).toBe('frontend-agent')
    expect(plan.tasks[0]!.skills).toHaveLength(8)
    expect(plan.tasks[0]!.skills).toEqual(['a', 'x', 'c', 'd', 'e', 'f', 'g', 'h'])
    expect(plan.tasks[1]!.agent).toBe('')
    expect(plan.tasks[1]!.skills).toEqual([])
  })

  it('rejects plans without tasks', () => {
    expect(() => normalizePlan({ summary: '', tasks: [] })).toThrow(/no usable tasks/)
  })

  it('extracts JSON from fenced or prefixed model output', () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('Result: {"b":2} done')).toEqual({ b: 2 })
    expect(() => extractJson('no json')).toThrow()
  })

  it('normalizes review verdicts', () => {
    const review = normalizeReview({ verdict: 'maybe', score: 140, summary: 'x', issues: [{ severity: 'huge', file: 'a.ts', message: 'm' }], requiredFixes: ['fix'] })
    expect(review.verdict).toBe('request_changes')
    expect(review.score).toBe(100)
    expect(review.issues[0]!.severity).toBe('major')
  })
})

describe('fallback categorization', () => {
  it.each([
    ['Add a password reset endpoint', 'auth-security'],
    ['Create a React profile card component', 'react-ui'],
    // conservative: anything mentioning login is treated as security-relevant by the fallback
    ['Create a React login form component', 'auth-security'],
    ['Change the button colors', 'styling'],
    ['Write unit tests for the parser', 'tests'],
    ['Update the README', 'documentation'],
  ])('%s → %s', (goal, category) => {
    expect(categorize(goal)).toBe(category)
  })
})

describe('fallback plan scope', () => {
  const index: RepoIndex = { version: 2, root: '/repo', builtAt: '', files: [], packageJsons: [], languages: {}, frameworks: [], isGit: true, stats: { indexedFiles: 0, reusedFromCache: 0, skippedLarge: 0, skippedBinary: 0 } }

  it.each(['Baue alles auf TailwindCSS um', 'Stelle das komplette Projekt auf Vue um', 'Convert the entire app to TypeScript'])('%s is project-wide work for premium', (goal) => {
    const task = deterministicPlan(goal, index).tasks[0]!
    expect(task.complexity).toBeGreaterThanOrEqual(4)
    expect(task.suggestedExecutor).toBe('premium')
    expect(task.agent).toBe('')
    expect(task.skills).toEqual([])
  })

  it('splits a project-wide conversion into setup + one precise local task per file', () => {
    const file = (path: string, language: string, lines = 50) => ({ path, size: lines * 40, mtimeMs: 0, hash: path, language, lines, symbols: [], imports: [], dependsOn: [] })
    const repo: RepoIndex = {
      ...index,
      files: [file('package.json', 'json'), file('vite.config.js', 'javascript'), file('src/main.js', 'javascript'), file('src/style.css', 'css'), file('index.html', 'html', 300), file('dist/app.js', 'javascript'), file('src/main.test.js', 'javascript')],
    }
    const plan = deterministicPlan('Baue alles auf TailwindCSS um', repo, { maxTasks: 8 })
    expect(plan.tasks.map((task) => task.relevantFiles)).toEqual([['package.json', 'vite.config.js'], ['src/style.css'], ['index.html'], ['src/main.js']])
    const [setup, ...perFile] = plan.tasks
    expect(setup!.description).toContain('Do NOT change markup')
    for (const task of perFile) {
      expect(task.suggestedExecutor).toBe('local')
      expect(task.dependsOn).toEqual(['task-001'])
      expect(task.acceptanceCriteria).toContain(FILE_SCOPED_CRITERION)
      expect(task.description).toContain(`exactly ONE file: ${task.relevantFiles[0]}`)
    }
    expect(perFile[0]!.complexity).toBe(2)

    const capped = deterministicPlan('Baue alles auf TailwindCSS um', repo, { maxTasks: 3 })
    expect(capped.tasks).toHaveLength(3)
    expect(capped.warnings.join(' ')).toContain('1 further file(s) are not covered')
  })

  it.each(['Change the button colors', 'Stelle sicher, dass der Button um 10 Pixel größer ist'])('%s stays a small local task', (goal) => {
    const task = deterministicPlan(goal, index).tasks[0]!
    expect(task.complexity).toBeLessThan(4)
    expect(task.suggestedExecutor).toBe('local')
  })
})

describe('fallback plan scope from named files', () => {
  const entry = (path: string) => ({ path, size: 100, lines: 10, language: 'tsx', hash: '', mtimeMs: 0, symbols: [], imports: [] })
  const index = { version: 2, root: '/repo', builtAt: '', files: [entry('src/App.tsx'), entry('src/components/Badge.tsx')], packageJsons: [], languages: {}, frameworks: ['React'], isGit: true, stats: { indexedFiles: 2, reusedFromCache: 0, skippedLarge: 0, skippedBinary: 0 } } as unknown as RepoIndex

  it('finds repository paths in a request, not URLs', () => {
    expect(mentionedPaths('Erstelle `src/components/StatCard.tsx` mit `./src/components/StatCard.css`; siehe https://example.com/docs/page.html und App.tsx.')).toEqual(['src/components/StatCard.tsx', 'src/components/StatCard.css', 'App.tsx'])
  })

  it('limits the task to the files the request names: existing to edit, others to create', () => {
    const task = deterministicPlan('Erstelle eine React-Komponente `StatCard` in `src/components/StatCard.tsx` mit Stylesheet `src/components/StatCard.css`', index).tasks[0]!
    expect(task.relevantFiles).toEqual([])
    expect(task.newFiles).toEqual(['src/components/StatCard.tsx', 'src/components/StatCard.css'])
    expect(task.acceptanceCriteria).toContain('Only these files are created or changed: src/components/StatCard.tsx, src/components/StatCard.css.')
    const edit = deterministicPlan('Ergänze in src/App.tsx eine Überschrift', index).tasks[0]!
    expect(edit.relevantFiles).toEqual(['src/App.tsx'])
    expect(edit.newFiles).toEqual([])
  })
})
