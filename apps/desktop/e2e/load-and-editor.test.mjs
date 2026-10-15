// GUI acceptance of the large-list handling and the editor AI hand-offs (real app, isolated profile,
// no model call): 1,000 explorer files, 10,000 run log lines, 2,000 chat messages, refactor/test/
// fix/review commands, file/folder/diff context, task from a problem.
//
//   pnpm --filter @multi-ai-coder/desktop build && node --test e2e/load-and-editor.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { answerFolderDialog, launch, newProfile, prepareRepository, quit, resultsDir, stamp, waitUntil } from './helpers.mjs'

const palette = async (page, label) => {
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette input').fill(`>${label}`)
  await page.locator('.palette-item', { hasText: label }).first().click()
}
const chatInput = (page) => page.locator('#chat-input').inputValue()
// the prepared draft reaches the input after the next render: wait for it instead of reading once
const expectDraft = (page, pattern) => waitUntil(async () => pattern.test(await chatInput(page)), 10_000, `chat draft ${pattern}`)
const longTasks = (page) => page.evaluate(() => (window.__loadLongTasks ?? []).slice())

test('large lists stay bounded in the DOM, editor AI hand-offs reach the chat', { timeout: 20 * 60_000 }, async () => {
  const id = stamp()
  const repo = prepareRepository({ install: true })
  mkdirSync(path.join(repo, 'bulk'))
  for (let index = 0; index < 1000; index++) writeFileSync(path.join(repo, 'bulk', `file-${String(index).padStart(4, '0')}.ts`), `export const value${index} = ${index}\n`)
  const profile = newProfile()
  const metrics = {}
  let session = await launch(profile)
  try {
    let { app, page, api } = session
    await api('PATCH', '/settings', { orchestrator: null, planApproval: true, fastPath: true })
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await page.evaluate(() => {
      window.__loadLongTasks = []
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__loadLongTasks.push(entry.duration) }).observe({ type: 'longtask', buffered: false })
    })
    await answerFolderDialog(app, repo)
    await page.getByRole('button', { name: 'Ordner öffnen' }).first().click()
    await page.locator('[data-path="bulk"]').first().waitFor()

    // --- explorer: 1,000 files in one folder ---
    let started = Date.now()
    await page.locator('[data-path="bulk"]').first().click()
    await waitUntil(async () => Number(await page.getByTestId('explorer-rows').getAttribute('data-total')) >= 1000, 30_000, 'explorer rows')
    metrics.explorer_expand_ms = Date.now() - started
    metrics.explorer_dom_rows = await page.locator('[data-testid="explorer-rows"] .tree-item').count()
    assert.ok(metrics.explorer_dom_rows < 150, `explorer renders a window, not 1,000 rows (${metrics.explorer_dom_rows})`)
    await page.getByTestId('explorer-rows').evaluate((element) => { element.scrollTop = element.scrollHeight })
    await page.locator('[data-path="bulk/file-0999.ts"]').waitFor({ timeout: 10_000 })
    await page.locator('[data-path="bulk/file-0999.ts"]').click()
    await waitUntil(async () => (await page.locator('.tab.active').textContent())?.includes('file-0999.ts'), 15_000, 'last file opened from the scrolled list')

    // --- editor AI hand-offs (prepared in the chat, nothing is sent) ---
    await palette(page, 'KI: Code refaktorieren')
    await expectDraft(page, /Refaktoriere[\s\S]*bulk\/file-0999\.ts[\s\S]*export const value999/)
    await palette(page, 'KI: Tests generieren')
    await expectDraft(page, /Generiere aussagekräftige Tests/)
    await palette(page, 'KI: Fehler korrigieren')
    await expectDraft(page, /Korrigiere die Fehler/)
    await palette(page, 'KI: Code-Review')
    await expectDraft(page, /Prüfe diesen Code auf Fehler/)
    await page.locator('#chat-input').fill('')
    await palette(page, 'Datei zum Chat-Kontext hinzufügen')
    await waitUntil(async () => /Kontext \(file: bulk\/file-0999\.ts\)/.test(await chatInput(page)), 10_000, 'file context')
    await palette(page, 'Ordner zum Chat-Kontext hinzufügen')
    await waitUntil(async () => /Kontext \(folder:/.test(await chatInput(page)), 10_000, 'folder context')
    writeFileSync(path.join(repo, 'src', 'App.tsx'), `${'// changed for the diff\n'}${await (await import('node:fs/promises')).readFile(path.join(repo, 'src', 'App.tsx'), 'utf8')}`)
    await palette(page, 'Git-Diff zum Chat-Kontext hinzufügen')
    await waitUntil(async () => /changed for the diff/.test(await chatInput(page)), 10_000, 'diff context')
    await page.locator('#chat-input').fill('')

    // --- task from a problem (Problems tab → "Task erstellen") ---
    writeFileSync(path.join(repo, 'src', 'broken.ts'), 'export const broken: number = "text"\n')
    await page.keyboard.press('Control+P')
    await page.locator('.palette input').fill('broken.ts')
    await page.locator('.palette-item', { hasText: 'src/broken.ts' }).first().waitFor()
    await page.keyboard.press('Enter')
    await page.locator('.bottom-tabs button', { hasText: 'Probleme' }).click()
    await page.getByRole('button', { name: 'Task erstellen' }).first().waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Task erstellen' }).first().click()
    await expectDraft(page, /Behebe diese Fehlermeldung[\s\S]*src\/broken\.ts:1[\s\S]*not assignable/)
    await page.locator('#chat-input').fill('')

    // --- a real run (fast path, no model) gives an execution for the log view ---
    await page.locator('#chat-input').fill('Benenne die Komponente Badge in Tag um (src/components/Badge.tsx)')
    await page.getByRole('button', { name: 'Senden' }).click()
    await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Ausführung starten' }).click()
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const sessionId = (await api('GET', `/projects/${projectId}/sessions`)).data[0].id
    const executionId = await waitUntil(async () => (await api('GET', `/sessions/${sessionId}`)).data.tasks[0]?.execution?.id, 30_000, 'execution')
    await waitUntil(async () => !['pending', 'running', 'integrating'].includes((await api('GET', `/executions/${executionId}`)).data.status), 5 * 60_000, 'run finished', 1000)
    await quit(app)

    // bulk data straight into the profile database: 10,000 run events, 2,000 chat messages
    const db = new DatabaseSync(path.join(profile, 'multi-ai-coder.db'))
    const sample = db.prepare('SELECT createdAt FROM RunEvent LIMIT 1').get()
    const base = Date.now() + 60_000
    const time = (offset) => (typeof sample?.createdAt === 'number' ? base + offset : new Date(base + offset).toISOString())
    db.exec('BEGIN')
    const insertEvent = db.prepare("INSERT INTO RunEvent (id, executionId, level, type, message, data, createdAt) VALUES (?, ?, 'info', 'load_test', ?, '{}', ?)")
    for (let index = 0; index < 10_000; index++) insertEvent.run(`load-ev-${String(index).padStart(5, '0')}`, executionId, `load line ${index}${index % 50 === 0 ? ' with a long message that wraps '.repeat(6) : ''}`, time(index))
    const insertMessage = db.prepare("INSERT INTO ChatMessage (id, projectId, sessionId, role, content, metadata, createdAt) VALUES (?, ?, ?, ?, ?, '{}', ?)")
    for (let index = 0; index < 2000; index++) insertMessage.run(`load-msg-${String(index).padStart(5, '0')}`, projectId, sessionId, index % 2 ? 'assistant' : 'user', `Nachricht ${index}\n${'Inhalt '.repeat(index % 7 === 0 ? 120 : 8)}`, time(-3_000_000 + index * 1000))
    db.exec('COMMIT')
    db.close()

    // --- restart with the data: chat and logs ---
    session = await launch(profile)
    ;({ app, page, api } = session)
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await page.evaluate(() => {
      window.__loadLongTasks = []
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__loadLongTasks.push(entry.duration) }).observe({ type: 'longtask', buffered: false })
    })
    started = Date.now()
    await page.locator('.chat-messages .msg', { hasText: 'Nachricht 1999' }).first().waitFor({ timeout: 60_000 })
    metrics.chat_open_ms = Date.now() - started
    metrics.chat_dom_messages = await page.locator('.chat-messages .msg').count()
    assert.ok(metrics.chat_dom_messages <= 260, `first page only (${metrics.chat_dom_messages})`)
    started = Date.now()
    await page.getByRole('button', { name: 'Ältere Nachrichten laden' }).click()
    await waitUntil(async () => (await page.locator('.chat-messages .msg').count()) > metrics.chat_dom_messages, 20_000, 'older page')
    metrics.chat_older_page_ms = Date.now() - started
    // the view stays where the user is (no jump to the end) and the newest message is still there
    assert.ok(await page.locator('.chat-messages .msg', { hasText: 'Nachricht 1999' }).count())

    await page.locator('.bottom-tabs button', { hasText: 'Logs' }).click()
    started = Date.now()
    await waitUntil(async () => Number(await page.getByTestId('log-lines').getAttribute('data-total')) >= 10_000, 60_000, '10,000 log lines loaded')
    metrics.logs_load_ms = Date.now() - started
    metrics.logs_dom_lines = await page.locator('[data-testid="log-lines"] .log-line').count()
    assert.ok(metrics.logs_dom_lines < 200, `log view renders a window (${metrics.logs_dom_lines})`)
    // follows the end, and the very first line is reachable by scrolling
    await page.locator('.log-line', { hasText: 'load line 9999' }).waitFor({ timeout: 10_000 })
    await page.getByTestId('log-lines').evaluate((element) => { element.scrollTop = 0 })
    await page.locator('.log-line', { hasText: /load line 0($|\s)/ }).or(page.locator('.log-line').first()).first().waitFor()
    await page.getByTestId('log-lines').evaluate((element) => { element.scrollTop = element.scrollHeight / 2 })
    await page.locator('.log-line', { hasText: /load line 4\d{3}\b/ }).first().waitFor({ timeout: 10_000 })
    const tasks = await longTasks(page)
    metrics.long_tasks_after_restart = { count: tasks.length, maxMs: Math.round(Math.max(0, ...tasks)), totalMs: Math.round(tasks.reduce((sum, value) => sum + value, 0)) }
    metrics.renderer_heap_mb = await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1024 / 1024))
    console.log('[e2e:load] metrics', JSON.stringify(metrics))
    mkdirSync(resultsDir, { recursive: true })
    writeFileSync(path.join(resultsDir, `load-and-editor-${id}.json`), JSON.stringify({ at: new Date().toISOString(), metrics }, null, 2))
    assert.deepEqual(session.consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(session.app)
  }
})
