// The shipped reference plugin (plugins/reference-extensions) through the real call sites of all six
// extension points: local models, orchestrator, repository context, validation, IDE and git view.
// The OpenAI-compatible model server is a local stand-in; nothing leaves the machine.
// Requires the compiled host: `pnpm --filter @multi-ai-coder/api build`.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const db = useTempDatabase('mac-reference-ext-')
process.env.MAC_DATA_DIR = db.dir
process.env.MAC_BUILTIN_PLUGINS_DIR = path.resolve(here, '../../../../plugins')
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { SettingsService } = await import('../runtime/settings.service.js')
const { PluginsService } = await import('./plugins.service.js')
const { OrchestratorService } = await import('../orchestration/orchestrator.service.js')
const { RepoContextService } = await import('../execution/repo-context.service.js')
const { WorkspaceFsService } = await import('../workspace-fs/workspace-fs.service.js')
const { LocalHistoryService } = await import('../ide/local-history.service.js')
const { IdeService } = await import('../ide/ide.service.js')
const { LocalModelsService } = await import('../local-models/local-models.service.js')
const { runValidationChecks } = await import('@multi-ai-coder/engine')

const hostBuilt = existsSync(path.resolve(here, '../../dist/plugins/host/plugin-host.cjs'))
const prisma = new PrismaService()
const events = new EventBusService()
const settings = new SettingsService(prisma, events)
const plugins = new PluginsService(prisma, events, settings)
const history = new LocalHistoryService()
const files = new WorkspaceFsService(prisma, events, history, plugins)
const plainFiles = new WorkspaceFsService(prisma, events, history)
const ide = new IdeService(prisma, events, settings, files, history, {} as never, plugins)
const orchestrators = new OrchestratorService(settings, events, undefined, plugins)
const repoContext = new RepoContextService(events, files, plugins)
const localModels = new LocalModelsService(settings, events, {} as never, plugins)
const ID = 'reference-extensions'

const repo = mkdtempSync(path.join(os.tmpdir(), 'mac-ref-repo-'))
const worktree = mkdtempSync(path.join(os.tmpdir(), 'mac-ref-worktree-'))
const TEST_SCRIPT = 'node --test test/smoke.test.cjs'
const FIXTURE_TESTS = `const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs');
const { add, greet, isEven } = require('../src/fixture.cjs');
test('addition', () => { assert.equal(add(2,3),5); fs.appendFileSync('executed-tests.txt','0'); });
test('greeting', () => { assert.equal(greet('Ada'),'Hello Ada'); fs.appendFileSync('executed-tests.txt','1'); });
test('parity', () => { assert.equal(isEven(2),true); assert.equal(isEven(3),false); fs.appendFileSync('executed-tests.txt','2'); });
`
let projectId = ''
let modelServer: Server
let baseUrl = ''
const requests: Array<{ path: string; body: Record<string, unknown> }> = []
let hangGeneration = false

function write(root: string, file: string, content: string) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), content)
}

/** Answers like a local OpenAI-compatible server; structured answers follow the requested schema. */
function completion(body: Record<string, unknown>) {
  const schema = ((body.response_format as { json_schema?: { schema?: { required?: string[] } } } | undefined)?.json_schema?.schema ?? {}) as { required?: string[] }
  const required = schema.required ?? []
  const last = String((body.messages as Array<{ content: string }>).at(-1)?.content ?? '')
  const analysis = { summary: 'Analyse', taskType: 'backend', complexity: 2, risk: 1, securitySensitive: false, affectedAreas: ['src'], needsDecomposition: false, openQuestions: [] }
  if (required.includes('files')) return { summary: 'Datei angelegt', files: [{ path: 'src/created.txt', content: 'hello from the plugin orchestrator' }], openIssues: [] }
  if (required.includes('verdict')) return { verdict: 'approve', score: 91, summary: 'ok', issues: [], requiredFixes: [] }
  if (required.includes('tasks')) return { summary: 'Plan', analysis, warnings: [], tasks: [{ id: 't1', title: 'Implementieren', description: 'd', category: 'backend-service', complexity: 2, risk: 1, relevantFiles: ['src/index.ts'], newFiles: [], dependsOn: [], capabilities: [], expectedInputTokens: 1000, testStrategy: 'unit', acceptanceCriteria: ['läuft'], suggestedExecutor: 'local', rationale: 'klein' }] }
  if (required.includes('taskType')) return analysis
  return `Antwort auf: ${last}`
}

beforeAll(async () => {
  await applyMigrations(prisma, MIGRATIONS_DIR, () => undefined)
  modelServer = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      requests.push({ path: request.url!, body })
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'fake-coder', object: 'model' }] }))
      if (request.url === '/v1/chat/completions') {
        if (hangGeneration) return
        const answer = completion(body)
        return response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: typeof answer === 'string' ? answer : JSON.stringify(answer) } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }))
      }
      response.writeHead(404).end('{}')
    })
  })
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(modelServer.address() as { port: number }).port}/v1`

  for (const root of [repo, worktree]) {
    write(root, 'package.json', JSON.stringify({ name: 'ref-demo', scripts: { test: TEST_SCRIPT, build: 'tsc' }, dependencies: { express: '^4' }, devDependencies: { vitest: '^4' } }))
    write(root, 'tsconfig.json', '{ "compilerOptions": { "strict": true } }')
    write(root, 'src/index.ts', 'export const value = 1\n')
    write(root, 'src/fixture.cjs', `exports.add=(a,b)=>a+b; exports.greet=name=>'Hello '+name; exports.isEven=value=>value%2===0;\n`)
    write(root, 'test/smoke.test.cjs', FIXTURE_TESTS)
  }
  write(repo, 'broken.json', '{\n  "a": 1,\n  "b": \n}\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
  execFileSync('git', ['branch', 'feature'], { cwd: repo })
  write(repo, 'src/index.ts', 'export const value = 2\n')
  write(repo, 'new-file.txt', 'untracked\n')
  projectId = (await prisma.project.create({ data: { name: 'ref', repoPath: repo } })).id
  await settings.update({ lastProjectId: projectId })
  if (!hostBuilt) return
  const manifest = JSON.parse(readFileSync(path.join(process.env.MAC_BUILTIN_PLUGINS_DIR!, ID, 'multi-ai-coder-plugin.json'), 'utf8')) as { permissions: Record<string, unknown> }
  await plugins.enable(ID, manifest.permissions)
  await plugins.updateSettings(ID, { baseUrl })
}, 60_000)

afterAll(async () => {
  await plugins.onApplicationShutdown()
  ide.onModuleDestroy()
  modelServer?.close()
  await prisma.$disconnect()
  db.cleanup()
})

describe.skipIf(!hostBuilt)('reference plugin: all six extension points at their call sites', () => {
  it('registers six contributions', async () => {
    const catalog = (await plugins.extensionCatalog()).filter((entry) => entry.plugin === ID)
    expect(catalog.map((entry) => entry.kind).sort()).toEqual(['gitIntegrations', 'languageIntegrations', 'modelProviders', 'orchestratorAdapters', 'repositoryAnalyzers', 'testRunners'])
  }, 60_000)

  it('model provider: engine profiles and generation for local agents', async () => {
    await plugins.selectExtension('modelProviders', { plugin: ID, id: 'openai-compatible' })
    const profiles = await localModels.engineProfiles()
    expect(profiles).toEqual([{ model: `plugin:${ID}:openai-compatible:fake-coder`, roles: ['balanced'], toolCalling: false, contextWindow: 8192, available: true }])
    const client = localModels.clientFor(profiles[0]!.model, {} as never)
    const answer = await client.chat({ model: 'ignored', messages: [{ role: 'user', content: 'Hallo' }], format: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } } } as never)
    expect(answer.message.content).toBe('Antwort auf: Hallo')
    expect(answer.promptTokens).toBe(11)
    const sent = requests.at(-1)!.body
    expect(sent.model).toBe('fake-coder')
    expect((sent.response_format as { type: string }).type).toBe('json_schema')
    await plugins.selectExtension('modelProviders', null)
  }, 60_000)

  it('model provider forwards limits, rejects oversized input without a call and reports complete output honestly', async () => {
    const client = localModels.clientFor(`plugin:${ID}:openai-compatible:fake-coder`, {} as never)
    const before = requests.length
    await expect(client.chat({ model: 'ignored', messages: [{ role: 'user', content: 'x'.repeat(5000) }], options: { num_ctx: 1024 } })).rejects.toMatchObject({ kind: 'resource_limit' })
    expect(requests).toHaveLength(before)
    let tokenCallback = false
    const result = await client.chat({ model: 'ignored', messages: [{ role: 'user', content: 'short' }], options: { num_ctx: 4096, num_predict: 16 } }, { onToken: () => { tokenCallback = true } })
    expect(result.completionTokens).toBe(7)
    expect(requests.at(-1)!.body.max_tokens).toBe(16)
    expect(tokenCallback).toBe(false)
    await expect(client.chat({ model: 'ignored', messages: [{ role: 'user', content: 'short' }], options: { num_predict: 2 } })).rejects.toMatchObject({ kind: 'resource_limit' })
  }, 30_000)

  it('plugin orchestrator enforces timeout and cancelRun on delegated HTTP work', async () => {
    await plugins.selectExtension('orchestratorAdapters', { plugin: ID, id: 'local-orchestrator' })
    const adapter = (await orchestrators.active())!
    const input = { question: 'short', context: { summary: 'demo', relevantFiles: [], validationCommands: [] } }
    const before = requests.length
    await expect(adapter.chat(input, { runId: 'bounded', cwd: repo, limits: { maxOutputTokens: 10 } })).rejects.toMatchObject({ kind: 'resource_limit' })
    expect(requests).toHaveLength(before)
    hangGeneration = true
    try {
      await expect(adapter.chat(input, { runId: 'timeout-plugin', cwd: repo, timeoutMs: 500 })).rejects.toThrow(/did not answer|timed out/)
      const called = requests.length
      const pending = adapter.chat(input, { runId: 'cancel-plugin', cwd: repo, timeoutMs: 6000 })
      const rejected = expect(pending).rejects.toThrow(/cancelled/)
      const deadline = Date.now() + 5000
      while (requests.length === called && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
      expect(requests.length).toBeGreaterThan(called)
      await adapter.cancelRun('cancel-plugin')
      await rejected
    } finally { hangGeneration = false; await plugins.selectExtension('orchestratorAdapters', null) }
  }, 20_000)

  it('cancels an actual plugin test process when its extension call is aborted', async () => {
    write(worktree, 'test/smoke.test.cjs', `require('node:fs').writeFileSync('hanging-test-pid.txt',String(process.pid));setInterval(()=>{},1000);\n`)
    const controller = new AbortController()
    const pending = plugins.invokeExtension(ID, 'testRunners', 'package-tests', 'run', { cwd: worktree }, { signal: controller.signal, timeoutMs: 6000 })
    const rejected = expect(pending).rejects.toThrow(/cancelled/)
    const pidFile = path.join(worktree, 'hanging-test-pid.txt')
    const deadline = Date.now() + 5000
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(existsSync(pidFile)).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    controller.abort()
    await rejected
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    const cleanupDeadline = Date.now() + 3000
    while (alive() && Date.now() < cleanupDeadline) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(alive()).toBe(false)
    write(worktree, 'test/smoke.test.cjs', FIXTURE_TESTS)
  }, 15000)

  it('orchestrator: analyze, plan, chat, review and execute (edits only the delegated worktree)', async () => {
    await plugins.selectExtension('orchestratorAdapters', { plugin: ID, id: 'local-orchestrator' })
    const adapter = (await orchestrators.active())!
    expect(adapter.displayName).toBe('Lokaler Orchestrator (OpenAI-kompatibel)')
    const context = { summary: 'Demo', relevantFiles: [], validationCommands: [] } as never
    expect((await adapter.analyzeTask({ goal: 'API bauen', context }, { runId: 'r1', cwd: repo })).result.taskType).toBe('backend')
    const plan = (await adapter.createPlan({ goal: 'API bauen', context, costMode: 'balanced', localModels: [], maxTasks: 4 }, { runId: 'r1', cwd: repo })).result
    expect(plan.tasks.map((task) => task.title)).toEqual(['Implementieren'])
    expect((await adapter.chat({ question: 'Was macht das Projekt?', context }, { runId: 'r1', cwd: repo })).result.answer).toBe('Antwort auf: Was macht das Projekt?')
    expect((await adapter.reviewResult({ goal: 'x', tasks: [], diff: '', validationSummary: '', riskFlags: [] }, { runId: 'r1', cwd: repo })).result).toMatchObject({ verdict: 'approve', score: 91 })
    const executed = (await adapter.executeComplexTask({ taskId: 't1', title: 'Datei', instructions: 'anlegen', acceptanceCriteria: [], relevantFiles: ['src/index.ts'] }, { runId: 'r1', cwd: worktree })).result
    expect(executed.filesChanged).toEqual(['src/created.txt'])
    expect(readFileSync(path.join(worktree, 'src/created.txt'), 'utf8')).toBe('hello from the plugin orchestrator')
    expect(existsSync(path.join(repo, 'src/created.txt'))).toBe(false)
    // the plugin got the existing file content from the worktree
    expect(JSON.stringify(requests.at(-1)!.body)).toContain('export const value = 1')
    await plugins.selectExtension('orchestratorAdapters', null)
  }, 60_000)

  it('repository analyzer + test runner: part of the planning digest and the validation of a run', async () => {
    await plugins.selectExtension('repositoryAnalyzers', { plugin: ID, id: 'manifest-analyzer' })
    await plugins.selectExtension('testRunners', { plugin: ID, id: 'package-tests' })
    const { digest, checks } = await repoContext.digest(projectId, repo, 'Tests ergänzen')
    expect(digest.summary).toContain('Plugin repository analysis')
    expect(digest.summary).toContain('Node-Projekt "ref-demo" mit npm')
    expect(digest.summary).toContain('express')
    const check = checks.find((entry) => entry.source === 'plugin')!
    expect(check.command).toContain('Paket-Tests')
    // the validation step of a run executes the plugin runner inside the run's worktree
    const report = await runValidationChecks(worktree, [check])
    expect(report.results[0], JSON.stringify(report.results[0])).toMatchObject({ status: 'passed', testsPassed: 3, testsFailed: 0 })
    expect(readFileSync(path.join(worktree, 'executed-tests.txt'), 'utf8')).toBe('012')
    expect(existsSync(path.join(repo, 'executed-tests.txt'))).toBe(false)
    write(worktree, 'test/smoke.test.cjs', `const { test } = require('node:test'); const assert = require('node:assert/strict'); test('real failure', () => assert.equal(1, 2));\n`)
    const failed = await runValidationChecks(worktree, [check])
    expect(failed.results[0]).toMatchObject({ status: 'failed', testsPassed: 0, testsFailed: 1 })
    expect(failed.results[0]!.output).toContain('real failure')
    await plugins.selectExtension('repositoryAnalyzers', null)
    await plugins.selectExtension('testRunners', null)
  }, 120_000)

  it('language integration: JSON diagnostics in the IDE; other files fall back to the built-in server', async () => {
    await plugins.selectExtension('languageIntegrations', { plugin: ID, id: 'json-diagnostics' })
    const result = await ide.fileDiagnostics(projectId, 'broken.json')
    expect(result.semantic).toBe(false)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({ severity: 'error', source: 'json', line: 4 })
    expect((await ide.fileDiagnostics(projectId, 'broken.json', '{"ok": true}')).diagnostics).toEqual([])
    // .ts is declined by the plugin ({ unsupported: true }) → the bundled TypeScript service answers
    const ts = await ide.fileDiagnostics(projectId, 'src/index.ts', 'export const value: number = "x"\n')
    expect(ts.semantic).toBe(true)
    expect(ts.diagnostics.some((diagnostic) => /not assignable/.test(diagnostic.message))).toBe(true)
    await plugins.selectExtension('languageIntegrations', null)
  }, 120_000)

  it('git integration: status, diff and branches equal the built-in git view', async () => {
    await plugins.selectExtension('gitIntegrations', { plugin: ID, id: 'git-cli' })
    expect(await files.gitStatus(projectId)).toEqual(await plainFiles.gitStatus(projectId))
    expect(await files.gitDiff(projectId)).toEqual(await plainFiles.gitDiff(projectId))
    expect(await files.gitDiff(projectId, 'src/index.ts')).toEqual(await plainFiles.gitDiff(projectId, 'src/index.ts'))
    expect(await files.branches(projectId)).toEqual(await plainFiles.branches(projectId))
    expect((await files.branches(projectId)).map((branch) => branch.name).sort()).toEqual(['feature', 'main'])
    await plugins.selectExtension('gitIntegrations', null)
  }, 60_000)

  it('errors are clear, disabling never falls back silently, re-enabling restarts the host', async () => {
    await plugins.updateSettings(ID, { baseUrl: 'http://127.0.0.1:9/v1' })
    await expect(plugins.invokeExtension(ID, 'modelProviders', 'openai-compatible', 'models', {})).rejects.toThrow(/nicht erreichbar/)
    await plugins.updateSettings(ID, { baseUrl: 'http://example.com/v1' })
    await expect(plugins.invokeExtension(ID, 'modelProviders', 'openai-compatible', 'models', {})).rejects.toThrow(/Nur lokale Server/)
    await plugins.updateSettings(ID, { baseUrl })
    await plugins.selectExtension('gitIntegrations', { plugin: ID, id: 'git-cli' })
    await plugins.disable(ID)
    await expect(files.gitStatus(projectId)).rejects.toThrow(/unavailable/)
    await plugins.enable(ID)
    expect(await files.gitStatus(projectId)).toEqual(await plainFiles.gitStatus(projectId))
    await plugins.selectExtension('gitIntegrations', null)
  }, 60_000)
})
