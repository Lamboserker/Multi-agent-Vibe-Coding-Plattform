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

  it('lists agents and skills and tells the planner to use requested skills', () => {
    const long = 'Sehr ausführliche Beschreibung. '.repeat(15) + 'ENDMARKER'
    const prompt = planningPrompt({
      ...input,
      agents: [{ name: 'frontend-agent', description: long, categories: ['react-ui'], skills: ['ui-design'] }],
      skills: [{ name: 'projekt-doku', description: 'Pflegt die Doku.', requested: true }, { name: 'ui-design', description: 'UI rules.', requested: false }],
    })
    expect(prompt).toContain('# Available agents')
    expect(prompt).toContain('# Available skills')
    expect(prompt).toContain('projekt-doku (requested by the user)')
    expect(prompt).not.toContain('ui-design (requested by the user)')
    expect(prompt).toContain('must appear on at least one task')
    expect(prompt).toMatch(/never wait for one/)
    expect(long.length).toBeGreaterThan(200)
    expect(prompt).not.toContain(long)
    expect(prompt).not.toContain('ENDMARKER')
    expect(prompt).toMatch(/- frontend-agent: .+… — categories: react-ui — skills: ui-design/)
  })

  it('caps the catalogs: 20 agents, 12 categories per agent', () => {
    const agents = Array.from({ length: 25 }, (_, index) => ({ name: `agent-${index + 1}`, description: 'd', categories: [] as string[], skills: [] as string[] }))
    const prompt = planningPrompt({ ...input, agents: agents.map((agent, index) => (index === 0 ? { ...agent, categories: Array.from({ length: 15 }, (_, cat) => `cat-${cat + 1}`) } : agent)) })
    expect(prompt).toMatch(/- agent-20:/)
    expect(prompt).not.toMatch(/- agent-21:/)
    expect(prompt).not.toMatch(/- agent-25:/)
    expect(prompt).toMatch(/cat-12(?!\d)/)
    expect(prompt).not.toMatch(/cat-13(?!\d)/)
    expect(prompt).not.toMatch(/cat-15(?!\d)/)
  })

  it('omits the catalogs and pins agent and skills to empty without them', () => {
    const prompt = planningPrompt(input)
    expect(prompt).not.toContain('# Available agents')
    expect(prompt).not.toContain('# Available skills')
    expect(prompt).toContain('"agent": always ""')
    expect(prompt).toContain('"skills": always []')
  })
})
