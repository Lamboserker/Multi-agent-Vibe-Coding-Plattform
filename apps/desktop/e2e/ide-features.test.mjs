// GUI test of the IDE features (real app, runtime, the project's own TypeScript; no model call).
//
//   pnpm --filter @multi-ai-coder/desktop build
//   node --test e2e/ide-features.test.mjs
//
// Covered: quick open, command palette, go to line, workspace search + replace (closed file on disk),
// go to definition across files, rename across files (open + closed files), live diagnostics with
// unsaved content, problems panel + project check (tsc), git gutter, save + local history, format
// (Prettier missing → clear message), global shortcuts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { answerFolderDialog, launch, newProfile, prepareRepository, quit, resultsDir, stamp, waitUntil } from './helpers.mjs'

const activeTab = (page) => page.locator('.tab.active').textContent()

async function palette(page, text, choose) {
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette input').fill(`>${text}`)
  await page.locator('.palette-item', { hasText: choose ?? text }).first().click()
}

async function gotoLine(page, line, column) {
  await page.keyboard.press('Control+G')
  await page.locator('.palette input').fill(`:${line}:${column}`)
  await page.keyboard.press('Enter')
}

test('IDE features: navigation, search/replace, language features, problems, history', { timeout: 15 * 60_000 }, async () => {
  const id = stamp()
  const repo = prepareRepository({ install: true })
  const profile = newProfile()
  const { app, page, api, consoleErrors } = await launch(profile)
  try {
    assert.equal((await api('PATCH', '/settings', { orchestrator: null })).status, 200)
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await answerFolderDialog(app, repo)
    await page.getByRole('button', { name: 'Ordner öffnen' }).first().click()
    await page.locator('[data-path="src"]').first().waitFor()

    // --- quick open (Ctrl+P) ---
    await page.keyboard.press('Control+P')
    await page.locator('.palette input').fill('apptsx')
    await page.locator('.palette-item', { hasText: 'src/App.tsx' }).first().waitFor()
    await page.keyboard.press('Enter')
    await waitUntil(async () => (await activeTab(page))?.includes('App.tsx'), 15_000, 'App.tsx opened via quick open')

    // --- command palette (Ctrl+Shift+P) ---
    await palette(page, 'Ansicht: Git')
    await page.locator('nav.activity-bar button[aria-label="Git"].active').waitFor()

    // --- go to line + go to definition (F12) across files ---
    await page.locator('[data-testid="code-editor"] .view-lines').click()
    await gotoLine(page, 6, 8) // "<Badge label" → on "Badge"
    await page.keyboard.press('F12')
    await waitUntil(async () => (await activeTab(page))?.includes('Badge.tsx'), 20_000, 'definition opened Badge.tsx')

    // --- rename (F2) across files: App.tsx is closed first (written on disk), Badge.test.tsx is closed too ---
    await page.locator('.tab', { hasText: 'App.tsx' }).getByRole('button').click()
    await page.locator('[data-testid="code-editor"] .view-lines').click()
    await gotoLine(page, 6, 17) // "export function Badge"
    await page.keyboard.press('F2')
    await page.locator('.rename-box input').waitFor({ timeout: 10_000 })
    await page.locator('.rename-box input').fill('Tag')
    await page.locator('.rename-box input').press('Enter')
    await waitUntil(() => readFileSync(path.join(repo, 'src/App.tsx'), 'utf8').includes('<Tag label'), 20_000, 'closed file renamed on disk')
    assert.match(readFileSync(path.join(repo, 'src/components/Badge.test.tsx'), 'utf8'), /Tag/)
    // Monaco renders spaces as non-breaking spaces
    const editorText = async () => (await page.locator('.editor-group:not(.secondary) [data-testid="code-editor"] .view-lines').textContent()).replace(/\u00a0/g, ' ')
    await waitUntil(async () => (await editorText()).includes('function Tag'), 10_000, 'open file renamed in the editor')

    // --- live diagnostics with unsaved content + problems indicator ---
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    await page.keyboard.type("export const broken: number = 'x'")
    await page.locator('[data-testid="code-editor"] .squiggly-error').first().waitFor({ timeout: 20_000 })
    await waitUntil(async () => (await page.locator('.status-bar').textContent()).includes('⊗ 1'), 10_000, 'status bar counts the error')

    // --- git gutter (file differs from HEAD) ---
    await page.locator('[data-testid="code-editor"] .git-gutter-modified, [data-testid="code-editor"] .git-gutter-added').first().waitFor({ timeout: 10_000 })

    // --- save → local history keeps the previous version ---
    await page.keyboard.press('Control+S')
    await waitUntil(async () => (await page.locator('.tab.active .dirty').count()) === 0, 10_000, 'saved')
    await palette(page, 'Lokale Historie')
    await page.locator('.modal .palette-item').first().waitFor({ timeout: 10_000 })
    await page.locator('.modal .palette-item').first().click()
    await page.locator('[data-testid="ai-diff"]').waitFor()
    await page.locator('.modal').getByRole('button', { name: 'Schließen', exact: true }).click()

    // --- project check with the project's tsc (finds the saved error) ---
    await palette(page, 'Projekt prüfen')
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const problems = await waitUntil(async () => {
      const result = (await api('GET', `/projects/${projectId}/ide/problems`)).data
      return result && !result.running && result.tools.length ? result : null
    }, 120_000, 'project check finished')
    assert.ok(problems.tools.includes('tsc'))
    assert.ok(problems.problems.some((problem) => problem.source === 'tsc' && problem.code === 'TS2322' && problem.path === 'src/components/Badge.tsx'), JSON.stringify(problems.problems))
    await page.locator('[data-testid="problems-view"]').getByText(/Letzte Prüfung.*tsc/).waitFor({ timeout: 10_000 })

    // --- format: the fixture has no Prettier → clear message, nothing changes ---
    await palette(page, 'Dokument formatieren')
    await page.getByText('Prettier ist im Projekt nicht installiert').first().waitFor({ timeout: 10_000 })

    // --- workspace search + replace (closed file written on disk) ---
    await page.keyboard.press('Control+Shift+F')
    await page.locator('[data-view="search"] input[aria-label="Suchbegriff"]').fill('beta')
    await page.locator('[data-testid="search-results"] .search-file', { hasText: 'src/App.tsx' }).waitFor({ timeout: 15_000 })
    await page.locator('[data-view="search"] button[title="Ersetzen ein-/ausblenden"]').click()
    await page.locator('[data-view="search"] input[aria-label="Ersetzen durch"]').fill('gamma')
    await page.locator('[data-view="search"]').getByRole('button', { name: 'Alle ersetzen' }).click()
    await page.locator('.modal .btn.danger').click()
    await waitUntil(() => readFileSync(path.join(repo, 'src/App.tsx'), 'utf8').includes('label="gamma"'), 15_000, 'replaced on disk')

    // --- split editor: the same document in two editors, edits appear in both ---
    await page.locator('.tab', { hasText: 'Badge.tsx' }).first().click()
    await palette(page, 'Editor teilen')
    const splitEditor = page.locator('[data-testid="split-editor"] .view-lines')
    await splitEditor.waitFor({ timeout: 10_000 })
    await splitEditor.click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.type('// split edit\n')
    await waitUntil(async () => (await editorText()).includes('// split edit'), 10_000, 'edit from the split editor visible in the main editor')
    await page.keyboard.press('Control+Z')
    await palette(page, 'Editor teilen')
    await page.locator('[data-testid="split-editor"]').waitFor({ state: 'detached', timeout: 10_000 })

    // --- shortcuts overview ---
    await palette(page, 'Tastenkürzel anzeigen')
    await page.locator('.modal').getByText('Strg+Umschalt+P').waitFor()
    await page.screenshot({ path: path.join(resultsDir, `${id}-ide-shortcuts.png`) })
    await page.locator('.modal').getByRole('button', { name: 'Schließen', exact: true }).click()

    assert.deepEqual(consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await page.screenshot({ path: path.join(resultsDir, `${id}-ide-final.png`) }).catch(() => undefined)
    await quit(app)
  }
})
