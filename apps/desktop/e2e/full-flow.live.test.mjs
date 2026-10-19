// Complete flow with a real local model (no premium call): open a plain folder (git is set up),
// agent run, project changes WHILE the run is active, approval, apply, app restart.
//
//   MAC_E2E_LIVE=1 MAC_E2E_MODEL=qwen2.5-coder:7b MAC_E2E_OLLAMA_URL=http://127.0.0.1:11435 \
//   MAC_E2E_OLLAMA_MODELS=D:\ollama-models node --test e2e/full-flow.live.test.mjs
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { go, launch, newProfile, openProject, prepareRepository, quit, resultsDir, stamp, waitUntil } from './helpers.mjs'

const live = process.env.MAC_E2E_LIVE === '1'
const model = process.env.MAC_E2E_MODEL ?? 'qwen2.5-coder:7b'
const ollamaUrl = process.env.MAC_E2E_OLLAMA_URL ?? 'http://127.0.0.1:11434'
const ACTIVE = ['pending', 'running', 'integrating']
const REQUEST =
  'Erstelle eine React-Komponente `Greeting` in `src/components/Greeting.tsx` mit der Prop `name: string`, die `<h1 className="greeting">Hallo, {name}!</h1>` rendert, ' +
  'und einen Vitest-Test in `src/components/Greeting.test.tsx` nach dem Muster von `src/components/Badge.test.tsx` (renderToStaticMarkup).'
const git = (repo, command) => execSync(`git ${command}`, { cwd: repo, encoding: 'utf8' }).trim()

async function configure(api, approvalMode = 'manual') {
  await api('PATCH', '/settings', { orchestrator: null, ollamaBaseUrl: ollamaUrl, ollamaModelsDir: process.env.MAC_E2E_OLLAMA_MODELS ?? null, planApproval: true, approvalMode, premiumReviewPolicy: 'never', fastPath: false })
  if (!(await api('GET', '/local-models/ollama')).data.reachable) await api('POST', '/local-models/ollama/start')
  await waitUntil(async () => (await api('GET', '/local-models/ollama')).data.reachable, 60_000, 'ollama reachable')
  assert.ok((await api('GET', '/local-models/installed')).data.some?.((entry) => entry.name === model), `Model ${model} must be installed at ${ollamaUrl}`)
  await api('PUT', '/local-models/roles', { fast: model, balanced: model, advanced: model })
  await api('POST', '/onboarding/complete')
}

async function startRun(page, api) {
  await go(page, 'Leitstand')
  await page.locator('#chat-input').fill(REQUEST)
  await page.getByRole('button', { name: 'Senden' }).click()
  await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 180_000 })
  const projectId = (await api('GET', '/settings')).data.lastProjectId
  const sessionId = (await api('GET', `/projects/${projectId}/sessions`)).data[0].id
  await page.getByRole('button', { name: 'Ausführung starten' }).click()
  const executionId = await waitUntil(async () => (await api('GET', `/sessions/${sessionId}`)).data.tasks[0]?.execution?.id, 30_000, 'execution created')
  return { projectId, sessionId, executionId }
}

const finished = (api, executionId) => waitUntil(async () => {
  const status = (await api('GET', `/executions/${executionId}`)).data.status
  return ACTIVE.includes(status) ? null : status
}, 45 * 60_000, 'run finished', 2000)

test('open → run (with project changes meanwhile) → approval → apply → restart', { skip: !live && 'set MAC_E2E_LIVE=1 (needs Ollama with the model)', timeout: 60 * 60_000 }, async () => {
  const id = stamp()
  // a plain folder: no git yet, an incomplete .gitignore and a secret
  const repo = prepareRepository({ install: true })
  rmSync(path.join(repo, '.git'), { recursive: true, force: true })
  writeFileSync(path.join(repo, '.gitignore'), 'dist/\n')
  writeFileSync(path.join(repo, '.env'), 'API_TOKEN=secret\n')
  const profile = newProfile()
  let session = await launch(profile)
  let { app, page, api } = session
  try {
    await configure(api)
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(app, page, repo)
    assert.equal(git(repo, 'log --format=%s'), 'Initial commit')
    assert.equal(git(repo, 'ls-files .env node_modules'), '', 'secret and dependencies stay out despite the incomplete .gitignore')

    const { executionId } = await startRun(page, api)
    await page.locator('[data-testid="run-running"]').waitFor({ timeout: 30_000 })

    // --- the user keeps working in the project while the agents run ---
    const readme = readFileSync(path.join(repo, 'README.md'), 'utf8')
    writeFileSync(path.join(repo, 'README.md'), `${readme}\nNotiz während des Laufs.\n`)
    mkdirSync(path.join(repo, 'docs'), { recursive: true })
    writeFileSync(path.join(repo, 'docs', 'notes.md'), '# Notizen\n')
    git(repo, 'add docs/notes.md')
    git(repo, '-c user.name=t -c user.email=t@t commit -q -m "docs während des Laufs"')
    const userHead = git(repo, 'rev-parse HEAD')

    const status = await finished(api, executionId)
    const run = (await api('GET', `/executions/${executionId}`)).data
    console.log('[e2e] run finished', JSON.stringify({ status, attempts: run.agentRuns.map((attempt) => attempt.outcome), validation: run.finalValidation?.summary, premiumCalls: run.usage?.premium.calls }))
    assert.equal(status, 'awaiting_approval', `the local model must produce a validated change (${run.errorMessage ?? ''})`)
    assert.equal(run.usage?.premium.calls ?? 0, 0, 'no premium call happened')
    assert.ok(!existsSync(path.join(repo, 'src', 'components', 'Greeting.tsx')), 'nothing is written to the checkout before approval')

    // --- approval: applies on top of the moved branch, the user's changes stay ---
    await go(page, 'Freigabe')
    const approval = page.locator('[data-testid="workflow-approval"]')
    await approval.locator('.review-file', { hasText: 'Greeting' }).first().waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'In Arbeitskopie übernehmen' }).click()
    await waitUntil(async () => (await api('GET', `/executions/${executionId}`)).data.status === 'applied', 60_000, 'applied')
    await approval.locator('.done-box').waitFor({ timeout: 15_000 })
    assert.match(readFileSync(path.join(repo, 'src', 'components', 'Greeting.tsx'), 'utf8'), /Greeting/)
    assert.match(readFileSync(path.join(repo, 'README.md'), 'utf8'), /Notiz während des Laufs/, 'uncommitted user change kept')
    assert.equal(git(repo, 'rev-parse HEAD'), userHead, 'apply does not commit or move the branch')
    assert.ok(existsSync(path.join(repo, 'docs', 'notes.md')))
    assert.doesNotMatch(git(repo, 'status --porcelain'), /^(UU|AA|DU|UD) /m, 'no unmerged entries')
    const tests = execSync('npx --no-install vitest run', { cwd: repo, encoding: 'utf8' })
    assert.match(tests, /passed/)
    await page.screenshot({ path: path.join(resultsDir, `${id}-full-flow-applied.png`) })

    // --- restart: everything is still there ---
    await quit(app)
    session = await launch(profile)
    ;({ app, page, api } = session)
    await page.waitForSelector('.ide', { timeout: 60_000 })
    assert.equal((await api('GET', `/executions/${executionId}`)).data.status, 'applied')
    await go(page, 'Leitstand')
    await waitUntil(async () => (await page.locator('[data-testid="workflow"]').getAttribute('data-state')) === 'done', 30_000, 'done after restart')
    assert.match(readFileSync(path.join(repo, 'README.md'), 'utf8'), /Notiz während des Laufs/)
    assert.ok(existsSync(path.join(repo, 'src', 'components', 'Greeting.tsx')))
    assert.deepEqual(session.consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(app)
  }
})

test('a change to a file the agents also write during the run is protected at approval', { skip: !live && 'set MAC_E2E_LIVE=1 (needs Ollama with the model)', timeout: 60 * 60_000 }, async () => {
  const repo = prepareRepository({ install: true })
  const { app, page, api, consoleErrors } = await launch(newProfile())
  try {
    await configure(api)
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(app, page, repo)
    const { executionId } = await startRun(page, api)
    // the user creates the very file the agents are about to create
    mkdirSync(path.join(repo, 'src', 'components'), { recursive: true })
    const mine = 'export const Greeting = () => null // meine Version\n'
    writeFileSync(path.join(repo, 'src', 'components', 'Greeting.tsx'), mine)
    const status = await finished(api, executionId)
    assert.equal(status, 'awaiting_approval', `the local model must produce a validated change (${(await api('GET', `/executions/${executionId}`)).data.errorMessage ?? ''})`)
    await go(page, 'Freigabe')
    await page.getByRole('button', { name: 'In Arbeitskopie übernehmen' }).click()
    const notice = page.locator('[data-testid="apply-rejected"]')
    await notice.waitFor({ timeout: 15_000 })
    assert.match(await notice.textContent(), /nicht committeten Änderungen in .*Greeting\.tsx/)
    assert.equal(readFileSync(path.join(repo, 'src', 'components', 'Greeting.tsx'), 'utf8'), mine, 'the user version is untouched')
    assert.doesNotMatch(git(repo, 'status --porcelain'), /^(UU|AA|DU|UD) /m)
    // keeping the result as a branch is always possible
    await notice.getByRole('button', { name: 'Als Branch behalten' }).click()
    await waitUntil(async () => (await api('GET', `/executions/${executionId}`)).data.status === 'applied', 30_000, 'kept as branch')
    assert.equal(readFileSync(path.join(repo, 'src', 'components', 'Greeting.tsx'), 'utf8'), mine)
    assert.deepEqual(consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(app)
  }
})

test('default mode: the result is committed onto main without asking, also after commits on main during the run', { skip: !live && 'set MAC_E2E_LIVE=1 (needs Ollama with the model)', timeout: 60 * 60_000 }, async () => {
  const repo = prepareRepository({ install: true })
  const profile = newProfile()
  let session = await launch(profile)
  let { app, page, api } = session
  try {
    assert.equal((await api('GET', '/settings')).data.approvalMode, 'auto_commit')
    await configure(api, 'auto_commit')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(app, page, repo)
    const { executionId } = await startRun(page, api)
    await waitUntil(async () => (await api('GET', `/executions/${executionId}`)).data.baseCommit, 120_000, 'run base commit', 200)

    // the user commits on main and keeps an uncommitted change while the agents run
    mkdirSync(path.join(repo, 'docs'), { recursive: true })
    writeFileSync(path.join(repo, 'docs', 'notes.md'), '# Notizen\n')
    git(repo, 'add docs/notes.md')
    git(repo, '-c user.name=t -c user.email=t@t commit -q -m "docs während des Laufs"')
    const userHead = git(repo, 'rev-parse HEAD')
    const readme = readFileSync(path.join(repo, 'README.md'), 'utf8')
    writeFileSync(path.join(repo, 'README.md'), `${readme}\nNotiz während des Laufs.\n`)

    const status = await finished(api, executionId)
    // awaiting_approval is only a moment before the automatic commit
    const final = status === 'awaiting_approval' ? await waitUntil(async () => { const value = (await api('GET', `/executions/${executionId}`)).data.status; return value === 'awaiting_approval' ? null : value }, 60_000, 'auto commit', 500).catch(() => 'awaiting_approval') : status
    const run = (await api('GET', `/executions/${executionId}`)).data
    console.log('[e2e] auto-commit run', JSON.stringify({ status: final, attempts: run.agentRuns.map((attempt) => attempt.outcome), validation: run.finalValidation?.summary }))
    assert.equal(final, 'applied', `committed without a click (${run.errorMessage ?? ''})`)
    assert.equal(git(repo, 'rev-parse --abbrev-ref HEAD'), 'main')
    assert.ok(git(repo, `merge-base --is-ancestor ${userHead} HEAD && echo yes`) === 'yes', 'the commit made during the run is kept')
    assert.match(git(repo, 'show HEAD:src/components/Greeting.tsx'), /Greeting/)
    assert.match(readFileSync(path.join(repo, 'README.md'), 'utf8'), /Notiz während des Laufs/, 'uncommitted user change kept')
    assert.equal(git(repo, 'status --porcelain'), 'M README.md')
    assert.equal(git(repo, 'branch --list "mac/*"'), '', 'no leftover agent branches')

    await quit(app)
    session = await launch(profile)
    ;({ app, page, api } = session)
    await page.waitForSelector('.ide', { timeout: 60_000 })
    assert.equal((await api('GET', `/executions/${executionId}`)).data.status, 'applied')
    await go(page, 'Leitstand')
    await waitUntil(async () => (await page.locator('[data-testid="workflow"]').getAttribute('data-state')) === 'done', 30_000, 'done after restart')
    assert.deepEqual(session.consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(app)
  }
})

test('a conflict with a newer commit on main is merged by the local model, checked and committed', { skip: !live && 'set MAC_E2E_LIVE=1 (needs Ollama with the model)', timeout: 60 * 60_000 }, async () => {
  const repo = prepareRepository({ install: true })
  const { app, page, api, consoleErrors } = await launch(newProfile())
  try {
    await configure(api, 'auto_commit')
    // the run itself takes the fast path (rename without a model); the model only merges the conflict
    await api('PATCH', '/settings', { fastPath: true, autoStartSmallPlans: false })
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(app, page, repo)
    await go(page, 'Leitstand')
    await page.locator('#chat-input').fill('Benenne die Komponente Badge in Tag um (src/components/Badge.tsx)')
    await page.getByRole('button', { name: 'Senden' }).click()
    await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 120_000 }).catch(async (error) => {
      const projectId = (await api('GET', '/settings')).data.lastProjectId
      const sessions = (await api('GET', `/projects/${projectId}/sessions`)).data
      const detail = sessions[0] ? (await api('GET', `/sessions/${sessions[0].id}`)).data : undefined
      console.log('[e2e] planning', JSON.stringify({ sessions: sessions.length, tasks: detail?.tasks?.map((task) => [task.status, task.currentStep, task.subtasks?.length]) }))
      await page.screenshot({ path: path.join(resultsDir, `${stamp()}-merge-plan.png`) })
      throw error
    })
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const sessionId = (await api('GET', `/projects/${projectId}/sessions`)).data[0].id
    await page.getByRole('button', { name: 'Ausführung starten' }).click()
    const executionId = await waitUntil(async () => (await api('GET', `/sessions/${sessionId}`)).data.tasks[0]?.execution?.id, 30_000, 'execution created')
    await waitUntil(async () => (await api('GET', `/executions/${executionId}`)).data.baseCommit, 60_000, 'run base commit', 100)

    // meanwhile the user adds a second badge right where the agent renames the first one
    const app_ = path.join(repo, 'src', 'App.tsx')
    writeFileSync(app_, readFileSync(app_, 'utf8').replace('<Badge label="beta" />', '<Badge label="beta" />\n      <Badge label="neu" />'))
    git(repo, '-c user.name=t -c user.email=t@t commit -q -am "zweites Badge"')

    const status = await waitUntil(async () => {
      const value = (await api('GET', `/executions/${executionId}`)).data.status
      return [...ACTIVE, 'awaiting_approval'].includes(value) ? null : value
    }, 30 * 60_000, 'run applied', 2000).catch(async (error) => {
      console.log('[e2e] status', (await api('GET', `/executions/${executionId}`)).data.status)
      throw error
    })
    const messages = (await api('GET', `/sessions/${sessionId}`)).data.messages?.map((message) => message.content) ?? []
    console.log('[e2e] merge', JSON.stringify({ status, messages: messages.filter((text) => /zusammengeführt|Konflikt|übernommen/i.test(text)) }))
    assert.equal(status, 'applied')
    const merged = git(repo, 'show HEAD:src/App.tsx')
    assert.match(merged, /<Tag label="beta" \/>/)
    assert.match(merged, /<Tag label="neu" \/>/, 'the user\'s new line follows the rename')
    // the file keeps its name (the rename tool renames the component, not the module)
    assert.doesNotMatch(merged, /<Badge|\{ Badge \}|<{7}|>{7}/)
    assert.equal(git(repo, 'rev-parse --abbrev-ref HEAD'), 'main')
    assert.equal(git(repo, 'status --porcelain'), '')
    assert.match(readFileSync(app_, 'utf8'), /<Tag label="neu" \/>/, 'the checkout shows the merged result')
    execSync('npx --no-install tsc --noEmit -p tsconfig.json', { cwd: repo })
    await page.getByText('automatisch zusammengeführt', { exact: false }).first().waitFor({ timeout: 15_000 })
    assert.deepEqual(consoleErrors.filter((message) => !/Failed to load resource/.test(message)), [])
  } finally {
    await quit(app)
  }
})
