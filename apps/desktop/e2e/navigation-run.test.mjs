// Acceptance test (Phase 0.3, 1.7 / criterion 15): a REAL coding run keeps running and stays attached
// to its session while the user navigates, reloads the window and restarts the app.
//
// Real: Electron app, runtime, git worktrees, local Ollama model, typecheck + tests in the worktree.
// No premium call: no orchestrator is selected, the deterministic fallback planner creates the plan.
//
//   MAC_E2E_LIVE=1 MAC_E2E_MODEL=qwen2.5-coder:7b MAC_E2E_OLLAMA_URL=http://127.0.0.1:11435 \
//   MAC_E2E_OLLAMA_MODELS=D:\ollama-models node --test e2e/navigation-run.test.mjs
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { CHAT_MESSAGES, go, launch, newProfile, openProject, percentiles, prepareRepository, quit, resultsDir, stamp, waitUntil } from './helpers.mjs'

const live = process.env.MAC_E2E_LIVE === '1'
const model = process.env.MAC_E2E_MODEL ?? 'qwen2.5-coder:7b'
const ollamaUrl = process.env.MAC_E2E_OLLAMA_URL ?? 'http://127.0.0.1:11434'
const VIEWS = ['Code', 'Freigabe', 'Sitzungen', 'Modelle', 'Kosten', 'Setup', 'Code', 'Leitstand']
const REQUEST =
  'Erstelle eine React-Komponente `Greeting` in `src/components/Greeting.tsx` mit der Prop `name: string`, die `<h1 className="greeting">Hallo, {name}!</h1>` rendert, ' +
  'und einen Vitest-Test in `src/components/Greeting.test.tsx` nach dem Muster von `src/components/Badge.test.tsx` (renderToStaticMarkup).'
const ACTIVE = ['pending', 'running', 'integrating']

test('a real run keeps running and stays in its session across navigation, reload and app restart', { skip: !live && 'set MAC_E2E_LIVE=1 (needs Ollama with the model)', timeout: 60 * 60_000 }, async () => {
  const id = stamp()
  const report = { startedAt: new Date().toISOString(), model, steps: [], navigationMs: [], checks: [] }
  const step = (name, detail) => {
    report.steps.push({ name, at: new Date().toISOString(), ...detail })
    console.log(`[e2e] ${name}`, detail ? JSON.stringify(detail).slice(0, 500) : '')
  }
  const repo = prepareRepository({ install: true })
  const profile = newProfile()
  let session = await launch(profile)
  let { app, page, api } = session
  try {
    // --- configuration: local model only, no orchestrator ---
    await api('PATCH', '/settings', { orchestrator: null, ollamaBaseUrl: ollamaUrl, ollamaModelsDir: process.env.MAC_E2E_OLLAMA_MODELS ?? null, planApproval: true, approvalMode: 'manual', premiumReviewPolicy: 'never' })
    if (!(await api('GET', '/local-models/ollama')).data.reachable) await api('POST', '/local-models/ollama/start')
    await waitUntil(async () => (await api('GET', '/local-models/ollama')).data.reachable, 60_000, 'ollama reachable')
    const installed = await api('GET', '/local-models/installed')
    assert.ok(installed.data.some?.((entry) => entry.name === model), `Model ${model} must be installed at ${ollamaUrl}`)
    await api('PUT', '/local-models/roles', { fast: model, balanced: model, advanced: model })
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(app, page, repo)
    await go(page, 'Code')
    await page.locator('[data-path="src"]').first().waitFor({ timeout: 30_000 })
    step('configured and project opened', { model })
    await go(page, 'Leitstand')

    // --- start a real run ---
    await page.locator('#chat-input').fill(REQUEST)
    await page.getByRole('button', { name: 'Senden' }).click()
    await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 120_000 })
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const sessions = (await api('GET', `/projects/${projectId}/sessions`)).data
    assert.equal(sessions.length, 1)
    const sessionId = sessions[0].id
    await page.getByRole('button', { name: 'Ausführung starten' }).click()
    const executionId = await waitUntil(async () => (await api('GET', `/sessions/${sessionId}`)).data.tasks[0]?.execution?.id, 30_000, 'execution created')
    await page.locator('[data-testid="run-running"]').waitFor({ timeout: 30_000 })
    step('run started', { sessionId, executionId })

    const runStatus = async () => (await api('GET', `/executions/${executionId}`)).data.status
    const uiState = () =>
      page.evaluate((selector) => ({
        sessionTitle: document.querySelector('[data-testid="session-title"]')?.textContent,
        messages: document.querySelectorAll(selector).length,
        runVisible: Boolean(document.querySelector('[data-testid="run-running"]')) || Boolean(document.querySelector('.approval-card')),
        activity: document.querySelector('.activity-indicator')?.textContent ?? document.querySelector('.status-bar')?.textContent,
      }), CHAT_MESSAGES)
    const initial = await uiState()

    // --- navigate at least 30 times while the run is active ---
    let navigationsWhileRunning = 0
    for (let index = 0; index < 40; index += 1) {
      const view = VIEWS[index % VIEWS.length]
      const started = Date.now()
      await go(page, view)
      report.navigationMs.push(Date.now() - started)
      const status = await runStatus()
      if (ACTIVE.includes(status)) navigationsWhileRunning += 1
      if (index % 8 === 7) {
        const state = await uiState()
        report.checks.push({ index, status, ...state })
        assert.equal(state.sessionTitle, initial.sessionTitle, 'the session stays selected')
        assert.ok(state.messages >= initial.messages, 'no message disappears')
        assert.notEqual(status, 'cancelled', 'navigation never cancels the run')
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    step('navigated while running', { navigationsWhileRunning, navigation: percentiles(report.navigationMs) })
    assert.ok(navigationsWhileRunning >= 30, `at least 30 navigations must happen while the run is active (got ${navigationsWhileRunning}); use a slower model if the run finishes too fast`)

    // --- renderer reload while the run is (most likely still) active ---
    const statusBeforeReload = await runStatus()
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await waitUntil(async () => (await uiState()).sessionTitle === initial.sessionTitle, 20_000, 'session restored after reload')
    const statusAfterReload = await runStatus()
    assert.notEqual(statusAfterReload, 'cancelled')
    step('reload during run', { statusBeforeReload, statusAfterReload })

    // --- the run finishes in its original session ---
    const finalStatus = await waitUntil(async () => {
      const status = await runStatus()
      return ACTIVE.includes(status) ? null : status
    }, 45 * 60_000, 'run finished', 2000)
    const detail = (await api('GET', `/sessions/${sessionId}`)).data
    assert.equal(detail.tasks[0].execution.id, executionId, 'the result belongs to the original session')
    assert.ok(detail.messages.some((message) => message.metadata?.kind === 'run_summary' && message.metadata.executionId === executionId), 'the run summary is posted into the original session')
    const run = (await api('GET', `/executions/${executionId}`)).data
    step('run finished', {
      finalStatus,
      attempts: run.agentRuns.map((attempt) => ({ model: attempt.selectedModelName, outcome: attempt.outcome, ms: attempt.durationMs })),
      validation: run.finalValidation?.summary,
      premiumCalls: run.usage?.premium.calls,
    })
    report.coding = { status: finalStatus, ok: ['awaiting_approval', 'completed'].includes(finalStatus), task: detail.tasks[0], attempts: run.agentRuns, finalValidation: run.finalValidation }
    assert.equal(run.usage?.premium.calls ?? 0, 0, 'no premium call happened')
    if (finalStatus === 'awaiting_approval') await page.locator('[data-testid="workflow"][data-state="approval"]').waitFor({ timeout: 20_000 })

    // --- app restart: the session with its finished run is restored ---
    await quit(app)
    session = await launch(profile)
    ;({ app, page, api } = session)
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await waitUntil(async () => (await uiState()).sessionTitle === initial.sessionTitle, 30_000, 'session restored after restart')
    const restartedStatus = await runStatus()
    assert.equal(restartedStatus, finalStatus, 'a finished run keeps its status across restarts')
    if (finalStatus === 'awaiting_approval') await page.locator('[data-testid="workflow"][data-state="approval"]').waitFor({ timeout: 20_000 })
    const activity = (await api('GET', '/activity')).data
    assert.equal(activity.executions.length, 0, 'nothing is shown as running after the restart')
    step('app restart', { restartedStatus })
    await page.screenshot({ path: path.join(resultsDir, `${id}-navigation-run-restart.png`) })
    report.ok = true
    report.acceptance = { navigation: true, persistence: true, coding: report.coding.ok }
  } finally {
    report.consoleErrors = session.consoleErrors
    report.finishedAt = new Date().toISOString()
    writeFileSync(path.join(resultsDir, `${id}-navigation-run-report.json`), JSON.stringify(report, null, 2))
    await quit(app)
  }
})

test('an app restart during a real run marks it interrupted (not running) and it can be resumed in its session', { skip: !live && 'set MAC_E2E_LIVE=1 (needs Ollama with the model)', timeout: 60 * 60_000 }, async () => {
  const repo = prepareRepository({ install: true })
  const profile = newProfile()
  let session = await launch(profile)
  let { app, page, api } = session
  try {
    await api('PATCH', '/settings', { orchestrator: null, ollamaBaseUrl: ollamaUrl, ollamaModelsDir: process.env.MAC_E2E_OLLAMA_MODELS ?? null, planApproval: true, approvalMode: 'manual', premiumReviewPolicy: 'never' })
    if (!(await api('GET', '/local-models/ollama')).data.reachable) await api('POST', '/local-models/ollama/start')
    await waitUntil(async () => (await api('GET', '/local-models/ollama')).data.reachable, 60_000, 'ollama reachable')
    await api('PUT', '/local-models/roles', { fast: model, balanced: model, advanced: model })
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(app, page, repo)
    await page.locator('#chat-input').fill(REQUEST)
    await page.getByRole('button', { name: 'Senden' }).click()
    await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 120_000 })
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const sessionId = (await api('GET', `/projects/${projectId}/sessions`)).data[0].id
    await page.getByRole('button', { name: 'Ausführung starten' }).click()
    const executionId = await waitUntil(async () => (await api('GET', `/sessions/${sessionId}`)).data.tasks[0]?.execution?.id, 30_000, 'execution created')
    // quit while a local agent is working on the task (integration worktree exists → resumable)
    await waitUntil(async () => {
      const run = (await api('GET', `/executions/${executionId}`)).data
      return run.status === 'running' && run.integrationBranch && run.agentRuns?.some((attempt) => attempt.status === 'running')
    }, 120_000, 'agent working', 200)
    console.log('[e2e] agent working; quitting the app')

    await quit(app)
    session = await launch(profile)
    ;({ app, page, api } = session)
    await page.waitForSelector('.ide', { timeout: 60_000 })
    assert.equal((await api('GET', `/executions/${executionId}`)).data.status, 'interrupted', 'a run whose process ended is shown as interrupted, never as running')
    assert.equal((await api('GET', '/activity')).data.executions.length, 0)
    await waitUntil(async () => (await api('GET', `/sessions/${sessionId}`)).data.status === 'interrupted', 10_000, 'session interrupted')
    await page.locator('[data-testid="workflow"]').getByRole('button', { name: 'Ausführung fortsetzen' }).click()
    console.log('[e2e] resumed after restart')
    const finalStatus = await waitUntil(async () => {
      const status = (await api('GET', `/executions/${executionId}`)).data.status
      return ACTIVE.includes(status) ? null : status
    }, 45 * 60_000, 'resumed run finished', 2000)
    assert.equal(finalStatus, 'awaiting_approval')
    const detail = (await api('GET', `/sessions/${sessionId}`)).data
    assert.equal(detail.tasks[0].execution.id, executionId, 'the resumed run stays in its session')
    const run = (await api('GET', `/executions/${executionId}`)).data
    assert.equal(run.usage?.premium.calls ?? 0, 0, 'no premium call happened')
    console.log('[e2e] resumed run finished', JSON.stringify({ finalStatus, attempts: run.agentRuns.map((attempt) => attempt.outcome), validation: run.finalValidation?.summary }))
  } finally {
    await quit(app)
  }
})
