import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { appDir, launch, newProfile, quit, resultsDir, setupSection, stamp, waitUntil } from './helpers.mjs'

test('integration catalog, explicit grants, packages and restart through the desktop', { timeout: 240_000 }, async () => {
  const profile = newProfile()
  let session = await launch(profile)
  const id = stamp()
  try {
    let { app, page, api } = session
    await api('PATCH', '/settings', { orchestrator: null })
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await setupSection(page, 'MCP-Server')
    const view = page.locator('[data-view="mcp"]')
    await view.getByRole('button', { name: 'Integrationskatalog', exact: true }).click()
    const catalog = view.getByTestId('integration-catalog')
    await catalog.locator('.integration-card').first().waitFor()
    assert.equal(await catalog.locator('.integration-card').count(), process.platform === 'win32' ? 30 : 29)
    await catalog.getByLabel('Katalog durchsuchen').fill('higgsfield')
    assert.equal(await catalog.locator('.integration-card').count(), 1)
    await catalog.getByLabel('Katalog durchsuchen').fill('')
    await catalog.getByRole('tab', { name: 'Skills', exact: true }).click()
    assert.equal(await catalog.locator('.integration-card').count(), 40)
    const browserSkill = catalog.locator('.integration-card').filter({ has: page.getByRole('heading', { name: 'Browsersteuerung', exact: true }) })
    await browserSkill.getByRole('button', { name: 'Aktivieren', exact: true }).click()
    await browserSkill.getByText('Aktiv', { exact: true }).waitFor()
    await catalog.getByRole('tab', { name: 'Workflow-Pakete', exact: true }).click()
    assert.equal(await catalog.locator('.integration-card').count(), 8)
    await page.screenshot({ path: path.join(resultsDir, `${id}-integration-bundles.png`) })
    await catalog.getByRole('tab', { name: 'MCP-Server', exact: true }).click()

    const server = (await api('POST', '/mcp/servers', { name: 'fixture-browser', transport: 'stdio', command: process.execPath, args: [path.resolve(appDir, '../api/src/mcp/testing/test-server.mjs')], defaultPolicy: 'confirm', agents: [] })).data
    await catalog.locator('.integration-card').filter({ has: page.getByRole('heading', { name: 'Microsoft Playwright', exact: true }) }).getByRole('button', { name: 'Einrichten', exact: true }).click()
    const wizard = view.getByTestId('integration-setup')
    await wizard.getByLabel('Vorhandene Verbindung verwenden').selectOption(server.id)
    await wizard.getByRole('button', { name: 'Einrichtung starten', exact: true }).click()
    await wizard.getByRole('heading', { name: 'Werkzeuge und Agenten freigeben', exact: true }).waitFor({ timeout: 30_000 })
    await wizard.locator('.integration-tool').filter({ has: page.locator('strong', { hasText: /^add$/ }) }).locator('input').check()
    await page.screenshot({ path: path.join(resultsDir, `${id}-integration-grants.png`) })
    await wizard.getByRole('button', { name: 'Auswahl freigeben und abschließen', exact: true }).click()
    await wizard.getByRole('button', { name: 'Zum Katalog', exact: true }).waitFor()
    const granted = (await api('GET', `/mcp/servers/${server.id}`)).data
    assert.deepEqual(granted.toolPolicies, { add: 'allow' })
    assert.equal(granted.defaultPolicy, 'confirm')
    assert.deepEqual(granted.agents, ['coder', 'chat'])
    await wizard.getByRole('button', { name: 'Zum Katalog', exact: true }).click()

    const contextServer = (await api('POST', '/mcp/servers', { name: 'fixture-docs', transport: 'stdio', command: process.execPath, args: [path.resolve(appDir, '../api/src/mcp/testing/test-server.mjs')], defaultPolicy: 'confirm', agents: [] })).data
    const job = (await api('POST', '/integrations/presets/context7/setup', { reuseServerId: contextServer.id })).data
    await waitUntil(async () => (await api('GET', `/integrations/jobs/${job.id}`)).data.phase === 'approval', 30_000, 'context setup approval')
    assert.equal((await api('POST', `/integrations/jobs/${job.id}/approve`, { roles: ['coder'], allow: ['add'] })).status, 201)
    await catalog.getByRole('tab', { name: 'Workflow-Pakete', exact: true }).click()
    await catalog.locator('.integration-card').filter({ has: page.getByRole('heading', { name: 'Webentwicklung', exact: true }) }).getByRole('button', { name: 'Paket öffnen', exact: true }).click()
    await view.getByRole('button', { name: 'Paket aktivieren', exact: true }).click()
    await view.getByRole('button', { name: 'Paketzuordnung entfernen', exact: true }).waitFor()
    await quit(app)

    session = await launch(profile)
    ;({ app, page, api } = session)
    const persisted = (await api('GET', '/integrations/catalog')).data
    assert.equal(persisted.presets.find((entry) => entry.id === 'playwright').serverId, server.id)
    assert.equal(persisted.bundles.find((entry) => entry.id === 'web').active, true)
    assert.equal(persisted.skills.find((entry) => entry.id === 'browser-control').enabled, true)
    await setupSection(page, 'Skills')
    await page.locator('[data-view="skills"]').getByRole('button', { name: 'Integrationskatalog', exact: true }).click()
    await page.getByTestId('integration-catalog').getByRole('tab', { name: 'Skills', exact: true }).waitFor()
    assert.equal(session.consoleErrors.length, 0)
  } finally { await quit(session.app) }
})
