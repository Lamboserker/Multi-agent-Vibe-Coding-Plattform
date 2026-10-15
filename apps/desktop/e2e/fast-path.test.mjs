// Fast path end-to-end (real app, runtime, git worktree, typecheck + vitest): a rename request is
// executed by the TypeScript language service without any model – no orchestrator, no local model.
//
//   pnpm --filter @multi-ai-coder/desktop build && node --test e2e/fast-path.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { answerFolderDialog, launch, newProfile, prepareRepository, quit, resultsDir, stamp, waitUntil } from './helpers.mjs'

test('a rename request runs on the fast path without any model and is applied after approval', { timeout: 10 * 60_000 }, async () => {
  const repo = prepareRepository({ install: true })
  const session = await launch(newProfile())
  const { app, page, api } = session
  try {
    await api('PATCH', '/settings', { orchestrator: null, planApproval: true, fastPath: true, modelRoles: undefined })
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await answerFolderDialog(app, repo)
    await page.getByRole('button', { name: 'Ordner öffnen' }).first().click()
    await page.locator('#chat-input').fill('Benenne die Komponente Badge in Tag um (src/components/Badge.tsx)')
    await page.getByRole('button', { name: 'Senden' }).click()
    await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 60_000 })
    const workflow = page.locator('[data-testid="workflow"]')
    assert.equal(await workflow.getAttribute('data-phase'), 'plan')
    assert.equal(await page.getByRole('button', { name: 'Ausführung starten', exact: true }).count(), 1)
    await page.getByText('Fast Path (ohne Premium-Planung)').first().waitFor()
    await page.getByRole('button', { name: 'Ausführung starten' }).click()
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const sessionId = (await api('GET', `/projects/${projectId}/sessions`)).data[0].id
    const executionId = await waitUntil(async () => (await api('GET', `/sessions/${sessionId}`)).data.tasks[0]?.execution?.id, 30_000, 'execution')
    const status = await waitUntil(async () => { const value = (await api('GET', `/executions/${executionId}`)).data.status; return ['pending', 'running', 'integrating'].includes(value) ? null : value }, 5 * 60_000, 'run finished', 1000)
    if (status !== 'awaiting_approval') console.log('[e2e] events', JSON.stringify((await api('GET', `/executions/${executionId}/events`)).data.map((event) => `${event.type}: ${event.message}`).slice(-25), null, 1))
    assert.equal(status, 'awaiting_approval')
    await page.getByText('Änderungen bereit zur Freigabe').first().waitFor({ timeout: 30_000 })
    assert.equal(await workflow.getAttribute('data-phase'), 'approval')
    assert.equal(await page.locator('[data-testid="workflow-approval"]').count(), 1, 'approval has exactly one home')
    assert.equal(await page.getByRole('button', { name: 'In Arbeitskopie übernehmen', exact: true }).count(), 1)
    await page.locator('nav.activity-bar button[aria-label="Agenten"]').click()
    const agents = page.locator('[data-view="agents"]')
    assert.equal(await agents.locator('[data-testid="workflow-approval"]').count(), 0)
    assert.equal(await agents.getByRole('button', { name: /Pausieren|Fortsetzen|Abbrechen|übernehmen/ }).count(), 0)
    await page.keyboard.press('Control+Shift+b')
    assert.equal(await page.locator('.chat-panel:visible').count(), 0)
    await agents.getByRole('button', { name: 'Zum Arbeitsablauf', exact: true }).click()
    await workflow.waitFor({ state: 'visible' })
    await page.getByRole('tab', { name: /Arbeitsablauf/ }).focus()
    await page.keyboard.press('End')
    assert.equal(await page.getByRole('tab', { name: 'Verlauf', exact: true }).getAttribute('aria-selected'), 'true')
    await page.locator('[data-testid="chat-messages"] .msg[data-role="user"]').first().waitFor({ state: 'visible' })
    await page.keyboard.press('Control+Shift+l')
    await workflow.waitFor({ state: 'visible' })
    await workflow.getByRole('button', { name: 'Laufdetails', exact: true }).click()
    await page.locator('.bottom-panel').getByRole('button', { name: 'Zum Arbeitsablauf', exact: true }).click()
    await page.reload()
    await workflow.waitFor({ state: 'visible', timeout: 60_000 })
    await waitUntil(async () => (await workflow.getAttribute('data-state')) === 'approval', 30_000, 'approval restored after reload')
    await page.locator('[data-testid="workflow-entry"]').click()
    assert.equal(await page.getByRole('tab', { name: /Arbeitsablauf/ }).getAttribute('aria-selected'), 'true')
    await page.screenshot({ path: path.join(resultsDir, `${stamp()}-workflow-approval.png`) })
    const run = (await api('GET', `/executions/${executionId}`)).data
    console.log('[e2e] fast path run', JSON.stringify({ attempts: run.agentRuns.map((attempt) => [attempt.agentName, attempt.selectedModelName, attempt.outcome, attempt.durationMs]), validation: run.finalValidation.summary, calls: run.modelCalls.length }))
    assert.equal(run.modelCalls.length, 0, 'no model was called')
    assert.deepEqual(run.agentRuns.map((attempt) => attempt.agentName), ['DeterministicTool'])
    assert.ok(run.finalValidation.results.some((result) => result.kind === 'typecheck' && result.status === 'passed'))
    assert.ok(run.finalValidation.results.some((result) => result.kind === 'test' && result.status === 'passed'))

    await page.getByRole('button', { name: 'In Arbeitskopie übernehmen' }).first().click()
    await waitUntil(async () => (await api('GET', `/executions/${executionId}`)).data.status === 'applied', 60_000, 'applied')
    await waitUntil(async () => (await workflow.getAttribute('data-state')) === 'done', 15_000, 'workflow completed')
    assert.match(readFileSync(path.join(repo, 'src', 'App.tsx'), 'utf8'), /<Tag /)
    assert.match(readFileSync(path.join(repo, 'src', 'components', 'Badge.tsx'), 'utf8'), /function Tag/)
    await workflow.getByRole('button', { name: 'Rückgängig machen', exact: true }).click()
    await waitUntil(async () => (await api('GET', `/executions/${executionId}`)).data.applyRecords?.some((entry) => entry.status === 'reverted'), 30_000, 'applied change reverted')
    await workflow.getByText('Die Übernahme wurde rückgängig gemacht.', { exact: true }).waitFor()
    assert.match(readFileSync(path.join(repo, 'src', 'App.tsx'), 'utf8'), /<Badge /)
  } finally {
    await quit(app)
  }
})
