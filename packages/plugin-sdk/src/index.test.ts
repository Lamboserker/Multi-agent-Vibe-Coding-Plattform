import { describe, expect, it } from 'vitest'
import { compareVersions, hostAllowed, ManifestError, validateManifest } from './index.js'

const base = { id: 'demo', name: 'Demo', version: '1.0.0', description: 'demo', apiVersion: 1, main: 'index.js', permissions: {} }

describe('validateManifest', () => {
  it('accepts a minimal manifest', () => {
    expect(validateManifest(base).id).toBe('demo')
  })

  it('rejects unsafe or unsupported manifests', () => {
    expect(() => validateManifest({ ...base, main: '../escape.js' })).toThrow(ManifestError)
    expect(() => validateManifest({ ...base, main: '/abs.js' })).toThrow(/main/)
    expect(() => validateManifest({ ...base, apiVersion: 2 })).toThrow(/apiVersion/)
    expect(() => validateManifest({ ...base, id: 'Bad Id' })).toThrow(/id/)
    expect(() => validateManifest({ ...base, version: 'latest' })).toThrow(/version/)
    expect(() => validateManifest({ ...base, permissions: { network: ['http://x'] } })).toThrow(/network/)
    expect(() => validateManifest({ ...base, permissions: { processes: ['rm -rf'] } })).toThrow(/processes/)
  })
})

describe('hostAllowed', () => {
  it('matches exact hosts, sub-domain wildcards, ports and "*"', () => {
    expect(hostAllowed('api.github.com', ['api.github.com'])).toBe(true)
    expect(hostAllowed('evil.com', ['api.github.com'])).toBe(false)
    expect(hostAllowed('api.github.com.evil.com', ['api.github.com'])).toBe(false)
    expect(hostAllowed('a.gitlab.com', ['*.gitlab.com'])).toBe(true)
    expect(hostAllowed('gitlab.com', ['*.gitlab.com'])).toBe(false)
    expect(hostAllowed('localhost:5432', ['localhost'])).toBe(true)
    expect(hostAllowed('localhost:5432', ['localhost:3000'])).toBe(false)
    expect(hostAllowed('anything.example', ['*'])).toBe(true)
    expect(hostAllowed('anything.example', [])).toBe(false)
  })
})

describe('compareVersions', () => {
  it('orders semantic versions', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1)
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0)
  })
})
