// GUI regression test for session and state persistence (real Electron app, real runtime, real git).
// No model is called: without an orchestrator the deterministic fallback planner creates the plan.
//
//   pnpm --filter @multi-ai-coder/desktop build
//   node --test e2e/session-persistence.test.mjs
//
// Covered: navigation (32 view switches), unsaved editor content, chat drafts, session history,
// a setting typed without blur, renderer reload, renderer crash, full app restart, terminal history.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { launchWithCdp } from './cdp.mjs'
import { CHAT_MESSAGES, codeView, go, launch, newProfile, openProject, percentiles, prepareRepository, quit, resultsDir, setupSection, stamp, waitUntil } from './helpers.mjs'

const VIEWS = ['Leitstand', 'Code', 'Freigabe', 'Sitzungen', 'Modelle', 'Kosten', 'Setup', 'Code']
const UNSAVED = '// unsaved edit from the persistence test'
const COMPOSER_DRAFT = 'Entwurf, der nicht gesendet wurde'

/** Reads the visible UI state in the page (used through Playwright and through raw CDP). */
const READ_UI = `(() => {
  const lines = document.querySelector('[data-testid="code-editor"] .view-lines')
  return {
    ide: Boolean(document.querySelector('.ide')),
    activeTab: document.querySelector('.tab.active')?.textContent ?? null,
    tabDirty: document.querySelectorAll('.tab.active .dirty').length,
    // Monaco renders spaces as non-breaking spaces
    editor: (lines?.textContent ?? '').replace(/\\u00a0/g, ' '),
    chatMessages: document.querySelectorAll(${JSON.stringify(CHAT_MESSAGES)}).length,
    composer: document.querySelector('#chat-input')?.value ?? null,
    sessionTitle: document.querySelector('[data-testid="session-title"]')?.textContent ?? null,
  }
})()`

/** Window and editor state when something was not restored (diagnostics only). */
const DEBUG_UI = `(() => {
  const editor = document.querySelector('[data-testid="code-editor"]')
  const box = editor?.getBoundingClientRect()
  return { visibility: document.visibilityState, focus: document.hasFocus(), screen: document.querySelector('.app-shell')?.dataset.screen, editorBox: box ? [Math.round(box.width), Math.round(box.height)] : null, monaco: Boolean(editor?.querySelector('.monaco-editor')), lines: editor?.querySelectorAll('.view-line').length ?? 0 }
})()`

async function snapshot(page, api) {
  const ui = await page.evaluate(READ_UI)
  const settings = (await api('GET', '/settings')).data
  return { ...ui, maxTasks: settings.maxTasks }
}

async function waitRestored(read, before, label, debug) {
  let last
  return waitUntil(async () => {
    const ui = await read()
    last = ui
    return ui.ide && ui.editor.includes('unsaved edit') && ui.chatMessages >= before.chatMessages && ui.composer === before.composer ? ui : null
  }, 60_000, label, 300).catch((error) => {
    // the state that was shown instead (helps to see which part was not restored)
    console.log('[e2e] not restored:', JSON.stringify({ ...last, editor: last?.editor?.slice(-80) }))
    return Promise.resolve(debug?.()).then((state) => {
      if (state) console.log('[e2e] window/editor:', JSON.stringify(state))
      throw error
    })
  })
}

test('sessions, drafts and settings survive navigation, reload, renderer crash and app restart', { timeout: 15 * 60_000 }, async () => {
  const id = stamp()
  const report = { startedAt: new Date().toISOString(), steps: [], navigationMs: [] }
  const step = (name, detail) => {
    report.steps.push({ name, at: new Date().toISOString(), ...detail })
    console.log(`[e2e] ${name}`, detail ? JSON.stringify(detail).slice(0, 400) : '')
  }
  const repo = prepareRepository()
  const profile = newProfile()
  let session = await launch(profile)
  let { app, page, api } = session
  try {
    // --- setup: no orchestrator (no premium call), plan approval on ---
    assert.equal((await api('PATCH', '/settings', { orchestrator: null, planApproval: true, approvalMode: 'manual' })).status, 200)
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })

    await openProject(app, page, repo)
    await go(page, 'Code')
    await page.locator('[data-path="src"]').first().click()
    await page.locator('[data-path="src/App.tsx"]').click()
    await page.locator('[data-testid="code-editor"] .view-lines').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    await page.keyboard.type(UNSAVED)
    await waitUntil(async () => (await page.locator('.tab.active .dirty').count()) === 1, 5000, 'dirty tab')
    step('project opened, unsaved edit typed')

    // a session with a real (deterministic) plan
    await go(page, 'Leitstand')
    await page.locator('#chat-input').fill('Ergänze in src/App.tsx eine Überschrift')
    await page.getByRole('button', { name: 'Senden' }).click()
    await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 120_000 })
    await page.locator('#chat-input').fill(COMPOSER_DRAFT)
    step('session planned')

    // a setting typed and immediately left (no blur, no Enter)
    await setupSection(page, 'Einstellungen')
    await page.locator('label:has-text("Max. Teilaufgaben") input').fill('5')
    await codeView(page, 'Explorer')
    await waitUntil(async () => (await api('GET', '/settings')).data.maxTasks === 5, 5000, 'setting persisted after navigating away')
    step('setting persisted without blur')

    // the code screen was just shown again: Monaco lays out on the next frames (the snapshot reads rendered lines)
    await waitUntil(async () => (await page.evaluate(READ_UI)).editor.includes(UNSAVED), 10_000, 'editor laid out again', 100).catch(async (error) => {
      console.log('[e2e] window/editor:', JSON.stringify(await page.evaluate(DEBUG_UI)))
      throw error
    })
    const before = await snapshot(page, api)
    assert.ok(before.editor.includes('unsaved edit from the persistence test'), before.editor)
    assert.equal(before.composer, COMPOSER_DRAFT)
    assert.equal(before.tabDirty, 1)
    assert.ok(before.chatMessages >= 2, 'user message and plan are shown')

    // --- 32 view switches; every switch must keep everything ---
    for (let index = 0; index < 32; index += 1) {
      const view = VIEWS[index % VIEWS.length]
      const started = Date.now()
      await go(page, view)
      report.navigationMs.push(Date.now() - started)
    }
    await codeView(page, 'Explorer')
    assert.deepEqual(await snapshot(page, api), before, 'navigation must not change any state')
    step('32 navigations', { navigation: percentiles(report.navigationMs) })

    // --- renderer reload ---
    const reloadStarted = Date.now()
    await page.reload()
    await waitRestored(() => page.evaluate(READ_UI), before, 'state restored after reload')
    report.reloadRestoreMs = Date.now() - reloadStarted
    assert.deepEqual(await snapshot(page, api), before, 'reload must restore the same state')
    step('renderer reload restored everything', { ms: report.reloadRestoreMs })
    await quit(app)

    // --- renderer crash (raw CDP: Playwright cannot follow a crashed target) ---
    const cdp = await launchWithCdp(profile)
    try {
      await waitRestored(() => cdp.evaluate(READ_UI), before, 'state restored after restart (cdp)', () => cdp.evaluate(DEBUG_UI))
      await cdp.crashRenderer()
      const crashStarted = Date.now()
      const afterCrash = await waitRestored(() => cdp.evaluate(READ_UI), before, 'state restored after renderer crash', () => cdp.evaluate(DEBUG_UI))
      report.crashRestoreMs = Date.now() - crashStarted
      assert.equal(afterCrash.tabDirty, 1)
      assert.equal(afterCrash.activeTab, before.activeTab)
      step('renderer crash recovered', { ms: report.crashRestoreMs })
      // changed outside the settings view immediately before quitting
      await cdp.evaluate("window.mac.api('PATCH', '/settings', { costMode: 'quality' }).then((response) => response.status)")
    } finally {
      await cdp.close()
    }

    // --- full app restart; a setting changed right before quitting must win over the cached shell ---
    const restartStarted = Date.now()
    session = await launch(profile)
    ;({ app, page, api } = session)
    await waitRestored(() => page.evaluate(READ_UI), before, 'state restored after app restart')
    report.restartRestoreMs = Date.now() - restartStarted
    assert.deepEqual(await snapshot(page, api), before, 'an app restart must restore the same state')
    await waitUntil(async () => (await page.locator('.status-bar').textContent()).includes('Modus: quality'), 10_000, 'current (not cached) settings after restart')
    const terminals = await page.evaluate(() => window.mac.terminal.list())
    assert.ok(terminals.some((terminal) => terminal.status === 'restored'), 'terminal history of the previous app session is available')
    step('app restart restored everything', { ms: report.restartRestoreMs, terminals: terminals.map((terminal) => terminal.status) })

    await page.screenshot({ path: path.join(resultsDir, `${id}-persistence-restart.png`) })
    report.ok = true
  } finally {
    report.consoleErrors = session.consoleErrors
    report.finishedAt = new Date().toISOString()
    writeFileSync(path.join(resultsDir, `${id}-persistence-report.json`), JSON.stringify(report, null, 2))
    await quit(app)
  }
})
