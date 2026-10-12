import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RuntimeConfig {
  /** Desktop mode: started by the Electron shell, authenticated by a per-launch token. */
  desktop: boolean
  desktopToken?: string
  host: string
  port: number
  dataDir: string
  databaseUrl: string
  migrationsDir: string
  worktreesDir: string
  cacheDir: string
  logsDir: string
}

function defaultDataDir(): string {
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Multi-AI Coder')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Multi-AI Coder')
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'multi-ai-coder')
}

function findMigrationsDir(): string {
  if (process.env.MAC_MIGRATIONS_DIR) return process.env.MAC_MIGRATIONS_DIR
  // dev: <repo>/prisma/migrations relative to apps/api/src|dist/runtime
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.resolve(here, '../../../../prisma/migrations'), path.resolve(process.cwd(), 'prisma/migrations'), path.resolve(process.cwd(), '../../prisma/migrations')]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

let cached: RuntimeConfig | undefined

export function runtimeConfig(): RuntimeConfig {
  if (cached) return cached
  const desktopToken = process.env.MAC_DESKTOP_TOKEN || undefined
  const dataDir = process.env.MAC_DATA_DIR ?? defaultDataDir()
  for (const dir of [dataDir, path.join(dataDir, 'worktrees'), path.join(dataDir, 'cache'), path.join(dataDir, 'logs')]) mkdirSync(dir, { recursive: true })
  const databaseUrl = process.env.DATABASE_URL?.startsWith('file:') ? process.env.DATABASE_URL : `file:${path.join(dataDir, 'multi-ai-coder.db').replaceAll('\\', '/')}`
  cached = {
    desktop: Boolean(desktopToken),
    desktopToken,
    // The local runtime is never exposed on the network.
    host: '127.0.0.1',
    port: Number(process.env.MAC_PORT ?? process.env.API_PORT ?? 4000),
    dataDir,
    databaseUrl,
    migrationsDir: findMigrationsDir(),
    worktreesDir: path.join(dataDir, 'worktrees'),
    cacheDir: path.join(dataDir, 'cache'),
    logsDir: path.join(dataDir, 'logs'),
  }
  process.env.DATABASE_URL = databaseUrl
  return cached
}
