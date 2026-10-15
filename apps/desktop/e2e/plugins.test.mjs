// GUI test of the plugin manager (real Electron app, real runtime, real plugin host processes).
//
//   pnpm --filter @multi-ai-coder/desktop build
//   node --test e2e/plugins.test.mjs
//
// Covered: listing the shipped plugins, the permission dialog, activation, a plugin view with a
// form, a confirmed write (database), a secret stored encrypted by the shell and read by the plugin
// through its grant, install of a third-party plugin from a folder, its sandbox, disable/uninstall,
// and that plugins come back after an app restart.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { answerFolderDialog, launch, newProfile, prepareRepository, quit, resultsDir, stamp, waitUntil } from './helpers.mjs'

async function openPlugin(page, name) {
  const back = page.locator('button[aria-label="Zurück zur Liste"]')
  if (await back.count()) await back.first().click()
  await page.locator('.plugin-item', { hasText: name }).first().click()
  await page.locator('.panel-header h2', { hasText: name }).first().waitFor()
}

async function enable(page) {
  await page.getByRole('button', { name: 'Aktivieren …' }).click()
  await page.locator('.modal .btn.primary').click()
  await page.locator('[data-view="plugins"] .badge', { hasText: 'aktiv' }).first().waitFor({ timeout: 30_000 })
}

test('plugin manager: permissions, views, secrets, third-party sandbox, restart', { timeout: 10 * 60_000 }, async () => {
  const id = stamp()
  const repo = prepareRepository()
  // a SQLite database inside the project
  const { DatabaseSync } = await import('node:sqlite')
  mkdirSync(path.join(repo, 'data'), { recursive: true })
  const sqlite = new DatabaseSync(path.join(repo, 'data', 'app.db'))
  sqlite.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes (body) VALUES ('erste Notiz');")
  sqlite.close()
  // a third-party plugin that tries to escape its sandbox
  const thirdParty = path.join(path.dirname(repo), `mac-e2e-plugin-${Date.now()}`)
  mkdirSync(thirdParty, { recursive: true })
  writeFileSync(
    path.join(thirdParty, 'multi-ai-coder-plugin.json'),
    JSON.stringify({ id: 'e2e-sneaky', name: 'E2E Sneaky', version: '1.0.0', description: 'Third-party test plugin', apiVersion: 1, main: 'index.cjs', permissions: {}, contributes: { views: [{ id: 'main', title: 'Sneaky' }] } }),
  )
  writeFileSync(
    path.join(thirdParty, 'index.cjs'),
    `module.exports = { activate(context) { context.views.register('main', async () => {
      const attempts = []
      try { require('node:child_process'); attempts.push('child_process: allowed') } catch (error) { attempts.push('child_process: blocked') }
      try { await fetch('https://example.com'); attempts.push('fetch: allowed') } catch (error) { attempts.push('fetch: blocked') }
      try { require('node:fs').readFileSync(${JSON.stringify(path.join(repo, 'data', 'app.db'))}); attempts.push('project file: allowed') } catch (error) { attempts.push('project file: blocked') }
      try { await context.http.fetch('https://example.com'); attempts.push('context.http: allowed') } catch (error) { attempts.push('context.http: ' + error.message) }
      return { type: 'stack', children: attempts.map((text) => ({ type: 'text', text })) }
    }) } }`,
  )

  const profile = newProfile()
  let session = await launch(profile)
  let { app, page, api } = session
  try {
    assert.equal((await api('PATCH', '/settings', { orchestrator: null })).status, 200)
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await answerFolderDialog(app, repo)
    await page.getByRole('button', { name: 'Ordner öffnen' }).first().click()
    await page.locator('[data-path="data"]').first().waitFor()

    // --- the shipped plugins are listed, disabled until permissions are granted ---
    await page.locator('nav.activity-bar button[aria-label="Erweiterungen"]').click()
    await waitUntil(async () => (await page.locator('.plugin-item').count()) === 7, 30_000, 'seven shipped plugins listed')

    // --- Database Tools: grant, view with form, read query, confirmed write ---
    await openPlugin(page, 'Database Tools')
    assert.match(await page.locator('.modal, [data-view="plugins"]').first().textContent(), /Dateien des geöffneten Projekts lesen und schreiben/)
    await enable(page)
    const view = page.locator('[data-plugin-view="database-tools:main"]')
    await view.locator('td', { hasText: 'notes' }).first().waitFor({ timeout: 30_000 })
    await view.locator('textarea').fill("INSERT INTO notes (body) VALUES ('aus dem Plugin')")
    await view.getByRole('button', { name: 'Ausführen', exact: true }).click()
    await view.getByText('erst nach Bestätigung').waitFor()
    await view.getByRole('button', { name: 'Schreibend ausführen' }).click()
    await page.locator('.modal .btn.primary').click()
    await view.locator('textarea').fill('SELECT body FROM notes ORDER BY id')
    await view.getByRole('button', { name: 'Ausführen', exact: true }).click()
    await view.locator('td', { hasText: 'aus dem Plugin' }).first().waitFor()

    // --- secret: stored encrypted by the shell, read by the plugin through its grant ---
    await page.locator('label:has-text("Verbindung") select').first().selectOption('postgres')
    await page.locator('input[type="password"]').fill('postgres://user:secret@127.0.0.1:1/db')
    await page.getByRole('button', { name: 'Speichern' }).click()
    await waitUntil(async () => (await page.locator('input[type="password"]').getAttribute('placeholder'))?.includes('gespeichert'), 10_000, 'secret stored')
    await page.locator('[data-plugin-view="database-tools:main"] button[title="Neu laden"]').click()
    await page.locator('[data-plugin-view="database-tools:main"]').getByText('Keine Verbindung zu 127.0.0.1:1').waitFor({ timeout: 20_000 })
    const secretsFile = readFileSync(path.join(profile, 'secrets.json'), 'utf8')
    assert.ok(secretsFile.includes('plugin:database-tools/postgresUrl'))
    assert.ok(!secretsFile.includes('secret@127.0.0.1'), 'the secret is stored encrypted')

    // --- API Tools: a request against the runtime itself is not needed; render the view ---
    await openPlugin(page, 'API Tools')
    await enable(page)
    await page.locator('[data-plugin-view="api-tools:main"]').getByText('Noch keine gespeicherten Anfragen').waitFor({ timeout: 20_000 })

    // --- third-party plugin from a folder: untrusted, sandboxed ---
    await page.locator('button[aria-label="Zurück zur Liste"]').click()
    await answerFolderDialog(app, thirdParty)
    await page.getByRole('button', { name: 'Aus Ordner' }).click()
    await page.locator('.panel-header h2', { hasText: 'E2E Sneaky' }).waitFor({ timeout: 30_000 })
    await page.getByText('Fremd-Plugin (Sandbox)').waitFor()
    await enable(page)
    const sneaky = page.locator('[data-plugin-view="e2e-sneaky:main"]')
    await sneaky.getByText('child_process: blocked').waitFor({ timeout: 20_000 })
    for (const text of ['fetch: blocked', 'project file: blocked', 'context.http: Permission denied: network example.com']) await sneaky.getByText(text).waitFor()
    await page.screenshot({ path: path.join(resultsDir, `${id}-plugins-sandbox.png`) })

    // --- restart: enabled plugins come back active ---
    await quit(app)
    session = await launch(profile)
    ;({ app, page, api } = session)
    await waitUntil(async () => {
      const list = (await api('GET', '/plugins')).data
      return ['database-tools', 'api-tools', 'e2e-sneaky'].every((pluginId) => list.find((plugin) => plugin.id === pluginId)?.status === 'active')
    }, 60_000, 'plugins active after restart')

    // --- disable and uninstall ---
    await page.locator('nav.activity-bar button[aria-label="Erweiterungen"]').click()
    await openPlugin(page, 'E2E Sneaky')
    await page.getByRole('button', { name: 'Deinstallieren' }).click()
    await page.locator('.modal .btn.danger').click()
    await waitUntil(async () => !(await api('GET', '/plugins')).data.some((plugin) => plugin.id === 'e2e-sneaky'), 20_000, 'uninstalled')
    await openPlugin(page, 'API Tools')
    await page.getByRole('button', { name: 'Deaktivieren' }).click()
    await waitUntil(async () => (await api('GET', '/plugins')).data.find((plugin) => plugin.id === 'api-tools')?.status === 'disabled', 20_000, 'disabled')
    assert.deepEqual(session.consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(app)
  }
})
