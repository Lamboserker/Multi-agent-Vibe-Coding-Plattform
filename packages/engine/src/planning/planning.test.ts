import { describe, expect, it } from 'vitest'
import { normalizePlan, extractJson, normalizeReview } from '../orchestrator/schemas.js'
import { analyzeDag, findCycle, transitiveDependents } from './dag.js'
import { categorize } from './fallback-planner.js'

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
