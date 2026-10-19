import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy, Optional } from '@nestjs/common'
import { LocalHistoryService } from '../ide/local-history.service.js'
import { existsSync, promises as fs, watch, type FSWatcher } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cloneRepository,
  commitStaged,
  currentBranch,
  git,
  headCommit,
  initRepository,
  isGitRepository,
  isSensitivePath,
  listBranches,
  normalizeRelative,
  PathViolationError,
  recentCommits,
  resolveInside,
  searchCode,
  showFileAt,
  status,
} from '@multi-ai-coder/engine'
import { PrismaService } from '../common/prisma.service.js'
import { EventBusService } from '../runtime/event-bus.service.js'
import { PluginsService } from '../plugins/plugins.service.js'

const MAX_EDITOR_FILE = 5 * 1024 * 1024
const HIDDEN = new Set(['.git'])
const COLLAPSED = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', '.turbo', 'out', 'target', '.venv', '__pycache__'])

export interface TreeEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  heavy?: boolean
}

/**
 * File and git operations for the IDE (explorer, editor, search, git view).
 * The user's own editor may open any file inside the project except .git internals;
 * the stricter agent rules (no secrets, task scope) live in the engine's WorkspaceFiles.
 */
/** A git integration plugin answered: accept only the shape the UI expects. */
function gitResult<T>(value: T, valid: (value: any) => boolean): T {
  if (!valid(value)) throw new BadRequestException('Git integration plugin returned an invalid result.')
  return value
}

/** Written when a folder without .gitignore becomes a repository: no dependencies or secrets in the first commit. */
export const DEFAULT_GITIGNORE = ['node_modules/', 'dist/', 'build/', 'out/', 'coverage/', '.next/', '.turbo/', '.cache/', '.venv/', 'venv/', '__pycache__/', '*.log', '.env', '.env.*', '!.env.example', '.DS_Store', 'Thumbs.db', ''].join('\n')

const MAX_AUTO_INIT_ENTRIES = 20_000

/** Counts directory entries up to `limit` (skipping ignored heavy folders), to refuse huge folders. */
async function countEntries(dir: string, limit: number): Promise<number> {
  let count = 0
  const queue = [dir]
  while (queue.length && count <= limit) {
    const current = queue.shift()!
    let entries: Array<import('node:fs').Dirent>
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && ['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__'].includes(entry.name)) continue
      count += 1
      if (entry.isDirectory()) queue.push(path.join(current, entry.name))
    }
  }
  return count
}

/**
 * Makes sure a project folder is a git repository with at least one commit: agents work in worktrees
 * that branch off a commit. Initialises git if needed, writes a default .gitignore if there is none
 * and commits what is there as "Initial commit". Existing history is never touched. Drive roots, the
 * home folder and very large folders are only handled on explicit request (`force`).
 */
/** Dependency folders that never go into an automatic first commit, whatever the .gitignore says. */
const DEPENDENCY_DIRECTORIES = ['node_modules', 'bower_components', 'jspm_packages', '.pnpm-store', '.venv', 'venv', '__pycache__', '.tox', '.gradle']

export interface EnsureRepositoryResult {
  initialized: boolean
  committed: boolean
  hasCommit: boolean
  skipped?: string
  /** Files and folders left out of the first commit (secrets, dependencies) although not ignored. */
  excluded?: string[]
}

/** force: the user asked for it explicitly (no guard). allowLarge: a run needs git now (only drive roots and the home folder are refused). */
export async function ensureRepository(root: string, options: { force?: boolean; allowLarge?: boolean } = {}): Promise<EnsureRepositoryResult> {
  const resolved = path.resolve(root)
  const isRepo = await isGitRepository(resolved)
  if (isRepo && (await headCommit(resolved))) return { initialized: false, committed: false, hasCommit: true }
  if (!options.force) {
    const home = path.resolve(os.homedir())
    if (resolved === path.parse(resolved).root || resolved.toLowerCase() === home.toLowerCase()) return { initialized: false, committed: false, hasCommit: false, skipped: 'Drive roots and the home folder are not turned into a repository automatically.' }
    if (!options.allowLarge && (await countEntries(resolved, MAX_AUTO_INIT_ENTRIES)) > MAX_AUTO_INIT_ENTRIES) return { initialized: false, committed: false, hasCommit: false, skipped: `More than ${MAX_AUTO_INIT_ENTRIES} files: git is set up when the first run starts.` }
  }
  if (!isRepo) await initRepository(resolved)
  if (!existsSync(path.join(resolved, '.gitignore'))) await fs.writeFile(path.join(resolved, '.gitignore'), DEFAULT_GITIGNORE)
  // An existing .gitignore may be incomplete: dependencies are excluded by pathspec (their folders
  // are not even scanned), secrets are taken out of the index after staging.
  const dependencyExcludes = DEPENDENCY_DIRECTORIES.map((name) => `:(exclude,glob)**/${name}/**`)
  await git(resolved, ['add', '-A', '--', '.', ...dependencyExcludes])
  const staged = (await git(resolved, ['diff', '--cached', '--name-only', '-z'], { allowFailure: true })).stdout.split('\0').filter(Boolean)
  const secrets = staged.filter((file) => isSensitivePath(file))
  if (secrets.length) await git(resolved, ['rm', '-q', '--cached', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: secrets.join('\0') })
  const leftOutDependencies = DEPENDENCY_DIRECTORIES.filter((name) => existsSync(path.join(resolved, name)))
  await commitStaged(resolved, 'Initial commit').catch(async () => {
    // no user identity configured or nothing to commit: the app's identity, empty commit allowed
    await git(resolved, ['commit', '-q', '--allow-empty', '-m', 'Initial commit'], { internal: true })
  })
  const hasCommit = Boolean(await headCommit(resolved))
  // what is left out but not ignored would show up as untracked: report it so the user can add it to .gitignore
  const ignored = new Set((await git(resolved, ['check-ignore', '--stdin', '-z'], { allowFailure: true, input: [...secrets, ...leftOutDependencies.map((name) => `${name}/`)].join('\0') })).stdout.split('\0').filter(Boolean).map((entry) => entry.replace(/\/$/, '')))
  const excluded = [...secrets, ...leftOutDependencies.map((name) => `${name}/`)].filter((entry) => !ignored.has(entry.replace(/\/$/, '')))
  return { initialized: !isRepo, committed: hasCommit, hasCommit, ...(excluded.length ? { excluded } : {}) }
}

@Injectable()
export class WorkspaceFsService implements OnModuleDestroy {
  private watchers = new Map<string, { watcher: FSWatcher; timer?: NodeJS.Timeout; changed: Set<string> }>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
    @Optional() private readonly history?: LocalHistoryService,
    @Optional() private readonly plugins?: PluginsService,
  ) {}

  async root(projectId: string): Promise<string> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } })
    if (!project) throw new NotFoundException('Project not found.')
    return project.repoPath
  }

  private resolve(root: string, relative: string) {
    try {
      const resolved = relative === '' || relative === '.' ? { absolute: path.resolve(root), relative: '' } : resolveInside(root, relative)
      if (resolved.relative.split('/')[0] === '.git') throw new PathViolationError('The .git directory is not editable.', relative)
      return resolved
    } catch (error) {
      if (error instanceof PathViolationError) throw new BadRequestException(error.message)
      throw error
    }
  }

  async tree(projectId: string, dir = ''): Promise<TreeEntry[]> {
    const root = await this.root(projectId)
    const { absolute, relative } = this.resolve(root, dir)
    const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => {
      throw new NotFoundException('Directory not found.')
    })
    const result: TreeEntry[] = []
    for (const entry of entries) {
      if (HIDDEN.has(entry.name)) continue
      const childPath = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) result.push({ name: entry.name, path: childPath, type: 'directory', heavy: COLLAPSED.has(entry.name) })
      else if (entry.isFile()) {
        const stat = await fs.stat(path.join(absolute, entry.name)).catch(() => undefined)
        result.push({ name: entry.name, path: childPath, type: 'file', size: stat?.size })
      }
    }
    return result.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name))
  }

  async readFile(projectId: string, file: string) {
    const root = await this.root(projectId)
    const { absolute, relative } = this.resolve(root, file)
    const stat = await fs.stat(absolute).catch(() => undefined)
    if (!stat?.isFile()) throw new NotFoundException('File not found.')
    if (stat.size > MAX_EDITOR_FILE) return { path: relative, binary: false, tooLarge: true, size: stat.size, mtimeMs: stat.mtimeMs, content: '' }
    const buffer = await fs.readFile(absolute)
    const binary = buffer.subarray(0, 8000).includes(0)
    return { path: relative, binary, tooLarge: false, size: stat.size, mtimeMs: stat.mtimeMs, content: binary ? '' : buffer.toString('utf8') }
  }

  /** Writes a file; when expectedMtimeMs is given and the file changed on disk meanwhile, a conflict is reported. */
  async writeFile(projectId: string, file: string, content: string, expectedMtimeMs?: number, reason = 'save') {
    if (typeof content !== 'string') throw new BadRequestException('content must be a string.')
    if (Buffer.byteLength(content) > MAX_EDITOR_FILE) throw new BadRequestException('File is too large for the editor.')
    const root = await this.root(projectId)
    const { absolute, relative } = this.resolve(root, file)
    const stat = await fs.stat(absolute).catch(() => undefined)
    if (expectedMtimeMs !== undefined && stat && Math.abs(stat.mtimeMs - expectedMtimeMs) > 1) {
      throw new ConflictException('The file was changed outside the editor. Reload it or overwrite explicitly.')
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    // local history: keep what is about to be overwritten (failures never block the save)
    if (stat?.isFile() && this.history && stat.size <= MAX_EDITOR_FILE) {
      const previous = await fs.readFile(absolute, 'utf8').catch(() => undefined)
      if (previous !== undefined && previous !== content) await this.history.record(projectId, relative, previous, reason).catch(() => undefined)
    }
    await fs.writeFile(absolute, content, 'utf8')
    const next = await fs.stat(absolute)
    return { path: relative, mtimeMs: next.mtimeMs, size: next.size }
  }

  async createEntry(projectId: string, entryPath: string, type: 'file' | 'directory') {
    const root = await this.root(projectId)
    const { absolute, relative } = this.resolve(root, entryPath)
    if (existsSync(absolute)) throw new ConflictException('Path already exists.')
    if (type === 'directory') await fs.mkdir(absolute, { recursive: true })
    else {
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      await fs.writeFile(absolute, '', { flag: 'wx' })
    }
    return { path: relative, type }
  }

  async renameEntry(projectId: string, from: string, to: string) {
    const root = await this.root(projectId)
    const source = this.resolve(root, from)
    const target = this.resolve(root, to)
    if (!existsSync(source.absolute)) throw new NotFoundException('Source not found.')
    if (existsSync(target.absolute)) throw new ConflictException('Target exists.')
    await fs.mkdir(path.dirname(target.absolute), { recursive: true })
    await fs.rename(source.absolute, target.absolute)
    return { from: source.relative, to: target.relative }
  }

  /** Deletes a file or directory. Directories with many files require an explicit confirmation count. */
  async deleteEntry(projectId: string, entryPath: string, confirmCount?: number) {
    const root = await this.root(projectId)
    const { absolute, relative } = this.resolve(root, entryPath)
    if (!relative) throw new BadRequestException('The project root cannot be deleted.')
    const stat = await fs.stat(absolute).catch(() => undefined)
    if (!stat) throw new NotFoundException('Path not found.')
    if (stat.isDirectory()) {
      const count = await this.countFiles(absolute, 5000)
      if (count > 20 && confirmCount !== count) return { deleted: false, requiresConfirmation: true, fileCount: count }
      await fs.rm(absolute, { recursive: true })
    } else {
      await fs.unlink(absolute)
    }
    return { deleted: true, path: relative }
  }

  private async countFiles(dir: string, limit: number): Promise<number> {
    let count = 0
    const stack = [dir]
    while (stack.length && count < limit) {
      const current = stack.pop()!
      for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) stack.push(path.join(current, entry.name))
        else count += 1
      }
    }
    return count
  }

  async search(projectId: string, query: string, regex = false) {
    const root = await this.root(projectId)
    if (regex) {
      try {
        new RegExp(query)
      } catch {
        throw new BadRequestException('Invalid regular expression.')
      }
    }
    return searchCode(root, query, { maxResults: 300, regex })
  }

  // --- git view -------------------------------------------------------------

  async gitStatus(projectId: string) {
    const root = await this.root(projectId)
    const extension = await this.plugins?.invokeSelected<{ isRepo: false } | { isRepo: true; branch: string; head: string; entries: Awaited<ReturnType<typeof status>> }>('gitIntegrations', 'request', { project: { id: projectId, name: path.basename(root), repoPath: root }, operation: 'status', args: {} })
    if (extension != null && !(extension as { unsupported?: unknown }).unsupported) return gitResult(extension, (value) => typeof value.isRepo === 'boolean' && (!value.isRepo || (typeof value.branch === 'string' && Array.isArray(value.entries))))
    if (!(await isGitRepository(root))) return { isRepo: false as const }
    const [entries, branch, head] = await Promise.all([status(root), currentBranch(root), headCommit(root)])
    return { isRepo: true as const, branch, head, entries }
  }

  async gitDiff(projectId: string, file?: string, staged = false) {
    const root = await this.root(projectId)
    if (file) this.resolve(root, file)
    const extension = await this.plugins?.invokeSelected<{ diff: string }>('gitIntegrations', 'request', { project: { id: projectId, name: path.basename(root), repoPath: root }, operation: 'diff', args: { file, staged } })
    if (extension != null && !(extension as { unsupported?: unknown }).unsupported) return gitResult(extension, (value) => typeof value.diff === 'string')
    const args = ['diff', '--no-color', '--no-ext-diff']
    if (staged) args.push('--cached')
    if (file) args.push('--', normalizeRelative(this.resolve(root, file).relative))
    return { diff: (await git(root, args, { allowFailure: true })).stdout }
  }

  async fileAtHead(projectId: string, file: string) {
    const root = await this.root(projectId)
    const { relative } = this.resolve(root, file)
    return { path: relative, content: (await showFileAt(root, 'HEAD', relative)) ?? null }
  }

  async branches(projectId: string) {
    const root = await this.root(projectId)
    const extension = await this.plugins?.invokeSelected<Awaited<ReturnType<typeof listBranches>>>('gitIntegrations', 'request', { project: { id: projectId, name: path.basename(root), repoPath: root }, operation: 'branches', args: {} })
    if (extension != null && !(extension as { unsupported?: unknown }).unsupported) return gitResult(extension, (value) => Array.isArray(value) && value.every((branch) => typeof branch?.name === 'string'))
    return listBranches(await this.root(projectId))
  }

  async log(projectId: string, limit = 50) {
    return recentCommits(await this.root(projectId), Math.min(limit, 200))
  }

  async stage(projectId: string, paths: string[]) {
    const root = await this.root(projectId)
    const files = paths.map((file) => this.resolve(root, file).relative)
    if (files.length) await git(root, ['add', '--', ...files])
    return this.gitStatus(projectId)
  }

  async unstage(projectId: string, paths: string[]) {
    const root = await this.root(projectId)
    const files = paths.map((file) => this.resolve(root, file).relative)
    if (files.length) await git(root, ['reset', '-q', '--', ...files], { allowFailure: true })
    return this.gitStatus(projectId)
  }

  /** Discards working-tree changes of the given files (destructive → explicit confirm flag). */
  async discard(projectId: string, paths: string[], confirm: boolean) {
    if (!confirm) throw new BadRequestException('Discarding changes requires confirmation.')
    const root = await this.root(projectId)
    const files = paths.map((file) => this.resolve(root, file).relative)
    const entries = await status(root)
    const untracked = files.filter((file) => entries.some((entry) => entry.path === file && entry.untracked))
    const tracked = files.filter((file) => !untracked.includes(file))
    if (tracked.length) await git(root, ['checkout', '--', ...tracked])
    for (const file of untracked) await fs.rm(path.join(root, file), { force: true })
    return this.gitStatus(projectId)
  }

  async commit(projectId: string, message: string) {
    if (!message?.trim()) throw new BadRequestException('Commit message is required.')
    const root = await this.root(projectId)
    // User commits run the project's hooks and use the user's own git identity.
    const result = await git(root, ['commit', '-q', '-F', '-'], { input: message, allowFailure: true })
    if (result.exitCode !== 0) throw new BadRequestException((result.stderr || result.stdout).trim() || 'Commit failed.')
    return { head: await headCommit(root) }
  }

  async checkout(projectId: string, branch: string, create = false) {
    const root = await this.root(projectId)
    if (!/^[\w./-]+$/.test(branch) || branch.includes('..')) throw new BadRequestException('Invalid branch name.')
    const dirty = (await status(root)).filter((entry) => !entry.untracked)
    if (dirty.length) throw new ConflictException('Commit or stash your changes before switching branches.')
    const result = await git(root, create ? ['checkout', '-q', '-b', branch] : ['checkout', '-q', branch], { allowFailure: true })
    if (result.exitCode !== 0) throw new BadRequestException((result.stderr || result.stdout).trim())
    return this.gitStatus(projectId)
  }

  /** Initialises git in a folder that is not a repository yet (with an initial commit). */
  async initGit(projectId: string) {
    const root = await this.root(projectId)
    if (await isGitRepository(root)) return this.gitStatus(projectId)
    await initRepository(root)
    await git(root, ['add', '-A'])
    await commitStaged(root, 'Initial commit').catch(async () => {
      await git(root, ['commit', '-q', '--allow-empty', '-m', 'Initial commit'], { internal: true })
    })
    return this.gitStatus(projectId)
  }

  /**
   * A repository that was initialised elsewhere may have no commit yet. Commits everything that is not
   * ignored as "Initial commit" (an empty commit for an empty folder). Never touches existing history.
   */
  async initialCommit(projectId: string) {
    const root = await this.root(projectId)
    const result = await ensureRepository(root, { force: true })
    if (!result.hasCommit) throw new BadRequestException(result.skipped ?? 'The initial commit could not be created.')
    return this.gitStatus(projectId)
  }

  // --- project creation -----------------------------------------------------



  async createNewProject(parentDir: string, name: string) {
    if (!/^[\w.-]{1,80}$/.test(name)) throw new BadRequestException('Use letters, numbers, ".", "-" or "_" for the project name.')
    const target = path.join(path.resolve(parentDir), name)
    if (existsSync(target)) throw new ConflictException('A folder with that name already exists.')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'README.md'), `# ${name}\n`)
    await fs.writeFile(path.join(target, '.gitignore'), 'node_modules\ndist\n.env\n.env.*\n')
    await initRepository(target)
    await git(target, ['add', '-A'])
    await git(target, ['commit', '-q', '-m', 'Initial commit'], { internal: true })
    return target
  }

  async cloneProject(url: string, parentDir: string, name?: string) {
    const folder = name ?? url.split('/').pop()?.replace(/\.git$/, '') ?? 'repository'
    if (!/^[\w.-]{1,100}$/.test(folder)) throw new BadRequestException('Invalid target folder name.')
    const target = path.join(path.resolve(parentDir), folder)
    if (existsSync(target)) throw new ConflictException('Target folder already exists.')
    await cloneRepository(url, target)
    return target
  }

  // --- watching -------------------------------------------------------------

  /** Watches a project for external changes and publishes debounced "files_changed" events. */
  async watchProject(projectId: string) {
    if (this.watchers.has(projectId)) return
    const root = await this.root(projectId)
    try {
      const state: { watcher: FSWatcher; timer?: NodeJS.Timeout; changed: Set<string> } = {
        changed: new Set(),
        watcher: watch(root, { recursive: true }, (_event, filename) => {
          if (!filename) return
          const relative = filename.toString().replaceAll('\\', '/')
          if (relative.startsWith('.git/') && !/^\.git\/(HEAD|index|refs\/heads)/.test(relative)) return
          if (/(^|\/)node_modules\//.test(relative)) return
          state.changed.add(relative)
          if (state.timer) clearTimeout(state.timer)
          state.timer = setTimeout(() => {
            const all = [...state.changed]
            state.changed.clear()
            // truncated = the list is incomplete; consumers that track changes (repo index) rescan fully
            this.events.publish('project', 'files_changed', { projectId, files: all.slice(0, 200), truncated: all.length > 200 }, projectId)
          }, 300)
        }),
      }
      state.watcher.on('error', () => this.unwatch(projectId))
      this.watchers.set(projectId, state)
      // lets the repo index warm up while the user is still typing (first plan skips the full scan)
      this.events.publish('project', 'watch_started', { projectId, repoPath: root }, projectId)
    } catch {
      // Recursive watching is unsupported on some platforms/file systems; the UI falls back to refresh.
    }
  }

  isWatching(projectId: string) {
    return this.watchers.has(projectId)
  }

  unwatch(projectId: string) {
    const state = this.watchers.get(projectId)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    state.watcher.close()
    this.watchers.delete(projectId)
  }

  onModuleDestroy() {
    for (const id of [...this.watchers.keys()]) this.unwatch(id)
  }
}
