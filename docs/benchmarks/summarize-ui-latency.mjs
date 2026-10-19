import fs from 'node:fs'
import path from 'node:path'
const folder = path.resolve(process.argv[2])
const events = fs.readFileSync(path.join(folder, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).sort((a,b) => a.epochMs - b.epochMs)
const find = (name, predicate = () => true) => events.find(e => e.name === name && predicate(e))
const submit = find('ui.click', e => e.label === 'Senden')
if (!submit) throw new Error('No submitted UI task')
const origin = submit.rendererEpochMs
const time = e => e.rendererEpochMs ?? e.epochMs
const relative = e => Math.round((time(e) - origin) * 1000) / 1000
const names = ['ui.click','ui.plan.visible','plan.review.start','plan.review.approved','queue.claim','execution.plan.start','context.digest.start','context.digest.end','codex.createPlan.start','codex.createPlan.end','ollama.load.start','ollama.load.end','runner.execute.start','context.digest.engine.start','context.digest.engine.end','context.preload.start','context.preload.end','ollama.chat.start','ollama.chat.end','tool.call.start','tool.call.end','validation.start','validation.end','integration.cherryPick.start','integration.cherryPick.end','runner.review.start','runner.review.end','runner.finalize.start','runner.finalize.end','execution.chat.start','execution.chat.end','ui.approval.dom','ui.approval.paintOpportunity','ui.ready.visible','result.review.approved','run.complete']
const callStarts = events.filter(e => e.name === 'ollama.chat.start')
const localCalls = callStarts.map(start => {
  const end = find('ollama.chat.end', e => e.id === start.id)
  const server = find('ollama.server_metrics', e => e.parent === start.id)
  return { id: start.id, startMs: relative(start), endMs: end && relative(end), requestedModel: start.requestedModel, actualModel: server?.actualModel ?? null, settings: start.settings, think: start.think, structured: start.structured, toolNames: start.toolNames, wallMs: end?.durationMs ?? null, promptTokens: server?.promptTokens ?? null, completionTokens: server?.completionTokens ?? null, loadMs: server?.loadMs ?? null, contextProcessingMs: server?.promptEvalMs ?? null, decodeMs: server?.evalMs ?? null, serverTotalMs: server?.totalMs ?? null, serverResidualMs: server && server.totalMs - server.loadMs - server.promptEvalMs - server.evalMs, stream: server?.stream, gaps: server ? ['Thinking/output timings are streamed phase envelopes, not GPU compute partitions. evalMs combines all generated token types.'] : ['Terminal Ollama metrics missing; token counts are unknown, not zero.'] }
})
const summary = {
  runId: submit.runId, submitAt: new Date(origin).toISOString(), readyAt: find('ui.ready.visible')?.at,
  observedEndToEndMs: find('ui.ready.visible') ? time(find('ui.ready.visible')) - origin : null,
  paintOpportunityEndToEndMs: find('ui.approval.paintOpportunity') ? time(find('ui.approval.paintOpportunity')) - origin : null,
  planVisibleMs: find('ui.plan.visible') && relative(find('ui.plan.visible')),
  planApprovalClickMs: find('ui.click', e => e.label === 'Ausführung starten') && relative(find('ui.click', e => e.label === 'Ausführung starten')),
  preparationAndApprovalDwellMs: find('ui.click', e => e.label === 'Ausführung starten') && time(find('ui.click', e => e.label === 'Ausführung starten')) - time(find('ui.plan.visible')),
  appStartupMs: time(find('app.runtime.ready')) - time(find('app.launch.start')),
  localCalls,
  premiumCalls: events.filter(e => /^codex\.(createPlan|reviewResult|executeComplexTask|analyzeTask|chat)\.end$/.test(e.name)).map(e => ({ id: e.id, name: e.name, durationMs: e.durationMs, meta: e.meta, result: e.result, modelIdentitySource: 'Pinned CLI argument and adapter meta; CLI emitted no independent server model ID.' })),
  queueClaims: events.filter(e => e.name === 'queue.claim'),
  timeline: events.filter(e => names.includes(e.name)).map(e => ({ startMs: relative(e), ...e, epochMs: undefined, runId: undefined, source: undefined, result: e.name === 'tool.call.end' ? e.result : undefined })),
  apiRequests: events.filter(e => e.name === 'api.receive').map(start => { const end = find('api.finish', e => e.id === start.id); return { id: start.id, startMs: relative(start), method: start.method, path: start.path, durationMs: end?.durationMs, status: end?.status } }),
  gaps: ['No compositor/pixel-present timestamp. Endpoint is the real visible approval UI; double requestAnimationFrame marks a paint opportunity, followed by a screenshot.', 'UI click to HTTP receive includes renderer handler, preload IPC, main bridge and loopback transport; these are not separately instrumented.', 'Premium API prefill/thinking/output token split and server latency are not exposed by the CLI.', 'Hooks add synchronous JSONL writes and stream parsing; observer overhead has not been measured against an uninstrumented control.', 'Historical samples and the real application differ: the application exposes skill tools, so this run uses tools mode from its first local call.'],
}
fs.writeFileSync(path.join(folder, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ runId: summary.runId, observedEndToEndMs: summary.observedEndToEndMs, paintOpportunityEndToEndMs: summary.paintOpportunityEndToEndMs, appStartupMs: summary.appStartupMs, localCalls, premiumCalls: summary.premiumCalls.map(c => ({ name: c.name, ms: c.durationMs, meta: c.meta })) }, null, 2))
