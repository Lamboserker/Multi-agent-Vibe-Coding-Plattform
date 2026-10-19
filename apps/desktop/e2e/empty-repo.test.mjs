// Opening a project sets up git: a plain folder becomes a repository and a repository without commits
// gets its first commit (dependencies and secrets stay out). The run then goes through (fast path, no model).
//
//   pnpm --filter @multi-ai-coder/desktop build && node --test e2e/empty-repo.test.mjs
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { launch, newProfile, openProject, prepareRepository, quit, waitUntil } from './helpers.mjs'

const git = (repo, command) => execSync(`git ${command}`, { cwd: repo, encoding: 'utf8' }).trim()

test('opening a folder without git (or without commits) sets up the repository and runs work', { timeout: 10 * 60_000 }, async () => {
  // plain folder: the fixture without .git and without .gitignore, plus a secret
  const plain = prepareRepository({ install: true })
  rmSync(path.join(plain, '.git'), { recursive: true, force: true })
  rmSync(path.join(plain, '.gitignore'), { force: true })
  writeFileSync(path.join(plain, '.env'), 'API_TOKEN=secret\n')
  // repository initialised elsewhere without any commit
  const uncommitted = prepareRepository()
  rmSync(path.join(uncommitted, '.git'), { recursive: true, force: true })
  execSync('git init -q -b main', { cwd: uncommitted })

  const { app, page, api, consoleErrors } = await launch(newProfile())
  try {
    await api('PATCH', '/settings', { orchestrator: null, planApproval: true, fastPath: true, approvalMode: 'manual' })
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })

    await openProject(app, page, uncommitted)
    assert.equal(git(uncommitted, 'log --format=%s'), 'Initial commit')

    await openProject(app, page, plain)
    assert.equal(git(plain, 'log --format=%s'), 'Initial commit')
    assert.ok(existsSync(path.join(plain, '.gitignore')))
    assert.match(readFileSync(path.join(plain, '.gitignore'), 'utf8'), /node_modules/)
    assert.equal(git(plain, 'ls-files node_modules .env'), '', 'dependencies and secrets stay out of the first commit')
    assert.equal(git(plain, 'ls-files src/components/Badge.tsx'), 'src/components/Badge.tsx')

    // no "needs a commit" notice; the run goes through
    await page.locator('#chat-input').fill('Benenne die Komponente Badge in Tag um (src/components/Badge.tsx)')
    await page.getByRole('button', { name: 'Senden' }).click()
    const start = page.getByRole('button', { name: 'Ausführung starten' })
    await start.waitFor({ timeout: 60_000 })
    assert.equal(await page.locator('[data-testid="run-notice"]').count(), 0)
    await waitUntil(async () => !(await start.isDisabled()), 10_000, 'start enabled')
    await start.click()
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const sessionId = (await api('GET', `/projects/${projectId}/sessions`)).data[0].id
    const executionId = await waitUntil(async () => (await api('GET', `/sessions/${sessionId}`)).data.tasks[0]?.execution?.id, 30_000, 'execution')
    const status = await waitUntil(async () => { const value = (await api('GET', `/executions/${executionId}`)).data.status; return ['pending', 'running', 'integrating'].includes(value) ? null : value }, 5 * 60_000, 'run finished', 1000)
    assert.equal(status, 'awaiting_approval')
    assert.deepEqual(consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(app)
  }
})

test('applying a result after the branch moved is explained and the result can be kept as a branch', { timeout: 10 * 60_000 }, async () => {
  const repo = prepareRepository({ install: true })
  const { app, page, api, consoleErrors } = await launch(newProfile())
  try {
    await api('PATCH', '/settings', { orchestrator: null, planApproval: true, fastPath: true, approvalMode: 'manual' })
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(app, page, repo)
    await page.locator('#chat-input').fill('Benenne die Komponente Badge in Tag um (src/components/Badge.tsx)')
    await page.getByRole('button', { name: 'Senden' }).click()
    await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Ausführung starten' }).click()
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const sessionId = (await api('GET', `/projects/${projectId}/sessions`)).data[0].id
    const executionId = await waitUntil(async () => (await api('GET', `/sessions/${sessionId}`)).data.tasks[0]?.execution?.id, 30_000, 'execution')
    await waitUntil(async () => (await api('GET', `/executions/${executionId}`)).data.status === 'awaiting_approval', 5 * 60_000, 'awaiting approval', 1000)

    // meanwhile the files the change builds on are deleted and the deletion committed (as in the reported case)
    git(repo, 'rm -q -r src')
    git(repo, '-c user.name=t -c user.email=t@t commit -q -m changes')

    await page.locator('[data-testid="workflow"]').getByRole('button', { name: 'Änderungen prüfen' }).click()
    await page.getByRole('button', { name: 'In Arbeitskopie übernehmen' }).click()
    const notice = page.locator('[data-testid="apply-rejected"]')
    await notice.waitFor({ timeout: 15_000 })
    const text = await notice.textContent()
    assert.match(text, /Dein Branch hat sich seit dem Start des Laufs geändert/)
    assert.match(text, /fehlen in deiner Arbeitskopie: .*src\/App\.tsx/)
    assert.doesNotMatch(text, /Falling back|does not exist in index/)
    await notice.getByRole('button', { name: 'Als Branch behalten' }).click()
    await waitUntil(async () => (await api('GET', `/executions/${executionId}`)).data.status === 'applied', 30_000, 'kept as branch')
    const branch = (await api('GET', `/executions/${executionId}`)).data.integrationBranch
    assert.match(git(repo, `show ${branch}:src/components/Badge.tsx`), /function Tag/)
    assert.deepEqual(consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(app)
  }
})
