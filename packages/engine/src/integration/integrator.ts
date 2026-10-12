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

export type ApplyMode = 'branch' | 'working_tree' | 'fast_forward'

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
}

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
      message: `Uncommitted changes in ${blockedBy.length} file(s) would be overwritten. Commit or stash them first.`,
      files,
      blockedBy,
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
        files,
        beforeHead,
        targetBranch,
      }
    }
    const result = await git(input.repoPath, ['merge', '--ff-only', '-q', integrationHead], { allowFailure: true })
    if (result.exitCode !== 0) return { ok: false, mode: input.mode, message: `Fast-forward failed: ${(result.stderr || result.stdout).trim()}`, files, beforeHead, targetBranch }
    return { ok: true, mode: input.mode, message: `Fast-forwarded "${targetBranch}" to the integrated result.`, files, beforeHead, afterHead: integrationHead, targetBranch, patch }
  }

  // working_tree: apply the patch without committing (3-way merge when the base moved).
  const check = await applyPatch(input.repoPath, patch, { check: true })
  const useThreeWay = !check.ok
  if (useThreeWay) {
    const threeWayCheck = await applyPatch(input.repoPath, patch, { check: true, threeWay: true })
    if (!threeWayCheck.ok) {
      return { ok: false, mode: input.mode, message: `The patch does not apply to the current files: ${threeWayCheck.message || check.message}`, files, beforeHead, targetBranch }
    }
  }
  const applied = await applyPatch(input.repoPath, patch, { threeWay: useThreeWay })
  if (!applied.ok) return { ok: false, mode: input.mode, message: `Applying the patch failed: ${applied.message}`, files, beforeHead, targetBranch }
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

/** Reverts a previously applied change set (undo). */
export async function revertChangeSet(input: { repoPath: string; mode: ApplyMode; patch: string; files: string[]; beforeHead?: string; afterHead?: string }): Promise<{ ok: boolean; message: string }> {
  if (input.mode === 'branch') return { ok: true, message: 'Nothing was applied to your checkout; delete the branch to discard it.' }
  if (input.mode === 'working_tree') {
    const check = await applyPatch(input.repoPath, input.patch, { reverse: true, check: true })
    if (!check.ok) return { ok: false, message: `The files were changed after applying; automatic undo is not possible (${check.message}).` }
    const result = await applyPatch(input.repoPath, input.patch, { reverse: true })
    return result.ok ? { ok: true, message: 'Changes were removed from the working tree.' } : { ok: false, message: result.message }
  }
  // fast_forward: move the branch back only if nothing happened on top and the files are clean.
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
