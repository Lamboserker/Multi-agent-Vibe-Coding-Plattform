import { safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Secrets of plugins and MCP servers (tokens, passwords). Values are encrypted with the OS keychain
 * (safeStorage: DPAPI on Windows, Keychain on macOS, libsecret on Linux) and never sent to the
 * renderer; the renderer can only set, delete and list names. The runtime reads a value only for a
 * plugin/server the user granted that secret to.
 */
export class SecretVault {
  private readonly file: string
  private values: Record<string, string> = {}

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'secrets.json')
    try {
      if (existsSync(this.file)) this.values = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>
    } catch {
      this.values = {}
    }
  }

  private static key(scope: string, name: string) {
    if (!/^[\w.:-]{1,120}$/.test(scope) || !/^[\w.-]{1,120}$/.test(name)) throw new Error('Invalid secret name.')
    return `${scope}/${name}`
  }

  get available() {
    return safeStorage.isEncryptionAvailable()
  }

  private save() {
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(this.values, null, 2), { mode: 0o600 })
    renameSync(temp, this.file)
  }

  set(scope: string, name: string, value: string) {
    if (!this.available) throw new Error('Encrypted storage is not available on this system.')
    if (typeof value !== 'string' || value.length > 64 * 1024) throw new Error('Invalid secret value.')
    this.values[SecretVault.key(scope, name)] = safeStorage.encryptString(value).toString('base64')
    this.save()
  }

  get(scope: string, name: string): string | null {
    const stored = this.values[SecretVault.key(scope, name)]
    if (!stored) return null
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return null
    }
  }

  delete(scope: string, name: string) {
    delete this.values[SecretVault.key(scope, name)]
    this.save()
  }

  /** Names (not values) that are set for a scope. */
  names(scope: string): string[] {
    const prefix = `${scope}/`
    return Object.keys(this.values)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
  }
}
