// Live end-to-end test of the desktop app (NOT mocked):
//   real Electron app + local runtime, real Ollama model, real orchestrator CLI (subscription),
//   real git worktrees, real typecheck/tests, real approval → files written to the repository.
//
// Opt-in, because it downloads nothing itself but uses an installed local model and a little
// subscription quota. Run (after `pnpm --filter @multi-ai-coder/desktop build`):
//   MAC_E2E_LIVE=1 MAC_E2E_MODEL=qwen2.5-coder:7b MAC_E2E_OLLAMA_URL=http://127.0.0.1:11435 \
//   MAC_E2E_OLLAMA_MODELS=D:\ollama-models MAC_E2E_ORCHESTRATOR=codex MAC_E2E_CODEX_MODEL=gpt-5.6-luna \
//   node --test e2e/
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { go } from './helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(here, '..')
const live = process.env.MAC_E2E_LIVE === '1'
const model = process.env.MAC_E2E_MODEL ?? 'qwen2.5-coder:7b'
const ollamaUrl = process.env.MAC_E2E_OLLAMA_URL ?? 'http://127.0.0.1:11434'
const orchestrator = process.env.MAC_E2E_ORCHESTRATOR ?? 'codex'
const resultsDir = path.join(here, 'results')

const REQUEST =
  'Erstelle eine React-Komponente `Greeting` in `src/components/Greeting.tsx` mit der Prop `name: string`, die `<h1 className="greeting">Hallo, {name}!</h1>` rendert, ' +
  'und einen Vitest-Test in `src/components/Greeting.test.tsx` nach dem Muster von `src/components/Badge.test.tsx` (renderToStaticMarkup).'

/** Polls an async condition from the test process (page.waitForFunction would treat a Promise as truthy). */
async function waitUntil(condition, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for: ${label}`)
}

const run = (command, args, cwd) => execSync([command, ...args].join(' '), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function prepareRepository() {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'mac-e2e-repo-'))
  cpSync(path.join(here, 'fixtures', 'react-app'), repo, { recursive: true })
  run('pnpm', ['install', '--ignore-workspace', '--prefer-offline', '--silent'], repo)
  run('git', ['init', '-q', '-b', 'main'], repo)
  run('git', ['add', '-A'], repo)
  run('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'fixture'], repo)
  return repo
}

test('user requests a React component; local model implements it; user approves', { skip: !live && 'set MAC_E2E_LIVE=1 to run the live end-to-end test', timeout: 60 * 60_000 }, async () => {
  const { _electron: electron } = await import(pathToFileURL(path.join(appDir, 'node_modules', 'playwright-core', 'index.mjs')).href)
  mkdirSync(resultsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const shot = (page, name) => page.screenshot({ path: path.join(resultsDir, `${stamp}-${name}.png`) })
  const report = { startedAt: new Date().toISOString(), model, orchestrator, steps: [] }
  const step = (name, detail) => {
    report.steps.push({ name, at: new Date().toISOString(), ...detail })
    console.log(`[e2e] ${name}`, detail ? JSON.stringify(detail).slice(0, 300) : '')
  }

  // 1. test repository
  const repo = prepareRepository()
  step('repository prepared', { repo })

  const profile = mkdtempSync(path.join(os.tmpdir(), 'mac-e2e-profile-'))
  const env = { ...process.env, MAC_USER_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ cwd: appDir, args: ['.'], env })
  const page = await app.firstWindow()
  const consoleErrors = []
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()))
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  const api = (method, url, body) => page.evaluate(([m, u, b]) => window.mac.api(m, u, b), [method, url, body])

  try {
    page.on('close', () => console.log('[e2e] page closed'))
    app.on('close', () => console.log('[e2e] app closed'))
    await waitUntil(async () => (await page.evaluate(() => window.mac.runtime.status())).state === 'ready', 120_000, 'runtime ready')
    step('runtime ready')

    // 2. configuration a user would make in the setup wizard (orchestrator, local model roles)
    const settings = await api('PATCH', '/settings', {
      orchestrator,
      codexModel: process.env.MAC_E2E_CODEX_MODEL ?? '',
      ollamaBaseUrl: ollamaUrl,
      ollamaModelsDir: process.env.MAC_E2E_OLLAMA_MODELS ?? null,
      costMode: 'balanced',
      planApproval: true,
      approvalMode: 'manual',
    })
    assert.equal(settings.status, 200, JSON.stringify(settings.data))
    const ollama = await api('GET', '/local-models/ollama')
    if (!ollama.data.reachable) await api('POST', '/local-models/ollama/start')
    const installed = await api('GET', '/local-models/installed')
    assert.ok(installed.data.some?.((entry) => entry.name === model), `Model ${model} must be installed in Ollama at ${ollamaUrl} (download it in the app first).`)
    await api('PUT', '/local-models/roles', { fast: model, balanced: model, advanced: model })
    const status = await api('GET', `/orchestrator/${orchestrator}/status`)
    assert.ok(status.data.authenticated && !status.data.usesApiKeyBilling, `${orchestrator} must be logged in with a subscription: ${JSON.stringify(status.data)}`)
    await api('POST', '/onboarding/complete')
    await page.reload()
    step('configured', { orchestrator: status.data.authMethod, model })

    // 3. user opens the repository (native folder dialog answered by the test)
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    }, repo)
    await page.getByRole('button', { name: 'Ordner öffnen' }).first().click()
    await page.locator('.project-name', { hasText: path.basename(repo) }).waitFor({ timeout: 30_000 })
    await shot(page, '01-project-open')
    step('repository opened')

    // 4. user asks for the component in the orchestrator chat
    await page.locator('#chat-input').fill(REQUEST)
    await page.getByRole('button', { name: 'Senden' }).click()
    await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 15 * 60_000 })
    await shot(page, '02-plan')
    const tasks = await api('GET', `/tasks?projectId=${(await api('GET', '/settings')).data.lastProjectId}`)
    const task = tasks.data[0]
    const detail = await api('GET', `/tasks/${task.id}`)
    const plan = detail.data.plans[0]
    step('planned', { source: plan.source, subtasks: detail.data.subtasks.map((subtask) => ({ key: subtask.key, title: subtask.title, executor: subtask.selectedModelClass, model: subtask.selectedModelName })) })
    assert.equal(plan.source, orchestrator, 'the plan must come from the premium orchestrator, not the fallback planner')

    // 5. user starts the execution; agents work in isolated worktrees
    await page.getByRole('button', { name: 'Ausführung starten' }).click()
    await page.locator('[data-testid="workflow"][data-state="approval"]').waitFor({ timeout: 45 * 60_000 })
    await shot(page, '03-agents-awaiting-approval')
    const execution = (await api('GET', `/executions/${(await api('GET', `/tasks/${task.id}`)).data.executions[0].id}`)).data
    const localSuccess = execution.agentRuns.filter((runEntry) => runEntry.selectedModelClass === 'local_llm' && runEntry.outcome === 'success')
    step('awaiting approval', {
      attempts: execution.agentRuns.map((runEntry) => ({ model: runEntry.selectedModelName, outcome: runEntry.outcome, repair: runEntry.repairRound, ms: runEntry.durationMs })),
      validation: execution.finalValidation.summary,
      review: execution.review.kind,
      usage: { premiumCalls: execution.usage.premium.calls, premiumTokens: execution.usage.premium.inputTokens + execution.usage.premium.outputTokens, localCalls: execution.usage.local.calls, localTokens: execution.usage.local.inputTokens + execution.usage.local.outputTokens },
    })
    assert.ok(localSuccess.length > 0, 'a local model must have produced a validated patch')
    assert.ok(execution.finalValidation.ok, `final validation failed: ${execution.finalValidation.summary}`)
    assert.ok(execution.finalValidation.results.some((result) => result.kind === 'typecheck' && result.status === 'passed'), 'typecheck must run and pass')
    assert.ok(execution.finalValidation.results.some((result) => result.kind === 'test' && result.status === 'passed'), 'tests must run and pass')
    assert.ok(!existsSync(path.join(repo, 'src', 'components', 'Greeting.tsx')), 'nothing may be written to the checkout before approval')

    // 6. the diff is shown on the approval screen
    await go(page, 'Freigabe')
    await page.locator('[data-testid="workflow-approval"] .review-file', { hasText: 'Greeting' }).first().click()
    await page.locator('[data-testid="workflow-approval"] .diff-row.add', { hasText: 'Greeting' }).first().waitFor({ timeout: 30_000 })
    await shot(page, '04-diff')
    step('diff shown', { files: (execution.finalDiff.match(/^diff --git a\/(\S+)/gm) ?? []).map((line) => line.slice(13)) })

    // 7. user approves → applied to the working tree
    await page.getByRole('button', { name: 'In Arbeitskopie übernehmen' }).first().click()
    await waitUntil(async () => (await api('GET', `/executions/${execution.id}`)).data.status === 'applied', 60_000, 'changes applied')
    await shot(page, '05-applied')
    const component = readFileSync(path.join(repo, 'src', 'components', 'Greeting.tsx'), 'utf8')
    assert.match(component, /Greeting/)
    assert.match(component, /name/)
    const repoTypecheck = run('pnpm', ['run', 'typecheck'], repo)
    const repoTests = run('npx', ['--no-install', 'vitest', 'run'], repo)
    step('applied and verified in the repository', { component: component.slice(0, 400), tests: repoTests.match(/Tests\s+.*$/m)?.[0], typecheck: repoTypecheck.trim().split('\n').pop() })
    assert.match(repoTests, /passed/)
    report.ok = true
  } finally {
    report.consoleErrors = consoleErrors
    report.finishedAt = new Date().toISOString()
    writeFileSync(path.join(resultsDir, `${stamp}-report.json`), JSON.stringify(report, null, 2))
    await app.close()
  }
})
