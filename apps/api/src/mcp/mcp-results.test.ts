import { describe, expect, it } from 'vitest'
import { ResultPages } from './mcp-results.js'

describe('bounded complete MCP results', () => {
  it('evicts old results by total UTF-8 bytes and preserves the entire accepted result', async () => {
    const pages = new ResultPages(2, 16, 12)
    const a = JSON.parse(pages.page('ä'.repeat(4)))
    expect(JSON.parse(await pages.read(a.reference, 2)).text).toBe('ää')
    const b = JSON.parse(pages.page('b'.repeat(8)))
    await expect(pages.read(a.reference)).rejects.toThrow(/unavailable/)
    expect(JSON.parse(await pages.read(b.reference, 6)).text).toBe('bb')
    expect(() => pages.page('c'.repeat(13))).toThrow(/no truncated result/)
  })
  it('rechecks permission and permanently removes revoked references', async () => {
    const pages = new ResultPages(2)
    let allowed = true
    const first = JSON.parse(pages.page('abcdef', async () => allowed))
    allowed = false
    await expect(pages.read(first.reference)).rejects.toThrow(/revoked/)
    allowed = true
    await expect(pages.read(first.reference)).rejects.toThrow(/unavailable/)
  })
})
