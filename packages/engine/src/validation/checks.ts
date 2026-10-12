import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { classifyCommand } from '../security/commands.js'
import { redactSecrets } from '../security/paths.js'
import { runProcess, sanitizedEnv } from '../util/process.js'

export type CheckKind = 'typecheck' | 'test' | 'lint' | 'build' | 'syntax'

export interface ValidationCheck {
  id: string
  kind: CheckKind
  command: string
  /** A failing blocking check fails the task; non-blocking checks are reported only. */
  blocking: boolean
  timeoutMs: number
  source: string
}

export interface CheckResult {
  id: string
  kind: CheckKind
  command: string
  status: 'passed' | 'failed' | 'skipped' | 'timeout' | 'error'
  blocking: boolean
  durationMs: number
  exitCode: number | null
  testsPassed?: number
  testsFailed?: number
  errorCount?: number
  /** Tail of the output, secret-redacted, for logs and repair prompts. */
  output: string
  reason?: string
}

export interface ValidationReport {
  ok: boolean
  results: CheckResult[]
  testsPassed: number
  testsFailed: number
  summary: string
}

function readPackageJson(dir: string): { scripts: Record<string, string>; deps: Set<string> } | undefined {
  const file = path.join(dir, 'package.json')
  if (!existsSync(file)) return undefined
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    return { scripts: json.scripts ?? {}, deps: new Set(Object.keys({ ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) })) }
  } catch {
    return undefined
  }
}

function packageManagerOf(dir: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn'
  if (existsSync(path.join(dir, 'bun.lockb')) || existsSync(path.join(dir, 'bun.lock'))) return 'bun'
  return 'npm'
}

function runScript(manager: string, script: string): string {
  return manager === 'npm' ? `npm run ${script} --silent` : `${manager} run ${script}`
}

const WATCH_PATTERN = /\b(vitest(?!\s+run)(\s|$)|--watch\b|jest\s+--watch)/

/** Detects the project's own validation commands (package scripts first, toolchain defaults second). */
export function detectValidationChecks(projectDir: string): ValidationCheck[] {
  const checks: ValidationCheck[] = []
  const pkg = readPackageJson(projectDir)
  if (pkg) {
    const manager = packageManagerOf(projectDir)
    const scripts = pkg.scripts
    if (scripts.typecheck) checks.push({ id: 'typecheck', kind: 'typecheck', command: runScript(manager, 'typecheck'), blocking: true, timeoutMs: 5 * 60_000, source: 'package.json#typecheck' })
    else if ((pkg.deps.has('typescript') || existsSync(path.join(projectDir, 'tsconfig.json'))) && existsSync(path.join(projectDir, 'tsconfig.json'))) {
      checks.push({ id: 'typecheck', kind: 'typecheck', command: 'npx --no-install tsc --noEmit -p tsconfig.json', blocking: true, timeoutMs: 5 * 60_000, source: 'tsconfig.json' })
    }
    const testScript = scripts.test
    if (testScript && !/no test specified/.test(testScript)) {
      const command = WATCH_PATTERN.test(testScript) && pkg.deps.has('vitest') ? 'npx --no-install vitest run' : runScript(manager, 'test')
      checks.push({ id: 'test', kind: 'test', command, blocking: true, timeoutMs: 10 * 60_000, source: 'package.json#test' })
    }
    if (scripts.lint) checks.push({ id: 'lint', kind: 'lint', command: runScript(manager, 'lint'), blocking: false, timeoutMs: 5 * 60_000, source: 'package.json#lint' })
    return checks
  }
  if (existsSync(path.join(projectDir, 'pyproject.toml')) || existsSync(path.join(projectDir, 'requirements.txt'))) {
    checks.push({ id: 'test', kind: 'test', command: 'python -m pytest -q', blocking: true, timeoutMs: 10 * 60_000, source: 'python' })
    checks.push({ id: 'syntax', kind: 'syntax', command: 'python -m compileall -q .', blocking: true, timeoutMs: 2 * 60_000, source: 'python' })
  }
  if (existsSync(path.join(projectDir, 'go.mod'))) {
    checks.push({ id: 'build', kind: 'build', command: 'go vet ./...', blocking: true, timeoutMs: 5 * 60_000, source: 'go.mod' })
    checks.push({ id: 'test', kind: 'test', command: 'go test ./...', blocking: true, timeoutMs: 10 * 60_000, source: 'go.mod' })
  }
  if (existsSync(path.join(projectDir, 'Cargo.toml'))) {
    checks.push({ id: 'build', kind: 'build', command: 'cargo check', blocking: true, timeoutMs: 10 * 60_000, source: 'Cargo.toml' })
    checks.push({ id: 'test', kind: 'test', command: 'cargo test', blocking: true, timeoutMs: 15 * 60_000, source: 'Cargo.toml' })
  }
  return checks
}

/** Parses test counts from common runners (vitest, jest, mocha, pytest, go, cargo, node:test). */
export function parseTestCounts(output: string): { passed?: number; failed?: number } {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '')
  const vitest = text.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/)
  if (vitest) return { passed: Number(vitest[2]), failed: Number(vitest[1] ?? 0) }
  const vitestFailedOnly = text.match(/Tests\s+(\d+)\s+failed\s*\((\d+)\)/)
  if (vitestFailedOnly) return { passed: Number(vitestFailedOnly[2]) - Number(vitestFailedOnly[1]), failed: Number(vitestFailedOnly[1]) }
  const jest = text.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(?:\d+\s+skipped,\s+)?(?:(\d+)\s+passed,\s+)?(\d+)\s+total/)
  if (jest) return { passed: Number(jest[2] ?? 0), failed: Number(jest[1] ?? 0) }
  const pytest = text.match(/=+\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed)?/)
  if (pytest && (pytest[1] || pytest[2])) return { passed: Number(pytest[2] ?? 0), failed: Number(pytest[1] ?? 0) }
  // node:test – TAP ("# pass 3") and the spec reporter summary ("ℹ pass 3")
  const nodeTest = text.match(/(?:#|ℹ) pass (\d+)[\s\S]*?(?:#|ℹ) fail (\d+)/)
  if (nodeTest) return { passed: Number(nodeTest[1]), failed: Number(nodeTest[2]) }
  const cargo = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)]
  if (cargo.length) return { passed: cargo.reduce((sum, match) => sum + Number(match[1]), 0), failed: cargo.reduce((sum, match) => sum + Number(match[2]), 0) }
  const mocha = text.match(/(\d+)\s+passing[\s\S]*?(?:(\d+)\s+failing)?/)
  if (mocha) return { passed: Number(mocha[1]), failed: Number(mocha[2] ?? 0) }
  const goOk = (text.match(/^ok\s+/gm) ?? []).length
  const goFail = (text.match(/^FAIL\s+/gm) ?? []).length
  if (goOk || goFail) return { passed: goOk, failed: goFail }
  return {}
}

export function parseErrorCount(output: string): number | undefined {
  const tsc = output.match(/Found (\d+) errors?/)
  if (tsc) return Number(tsc[1])
  const lines = output.match(/error TS\d+:/g)
  return lines ? lines.length : undefined
}

export interface RunChecksOptions {
  signal?: AbortSignal
  onOutput?: (checkId: string, chunk: string) => void
  /** Allow running the project's own scripts/tests (they execute project code). Default true. */
  allowProjectCode?: boolean
  /** Commands that require approval are only run when listed here. */
  approvedCommands?: string[]
}

/** Runs checks sequentially inside a worktree with a secret-free environment. */
export async function runValidationChecks(cwd: string, checks: ValidationCheck[], options: RunChecksOptions = {}): Promise<ValidationReport> {
  const results: CheckResult[] = []
  for (const check of checks) {
    if (options.signal?.aborted) break
    const policy = classifyCommand(check.command)
    const approved = options.approvedCommands?.includes(check.command) ?? false
    if (policy.decision === 'deny' || (policy.decision === 'approval' && !approved) || (policy.runsProjectCode && options.allowProjectCode === false)) {
      results.push({
        id: check.id,
        kind: check.kind,
        command: check.command,
        status: 'skipped',
        blocking: check.blocking,
        durationMs: 0,
        exitCode: null,
        output: '',
        reason: policy.decision === 'allow' ? 'Running project code is disabled in settings.' : policy.reason,
      })
      continue
    }
    const [binary, ...args] = policy.argv
    const result = await runProcess(binary!, args, {
      cwd,
      env: sanitizedEnv(),
      timeoutMs: check.timeoutMs,
      signal: options.signal,
      maxOutputBytes: 512 * 1024,
      onStdout: (chunk) => options.onOutput?.(check.id, chunk),
      onStderr: (chunk) => options.onOutput?.(check.id, chunk),
    })
    const output = redactSecrets(`${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '')).trim()
    const counts = check.kind === 'test' ? parseTestCounts(output) : {}
    const status: CheckResult['status'] = result.spawnError ? 'error' : result.timedOut ? 'timeout' : result.exitCode === 0 ? 'passed' : 'failed'
    results.push({
      id: check.id,
      kind: check.kind,
      command: check.command,
      status,
      blocking: check.blocking,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      testsPassed: counts.passed,
      testsFailed: counts.failed,
      errorCount: check.kind === 'typecheck' ? parseErrorCount(output) : undefined,
      output: output.slice(-6000),
      reason: result.spawnError,
    })
  }
  const testsPassed = results.reduce((sum, result) => sum + (result.testsPassed ?? 0), 0)
  const testsFailed = results.reduce((sum, result) => sum + (result.testsFailed ?? 0), 0)
  const ok = results.every((result) => !result.blocking || result.status === 'passed' || result.status === 'skipped')
  const summary = results.length
    ? results.map((result) => `${result.kind}: ${result.status}${result.testsPassed !== undefined ? ` (${result.testsPassed} passed, ${result.testsFailed ?? 0} failed)` : ''}${result.reason ? ` – ${result.reason}` : ''}`).join('; ')
    : 'No validation commands detected for this project.'
  return { ok, results, testsPassed, testsFailed, summary }
}

/** Compact failure description for repair prompts. */
export function failureDigest(report: ValidationReport, maxChars = 5000): string {
  return report.results
    .filter((result) => result.status === 'failed' || result.status === 'timeout' || result.status === 'error')
    .map((result) => `## ${result.kind} failed: ${result.command}\n${result.output.slice(-Math.floor(maxChars / 2))}`)
    .join('\n\n')
    .slice(0, maxChars)
}
