import { describe, expect, it } from 'vitest'
import { acceptMerge, cleanMergeAnswer, mergePrompt } from './conflict-merge.js'

const hunk = {
  path: 'index.html',
  before: '<body>\n',
  after: '</body>\n',
  base: '  <h1>Titel</h1>\n',
  agent: '  <h1>Titel</h1>\n  <nav>Menü</nav>\n',
  current: '  <h1>Titel</h1>\n  <footer>Fuß</footer>\n',
}

describe('conflict merge', () => {
  it('asks for the region only, with both versions and the base', () => {
    const [system, user] = mergePrompt(hunk)
    expect(system!.content).toMatch(/merged region only/)
    expect(user!.content).toContain('<nav>Menü</nav>')
    expect(user!.content).toContain('<footer>Fuß</footer>')
  })

  it('removes an enclosing code fence and normalizes the end of the text', () => {
    expect(cleanMergeAnswer('```html\n  <h1>Titel</h1>\n  <nav>Menü</nav>\n```')).toBe('  <h1>Titel</h1>\n  <nav>Menü</nav>\n')
    expect(cleanMergeAnswer('   \n')).toBeUndefined()
  })

  it('accepts a merge with both additions and rejects one that drops a side or repeats the context', () => {
    expect(acceptMerge(hunk, '  <h1>Titel</h1>\n  <nav>Menü</nav>\n  <footer>Fuß</footer>\n')).toBe(true)
    expect(acceptMerge(hunk, '  <h1>Titel</h1>\n  <nav>Menü</nav>\n')).toBe(false)
    expect(acceptMerge(hunk, '<body>\n  <h1>Titel</h1>\n  <nav>Menü</nav>\n  <footer>Fuß</footer>\n</body>\n')).toBe(false)
  })

  it('does not insist on lines a side replaced (both changed the same line)', () => {
    const changed = { ...hunk, agent: '  <h1>Titel!</h1>\n', current: '  <h1>Neuer Titel</h1>\n' }
    expect(acceptMerge(changed, '  <h1>Neuer Titel!</h1>\n')).toBe(true)
  })
})

describe('conflict merge with a rename', () => {
  it('accepts an added line adapted to the renamed component', () => {
    const renamed = { path: 'src/App.tsx', before: '', after: '', base: '      <Badge label="beta" />\n', agent: '      <Tag label="beta" />\n', current: '      <Badge label="beta" />\n      <Badge label="neu" />\n' }
    expect(acceptMerge(renamed, '      <Tag label="beta" />\n      <Tag label="neu" />\n')).toBe(true)
    expect(acceptMerge(renamed, '      <Tag label="beta" />\n')).toBe(false)
  })
})

describe('repeated context', () => {
  it('strips context lines the model repeated around the region, nothing else', () => {
    const region = { before: '<body>\n  <div id="root">\n', after: '  </div>\n</body>\n', base: '    <h1>Dashboard</h1>\n' }
    const answer = '<body>\n  <div id="root">\n    <h1>Mein Dashboard</h1>\n    <nav>Menü</nav>\n  </div>\n</body>'
    expect(cleanMergeAnswer(answer, region)).toBe('    <h1>Mein Dashboard</h1>\n    <nav>Menü</nav>\n')
    expect(cleanMergeAnswer('    <h1>Mein Dashboard</h1>\n  </div>', region)).toBe('    <h1>Mein Dashboard</h1>\n')
    expect(cleanMergeAnswer('    <h1>Mein Dashboard</h1>', region)).toBe('    <h1>Mein Dashboard</h1>\n')
  })
})
