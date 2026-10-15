// GUI test of the terminal additions: search (Ctrl+F), rename (double click), split view.
//
//   pnpm --filter @multi-ai-coder/desktop build
//   node --test e2e/terminal.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerFolderDialog, launch, newProfile, prepareRepository, quit, waitUntil } from './helpers.mjs'

test('terminal: search, rename, split', { timeout: 5 * 60_000 }, async () => {
  const repo = prepareRepository()
  const { app, page, api, consoleErrors } = await launch(newProfile())
  try {
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await answerFolderDialog(app, repo)
    await page.getByRole('button', { name: 'Ordner öffnen' }).first().click()
    await page.locator('[data-path="src"]').first().waitFor()
    const terminal = page.locator('[data-testid="terminal-host"]').first()
    await terminal.waitFor({ timeout: 30_000 })
    await terminal.click()
    await page.keyboard.type('echo suchmarke4711')
    await page.keyboard.press('Enter')
    await waitUntil(async () => (await terminal.textContent()).includes('suchmarke4711'), 20_000, 'command output')

    // --- search ---
    await terminal.click()
    await page.keyboard.press('Control+F')
    await page.locator('input[aria-label="Im Terminal suchen"]').fill('suchmarke4711')
    await page.waitForTimeout(300)
    assert.equal(await page.locator('.terminal-search').getByText('nicht gefunden').count(), 0)
    await page.locator('input[aria-label="Im Terminal suchen"]').fill('gibtesnichtxyz')
    await page.locator('.terminal-search').getByText('nicht gefunden').waitFor()
    await page.locator('input[aria-label="Im Terminal suchen"]').press('Escape')

    // --- rename ---
    const tab = page.locator('.bottom-panel .badge', { hasText: /mac-e2e-repo|Terminal|pwsh|powershell/i }).first()
    await tab.dblclick()
    await page.locator('input[aria-label="Terminal umbenennen"]').fill('Server')
    await page.locator('input[aria-label="Terminal umbenennen"]').press('Enter')
    await waitUntil(async () => (await page.evaluate(() => window.mac.terminal.list())).some((entry) => entry.title === 'Server'), 10_000, 'renamed')

    // --- split ---
    await page.locator('button[aria-label="Terminal teilen"]').click()
    await waitUntil(async () => (await page.locator('[data-testid="terminals"] .terminal-wrapper:visible').count()) === 2, 20_000, 'two terminals side by side')
    await page.locator('button[aria-label="Terminal teilen"]').click()
    await waitUntil(async () => (await page.locator('[data-testid="terminals"] .terminal-wrapper:visible').count()) === 1, 10_000, 'split closed')
    assert.deepEqual(consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(app)
  }
})
