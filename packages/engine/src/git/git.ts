import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runProcess, type ProcessResult } from '../util/process.js'

export class GitError extends Error {
  constructor(
    message: string,
    readonly result?: ProcessResult,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export const AGENT_GIT_IDENTITY = { name: 'Multi-AI Coder Agent', email: 'agent@multi-ai-coder.local' }

let emptyHooksDir: string | undefined
/** An empty hooks directory: internal operations on agent worktrees must not run project git hooks. */
function hooksDisabledDir(): string {
  if (!emptyHooksDir) {
    emptyHooksDir = path.join(os.tmpdir(), 'multi-ai-coder-no-hooks')
    mkdirSync(emptyHooksDir, { recursive: true })
  }
  return emptyHooksDir
}

export interface GitRunOptions {
  /** Disable hooks and use the agent identity (internal worktree operations). */
  internal?: boolean
  input?: string
  timeoutMs?: number
  allowFailure?: boolean
}

export async function git(cwd: string, args: string[], options: GitRunOptions = {}): Promise<ProcessResult> {
  const prefix = options.internal
    ? [
        '-c', `core.hooksPath=${hooksDisabledDir()}`,
        '-c', `user.name=${AGENT_GIT_IDENTITY.name}`,
        '-c', `user.email=${AGENT_GIT_IDENTITY.email}`,
        '-c', 'commit.gpgsign=false',
      ]
    : []
  const result = await runProcess('git', ['-c', 'core.quotepath=false', ...prefix, ...args], {
    cwd,
    input: options.input,
    timeoutMs: options.timeoutMs ?? 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  })
  if (result.spawnError) throw new GitError(`git could not be started: ${result.spawnError}`, result)
  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new GitError(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 2000)}`, result)
  }
  return result
}

export async function gitVersion(): Promise<string | undefined> {
  const result = await runProcess('git', ['--version'], { timeoutMs: 10_000 })
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}

export async function isGitRepository(dir: string): Promise<boolean> {
  try {
    const result = await git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true })
    return result.exitCode === 0 && result.stdout.trim() === 'true'
  } catch {
    return false
  }
}

export async function repositoryRoot(dir: string): Promise<string> {
  const result = await git(dir, ['rev-parse', '--show-toplevel'])
  return path.resolve(result.stdout.trim())
}

export async function headCommit(dir: string): Promise<string | undefined> {
  const result = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true })
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}

export async function currentBranch(dir: string): Promise<string | undefined> {
  const result = await git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true })
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}

export interface StatusEntry {
  path: string
  originalPath?: string
  index: string
  worktree: string
  untracked: boolean
  conflicted: boolean
}

/** Parses `git status --porcelain=v1 -z`. */
export function parsePorcelainZ(output: string): StatusEntry[] {
  const entries: StatusEntry[] = []
  const parts = output.split('\0')
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index]
    if (!record || record.length < 4) continue
    const x = record[0]!
    const y = record[1]!
    const filePath = record.slice(3)
    const entry: StatusEntry = {
      path: filePath,
      index: x,
      worktree: y,
      untracked: x === '?' && y === '?',
      conflicted: x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D'),
    }
    if (x === 'R' || x === 'C') {
      entry.originalPath = parts[index + 1]
      index += 1
    }
    entries.push(entry)
  }
  return entries
}

export async function status(dir: string): Promise<StatusEntry[]> {
  const result = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  return parsePorcelainZ(result.stdout)
}

export async function listBranches(dir: string): Promise<Array<{ name: string; current: boolean; sha: string }>> {
  const result = await git(dir, ['branch', '--format=%(HEAD)\t%(refname:short)\t%(objectname)'])
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [head, name, sha] = line.split('\t')
      return { name: name ?? '', current: head === '*', sha: sha ?? '' }
    })
}

export async function recentCommits(dir: string, limit = 30): Promise<Array<{ sha: string; author: string; date: string; subject: string }>> {
  const result = await git(dir, ['log', `-n${limit}`, '--format=%H%x1f%an%x1f%aI%x1f%s'], { allowFailure: true })
  if (result.exitCode !== 0) return []
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, author, date, subject] = line.split('\x1f')
      return { sha: sha ?? '', author: author ?? '', date: date ?? '', subject: subject ?? '' }
    })
}

export const DEPENDENCY_DIR_EXCLUDES = [':(exclude,glob)**/node_modules', ':(exclude,glob)**/node_modules/**']

/** Output that test runners write into the project (Playwright, coverage); never part of a change. */
export const TEST_OUTPUT_EXCLUDES = ['test-results', 'playwright-report', 'blob-report', 'coverage', '.nyc_output'].flatMap((name) => [`:(exclude,glob)**/${name}`, `:(exclude,glob)**/${name}/**`])

/** Stages everything in an agent worktree except linked dependency folders and test runner output. */
export async function stageAll(dir: string): Promise<void> {
  await git(dir, ['add', '-A', '--', '.', ...DEPENDENCY_DIR_EXCLUDES, ...TEST_OUTPUT_EXCLUDES], { internal: true })
}

export async function hasStagedChanges(dir: string): Promise<boolean> {
  const result = await git(dir, ['diff', '--cached', '--quiet'], { allowFailure: true })
  return result.exitCode === 1
}

export async function commitStaged(dir: string, message: string): Promise<string> {
  await git(dir, ['commit', '--no-verify', '-q', '-F', '-'], { internal: true, input: message })
  const sha = await headCommit(dir)
  if (!sha) throw new GitError('Commit did not produce a HEAD.')
  return sha
}

export async function diffBetween(dir: string, from: string, to = 'HEAD', extra: string[] = []): Promise<string> {
  const result = await git(dir, ['diff', '--binary', '--no-color', '--no-ext-diff', ...extra, from, to, '--', '.', ...DEPENDENCY_DIR_EXCLUDES])
  return result.stdout
}

export interface FileChangeStat {
  path: string
  status: string
  added: number | null
  deleted: number | null
  binary: boolean
  oldPath?: string
}

/** Combines --name-status and --numstat for a commit range. */
export async function changeStats(dir: string, from: string, to = 'HEAD'): Promise<FileChangeStat[]> {
  const nameStatus = await git(dir, ['diff', '--name-status', '-z', '-M', from, to, '--', '.', ...DEPENDENCY_DIR_EXCLUDES])
  const numstat = await git(dir, ['diff', '--numstat', '-z', '-M', from, to, '--', '.', ...DEPENDENCY_DIR_EXCLUDES])

  const counts = new Map<string, { added: number | null; deleted: number | null }>()
  const numParts = numstat.stdout.split('\0')
  for (let index = 0; index < numParts.length; index += 1) {
    const record = numParts[index]
    if (!record) continue
    const [added, deleted, file] = record.split('\t')
    let target = file
    if (file === '' || file === undefined) {
      // rename: "added\tdeleted\t\0old\0new"
      target = numParts[index + 2]
      index += 2
    }
    if (target) {
      counts.set(target, {
        added: added === '-' ? null : Number(added),
        deleted: deleted === '-' ? null : Number(deleted),
      })
    }
  }

  const stats: FileChangeStat[] = []
  const parts = nameStatus.stdout.split('\0').filter((part) => part !== '')
  for (let index = 0; index < parts.length; index += 1) {
    const code = parts[index]!
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = parts[index + 1]!
      const newPath = parts[index + 2]!
      index += 2
      const count = counts.get(newPath)
      stats.push({ path: newPath, oldPath, status: code[0]!, added: count?.added ?? null, deleted: count?.deleted ?? null, binary: count?.added === null })
    } else {
      const file = parts[index + 1]!
      index += 1
      const count = counts.get(file)
      stats.push({ path: file, status: code, added: count?.added ?? null, deleted: count?.deleted ?? null, binary: count?.added === null })
    }
  }
  return stats
}

/** Mode changes (executable bit, symlinks, submodules) from `git diff --summary`. */
export async function modeChanges(dir: string, from: string, to = 'HEAD'): Promise<Array<{ path: string; mode: string; kind: string }>> {
  const result = await git(dir, ['diff', '--summary', from, to])
  const changes: Array<{ path: string; mode: string; kind: string }> = []
  for (const line of result.stdout.split('\n')) {
    const match = line.trim().match(/^(create|delete) mode (\d{6}) (.+)$/) ?? line.trim().match(/^mode change \d{6} => (\d{6}) (.+)$/)
    if (!match) continue
    if (match.length === 4) changes.push({ kind: match[1]!, mode: match[2]!, path: match[3]! })
    else changes.push({ kind: 'mode change', mode: match[1]!, path: match[2]! })
  }
  return changes
}

export async function showFileAt(dir: string, revision: string, file: string): Promise<string | undefined> {
  const result = await git(dir, ['show', `${revision}:${file.replaceAll('\\', '/')}`], { allowFailure: true })
  return result.exitCode === 0 ? result.stdout : undefined
}

export interface CherryPickResult {
  ok: boolean
  sha?: string
  conflicts: string[]
  message?: string
}

/** Squashes all commits after `base` into one commit with `message` (staged state is preserved). */
export async function squashSince(dir: string, base: string, message: string): Promise<string> {
  await git(dir, ['reset', '-q', '--soft', base], { internal: true })
  return commitStaged(dir, message)
}

/**
 * Task commits on an integration branch since `base`, keyed by task key. Task commits use the subject
 * "<key>: <title>"; this lets a resumed run recognise work that was integrated before an interruption
 * even if the database update for it was lost.
 */
export async function integratedTaskCommits(dir: string, base: string, keys: string[]): Promise<Map<string, string>> {
  const result = await git(dir, ['log', '--format=%H%x1f%s', `${base}..HEAD`], { allowFailure: true })
  const found = new Map<string, string>()
  if (result.exitCode !== 0) return found
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const [sha, subject = ''] = line.split('\x1f')
    const key = keys.find((candidate) => subject.startsWith(`${candidate}: `))
    // git log lists newest first; the newest commit of a task wins.
    if (key && sha && !found.has(key)) found.set(key, sha)
  }
  return found
}

export async function cherryPick(dir: string, commit: string): Promise<CherryPickResult> {
  const result = await git(dir, ['cherry-pick', '--allow-empty', '--keep-redundant-commits', commit], { internal: true, allowFailure: true })
  if (result.exitCode === 0) return { ok: true, sha: await headCommit(dir), conflicts: [] }
  const conflicted = await git(dir, ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true })
  const conflicts = conflicted.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  await git(dir, ['cherry-pick', '--abort'], { internal: true, allowFailure: true })
  return { ok: false, conflicts, message: (result.stderr || result.stdout).trim().slice(0, 2000) }
}

export async function applyPatch(
  dir: string,
  patchText: string,
  options: { check?: boolean; reverse?: boolean; threeWay?: boolean; index?: boolean } = {},
): Promise<{ ok: boolean; message: string }> {
  const args = ['apply', '--whitespace=nowarn']
  if (options.check) args.push('--check')
  if (options.reverse) args.push('-R')
  if (options.threeWay) args.push('--3way')
  if (options.index) args.push('--index')
  args.push('-')
  const result = await git(dir, args, { allowFailure: true, input: patchText })
  return { ok: result.exitCode === 0, message: (result.stderr || result.stdout).trim() }
}

export async function deleteBranch(dir: string, branch: string): Promise<void> {
  await git(dir, ['branch', '-D', branch], { internal: true, allowFailure: true })
}

export async function branchExists(dir: string, branch: string): Promise<boolean> {
  const result = await git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFailure: true })
  return result.exitCode === 0
}

export async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await git(dir, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true })
  return result.exitCode === 0
}

/** Tracked + untracked (non-ignored) files, as reported by git. */
export async function listFiles(dir: string): Promise<string[]> {
  const result = await git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  return [...new Set(result.stdout.split('\0').filter(Boolean))]
}

export async function initRepository(dir: string, initialBranch = 'main'): Promise<void> {
  await git(dir, ['init', '-q', '-b', initialBranch])
}

export async function cloneRepository(url: string, target: string, timeoutMs = 10 * 60_000): Promise<void> {
  if (!/^(https:\/\/|git@|ssh:\/\/)/.test(url)) throw new GitError('Only https://, ssh:// and git@ clone URLs are supported.')
  const result = await runProcess('git', ['clone', '--', url, target], {
    timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (result.exitCode !== 0) throw new GitError(`git clone failed: ${(result.stderr || result.stdout).trim().slice(0, 2000)}`, result)
}
