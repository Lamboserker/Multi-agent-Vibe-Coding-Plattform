import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import {
  applyPatch,
  branchExists,
  changeStats,
  cherryPick,
  currentBranch,
  diffBetween,
  git,
  GitError,
  headCommit,
  isAncestor,
  status,
} from '../git/git.js'

/** commit: onto the checked-out branch (fast-forward, or a merge commit when the branch moved). */
export type ApplyMode = 'branch' | 'working_tree' | 'fast_forward' | 'commit'

export interface ApplyOutcome {
  ok: boolean
  mode: ApplyMode
  message: string
  files: string[]
  beforeHead?: string
  afterHead?: string
  targetBranch?: string
  patch?: string
  /** Files with uncommitted user changes that block the operation. */
  blockedBy?: string[]
  /**
   * Why a working-tree/fast-forward apply was refused: user changes in the same files, the branch
   * moved since the run started (the change builds on files that differ or are gone), or a conflict.
   */
  reason?: 'dirty' | 'base_moved' | 'conflict'
  /** Files the change modifies that existed at the run's base but are missing in the checkout now. */
  missingFiles?: string[]
}

const listFiles = (files: string[]) => files.slice(0, 5).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '')

/** Serializes integration steps (cherry-picks onto the integration worktree). */
export class Mutex {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => (release = resolve))
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

/** Integrates one task commit onto the integration worktree. Conflicts abort cleanly. */
export async function integrateCommit(integrationWorktree: string, commit: string) {
  return cherryPick(integrationWorktree, commit)
}

/** Files the change set touches (base..head). */
export async function changedFiles(worktree: string, base: string, head = 'HEAD'): Promise<string[]> {
  const stats = await changeStats(worktree, base, head)
  return [...new Set(stats.flatMap((stat) => [stat.path, stat.oldPath].filter((value): value is string => Boolean(value))))]
}

/** Uncommitted (or untracked) user changes that overlap the given files. */
export async function conflictingUserChanges(repoPath: string, files: string[]): Promise<string[]> {
  const entries = await status(repoPath)
  const dirty = new Set(entries.flatMap((entry) => [entry.path, entry.originalPath].filter((value): value is string => Boolean(value))))
  return files.filter((file) => dirty.has(file))
}

/**
 * Applies the integrated change set to the user's repository according to the approval mode.
 * Never touches files that have uncommitted user changes; never pushes.
 */
export async function applyChangeSet(input: {
  repoPath: string
  integrationWorktree: string
  integrationBranch: string
  baseCommit: string
  mode: ApplyMode
  /** Message of the merge commit when the branch moved (mode commit). */
  commitMessage?: string
}): Promise<ApplyOutcome> {
  const integrationHead = await headCommit(input.integrationWorktree)
  if (!integrationHead) throw new GitError('Integration worktree has no commit.')
  const patch = await diffBetween(input.integrationWorktree, input.baseCommit, integrationHead)
  const files = await changedFiles(input.integrationWorktree, input.baseCommit, integrationHead)
  const beforeHead = await headCommit(input.repoPath)
  const targetBranch = await currentBranch(input.repoPath)

  if (!files.length) return { ok: false, mode: input.mode, message: 'The change set is empty.', files }

  if (input.mode === 'branch') {
    return {
      ok: true,
      mode: 'branch',
      message: `Changes are available on branch "${input.integrationBranch}". Merge it when you are ready.`,
      files,
      beforeHead,
      afterHead: beforeHead,
      targetBranch: input.integrationBranch,
      patch,
    }
  }

  const blockedBy = await conflictingUserChanges(input.repoPath, files)
  if (blockedBy.length) {
    return {
      ok: false,
      mode: input.mode,
      message: `Uncommitted changes in ${listFiles(blockedBy)} would be overwritten. Commit or stash them first, or keep the result as a branch.`,
      files,
      blockedBy,
      reason: 'dirty',
      beforeHead,
      targetBranch,
    }
  }

  if (input.mode === 'fast_forward') {
    if (!targetBranch) return { ok: false, mode: input.mode, message: 'The repository is in detached HEAD state.', files, beforeHead }
    if (!beforeHead || !(await isAncestor(input.repoPath, beforeHead, integrationHead))) {
      return {
        ok: false,
        mode: input.mode,
        message: `"${targetBranch}" moved since the run started; a fast-forward is not possible. Apply to the working tree or merge the branch instead.`,
        reason: 'base_moved',
        files,
        beforeHead,
        targetBranch,
      }
    }
    const result = await git(input.repoPath, ['merge', '--ff-only', '-q', integrationHead], { allowFailure: true })
    if (result.exitCode !== 0) return { ok: false, mode: input.mode, message: `Fast-forward failed: ${(result.stderr || result.stdout).trim()}`, files, beforeHead, targetBranch }
    return { ok: true, mode: input.mode, message: `Fast-forwarded "${targetBranch}" to the integrated result.`, files, beforeHead, afterHead: integrationHead, targetBranch, patch }
  }

  if (input.mode === 'commit') {
    if (!targetBranch) return { ok: false, mode: input.mode, message: 'The repository is in detached HEAD state; check out a branch (e.g. main) first.', files, beforeHead }
    // the branch did not move since the run started: its commits go on top (fast-forward)
    if (beforeHead && (await isAncestor(input.repoPath, beforeHead, integrationHead))) {
      const forward = await git(input.repoPath, ['merge', '--ff-only', '-q', integrationHead], { allowFailure: true })
      if (forward.exitCode === 0) return { ok: true, mode: input.mode, message: `Committed ${files.length} file(s) to "${targetBranch}".`, files, beforeHead, afterHead: integrationHead, targetBranch, patch }
    }
    // the branch moved (newer commits of the user): a merge commit on top of the newer state.
    // Conflicts are detected in memory first (merge-tree), so a conflicting merge never touches the checkout.
    const probe = await git(input.repoPath, ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', integrationHead], { allowFailure: true })
    if (probe.exitCode === 1) {
      const conflicts = probe.stdout.split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean)
      return {
        ok: false,
        mode: input.mode,
        message: `The working copy differs from the state the run started from; the change conflicts with the current files (conflicts in ${listFiles(conflicts)} with newer commits on "${targetBranch}"). Nothing was changed. Keep the result as a branch or run the task again on the current state.`,
        files,
        beforeHead,
        targetBranch,
        reason: 'conflict',
      }
    }
    const message = input.commitMessage ?? `Multi-AI Coder: ${input.integrationBranch}`
    const mergeArgs = ['merge', '--no-ff', '--no-edit', '-q', '-m', message, integrationHead]
    let merge = await git(input.repoPath, mergeArgs, { allowFailure: true })
    if (merge.exitCode !== 0 && /tell me who you are|empty ident|user\.(name|email)/i.test(merge.stderr + merge.stdout) && !(await unmergedFiles(input.repoPath, files)).length) {
      // no git identity configured: the app's identity
      merge = await git(input.repoPath, mergeArgs, { allowFailure: true, internal: true })
    }
    if (merge.exitCode !== 0) {
      const conflicts = await unmergedFiles(input.repoPath, files)
      // nothing may stay half-merged in the user's checkout
      await git(input.repoPath, ['merge', '--abort'], { allowFailure: true })
      return {
        ok: false,
        mode: input.mode,
        message: `The working copy differs from the state the run started from; the change conflicts with the current files (${conflicts.length ? `conflicts in ${listFiles(conflicts)} with newer commits on "${targetBranch}"` : (merge.stderr || merge.stdout).trim().split('\n')[0]}). Nothing was changed. Keep the result as a branch or run the task again on the current state.`,
        files,
        beforeHead,
        targetBranch,
        reason: 'conflict',
      }
    }
    const afterHead = await headCommit(input.repoPath)
    return { ok: true, mode: input.mode, message: `Committed ${files.length} file(s) to "${targetBranch}" (merged on top of its newer commits).`, files, beforeHead, afterHead, targetBranch, patch }
  }

  // working_tree: apply the patch without committing (3-way merge when the base moved).
  const check = await applyPatch(input.repoPath, patch, { check: true })
  const useThreeWay = !check.ok
  if (useThreeWay) {
    const threeWayCheck = await applyPatch(input.repoPath, patch, { check: true, threeWay: true })
    if (!threeWayCheck.ok) {
      // explain it: did the branch move since the run started, are files the change builds on gone?
      const atBase = await git(input.integrationWorktree, ['ls-tree', '-r', '--name-only', input.baseCommit, '--', ...files], { allowFailure: true })
      const missingFiles = atBase.stdout.split(/\r?\n/).filter(Boolean).filter((file) => !existsSync(path.join(input.repoPath, file)))
      const moved = Boolean(beforeHead && beforeHead !== input.baseCommit)
      const detail = (threeWayCheck.message || check.message).replace(/Falling back to direct application\.\.\.\s*/g, '').trim()
      const parts = [
        moved ? `"${targetBranch ?? 'HEAD'}" moved since the run started (base ${input.baseCommit.slice(0, 8)}, now ${beforeHead!.slice(0, 8)})` : 'The working copy differs from the state the run started from',
        missingFiles.length ? `${missingFiles.length} file(s) the change builds on are missing in the working copy: ${listFiles(missingFiles)}` : `the change conflicts with the current files (${detail})`,
      ]
      return { ok: false, mode: input.mode, message: `${parts.join('; ')}. Keep the result as a branch or run the task again on the current state.`, files, beforeHead, targetBranch, reason: moved || missingFiles.length ? 'base_moved' : 'conflict', missingFiles }
    }
  }
  // All or nothing: a failed or conflicting apply must not leave conflict markers or an unmerged
  // index in the user's checkout. The touched files are restored byte for byte.
  const snapshot = await snapshotFiles(input.repoPath, files)
  const applied = await applyPatch(input.repoPath, patch, { threeWay: useThreeWay })
  const unmerged = applied.ok ? await unmergedFiles(input.repoPath, files) : []
  if (!applied.ok || unmerged.length) {
    await restoreSnapshot(input.repoPath, snapshot)
    const conflicts = unmerged.length ? unmerged : conflictedFromOutput(applied.message)
    return {
      ok: false,
      mode: input.mode,
      message: `The working copy differs from the state the run started from; the change conflicts with the current files (${conflicts.length ? `conflicts in ${listFiles(conflicts)}` : applied.message.replace(/Falling back to direct application\.\.\.\s*/g, '').split('\n')[0]}). Nothing was changed. Keep the result as a branch or run the task again on the current state.`,
      files,
      beforeHead,
      targetBranch,
      reason: 'conflict',
    }
  }
  if (useThreeWay) {
    // --3way stages the result; unstage to leave the user's index as it was.
    await git(input.repoPath, ['reset', '-q', '--', ...files], { allowFailure: true })
  }
  return {
    ok: true,
    mode: input.mode,
    message: `Applied ${files.length} file(s) to the working tree (not committed).`,
    files,
    beforeHead,
    afterHead: beforeHead,
    targetBranch,
    patch,
  }
}

interface FileSnapshot {
  file: string
  /** Content before the apply; undefined = the file did not exist. */
  content?: Buffer
}

/** The exact state of the files an apply will touch (ignored files included, they are not in git status). */
async function snapshotFiles(repoPath: string, files: string[]): Promise<FileSnapshot[]> {
  return Promise.all(files.map(async (file) => ({ file, content: await fs.readFile(path.join(repoPath, file)).catch(() => undefined) })))
}

/**
 * Restores index and working tree of the snapshotted files. The apply only runs when none of them
 * had user changes, so their index entries were the committed ones: reset them to HEAD (this also
 * resolves unmerged entries) and write the previous bytes back.
 */
async function restoreSnapshot(repoPath: string, snapshot: FileSnapshot[]) {
  const files = snapshot.map((entry) => entry.file)
  const inHead = new Set((await git(repoPath, ['ls-tree', '-r', '--name-only', 'HEAD', '--', ...files], { allowFailure: true })).stdout.split(/\r?\n/).filter(Boolean))
  const tracked = files.filter((file) => inHead.has(file))
  const untracked = files.filter((file) => !inHead.has(file))
  if (tracked.length) await git(repoPath, ['reset', '-q', '--', ...tracked], { allowFailure: true })
  if (untracked.length) await git(repoPath, ['rm', '-q', '--cached', '-f', '--ignore-unmatch', '--', ...untracked], { allowFailure: true })
  for (const entry of snapshot) {
    const absolute = path.join(repoPath, entry.file)
    if (entry.content === undefined) await fs.rm(absolute, { force: true })
    else {
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      await fs.writeFile(absolute, entry.content)
    }
  }
}

async function unmergedFiles(repoPath: string, files: string[]): Promise<string[]> {
  const result = await git(repoPath, ['diff', '--name-only', '--diff-filter=U', '--', ...files], { allowFailure: true })
  return result.stdout.split(/\r?\n/).filter(Boolean)
}

/** "U path" lines of a failed `git apply --3way`. */
function conflictedFromOutput(output: string): string[] {
  return [...output.matchAll(/^U (.+)$/gm)].map((match) => match[1]!.trim())
}

/** Reverts a previously applied change set (undo). */
export async function revertChangeSet(input: { repoPath: string; mode: ApplyMode; patch: string; files: string[]; beforeHead?: string; afterHead?: string }): Promise<{ ok: boolean; message: string }> {
  if (input.mode === 'branch') return { ok: true, message: 'Nothing was applied to your checkout; delete the branch to discard it.' }
  if (input.mode === 'working_tree') {
    const check = await applyPatch(input.repoPath, input.patch, { reverse: true, check: true })
    if (!check.ok) return { ok: false, message: `The files were changed after applying; automatic undo is not possible (${check.message}).` }
    const result = await applyPatch(input.repoPath, input.patch, { reverse: true })
    return result.ok ? { ok: true, message: 'Changes were removed from the working tree.' } : { ok: false, message: result.message }
  }
  // fast_forward / commit: move the branch back only if nothing happened on top and the files are clean.
  const head = await headCommit(input.repoPath)
  if (!input.beforeHead || head !== input.afterHead) return { ok: false, message: 'The branch moved after the fast-forward; revert the commits manually (git revert).' }
  const dirty = await conflictingUserChanges(input.repoPath, input.files)
  if (dirty.length) return { ok: false, message: `Uncommitted changes in ${dirty.join(', ')} – undo would overwrite them.` }
  const result = await git(input.repoPath, ['reset', '--keep', '-q', input.beforeHead], { allowFailure: true })
  return result.exitCode === 0 ? { ok: true, message: 'Branch reset to its previous commit.' } : { ok: false, message: (result.stderr || result.stdout).trim() }
}

export async function ensureBranchAbsent(repoPath: string, branch: string): Promise<void> {
  if (await branchExists(repoPath, branch)) await git(repoPath, ['branch', '-D', branch], { internal: true, allowFailure: true })
}

// ---------------------------------------------------------------------------
// Catching up with a moved branch: conflicts are resolved in the integration worktree
// ---------------------------------------------------------------------------

/** One conflicting region of a file (diff3 style): the agent's text, the common base and the newer project text. */
export interface ConflictHunk {
  path: string
  agent: string
  base: string
  current: string
  /** A few lines before and after the region, for orientation. */
  before: string
  after: string
}

/** Returns the merged text of one region, or undefined when it cannot be merged. */
export type HunkResolver = (hunk: ConflictHunk) => Promise<string | undefined>

type ConflictSegment = string | { agent: string; base: string; current: string }

const CONFLICT_MARKER = /^(<{7}|\|{7}|={7}|>{7})(\s|$)/m

export function hasConflictMarkers(text: string): boolean {
  return CONFLICT_MARKER.test(text)
}

/** Splits a file with diff3 conflict markers into plain text and conflict regions; undefined if malformed. */
export function parseConflicts(text: string): ConflictSegment[] | undefined {
  const lines = text.split(/(?<=\n)/)
  const segments: ConflictSegment[] = []
  let plain = ''
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^<{7}(\s|$)/.test(lines[index]!)) {
      plain += lines[index]
      continue
    }
    const parts: Record<'agent' | 'base' | 'current', string> = { agent: '', base: '', current: '' }
    let part: keyof typeof parts | undefined = 'agent'
    let closed = false
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index]!
      if (/^\|{7}(\s|$)/.test(line)) part = 'base'
      else if (/^={7}(\s|$)/.test(line)) part = 'current'
      else if (/^>{7}(\s|$)/.test(line)) {
        closed = true
        break
      } else if (/^<{7}(\s|$)/.test(line)) return undefined
      else parts[part] += line
    }
    if (!closed) return undefined
    if (plain) segments.push(plain)
    plain = ''
    segments.push(parts)
  }
  if (plain) segments.push(plain)
  return segments
}

const normalized = (text: string) => text.replace(/\s+/g, ' ').trim()

const WORD = /^[\p{L}\p{N}_$]+$/u
const tokens = (text: string): string[] => text.match(/[\p{L}\p{N}_$]+|[^\p{L}\p{N}_$]+/gu) ?? []

/**
 * The agent only renamed identifiers in this region (e.g. Badge → Tag, as the rename tool does): the
 * same renames are applied to the newer project text, which then contains both changes exactly.
 * Undefined when the agent's change is more than consistent word-for-word renames.
 */
export function applyRenames(region: { agent: string; base: string; current: string }): string | undefined {
  const base = tokens(region.base)
  const agent = tokens(region.agent)
  if (!base.length || base.length !== agent.length) return undefined
  const renames = new Map<string, string>()
  for (let index = 0; index < base.length; index += 1) {
    const from = base[index]!
    const to = agent[index]!
    if (from === to) continue
    if (!WORD.test(from) || !WORD.test(to) || (renames.has(from) && renames.get(from) !== to)) return undefined
    renames.set(from, to)
  }
  if (!renames.size) return undefined
  const current = tokens(region.current)
  // the renamed identifiers must still be there: otherwise the agent's change would just be dropped
  if (![...renames.keys()].every((from) => current.includes(from))) return undefined
  return current.map((token) => renames.get(token) ?? token).join('')
}

/** Merges every conflict region of a file; undefined if one of them cannot be merged. */
export async function resolveConflictText(file: string, text: string, resolve?: HunkResolver, options: { renames?: boolean } = {}): Promise<string | undefined> {
  const segments = parseConflicts(text)
  if (!segments) return undefined
  let result = ''
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!
    if (typeof segment === 'string') {
      result += segment
      continue
    }
    let merged: string | undefined
    // whitespace-only differences: one side is enough
    if (normalized(segment.agent) === normalized(segment.current) || normalized(segment.agent) === normalized(segment.base)) merged = segment.current
    else if (normalized(segment.current) === normalized(segment.base)) merged = segment.agent
    if (merged === undefined && options.renames !== false) merged = applyRenames(segment)
    if (merged === undefined && resolve) {
      const previous = segments[index - 1]
      const next = segments[index + 1]
      merged = await resolve({
        path: file,
        ...segment,
        before: typeof previous === 'string' ? previous.split(/(?<=\n)/).slice(-12).join('') : '',
        after: typeof next === 'string' ? next.split(/(?<=\n)/).slice(0, 12).join('') : '',
      }).catch(() => undefined)
    }
    if (merged === undefined || hasConflictMarkers(merged)) return undefined
    if (merged && !merged.endsWith('\n') && (segment.agent.endsWith('\n') || segment.current.endsWith('\n'))) merged += '\n'
    result += merged
  }
  return result
}

export interface CatchUpOutcome {
  ok: boolean
  message: string
  /** Head of the integration branch afterwards (unchanged when not ok). */
  head?: string
  /** Files whose conflicts were merged. */
  resolved: string[]
  /** Files that could not be merged (deleted on one side, binary, or the resolver gave up). */
  unresolved: string[]
}

/**
 * Brings the integrated result up to date with the newer state of the user's branch by merging `target`
 * into the integration worktree – never in the user's checkout. Conflicting regions go to `resolve`;
 * if a file stays unresolved, the integration branch is left exactly as it was.
 */
/** renames: false skips the deterministic rename transfer (e.g. its result failed the checks before). */
export async function catchUpIntegration(input: { integrationWorktree: string; target: string; message: string; resolve?: HunkResolver; renames?: boolean }): Promise<CatchUpOutcome> {
  const worktree = input.integrationWorktree
  const before = await headCommit(worktree)
  if (!before) throw new GitError('Integration worktree has no commit.')
  if (await isAncestor(worktree, input.target, before)) return { ok: true, message: 'The result already contains the current state.', head: before, resolved: [], unresolved: [] }
  const merge = await git(worktree, ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-ff', '--no-commit', '-q', input.target], { allowFailure: true, internal: true })
  const unmerged = (await git(worktree, ['diff', '--name-only', '--diff-filter=U', '-z'], { allowFailure: true })).stdout.split('\0').filter(Boolean)
  const rollback = async () => {
    await git(worktree, ['merge', '--abort'], { allowFailure: true })
    await git(worktree, ['reset', '-q', '--hard', before], { allowFailure: true })
  }
  if (merge.exitCode !== 0 && !unmerged.length) {
    await rollback()
    return { ok: false, message: (merge.stderr || merge.stdout).trim().split('\n')[0] || 'The merge failed.', resolved: [], unresolved: [] }
  }
  const resolved: string[] = []
  const unresolved: string[] = []
  for (const file of unmerged) {
    const absolute = path.join(worktree, file)
    // only text both sides still have is merged: a file one side deleted (modify/delete) stays a decision
    // of the user, also when git left the other side's version without conflict markers
    const stages = new Set((await git(worktree, ['ls-files', '-u', '-z', '--', file], { allowFailure: true })).stdout.split('\0').filter(Boolean).map((entry) => entry.split(/\s+/)[2]))
    const text = stages.has('2') && stages.has('3') ? await fs.readFile(absolute, 'utf8').catch(() => undefined) : undefined
    const merged = text === undefined || text.includes('\0') || !hasConflictMarkers(text) ? undefined : await resolveConflictText(file, text, input.resolve, { renames: input.renames })
    if (merged === undefined) {
      unresolved.push(file)
      continue
    }
    await fs.writeFile(absolute, merged)
    await git(worktree, ['add', '--', file])
    resolved.push(file)
  }
  if (unresolved.length) {
    await rollback()
    return { ok: false, message: `Could not merge ${listFiles(unresolved)} automatically.`, resolved, unresolved }
  }
  const commit = await git(worktree, ['commit', '-q', '--no-edit', '-m', input.message], { allowFailure: true, internal: true })
  if (commit.exitCode !== 0) {
    await rollback()
    return { ok: false, message: (commit.stderr || commit.stdout).trim().split('\n')[0] || 'The merge commit failed.', resolved, unresolved }
  }
  return { ok: true, message: resolved.length ? `Merged the newer state (conflicts resolved in ${listFiles(resolved)}).` : 'Merged the newer state.', head: await headCommit(worktree), resolved, unresolved }
}
