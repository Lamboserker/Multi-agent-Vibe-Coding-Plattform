import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Scripted stand-in for the Ollama HTTP API used by unit/integration tests.
 * It is a MOCK: it proves the engine's control flow, not model quality.
 */
export interface FakeChatRequest {
  model: string
  messages: Array<{ role: string; content: string; tool_name?: string; tool_calls?: unknown[] }>
  tools?: unknown[]
  format?: unknown
}

export type FakeChatReply =
  | { content?: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; stallMs?: number; error?: string; status?: number }

export interface FakeOllama {
  url: string
  requests: FakeChatRequest[]
  close(): Promise<void>
}

export async function startFakeOllama(options: {
  models?: Array<{ name: string; size: number; capabilities?: string[] }>
  chat: (request: FakeChatRequest, index: number) => FakeChatReply
}): Promise<FakeOllama> {
  const requests: FakeChatRequest[] = []
  const models = options.models ?? [{ name: 'fake-coder:1b', size: 1_000_000_000, capabilities: ['completion', 'tools'] }]
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', async () => {
      const url = req.url ?? ''
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (url === '/api/version') return json({ version: '0.0.0-fake' })
      if (url === '/api/tags') return json({ models: models.map((model) => ({ name: model.name, model: model.name, size: model.size, digest: 'x', modified_at: new Date().toISOString() })) })
      if (url === '/api/ps') return json({ models: models.slice(0, 1).map((model) => ({ name: model.name, model: model.name, size: model.size, size_vram: model.size, expires_at: '' })) })
      if (url === '/api/show') {
        const request = JSON.parse(body || '{}') as { model?: string }
        const model = models.find((candidate) => candidate.name === request.model)
        return model ? json({ capabilities: model.capabilities ?? ['completion'], model_info: { 'fake.context_length': 32768 } }) : json({ error: 'model not found' }, 404)
      }
      if (url === '/api/generate') return json({ done: true })
      if (url === '/api/chat') {
        const request = JSON.parse(body) as FakeChatRequest
        const index = requests.length
        requests.push(request)
        const reply = options.chat(request, index)
        if (reply.error) return json({ error: reply.error }, reply.status ?? 500)
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        if (reply.stallMs) {
          res.write(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: false })}\n`)
          await new Promise((resolve) => setTimeout(resolve, reply.stallMs))
        }
        const message: Record<string, unknown> = { role: 'assistant', content: reply.content ?? '' }
        if (reply.toolCalls?.length) message.tool_calls = reply.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } }))
        res.write(`${JSON.stringify({ message, done: false })}\n`)
        res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 120, eval_count: 40, total_duration: 5_000_000 })}\n`)
        return
      }
      json({ error: 'not found' }, 404)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
