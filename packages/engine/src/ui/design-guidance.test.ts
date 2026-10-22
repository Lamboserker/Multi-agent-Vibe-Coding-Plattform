import { describe, expect, it } from 'vitest'
import type { DesignBrief } from '../orchestrator/types.js'
import { designGuidance, tokensCss } from './design-guidance.js'

const brief: DesignBrief = {
  summary: 's',
  designType: 'dashboard',
  direction: 'Calm zinc, indigo accent',
  tokens: [
    { name: '--bg', value: '#fff', darkValue: '#000', group: 'color' },
    { name: '--accent', value: '#4f46e5', darkValue: '', group: 'color' },
    { name: '--radius', value: '12px', darkValue: '', group: 'radius' },
  ],
  components: [
    { name: 'StatCard', purpose: 'KPI tile', file: 'src/components/StatCard.tsx', spec: 'SPEC-STAT', tokens: [] },
    { name: 'DataTable', purpose: 'Table', file: 'src/components/DataTable.tsx', spec: 'SPEC-TABLE', tokens: [] },
  ],
  screens: [{ name: 'Overview', route: '/overview', layout: 'LAYOUT-OVERVIEW', components: ['StatCard'] }],
}

describe('tokensCss', () => {
  it('emits :root and a dark block only for tokens with a dark value', () => {
    const css = tokensCss(brief.tokens)
    expect(css).toContain(':root {')
    expect(css).toContain('--accent: #4f46e5;')
    const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))
    expect(dark).toContain('--bg: #000;')
    expect(dark).not.toContain('--accent')
    expect(tokensCss([...brief.tokens].reverse())).toBe(css)
  })
})

describe('designGuidance', () => {
  it('is empty for non-UI tasks', () => expect(designGuidance(brief, { title: 'StatCard API', files: ['src/api.ts'], category: 'api-endpoint' })).toBe(''))

  it('matches components by PascalCase, kebab-case and by file', () => {
    expect(designGuidance(brief, { title: 'Build StatCard', category: 'react-ui' })).toContain('SPEC-STAT')
    const kebab = designGuidance(brief, { title: 'Add the stat-card component', category: 'react-ui' })
    expect(kebab).toContain('SPEC-STAT')
    expect(kebab).not.toContain('SPEC-TABLE')
    expect(designGuidance(brief, { title: 'Table', files: ['src/components/DataTable.tsx'] })).toContain('SPEC-TABLE')
  })

  it('includes direction, rule, tokens and a matching screen', () => {
    const text = designGuidance(brief, { title: 'Overview page', category: 'react-ui' })
    expect(text).toContain('## Design draft (approved)')
    expect(text).toContain('Calm zinc')
    expect(text).toContain('design/tokens.css')
    expect(text).toContain('- --accent: #4f46e5')
    expect(text).toContain('LAYOUT-OVERVIEW')
  })

  it('respects the budget without cutting mid-line', () => {
    const full = designGuidance(brief, { title: 'StatCard', category: 'react-ui' })
    const small = designGuidance(brief, { title: 'StatCard', category: 'react-ui' }, 260)
    expect(small.length).toBeLessThanOrEqual(260)
    expect(small.length).toBeLessThan(full.length)
    for (const line of small.split('\n')) expect(full).toContain(line)
  })
})
