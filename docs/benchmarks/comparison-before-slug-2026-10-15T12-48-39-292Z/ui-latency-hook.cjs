// Observation-only hooks, injected into the freshly built, unminified backend by
// ui-latency.mjs. No production source or execution/approval policy is changed.
const fs = require('node:fs')
const { AsyncLocalStorage } = require('node:async_hooks')

exports.install = function install(refs) {
  const file = process.env.MAC_LATENCY_TRACE
  const runId = process.env.MAC_LATENCY_RUN_ID
  const als = new AsyncLocalStorage()
  let seq = 0
  const emit = (name, data = {}) => fs.appendFileSync(file, JSON.stringify({ runId, source: 'backend', at: new Date().toISOString(), epochMs: performance.timeOrigin + performance.now(), name, parent: als.getStore(), ...data }) + '\n')
  const wrap = (name, fn, describe = () => ({}), summarize = () => ({})) => async function (...args) {
    const id = `b${++seq}`, parent = als.getStore(), started = performance.now()
    emit(`${name}.start`, { id, ...describe.call(this, args) })
    return als.run(id, async () => {
      try {
        const value = await fn.apply(this, args)
        emit(`${name}.end`, { id, parent, durationMs: performance.now() - started, ...summarize(value) })
        return value
      } catch (error) {
        emit(`${name}.error`, { id, parent, durationMs: performance.now() - started, error: String(error.stack ?? error) })
        throw error
      }
    })
  }
  const methods = (target, names, prefix) => {
    for (const name of names) if (typeof target[name] === 'function') target[name] = wrap(`${prefix}.${name}`, target[name], args => ({ args: args.map(a => typeof a === 'string' || typeof a === 'number' ? a : undefined) }))
  }
  methods(refs.executions, ['requestPlan', 'plan', 'start', 'runJob', 'approve', 'chat'], 'execution')
  methods(refs.executions.repoContext, ['index', 'digest', 'runContext', 'runChecks'], 'context')
  methods(refs.executions.localModels, ['warmup', 'engineProfiles', 'executionSlots'], 'models')
  methods(refs.WorktreeManager.prototype, ['create', 'prewarm', 'remove', 'acquirePooled'], 'worktree')
  methods(refs.ExecutionRunner.prototype, ['execute', 'executeTask', 'runLocal', 'runPremium', 'finalize', 'review', 'deterministicFix'], 'runner')
  methods(refs.WorkspaceFiles.prototype, ['read', 'list', 'write', 'edit', 'apply'], 'workspace')
  methods(refs.jobs, ['enqueue'], 'queue')
  const originalExecute = refs.jobs.execute
  refs.jobs.execute = function (job) {
    emit('queue.claim', { jobId: job.id, type: job.type, payload: job.payload, createdAt: job.createdAt, waitMs: Date.now() - new Date(job.createdAt).getTime() })
    return originalExecute.call(this, job)
  }
  const publish = refs.events.publish
  refs.events.publish = function (channel, type, data, subject) {
    emit('event.publish', { channel, type, data, subject })
    return publish.apply(this, arguments)
  }
  refs.app.use((req, res, next) => {
    if (req.originalUrl.startsWith('/events')) return next()
    const id = `http${++seq}`, started = performance.now()
    emit('api.receive', { id, method: req.method, path: req.originalUrl })
    res.on('finish', () => emit('api.finish', { id, method: req.method, path: req.originalUrl, status: res.statusCode, durationMs: performance.now() - started }))
    als.run(id, next)
  })
  for (const name of ['load', 'unload']) refs.OllamaClient.prototype[name] = wrap(`ollama.${name}`, refs.OllamaClient.prototype[name], args => ({ model: args[0], keepAlive: args[1], numCtx: args[2] }))
  const chat = refs.OllamaClient.prototype.chat
  refs.OllamaClient.prototype.chat = wrap('ollama.chat', async function (request, options) {
    // Observe bytes while passing the original response through to the original parser.
    const originalFetch = this.fetchImpl
    const started = performance.now()
    const calls = [], stream = { thinking: { chars: 0, chunks: 0 }, content: { chars: 0, chunks: 0 }, tools: { chunks: 0 } }
    this.fetchImpl = async (...args) => {
      const response = await originalFetch(...args)
      if (!String(args[0]).endsWith('/api/chat') || !response.body) return response
      let buffer = ''
      const consume = line => {
        if (!line.trim()) return
        const chunk = JSON.parse(line), t = performance.now() - started
        for (const key of ['thinking', 'content', 'tools']) {
          const value = key === 'tools' ? chunk.message?.tool_calls : chunk.message?.[key]
          if (value?.length) {
            const phase = stream[key]
            phase.firstMs ??= t; phase.lastMs = t; phase.chunks++
            if (key !== 'tools') phase.chars += value.length
          }
        }
        if (chunk.message?.tool_calls) calls.push(...chunk.message.tool_calls)
        if (chunk.done) emit('ollama.server_metrics', { actualModel: chunk.model, promptTokens: chunk.prompt_eval_count, completionTokens: chunk.eval_count, totalMs: chunk.total_duration / 1e6, loadMs: chunk.load_duration / 1e6, promptEvalMs: chunk.prompt_eval_duration / 1e6, evalMs: chunk.eval_duration / 1e6, doneReason: chunk.done_reason, stream, toolCalls: calls })
      }
      const decoder = new TextDecoder()
      const body = response.body.pipeThrough(new TransformStream({
        transform(bytes, controller) { buffer += decoder.decode(bytes, { stream: true }); let end; while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1) } controller.enqueue(bytes) },
        flush() { buffer += decoder.decode(); consume(buffer) },
      }))
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
    try { return await chat.call(this, request, options) }
    finally { this.fetchImpl = originalFetch }
  }, args => ({ requestedModel: args[0].model, settings: args[0].options, think: args[0].think, keepAlive: args[0].keep_alive, structured: Boolean(args[0].format), messageChars: args[0].messages.map(m => ({ role: m.role, chars: m.content.length })), toolNames: args[0].tools?.map(t => t.function.name) }), value => ({ promptTokens: value.promptTokens, completionTokens: value.completionTokens, totalDurationMs: value.totalDurationMs, loadDurationMs: value.loadDurationMs }))
  for (const name of ['createPlan', 'executeComplexTask', 'reviewResult', 'analyzeTask', 'chat']) {
    refs.CodexAdapter.prototype[name] = wrap(`codex.${name}`, refs.CodexAdapter.prototype[name], function (args) { return { configuredModel: this.options.model, effort: args[1]?.effort, run: args[1]?.runId, limits: args[1]?.limits } }, result => ({ meta: result.meta, result: result.result }))
  }
  const jsonl = refs.CodexAdapter.prototype.runJsonl
  refs.CodexAdapter.prototype.runJsonl = function (args, ctx, prompt, callback) {
    emit('codex.cli.start', { args, promptChars: prompt.length })
    return jsonl.call(this, args, ctx, prompt, event => {
      emit('codex.cli.event', { type: event.type, threadId: event.thread_id, returnedModel: event.model, usage: event.usage, itemType: event.item?.type, chars: event.item?.text?.length, command: event.item?.command, exitCode: event.item?.exit_code })
      return callback(event)
    })
  }
  emit('instrumentation.ready', { pid: process.pid })
  return { emit, wrap }
}
