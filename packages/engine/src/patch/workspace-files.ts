import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { isIgnoredPath, isSensitivePath, matchesAny, normalizeRelative, PathViolationError, redactSecrets, resolveInside } from '../security/paths.js'

export type FileOperation =
  | { action: 'write'; path: string; content: string }
  | { action: 'edit'; path: string; search: string; replace: string }
  | { action: 'delete'; path: string }

export interface WorkspaceScope {
  allowRead?: boolean
  allowWrite?: boolean
  maxFiles?: number
  /** Patterns the agent may write. Empty = any non-denied file. */
  writablePatterns: string[]
  deniedPatterns: string[]
  maxWriteBytes: number
  maxReadBytes: number
  allowDelete: boolean
}

export const DEFAULT_SCOPE: WorkspaceScope = {
  writablePatterns: [],
  deniedPatterns: ['.git/**', '**/node_modules/**', '.github/workflows/**'],
  maxWriteBytes: 256 * 1024,
  maxReadBytes: 64 * 1024,
  allowDelete: false,
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolInputError'
  }
}

/**
 * Scoped file access for agents. Every operation is validated against the workspace root,
 * sensitive-file rules and the task scope; content sent back to models is secret-redacted.
 */
export class WorkspaceFiles {
  readonly touched = new Set<string>()

  constructor(
    readonly root: string,
    readonly scope: WorkspaceScope = DEFAULT_SCOPE,
  ) {}

  private resolve(requested: string) {
    const resolved = resolveInside(this.root, requested)
    if (isIgnoredPath(resolved.relative)) throw new PathViolationError('Path is inside an ignored directory (.git, node_modules, build output).', requested)
    if (isSensitivePath(resolved.relative)) throw new PathViolationError('Access to credential/secret files is blocked.', requested)
    if (matchesAny(resolved.relative, this.scope.deniedPatterns)) throw new PathViolationError('Path is denied for this task.', requested)
    return resolved
  }

  assertWritable(requested: string) {
    if (this.scope.allowWrite === false) throw new PathViolationError('This agent has no write permission.', requested)
    if (!this.touched.has(requested) && this.touched.size >= (this.scope.maxFiles ?? Infinity)) throw new PathViolationError('Agent file resource limit reached.', requested)
    const resolved = this.resolve(requested)
    if (this.scope.writablePatterns.length && !matchesAny(resolved.relative, this.scope.writablePatterns)) {
      throw new PathViolationError(
        `Path is outside this task's writable scope (${this.scope.writablePatterns.slice(0, 6).join(', ')}).`,
        requested,
      )
    }
    return resolved
  }

  async read(requested: string, options: { startLine?: number; endLine?: number } = {}): Promise<{ path: string; content: string; totalLines: number; truncated: boolean }> {
    if (this.scope.allowRead === false) throw new PathViolationError('This agent has no read permission.', requested)
    const { absolute, relative } = this.resolve(requested)
    let raw: string
    try {
      const stat = await fs.stat(absolute)
      if (!stat.isFile()) throw new ToolInputError(`${relative} is not a file.`)
      raw = await fs.readFile(absolute, 'utf8')
    } catch (error) {
      if (error instanceof ToolInputError) throw error
      throw new ToolInputError(`File not found: ${relative}`)
    }
    if (raw.includes('\0')) throw new ToolInputError(`${relative} looks like a binary file.`)
    const lines = raw.split(/\r?\n/)
    const start = Math.max(1, options.startLine ?? 1)
    const end = Math.min(lines.length, options.endLine ?? lines.length)
    let content = lines.slice(start - 1, end).join('\n')
    let truncated = start > 1 || end < lines.length
    if (Buffer.byteLength(content) > this.scope.maxReadBytes) {
      content = content.slice(0, this.scope.maxReadBytes)
      truncated = true
    }
    return { path: relative, content: redactSecrets(content), totalLines: lines.length, truncated }
  }

  async list(requested = '.', depth = 2, limit = 300): Promise<string[]> {
    if (this.scope.allowRead === false) throw new PathViolationError('This agent has no read permission.', requested)
    const base = requested === '.' || requested === '' ? { absolute: path.resolve(this.root), relative: '' } : this.resolve(requested)
    const results: string[] = []
    const walk = async (absolute: string, relative: string, level: number) => {
      if (results.length >= limit) return
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(absolute, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (results.length >= limit) return
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name
        if (isIgnoredPath(childRelative) || isSensitivePath(childRelative)) continue
        if (entry.isDirectory()) {
          results.push(`${childRelative}/`)
          if (level < depth) await walk(path.join(absolute, entry.name), childRelative, level + 1)
        } else if (entry.isFile()) {
          results.push(childRelative)
        }
      }
    }
    await walk(base.absolute, base.relative, 1)
    return results
  }

  async apply(operation: FileOperation): Promise<{ path: string; summary: string }> {
    if (!operation || typeof operation !== 'object') throw new ToolInputError('Invalid file operation.')
    if (operation.action === 'write') return this.write(operation.path, operation.content)
    if (operation.action === 'edit') return this.edit(operation.path, operation.search, operation.replace)
    if (operation.action === 'delete') return this.remove(operation.path)
    throw new ToolInputError(`Unknown action ${(operation as { action?: string }).action}.`)
  }

  async write(requested: string, content: string): Promise<{ path: string; summary: string }> {
    if (typeof content !== 'string') throw new ToolInputError('content must be a string.')
    if (Buffer.byteLength(content) > this.scope.maxWriteBytes) throw new ToolInputError(`Content exceeds ${this.scope.maxWriteBytes} bytes.`)
    if (content.includes('\0')) throw new ToolInputError('Binary content is not allowed.')
    const { absolute, relative } = this.assertWritable(requested)
    const existed = existsSync(absolute)
    const normalized = await this.matchLineEndings(absolute, stripCodeFence(content))
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, normalized, 'utf8')
    this.touched.add(relative)
    return { path: relative, summary: `${existed ? 'Overwrote' : 'Created'} ${relative} (${normalized.split('\n').length} lines).` }
  }

  async edit(requested: string, search: string, replace: string): Promise<{ path: string; summary: string }> {
    if (typeof search !== 'string' || !search) throw new ToolInputError('search must be a non-empty string.')
    if (typeof replace !== 'string') throw new ToolInputError('replace must be a string.')
    const { absolute, relative } = this.assertWritable(requested)
    let original: string
    try {
      original = await fs.readFile(absolute, 'utf8')
    } catch {
      throw new ToolInputError(`Cannot edit missing file ${relative}; use write_file to create it.`)
    }
    const eol = original.includes('\r\n') ? '\r\n' : '\n'
    const text = original.replace(/\r\n/g, '\n')
    const needle = search.replace(/\r\n/g, '\n')
    const replacement = replace.replace(/\r\n/g, '\n')

    let updated: string | undefined
    const occurrences = countOccurrences(text, needle)
    if (occurrences === 1) {
      updated = text.replace(needle, () => replacement)
    } else if (occurrences > 1) {
      throw new ToolInputError(`search text occurs ${occurrences} times in ${relative}; include more surrounding lines to make it unique.`)
    } else {
      updated = fuzzyLineReplace(text, needle, replacement)
      if (updated === undefined) throw new ToolInputError(`search text not found in ${relative}. Read the file again and copy the exact lines.`)
    }
    if (Buffer.byteLength(updated) > this.scope.maxWriteBytes) throw new ToolInputError(`Result exceeds ${this.scope.maxWriteBytes} bytes.`)
    await fs.writeFile(absolute, eol === '\r\n' ? updated.replace(/\n/g, '\r\n') : updated, 'utf8')
    this.touched.add(relative)
    return { path: relative, summary: `Edited ${relative}.` }
  }

  async remove(requested: string): Promise<{ path: string; summary: string }> {
    if (!this.scope.allowDelete) throw new ToolInputError('Deleting files is not allowed for this task.')
    const { absolute, relative } = this.assertWritable(requested)
    const stat = await fs.stat(absolute).catch(() => undefined)
    if (!stat?.isFile()) throw new ToolInputError(`${relative} is not an existing file.`)
    await fs.unlink(absolute)
    this.touched.add(relative)
    return { path: relative, summary: `Deleted ${relative}.` }
  }

  private async matchLineEndings(absolute: string, content: string): Promise<string> {
    try {
      const existing = await fs.readFile(absolute, 'utf8')
      if (existing.includes('\r\n')) return content.replace(/\r?\n/g, '\r\n')
    } catch {
      // new file
    }
    return content.replace(/\r\n/g, '\n')
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** Matches the search block line-by-line ignoring leading/trailing whitespace differences. */
function fuzzyLineReplace(text: string, search: string, replace: string): string | undefined {
  const lines = text.split('\n')
  const searchLines = search.split('\n')
  while (searchLines.length && !searchLines[0]!.trim()) searchLines.shift()
  while (searchLines.length && !searchLines.at(-1)!.trim()) searchLines.pop()
  if (!searchLines.length) return undefined
  const target = searchLines.map((line) => line.trim())
  const matches: number[] = []
  for (let start = 0; start + target.length <= lines.length; start += 1) {
    let ok = true
    for (let offset = 0; offset < target.length; offset += 1) {
      if (lines[start + offset]!.trim() !== target[offset]) {
        ok = false
        break
      }
    }
    if (ok) matches.push(start)
  }
  if (matches.length !== 1) return undefined
  const start = matches[0]!
  return [...lines.slice(0, start), ...replace.split('\n'), ...lines.slice(start + target.length)].join('\n')
}

/** Models sometimes wrap whole-file content in a markdown fence; strip a single enclosing fence. */
export function stripCodeFence(content: string): string {
  const match = content.match(/^\s*```[\w.+-]*\n([\s\S]*?)\n```\s*$/)
  return match ? `${match[1]}\n` : content
}

export function describeOperation(operation: FileOperation): string {
  return `${operation.action} ${normalizeRelative(operation.path)}`
}
