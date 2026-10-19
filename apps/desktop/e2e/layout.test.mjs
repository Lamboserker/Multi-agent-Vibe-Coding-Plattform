import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { go, launch, newProfile, openProject, prepareRepository, quit, resultsDir, stamp, waitUntil } from './helpers.mjs'

test('layout: drag, cancel, reset, collapse, maximize, persisted sizes and the minimum window width', { timeout: 300_000 }, async () => {
  const repo = prepareRepository()
  const profile = newProfile()
  let session = await launch(profile)
  const variable = (name) => session.page.locator('.code-screen').evaluate((element, property) => parseFloat(getComputedStyle(element).getPropertyValue(property)), name)
  const drag = async (selector, dx, dy) => {
    const box = await session.page.locator(selector).boundingBox()
    assert.ok(box)
    await session.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await session.page.mouse.down()
    await session.page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 10 })
    await session.page.mouse.up()
    // the pointerup is handled asynchronously (the renderer may be busy right after a drag)
    await waitUntil(async () => (await session.page.locator('body.is-resizing').count()) === 0, 5000, 'drag finished')
  }
  try {
    await session.api('POST', '/onboarding/complete')
    await session.page.reload()
    await session.page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(session.app, session.page, repo)
    await go(session.page, 'Code')
    await session.page.locator('[data-path="src"]').first().waitFor()
    await session.page.locator('[data-testid="terminal-host"]').first().waitFor()

    const side = await variable('--side-width')
    const bottom = await variable('--bottom-height')
    await drag('.splitter-side', 48, 0)
    assert.equal(await variable('--side-width'), side + 48)
    await drag('.splitter-bottom', 0, -54)
    assert.equal(await variable('--bottom-height'), bottom + 54)
    const dimensions = await session.page.locator('.code-screen > .center').boundingBox()
    assert.ok(dimensions.width >= 320)

    // Lost pointer capture must undo the preview, without persisting or collapsing anything.
    const beforeCancel = await variable('--side-width')
    const handle = session.page.locator('.splitter-side')
    const box = await handle.boundingBox()
    await handle.evaluate((element) => {
      element.addEventListener('gotpointercapture', (event) => { element.dataset.pointerId = String(event.pointerId) }, { once: true })
    })
    await session.page.mouse.move(box.x + 2, box.y + 80)
    await session.page.mouse.down()
    await session.page.mouse.move(box.x + 62, box.y + 80)
    assert.equal(await variable('--side-width'), beforeCancel + 60)
    await handle.evaluate((element) => element.releasePointerCapture(Number(element.dataset.pointerId)))
    await session.page.mouse.move(box.x + 64, box.y + 80)
    await session.page.mouse.up()
    assert.equal(await variable('--side-width'), beforeCancel)
    assert.equal(await session.page.locator('body.is-resizing').count(), 0)

    // The spacer occupies most of the tab bar; double clicking it must maximize too.
    await session.page.locator('.bottom-tab-list > .spacer').dblclick()
    await session.page.locator('.center.bottom-max').waitFor()
    const maximized = await session.page.locator('.bottom-panel').boundingBox()
    assert.ok(maximized.height > bottom + 100)
    await session.page.getByRole('button', { name: 'Panel wiederherstellen', exact: true }).click()
    assert.equal(await variable('--bottom-height'), bottom + 54)

    // keyboard toggles: side column, agent column, bottom panel
    await session.page.keyboard.press('Control+b')
    assert.equal(await session.page.locator('.code-side:visible').count(), 0)
    await session.page.keyboard.press('Control+b')
    assert.equal(await variable('--side-width'), beforeCancel)
    await session.page.keyboard.press('Control+Shift+b')
    assert.equal(await session.page.locator('.agent-changes:visible').count(), 0)
    await session.page.keyboard.press('Control+Shift+b')
    await session.page.locator('.agent-changes').waitFor()
    await session.page.keyboard.press('Control+j')
    assert.equal(await session.page.locator('.bottom-panel:visible').count(), 0)
    await session.page.keyboard.press('Control+j')

    // the screen and all sizes survive a reload and an app restart
    await session.page.reload()
    await session.page.locator('.code-screen').waitFor({ timeout: 60_000 })
    assert.equal(await variable('--side-width'), beforeCancel)
    assert.equal(await variable('--bottom-height'), bottom + 54)
    await quit(session.app)
    session = await launch(profile)
    await session.page.locator('.code-screen').waitFor({ timeout: 60_000 })
    assert.equal(await variable('--side-width'), beforeCancel)
    assert.equal(await variable('--bottom-height'), bottom + 54)
    await session.page.locator('.splitter-side').dblclick()
    assert.equal(await variable('--side-width'), side)

    // Collapse through dragging and reopen with the previous usable size.
    await drag('.splitter-side', -(side + 60), 0)
    await waitUntil(async () => (await session.page.locator('.code-side:visible').count()) === 0, 5000, 'side column collapsed')
    await session.page.getByRole('button', { name: 'Seitenleiste einblenden', exact: true }).click()
    assert.equal(await variable('--side-width'), side)

    // Minimum window size: every screen stays usable, nothing overflows the header.
    await session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 640))
    await waitUntil(async () => (await session.page.evaluate(() => window.innerWidth)) <= 1024, 5000, 'window resized')
    await waitUntil(async () => (await session.page.locator('.code-screen > .center').boundingBox()).width >= 320, 5000, 'editor minimum width')
    const centerBounds = await session.page.locator('.code-screen > .center').boundingBox()
    const panelBounds = await session.page.locator('.bottom-panel').boundingBox()
    assert.ok(panelBounds.width <= centerBounds.width + 1, 'terminal panel stays inside the editor column')
    const maximizeBounds = await session.page.getByRole('button', { name: 'Panel maximieren', exact: true }).boundingBox()
    assert.ok(maximizeBounds.x + maximizeBounds.width <= centerBounds.x + centerBounds.width + 1, 'maximize button stays accessible at minimum width')
    await session.page.getByRole('button', { name: 'Panel maximieren', exact: true }).click()
    await session.page.getByRole('button', { name: 'Panel wiederherstellen', exact: true }).click()
    const overflow = () => session.page.evaluate(() => {
      const shell = document.querySelector('.app-shell')
      const header = document.querySelector('.app-header')
      return { shell: shell.scrollWidth - shell.clientWidth, header: header.scrollWidth - header.clientWidth, window: shell.getBoundingClientRect().right - window.innerWidth }
    })
    for (const screen of ['Leitstand', 'Freigabe', 'Sitzungen', 'Modelle', 'Kosten', 'Setup', 'Code']) {
      await go(session.page, screen)
      const value = await overflow()
      assert.ok(value.shell <= 1 && value.header <= 1 && value.window <= 1, `${screen} fits into 1024 px: ${JSON.stringify(value)}`)
    }
    await go(session.page, 'Leitstand')
    assert.ok((await session.page.locator('.ls-main').boundingBox()).width >= 400, 'Leitstand keeps room next to the chat')
    await session.page.screenshot({ path: path.join(resultsDir, `${stamp()}-layout-1024.png`) })
    assert.equal(await session.page.locator('body.is-resizing').count(), 0)
    assert.deepEqual(session.consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(session.app)
  }
})

/** p50/p95 of a list of numbers. */
export function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1), min: sorted[0] }
}
