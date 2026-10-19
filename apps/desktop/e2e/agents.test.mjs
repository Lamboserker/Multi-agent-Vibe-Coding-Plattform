// GUI test of the agent manager: templates, editing, automatic assignment at planning, manual change.
// No model is called (no orchestrator: the deterministic fallback planner creates the plan).
//
//   pnpm --filter @multi-ai-coder/desktop build
//   node --test e2e/agents.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { go, launch, newProfile, openProject, prepareRepository, quit, setupSection, waitUntil } from './helpers.mjs'

test('agent manager: templates, automatic assignment at planning, manual change', { timeout: 10 * 60_000 }, async () => {
  const repo = prepareRepository()
  const { app, page, api, consoleErrors } = await launch(newProfile())
  try {
    assert.equal((await api('PATCH', '/settings', { orchestrator: null, planApproval: true, approvalMode: 'manual' })).status, 200)
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(app, page, repo)

    // --- create agents from templates and edit one ---
    await setupSection(page, 'Agenten')
    const view = page.locator('[data-view="agents"]')
    await view.locator('.card', { hasText: 'Test-Agent' }).getByRole('button', { name: 'Anlegen' }).click()
    await view.locator('.card', { hasText: 'Doku-Agent' }).getByRole('button', { name: 'Anlegen' }).click()
    await view.locator('.plugin-item', { hasText: 'Doku-Agent' }).waitFor()
    await view.locator('.plugin-item', { hasText: 'Test-Agent' }).click()
    await view.locator('label:has-text("Eskalation") select').selectOption('none')
    await view.locator('label:has-text("Max. Schritte") input').fill('12')
    await view.getByRole('button', { name: 'Speichern' }).click()
    await view.locator('.plugin-item', { hasText: 'Test-Agent' }).waitFor()
    const agents = (await api('GET', '/agents')).data
    const testAgent = agents.find((agent) => agent.name === 'Test-Agent')
    assert.equal(testAgent.escalation, 'none')
    assert.equal(testAgent.maxSteps, 12)
    assert.deepEqual(testAgent.skills, ['writing-tests'])

    // --- planning assigns the matching agent ---
    await go(page, 'Leitstand')
    await page.locator('#chat-input').fill('Ergänze Vitest-Tests für die Badge-Komponente in src/components/Badge.test.tsx')
    await page.getByRole('button', { name: 'Senden' }).click()
    await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 120_000 })
    const workflow = page.locator('[data-testid="workflow"]')
    await workflow.locator('[data-testid="subtask-agent"]', { hasText: 'Test-Agent' }).first().waitFor({ timeout: 20_000 })
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const sessionId = (await api('GET', `/projects/${projectId}/sessions`)).data[0].id
    const taskId = (await api('GET', `/sessions/${sessionId}`)).data.tasks[0].id
    const firstSubtask = async () => (await api('GET', `/tasks/${taskId}`)).data.subtasks[0]
    const subtask = await firstSubtask()
    assert.equal(subtask.agentId, testAgent.id)

    // --- manual change in the inspector of the selected agent ---
    await workflow.locator('.agent-node', { hasText: 'Test-Agent' }).first().click()
    await workflow.locator('.inspector select:has(option:text-is("Kein Agentenprofil (nur Router)"))').selectOption({ label: 'Kein Agentenprofil (nur Router)' })
    await waitUntil(async () => (await firstSubtask()).agentId === null, 10_000, 'agent removed')
    await workflow.locator('.inspector select:has(option:text-is("Kein Agentenprofil (nur Router)"))').selectOption({ label: 'Doku-Agent' })
    await waitUntil(async () => (await firstSubtask()).agentId === agents.find((agent) => agent.name === 'Doku-Agent').id, 10_000, 'agent changed')
    await workflow.locator('[data-testid="subtask-agent"]', { hasText: 'Doku-Agent' }).first().waitFor({ timeout: 10_000 })
    assert.deepEqual(consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(app)
  }
})
