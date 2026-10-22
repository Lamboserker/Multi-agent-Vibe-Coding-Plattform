import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { branchExists, deleteBranch, git, GitError, headCommit, isGitRepository, status } from './git.js'

export interface WorktreeHandle {
  path: string
  branch: string
  baseCommit: string
}

export interface WorktreeManagerOptions {
  /** Directory that holds all agent worktrees (inside the app data dir, never inside the project). */
  root: string
  /**
   * Idle task worktrees kept per project for reuse. Re-using one only rewrites the files that differ
   * from the requested base commit instead of checking out the whole repository again.
   * 0 disables pooling.
   */
  poolSize?: number
}

const POOL_PREFIX = 'pool-'

/** Serializes pool bookkeeping per repository. */
class PoolLock {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(fn, fn)
    this.tails.set(key, result.catch(() => undefined))
    return result
  }
}

const poolLock = new PoolLock()
/** Pool worktrees currently handed out (process-wide, keyed by normalized path). */
const leased = new Set<string>()

/** Sanitizes an identifier for use in branch names and directory names. */
export function safeRefSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').replace(/\.{2,}/g, '.').slice(0, 48) || 'x'
}

export class WorktreeManager {
  constructor(private readonly options: WorktreeManagerOptions) {}

  worktreePath(projectKey: string, name: string): string {
    return path.join(this.options.root, safeRefSegment(projectKey), safeRefSegment(name))
  }

  /**
   * Creates an isolated worktree on a fresh branch at `baseCommit`. The user's checkout,
   * index and uncommitted changes are untouched.
   */
  async create(repoPath: string, input: { projectKey: string; name: string; branch: string; baseCommit: string; pooled?: boolean }): Promise<WorktreeHandle> {
    if (!(await isGitRepository(repoPath))) throw new GitError('Project is not a git repository.')
    // Long-lived worktrees (the integration worktree) must not live in a pool slot: after a restart
    // the slot is no longer leased and could be handed to another task.
    if (input.pooled !== false && (this.options.poolSize ?? 0) > 0) {
      const pooled = await this.acquirePooled(repoPath, input)
      if (pooled) return pooled
    }
    const target = this.worktreePath(input.projectKey, input.name)
    await this.remove(repoPath, target, input.branch)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await git(repoPath, ['worktree', 'add', '-q', '-b', input.branch, target, input.baseCommit], { internal: true })
    await this.linkDependencyFolders(repoPath, target)
    return { path: target, branch: input.branch, baseCommit: input.baseCommit }
  }

  /**
   * Creates missing idle pool slots (detached at HEAD) ahead of a run, e.g. while the planner is
   * still working. A later create() then only switches the files that differ instead of checking
   * out the whole repository. Never touches leased or existing slots; failures are ignored.
   */
  async prewarm(repoPath: string, projectKey: string, count: number): Promise<number> {
    const slots = Math.min(count, this.options.poolSize ?? 0)
    if (slots <= 0 || !(await isGitRepository(repoPath))) return 0
    const dir = this.poolDir(projectKey)
    return poolLock.run(dir.toLowerCase(), async () => {
      const registered = new Set((await this.listManaged(repoPath)).map((entry) => path.resolve(entry.path).toLowerCase()))
      let created = 0
      for (let index = 0; index < slots; index += 1) {
        const candidate = path.join(dir, `${POOL_PREFIX}${index}`)
        const key = path.resolve(candidate).toLowerCase()
        if (leased.has(key) || (registered.has(key) && existsSync(path.join(candidate, '.git')))) continue
        try {
          await this.removeDirectory(repoPath, candidate)
          await fs.mkdir(dir, { recursive: true })
          await git(repoPath, ['worktree', 'add', '-q', '--detach', candidate, 'HEAD'], { internal: true })
          await this.linkDependencyFolders(repoPath, candidate)
          created += 1
        } catch {
          await this.removeDirectory(repoPath, candidate).catch(() => undefined)
        }
      }
      return created
    })
  }

  private poolDir(projectKey: string) {
    return path.join(this.options.root, safeRefSegment(projectKey))
  }

  private isPoolPath(worktreePath: string) {
    return path.basename(worktreePath).startsWith(POOL_PREFIX) && path.resolve(worktreePath).toLowerCase().startsWith(path.resolve(this.options.root).toLowerCase())
  }

  /**
   * Reuses an idle pool worktree (or adds a new one while the pool is not full). Switching it to the
   * base commit only touches files that differ; ignored and untracked files of the previous task are
   * removed (dependency links excepted).
   */
  private async acquirePooled(repoPath: string, input: { projectKey: string; branch: string; baseCommit: string }): Promise<WorktreeHandle | undefined> {
    const dir = this.poolDir(input.projectKey)
    const slot = await poolLock.run(dir.toLowerCase(), async () => {
      const registered = new Set((await this.listManaged(repoPath)).map((entry) => path.resolve(entry.path).toLowerCase()))
      for (let index = 0; index < (this.options.poolSize ?? 0); index += 1) {
        const candidate = path.join(dir, `${POOL_PREFIX}${index}`)
        const key = path.resolve(candidate).toLowerCase()
        if (leased.has(key)) continue
        leased.add(key)
        return { path: candidate, exists: registered.has(key) && existsSync(path.join(candidate, '.git')) }
      }
      return undefined
    })
    if (!slot) return undefined
    try {
      if (slot.exists) {
        // Branch names are unique per task; -B also recovers a slot whose previous release failed.
        await git(slot.path, ['checkout', '-q', '-f', '-B', input.branch, input.baseCommit], { internal: true })
        await git(slot.path, ['reset', '-q', '--hard', input.baseCommit], { internal: true })
        await git(slot.path, ['clean', '-q', '-fdx', '-e', 'node_modules'], { internal: true })
      } else {
        await this.removeDirectory(repoPath, slot.path)
        await fs.mkdir(dir, { recursive: true })
        if (await branchExists(repoPath, input.branch)) await deleteBranch(repoPath, input.branch)
        await git(repoPath, ['worktree', 'add', '-q', '-b', input.branch, slot.path, input.baseCommit], { internal: true })
      }
      await this.linkDependencyFolders(repoPath, slot.path)
      return { path: slot.path, branch: input.branch, baseCommit: input.baseCommit }
    } catch {
      // A locked or broken slot is dropped; the caller falls back to a fresh worktree.
      leased.delete(path.resolve(slot.path).toLowerCase())
      await this.removeDirectory(repoPath, slot.path).catch(() => undefined)
      return undefined
    }
  }

  /** Returns a pool worktree to the pool: detached, clean, task branch deleted. */
  private async releasePooled(repoPath: string, worktreePath: string, branch?: string, deleteTaskBranch = true) {
    const key = path.resolve(worktreePath).toLowerCase()
    try {
      await git(worktreePath, ['checkout', '-q', '--detach'], { internal: true })
      await git(worktreePath, ['reset', '-q', '--hard'], { internal: true })
      await git(worktreePath, ['clean', '-q', '-fdx', '-e', 'node_modules'], { internal: true })
      if (branch && deleteTaskBranch && (await branchExists(repoPath, branch))) await deleteBranch(repoPath, branch)
    } catch {
      await this.removeDirectory(repoPath, worktreePath).catch(() => undefined)
      if (branch && deleteTaskBranch && (await branchExists(repoPath, branch))) await deleteBranch(repoPath, branch)
    } finally {
      leased.delete(key)
    }
  }

  private async removeDirectory(repoPath: string, worktreePath: string) {
    await this.unlinkDependencyFolders(worktreePath)
    if (existsSync(worktreePath)) {
      await git(repoPath, ['worktree', 'remove', '--force', worktreePath], { internal: true, allowFailure: true })
      await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
    }
    await git(repoPath, ['worktree', 'prune'], { internal: true, allowFailure: true })
  }

  /** Creates a worktree for an existing branch (used to resume a run after a crash). */
  async attach(repoPath: string, input: { projectKey: string; name: string; branch: string }): Promise<WorktreeHandle> {
    const target = this.worktreePath(input.projectKey, input.name)
    if (existsSync(path.join(target, '.git'))) {
      const head = await headCommit(target)
      if (head) return { path: target, branch: input.branch, baseCommit: head }
    }
    await git(repoPath, ['worktree', 'prune'], { internal: true, allowFailure: true })
    // git refuses to check out a branch twice. Runs created before integration worktrees were kept out
    // of the pool have the branch in a pool slot: return that slot to the pool and move the branch here.
    const holder = (await this.listManaged(repoPath)).find((entry) => entry.branch === input.branch && path.resolve(entry.path).toLowerCase() !== path.resolve(target).toLowerCase())
    if (holder) {
      if (this.isPoolPath(holder.path)) {
        await this.releasePooled(repoPath, holder.path, input.branch, false)
      } else if (existsSync(path.join(holder.path, '.git'))) {
        const head = await headCommit(holder.path)
        if (head) return { path: holder.path, branch: input.branch, baseCommit: head }
      }
    }
    await fs.rm(target, { recursive: true, force: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await git(repoPath, ['worktree', 'add', '-q', target, input.branch], { internal: true })
    await this.linkDependencyFolders(repoPath, target)
    const head = await headCommit(target)
    return { path: target, branch: input.branch, baseCommit: head ?? '' }
  }

  /** Discards all uncommitted changes in a worktree (after a failed attempt). */
  async reset(worktreePath: string, commit: string): Promise<void> {
    await git(worktreePath, ['reset', '-q', '--hard', commit], { internal: true })
    await git(worktreePath, ['clean', '-q', '-fd', '-e', 'node_modules'], { internal: true })
  }

  async remove(repoPath: string, worktreePath: string, branch?: string, options: { deleteBranch?: boolean } = {}): Promise<void> {
    if (this.isPoolPath(worktreePath) && existsSync(path.join(worktreePath, '.git'))) {
      await this.releasePooled(repoPath, worktreePath, branch, options.deleteBranch !== false)
      return
    }
    await this.unlinkDependencyFolders(worktreePath)
    if (existsSync(worktreePath)) {
      await git(repoPath, ['worktree', 'remove', '--force', worktreePath], { internal: true, allowFailure: true })
      await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
    }
    await git(repoPath, ['worktree', 'prune'], { internal: true, allowFailure: true })
    if (branch && options.deleteBranch !== false && (await branchExists(repoPath, branch))) {
      await deleteBranch(repoPath, branch)
    }
  }

  /** Lists worktrees registered in the repository that live under the manager's root. */
  async listManaged(repoPath: string): Promise<Array<{ path: string; branch?: string; head?: string }>> {
    const result = await git(repoPath, ['worktree', 'list', '--porcelain'], { allowFailure: true })
    const root = path.resolve(this.options.root).toLowerCase()
    const entries: Array<{ path: string; branch?: string; head?: string }> = []
    let current: { path: string; branch?: string; head?: string } | undefined
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current) entries.push(current)
        current = { path: path.resolve(line.slice(9).trim()) }
      } else if (line.startsWith('HEAD ') && current) current.head = line.slice(5).trim()
      else if (line.startsWith('branch ') && current) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
    }
    if (current) entries.push(current)
    return entries.filter((entry) => entry.path.toLowerCase().startsWith(root))
  }

  /**
   * Links node_modules folders of the main checkout into the worktree so that typechecks and
   * tests can run without reinstalling dependencies. Uses junctions on Windows (no admin rights).
   * Linked folders are excluded from staging via pathspecs.
   */
  async linkDependencyFolders(repoPath: string, worktreePath: string): Promise<string[]> {
    const linked: string[] = []
    const candidates = await this.findDependencyFolders(repoPath)
    for (const relative of candidates) {
      const source = path.join(repoPath, relative)
      const target = path.join(worktreePath, relative)
      if (!existsSync(path.dirname(target))) continue
      if (existsSync(target) && !(await this.isCacheOnlyFolder(target))) continue
      try {
        // e.g. `vite build` ran before the main checkout had dependencies and left node_modules/.vite behind;
        // `git clean -e node_modules` keeps that folder, so without replacing it the link would never come
        if (existsSync(target)) await fs.rm(target, { recursive: true, force: true })
        await fs.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
        linked.push(relative)
      } catch {
        // Linking is an optimisation; validation reports missing dependencies if it fails.
      }
    }
    return linked
  }

  /** A real (not linked) dependency folder in the worktree that holds only tool caches such as `.vite`. */
  private async isCacheOnlyFolder(target: string): Promise<boolean> {
    const stat = await fs.lstat(target).catch(() => undefined)
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return false
    const entries = await fs.readdir(target).catch(() => undefined)
    return entries !== undefined && entries.every((name) => name.startsWith('.') && name !== '.bin' && name !== '.pnpm')
  }

  /** Removes dependency links first so that no recursive deletion can follow them into the real node_modules. */
  private async unlinkDependencyFolders(worktreePath: string): Promise<void> {
    if (!existsSync(worktreePath)) return
    const walk = async (directory: string, depth: number) => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name)
        const stat = await fs.lstat(absolute).catch(() => undefined)
        if (!stat) continue
        if (stat.isSymbolicLink()) {
          if (entry.name === 'node_modules') await fs.unlink(absolute).catch(() => fs.rmdir(absolute).catch(() => undefined))
          continue
        }
        if (stat.isDirectory() && depth < 4 && entry.name !== '.git' && entry.name !== 'node_modules') await walk(absolute, depth + 1)
      }
    }
    await walk(worktreePath, 0)
  }

  private async findDependencyFolders(repoPath: string): Promise<string[]> {
    const found: string[] = []
    const walk = async (relative: string, depth: number) => {
      if (depth > 3) return
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(path.join(repoPath, relative), { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const child = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.name === 'node_modules') {
          found.push(child)
          continue
        }
        if (entry.name.startsWith('.') || ['dist', 'build', 'out', 'coverage', 'target'].includes(entry.name)) continue
        await walk(child, depth + 1)
      }
    }
    await walk('', 0)
    return found
  }
}

/** Returns whether a path has uncommitted user changes that a patch would touch. */
export async function overlappingDirtyFiles(repoPath: string, files: string[]): Promise<string[]> {
  const entries = await status(repoPath)
  const dirty = new Set(entries.flatMap((entry) => [entry.path, entry.originalPath].filter((value): value is string => Boolean(value))))
  return files.filter((file) => dirty.has(file))
}
