// Offline reconstruction of the two published feature samples. No inference.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const dir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dir, '../..')
const source = path.join(root, '.cache/task-latency-after-release.json')
const data = JSON.parse(fs.readFileSync(source))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const samples = data.samples.filter(s => s.name === 'feature')
const evidence = samples.map(s => {
  const file = path.join(s.artifacts, 'responses.jsonl'), bytes = fs.readFileSync(file)
  const responses = bytes.toString().trim().split('\n').map(line => JSON.parse(line))
  const rawName = `historical-feature-${s.repeat}-responses.jsonl`
  fs.writeFileSync(path.join(dir, rawName), bytes)
  const repair = s.attempts[1], call = s.modelCalls[1]
  const checksMs = repair.validation.results.reduce((n, r) => n + r.durationMs, 0)
  const repairResponses = responses.slice(1)
  const recordedServerMs = repairResponses.reduce((n, r) => n + r.response.totalDurationMs, 0)
  return {
    historicalRunId: `task-latency-2026-10-15/after-release/feature/${s.repeat}`,
    source, sourceSha256: sha(fs.readFileSync(source)), originalResponses: file, preservedResponses: rawName, responsesSha256: sha(bytes),
    totalMs: s.totalMs, firstAgentMs: s.modelCalls[0].durationMs, firstAttemptMs: s.attempts[0].durationMs,
    firstFailure: s.attempts[0].validation,
    firstOperations: JSON.parse(responses[0].response.message.content).operations,
    repairAgentMs: call.durationMs, repairAttemptMs: repair.durationMs, repairChecksMs: checksMs,
    repairAttemptRemainderMs: repair.durationMs - call.durationMs - checksMs,
    totalOutsideAttemptsMs: s.totalMs - s.attempts.reduce((n, a) => n + a.durationMs, 0),
    finalChecksMs: s.finalValidation.results.reduce((n, r) => n + r.durationMs, 0),
    recordedRepairServerMs: recordedServerMs,
    repairAgentMinusRecordedServerMs: call.durationMs - recordedServerMs,
    // This residual is NOT a context, thinking or tool measurement.
    calls: responses.map((r, index) => ({
      index, request: r.request, requestedModelFromSeries: data.model, actualReturnedModel: null,
      promptTokens: r.response.totalDurationMs ? r.response.promptTokens : null,
      completionTokens: r.response.totalDurationMs ? r.response.completionTokens : null,
      serverTotalMs: r.response.totalDurationMs || null, loadMs: r.response.totalDurationMs ? r.response.loadDurationMs : null,
      promptEvalMs: null, evalMs: null, thinkingDurationMs: null, contentDurationMs: null, toolDurationMs: null,
      reportedThinkingChars: r.response.message.thinking?.length ?? 0,
      contentChars: r.response.message.content.length,
      toolCalls: r.response.message.tool_calls ?? [],
      hasFinalMetrics: Boolean(r.response.totalDurationMs),
    })),
    repairValidation: repair.validation, finalValidation: s.finalValidation,
    gaps: ['Historical client discarded prompt_eval_duration and eval_duration.', 'No per-chunk timestamps or per-tool durations retained.', 'No returned model identifier/digest retained per response; qwen3:4b comes from requested model/series.', 'think=false was requested; no separate thinking field is stored. Long reasoning-like prose appears in content; its time/tokens cannot be separated from other output.', ...(s.repeat === 1 ? ['First repair HTTP response has 26880 content characters but zero/absent terminal metrics. Treat its token counts and server time as unknown, not zero. Missing done event cannot be proven without the original wire stream.'] : [])],
  }
})
fs.writeFileSync(path.join(dir, 'feature-repair-analysis-2026-10-15.json'), JSON.stringify({ analyzedAt: new Date().toISOString(), evidence }, null, 2))
console.log(JSON.stringify(evidence.map(({ historicalRunId, firstAgentMs, repairAgentMs, repairAttemptMs, repairChecksMs, repairAttemptRemainderMs, recordedRepairServerMs, repairAgentMinusRecordedServerMs }) => ({ historicalRunId, firstAgentMs, repairAgentMs, repairAttemptMs, repairChecksMs, repairAttemptRemainderMs, recordedRepairServerMs, repairAgentMinusRecordedServerMs })), null, 2))
