// Live test: "KI: Auswahl bearbeiten" with a real local model (no premium call), through the GUI.
//
//   MAC_E2E_LIVE=1 MAC_E2E_MODEL=qwen2.5-coder:7b MAC_E2E_OLLAMA_URL=http://127.0.0.1:11435 \
//   MAC_E2E_OLLAMA_MODELS=D:\ollama-models node --test e2e/ai-edit.live.test.mjs
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { answerFolderDialog, launch, newProfile, prepareRepository, quit, resultsDir, stamp, waitUntil } from './helpers.mjs'

const live = process.env.MAC_E2E_LIVE === '1'
const model = process.env.MAC_E2E_MODEL ?? 'qwen2.5-coder:7b'

test('AI edit of a selection with a local model, reviewed as a diff, applied undoably', { skip: !live && 'set MAC_E2E_LIVE=1', timeout: 15 * 60_000 }, async () => {
  const id = stamp()
  const repo = prepareRepository()
  const { app, page, api } = await launch(newProfile())
  try {
    await api('PATCH', '/settings', { orchestrator: null, ollamaBaseUrl: process.env.MAC_E2E_OLLAMA_URL ?? 'http://127.0.0.1:11434', ollamaModelsDir: process.env.MAC_E2E_OLLAMA_MODELS ?? null })
    if (!(await api('GET', '/local-models/ollama')).data.reachable) await api('POST', '/local-models/ollama/start')
    await waitUntil(async () => (await api('GET', '/local-models/ollama')).data.reachable, 60_000, 'ollama reachable')
    await api('PUT', '/local-models/roles', { fast: model, balanced: model, advanced: model })
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await answerFolderDialog(app, repo)
    await page.getByRole('button', { name: 'Ordner öffnen' }).first().click()
    await page.locator('[data-path="src"]').first().click()
    await page.locator('[data-path="src/components"]').first().click()
    await page.locator('[data-path="src/components/Badge.tsx"]').click()
    await page.locator('[data-testid="code-editor"] .view-lines').click()
    const before = (await api('GET', '/usage')).data
    // select the whole Badge function (lines 6-8)
    await page.keyboard.press('Control+G')
    await page.locator('.palette input').fill(':6:1')
    await page.keyboard.press('Enter')
    for (let line = 0; line < 3; line += 1) await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Control+I')
    await page.locator('.modal input').fill('Füge die optionale Prop `title?: string` hinzu und gib sie als title-Attribut des span aus.')
    await page.locator('.modal').getByRole('button', { name: 'Ausführen' }).click()
    await page.locator('[data-testid="ai-diff"]').waitFor({ timeout: 10 * 60_000 })
    await page.screenshot({ path: path.join(resultsDir, `${id}-ai-edit-diff.png`) })
    await page.locator('.modal').getByRole('button', { name: 'Übernehmen' }).click()
    const text = async () => (await page.locator('[data-testid="code-editor"] .view-lines').textContent()).replace(/\u00a0/g, ' ')
    await waitUntil(async () => (await text()).includes('title'), 10_000, 'edit applied')
    assert.equal(await page.locator('.tab.active .dirty').count(), 1, 'applied as an unsaved change')
    // one undo restores the original
    await page.keyboard.press('Control+Z')
    await waitUntil(async () => !(await text()).includes('title='), 10_000, 'undo restores')
    const after = (await api('GET', '/usage')).data
    assert.equal(after.premium?.calls ?? 0, before.premium?.calls ?? 0, 'no premium call')
  } finally {
    await quit(app)
  }
})
