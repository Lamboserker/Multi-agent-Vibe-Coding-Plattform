import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { answerFolderDialog, launch, newProfile, prepareRepository, quit, resultsDir, stamp, waitUntil } from './helpers.mjs'

test('layout: drag, cancel, reset, collapse, maximize and restore persisted sizes', { timeout: 240_000 }, async () => {
  const repo = prepareRepository()
  const profile = newProfile()
  let session = await launch(profile)
  const variable = (name) => session.page.locator('.ide').evaluate((element, property) => parseFloat(getComputedStyle(element).getPropertyValue(property)), name)
  const drag = async (selector, dx, dy) => {
    const box = await session.page.locator(selector).boundingBox()
    assert.ok(box)
    await session.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await session.page.mouse.down()
    await session.page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 10 })
    await session.page.mouse.up()
    assert.equal(await session.page.locator('body.is-resizing').count(), 0)
  }
  try {
    await session.api('POST', '/onboarding/complete')
    await session.page.reload()
    await session.page.waitForSelector('.ide', { timeout: 60_000 })
    await answerFolderDialog(session.app, repo)
    await session.page.getByRole('button', { name: 'Ordner öffnen' }).first().click()
    await session.page.locator('[data-path="src"]').first().waitFor()
    await session.page.locator('[data-testid="terminal-host"]').first().waitFor()

    const side = await variable('--side-width')
    const chat = await variable('--chat-width')
    const bottom = await variable('--bottom-height')
    await drag('.splitter-side', 48, 0)
    assert.equal(await variable('--side-width'), side + 48)
    await drag('.splitter-chat', -36, 0)
    assert.equal(await variable('--chat-width'), chat + 36)
    await drag('.splitter-bottom', 0, -54)
    assert.equal(await variable('--bottom-height'), bottom + 54)
    const dimensions = await session.page.locator('.center').boundingBox()
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

    await session.page.keyboard.press('Control+b')
    assert.equal(await session.page.locator('.side-panel:visible').count(), 0)
    await session.page.keyboard.press('Control+b')
    assert.equal(await variable('--side-width'), beforeCancel)
    await session.page.keyboard.press('Control+Shift+b')
    assert.equal(await session.page.locator('.chat-panel:visible').count(), 0)
    await session.page.keyboard.press('Control+Shift+b')
    await session.page.keyboard.press('Control+j')
    assert.equal(await session.page.locator('.bottom-panel:visible').count(), 0)
    await session.page.keyboard.press('Control+j')

    await session.page.reload()
    await session.page.waitForSelector('.ide', { timeout: 60_000 })
    assert.equal(await variable('--side-width'), beforeCancel)
    assert.equal(await variable('--chat-width'), chat + 36)
    assert.equal(await variable('--bottom-height'), bottom + 54)

    await quit(session.app)
    session = await launch(profile)
    await session.page.waitForSelector('.ide', { timeout: 60_000 })
    assert.equal(await variable('--side-width'), beforeCancel)
    assert.equal(await variable('--chat-width'), chat + 36)
    assert.equal(await variable('--bottom-height'), bottom + 54)
    await session.page.locator('.splitter-side').dblclick()
    assert.equal(await variable('--side-width'), side)

    // Collapse through dragging and reopen with the previous usable size.
    await drag('.splitter-chat', chat + 50, 0)
    assert.equal(await session.page.locator('.chat-panel:visible').count(), 0)
    await session.page.getByRole('button', { name: 'Chat ein-/ausblenden', exact: true }).click()
    assert.equal(await variable('--chat-width'), chat + 36)

    // Switching to a wide settings view still reserves a usable editor at minimum window width.
    await session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 640))
    await session.page.locator('nav.activity-bar button[aria-label="Einstellungen"]').click()
    await waitUntil(async () => (await session.page.locator('.center').boundingBox()).width >= 320, 5000, 'editor minimum width')
    const centerBounds = await session.page.locator('.center').boundingBox()
    const panelBounds = await session.page.locator('.bottom-panel').boundingBox()
    assert.ok(panelBounds.width <= centerBounds.width + 1, 'terminal panel stays inside the editor column')
    const maximizeBounds = await session.page.getByRole('button', { name: 'Panel maximieren', exact: true }).boundingBox()
    assert.ok(maximizeBounds.x + maximizeBounds.width <= centerBounds.x + centerBounds.width + 1, 'maximize button stays accessible at minimum width')
    await session.page.getByRole('button', { name: 'Panel maximieren', exact: true }).click()
    await session.page.getByRole('button', { name: 'Panel wiederherstellen', exact: true }).click()
    assert.equal(await session.page.locator('body.is-resizing').count(), 0)
    await session.page.screenshot({ path: path.join(resultsDir, `${stamp()}-layout.png`) })
    assert.deepEqual(session.consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(session.app)
  }
})
