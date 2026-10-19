// GUI test of the terminal additions: links (local dev servers open in the app), search (Ctrl+F), rename (double click), split view.
//
//   pnpm --filter @multi-ai-coder/desktop build
//   node --test e2e/terminal.test.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import path from 'node:path'
import { go, launch, newProfile, openProject, prepareRepository, quit, resultsDir, stamp, waitUntil } from './helpers.mjs'

test('terminal: links (Ctrl+click), search, rename, split', { timeout: 5 * 60_000 }, async () => {
  const repo = prepareRepository()
  const { app, page, api, consoleErrors } = await launch(newProfile())
  try {
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(app, page, repo)
    await go(page, 'Code')
    await page.locator('[data-path="src"]').first().waitFor()
    const terminal = page.locator('[data-testid="terminal-host"]').first()
    await terminal.waitFor({ timeout: 30_000 })
    await terminal.click()
    await page.keyboard.type('echo suchmarke4711')
    await page.keyboard.press('Enter')
    await waitUntil(async () => (await terminal.textContent()).includes('suchmarke4711'), 20_000, 'command output')

    // --- links: Ctrl+click on a local dev server opens it inside the app (code screen), other links in
    //     the browser (the main process call is intercepted) ---
    await app.evaluate(({ shell }) => {
      globalThis.__openedLinks = []
      shell.openExternal = async (url) => void globalThis.__openedLinks.push(url)
    })
    const opened = () => app.evaluate(() => globalThis.__openedLinks)
    // a real local server that forbids framing and needs its inline script (like many dev servers)
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" })
      response.end('<!doctype html><title>e2e</title><h1 id="msg">statisch</h1><a id="ext" href="https://example.com/extern">extern</a><script>document.getElementById("msg").textContent = "Vorschau läuft"</script>')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    try {
      const local = await printLink(page, terminal, `http://localhost:${port}/e2e-link`)
      await page.mouse.click(local.x, local.y)
      await page.waitForTimeout(500)
      assert.deepEqual(await opened(), [], 'a plain click does not open the link')
      assert.equal(await page.locator('[data-testid="preview-view"]').count(), 0)
      await ctrlClick(page, local)
      const preview = page.locator('[data-testid="preview-view"]')
      await preview.waitFor({ timeout: 10_000 })
      await page.locator('.tab.active', { hasText: `localhost:${port}` }).waitFor()
      assert.equal(await page.locator('.app-shell').getAttribute('data-screen'), 'code', 'shown in the code screen')
      assert.equal(await preview.locator('input[aria-label="Adresse der Vorschau"]').inputValue(), `http://localhost:${port}/e2e-link`, 'opened without the trailing period')
      // the page is a native view with its own process, placed exactly over the preview area
      const view = (script = 'document.getElementById("msg")?.textContent') => app.evaluate(async ({ BrowserWindow, webContents }, { port, script }) => {
        const window = BrowserWindow.getAllWindows()[0]
        const contents = webContents.getAllWebContents().find((entry) => entry.getURL().startsWith(`http://localhost:${port}`))
        if (!contents) return { exists: false }
        const child = window.contentView.children.find((entry) => entry.webContents === contents)
        return { exists: true, attached: Boolean(child), bounds: child?.getBounds(), ownProcess: contents.getOSProcessId() !== window.webContents.getOSProcessId(), value: await contents.executeJavaScript(script).catch(() => null) }
      }, { port, script })
      await waitUntil(async () => (await view()).value === 'Vorschau läuft', 15_000, 'page rendered in the preview')
      const shown = await view()
      assert.ok(shown.attached && shown.ownProcess, JSON.stringify(shown))
      const area = await page.locator('[data-testid="preview-area"]').boundingBox()
      assert.ok(Math.abs(shown.bounds.x - area.x) <= 2 && Math.abs(shown.bounds.y - area.y) <= 2 && Math.abs(shown.bounds.width - area.width) <= 2, JSON.stringify({ view: shown.bounds, area }))
      assert.deepEqual(await opened(), [], 'nothing was opened in the browser')

      // a dialog over the preview: the view steps aside (a still image is shown), and comes back
      await page.keyboard.press('Control+K')
      await page.locator('.palette').waitFor()
      await waitUntil(async () => !(await view()).attached, 5000, 'view hidden under the palette')
      await page.keyboard.press('Escape')
      await waitUntil(async () => (await view()).attached, 5000, 'view back after the palette')
      // another tab: hidden; back to the preview tab: shown again, the page kept its state
      await view('document.getElementById("msg").dataset.mark = "kept"')
      await go(page, 'Leitstand')
      await waitUntil(async () => !(await view()).attached, 5000, 'view hidden on another screen')
      await go(page, 'Code')
      await waitUntil(async () => (await view()).attached, 5000, 'view shown again')
      assert.equal((await view('document.getElementById("msg").dataset.mark')).value, 'kept')

      // a link to another host inside the preview goes to the browser, the preview stays
      await view('document.getElementById("ext").click()')
      await waitUntil(async () => (await opened()).length === 1, 5000, 'external link from the preview')
      assert.deepEqual(await opened(), ['https://example.com/extern'])
      assert.equal((await view()).value, 'Vorschau läuft')
      // the tab comes back after a reload of the app's page
      await page.reload()
      await page.locator('.tab', { hasText: `localhost:${port}` }).waitFor({ timeout: 60_000 })
      await waitUntil(async () => (await view()).attached, 15_000, 'preview shown after reload')
    } finally {
      server.close()
    }

    // other web links still open in the browser
    await go(page, 'Code')
    await terminal.click()
    const external = await printLink(page, terminal, 'https://example.org/e2e-docs')
    await ctrlClick(page, external)
    await waitUntil(async () => (await opened()).length === 2, 5000, 'external link opened')
    assert.equal((await opened())[1], 'https://example.org/e2e-docs')

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

/** Prints a URL (followed by a period) in the terminal and returns the screen position of the link. */
async function printLink(page, terminal, url) {
  const marker = url.replace(/^https?:\/\//, '')
  await terminal.click()
  await page.keyboard.type(`echo Link: ${url}.`)
  await page.keyboard.press('Enter')
  await waitUntil(async () => ((await terminal.textContent()).split(marker).length - 1) >= 2, 20_000, 'link printed')
  // screen position of the URL in the last row that shows it (the command output, not the typed command)
  const point = await page.evaluate((text) => {
    const rows = [...document.querySelectorAll('[data-testid="terminal-host"] .xterm-rows > div')].filter((row) => row.textContent.includes(text))
    const row = rows.at(-1)
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    let offset = row.textContent.indexOf(text) + 4
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (offset < node.textContent.length) {
        const range = document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + 1)
        const box = range.getBoundingClientRect()
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      }
      offset -= node.textContent.length
    }
    return null
  }, marker)
  assert.ok(point, 'link position found')
  // output after the link (the next prompt) resets xterm's hover state: move away and back until the hint shows
  await waitUntil(async () => {
    await page.mouse.move(point.x, point.y - 60)
    for (let step = 0; step < 4; step += 1) await page.mouse.move(point.x + step, point.y)
    await page.waitForTimeout(150)
    return (await terminal.getAttribute('title')) === 'Link öffnen (Strg + Klick)'
  }, 10_000, 'link hint on hover', 300).catch(async (error) => {
    // which row was targeted and what the terminal shows (diagnostics only)
    const rows = await page.evaluate((text) => [...document.querySelectorAll('[data-testid="terminal-host"] .xterm-rows > div')].map((row) => row.textContent).filter((row) => row.includes(text)), marker)
    console.log('[e2e] link rows', JSON.stringify({ point, rows, title: await terminal.getAttribute('title') }))
    await page.screenshot({ path: path.join(resultsDir, `${stamp()}-terminal-link.png`) })
    throw error
  })
  return point
}

async function ctrlClick(page, point) {
  await page.keyboard.down('Control')
  await page.mouse.click(point.x, point.y)
  await page.keyboard.up('Control')
}
