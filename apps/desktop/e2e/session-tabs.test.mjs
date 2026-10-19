// Session tabs in the header can be closed: the session stays (screen "Sitzungen") and comes back
// as a tab when it is opened again. Closed tabs stay closed after a restart.
//
//   pnpm --filter @multi-ai-coder/desktop build && node --test e2e/session-tabs.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { launch, newProfile, openProject, prepareRepository, quit, waitUntil } from './helpers.mjs'

const titles = async (page) => (await page.locator('[data-testid="session-tab"]').allTextContents()).map((text) => text.trim())

test('session tabs: close, the session stays, reopen, restart', { timeout: 5 * 60_000 }, async () => {
  const repo = prepareRepository()
  const profile = newProfile()
  let session = await launch(profile)
  try {
    await session.api('POST', '/onboarding/complete')
    await session.page.reload()
    await session.page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(session.app, session.page, repo)
    const projectId = (await session.api('GET', '/settings')).data.lastProjectId
    for (const title of ['Erste Sitzung', 'Zweite Sitzung', 'Dritte Sitzung']) await session.api('POST', `/projects/${projectId}/sessions`, { title })
    await session.page.reload()
    await session.page.waitForSelector('.ide', { timeout: 60_000 })
    await waitUntil(async () => (await titles(session.page)).length === 3, 30_000, 'three session tabs')

    // close a tab that is not active: it disappears from the header, the session still exists
    const tab = session.page.locator('[data-testid="session-tab"]', { hasText: 'Zweite Sitzung' })
    await tab.hover()
    await session.page.getByRole('button', { name: 'Zweite Sitzung schließen', exact: true }).click()
    await waitUntil(async () => !(await titles(session.page)).some((text) => text.includes('Zweite Sitzung')), 5000, 'tab closed')
    assert.ok((await session.api('GET', `/projects/${projectId}/sessions`)).data.some((entry) => entry.title === 'Zweite Sitzung'), 'the session itself stays')

    // close the active tab: another session becomes active
    await session.page.locator('[data-testid="session-tab"]', { hasText: 'Dritte Sitzung' }).click()
    await waitUntil(async () => (await session.page.locator('[data-testid="session-tab"].on').textContent())?.includes('Dritte Sitzung'), 10_000, 'third active')
    await session.page.getByRole('button', { name: 'Dritte Sitzung schließen', exact: true }).click()
    await waitUntil(async () => !(await titles(session.page)).some((text) => text.includes('Dritte Sitzung')), 5000, 'active tab closed')
    await waitUntil(async () => (await session.page.locator('[data-testid="session-tab"].on').textContent())?.includes('Erste Sitzung'), 10_000, 'next session active')

    // closed tabs stay closed after a restart
    await quit(session.app)
    session = await launch(profile)
    await session.page.waitForSelector('.ide', { timeout: 60_000 })
    await waitUntil(async () => (await titles(session.page)).length === 1, 30_000, 'one tab after restart')
    assert.match((await titles(session.page))[0], /Erste Sitzung/)
    assert.deepEqual(session.consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(session.app)
  }
})
