// Serial, real Electron UI measurement. Build the desktop application first.
// node docs/benchmarks/ui-latency.mjs
// Only the native folder picker is answered deterministically. Task submission,
// plan approval, result rendering, diff review and apply use the real UI.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { launch, quit, waitUntil, answerFolderDialog } from '../../apps/desktop/e2e/helpers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dir = path.join(root, 'docs/benchmarks')
const scenario = process.env.BENCH_SCENARIO ?? 'slug'
const phase = process.env.BENCH_PHASE ?? 'before'
const runId = `comparison-${phase}-${scenario}-${new Date().toISOString().replace(/[:.]/g, '-')}`
const out = path.join(dir, runId)
fs.mkdirSync(out)
const trace = path.join(out, 'trace.jsonl')
const emit = (name, data = {}) => { fs.appendFileSync(trace, JSON.stringify({ runId, source: 'harness', at: new Date().toISOString(), epochMs: performance.timeOrigin + performance.now(), name, ...data }) + '\n'); console.log(name, JSON.stringify(data).slice(0, 700)) }
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const { createHash } = await import('node:crypto')
const hash = data => createHash('sha256').update(data).digest('hex')
const base = fs.mkdtempSync(path.join(os.tmpdir(), `${runId}-`)), repo = path.join(base, 'repo'), profile = path.join(base, 'profile')
fs.mkdirSync(repo); fs.mkdirSync(profile)
const syntax = "import { readdirSync } from 'node:fs'; import { execFileSync } from 'node:child_process'; for (const f of readdirSync('src')) if (f.endsWith('.mjs')) execFileSync(process.execPath, ['--check', 'src/' + f]);"
let acceptance = "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { slugify, version } from '../src/index.mjs'; test('slugify', () => { assert.equal(version,1); for (const [v,e] of [[' Hello, WORLD! ','hello-world'],['',''],['---',''],['a__b  c','a-b-c']]) assert.equal(slugify(v),e) });\n"
let files = { 'src/index.mjs': 'export const version = 1\n', 'test/slug.test.mjs': acceptance, 'syntax.mjs': syntax, 'package.json': JSON.stringify({ name: 'latency-fixture', type: 'module', scripts: { test: 'node --test', typecheck: 'node syntax.mjs' } }) }
let scenarioGoal = 'Implement an exported slugify(text) function in a new src/slug.mjs and re-export it from src/index.mjs. Lowercase ASCII text, trim it, replace each group of non-alphanumeric characters by one hyphen, remove leading/trailing hyphens. Empty input returns an empty string. Do not change tests. Implement both files in one task.'
if (scenario !== 'slug') {
  acceptance = "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { clamp } from '../src/index.mjs'; test('clamp boundaries', () => { for (const [v,lo,hi,e] of [[-2,0,5,0],[2,0,5,2],[8,0,5,5],[0,0,5,0],[5,0,5,5],[-4,-3,-1,-3]]) assert.equal(clamp(v,lo,hi),e) });\n"
  files = { 'src/index.mjs': 'export const clamp = (value, min, max) => Math.min(min, Math.max(max, value))\n', 'test/slug.test.mjs': acceptance, 'syntax.mjs': syntax, 'package.json': files['package.json'] }
  scenarioGoal = 'Correct clamp(value,min,max) in src/index.mjs: return Math.min(max, Math.max(min, value)). Preserve signature and all tests. One small local task.'
  if (scenario === 'repair') scenarioGoal = 'Repair the existing clamp(value,min,max) in src/index.mjs so it returns the nearest boundary for outside values and preserves values inside [min,max], including negative boundaries. Inspect the supplied failing acceptance test. Keep the existing signature and all tests unchanged. One small local task.'
}
for (let i = 0; i < 24; i++) files[`src/unrelated${i}.mjs`] = Array.from({ length: 80 }, (_, n) => `export const unrelated${i}_${n} = ${n}`).join('\n') + '\n'
for (const [file, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), content) }
const repoGit = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
repoGit('init', '-q', '-b', 'main'); repoGit('add', '-A'); repoGit('-c', 'user.name=Benchmark', '-c', 'user.email=bench@localhost', 'commit', '-qm', 'fixture')
fs.writeFileSync(path.join(out, 'fixture.json'), JSON.stringify({ goal: scenarioGoal, files }, null, 2))
const goal = JSON.parse(fs.readFileSync(path.join(out, 'fixture.json'))).goal
const backend = path.join(root, 'apps/desktop/dist/backend/main.cjs'), savedBackend = fs.readFileSync(backend, 'utf8')
const original = phase === 'before' ? fs.readFileSync(path.join(root, '.cache/ui-optimization-baseline.cjs'), 'utf8') : savedBackend
const baselineBuild = JSON.parse(fs.readFileSync(path.join(root, ".cache/ui-optimization-baseline-build.json")))
const manifest = { phase, scenario, baselineSourceTreeSha256: baselineBuild.sourceTreeSha256, baselineSourceDiffSha256: baselineBuild.sourceDiffSha256, executedBackendSha256: hash(original), sourceSnapshotNote: phase === "before" ? "Source file inventory describes the current working tree; executed backend is the pinned pre-change build identified separately." : "Current optimized build", runId, recordedAt: new Date().toISOString(), commit: git('rev-parse', 'HEAD'), dirtyStatus: git('status', '--short'), sourceDiffSha256: hash(execFileSync('git', ['diff', '--binary'], { cwd: root })), repo, profile, baseCommit: repoGit('rev-parse', 'HEAD'), node: process.version, buildCommand: 'pnpm --filter @multi-ai-coder/desktop build', buildLog: '.cache/ui-latency-build.log', files: {} }
for (const file of git('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(f => /^(apps|packages)\//.test(f) && !f.includes('/dist/'))) if (fs.existsSync(path.join(root, file))) manifest.files[file] = hash(fs.readFileSync(path.join(root, file)))
manifest.sourceTreeSha256 = hash(JSON.stringify(manifest.files))
manifest.buildArtifacts = {}
const addTree = folder => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const p = path.join(folder, entry.name); if (entry.isDirectory()) addTree(p); else if (!p.endsWith('.map')) manifest.buildArtifacts[path.relative(root, p).replaceAll('\\', '/')] = hash(fs.readFileSync(p)) } }
addTree(path.join(root, 'apps/desktop/dist'))
// Unminified bundle symbols are checked; fail closed on a changed bundler layout.
const jobClass = original.match(/await app\.get\((JobQueueService\w*)\)\.start\(\)/)?.[1]
assert.ok(jobClass)
const marker = '  await executions.recover();'
assert.equal(original.split(marker).length, 2)
const inject = `  if (process.env.MAC_LATENCY_TRACE) {
    const bench = require(process.env.MAC_LATENCY_HOOK).install({ app, executions, jobs: app.get(${jobClass}), events: executions.events, OllamaClient, ExecutionRunner, WorkspaceFiles, WorktreeManager, CodexAdapter });
    buildContextDigest = bench.wrap('context.digest.engine', buildContextDigest, a => ({ goal: a[1], options: a[2] }), r => ({ tokenEstimate: r.tokenEstimate }));
    preloadFiles = bench.wrap('context.preload', preloadFiles, a => ({ files: a[1], budgetChars: a[2] }));
    runLocalAgent = bench.wrap('agent.local', runLocalAgent, a => ({ model: a[0].model, task: a[0].task, previousFailures: a[0].previousFailures, availableTools: a[0].extraTools?.map(t => t.name), instructionChars: a[0].extraInstructions?.length ?? 0, preferStructured: a[0].preferStructured, supportsTools: a[0].supportsTools }), r => ({ result: r }));
    executeToolCall = bench.wrap('tool.call', executeToolCall, a => ({ call: a[0] }), r => ({ result: r }));
    runValidationChecks = bench.wrap('validation', runValidationChecks, a => ({ cwd: a[0], checks: a[1] }), r => ({ report: r }));
    validatePatch = bench.wrap('patch.validate', validatePatch, a => ({ cwd: a[0], base: a[1], head: a[2] }), r => ({ ok: r.ok, issues: r.issues, files: r.files }));
    cherryPick = bench.wrap('integration.cherryPick', cherryPick, a => ({ cwd: a[0], commit: a[1] }), r => ({ result: r }));
    runProcess = bench.wrap('process', runProcess, a => ({ command: a[0], args: a[1], cwd: a[2]?.cwd }), r => ({ exitCode: r.exitCode, processMs: r.durationMs, timedOut: r.timedOut }));
  }
`
fs.writeFileSync(backend, original.replace(marker, inject + marker))
manifest.instrumentedBackendSha256 = hash(fs.readFileSync(backend))
manifest.recorderSha256 = hash(fs.readFileSync(fileURLToPath(import.meta.url)))
manifest.hookSha256 = hash(fs.readFileSync(path.join(dir, 'ui-latency-hook.cjs')))
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify(manifest, null, 2))
fs.copyFileSync(path.join(root, '.cache/ui-latency-build.log'), path.join(out, 'build.log'))
for (const file of ['ui-execution-comparison.mjs', 'ui-latency-hook.cjs']) fs.copyFileSync(path.join(dir, file), path.join(out, file))
let session
try {
  emit('app.launch.start', { repo, profile })
  session = await launch(profile, { MAC_LATENCY_REPAIR: scenario === 'repair' ? '1' : '0', MAC_LATENCY_TRACE: trace, MAC_LATENCY_RUN_ID: runId, MAC_LATENCY_HOOK: path.join(dir, 'ui-latency-hook.cjs') })
  const { app, page, api } = session
  emit('app.runtime.ready', { runtime: await page.evaluate(() => window.mac.runtime.status()) })
  const patch = { fastPath: false, orchestrator: 'codex', codexModel: 'gpt-6-astra', orchestratorAuthMode: 'subscription', ollamaBaseUrl: 'http://127.0.0.1:11436', ollamaModelsDir: path.join(os.homedir(), '.ollama/models'), costMode: 'balanced', planApproval: true, autoStartSmallPlans: false, approvalMode: 'manual', localParallelism: 1, premiumParallelism: 1, numCtx: 16384, maxTasks: 1 }
  assert.equal((await api('PATCH', '/settings', patch)).status, 200)
  emit('ollama.start.start')
  const status = await api('GET', '/local-models/ollama')
  if (!status.data.reachable) emit('ollama.start.result', { result: await api('POST', '/local-models/ollama/start') })
  const installed = await api('GET', '/local-models/installed')
  fs.writeFileSync(path.join(out, 'models.json'), JSON.stringify(installed.data, null, 2))
  assert.ok(installed.data.some(m => m.name === 'qwen3:4b'))
  const snapshot = { at: new Date().toISOString() }
  for (const endpoint of ['tags', 'ps', 'version']) snapshot[endpoint] = await (await fetch(`${patch.ollamaBaseUrl}/api/${endpoint}`)).json()
  fs.writeFileSync(path.join(out, 'ollama-runtime.json'), JSON.stringify(snapshot, null, 2))
  const modelDetails = await (await fetch(patch.ollamaBaseUrl + '/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:4b' }) })).json()
  fs.writeFileSync(path.join(out, 'model-default-parameters.json'), JSON.stringify({ parameters: modelDetails.parameters, capabilities: modelDetails.capabilities, model_info: modelDetails.model_info }, null, 2))
  assert.equal((await api('PUT', '/local-models/roles', { fast: 'qwen3:4b', balanced: 'qwen3:4b', advanced: 'qwen3:4b' })).status, 200)
  const auth = await api('GET', '/orchestrator/codex/status')
  assert.ok(auth.data.authenticated && !auth.data.usesApiKeyBilling)
  await api('POST', '/onboarding/complete'); await page.reload(); await page.waitForSelector('.ide')
  await answerFolderDialog(app, repo)
  await page.getByRole('button', { name: 'Ordner öffnen' }).first().click()
  await page.locator('#chat-input').waitFor({ state: 'visible' })
  await page.locator('#chat-input').fill(goal)
  await page.screenshot({ path: path.join(out, '01-before-submit.png') })
  fs.writeFileSync(path.join(out, 'settings.json'), JSON.stringify((await api('GET', '/settings')).data, null, 2))
  // A renderer capture listener dates the actual click; the observer marks the
  // first two-animation-frame paint opportunity after the approval UI appears.
  await page.exposeFunction('latencyMark', value => emit(value.name, value))
  await page.evaluate(() => {
    document.addEventListener('click', e => {
      const button = e.target.closest('button')
      if (button && /^(Senden|Ausführung starten|In Arbeitskopie übernehmen)$/.test(button.textContent.trim() || button.getAttribute('aria-label') || '')) window.latencyMark({ name: 'ui.click', label: button.textContent.trim() || button.getAttribute('aria-label'), rendererEpochMs: performance.timeOrigin + performance.now() })
    }, true)
    let marked = false
    new MutationObserver(() => {
      const approval = document.querySelector('[data-testid="workflow-approval"]')
      if (!marked && approval && approval.getBoundingClientRect().height > 0) {
        marked = true
        window.latencyMark({ name: 'ui.approval.dom', rendererEpochMs: performance.timeOrigin + performance.now() })
        requestAnimationFrame(() => requestAnimationFrame(() => window.latencyMark({ name: 'ui.approval.paintOpportunity', rendererEpochMs: performance.timeOrigin + performance.now() })))
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true })
  })
  // SSE arrival and IPC/API round trips in Electron main, without recording auth headers.
  await app.evaluate(({ BrowserWindow }, file) => {
    const fs = process.getBuiltinModule('node:fs')
    const record = (name, data) => fs.appendFileSync(file, JSON.stringify({ runId: process.env.MAC_LATENCY_RUN_ID, source: 'main', name, epochMs: performance.timeOrigin + performance.now(), at: new Date().toISOString(), ...data }) + '\n')
    // Existing IPC handlers are wrapped through the validated app-local bridge.
    // webContents.send records SSE delivery to the renderer.
    for (const win of BrowserWindow.getAllWindows()) {
      const send = win.webContents.send.bind(win.webContents)
      win.webContents.send = (channel, ...args) => { if (/event/.test(channel)) record('main.send', { channel, event: args[0] }); return send(channel, ...args) }
    }
  }, trace)
  emit('ui.submit.action.start')
  await page.getByRole('button', { name: 'Senden', exact: true }).click()
  await page.getByRole('button', { name: 'Ausführung starten', exact: true }).waitFor({ timeout: 360000 })
  const projectId = (await api('GET', '/settings')).data.lastProjectId
  const task = (await api('GET', `/tasks?projectId=${projectId}`)).data[0]
  const detail = (await api('GET', `/tasks/${task.id}`)).data
  emit('ui.plan.visible', { taskId: task.id, plan: detail.plans[0], subtasks: detail.subtasks })
  fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(detail, null, 2))
  assert.equal(detail.plans[0].source, 'codex')
  await page.screenshot({ path: path.join(out, '02-plan.png') })
  emit('plan.review.start')
  assert.equal(detail.subtasks.length, 1)
  assert.equal(detail.subtasks[0].selectedModelClass, 'local_llm')
  assert.equal(detail.subtasks[0].selectedModelName, 'qwen3:4b')
  await new Promise(r => setTimeout(r, 3000))
  emit('plan.review.approved')
  await page.getByRole('button', { name: 'Ausführung starten', exact: true }).click()
  await page.getByText('Änderungen bereit zur Freigabe', { exact: true }).first().waitFor({ timeout: 1200000 })
  await page.getByRole('button', { name: 'In Arbeitskopie übernehmen', exact: true }).waitFor({ state: 'visible' })
  emit('ui.ready.visible', { rendererEpochMs: await page.evaluate(() => performance.timeOrigin + performance.now()) })
  await page.screenshot({ path: path.join(out, '03-ready.png') })
  const taskAfter = (await api('GET', `/tasks/${task.id}`)).data
  const execution = (await api('GET', `/executions/${taskAfter.executions[0].id}`)).data
  emit('run.ids', { taskId: task.id, executionId: execution.id })
  fs.writeFileSync(path.join(out, 'execution.json'), JSON.stringify(execution, null, 2))
  fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify((await api('GET', `/executions/${execution.id}/events`)).data, null, 2))
  assert.equal(execution.status, 'awaiting_approval')
  assert.ok(execution.finalValidation.ok)
  assert.ok(execution.finalValidation.results.length >= 2)
  assert.ok(execution.finalValidation.results.every(r => r.status === 'passed'), 'no skipped final checks')
  assert.equal(repoGit('status', '--porcelain'), '')
  assert.equal(fs.readFileSync(path.join(execution.integrationWorktree, 'test/slug.test.mjs'), 'utf8').replaceAll('\r\n', '\n'), acceptance)
  await page.getByRole('button', { name: 'Diff im Editor' }).first().click()
  await page.locator('.monaco-editor').first().waitFor({ timeout: 30000 })
  await page.screenshot({ path: path.join(out, '04-diff.png') })
  fs.writeFileSync(path.join(out, 'result.diff'), execution.finalDiff)
  emit('result.review.approved', { review: execution.review, testsUnchanged: true, userCheckoutClean: true })
  await page.getByRole('button', { name: 'In Arbeitskopie übernehmen', exact: true }).click()
  await waitUntil(async () => (await api('GET', `/executions/${execution.id}`)).data.status === 'applied', 60000, 'apply')
  const check = execFileSync(process.execPath, ['--test'], { cwd: repo, encoding: 'utf8' })
  execFileSync(process.execPath, ['syntax.mjs'], { cwd: repo })
  fs.writeFileSync(path.join(out, 'post-apply-tests.txt'), check)
  await page.screenshot({ path: path.join(out, '05-applied.png') })
  emit('run.complete', { success: true, phase, scenario })
} catch (error) {
  emit('run.error', { error: String(error.stack ?? error) })
  if (session) { await session.page.screenshot({ path: path.join(out, 'error.png') }).catch(() => {}); fs.writeFileSync(path.join(out, 'error-ui.txt'), await session.page.locator('body').innerText().catch(() => 'unavailable')) }
  process.exitCode = 1
} finally {
  try {
    if (session) {
      await quit(session.app)
      fs.copyFileSync(path.join(profile, 'logs/runtime.log'), path.join(out, 'runtime.log'))
    }
  } catch (error) {
    emit('teardown.error', { error: String(error.stack ?? error) })
    process.exitCode = 1
  } finally {
    fs.writeFileSync(backend, savedBackend)
    emit('app.closed.backend.restored', { originalSha256: hash(fs.readFileSync(backend)) })
  }
  console.log('ARTIFACTS', out)
}
