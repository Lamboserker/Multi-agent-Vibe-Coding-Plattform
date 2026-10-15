import { Injectable, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { runtimeConfig } from '../runtime/runtime-config.js'

const MAX_ENTRIES = 50
const MAX_AGE_MS = 30 * 24 * 60 * 60_000
const MAX_BYTES = 2 * 1024 * 1024

export interface HistoryEntry {
  id: string
  at: string
  size: number
  /** save | replace | rename | ai-edit | restore … */
  reason: string
}

/**
 * Local history: the previous content of a file is kept whenever the app overwrites it (save,
 * replace, AI edit, restore), independent of git. Stored under <data>/history/<project>/<file hash>/.
 */
@Injectable()
export class LocalHistoryService {
  private dir(projectId: string, file: string) {
    const hash = createHash('sha256').update(file).digest('hex').slice(0, 24)
    return path.join(runtimeConfig().dataDir, 'history', projectId.replace(/[^\w-]/g, '_'), hash)
  }

  private async index(dir: string): Promise<{ path: string; entries: HistoryEntry[] }> {
    try {
      return JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8')) as { path: string; entries: HistoryEntry[] }
    } catch {
      return { path: '', entries: [] }
    }
  }

  /** Records the content a file had before it was overwritten (identical consecutive versions are skipped). */
  async record(projectId: string, file: string, previous: string, reason = 'save') {
    if (Buffer.byteLength(previous) > MAX_BYTES) return
    const dir = this.dir(projectId, file)
    await fs.mkdir(dir, { recursive: true })
    const index = await this.index(dir)
    const last = index.entries[0]
    if (last && existsSync(path.join(dir, `${last.id}.txt`)) && (await fs.readFile(path.join(dir, `${last.id}.txt`), 'utf8')) === previous) return
    const id = `${Date.now()}`
    await fs.writeFile(path.join(dir, `${id}.txt`), previous, 'utf8')
    const now = Date.now()
    const entries = [{ id, at: new Date(now).toISOString(), size: Buffer.byteLength(previous), reason }, ...index.entries]
    const keep = entries.filter((entry, position) => position < MAX_ENTRIES && now - Date.parse(entry.at) < MAX_AGE_MS)
    for (const entry of entries.filter((candidate) => !keep.includes(candidate))) await fs.rm(path.join(dir, `${entry.id}.txt`), { force: true })
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ path: file, entries: keep }), 'utf8')
  }

  async list(projectId: string, file: string) {
    return (await this.index(this.dir(projectId, file))).entries
  }

  async read(projectId: string, file: string, id: string) {
    if (!/^\d+$/.test(id)) throw new NotFoundException('Unknown history entry.')
    const target = path.join(this.dir(projectId, file), `${id}.txt`)
    if (!existsSync(target)) throw new NotFoundException('Unknown history entry.')
    return { id, content: await fs.readFile(target, 'utf8') }
  }
}
