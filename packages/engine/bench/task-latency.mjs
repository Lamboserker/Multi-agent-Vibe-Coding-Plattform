// Real task -> plan -> isolated edits -> checks -> integration -> checks.
// Build first. No downloads, training or API keys needed. Uses installed models/CLI logins.
// node packages/engine/bench/task-latency.mjs --model <installed> --planner none|codex|claude-code --label before
// --engine <dist/index.js> permits an unchanged baseline; --scenario fix|feature|refactor.
// --plan-only true isolates premium planning. --cold true includes local model load in totalMs.
// Run inference benchmarks serially on an otherwise idle Ollama endpoint.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const args = Object.fromEntries(process.argv.slice(2).reduce((all, arg, i, argv) => arg.startsWith('--') ? [...all, [arg.slice(2), argv[i + 1]]] : all, []))
if (!args.model) throw new Error('Pass --model with an installed model name.')
const engine = await import(args.engine ? pathToFileURL(path.resolve(args.engine)).href : new URL('../dist/index.js', import.meta.url).href)
const client = new engine.OllamaClient(args.ollama ?? 'http://127.0.0.1:11434')
const show = await client.show(args.model)
const planner = args.planner === 'codex' ? new engine.CodexAdapter({ model: args['planner-model'] }) : args.planner === 'claude-code' ? new engine.ClaudeCodeAdapter({ model: args['planner-model'] }) : undefined
const syntax = "import { readdirSync } from 'node:fs'; import { execFileSync } from 'node:child_process'; for (const f of readdirSync('src')) if (f.endsWith('.mjs')) execFileSync(process.execPath, ['--check', 'src/' + f]);"
const fixtures = {
  fix: {
    goal: 'Fix clamp in src/math.mjs: return min for values below min, max for values above max, and the value otherwise. Preserve the exports. Do not change tests. One task is sufficient.',
    files: { 'src/math.mjs': 'export const clamp = (value, min, max) => Math.max(max, Math.min(min, value))\n', 'test/math.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { clamp } from '../src/math.mjs'; test('bounds and interior', () => { for (const [v, expected] of [[-2,0],[0,0],[3,3],[10,10],[12,10]]) assert.equal(clamp(v,0,10), expected) });\n" },
    targets: ['src/math.mjs'], newFiles: [],
  },
  feature: {
    goal: 'Implement an exported slugify(text) function in a new src/slug.mjs and re-export it from src/index.mjs. Lowercase ASCII text, trim it, replace each group of non-alphanumeric characters by one hyphen, remove leading/trailing hyphens. Empty input returns an empty string. Do not change tests. Implement both files in one task.',
    files: { 'src/index.mjs': 'export const version = 1\n', 'test/slug.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { slugify, version } from '../src/index.mjs'; test('slugify', () => { assert.equal(version,1); for (const [v,e] of [[' Hello, WORLD! ','hello-world'],['',''],['---',''],['a__b  c','a-b-c']]) assert.equal(slugify(v),e) });\n" },
    targets: ['src/index.mjs'], newFiles: ['src/slug.mjs'],
  },
  refactor: {
    goal: 'Remove duplicate VAT calculations: export withVat(net, rate) from new src/tax.mjs returning net * (1 + rate). Change src/invoice.mjs and src/quote.mjs to import and use that helper with rate 0.19. Preserve their existing exports and behavior. Do not change tests. Use one task for this small refactor.',
    files: { 'src/invoice.mjs': 'export const invoiceTotal = (net) => net * 1.19\n', 'src/quote.mjs': 'export const quoteTotal = (net) => net * 1.19\n', 'test/tax.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { invoiceTotal } from '../src/invoice.mjs'; import { quoteTotal } from '../src/quote.mjs'; import { withVat } from '../src/tax.mjs'; test('totals', () => { for (const n of [0,10,100]) { assert.equal(invoiceTotal(n),n*1.19); assert.equal(quoteTotal(n),n*1.19); } assert.equal(withVat(100,0.07),107) });\n" },
    targets: ['src/invoice.mjs', 'src/quote.mjs'], newFiles: ['src/tax.mjs'],
  },
}
if (args.planner && !['none', 'codex', 'claude-code'].includes(args.planner)) throw new Error('Unknown planner')
if (args.scenario && !fixtures[args.scenario]) throw new Error('Unknown scenario')
if (!Number.isSafeInteger(Number(args.repeats ?? 1)) || Number(args.repeats ?? 1) < 1) throw new Error('repeats must be a positive integer')
const samples = []
const hardware = await engine.detectHardware()
for (let repeat = 0; repeat < Number(args.repeats ?? 1); repeat++) for (const [name, fixture] of Object.entries(fixtures)) {
  if (args.scenario && name !== args.scenario) continue
  const root = mkdtempSync(path.join(os.tmpdir(), 'mac-latency-'))
  const repo = path.join(root, 'repo')
  mkdirSync(repo)
  const files = { ...fixture.files, 'package.json': JSON.stringify({ name: 'latency-fixture', type: 'module', scripts: { test: 'node --test', typecheck: 'node syntax.mjs' } }), 'syntax.mjs': syntax }
  // Irrelevant code makes context selection measurable without changing task difficulty.
  for (let i = 0; i < 24; i++) files[`src/unrelated${i}.mjs`] = Array.from({ length: 80 }, (_, n) => `export const unrelated${i}_${n} = ${n}`).join('\n') + '\n'
  for (const [file, content] of Object.entries(files)) { mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); writeFileSync(path.join(repo, file), content) }
  const git = (...argv) => execFileSync('git', argv, { cwd: repo, stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('-c', 'user.name=Benchmark', '-c', 'user.email=bench@localhost', 'commit', '-qm', 'fixture')
  const calls = [], attempts = [], events = []
  const state = {}
  const store = { async updateRun(id, patch) { Object.assign(state, patch) }, async updateTask() {}, async startAttempt(input) { attempts.push({ ...input }); return String(attempts.length - 1) }, async finishAttempt(id, value) { Object.assign(attempts[Number(id)], value) }, async recordModelCall(call) { calls.push(call); console.error(JSON.stringify({ phase: 'model', scenario: name, durationMs: call.durationMs, status: call.status })) }, emit(event) { events.push(event) } }
  const measuredClient = { async chat(request, options) {
    const response = await client.chat(request, options)
    appendFileSync(path.join(root, 'responses.jsonl'), JSON.stringify({ request: { think: request.think, structured: Boolean(request.format), context: request.options?.num_ctx }, response }) + '\n')
    return response
  } }
  const numCtx = Number(args.context ?? 16384)
  if (args['plan-only'] !== 'true') {
    if (args.cold === 'true') await client.unload(args.model)
    else await client.load(args.model, '15m', numCtx)
  }
  const started = performance.now()
  let planningMs = 0, contextTokens = 0, planUsage, outcome, error
  try {
    const index = await engine.buildRepoIndex(repo)
    const checks = engine.detectValidationChecks(repo)
    const planStart = performance.now()
    let plan
    if (planner) {
      const options = engine.planningContextOptions?.(fixture.goal) ?? { budgetTokens: 18000, excerptFiles: 12, excerptChars: 20000, excerptMaxLines: 500, fillUnranked: true }
      const context = await engine.buildContextDigest(index, fixture.goal, { ...options, validationCommands: checks.map(c => c.command) })
      contextTokens = context.tokenEstimate
      const result = await planner.createPlan({ goal: fixture.goal, context, costMode: 'balanced', maxTasks: 3, localModels: [{ model: args.model, role: 'fast/balanced/advanced', toolCalling: show.capabilities?.includes('tools'), strengths: [] }] }, { runId: `bench-plan-${Date.now()}`, cwd: repo, effort: 'low', timeoutMs: 180000, onEvent(e) { if (e.type === 'tool' || e.type === 'command') events.push(e) } })
      plan = result.result
      planUsage = result.meta.usage
    } else plan = { tasks: [{ id: 'task-001', title: name, description: fixture.goal, category: 'general', complexity: 2, risk: 1, relevantFiles: fixture.targets, newFiles: fixture.newFiles, dependsOn: [], acceptanceCriteria: ['The requested behavior passes the existing tests.'], expectedInputTokens: 2000, suggestedExecutor: 'local' }] }
    planningMs = performance.now() - planStart
    if (!plan.tasks.length || plan.tasks.some(t => !t.description || !t.acceptanceCriteria.length)) throw new Error('Planner produced no actionable tasks')
    if (args['plan-only'] !== 'true') {
    const tasks = plan.tasks.map((t, i) => ({ ...t, id: `db-${t.id}`, key: t.id, status: 'planned', priority: plan.tasks.length - i, manualModel: args.model }))
    const runner = new engine.ExecutionRunner({ id: `bench-${Date.now()}`, projectKey: 'bench', repoPath: repo, goal: fixture.goal }, tasks, { store, worktrees: new engine.WorktreeManager({ root: path.join(root, 'wt') }), ollama: client, localClientFor: () => measuredClient, localModels: [{ model: args.model, roles: ['fast', 'balanced', 'advanced'], available: true, toolCalling: show.capabilities?.includes('tools') ?? false, thinking: show.capabilities?.includes('thinking') ?? false, contextWindow: numCtx }], checks, index, stats: [], settings: { ...engine.DEFAULT_ENGINE_SETTINGS, numCtx, maxLocalRepairs: 2, premiumExecutionAllowed: false } })
    outcome = await runner.execute()
    // Quality gate beyond runner status: final checks and original tests unchanged.
    if (outcome.status !== 'awaiting_approval' || outcome.failedTasks.length || !outcome.finalValidation?.ok) throw new Error(`Task failed: ${outcome.status}; ${outcome.failedTasks}`)
    for (const [file, content] of Object.entries(fixture.files)) if (file.startsWith('test/') && readFileSync(path.join(state.integrationWorktree, file), 'utf8').replaceAll('\r\n', '\n') !== content) throw new Error('Model changed the acceptance tests')
    if (git('status', '--porcelain').toString().trim()) throw new Error('User checkout was modified')
    }
  } catch (e) { error = String(e.stack ?? e) }
  const sample = { name, repeat, success: !error, totalMs: Math.round(performance.now() - started), planningMs: Math.round(planningMs), contextTokens, planUsage, modelCalls: calls.map(c => ({ model: c.model, durationMs: c.durationMs, status: c.status, usage: c.usage })), attempts: attempts.map(a => ({ model: a.model, outcome: a.outcome, durationMs: a.durationMs, logs: a.logs, validation: a.validation })), finalValidation: outcome?.finalValidation, tools: events.filter(e => e.type === 'tool_call' || e.type === 'tool' || e.type === 'command').length, error, artifacts: root }
  samples.push(sample)
  console.log(JSON.stringify({ ...sample, attempts: sample.attempts.map(a => ({ model: a.model, outcome: a.outcome, durationMs: a.durationMs })), finalValidation: sample.finalValidation?.summary }))
  const output = path.resolve(args.output ?? `.cache/task-latency-${args.label ?? 'run'}.json`)
  mkdirSync(path.dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify({ label: args.label, model: args.model, planner: args.planner ?? 'none', plannerModel: args['planner-model'] ?? 'CLI default', cold: args.cold === 'true', context: numCtx, hardware, samples }, null, 2))
}
if (samples.some(s => !s.success)) process.exitCode = 1
