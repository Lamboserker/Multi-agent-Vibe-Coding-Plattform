// GUI test of the skill manager/builder and the MCP manager (real app, real runtime, real MCP server
// process built with the official SDK: apps/api/src/mcp/testing/test-server.mjs). No model is called.
//
//   pnpm --filter @multi-ai-coder/desktop build
//   node --test e2e/skills-mcp.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { answerFolderDialog, appDir, launch, newProfile, prepareRepository, quit, resultsDir, stamp, waitUntil } from './helpers.mjs'

const testServer = path.resolve(appDir, '../api/src/mcp/testing/test-server.mjs')

test('skills and MCP servers through the UI', { timeout: 10 * 60_000 }, async () => {
  const id = stamp()
  const repo = prepareRepository()
  const profile = newProfile()
  const session = await launch(profile)
  const { app, page, api } = session
  try {
    assert.equal((await api('PATCH', '/settings', { orchestrator: null })).status, 200)
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await answerFolderDialog(app, repo)
    await page.getByRole('button', { name: 'Ordner öffnen' }).first().click()
    await page.locator('[data-path="src"]').first().waitFor()

    // ---------------- Skills ----------------
    await page.locator('nav.activity-bar button[aria-label="Skills"]').click()
    const skillsView = page.locator('[data-view="skills"]')
    await skillsView.locator('.plugin-item', { hasText: 'writing-tests' }).waitFor({ timeout: 30_000 })
    // builder: a project skill
    await skillsView.getByRole('button', { name: 'Neuer Skill' }).click()
    await skillsView.locator('label:has-text("Speicherort") select').selectOption('project')
    await skillsView.locator('label:has-text("Name") input').fill('ui-conventions')
    await skillsView.locator('label:has-text("Beschreibung") textarea').fill('UI-Konventionen des Teams. Gilt für Komponenten.')
    await skillsView.locator('label:has-text("Auslöser") input').fill('komponente, button')
    await skillsView.locator('label:has-text("Anweisungen") textarea').fill('# UI\nButtons verwenden immer die Klasse btn.')
    await skillsView.getByRole('button', { name: 'Speichern' }).click()
    await skillsView.locator('.panel-header h2', { hasText: 'ui-conventions' }).waitFor()
    const skillFile = readFileSync(path.join(repo, '.multi-ai-coder', 'skills', 'ui-conventions', 'SKILL.md'), 'utf8')
    assert.match(skillFile, /triggers: \[komponente, button\]/)
    // role assignment
    await skillsView.locator('label:has-text("Alle Agenten") input').uncheck()
    await skillsView.locator('label:has-text("Chat-Fragen") input').uncheck()
    await waitUntil(async () => {
      const skill = (await api('GET', `/skills?projectId=${(await api('GET', '/settings')).data.lastProjectId}`)).data.find((entry) => entry.name === 'ui-conventions')
      return JSON.stringify(skill?.agents) === JSON.stringify(['planner', 'coder'])
    }, 10_000, 'role assignment saved')
    // preview: which skills a coder gets for a goal
    await skillsView.locator('button[aria-label="Zurück zur Liste"]').click()
    await skillsView.locator('input[placeholder^="Aufgabe"]').fill('Neue Button-Komponente mit Tests')
    await skillsView.getByRole('button', { name: 'Prüfen', exact: true }).click()
    await skillsView.getByText(/Vollständig im Kontext: .*ui-conventions/).waitFor()
    // script approval of the shipped changelog skill (shows the script before approving)
    await skillsView.locator('.plugin-item', { hasText: 'changelog' }).click()
    await skillsView.getByRole('button', { name: 'Skripte prüfen und genehmigen …' }).click()
    await page.locator('.modal').getByText('git describe').first().waitFor()
    await page.locator('.modal .btn.primary').click()
    await skillsView.getByText('genehmigt', { exact: true }).waitFor()

    // ---------------- MCP ----------------
    await page.locator('nav.activity-bar button[aria-label="MCP-Server"]').click()
    const mcpView = page.locator('[data-view="mcp"]')
    await mcpView.getByRole('button', { name: 'Server hinzufügen' }).click()
    await mcpView.locator('label').filter({ has: page.locator('span', { hasText: /^Name$/ }) }).locator('input').fill('testserver')
    await mcpView.locator('label:has-text("Befehl") input').fill(process.execPath)
    await mcpView.locator('label:has-text("Argumente") textarea').fill(testServer)
    await mcpView.locator('label:has-text("Geheime Umgebungsvariablen") input').fill('TEST_TOKEN')
    await mcpView.getByRole('button', { name: 'Speichern' }).click()
    await mcpView.locator('.panel-header h2', { hasText: 'testserver' }).waitFor()
    // the secret is entered in the UI and stored encrypted by the shell
    await mcpView.locator('input[type="password"]').fill('geheim123')
    await mcpView.locator('label:has-text("Umgebungsvariable TEST_TOKEN")').getByRole('button', { name: 'Speichern' }).click()
    await waitUntil(async () => (await mcpView.locator('input[type="password"]').getAttribute('placeholder'))?.includes('gespeichert'), 10_000, 'secret stored')
    assert.ok(!readFileSync(path.join(profile, 'secrets.json'), 'utf8').includes('geheim123'), 'MCP secret encrypted at rest')
    await mcpView.getByRole('button', { name: 'Verbindung testen' }).click()
    await mcpView.locator('td code', { hasText: 'drop_table' }).waitFor({ timeout: 30_000 })
    await mcpView.getByText('verändert/löscht').first().waitFor()
    // destructive tools default to "confirm"; allow "add" for agents
    const addRow = mcpView.locator('tr', { has: page.locator('code', { hasText: /^add$/ }) })
    await addRow.locator('select').selectOption('allow')
    await waitUntil(async () => {
      const servers = (await api('GET', '/mcp/servers')).data
      return servers[0]?.toolPolicies?.add === 'allow'
    }, 10_000, 'policy saved')
    // manual call with confirmation; the server sees the secret from the vault
    const secretRow = mcpView.locator('tr', { has: page.locator('code', { hasText: 'secret_env' }) })
    await secretRow.getByRole('button', { name: 'Ausprobieren' }).click()
    await page.locator('.modal .btn.primary').click()
    await mcpView.locator('.plugin-result pre', { hasText: 'token:9' }).waitFor({ timeout: 20_000 })
    await addRow.getByRole('button', { name: 'Ausprobieren' }).click()
    await page.locator('.modal textarea').fill('{ "a": 20, "b": 22 }')
    await page.locator('.modal .btn.primary').click()
    await mcpView.locator('.plugin-result pre', { hasText: /^42$/ }).waitFor({ timeout: 20_000 })
    await page.screenshot({ path: path.join(resultsDir, `${id}-mcp-manager.png`) })

    // import (credentials go to the vault, server starts disabled)
    await mcpView.locator('button[aria-label="Zurück zur Liste"]').click()
    await mcpView.getByRole('button', { name: 'JSON importieren' }).click()
    await page.locator('.modal textarea').fill(JSON.stringify({ mcpServers: { imported: { command: 'npx', args: ['-y', 'x'], env: { API_KEY: 'very-secret' } } } }))
    await page.locator('.modal .btn.primary').click()
    await mcpView.locator('.plugin-item', { hasText: 'imported' }).waitFor()
    const imported = (await api('GET', '/mcp/servers')).data.find((server) => server.name === 'imported')
    assert.equal(imported.enabled, false)
    assert.deepEqual(imported.secretEnv, ['API_KEY'])
    assert.ok(!readFileSync(path.join(profile, 'secrets.json'), 'utf8').includes('very-secret'))
    assert.deepEqual(session.consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(app)
  }
})
