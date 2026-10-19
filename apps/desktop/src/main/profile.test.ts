import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEVELOPMENT_DIR, developmentProfileDir, PRODUCT_DIR } from './profile'

describe('developmentProfileDir', () => {
  const roots: string[] = []
  const appData = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mac-profile-'))
    roots.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('uses a separate, empty profile on a fresh machine', () => {
    const root = appData()
    expect(developmentProfileDir(root)).toBe(path.join(root, DEVELOPMENT_DIR))
    expect(existsSync(path.join(root, PRODUCT_DIR))).toBe(false)
  })

  it('moves the formerly shared profile once, so the installed app starts empty', () => {
    const root = appData()
    mkdirSync(path.join(root, PRODUCT_DIR))
    writeFileSync(path.join(root, PRODUCT_DIR, 'multi-ai-coder.db'), 'data')
    const dir = developmentProfileDir(root)
    expect(dir).toBe(path.join(root, DEVELOPMENT_DIR))
    expect(readFileSync(path.join(dir, 'multi-ai-coder.db'), 'utf8')).toBe('data')
    expect(existsSync(path.join(root, PRODUCT_DIR))).toBe(false)
  })

  it('leaves an installed app profile alone once the development profile exists', () => {
    const root = appData()
    mkdirSync(path.join(root, DEVELOPMENT_DIR))
    mkdirSync(path.join(root, PRODUCT_DIR))
    writeFileSync(path.join(root, PRODUCT_DIR, 'multi-ai-coder.db'), 'installed')
    expect(developmentProfileDir(root)).toBe(path.join(root, DEVELOPMENT_DIR))
    expect(readFileSync(path.join(root, PRODUCT_DIR, 'multi-ai-coder.db'), 'utf8')).toBe('installed')
  })
})
