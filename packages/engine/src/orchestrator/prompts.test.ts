import { describe, expect, it } from 'vitest'
import { chooseExecutionPrompt, ORCHESTRATOR_SYSTEM_PROMPT, planningPrompt, reconcilePlanPrompt, renderRepairHint, repairHintPrompt } from './prompts.js'
import { reconcileDesignPrompt } from './design-prompt.js'

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

  it('forbids naming a model or executor in title or description', () => {
    expect(planningPrompt(input)).toMatch(/Never name a model or executor in "title" or "description"/)
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

  it('scores complexity and risk with an explicit rubric and reserves premium for unsplittable hard tasks', () => {
    const prompt = planningPrompt(input)
    expect(prompt).toMatch(/1–2 = one file with a clear "old → new" instruction/)
    expect(prompt).toMatch(/3 = a new component plus its test, or one file with non-trivial logic/)
    expect(prompt).toMatch(/4 = several existing files must change together/)
    expect(prompt).toMatch(/5 = architecture or cross-cutting change/)
    expect(prompt).toMatch(/"risk": 4–5 only for authentication\/security, data migrations, destructive data operations/)
    expect(prompt).toMatch(/and payment/)
    expect(prompt).toMatch(/UI and styling tasks are risk 1–2/)
    expect(prompt).toMatch(/"premium" only for tasks with complexity 4–5 that cannot be split further/)
    // no leftover rule that sends security logic to premium regardless of the scores
    expect(prompt).not.toMatch(/"premium" for security-critical logic/)
    // the rubric must not contradict the one-file rule: local tasks still edit one existing file
    expect(prompt).toMatch(/Only "premium" tasks may edit several existing files at once/)
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/cross-cutting architecture changes are high complexity/)
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

  describe('design draft', () => {
    const design = {
      summary: 'Ruhiges Dashboard für Kennzahlen.',
      designType: 'dashboard' as const,
      direction: 'Hell, viel Weißraum, ein Akzent.',
      tokens: [
        { name: '--accent', value: '#123456', darkValue: '', group: 'color' as const },
        { name: '--space-4', value: '16px', darkValue: '', group: 'spacing' as const },
      ],
      components: [
        { name: 'StatCard', purpose: 'Zeigt eine Kennzahl.', file: 'src/components/StatCard.tsx', spec: 'x'.repeat(500), tokens: ['--accent'] },
        { name: 'Sidebar', purpose: 'Navigation.', file: '', spec: 'Liste mit Links.', tokens: [] },
      ],
      screens: [{ name: 'Übersicht', route: '/', layout: 'Sidebar links, Karten rechts', components: ['Sidebar', 'StatCard'] }],
    }

    it('is absent without a design', () => {
      const prompt = planningPrompt(input)
      expect(prompt).not.toContain('# Design draft')
      expect(prompt).not.toContain('design/tokens.css')
    })

    it('lists summary, tokens by name, components with files and screens', () => {
      const prompt = planningPrompt({ ...input, design })
      expect(prompt).toContain('# Design draft (approved by the user)')
      expect(prompt).toContain('Ruhiges Dashboard für Kennzahlen.')
      expect(prompt).toContain('--accent, --space-4')
      expect(prompt).not.toContain('#123456')
      expect(prompt).toContain('- StatCard (src/components/StatCard.tsx): Zeigt eine Kennzahl.')
      expect(prompt).toContain('- Sidebar (file: choose): Navigation. — Liste mit Links.')
      expect(prompt).toContain('- Übersicht (/): Sidebar links, Karten rechts; components: Sidebar, StatCard')
    })

    it('clips long specs and never carries a mockup', () => {
      const prompt = planningPrompt({ ...input, design: { ...design, mockupHtml: '<html>MOCKUPMARKER</html>' } as typeof design })
      expect(prompt).not.toContain('x'.repeat(301))
      expect(prompt).toContain('x'.repeat(290))
      expect(prompt).not.toContain('MOCKUPMARKER')
    })

    it('adds the design rules without contradicting the one-file rules', () => {
      const prompt = planningPrompt({ ...input, design })
      expect(prompt).toContain('do not plan tasks for these files')
      expect(prompt).toMatch(/imports design\/tokens\.css into the project's global stylesheet or entry file \(one existing file, or in an empty repository the entry file created by the setup task\), and a second task for the app shell/)
      expect(prompt).toContain('one task per design component, named after the component')
      expect(prompt).toContain('group closely related small components into one task: at most 2 new files per task, and at most one existing file per local task')
      expect(prompt).toContain('loading/empty/error states')
      // the single-file rules stay and nothing demands two existing files in one task
      expect(prompt).toContain('edits at most ONE existing source file')
      expect(prompt).not.toMatch(/one task[^.\n]*(and|plus) the (app shell|layout)/i)
      expect(prompt).not.toMatch(/tokens\.css[^.\n]*and builds the app shell/)
      expect(planningPrompt(input)).not.toContain('Design rules')
    })
  })

  it('omits the catalogs and pins agent and skills to empty without them', () => {
    const prompt = planningPrompt(input)
    expect(prompt).not.toContain('# Available agents')
    expect(prompt).not.toContain('# Available skills')
    expect(prompt).toContain('"agent": always ""')
    expect(prompt).toContain('"skills": always []')
  })
})

describe('repair hint prompt', () => {
  const hintInput = {
    taskId: 'task-003', title: 'Greet', instructions: 'Create src/greet.js exporting greet(name).', acceptanceCriteria: ['greet("Ada") returns "Hello Ada"'],
    files: ['src/greet.js', 'test/greet.test.js'], diff: '+export const greet = (name) => `Hi ${name}`', failures: '## test failed: node --test\nexpected Hello',
  }

  it('gives task, diff, failure and files and forbids implementing', () => {
    const prompt = repairHintPrompt(hintInput)
    expect(prompt).toContain('# Task task-003: Greet')
    expect(prompt).toContain('- greet("Ada") returns "Hello Ada"')
    expect(prompt).toContain('- test/greet.test.js')
    expect(prompt).toContain('```diff\n+export const greet = (name) => `Hi ${name}`\n```')
    expect(prompt).toContain('## test failed: node --test')
    expect(prompt).toMatch(/Do NOT implement the task yourself and do not\s+modify files/)
    expect(prompt).toMatch(/"find": text copied exactly from the current file/)
    expect(prompt).toMatch(/"low" if the root cause is\s+unclear/)
    expect(prompt).toMatch(/"diagnosis": .* in German/)
  })

  it('truncates long diffs and says when nothing was written', () => {
    expect(repairHintPrompt({ ...hintInput, diff: 'x'.repeat(30) }, 10)).toContain('[diff truncated, 20 chars omitted]')
    expect(repairHintPrompt({ ...hintInput, diff: '' })).toContain('(the attempt wrote no files)')
  })

  it('renders the hint as literal old → new instructions for the local model', () => {
    const text = renderRepairHint({
      diagnosis: 'Falscher Gruß.',
      confidence: 'high',
      edits: [
        { file: 'src/greet.js', find: '`Hi ${name}`', replace: '`Hello ${name}`', note: 'Test erwartet Hello' },
        { file: 'src/extra.js', find: '', replace: 'export {}\n', note: '' },
      ],
    }, '## test failed')
    expect(text).toContain('Diagnosis: Falscher Gruß.')
    expect(text).toContain('1. src/greet.js – Test erwartet Hello\nold:\n```\n`Hi ${name}`\n```\nnew:\n```\n`Hello ${name}`\n```')
    expect(text).toContain('2. src/extra.js\nCreate the file with exactly this content:\n```\nexport {}\n\n```')
    expect(text).toContain('# Failure of the previous attempt\n## test failed')
    expect(text).not.toMatch(/premium|executor/i)
  })
})

describe('duo prompts', () => {
  const plan = (summary: string) => ({
    summary,
    analysis: { summary, taskType: 'frontend', complexity: 2, risk: 1, securitySensitive: false, affectedAreas: [], needsDecomposition: true, openQuestions: [] },
    tasks: [{ id: 'task-001', title: `${summary} task`, description: 'old → new', category: 'react-ui', complexity: 2, risk: 1, relevantFiles: [], newFiles: ['src/A.tsx'], dependsOn: [], capabilities: [], expectedInputTokens: 1000, testStrategy: '', acceptanceCriteria: [], suggestedExecutor: 'local' as const, rationale: '', agent: '', skills: [] }],
    warnings: [],
  })

  it('the plan reconciliation repeats every planning rule and states the merge rules', () => {
    const prompt = reconcilePlanPrompt(input, [{ label: 'Claude Code', plan: plan('Alpha') }, { label: 'Codex', plan: plan('Beta') }])
    // the full planning prompt (rules + context) is part of it
    expect(prompt.startsWith(planningPrompt(input))).toBe(true)
    expect(prompt).toMatch(/it edits at most ONE existing source file/)
    expect(prompt).toMatch(/"complexity" \(score each task/)
    expect(prompt).toContain('At most 8 tasks')
    expect(prompt).toContain('## Proposal A (Claude Code)')
    expect(prompt).toContain('## Proposal B (Codex)')
    expect(prompt).toContain('"Alpha task"')
    expect(prompt).toMatch(/prefer the finer decomposition/)
    expect(prompt).toMatch(/Prefer "local"/)
    expect(prompt).toMatch(/Drop duplicates/)
    expect(prompt).toMatch(/"notes": 1–5 short sentences in German/)
  })

  it('truncates very large proposals', () => {
    const big = plan('x'.repeat(5000))
    expect(reconcilePlanPrompt(input, [{ label: 'A', plan: big }, { label: 'B', plan: big }], 1000)).toContain('[plan truncated')
  })

  it('the execution choice shows both diffs with labels and asks for A or B', () => {
    const prompt = chooseExecutionPrompt({ taskId: 'task-001', title: 'Greet', instructions: 'Add greet', acceptanceCriteria: ['greet works'] }, [
      { label: 'Claude Code', diff: '+claude', summary: 's1', validation: 'all passed' },
      { label: 'Codex', diff: '+codex', summary: 's2', validation: 'all passed' },
    ])
    expect(prompt).toContain('## Change A (Claude Code)')
    expect(prompt).toContain('## Change B (Codex)')
    expect(prompt).toContain('+claude')
    expect(prompt).toContain('+codex')
    expect(prompt).toContain('- greet works')
    expect(prompt).toMatch(/"winner": "A" or "B"/)
  })

  it('the design reconciliation keeps the design rules and both drafts', () => {
    const draft = (summary: string) => ({ summary, designType: 'crm' as const, direction: 'd', tokens: [], components: [], screens: [], mockupHtml: `<main>${summary}</main>`, questions: [] })
    const prompt = reconcileDesignPrompt({ goal: 'CRM', context: input.context, provider: 'codex' }, [{ label: 'Codex', draft: draft('Eins') }, { label: 'Claude Code', draft: draft('Zwei') }])
    expect(prompt).toContain('# Design rules')
    expect(prompt).toContain('## Avoid dated output')
    expect(prompt).toContain('## Draft A (Codex)')
    expect(prompt).toContain('<main>Zwei</main>')
    expect(prompt).toMatch(/one complete mockup of the merged draft/)
  })
})
