import { describe, expect, it } from 'vitest'
import { planningPrompt } from './prompts.js'

const input = {
  goal: 'Erstelle mit Vite ein React-Projekt mit einem modernen Dashboard (Bootstrap).',
  context: { summary: 'Empty repository (README.md only).', relevantFiles: [], validationCommands: [] },
  costMode: 'balanced' as const,
  localModels: [{ role: 'balanced', model: 'qwen2.5-coder:7b', toolCalling: true, strengths: ['react'] }],
  maxTasks: 8,
}

describe('planning prompt', () => {
  it('lets local tasks create files, so a new project is not handed to premium as a whole', () => {
    const prompt = planningPrompt(input)
    expect(prompt).not.toMatch(/exactly ONE existing file/)
    expect(prompt).toMatch(/creates a few small new files/)
    expect(prompt).toMatch(/New projects and empty or nearly empty repositories are no reason for premium/)
    expect(prompt).toMatch(/local setup task first/)
  })
})
