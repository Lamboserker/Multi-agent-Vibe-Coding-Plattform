import { describe, expect, it } from 'vitest'
import { MAX_MCP_RESULT_BYTES, ResultPages, richMcpContent } from './mcp-results.js'

describe('native MCP content', () => {
  it('preserves images and summarizes unsupported data without embedding arbitrary resources', () => {
    expect(richMcpContent({ content: [{ type: 'text', text: 'render' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'audio', data: 'secret-bytes' }] })).toEqual([{ type: 'text', text: 'render' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'text', text: '[audio content omitted]' }])
    expect(richMcpContent({ structuredContent: { answer: 42 } })).toEqual([{ type: 'text', text: '{"answer":42}' }])
  })
  it('rejects invalid base64, unsupported image types and oversized payloads', () => {
    expect(() => richMcpContent({ content: [{ type: 'image', mimeType: 'image/svg+xml', data: 'AAAA' }] })).toThrow(/Unsupported/)
    expect(() => richMcpContent({ content: [{ type: 'image', mimeType: 'image/png', data: 'not base64' }] })).toThrow(/invalid/)
    expect(() => richMcpContent({ content: [{ type: 'text', text: 'x'.repeat(MAX_MCP_RESULT_BYTES) }] })).toThrow(/16 MB/)
    const large = richMcpContent({ content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA'.repeat(512_000) }] })
    expect(large[0]?.type).toBe('image')
  })
})

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
