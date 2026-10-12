import { promises as fs } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { changeStats, diffBetween, modeChanges, type FileChangeStat } from '../git/git.js'
import { isSecurityCriticalPath, isSensitivePath, matchesAny, normalizeRelative } from '../security/paths.js'

export type IssueSeverity = 'blocking' | 'warning'

export interface PatchIssue {
  severity: IssueSeverity
  code:
    | 'path_traversal'
    | 'sensitive_file'
    | 'denied_file'
    | 'out_of_scope'
    | 'binary_file'
    | 'symlink'
    | 'submodule'
    | 'executable_bit'
    | 'file_too_large'
    | 'too_many_files'
    | 'syntax_error'
    | 'conflict_marker'
    | 'secret_added'
    | 'empty_patch'
    | 'security_critical'
  file?: string
  message: string
}

export interface PatchPolicy {
  /** Glob patterns the change may touch. Empty = whole workspace (minus denied/sensitive). */
  allowedPatterns: string[]
  deniedPatterns: string[]
  /** When false, out-of-scope files are warnings instead of blocking issues. */
  strictScope: boolean
  maxFiles: number
  maxFileBytes: number
  allowEmpty?: boolean
}

export const DEFAULT_DENIED_PATTERNS = ['.git/**', '**/node_modules/**', '.github/workflows/**', '**/.husky/**']

export const DEFAULT_PATCH_POLICY: PatchPolicy = {
  allowedPatterns: [],
  deniedPatterns: DEFAULT_DENIED_PATTERNS,
  strictScope: false,
  maxFiles: 60,
  maxFileBytes: 512 * 1024,
}

export interface PatchValidationResult {
  ok: boolean
  issues: PatchIssue[]
  files: FileChangeStat[]
  securityCritical: string[]
  linesAdded: number
  linesDeleted: number
  diff: string
}

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})( |$)/m
const ADDED_SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{20,}/,
]

/**
 * Validates the committed change between `baseCommit` and `head` inside a worktree.
 * Every patch produced by any agent (local or premium) passes through here before
 * tests run or integration is offered.
 */
export async function validatePatch(worktreePath: string, baseCommit: string, head = 'HEAD', policy: PatchPolicy = DEFAULT_PATCH_POLICY): Promise<PatchValidationResult> {
  const issues: PatchIssue[] = []
  const files = await changeStats(worktreePath, baseCommit, head)
  const modes = await modeChanges(worktreePath, baseCommit, head)
  const diff = await diffBetween(worktreePath, baseCommit, head)

  if (!files.length && !policy.allowEmpty) {
    issues.push({ severity: 'blocking', code: 'empty_patch', message: 'The agent did not change any file.' })
  }
  if (files.length > policy.maxFiles) {
    issues.push({ severity: 'blocking', code: 'too_many_files', message: `Patch touches ${files.length} files (limit ${policy.maxFiles}).` })
  }

  for (const mode of modes) {
    if (mode.mode === '120000') issues.push({ severity: 'blocking', code: 'symlink', file: mode.path, message: 'Symlinks may not be created by agents.' })
    else if (mode.mode === '160000') issues.push({ severity: 'blocking', code: 'submodule', file: mode.path, message: 'Submodule changes are not allowed.' })
    else if (mode.mode === '100755') issues.push({ severity: 'warning', code: 'executable_bit', file: mode.path, message: 'File is marked executable.' })
  }

  const securityCritical: string[] = []
  let linesAdded = 0
  let linesDeleted = 0

  for (const file of files) {
    linesAdded += file.added ?? 0
    linesDeleted += file.deleted ?? 0
    const relative = normalizeRelative(file.path)
    for (const candidate of [relative, file.oldPath ? normalizeRelative(file.oldPath) : undefined].filter((value): value is string => Boolean(value))) {
      if (candidate.split('/').includes('..') || path.isAbsolute(candidate) || /^[a-zA-Z]:/.test(candidate)) {
        issues.push({ severity: 'blocking', code: 'path_traversal', file: candidate, message: 'Path escapes the workspace.' })
      }
      if (isSensitivePath(candidate)) {
        issues.push({ severity: 'blocking', code: 'sensitive_file', file: candidate, message: 'Credential or secret-like files may not be modified by agents.' })
      }
      if (matchesAny(candidate, policy.deniedPatterns)) {
        issues.push({ severity: 'blocking', code: 'denied_file', file: candidate, message: 'File is on the deny list for this task.' })
      }
      if (policy.allowedPatterns.length && !matchesAny(candidate, policy.allowedPatterns)) {
        issues.push({
          severity: policy.strictScope ? 'blocking' : 'warning',
          code: 'out_of_scope',
          file: candidate,
          message: 'File is outside the task scope assigned by the planner.',
        })
      }
    }
    if (isSecurityCriticalPath(relative)) securityCritical.push(relative)
    if (file.binary) {
      issues.push({ severity: 'blocking', code: 'binary_file', file: relative, message: 'Binary files may not be produced by agents.' })
      continue
    }
    if (file.status === 'D') continue

    const absolute = path.join(worktreePath, relative)
    let content: string
    try {
      const stat = await fs.stat(absolute)
      if (stat.size > policy.maxFileBytes) {
        issues.push({ severity: 'blocking', code: 'file_too_large', file: relative, message: `File is ${stat.size} bytes (limit ${policy.maxFileBytes}).` })
        continue
      }
      content = await fs.readFile(absolute, 'utf8')
    } catch {
      continue
    }

    if (CONFLICT_MARKER.test(content)) {
      issues.push({ severity: 'blocking', code: 'conflict_marker', file: relative, message: 'File contains merge conflict markers.' })
    }
    const syntax = checkSyntax(relative, content)
    if (syntax) issues.push({ severity: 'blocking', code: 'syntax_error', file: relative, message: syntax })
  }

  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    if (ADDED_SECRET_PATTERNS.some((pattern) => pattern.test(line))) {
      issues.push({ severity: 'blocking', code: 'secret_added', message: 'The patch adds a credential-looking value.' })
      break
    }
  }

  if (securityCritical.length) {
    issues.push({
      severity: 'warning',
      code: 'security_critical',
      message: `Security-critical files changed: ${securityCritical.slice(0, 8).join(', ')}. A strict review is required.`,
    })
  }

  return {
    ok: !issues.some((issue) => issue.severity === 'blocking'),
    issues,
    files,
    securityCritical,
    linesAdded,
    linesDeleted,
    diff,
  }
}

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
}

/** Deterministic syntax check (no type information). Returns an error message or undefined. */
export function checkSyntax(file: string, content: string): string | undefined {
  const extension = path.extname(file).toLowerCase()
  const base = path.basename(file).toLowerCase()
  if (extension in SCRIPT_KINDS) {
    const kind = SCRIPT_KINDS[extension]!
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false, kind)
    const diagnostics = (source as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []
    const first = diagnostics[0]
    if (!first) return undefined
    const position = first.start !== undefined ? source.getLineAndCharacterOfPosition(first.start) : undefined
    const message = ts.flattenDiagnosticMessageText(first.messageText, ' ')
    return `${position ? `line ${position.line + 1}:${position.character + 1} ` : ''}${message}${diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : ''}`
  }
  if (extension === '.json') {
    if (/^(tsconfig|jsconfig)(\..+)?\.json$/.test(base) || base.endsWith('.jsonc')) {
      const parsed = ts.parseConfigFileTextToJson(file, content)
      return parsed.error ? ts.flattenDiagnosticMessageText(parsed.error.messageText, ' ') : undefined
    }
    try {
      JSON.parse(content)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  return undefined
}
