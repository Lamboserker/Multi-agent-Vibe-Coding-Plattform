import { describe, expect, it } from 'vitest'
import { executionPrompt } from './prompts.js'

describe('premium execution prompt', () => {
  it('carries the role and skill guidance local agents get', () => {
    const prompt = executionPrompt({ taskId: 'task-001', title: 'Dashboard', instructions: 'Build the dashboard.', acceptanceCriteria: [], relevantFiles: [], guidance: '## Relevant skills (follow these instructions)\n### Skill: ui-design\nTokens first.' })
    expect(prompt).toMatch(/# Guidance \(follow it\)\n## Relevant skills/)
    expect(executionPrompt({ taskId: 't', title: 't', instructions: 'x', acceptanceCriteria: [], relevantFiles: [] })).not.toContain('Guidance')
  })
})
