import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common'
import { existsSync, promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import {
  cloneRepository,
  commitStaged,
  currentBranch,
  git,
  headCommit,
  initRepository,
  isGitRepository,
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
@Injectable()
export class WorkspaceFsService implements OnModuleDestroy {
  private watchers = new Map<string, { watcher: FSWatcher; timer?: NodeJS.Timeout; changed: Set<string> }>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
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
  async writeFile(projectId: string, file: string, content: string, expectedMtimeMs?: number) {
    if (typeof content !== 'string') throw new BadRequestException('content must be a string.')
    if (Buffer.byteLength(content) > MAX_EDITOR_FILE) throw new BadRequestException('File is too large for the editor.')
    const root = await this.root(projectId)
    const { absolute, relative } = this.resolve(root, file)
    const stat = await fs.stat(absolute).catch(() => undefined)
    if (expectedMtimeMs !== undefined && stat && Math.abs(stat.mtimeMs - expectedMtimeMs) > 1) {
      throw new ConflictException('The file was changed outside the editor. Reload it or overwrite explicitly.')
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true })
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
    if (!(await isGitRepository(root))) return { isRepo: false as const }
    const [entries, branch, head] = await Promise.all([status(root), currentBranch(root), headCommit(root)])
    return { isRepo: true as const, branch, head, entries }
  }

  async gitDiff(projectId: string, file?: string, staged = false) {
    const root = await this.root(projectId)
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
            const files = [...state.changed].slice(0, 200)
            state.changed.clear()
            this.events.publish('project', 'files_changed', { projectId, files }, projectId)
          }, 300)
        }),
      }
      state.watcher.on('error', () => this.unwatch(projectId))
      this.watchers.set(projectId, state)
    } catch {
      // Recursive watching is unsupported on some platforms/file systems; the UI falls back to refresh.
    }
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
