import { describe, expect, it } from 'vitest'
import { DESIGN_TOKENS } from '../ui/design-normalize.js'
import { ANALYSIS_SCHEMA, CHAT_SCHEMA, DESIGN_SCHEMA, EXECUTION_SUMMARY_SCHEMA, normalizeDesignDraft, normalizeRepairHint, PLAN_SCHEMA, REPAIR_HINT_SCHEMA, REVIEW_SCHEMA, sanitizeMockup } from './schemas.js'
import { OrchestratorError } from './types.js'

function walk(schema: any, path = 'root'): void {
  if (schema.type === 'object') {
    expect(schema.additionalProperties, path).toBe(false)
    expect(Object.keys(schema.properties).sort(), path).toEqual([...schema.required].sort())
    for (const [key, child] of Object.entries(schema.properties)) walk(child, `${path}.${key}`)
  }
  if (schema.type === 'array') walk(schema.items, `${path}[]`)
}

const component = { name: 'StatCard', purpose: 'KPI', file: 'src/StatCard.tsx', spec: 'x', tokens: ['--accent'] }
const draft = (over: Record<string, unknown> = {}) => ({ summary: ' s ', designType: 'dashboard', direction: 'd', tokens: [], components: [component], screens: [], mockupHtml: '<p>hi</p>', questions: [], ...over })

describe('DESIGN_SCHEMA', () => {
  it('is strict at every level', () => walk(DESIGN_SCHEMA))
})

describe('structured output schemas', () => {
  it('are strict at every level', () => {
    for (const schema of [ANALYSIS_SCHEMA, PLAN_SCHEMA, REVIEW_SCHEMA, REPAIR_HINT_SCHEMA, EXECUTION_SUMMARY_SCHEMA, CHAT_SCHEMA]) walk(schema)
  })
})

describe('normalizeRepairHint', () => {
  it('keeps exact find/replace text, drops unsafe paths and no-op edits', () => {
    const hint = normalizeRepairHint({
      diagnosis: ' Falscher Gruß ',
      confidence: 'high',
      edits: [
        { file: './src/greet.js', find: '  `Hi`\n', replace: '  `Hello`\n', note: ' fix ' },
        { file: '../etc/passwd', find: 'a', replace: 'b', note: '' },
        { file: 'C:/x.js', find: 'a', replace: 'b', note: '' },
        { file: 'src/same.js', find: 'x', replace: 'x', note: '' },
        { file: 'src/new.js', find: '', replace: 'export {}\n', note: 'new file' },
      ],
    })
    expect(hint.diagnosis).toBe('Falscher Gruß')
    expect(hint.edits).toEqual([
      { file: 'src/greet.js', find: '  `Hi`\n', replace: '  `Hello`\n', note: 'fix' },
      { file: 'src/new.js', find: '', replace: 'export {}\n', note: 'new file' },
    ])
  })

  it('defaults an unknown confidence to medium and rejects non-objects', () => {
    expect(normalizeRepairHint({ diagnosis: 'x', edits: 'nope', confidence: 'sure' })).toEqual({ diagnosis: 'x', edits: [], confidence: 'medium' })
    expect(() => normalizeRepairHint([])).toThrow(OrchestratorError)
  })
})

describe('normalizeDesignDraft', () => {
  it('fills every base token', () => {
    const result = normalizeDesignDraft(draft({ tokens: [{ name: '--accent', value: '#f00', darkValue: '', group: 'color' }] }))
    const names = result.tokens.map((token) => token.name)
    for (const name of Object.keys(DESIGN_TOKENS)) expect(names).toContain(name)
    expect(result.tokens.find((token) => token.name === '--accent')?.value).toBe('#f00')
    expect(result.tokens.find((token) => token.name === '--bg')?.darkValue).toBe('#0b0b0e')
    expect(result.summary).toBe('s')
  })

  it('drops bad names and duplicates', () => {
    const result = normalizeDesignDraft(draft({ tokens: [{ name: 'accent', value: 'x', darkValue: '', group: 'color' }, { name: '--Bad', value: 'x', darkValue: '', group: 'color' }, { name: '--gap', value: '8px', darkValue: '', group: 'spacing' }, { name: '--gap', value: '9px', darkValue: '', group: 'spacing' }] }))
    expect(result.tokens.filter((token) => token.name === '--gap')).toEqual([{ name: '--gap', value: '8px', darkValue: '', group: 'spacing' }])
    expect(result.tokens.some((token) => token.name === 'accent' || token.name === '--Bad')).toBe(false)
  })

  it('caps lists and spec length', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ name: `--t-${index}`, value: '1', darkValue: '', group: 'spacing' }))
    const result = normalizeDesignDraft(draft({
      tokens: many,
      components: Array.from({ length: 30 }, (_, index) => ({ ...component, name: `C${index}`, spec: 'a'.repeat(900) })),
      screens: Array.from({ length: 12 }, (_, index) => ({ name: `S${index}`, route: '/', layout: 'l', components: [] })),
      questions: Array.from({ length: 30 }, (_, index) => `q${index}`),
    }))
    expect(result.tokens).toHaveLength(40)
    expect(result.components).toHaveLength(16)
    expect(result.components[0]!.spec).toHaveLength(600)
    expect(result.screens).toHaveLength(8)
    expect(result.questions).toHaveLength(20)
  })

  it('maps unknown designType to other', () => expect(normalizeDesignDraft(draft({ designType: 'blog' })).designType).toBe('other'))

  it('throws without components and questions, accepts questions only', () => {
    expect(() => normalizeDesignDraft(draft({ components: [] }))).toThrow(OrchestratorError)
    const result = normalizeDesignDraft(draft({ components: [], questions: ['Welche Marke?'] }))
    expect(result.questions).toEqual(['Welche Marke?'])
  })

  it('sanitizes the mockup', () => expect(normalizeDesignDraft(draft({ mockupHtml: '<p onclick="x()">a</p><script>1</script>' })).mockupHtml).toBe('<p>a</p>'))
})

describe('normalizeDesignDraft token values', () => {
  it('drops tokens whose value could break out of a declaration', () => {
    const result = normalizeDesignDraft(draft({
      tokens: [
        { name: '--accent', value: 'red; } body{display:none} :root{--x:0', darkValue: '', group: 'color' },
        { name: '--bg', value: 'url(https://x)', darkValue: '', group: 'color' },
        { name: '--fg', value: '#111', darkValue: 'red;}', group: 'color' },
        { name: '--long', value: 'a'.repeat(121), darkValue: '', group: 'color' },
      ],
    }))
    expect(result.tokens.find((token) => token.name === '--accent')?.value).toBe(DESIGN_TOKENS['--accent']?.light)
    expect(result.tokens.find((token) => token.name === '--bg')?.value).toBe(DESIGN_TOKENS['--bg']?.light)
    expect(result.tokens.find((token) => token.name === '--long')).toBeUndefined()
    const fg = result.tokens.find((token) => token.name === '--fg')
    expect(fg?.value).toBe('#111')
    expect(fg?.darkValue).toBe('')
  })
})

describe('sanitizeMockup', () => {
  it('strips scripts, handlers, javascript: URLs and external assets', () => {
    const html = [
      '<style>.a{color:red;background:url(https://x.io/a.png)}</style>',
      '<link rel="stylesheet" href="https://cdn.x/y.css">',
      '<script src="https://x/y.js"></script><script>alert(1)</script>',
      '<a href="javascript:alert(1)" onclick="x()">l</a>',
      '<img src="https://x/a.png" onerror=\'y()\'>',
      '<iframe src="https://x"></iframe>',
      '<img src="data:image/png;base64,AAA">',
    ].join('')
    const out = sanitizeMockup(html)
    expect(out).not.toMatch(/script|onclick|onerror|javascript:|https?:|<link|iframe/i)
    expect(out).toContain('data:image/png;base64,AAA')
    expect(out).toContain('<style>.a{color:red;')
  })

  it.each([
    '<svg/onload=alert(1)>',
    '<img src="x"onerror="alert(1)">',
    '<a href="javascript:alert(\'x\')">l</a>',
    '<a href="&#106;avascript:alert(1)">l</a>',
    '<a href="&#x6A;avascript&colon;alert(1)">l</a>',
    '<a href="java\tscript:alert(1)">l</a>',
    '<a href=" JaVa&#9;Script:alert(1)">l</a>',
    '<a href=javascript:alert(1)>l</a>',
    '<a href="data:text/html,<b>x</b>">l</a>',
    '<meta http-equiv="refresh" content="0;url=https://x.io">',
    '<base href="https://x.io/">',
    '<img srcset="https://x.io/a.png 1x, b.png 2x">',
    '<video poster="//x.io/p.png"></video>',
    '<body background="https://x.io/b.png">',
    '<form action="https://x.io/post"><button formaction="//x.io">go</button></form>',
    '<style>.a{background:image-set("https://x.io/a.png" 1x)}</style>',
    '<style>@import "https://x.io/a.css";.a{color:red}</style>',
    '<style>@import url(https://x.io/a.css);</style>',
    '<div style="background:url( //x.io/a.png)">',
  ])('neutralizes %s', (payload) => {
    const out = sanitizeMockup(payload)
    expect(out).not.toMatch(/on(?:load|error)\s*=|javascript|data:text\/html|<meta|<base|https?:|\/\/x\.io|@import|image-set/i)
  })

  it('keeps benign attributes', () => {
    const out = sanitizeMockup('<a href="#top" class="x" data-component="A">a</a><img src="data:image/png;base64,AAA" alt="once on=1">')
    expect(out).toContain('href="#top"')
    expect(out).toContain('data-component="A"')
    expect(out).toContain('data:image/png;base64,AAA')
  })

  it.each([
    '<p>Mode: online = true</p>',
    '<p>Set onload= in config</p>',
    '<input placeholder="Suche onboarding=" title="x onclick=y">',
  ])('keeps handler-like text outside attributes: %s', (html) => expect(sanitizeMockup(html)).toBe(html))

  it('removes unterminated scripts', () => expect(sanitizeMockup('<p>a</p><script>alert(1)')).toBe('<p>a</p>'))

  it('returns empty for oversize output', () => expect(sanitizeMockup('a'.repeat(200_001))).toBe(''))
})
