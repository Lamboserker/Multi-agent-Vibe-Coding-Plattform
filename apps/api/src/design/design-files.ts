import { DESIGN_TYPES, designGuidance, tokensCss, type DesignBrief, type DesignDraft, type DesignType, type FastPathTool, type PlannedTask, type SkillOffer } from '@multi-ai-coder/engine'

/** Key of the deterministic task that writes the design files before every planned task. */
export const DESIGN_TASK_ID = 'design-001'
export const DESIGN_FILES = { tokens: 'design/tokens.css', markdown: 'design/DESIGN.md', mockup: 'design/mockup.html' } as const

/** What a DesignDraft row stores in `spec`: the brief without summary/type plus the designer's questions. */
export interface DesignSpec {
  direction: string
  tokens: DesignBrief['tokens']
  components: DesignBrief['components']
  screens: DesignBrief['screens']
  questions: string[]
}

export function specOf(draft: DesignDraft): DesignSpec {
  return { direction: draft.direction, tokens: draft.tokens, components: draft.components, screens: draft.screens, questions: draft.questions }
}

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

/** The brief of a stored draft row (tolerant: a row from an older version may miss fields). */
export function briefOf(row: { summary: string; designType: string | null; spec: unknown }): DesignBrief {
  const spec = (row.spec ?? {}) as Partial<DesignSpec>
  const designType = (DESIGN_TYPES as readonly string[]).includes(row.designType ?? '') ? (row.designType as DesignType) : 'other'
  return {
    summary: row.summary,
    designType,
    direction: typeof spec.direction === 'string' ? spec.direction : '',
    tokens: list(spec.tokens),
    components: list(spec.components),
    screens: list(spec.screens),
  }
}

const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

/** design/DESIGN.md: the approved draft as a readable reference for agents and the user. */
export function designMarkdown(brief: DesignBrief): string {
  const lines = [
    '# Design',
    '',
    `Typ: ${brief.designType}`,
    '',
    brief.summary,
    '',
    ...(brief.direction ? ['## Richtung', '', brief.direction, ''] : []),
    '## Tokens',
    '',
    'Nur diese CSS-Variablen aus `design/tokens.css` verwenden (`var(--…)`); `design/mockup.html` ist die visuelle Referenz.',
    '',
    '| Token | Wert | Dunkel | Gruppe |',
    '|---|---|---|---|',
    ...brief.tokens.map((token) => `| \`${cell(token.name)}\` | ${cell(token.value)} | ${cell(token.darkValue || '–')} | ${token.group} |`),
    '',
    '## Komponenten',
    '',
  ]
  for (const component of brief.components) {
    lines.push(`### ${component.name}${component.file ? ` (\`${component.file}\`)` : ''}`, '')
    if (component.purpose) lines.push(component.purpose, '')
    if (component.spec) lines.push(component.spec, '')
    if (component.tokens.length) lines.push(`Tokens: ${component.tokens.map((token) => `\`${token}\``).join(', ')}`, '')
  }
  if (brief.screens.length) {
    lines.push('## Screens', '')
    for (const screen of brief.screens) {
      lines.push(`### ${screen.name}${screen.route ? ` (\`${screen.route}\`)` : ''}`, '')
      if (screen.layout) lines.push(screen.layout, '')
      if (screen.components.length) lines.push(`Komponenten: ${screen.components.join(', ')}`, '')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Restrictive CSP of the written mockup: opened from the repository in a browser it may not load scripts,
 * remote resources or frames (only inline styles and data: images/fonts).
 */
export const MOCKUP_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`

/** The mockup with MOCKUP_CSP as the first element of <head> (a missing <head> or <html> is added). */
export function withMockupCsp(html: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(html)
  if (head) return `${html.slice(0, head.index + head[0].length)}${MOCKUP_CSP}${html.slice(head.index + head[0].length)}`
  const root = /<html(?:\s[^>]*)?>/i.exec(html)
  if (root) return `${html.slice(0, root.index + root[0].length)}<head>${MOCKUP_CSP}</head>${html.slice(root.index + root[0].length)}`
  return `${MOCKUP_CSP}${html}`
}

/** The write-files tool of design-001; mockup.html is left out when the sanitizer dropped the mockup. */
export function designFilesTool(brief: DesignBrief, mockupHtml: string): Extract<FastPathTool, { kind: 'write-files' }> {
  const files: string[] = [DESIGN_FILES.tokens, DESIGN_FILES.markdown]
  const contents = [tokensCss(brief.tokens), designMarkdown(brief)]
  if (mockupHtml.trim()) {
    files.push(DESIGN_FILES.mockup)
    contents.push(withMockupCsp(mockupHtml))
  }
  return { kind: 'write-files', files, contents }
}

/** The deterministic first task of a plan built on an approved design. */
export function designPlanTask(tool: Extract<FastPathTool, { kind: 'write-files' }>): PlannedTask {
  return {
    id: DESIGN_TASK_ID,
    title: 'Design-Dateien anlegen',
    description: `Writes the approved design draft into the repository: ${tool.files.join(', ')} (deterministic, no model call).`,
    category: 'fast-path',
    complexity: 1,
    risk: 1,
    relevantFiles: [],
    newFiles: [...tool.files],
    dependsOn: [],
    capabilities: [],
    expectedInputTokens: 0,
    testStrategy: 'Project validation commands in the task worktree.',
    acceptanceCriteria: ['The design files exist with the approved content.'],
    suggestedExecutor: 'local',
    rationale: 'Approved design draft: files are written by a deterministic tool.',
    agent: '',
    skills: [],
  }
}

/** Prepends design-001 and makes every planned task depend on it. */
export function withDesignTask<T extends { tasks: PlannedTask[] }>(plan: T, designTask: PlannedTask): T {
  return {
    ...plan,
    tasks: [designTask, ...plan.tasks.filter((task) => task.id !== designTask.id).map((task) => ({ ...task, dependsOn: [...new Set([designTask.id, ...task.dependsOn])] }))],
  }
}

/**
 * The skill catalog offered to the planner with `design-<type>` flagged as requested (requested first),
 * so the planner attaches the type recipe to the UI tasks. Unchanged if that skill is not active for coders.
 */
export function requestDesignSkill(catalog: SkillOffer[], designType: string): SkillOffer[] {
  const name = `design-${designType}`
  if (!catalog.some((skill) => skill.name === name)) return catalog
  return catalog.map((skill) => (skill.name === name ? { ...skill, requested: true } : skill)).sort((a, b) => Number(b.requested) - Number(a.requested))
}

/** Appends the design guidance for a UI task to the executor's instructions (tool tasks need none). */
export function withDesignGuidance<R extends { instructions?: string; sources?: string[] }>(
  resources: R,
  brief: DesignBrief,
  task: { title: string; description: string; category: string; relevantFiles: string[]; newFiles: string[]; tool?: unknown },
): R {
  if (task.tool) return resources
  const guidance = designGuidance(brief, { title: task.title, description: task.description, category: task.category, files: [...task.relevantFiles, ...task.newFiles] })
  if (!guidance) return resources
  return { ...resources, instructions: [resources.instructions, guidance].filter(Boolean).join('\n\n'), sources: [...(resources.sources ?? []), 'Design-Entwurf'] }
}
