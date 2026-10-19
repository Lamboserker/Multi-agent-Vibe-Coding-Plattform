// Default approval mode: a validated result is committed onto the checked-out branch (main) without
// asking – also when main got newer commits during the run (merge commit). Fast path, no model.
//
//   pnpm --filter @multi-ai-coder/desktop build && node --test e2e/auto-commit.test.mjs
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { launch, newProfile, openProject, prepareRepository, quit, waitUntil } from './helpers.mjs'

const git = (repo, command) => execSync(`git ${command}`, { cwd: repo, encoding: 'utf8' }).trim()

test('results land on main automatically, also after newer commits on main', { timeout: 10 * 60_000 }, async () => {
  const repo = prepareRepository({ install: true })
  const { app, page, api, consoleErrors } = await launch(newProfile())
  try {
    assert.equal((await api('GET', '/settings')).data.approvalMode, 'auto_commit', 'committing to main is the default')
    await api('PATCH', '/settings', { orchestrator: null, planApproval: true, fastPath: true })
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(app, page, repo)
    const baseHead = git(repo, 'rev-parse HEAD')

    await page.locator('#chat-input').fill('Benenne die Komponente Badge in Tag um (src/components/Badge.tsx)')
    await page.getByRole('button', { name: 'Senden' }).click()
    await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Ausführung starten' }).click()
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const sessionId = (await api('GET', `/projects/${projectId}/sessions`)).data[0].id
    const executionId = await waitUntil(async () => (await api('GET', `/sessions/${sessionId}`)).data.tasks[0]?.execution?.id, 30_000, 'execution')

    // once the run has fixed its base, main gets a newer commit (another file) and an uncommitted change (another file)
    const baseCommit = await waitUntil(async () => (await api('GET', `/executions/${executionId}`)).data.baseCommit, 60_000, 'run base commit', 100)
    assert.equal(baseCommit, baseHead)
    writeFileSync(path.join(repo, 'NOTES.md'), 'während des Laufs\n')
    git(repo, 'add NOTES.md')
    git(repo, '-c user.name=t -c user.email=t@t commit -q -m "Notizen während des Laufs"')
    const readme = readFileSync(path.join(repo, 'README.md'), 'utf8')
    writeFileSync(path.join(repo, 'README.md'), `${readme}\nlokal, nicht committet\n`)

    // no click: the run ends applied, committed on main
    await waitUntil(async () => (await api('GET', `/executions/${executionId}`)).data.status === 'applied', 5 * 60_000, 'committed automatically', 1000).catch(async (error) => {
      console.log('[e2e] events', JSON.stringify((await api('GET', `/executions/${executionId}/events`)).data.map((event) => `${event.type}: ${event.message}`).slice(-15), null, 1))
      throw error
    })
    await waitUntil(async () => (await page.locator('[data-testid="workflow"]').getAttribute('data-state')) === 'done', 30_000, 'leitstand done')
    assert.equal(git(repo, 'rev-parse --abbrev-ref HEAD'), 'main')
    assert.match(git(repo, 'log -1 --format=%s'), /^Multi-AI Coder: /, 'main moved during the run, so the result is merged on top')
    assert.equal(git(repo, 'log -1 --format=%P').split(' ').length, 2)
    assert.match(git(repo, 'show HEAD:src/components/Badge.tsx'), /function Tag/)
    assert.match(git(repo, 'show HEAD:NOTES.md'), /während des Laufs/, 'the newer commit on main is kept')
    assert.ok(git(repo, `rev-list ${baseHead}..HEAD`).split('\n').length >= 2)
    assert.match(readFileSync(path.join(repo, 'README.md'), 'utf8'), /lokal, nicht committet/, 'uncommitted user change kept')
    assert.match(readFileSync(path.join(repo, 'src', 'components', 'Badge.tsx'), 'utf8'), /function Tag/, 'the checkout shows the committed result')
    assert.equal(git(repo, 'status --porcelain'), 'M README.md')
    assert.equal(git(repo, 'branch --list "mac/*"'), '', 'no leftover agent branches')
    assert.deepEqual(consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(app)
  }
})

test('a folder without git: the run sets git up itself and the result lands in the main code', { timeout: 10 * 60_000 }, async () => {
  const repo = prepareRepository({ install: true })
  const { app, page, api, consoleErrors } = await launch(newProfile())
  try {
    await api('PATCH', '/settings', { orchestrator: null, planApproval: true, fastPath: true })
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(app, page, repo)
    // git is gone again after opening (e.g. removed by the user): nothing asks the user to set it up
    rmSync(path.join(repo, '.git'), { recursive: true, force: true })

    await page.locator('#chat-input').fill('Benenne die Komponente Badge in Tag um (src/components/Badge.tsx)')
    await page.getByRole('button', { name: 'Senden' }).click()
    const start = page.getByRole('button', { name: 'Ausführung starten' })
    await start.waitFor({ timeout: 60_000 })
    assert.equal(await page.locator('[data-testid="run-notice"]').count(), 0)
    assert.equal(await start.isDisabled(), false)
    await start.click()
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const sessionId = (await api('GET', `/projects/${projectId}/sessions`)).data[0].id
    const executionId = await waitUntil(async () => (await api('GET', `/sessions/${sessionId}`)).data.tasks[0]?.execution?.id, 30_000, 'execution')
    await waitUntil(async () => (await api('GET', `/executions/${executionId}`)).data.status === 'applied', 5 * 60_000, 'committed automatically', 1000)
    assert.equal(git(repo, 'rev-parse --abbrev-ref HEAD'), 'main')
    const log = git(repo, 'log --format=%s').split('\n')
    assert.equal(log.at(-1), 'Initial commit')
    assert.equal(log.length, 2, JSON.stringify(log))
    assert.match(readFileSync(path.join(repo, 'src', 'components', 'Badge.tsx'), 'utf8'), /function Tag/)
    assert.equal(git(repo, 'status --porcelain'), '')
    await page.getByText('Git wurde für dieses Projekt automatisch eingerichtet', { exact: false }).first().waitFor({ timeout: 15_000 })
    assert.deepEqual(consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(app)
  }
})
