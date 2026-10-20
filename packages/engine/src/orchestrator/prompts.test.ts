import { describe, expect, it } from 'vitest'
import { ORCHESTRATOR_SYSTEM_PROMPT, planningPrompt } from './prompts.js'

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
    expect(prompt).toMatch(/New projects, empty or nearly empty repositories and requests for a basic structure \("Grundstruktur", scaffold\) are no reason for\s+premium/)
    expect(prompt).toMatch(/local setup task first/)
  })

  it('asks for fine decomposition and nothing pushes towards a single task', () => {
    const prompt = planningPrompt(input)
    for (const text of [ORCHESTRATOR_SYSTEM_PROMPT, prompt]) {
      expect(text).not.toMatch(/Minimize time to a validated change/)
      expect(text).not.toMatch(/in ONE task/)
      expect(text).toMatch(/one task = one file/i)
      expect(text).toMatch(/Bundle only trivial edits of the same file/)
    }
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/documentation file including its test/)
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/setup task first/)
    // a component with an existing test file must stay a local task
    expect(prompt).toMatch(/at most ONE existing source file \(plus its own test file\)/)
    // the grouping exception applies to every plan, not only to large conversions
    expect(prompt).toMatch(/Only if there are more files than tasks allowed, group\s+the smallest files of one kind/)
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/independent tasks no dependency/)
  })

  it('plans a basic structure as setup task plus one task per file, documentation included', () => {
    const prompt = planningPrompt(input)
    expect(prompt).toMatch(/"Grundstruktur"/)
    expect(prompt).toMatch(/one local task per file or per component\/page with its test/)
    expect(prompt).toMatch(/documentation files \(README, docs\/\*\.md\)/)
    // tests belong to their component, not into a task of their own
    expect(prompt).not.toMatch(/style file, test and/)
    expect(prompt).not.toMatch(/fitting agent from "Available agents"/)
    const withAgents = planningPrompt({ ...input, agents: [{ name: 'docs-agent', description: 'Docs.', categories: ['docs'], skills: [] }] })
    expect(withAgents).toMatch(/each with the fitting agent from "Available agents"/)
  })

  it('allows an empty plan only together with open questions (ADR-002)', () => {
    expect(planningPrompt(input)).toMatch(/Never return zero tasks without questions: if the request truly cannot be planned, return no tasks and put concrete questions\s+into "analysis\.openQuestions"\./)
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
