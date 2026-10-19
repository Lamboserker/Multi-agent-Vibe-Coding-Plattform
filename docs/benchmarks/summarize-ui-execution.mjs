// All missing counters remain null (unknown), never inferred as zero.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.dirname(fileURLToPath(import.meta.url))
const folders = process.argv.slice(2)
const runs = []
for (const name of folders.length ? folders : fs.readdirSync(root).filter(name => name.startsWith('comparison-'))) {
  const dir = path.resolve(root, name)
  const rows = fs.readFileSync(path.join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const find = (name, predicate = () => true) => rows.find(row => row.name === name && predicate(row))
  const submit = find('ui.click', row => row.label === 'Senden')
  const ready = find('ui.ready.visible')
  const complete = find('run.complete')
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'build.json')))
  const local = rows.filter(row => row.name === 'ollama.chat.start').map(start => {
    const end = find('ollama.chat.end', row => row.id === start.id)
    const metrics = find('ollama.server_metrics', row => row.parent === start.id)
    return { model: start.requestedModel, options: start.settings, think: start.think ?? null, keepAlive: start.keepAlive ?? null,
      structured: start.structured, durationMs: end?.durationMs ?? null, outputTokens: metrics?.completionTokens ?? null,
      inputTokens: metrics?.promptTokens ?? null, doneReason: metrics?.doneReason ?? null, toolNames: start.toolNames ?? [],
      contentChars: metrics?.stream?.content?.chars ?? null }
  })
  const premium = rows.filter(row => /^codex\.(createPlan|executeComplexTask|reviewResult|chat|analyzeTask)\.start$/.test(row.name))
    .map(start => { const row = find(start.name.replace(/start$/, 'end'), row => row.id === start.id); return { name: start.name, model: row?.meta?.model ?? start.configuredModel ?? null, effort: start.effort ?? null, outputTokens: row?.meta?.usage?.measured ? row.meta.usage.outputTokens : null, durationMs: row?.durationMs ?? null } })
  const agentRounds = rows.filter(row => row.name === 'runner.runLocal.start')
  const tokens = calls => calls.every(call => call.outputTokens !== null) ? calls.reduce((sum, call) => sum + call.outputTokens, 0) : null
  const run = { folder: path.basename(dir), phase: manifest.phase, scenario: manifest.scenario,
    success: Boolean(complete?.success), error: find('run.error')?.error ?? null,
    totalMs: submit && ready ? ready.rendererEpochMs - submit.rendererEpochMs : null,
    localMs: local.every(call => call.durationMs !== null) ? local.reduce((sum, call) => sum + call.durationMs, 0) : null,
    localOutputTokens: local.length ? tokens(local) : null,
    allOutputTokens: local.length && premium.length ? tokens([...local, ...premium]) : null,
    modelCalls: local.length + premium.length, localModelCalls: local.length, premiumModelCalls: premium.length,
    repairs: agentRounds.length ? agentRounds.filter(row => row.args?.[6] > 0).length + rows.filter(row => row.name === 'runner.runPremium.start' && row.args?.[5] > 0).length : null,
    controlledFaults: rows.filter(row => row.name === 'benchmark.fault').length,
    agentCapabilities: rows.filter(row => row.name === 'agent.local.start').map(row => ({ availableTools: row.availableTools ?? null, instructionChars: row.instructionChars ?? null, preferStructured: row.preferStructured ?? null })),
    local, premium,
  }
  fs.writeFileSync(path.join(dir, 'comparison-summary.json'), JSON.stringify(run, null, 2))
  runs.push(run)
}
const mean = values => values.length && values.every(value => value !== null) ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const groups = []
for (const phase of ['before', 'after']) for (const scenario of ['slug', 'clamp', 'repair']) {
  const selected = runs.filter(run => run.phase === phase && run.scenario === scenario)
  if (!selected.length) continue
  groups.push({ phase, scenario, n: selected.length, successful: selected.filter(run => run.success).length,
    totalMs: mean(selected.map(run => run.totalMs)), localMs: mean(selected.map(run => run.localMs)),
    localOutputTokens: mean(selected.map(run => run.localOutputTokens)), allOutputTokens: mean(selected.map(run => run.allOutputTokens)),
    modelCalls: mean(selected.map(run => run.modelCalls)), repairs: mean(selected.map(run => run.repairs)) })
}
const aggregate = ['before', 'after'].map(phase => {
  const selected = runs.filter(run => run.phase === phase)
  const sum = key => selected.length && selected.every(run => run[key] !== null) ? selected.reduce((total, run) => total + run[key], 0) : null
  return { phase, n: selected.length, successful: selected.filter(run => run.success).length,
    meanTotalMs: mean(selected.map(run => run.totalMs)), totalMs: sum('totalMs'), localMs: sum('localMs'),
    localOutputTokens: sum('localOutputTokens'), allOutputTokens: sum('allOutputTokens'),
    modelCalls: sum('modelCalls'), localModelCalls: sum('localModelCalls'), premiumModelCalls: sum('premiumModelCalls'), repairs: sum('repairs') }
})
fs.writeFileSync(path.join(root, 'ui-execution-comparison.json'), JSON.stringify({ recordedAt: new Date().toISOString(), aggregate, groups, runs }, null, 2))
console.table(groups)
console.table(aggregate)
