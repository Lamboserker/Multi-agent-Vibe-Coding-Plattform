// Fast path end-to-end (real app, runtime, git worktree, typecheck + vitest): a rename request is
// executed by the TypeScript language service without any model – no orchestrator, no local model.
// Covers the Leitstand (plan, run), the approval screen with the real diff, apply and undo.
//
//   pnpm --filter @multi-ai-coder/desktop build && node --test e2e/fast-path.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { CHAT_MESSAGES, go, launch, newProfile, openProject, prepareRepository, quit, resultsDir, stamp, waitUntil } from './helpers.mjs'

test('a rename request runs on the fast path without any model and is applied after approval', { timeout: 10 * 60_000 }, async () => {
  const repo = prepareRepository({ install: true })
  const session = await launch(newProfile())
  const { app, page, api } = session
  try {
    await api('PATCH', '/settings', { orchestrator: null, planApproval: true, fastPath: true, modelRoles: undefined, approvalMode: 'manual' })
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(app, page, repo)
    await page.locator('#chat-input').fill('Benenne die Komponente Badge in Tag um (src/components/Badge.tsx)')
    await page.getByRole('button', { name: 'Senden' }).click()
    const workflow = page.locator('[data-testid="workflow"]')
    await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 60_000 })
    assert.equal(await workflow.getAttribute('data-state'), 'ready')
    assert.equal(await page.getByRole('button', { name: 'Ausführung starten', exact: true }).count(), 1)
    await workflow.getByText('Fast Path (ohne Premium-Planung)').first().waitFor()
    // the plan is in the chat as well (plan card below the orchestrator message)
    await page.locator('.plan-card .plan-row').first().waitFor()
    await page.getByRole('button', { name: 'Ausführung starten' }).click()
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const sessionId = (await api('GET', `/projects/${projectId}/sessions`)).data[0].id
    const executionId = await waitUntil(async () => (await api('GET', `/sessions/${sessionId}`)).data.tasks[0]?.execution?.id, 30_000, 'execution')
    const status = await waitUntil(async () => { const value = (await api('GET', `/executions/${executionId}`)).data.status; return ['pending', 'running', 'integrating'].includes(value) ? null : value }, 5 * 60_000, 'run finished', 1000)
    if (status !== 'awaiting_approval') console.log('[e2e] events', JSON.stringify((await api('GET', `/executions/${executionId}/events`)).data.map((event) => `${event.type}: ${event.message}`).slice(-25), null, 1))
    assert.equal(status, 'awaiting_approval')

    // --- Leitstand: approval state, but no approval controls (they live on the approval screen) ---
    await waitUntil(async () => (await workflow.getAttribute('data-state')) === 'approval', 30_000, 'leitstand shows approval')
    await page.locator('.approval-card').getByRole('button', { name: 'Prüfen und freigeben' }).waitFor()
    assert.equal(await workflow.getByRole('button', { name: /übernehmen|Verwerfen/ }).count(), 0)
    await page.getByRole('radio', { name: 'Kacheln' }).click()
    assert.equal(await workflow.getByRole('button', { name: /übernehmen|Verwerfen/ }).count(), 0)
    await page.getByRole('radio', { name: 'Graph' }).click()

    // --- approval screen with the real diff ---
    await workflow.getByRole('button', { name: 'Änderungen prüfen', exact: true }).click()
    const approval = page.locator('[data-testid="workflow-approval"]')
    await approval.waitFor()
    assert.equal(await approval.count(), 1, 'approval has exactly one home')
    await approval.getByText('Änderungen bereit zur Freigabe').waitFor()
    assert.equal(await page.getByRole('button', { name: 'In Arbeitskopie übernehmen', exact: true }).count(), 1)
    const files = await approval.locator('.review-file').allTextContents()
    assert.ok(files.some((entry) => entry.includes('App.tsx')) && files.some((entry) => entry.includes('Badge.tsx')), JSON.stringify(files))
    await approval.locator('.review-file', { hasText: 'Badge.tsx' }).first().click()
    await approval.locator('.diff-row.add', { hasText: 'function Tag' }).first().waitFor()
    assert.ok(await approval.locator('.diff-row.del', { hasText: 'Badge' }).count(), 'removed lines are shown')
    await approval.getByText('Typecheck').first().waitFor()
    await page.screenshot({ path: path.join(resultsDir, `${stamp()}-review-screen.png`) })

    // the agent version opens as a diff in the code screen
    await approval.getByRole('button', { name: 'Im Code öffnen' }).click()
    await page.locator('.tab.active', { hasText: 'Agenten: Badge.tsx' }).waitFor({ timeout: 15_000 })
    await page.locator('.agent-changes .change-row', { hasText: 'Badge.tsx' }).waitFor()
    await go(page, 'Freigabe')

    // --- reload: the approval is restored, the footer entry leads to the Leitstand ---
    await page.reload()
    await approval.waitFor({ timeout: 60_000 })
    await approval.getByText('Änderungen bereit zur Freigabe').waitFor({ timeout: 30_000 })
    await page.locator('[data-testid="workflow-entry"]').click()
    await waitUntil(async () => (await workflow.getAttribute('data-state')) === 'approval', 30_000, 'approval restored after reload')
    assert.ok(await page.locator(CHAT_MESSAGES).count() >= 2)

    const run = (await api('GET', `/executions/${executionId}`)).data
    console.log('[e2e] fast path run', JSON.stringify({ attempts: run.agentRuns.map((attempt) => [attempt.agentName, attempt.selectedModelName, attempt.outcome, attempt.durationMs]), validation: run.finalValidation.summary, calls: run.modelCalls.length }))
    assert.equal(run.modelCalls.length, 0, 'no model was called')
    assert.deepEqual(run.agentRuns.map((attempt) => attempt.agentName), ['DeterministicTool'])
    assert.ok(run.finalValidation.results.some((result) => result.kind === 'typecheck' && result.status === 'passed'))
    assert.ok(run.finalValidation.results.some((result) => result.kind === 'test' && result.status === 'passed'))

    // --- apply and undo ---
    await go(page, 'Freigabe')
    await page.getByRole('button', { name: 'In Arbeitskopie übernehmen' }).first().click()
    await waitUntil(async () => (await api('GET', `/executions/${executionId}`)).data.status === 'applied', 60_000, 'applied')
    await approval.locator('.done-box').waitFor({ timeout: 15_000 })
    assert.match(readFileSync(path.join(repo, 'src', 'App.tsx'), 'utf8'), /<Tag /)
    assert.match(readFileSync(path.join(repo, 'src', 'components', 'Badge.tsx'), 'utf8'), /function Tag/)
    await go(page, 'Leitstand')
    await waitUntil(async () => (await workflow.getAttribute('data-state')) === 'done', 15_000, 'workflow completed')
    await go(page, 'Freigabe')
    await approval.getByRole('button', { name: 'Rückgängig machen', exact: true }).click()
    await waitUntil(async () => (await api('GET', `/executions/${executionId}`)).data.applyRecords?.some((entry) => entry.status === 'reverted'), 30_000, 'applied change reverted')
    await approval.getByText('Die Übernahme wurde rückgängig gemacht.', { exact: true }).waitFor()
    await approval.getByText('Ergebnis (nicht übernommen)').waitFor()
    assert.match(readFileSync(path.join(repo, 'src', 'App.tsx'), 'utf8'), /<Badge /)
    assert.deepEqual(session.consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(app)
  }
})
