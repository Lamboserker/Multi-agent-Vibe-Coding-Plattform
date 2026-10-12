import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, promises as fs, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Persistent UI work state of the desktop shell (open tabs, layout, active session, drafts of unsaved
 * editor content …). It lives in the main process, so it survives renderer reloads and crashes and is
 * available before the local runtime has started. Domain data (sessions, messages, runs) stays in the
 * runtime's SQLite database.
 *
 * - Writes are debounced and atomic (temp file + rename); a .bak copy of the last good file is kept.
 * - Every renderer page registers an epoch; writes from an older page (still in flight while the window
 *   reloads) are rejected, so a reload can never roll the state back.
 * - flushSync() writes everything pending before the app quits.
 */

export interface StateDocument<T = unknown> {
  version: number
  savedAt: string
  data: T
}

export interface DraftEntry {
  path: string
  content: string
  /** mtime of the file on disk the draft is based on (conflict detection on restore). */
  baseMtimeMs?: number
  savedAt: string
}

export type SetResult = { ok: true; version: number } | { ok: false; reason: 'stale_epoch' | 'too_large' | 'invalid' }

const KEY = /^[a-z0-9][a-z0-9:_.-]{0,120}$/i
const PROJECT = /^[a-z0-9_-]{1,64}$/i
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
export const MAX_DRAFT_BYTES = 6 * 1024 * 1024

export function isValidStateKey(key: unknown): key is string {
  return typeof key === 'string' && KEY.test(key)
}

export function isValidProjectKey(key: unknown): key is string {
  return typeof key === 'string' && PROJECT.test(key)
}

function atomicWrite(file: string, content: string) {
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, content, 'utf8')
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temp, file)
      return
    } catch (error) {
      // Windows: a virus scanner or indexer can hold the target for a moment.
      if (attempt >= 4) {
        rmSync(temp, { force: true })
        throw error
      }
      const until = Date.now() + 20 * (attempt + 1)
      while (Date.now() < until) {
        // short synchronous back-off (flushSync must stay synchronous)
      }
    }
  }
}

export class StateStore {
  private readonly docs = new Map<string, StateDocument>()
  private readonly dirtyDocs = new Set<string>()
  private readonly pendingDrafts = new Map<string, { file: string; entry: DraftEntry | null }>()
  private readonly backedUp = new Set<string>()
  private timer?: NodeJS.Timeout
  private epoch?: string

  constructor(
    private readonly dir: string,
    private readonly debounceMs = 250,
  ) {
    mkdirSync(path.join(dir, 'drafts'), { recursive: true })
  }

  /** A renderer page announces itself; from now on only its writes are accepted. */
  registerEpoch(epoch: string) {
    this.epoch = epoch
  }

  private acceptsEpoch(epoch: string | undefined) {
    return !this.epoch || !epoch || epoch === this.epoch
  }

  private docFile(key: string) {
    return path.join(this.dir, `${key.replace(/:/g, '~')}.json`)
  }

  get<T = unknown>(key: string): StateDocument<T> | undefined {
    if (!isValidStateKey(key)) return undefined
    const cached = this.docs.get(key)
    if (cached) return cached as StateDocument<T>
    const file = this.docFile(key)
    for (const candidate of [file, `${file}.bak`]) {
      if (!existsSync(candidate)) continue
      try {
        const doc = JSON.parse(readFileSync(candidate, 'utf8')) as StateDocument<T>
        if (typeof doc?.version !== 'number' || !('data' in doc)) continue
        this.docs.set(key, doc)
        // Keep a copy of the last file that could be read, once per app start.
        if (candidate === file && !this.backedUp.has(key)) {
          copyFileSync(file, `${file}.bak`)
          this.backedUp.add(key)
        }
        return doc
      } catch {
        // corrupt (e.g. power loss during a write on a file system without atomic rename): try .bak
      }
    }
    return undefined
  }

  set(key: string, data: unknown, epoch?: string): SetResult {
    if (!isValidStateKey(key)) return { ok: false, reason: 'invalid' }
    if (!this.acceptsEpoch(epoch)) return { ok: false, reason: 'stale_epoch' }
    let size: number
    try {
      size = Buffer.byteLength(JSON.stringify(data) ?? '')
    } catch {
      return { ok: false, reason: 'invalid' }
    }
    if (size > MAX_DOCUMENT_BYTES) return { ok: false, reason: 'too_large' }
    const version = (this.get(key)?.version ?? 0) + 1
    this.docs.set(key, { version, savedAt: new Date().toISOString(), data })
    this.dirtyDocs.add(key)
    this.schedule()
    return { ok: true, version }
  }

  delete(key: string) {
    if (!isValidStateKey(key)) return
    this.docs.delete(key)
    this.dirtyDocs.delete(key)
    for (const file of [this.docFile(key), `${this.docFile(key)}.bak`]) rmSync(file, { force: true })
  }

  // --- drafts of unsaved editor content -------------------------------------

  private draftDir(projectKey: string) {
    return path.join(this.dir, 'drafts', projectKey)
  }

  private draftFile(projectKey: string, filePath: string) {
    return path.join(this.draftDir(projectKey), `${createHash('sha1').update(filePath).digest('hex')}.json`)
  }

  putDraft(projectKey: string, entry: Omit<DraftEntry, 'savedAt'>, epoch?: string): SetResult {
    if (!isValidProjectKey(projectKey) || typeof entry?.path !== 'string' || entry.path.length > 1024 || typeof entry.content !== 'string') return { ok: false, reason: 'invalid' }
    if (!this.acceptsEpoch(epoch)) return { ok: false, reason: 'stale_epoch' }
    if (Buffer.byteLength(entry.content) > MAX_DRAFT_BYTES) return { ok: false, reason: 'too_large' }
    const file = this.draftFile(projectKey, entry.path)
    this.pendingDrafts.set(file, { file, entry: { path: entry.path, content: entry.content, baseMtimeMs: typeof entry.baseMtimeMs === 'number' ? entry.baseMtimeMs : undefined, savedAt: new Date().toISOString() } })
    this.schedule()
    return { ok: true, version: 1 }
  }

  deleteDraft(projectKey: string, filePath: string, epoch?: string): SetResult {
    if (!isValidProjectKey(projectKey) || typeof filePath !== 'string') return { ok: false, reason: 'invalid' }
    if (!this.acceptsEpoch(epoch)) return { ok: false, reason: 'stale_epoch' }
    const file = this.draftFile(projectKey, filePath)
    this.pendingDrafts.set(file, { file, entry: null })
    this.schedule()
    return { ok: true, version: 1 }
  }

  listDrafts(projectKey: string): DraftEntry[] {
    if (!isValidProjectKey(projectKey)) return []
    const dir = this.draftDir(projectKey)
    const result = new Map<string, DraftEntry>()
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        try {
          const entry = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as DraftEntry
          if (typeof entry.path === 'string' && typeof entry.content === 'string') result.set(path.join(dir, name), entry)
        } catch {
          // ignore unreadable draft
        }
      }
    }
    // pending (not yet written) drafts win over the files on disk
    for (const [file, pending] of this.pendingDrafts) {
      if (path.dirname(file) !== dir) continue
      if (pending.entry) result.set(file, pending.entry)
      else result.delete(file)
    }
    return [...result.values()]
  }

  // --- persistence ------------------------------------------------------------

  private schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.debounceMs)
  }

  /** Asynchronous flush of everything pending (normal operation). */
  async flush() {
    const docs = [...this.dirtyDocs]
    this.dirtyDocs.clear()
    const drafts = [...this.pendingDrafts.values()]
    this.pendingDrafts.clear()
    for (const key of docs) {
      const doc = this.docs.get(key)
      if (!doc) continue
      try {
        atomicWrite(this.docFile(key), JSON.stringify(doc))
      } catch {
        this.dirtyDocs.add(key) // retried with the next flush
      }
    }
    for (const draft of drafts) {
      try {
        if (draft.entry) {
          await fs.mkdir(path.dirname(draft.file), { recursive: true })
          atomicWrite(draft.file, JSON.stringify(draft.entry))
        } else {
          await fs.rm(draft.file, { force: true })
        }
      } catch {
        if (!this.pendingDrafts.has(draft.file)) this.pendingDrafts.set(draft.file, draft)
      }
    }
    if (this.dirtyDocs.size || this.pendingDrafts.size) this.schedule()
  }

  /** Synchronous flush for app shutdown. */
  flushSync() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const key of [...this.dirtyDocs]) {
      const doc = this.docs.get(key)
      if (doc) atomicWrite(this.docFile(key), JSON.stringify(doc))
      this.dirtyDocs.delete(key)
    }
    for (const draft of [...this.pendingDrafts.values()]) {
      if (draft.entry) {
        mkdirSync(path.dirname(draft.file), { recursive: true })
        atomicWrite(draft.file, JSON.stringify(draft.entry))
      } else if (existsSync(draft.file)) {
        unlinkSync(draft.file)
      }
      this.pendingDrafts.delete(draft.file)
    }
  }

  get pendingWrites() {
    return this.dirtyDocs.size + this.pendingDrafts.size
  }
}
