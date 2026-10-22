import { describe, expect, it } from 'vitest'
import { DESIGN_TOKENS } from '../ui/design-normalize.js'
import { AVOID_DATED_RULES, MODERN_DESIGN_RULES, designPrompt } from './design-prompt.js'
import type { DesignInput } from './types.js'

const base: DesignInput = { goal: 'CRM-Dashboard', context: { summary: 'Vite React app', relevantFiles: [], validationCommands: [] }, provider: 'claude-code' }

describe('designPrompt', () => {
  it('contains the modern rules and all base token names', () => {
    const prompt = designPrompt(base)
    expect(prompt).toContain(MODERN_DESIGN_RULES)
    for (const name of Object.keys(DESIGN_TOKENS)) expect(prompt).toContain(name)
    expect(prompt).toContain('Vite React app')
  })

  it('adds the avoid-list for codex only', () => {
    expect(designPrompt({ ...base, provider: 'codex' })).toContain(AVOID_DATED_RULES)
    expect(designPrompt({ ...base, provider: 'codex' })).toContain('## Avoid dated output')
    expect(designPrompt(base)).not.toContain('Avoid dated output')
  })

  it('adds the feedback section only with feedback', () => {
    expect(designPrompt(base)).not.toContain('Feedback on the previous draft')
    const prompt = designPrompt({ ...base, feedback: 'Mehr Weißraum', previous: { summary: 'Alt', designType: 'crm', direction: '', tokens: [], components: [], screens: [] } })
    expect(prompt).toContain('# Feedback on the previous draft')
    expect(prompt).toContain('Mehr Weißraum')
    expect(prompt).toContain('Alt')
  })

  it('includes a compact previous draft in revisions', () => {
    const previous = {
      summary: 'Alt',
      designType: 'crm' as const,
      direction: 'Ruhig, dicht',
      tokens: Array.from({ length: 60 }, (_, index) => ({ name: `--t${index}`, value: `v${index}`, darkValue: '', group: 'color' as const })),
      components: [{ name: 'StatCard', purpose: 'KPI', file: 'src/StatCard.tsx', spec: 'SPEC-NOT-INCLUDED', tokens: [] }],
      screens: [{ name: 'Übersicht', route: '/', layout: 'x', components: ['StatCard', 'Sidebar'] }],
    }
    const prompt = designPrompt({ ...base, feedback: 'Mehr Weißraum', previous })
    expect(prompt).toContain('Direction: Ruhig, dicht')
    expect(prompt).toContain('--t0=v0')
    expect(prompt).toContain('--t39=v39')
    expect(prompt).not.toContain('--t40=')
    expect(prompt).toContain('StatCard (src/StatCard.tsx)')
    expect(prompt).toContain('Übersicht: StatCard+Sidebar')
    expect(prompt).not.toContain('SPEC-NOT-INCLUDED')
    const section = prompt.slice(prompt.indexOf('# Feedback'), prompt.indexOf('# Design rules'))
    expect(section.length).toBeLessThan(2700)
  })

  it('clips catalog descriptions and includes inline skills', () => {
    const prompt = designPrompt({ ...base, skillCatalog: [{ name: 'ui-design', description: 'x'.repeat(500) }], skills: 'INLINE SKILL' })
    expect(prompt).toContain('- ui-design: ' + 'x'.repeat(199) + '…')
    expect(prompt).not.toContain('x'.repeat(201))
    expect(prompt).toContain('INLINE SKILL')
  })
})
