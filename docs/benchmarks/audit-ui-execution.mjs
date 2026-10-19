import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const selected = JSON.parse(fs.readFileSync(path.join(root, 'ui-execution-selection.json'), 'utf8'))
const fixtureHashes = new Map(), bundleHashes = new Map(), counts = new Map()
const hash = value => createHash('sha256').update(value).digest('hex')
const audited = []
for (const folder of selected.runs) {
  const dir = path.join(root, folder)
  const fixture = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json')))
  const build = JSON.parse(fs.readFileSync(path.join(dir, 'build.json')))
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'comparison-summary.json')))
  const rows = fs.readFileSync(path.join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(summary.modelCalls, rows.filter(row => row.name === 'ollama.chat.start' || row.name === 'codex.cli.start').length, 'actual inference/CLI invocations match reported model calls')
  const runtime = JSON.parse(fs.readFileSync(path.join(dir, 'ollama-runtime.json')))
  assert.equal(runtime.tags.models.find(model => model.name === 'qwen3:4b')?.digest, '359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7')
  for (const call of summary.local) {
    assert.equal(call.model, 'qwen3:4b')
    assert.equal(call.options.num_ctx, 16384)
    assert.ok([0.15, 0.35].includes(call.options.temperature))
    assert.equal(call.think, false)
    assert.equal(call.keepAlive, '15m')
    if (build.phase === 'after') assert.equal(call.options.num_predict, 2048)
    else assert.equal(call.options.num_predict, undefined)
  }
  for (const call of summary.premium) assert.equal(call.model, 'gpt-6-astra')
  const fixtureHash = hash(JSON.stringify(fixture))
  if (fixtureHashes.has(build.scenario)) assert.equal(fixtureHash, fixtureHashes.get(build.scenario), 'same task and every fixture file in both phases')
  fixtureHashes.set(build.scenario, fixtureHash)
  const bundleHash = build.executedBackendSha256 ?? build.buildArtifacts['apps/desktop/dist/backend/main.cjs']
  if (bundleHashes.has(build.phase)) assert.equal(bundleHash, bundleHashes.get(build.phase), 'one build per phase')
  bundleHashes.set(build.phase, bundleHash)
  const group = build.phase + '/' + build.scenario
  counts.set(group, (counts.get(group) ?? 0) + 1)
  if (summary.success) {
    const execution = JSON.parse(fs.readFileSync(path.join(dir, 'execution.json')))
    assert.equal(execution.finalValidation.ok, true)
    assert.ok(execution.finalValidation.results.length >= 2)
    assert.ok(execution.finalValidation.results.every(check => check.status === 'passed'))
    assert.ok(rows.some(row => row.name === 'result.review.approved' && row.testsUnchanged && row.userCheckoutClean))
    assert.ok(rows.some(row => row.name === 'ui.click' && row.label === 'In Arbeitskopie übernehmen'))
    const tests = fs.readFileSync(path.join(build.repo, 'test/slug.test.mjs'), 'utf8').replaceAll('\r\n', '\n')
    assert.equal(tests, fixture.files['test/slug.test.mjs'])
    assert.ok(fs.existsSync(path.join(dir, 'post-apply-tests.txt')))
    if (build.scenario === 'repair') {
      assert.equal(summary.controlledFaults, 1)
      assert.ok(summary.repairs >= 1)
    }
  }
  audited.push({ folder, success: summary.success, fixtureSha256: fixtureHash, executedBackendSha256: bundleHash })
}
for (const phase of ['before', 'after']) for (const scenario of ['slug', 'clamp', 'repair']) assert.equal(counts.get(phase + '/' + scenario), 2)
assert.notEqual(bundleHashes.get('before'), bundleHashes.get('after'))
fs.writeFileSync(path.join(root, 'ui-execution-audit.json'), JSON.stringify({ ok: true, audited }, null, 2))
console.log('Audited:', audited.length, 'runs; identical fixtures, unchanged acceptance tests, fixed builds and real UI approvals.')
