// A failed run can be ended (its work state is cleaned up, the failure banner goes away) or planned anew
// instead of repeating the same plan. Fast path, no model: a project test that pins the old name makes
// the rename fail its validation.
//
//   pnpm --filter @multi-ai-coder/desktop build && node --test e2e/failed-run.test.mjs
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { launch, newProfile, openProject, prepareRepository, quit, waitUntil } from './helpers.mjs'

test('a failed run can be ended and planned anew', { timeout: 10 * 60_000 }, async () => {
  const repo = prepareRepository({ install: true })
  writeFileSync(path.join(repo, 'src', 'name.test.ts'), "import { Badge } from './components/Badge'\n\ntest('keeps the public name', () => expect(Badge.name).toBe('Badge'))\n")
  execSync('git add -A && git -c user.name=t -c user.email=t@t commit -q -m "pin name"', { cwd: repo })
  const { app, page, api, consoleErrors } = await launch(newProfile())
  try {
    await api('PATCH', '/settings', { orchestrator: null, planApproval: true, fastPath: true, autoStartSmallPlans: false })
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(app, page, repo)
    await page.locator('#chat-input').fill('Benenne die Komponente Badge in Tag um (src/components/Badge.tsx)')
    await page.getByRole('button', { name: 'Senden' }).click()
    await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Ausführung starten' }).click()
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const sessionId = (await api('GET', `/projects/${projectId}/sessions`)).data[0].id
    const executionId = await waitUntil(async () => (await api('GET', `/sessions/${sessionId}`)).data.tasks[0]?.execution?.id, 30_000, 'execution')
    const status = await waitUntil(async () => { const value = (await api('GET', `/executions/${executionId}`)).data.status; return ['pending', 'running', 'integrating'].includes(value) ? null : value }, 5 * 60_000, 'run finished', 1000)
    assert.equal(status, 'failed')

    const workflow = page.locator('[data-testid="workflow"]')
    await page.locator('[data-testid="run-notice"]').waitFor({ timeout: 30_000 })
    await workflow.getByRole('button', { name: 'Neu planen' }).waitFor()
    await workflow.getByRole('button', { name: 'Lauf beenden' }).click()
    await waitUntil(async () => (await api('GET', `/executions/${executionId}`)).data.status === 'cancelled', 30_000, 'run ended')
    await waitUntil(async () => (await page.locator('[data-testid="run-notice"]').count()) === 0, 15_000, 'failure banner gone')
    assert.equal(await workflow.getByRole('button', { name: 'Lauf beenden' }).count(), 0)
    assert.equal(execSync('git branch --list "mac/*"', { cwd: repo, encoding: 'utf8' }).trim(), '', 'no leftover agent branch')

    // planning anew is possible right away
    await workflow.getByRole('button', { name: 'Neu planen' }).click()
    await page.locator('.modal textarea, .modal input').first().fill('Lass den Namen in name.test.ts unverändert')
    await page.locator('.modal .btn.primary').click()
    await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 60_000 }).catch(async (error) => {
      const task = (await api('GET', `/sessions/${sessionId}`)).data.tasks
      console.log('[e2e] replan', await workflow.getAttribute('data-state'), JSON.stringify(task.map((entry) => [entry.status, entry.currentStep, entry.errorMessage])), JSON.stringify((await api('GET', `/sessions/${sessionId}`)).data.messages?.slice(-3).map((message) => message.content.slice(0, 200))))
      throw error
    })
    assert.deepEqual(consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(app)
  }
})
