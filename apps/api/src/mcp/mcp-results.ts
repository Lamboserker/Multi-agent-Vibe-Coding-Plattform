import { randomBytes } from 'node:crypto'

/**
 * Bounded store for long tool results of one agent run / orchestrator call. A long result is
 * returned as its first page plus an unguessable reference; the rest is read page by page. A store
 * belongs to exactly one run, so references from other runs or sessions are never readable.
 */
export class ResultPages {
  private readonly results = new Map<string, { full: string; bytes: number; permitted?: () => Promise<boolean> }>()
  private retainedBytes = 0
  constructor(private readonly pageChars = 12_000, private readonly maxResults = 16, private readonly maxChars = 16_000_000) {}

  /** Full text if it fits on one page, else a JSON page with a reference. */
  page(full: string, permitted?: () => Promise<boolean>): string {
    const bytes = Buffer.byteLength(full)
    if (bytes > this.maxChars) throw new Error('Tool result exceeds the session byte limit; no truncated result was retained.')
    if (full.length <= this.pageChars) return full
    while (this.results.size >= this.maxResults || this.retainedBytes + bytes > this.maxChars) this.remove(this.results.keys().next().value!)
    const reference = randomBytes(16).toString('hex')
    this.results.set(reference, { full, bytes, permitted })
    this.retainedBytes += bytes
    return JSON.stringify({ text: full.slice(0, this.pageChars), reference, totalChars: full.length, nextOffset: this.pageChars })
  }

  async read(reference: unknown, offset: unknown = 0): Promise<string> {
    const entry = this.results.get(String(reference))
    if (entry === undefined) throw new Error('Result reference is unavailable in this session.')
    if (entry.permitted && !(await entry.permitted())) {
      this.remove(String(reference))
      throw new Error('Result permission was revoked; the retained result was removed.')
    }
    const full = entry.full
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > full.length) throw new Error('Invalid result offset.')
    const end = Math.min(Number(offset) + this.pageChars, full.length)
    return JSON.stringify({ text: full.slice(Number(offset), end), totalChars: full.length, nextOffset: end < full.length ? end : null })
  }

  private remove(reference: string) { const entry = this.results.get(reference); if (entry) this.retainedBytes -= entry.bytes; this.results.delete(reference) }
  clear() { this.results.clear(); this.retainedBytes = 0 }
}

export const READ_RESULT_DESCRIPTION = 'Reads the next page of a long tool result. Pass the reference and nextOffset from the previous page.'
export const READ_RESULT_SCHEMA = { type: 'object', properties: { reference: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['reference'] }
