/**
 * Minimal, dependency-free client for the documented Ollama HTTP API
 * (https://github.com/ollama/ollama/blob/main/docs/api.md).
 */

export interface OllamaModelSummary {
  name: string
  model: string
  size: number
  digest: string
  modified_at: string
  details?: { family?: string; parameter_size?: string; quantization_level?: string; format?: string }
}

export interface OllamaShowResponse {
  capabilities?: string[]
  details?: { family?: string; parameter_size?: string; quantization_level?: string }
  model_info?: Record<string, unknown>
  parameters?: string
  template?: string
  license?: string
}

export interface OllamaRunningModel {
  name: string
  model: string
  size: number
  size_vram: number
  expires_at: string
  context_length?: number
}

export interface OllamaToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> | string }
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
  tool_name?: string
  thinking?: string
}

export interface OllamaChatRequest {
  model: string
  messages: OllamaMessage[]
  tools?: OllamaToolDefinition[]
  /** "json" or a JSON schema for structured outputs. */
  format?: 'json' | Record<string, unknown>
  options?: { num_ctx?: number; temperature?: number; num_predict?: number; seed?: number; top_p?: number }
  keep_alive?: string | number
  think?: boolean
}

export interface OllamaChatResult {
  message: OllamaMessage
  promptTokens: number
  completionTokens: number
  totalDurationMs: number
  loadDurationMs: number
  doneReason?: string
}

/** Actual first streamed model output; no prompt/response contents are retained. */
export const inferenceTimings: Array<{ model: string; firstTokenMs: number; at: string }> = []

export interface PullProgress {
  status: string
  digest?: string
  total?: number
  completed?: number
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'not_found' | 'out_of_memory' | 'timeout' | 'stalled' | 'aborted' | 'http' | 'invalid_response' | 'resource_limit',
    readonly status?: number,
  ) {
    super(message)
    this.name = 'OllamaError'
  }
}

export class OllamaClient {
  constructor(
    readonly baseUrl = 'http://127.0.0.1:11434',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string) {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`
  }

  private async request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    const signals = [AbortSignal.timeout(init.timeoutMs ?? 15_000)]
    if (init.signal) signals.push(init.signal)
    let response: Response
    try {
      response = await this.fetchImpl(this.url(path), { ...init, signal: AbortSignal.any(signals) })
    } catch (error) {
      throw toOllamaError(error, init.signal ?? undefined)
    }
    if (!response.ok) throw await httpError(response)
    const text = await response.text()
    try {
      return (text ? JSON.parse(text) : {}) as T
    } catch {
      throw new OllamaError(`Invalid JSON from Ollama ${path}.`, 'invalid_response')
    }
  }

  async version(): Promise<string> {
    const data = await this.request<{ version: string }>('/api/version', { timeoutMs: 3000 })
    return data.version
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.version()
      return true
    } catch {
      return false
    }
  }

  async list(): Promise<OllamaModelSummary[]> {
    const data = await this.request<{ models?: OllamaModelSummary[] }>('/api/tags')
    return data.models ?? []
  }

  async show(model: string): Promise<OllamaShowResponse> {
    return this.request<OllamaShowResponse>('/api/show', { method: 'POST', body: JSON.stringify({ model }), headers: { 'Content-Type': 'application/json' } })
  }

  async running(): Promise<OllamaRunningModel[]> {
    const data = await this.request<{ models?: OllamaRunningModel[] }>('/api/ps')
    return data.models ?? []
  }

  async delete(model: string): Promise<void> {
    await this.request('/api/delete', { method: 'DELETE', body: JSON.stringify({ model }), headers: { 'Content-Type': 'application/json' } })
  }

  /** Loads a model into memory (start). */
  async load(model: string, keepAlive: string | number = '15m', numCtx?: number): Promise<void> {
    await this.request('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ model, keep_alive: keepAlive, options: numCtx ? { num_ctx: numCtx } : undefined }),
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: 5 * 60_000,
    })
  }

  /** Unloads a model from memory (stop). */
  async unload(model: string): Promise<void> {
    await this.request('/api/generate', { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }), headers: { 'Content-Type': 'application/json' } })
  }

  /**
   * Pulls a model with streamed progress. Ollama resumes partially downloaded layers on its own,
   * so calling pull again after an interruption continues the download.
   */
  async pull(model: string, onProgress: (progress: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    let response: Response
    try {
      response = await this.fetchImpl(this.url('/api/pull'), {
        method: 'POST',
        body: JSON.stringify({ model, stream: true }),
        headers: { 'Content-Type': 'application/json' },
        signal,
      })
    } catch (error) {
      throw toOllamaError(error, signal)
    }
    if (!response.ok || !response.body) throw await httpError(response)
    for await (const line of ndjsonLines(response.body, signal, 120_000)) {
      const event = line as PullProgress & { error?: string }
      if (event.error) throw new OllamaError(event.error, /not found|manifest/.test(event.error) ? 'not_found' : 'http')
      onProgress(event)
    }
  }

  /**
   * Chat completion with optional tools / structured output. Streams internally so that a model
   * that stops producing tokens is detected (`idleTimeoutMs`) instead of hanging forever.
   */
  async chat(request: OllamaChatRequest, options: { signal?: AbortSignal; idleTimeoutMs?: number; timeoutMs?: number; onToken?: (text: string) => void } = {}): Promise<OllamaChatResult> {
    const started = performance.now()
    let firstToken = false
    const controller = new AbortController()
    const signals = [controller.signal]
    if (options.signal) signals.push(options.signal)
    const total = setTimeout(() => controller.abort(new OllamaError('Model call exceeded its time limit.', 'timeout')), options.timeoutMs ?? 10 * 60_000)
    try {
      let response: Response
      try {
        response = await this.fetchImpl(this.url('/api/chat'), {
          method: 'POST',
          body: JSON.stringify({ ...request, stream: true }),
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.any(signals),
        })
      } catch (error) {
        throw toOllamaError(error, options.signal, controller.signal)
      }
      if (!response.ok || !response.body) throw await httpError(response)

      let content = ''
      let thinking = ''
      const toolCalls: OllamaToolCall[] = []
      let final: Record<string, unknown> = {}
      try {
        for await (const line of ndjsonLines(response.body, AbortSignal.any(signals), options.idleTimeoutMs ?? 180_000)) {
          const chunk = line as { message?: OllamaMessage; done?: boolean; error?: string } & Record<string, unknown>
          if (chunk.error) throw classifyErrorText(chunk.error)
          if (!firstToken && (chunk.message?.content || chunk.message?.thinking || chunk.message?.tool_calls?.length)) {
            firstToken = true
            inferenceTimings.push({ model: request.model, firstTokenMs: Math.round(performance.now() - started), at: new Date().toISOString() })
            if (inferenceTimings.length > 200) inferenceTimings.shift()
          }
          if (chunk.message?.content) {
            content += chunk.message.content
            options.onToken?.(chunk.message.content)
          }
          if (chunk.message?.thinking) thinking += chunk.message.thinking
          if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls)
          if (chunk.done) final = chunk
        }
      } catch (error) {
        if (error instanceof OllamaError) throw error
        throw toOllamaError(error, options.signal, controller.signal)
      }
      if (!final.done) throw new OllamaError('Ollama stream ended without a completion marker; response discarded.', 'invalid_response')
      return {
        message: { role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : undefined, thinking: thinking || undefined },
        promptTokens: Number(final.prompt_eval_count ?? 0),
        completionTokens: Number(final.eval_count ?? 0),
        totalDurationMs: Math.round(Number(final.total_duration ?? 0) / 1e6),
        loadDurationMs: Math.round(Number(final.load_duration ?? 0) / 1e6),
        doneReason: typeof final.done_reason === 'string' ? final.done_reason : undefined,
      }
    } finally {
      clearTimeout(total)
    }
  }
}

async function* ndjsonLines(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined, idleTimeoutMs: number): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new OllamaError('Aborted.', 'aborted')
      let idleTimer: NodeJS.Timeout | undefined
      const idle = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => reject(new OllamaError(`Model produced no output for ${Math.round(idleTimeoutMs / 1000)}s (stalled).`, 'stalled')), idleTimeoutMs)
      })
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await Promise.race([reader.read(), idle])
      } finally {
        clearTimeout(idleTimer)
      }
      if (result.done) break
      buffer += decoder.decode(result.value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) yield JSON.parse(line)
        newline = buffer.indexOf('\n')
      }
    }
    if (buffer.trim()) yield JSON.parse(buffer.trim())
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

async function httpError(response: Response): Promise<OllamaError> {
  let message = `Ollama returned HTTP ${response.status}.`
  try {
    const body = (await response.json()) as { error?: string }
    if (body.error) message = body.error
  } catch {
    // keep default
  }
  if (response.status === 404) return new OllamaError(message, 'not_found', 404)
  const classified = classifyErrorText(message)
  return new OllamaError(classified.message, classified.kind, response.status)
}

function classifyErrorText(message: string): OllamaError {
  if (/out of memory|cudaMalloc|insufficient memory|requires more system memory|unable to allocate/i.test(message)) {
    return new OllamaError(message, 'out_of_memory')
  }
  if (/not found|pull the model/i.test(message)) return new OllamaError(message, 'not_found')
  return new OllamaError(message, 'http')
}

function toOllamaError(error: unknown, userSignal?: AbortSignal, internalSignal?: AbortSignal): OllamaError {
  if (error instanceof OllamaError) return error
  if (internalSignal?.aborted && internalSignal.reason instanceof OllamaError) return internalSignal.reason
  if (userSignal?.aborted) return new OllamaError('Model call was cancelled.', 'aborted')
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout|timed out/i.test(message) || (error instanceof Error && error.name === 'TimeoutError')) {
    return new OllamaError('Ollama did not respond in time.', 'timeout')
  }
  return new OllamaError(`Ollama is not reachable: ${message}`, 'unreachable')
}

/** Reads the context length from /api/show model_info ("<arch>.context_length"). */
export function contextLengthFromShow(show: OllamaShowResponse): number | undefined {
  for (const [key, value] of Object.entries(show.model_info ?? {})) {
    if (key.endsWith('.context_length') && typeof value === 'number') return value
  }
  return undefined
}
