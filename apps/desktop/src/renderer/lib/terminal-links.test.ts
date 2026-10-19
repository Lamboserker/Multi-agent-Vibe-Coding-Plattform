import { describe, expect, it } from 'vitest'
import { findLinks, isLinkModifier } from './terminal-links'

describe('terminal links', () => {
  it('finds dev server and web links with their position', () => {
    const line = '  ➜  Local:   http://localhost:5173/   Docs: https://vitejs.dev/guide/.'
    expect(findLinks(line)).toEqual([
      { start: 14, end: 36, url: 'http://localhost:5173/' },
      { start: 45, end: 70, url: 'https://vitejs.dev/guide/' },
    ])
  })

  it('stops at quotes, brackets and trailing punctuation', () => {
    expect(findLinks('see (https://example.com/a?b=1&c=2), "https://x.dev/y"').map((link) => link.url)).toEqual(['https://example.com/a?b=1&c=2', 'https://x.dev/y'])
    expect(findLinks('Server läuft auf http://127.0.0.1:3000!').map((link) => link.url)).toEqual(['http://127.0.0.1:3000'])
  })

  it('ignores other schemes and incomplete URLs', () => {
    expect(findLinks('file:///C:/x ftp://host javascript:alert(1) http:// https://')).toEqual([])
  })

  it('needs Ctrl (or Cmd) for opening', () => {
    expect(isLinkModifier({ ctrlKey: true, metaKey: false })).toBe(true)
    expect(isLinkModifier({ ctrlKey: false, metaKey: true })).toBe(true)
    expect(isLinkModifier({ ctrlKey: false, metaKey: false })).toBe(false)
  })
})
