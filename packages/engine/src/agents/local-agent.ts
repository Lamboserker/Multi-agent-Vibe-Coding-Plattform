import { OllamaClient, OllamaError, type OllamaMessage, type OllamaToolCall, type OllamaToolDefinition } from '../ollama/client.js'
import { PathViolationError } from '../security/paths.js'
import { ToolInputError, WorkspaceFiles, type FileOperation } from '../patch/workspace-files.js'
import type { SearchHit } from '../index/repo-index.js'

export interface LocalAgentTask {
  id: string
  title: string
  description: string
  acceptanceCriteria: string[]
  relevantFiles: string[]
  newFiles: string[]
}

export type LocalAgentEvent =
  | { type: 'step'; step: number; mode: 'tools' | 'structured' }
  | { type: 'tool_call'; name: string; args: string; ok: boolean; result: string }
  | { type: 'text'; text: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number }

/** A tool provided by the application (MCP server, plugin, skill loader) next to the file tools. */
export interface AgentTool {
  name: string
  description: string
  /** A prerequisite for this task, rather than merely an available tool. */
  required?: boolean
  /** Information/instruction tool; its required result must precede dependent edits. */
  readOnly?: boolean
  /** JSON schema of the arguments. */
  parameters: Record<string, unknown>
  /** Returns the text handed back to the model (truncated by the agent loop). */
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>
}

export interface LocalAgentInput {
  client: Pick<OllamaClient, 'chat'>
  model: string
  /** Ollama keep_alive for the agent's calls (default 15m). */
  keepAlive?: string
  supportsTools: boolean
  /** One structured response for a small self-contained task; otherwise use the tool loop. */
  preferStructured?: boolean
  supportsThinking?: boolean
  workspace: WorkspaceFiles
  task: LocalAgentTask
  /** Compact repository context (outlines, conventions). */
  context: string
  previousFailures?: string
  search?: (query: string) => Promise<SearchHit[]>
  maxSteps?: number
  maxOutputTokens?: number
  numCtx?: number
  timeoutMs?: number
  signal?: AbortSignal
  onEvent?: (event: LocalAgentEvent) => void
  /** Additional tools (only offered in tool-calling mode). */
  extraTools?: AgentTool[]
  /** Prerequisites resolved from the original goal by the application. */
  requiredTools?: string[]
  /** Appended to the system prompt (e.g. the index of available skills). */
  extraInstructions?: string
}

export interface LocalAgentResult {
  status: 'completed' | 'no_changes' | 'failed'
  mode: 'tools' | 'structured'
  summary: string
  steps: number
  toolCalls: number
  invalidToolCalls: number
  /** Tool calls the model wrote as JSON text that were recovered and validated. */
  recoveredToolCalls: number
  promptTokens: number
  completionTokens: number
  durationMs: number
  filesTouched: string[]
  error?: string
  errorKind?: OllamaError['kind'] | 'tool_misuse' | 'invalid_output'
}

const SYSTEM_PROMPT = `You are a careful software engineer working on ONE task inside a git worktree.
Use the provided tools to read and change files. Rules:
- Read a file before editing it (unless its full content was already given to you).
- Use edit_file with an exact, unique "search" snippet copied from the file for small changes; use write_file for new files or full rewrites.
- Only touch files needed for the task. Never touch .env files, credentials, lockfiles or CI configuration.
- Follow the existing code style, imports and conventions of the repository.
- When you use a symbol from another file, import it from that exact file path.
- Files supplied below are already read: edit them directly. Prefer edit_file over rewriting an existing file.
- Batch independent file operations in one response. Include finish after the final edits in that response; the engine runs validation afterwards.
- Follow the supplied solution directly. Do not narrate your reasoning or repeat the plan.
- When the task is complete, call finish with a summary below 300 characters.`

const STRUCTURED_SYSTEM_PROMPT = `You are a careful software engineer implementing ONE task inside a git worktree.
The current target files are provided. Respond ONLY with a JSON object containing a short summary and an operations array.
Use action "edit" with path, an exact unique search snippet and the corrected replace text for existing files.
Use action "write" with path and complete content for new files. Each operation must implement an actual change.
Preserve unrelated code, exports and conventions. Never touch .env files, credentials, lockfiles or CI configuration.
Include the imports needed for symbols used from other files. Export each symbol only once.
Follow the supplied plan directly; do not repeat analysis or explain your reasoning. Keep summary below 300 characters.
If a skill applies but its full instructions are not supplied, or you need any tool, resource or further exploration before editing, return needs_tools: true and an EMPTY operations array. The engine will offer the full tool set before any changes. Otherwise return needs_tools: false and the complete operations. Never skip required skill instructions or tool access.
The engine applies your operations and runs the project checks.`

export const LOCAL_AGENT_TOOLS: OllamaToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the repository (optionally a line range).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative path' },
          start_line: { type: 'integer', description: 'First line (1-based), optional' },
          end_line: { type: 'integer', description: 'Last line (inclusive), optional' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and folders below a directory.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory, default "."' }, depth: { type: 'integer', description: '1-3' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search the repository for a literal text (identifiers, strings). Returns file:line matches.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a file or replace its entire content.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: 'Complete file content' } }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace one exact, unique snippet in an existing file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, search: { type: 'string', description: 'Exact existing text (unique in the file)' }, replace: { type: 'string', description: 'Replacement text' } },
        required: ['path', 'search', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Signal that the task is complete.',
      parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    },
  },
]

/** JSON schema for the structured fallback when a model has no reliable tool calling. */
export const STRUCTURED_PATCH_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    needs_tools: { type: 'boolean' },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['write', 'edit'] },
          path: { type: 'string' },
          content: { type: 'string', description: 'full file content for write, empty for edit' },
          search: { type: 'string', description: 'exact unique snippet for edit, empty for write' },
          replace: { type: 'string', description: 'replacement for edit, empty for write' },
        },
        required: ['action', 'path'],
      },
    },
  },
  required: ['summary', 'needs_tools', 'operations'],
}

function taskPrompt(input: LocalAgentInput, preloaded: string): string {
  const task = input.task
  return [
    `# Task ${task.id}: ${task.title}`,
    task.description,
    task.acceptanceCriteria.length ? `## Acceptance criteria\n${task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}` : '',
    task.relevantFiles.length ? `## Files to read/edit\n${task.relevantFiles.map((file) => `- ${file}`).join('\n')}` : '',
    task.newFiles.length ? `## Files to create\n${task.newFiles.map((file) => `- ${file}`).join('\n')}` : '',
    input.previousFailures
      ? `## The previous attempt failed validation – fix these errors
${input.previousFailures}

The files below contain your previous attempt. Do not repeat it unchanged: change exactly what is needed to meet the original task and failing checks. Preserve supplied acceptance tests unless the task explicitly requests test changes.`
      : '',
    `## Repository context\n${input.context}`,
    preloaded ? `## Current content of the files to edit\n${preloaded}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Puts the content of small target files directly into the prompt (saves tool round-trips). */
async function preloadFiles(workspace: WorkspaceFiles, files: string[], budgetChars: number, completeFiles?: Set<string>, missingFiles?: Set<string>): Promise<string> {
  const parts: string[] = []
  let used = 0
  for (const file of files.slice(0, 6)) {
    try {
      const read = await workspace.read(file)
      const block = `### ${read.path}${read.truncated ? ' (partial; read the needed range before editing)' : ' (complete)'}\n\`\`\`\n${read.content}\n\`\`\``
      if (used + block.length > budgetChars) continue
      parts.push(block)
      if (!read.truncated) completeFiles?.add(file)
      used += block.length
    } catch (error) {
      // Only confirmed absence permits a new file without preloaded content.
      if (error instanceof ToolInputError && error.code === 'not_found') missingFiles?.add(file)
    }
  }
  return parts.join('\n\n')
}

/** Conservative estimate, not a tokenizer. Reserve space before Ollama can silently drop the task. */
function requestTokens(messages: OllamaMessage[], schema: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify({ messages, schema }), 'utf8') / 3) + messages.length * 16
}

function ensureContext(messages: OllamaMessage[], schema: unknown, numCtx: number, responseTokens: number): void {
  if (requestTokens(messages, schema) > numCtx - responseTokens) {
    throw new OllamaError('Task instructions/tools exceed the context budget. Split the task or increase its context limit; no model call was started.', 'resource_limit')
  }
}

/** Some templates leak a completed reasoning block even with think:false. Only parse the final
 * answer, never JSON examples inside that block. File operations still pass the normal validator. */
function structuredAnswer(content: string): unknown {
  const end = content.lastIndexOf('</think>')
  const answer = (end >= 0 ? content.slice(end + '</think>'.length) : content).trim()
  const fenced = answer.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return JSON.parse(fenced?.[1] ?? answer)
}

const TOOL_NAMES = new Set(LOCAL_AGENT_TOOLS.map((tool) => tool.function.name))

/** Strong task requirements; a catalogue entry or a negated mention is not sufficient. */
export function requiredToolNames(tools: AgentTool[], taskText: string): string[] {
  return tools.filter(tool => {
    if (tool.required) return true
    const escaped = tool.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const named = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'iu')
    return taskText.split(/[\n;:,]|[.!?](?=\s)/u).some(clause => named.test(clause) &&
      /\b(call|use|invoke|query|fetch|load|run|read|rufe?|verwende|nutze|lade|lies|hole|aufrufen)\b/iu.test(clause) &&
      !/\b(not|never|without|don't|mustn't|can't|cannot|nicht|ohne|kein|keine|keinen)\b/iu.test(clause))
  }).map(tool => tool.name)
}

/**
 * Some models (e.g. qwen2.5-coder via Ollama) emit tool calls as JSON text in the message content
 * instead of the structured tool_calls field. Recovers such calls – plain JSON, fenced JSON or
 * <tool_call> blocks – for known tool names only. Recovered calls are validated like native ones.
 */
export function recoverTextToolCalls(content: string, extraNames: ReadonlySet<string> = new Set()): OllamaToolCall[] {
  const thinkingEnd = content.lastIndexOf('</think>')
  const text = (thinkingEnd >= 0 ? content.slice(thinkingEnd + '</think>'.length) : content).trim()
  if (!text) return []
  const candidates: string[] = []
  for (const match of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) candidates.push(match[1]!)
  // XML often lives inside a Markdown fence: those are two views of ONE call, not two calls.
  if (!candidates.length) for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(match[1]!)
  if (!candidates.length) candidates.push(text)
  const calls: OllamaToolCall[] = []
  const accept = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const item = value as { name?: unknown; arguments?: unknown; parameters?: unknown; function?: { name?: unknown; arguments?: unknown } }
    const name = typeof item.name === 'string' ? item.name : typeof item.function?.name === 'string' ? item.function.name : undefined
    // tools without parameters (common for MCP tools) may be written without an arguments field
    const args = item.arguments ?? item.parameters ?? item.function?.arguments ?? (name && extraNames.has(name) ? {} : undefined)
    if (!name || !(TOOL_NAMES.has(name) || extraNames.has(name)) || !args || (typeof args !== 'object' && typeof args !== 'string')) return
    calls.push({ function: { name, arguments: args as Record<string, unknown> | string } })
  }
  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      // several JSON objects separated by newlines
      for (const line of candidate.split(/\n(?=\s*\{)/)) {
        try {
          accept(JSON.parse(line))
        } catch {
          // not JSON
        }
      }
      continue
    }
    if (Array.isArray(parsed)) parsed.forEach(accept)
    else accept(parsed)
  }
  return calls
}

function safeObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function parseArguments(call: OllamaToolCall): Record<string, unknown> {
  const raw = call.function.arguments
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      throw new ToolInputError('Tool arguments are not valid JSON.')
    }
    throw new ToolInputError('Tool arguments must be an object.')
  }
  if (!raw || typeof raw !== 'object') throw new ToolInputError('Tool arguments must be an object.')
  return raw
}

function requireString(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key]
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new ToolInputError(`"${key}" must be a ${allowEmpty ? '' : 'non-empty '}string.`)
  return value
}

function optionalInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) throw new ToolInputError(`"${key}" must be a number.`)
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Executes one validated tool call against the scoped workspace. */
export async function executeToolCall(
  call: OllamaToolCall,
  workspace: WorkspaceFiles,
  search?: (query: string) => Promise<SearchHit[]>,
  extraTools: AgentTool[] = [],
  signal?: AbortSignal,
): Promise<{ ok: boolean; output: string; finished?: string }> {
  const name = call.function?.name
  try {
    const args = parseArguments(call)
    switch (name) {
      case 'read_file': {
        const read = await workspace.read(requireString(args, 'path'), { startLine: optionalInt(args, 'start_line', 1, 1_000_000), endLine: optionalInt(args, 'end_line', 1, 1_000_000) })
        return { ok: true, output: `${read.path} (${read.totalLines} lines${read.truncated ? ', partial' : ''}):\n${read.content}` }
      }
      case 'list_files': {
        const listing = await workspace.list(typeof args.path === 'string' && args.path ? args.path : '.', optionalInt(args, 'depth', 1, 3) ?? 2)
        return { ok: true, output: listing.join('\n') || '(empty)' }
      }
      case 'search_code': {
        if (!search) return { ok: false, output: 'search_code is not available.' }
        const hits = await search(requireString(args, 'query'))
        return { ok: true, output: hits.length ? hits.slice(0, 30).map((hit) => `${hit.path}:${hit.line}: ${hit.text}`).join('\n') : 'No matches.' }
      }
      case 'write_file': {
        const result = await workspace.write(requireString(args, 'path'), requireString(args, 'content', true))
        return { ok: true, output: result.summary }
      }
      case 'edit_file': {
        const result = await workspace.edit(requireString(args, 'path'), requireString(args, 'search'), requireString(args, 'replace', true))
        return { ok: true, output: result.summary }
      }
      case 'finish':
        return { ok: true, output: 'Finished.', finished: typeof args.summary === 'string' ? args.summary : 'Task completed.' }
      default: {
        const extra = extraTools.find((tool) => tool.name === name)
        if (extra) return { ok: true, output: await extra.execute(args, signal) }
        return { ok: false, output: `Unknown tool "${name}". Available: ${[...LOCAL_AGENT_TOOLS.map((tool) => tool.function.name), ...extraTools.map((tool) => tool.name)].join(', ')}.` }
      }
    }
  } catch (error) {
    if (error instanceof ToolInputError || error instanceof PathViolationError) return { ok: false, output: `Error: ${error.message}` }
    return { ok: false, output: `Error: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Runs a local model on one task. Tool-capable models work in a bounded tool loop;
 * other models must return a strict JSON list of file operations.
 */
export async function runLocalAgent(input: LocalAgentInput): Promise<LocalAgentResult> {
  const started = Date.now()
  const callerSignal = input.signal
  const deadlineSignal = AbortSignal.timeout(input.timeoutMs ?? 15 * 60_000)
  input = { ...input, signal: AbortSignal.any([deadlineSignal, ...(callerSignal ? [callerSignal] : [])]) }
  const numCtx = input.numCtx ?? 16_384
  // File tools cannot be shadowed by application tools.
  const extraTools = (input.extraTools ?? []).filter(tool => !TOOL_NAMES.has(tool.name))
  const extraNames = new Set(extraTools.map(tool => tool.name))
  const requiredTools = new Set([...(input.requiredTools ?? []), ...requiredToolNames(extraTools, [input.task.title, input.task.description, ...input.task.acceptanceCriteria].join('\n'))])
  const requiredDataTools = new Set(extraTools.filter(tool => requiredTools.has(tool.name) && (tool.required || tool.readOnly)).map(tool => tool.name))
  // A nominally new file may already exist, including after a repair attempt. Read it too.
  const preloadTargets = [...new Set([...input.task.relevantFiles, ...input.task.newFiles])]
  const preloadBudget = Math.floor(numCtx * 3 * 0.3)
  const completeFiles = new Set<string>()
  const missingFiles = new Set<string>()
  let preloaded = await preloadFiles(input.workspace, preloadTargets, preloadBudget, completeFiles, missingFiles)
  // Available tools do not imply that this task needs them. The structured response can
  // request the full tool loop before editing; all skill instructions are retained.
  const structured = input.preferStructured && !requiredTools.size &&
    preloadTargets.length > 0 && preloadTargets.length <= 6 &&
    preloadTargets.every(file => completeFiles.has(file) || (input.task.newFiles.includes(file) && missingFiles.has(file)))
  const useTools = input.supportsTools && !structured
  const outputBudget = input.maxOutputTokens ?? (structured ? 8192 : 16384)
  const responseBudget = Math.min(structured ? 2048 : 4096, Math.max(1, Math.floor(numCtx / 4)))
  const result: LocalAgentResult = {
    status: 'failed',
    mode: useTools ? 'tools' : 'structured',
    summary: '',
    steps: 0,
    toolCalls: 0,
    invalidToolCalls: 0,
    recoveredToolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    durationMs: 0,
    filesTouched: [],
  }
  const deadline = started + (input.timeoutMs ?? 15 * 60_000)
  const remaining = () => Math.max(1, deadline - Date.now())
  // A slightly higher temperature on repairs avoids repeating the identical failing output.
  const options = { num_ctx: numCtx, temperature: input.previousFailures ? 0.35 : 0.15, num_predict: Math.min(responseBudget, outputBudget) }
  const think = input.supportsThinking ? false : undefined

  const systemPrompt = [SYSTEM_PROMPT, input.extraInstructions,
    requiredTools.size ? `Required task tools: ${[...requiredTools].join(', ')}. Use them before finishing, following the task's operation order; never invent their results.` : '',
    requiredDataTools.size ? `Before editing, obtain these required information/instruction results: ${[...requiredDataTools].join(', ')}. Use their actual results in a subsequent response.` : '',
  ].filter(Boolean).join('\n\n')
  const tools: OllamaToolDefinition[] = [...LOCAL_AGENT_TOOLS, ...extraTools.map((tool) => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))]

  try {
    if (requiredTools.size && (!useTools || [...requiredTools].some(name => !extraNames.has(name)))) {
      throw new OllamaError('Required task tools are unavailable; no changes were applied.', 'invalid_response')
    }
    if (useTools) {
      const messages: OllamaMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: taskPrompt(input, preloaded) },
      ]
      const maxSteps = input.maxSteps ?? 16
      let nudged = false
      for (let step = 1; step <= maxSteps; step += 1) {
        if (Date.now() > deadline) throw new OllamaError('Task time limit reached.', 'timeout')
        if (result.completionTokens >= outputBudget) throw new OllamaError('Agent output token resource limit reached.', 'resource_limit')
        options.num_predict = Math.min(responseBudget, outputBudget - result.completionTokens)
        // Keep the task and the latest complete tool round. Refresh supplied files after writes,
        // rather than retaining a stale original alongside an ever growing history.
        if (requestTokens(messages, tools) > numCtx - options.num_predict && messages.length > 4) {
          let lastAssistant = messages.length - 1
          while (lastAssistant > 2 && messages[lastAssistant]?.role !== 'assistant') lastAssistant--
          if (lastAssistant > 2) {
            preloaded = await preloadFiles(input.workspace, [...new Set([...preloadTargets, ...input.workspace.touched])], preloadBudget)
            messages[1] = { role: 'user', content: taskPrompt(input, preloaded) + '\n\nOlder tool rounds omitted to fit context. Current files above include edits already applied. Re-read any other file you still need.' }
            messages.splice(2, lastAssistant - 2)
          }
        }
        ensureContext(messages, tools, numCtx, options.num_predict)
        result.steps = step
        input.onEvent?.({ type: 'step', step, mode: 'tools' })
        const response = await input.client.chat(
          { model: input.model, messages, tools, options, keep_alive: input.keepAlive ?? '15m', think },
          { signal: input.signal, timeoutMs: remaining(), idleTimeoutMs: 180_000 },
        )
        result.promptTokens += response.promptTokens
        result.completionTokens += response.completionTokens
        if (response.promptTokens > numCtx || result.completionTokens > outputBudget) throw new OllamaError('Model exceeded the agent context/output token limit; response discarded before applying tools.', 'resource_limit')
        input.onEvent?.({ type: 'usage', promptTokens: response.promptTokens, completionTokens: response.completionTokens })
        if (input.signal?.aborted) throw new OllamaError('Agent aborted before applying response.', 'aborted')
        if (response.doneReason === 'length' || response.completionTokens >= options.num_predict) throw new OllamaError('Model response reached its output limit; incomplete response discarded.', 'resource_limit')
        messages.push(response.message)
        let calls = response.message.tool_calls ?? []
        if (!calls.length) {
          calls = recoverTextToolCalls(response.message.content, extraNames)
          if (calls.length) {
            result.recoveredToolCalls += calls.length
            // Keep the conversation well-formed for the chat template: a real tool-call turn.
            messages[messages.length - 1] = {
              role: 'assistant',
              content: '',
              tool_calls: calls.map((call) => ({ function: { name: call.function.name, arguments: typeof call.function.arguments === 'string' ? safeObject(call.function.arguments) : call.function.arguments } })),
            }
            input.onEvent?.({ type: 'text', text: `(${calls.length} tool call(s) recovered from text output)` })
          }
        }
        if (response.message.content.trim() && !calls.length) input.onEvent?.({ type: 'text', text: response.message.content.slice(0, 2000) })

        if (!calls.length) {

          if (nudged) {
            result.error = 'The model did not explicitly finish the task using the tools.'
            result.errorKind = 'tool_misuse'
            break
          }
          nudged = true
          messages.push({ role: 'user', content: 'Complete the remaining task using write_file or edit_file as needed, then explicitly call finish.' })
          continue
        }

        let finished: string | undefined
        let batchFailed = false
        // A patch generated in the same response cannot yet depend on the returned tool result.
        const awaitingRequiredResults = requiredTools.size > 0
        const awaitingRequiredData = requiredDataTools.size > 0
        for (const call of calls) {
          result.toolCalls += 1
          const mutating = ['write_file', 'edit_file'].includes(call.function?.name)
          const outcome = (awaitingRequiredData && mutating) || (awaitingRequiredResults && call.function?.name === 'finish')
            ? { ok: false, output: mutating ? 'Required information tools must return before editing. Use their results in your next response.' : 'Required task tools must return before finishing. Read their results in your next response.' }
            : await executeToolCall(call, input.workspace, input.search, extraTools, input.signal)
          if (outcome.ok) { requiredTools.delete(call.function?.name); requiredDataTools.delete(call.function?.name) }
          if (!outcome.ok) { result.invalidToolCalls += 1; batchFailed = true }
          input.onEvent?.({ type: 'tool_call', name: call.function?.name ?? '?', args: summarizeArgs(call), ok: outcome.ok, result: outcome.output.slice(0, 300) })
          const limit = Math.min(12_000, Math.floor(numCtx * 0.75))
          messages.push({ role: 'tool', content: outcome.output.length > limit ? `${outcome.output.slice(0, limit)}\n[partial tool result; request a narrower range if needed]` : outcome.output, tool_name: call.function?.name })
          if (outcome.finished !== undefined && !batchFailed) { finished = outcome.finished; break }
        }
        if (result.invalidToolCalls >= 6) {
          result.error = `Too many invalid tool calls (${result.invalidToolCalls}).`
          result.errorKind = 'tool_misuse'
          break
        }
        if (finished !== undefined && !batchFailed) {
          result.summary = finished.slice(0, 300)
          break
        }
        if (step === maxSteps) result.error = `Step limit (${maxSteps}) reached before the model called finish.`
      }
    } else {
      // Structured output mode: up to two rounds (second round gets apply errors back).
      let feedback = ''
      for (let round = 1; round <= Math.min(2, input.maxSteps ?? 16); round += 1) {
        {
          const left = outputBudget - result.completionTokens
          if (left <= 0) throw new OllamaError('Agent output token resource limit reached.', 'resource_limit')
          options.num_predict = Math.min(responseBudget, left)
        }
        result.steps = round
        input.onEvent?.({ type: 'step', step: round, mode: 'structured' })
        if (round > 1) preloaded = await preloadFiles(input.workspace, [...new Set([...preloadTargets, ...input.workspace.touched])], preloadBudget)
        const messages: OllamaMessage[] = [
          { role: 'system', content: STRUCTURED_SYSTEM_PROMPT + (extraTools.length ? '\nAvailable additional tools (request needs_tools before using any): ' + extraTools.map(tool => tool.name + ': ' + tool.description).join('\n') : '') + (input.extraInstructions ? `\n\n${input.extraInstructions}` : '') },
          { role: 'user', content: taskPrompt(input, preloaded) + (feedback ? `\n\n## Your previous operations failed\n${feedback}\nSuccessful operations are already applied in the current files above. Return only remaining fixes.` : '') },
        ]
        ensureContext(messages, STRUCTURED_PATCH_SCHEMA, numCtx, options.num_predict)
        const response = await input.client.chat(
          {
            model: input.model,
            messages,
            format: STRUCTURED_PATCH_SCHEMA,
            options,
            keep_alive: input.keepAlive ?? '15m',
            think,
          },
          { signal: input.signal, timeoutMs: remaining(), idleTimeoutMs: 180_000 },
        )
        result.promptTokens += response.promptTokens
        result.completionTokens += response.completionTokens
        input.onEvent?.({ type: 'usage', promptTokens: response.promptTokens, completionTokens: response.completionTokens })
        if (input.signal?.aborted) throw new OllamaError('Agent aborted before applying response.', 'aborted')
        if (response.doneReason === 'length' || response.completionTokens >= options.num_predict) throw new OllamaError('Model response reached its output limit; incomplete response discarded.', 'resource_limit')
        let parsed: { summary?: unknown; operations?: unknown; needs_tools?: unknown }
        if (response.promptTokens > numCtx || result.completionTokens > outputBudget) throw new OllamaError('Model exceeded the agent context/output token limit; response discarded before applying operations.', 'resource_limit')
        try {
          const value = structuredAnswer(response.message.content)
          if (!value || typeof value !== 'object' || !Array.isArray((value as { operations?: unknown }).operations)) throw new Error('Expected an operations array.')
          parsed = value as typeof parsed
        } catch {
          feedback = 'Your answer was not valid JSON.'
          continue
        }
        if (parsed.needs_tools === true) {
          if (!input.supportsTools || (parsed.operations as unknown[]).length) throw new OllamaError('Required tools unavailable or mixed with premature operations; response discarded.', 'invalid_response')
          const remainingSteps = (input.maxSteps ?? 16) - result.steps
          if (remainingSteps <= 0) throw new OllamaError('No steps left for required tools.', 'resource_limit')
          const fallback = await runLocalAgent({ ...input, preferStructured: false, maxSteps: remainingSteps, maxOutputTokens: outputBudget - result.completionTokens, timeoutMs: remaining() })
          return { ...fallback, steps: result.steps + fallback.steps, promptTokens: result.promptTokens + fallback.promptTokens, completionTokens: result.completionTokens + fallback.completionTokens, durationMs: Date.now() - started }
        }
        const operations = Array.isArray(parsed.operations) ? parsed.operations : []
        const errors: string[] = []
        let appliedOperations = 0
        for (const raw of operations) {
          const operation = toOperation(raw)
          if (!operation) {
            errors.push('Invalid operation object.')
            continue
          }
          result.toolCalls += 1
          try {
            // A complete response can redundantly restate already-correct content. Verify it
            // through the normal scope/read rules; do not count it as an actual change.
            if (operation.action === 'edit' && operation.search.replace(/\r\n/g, '\n') === operation.replace.replace(/\r\n/g, '\n')) {
              input.workspace.assertWritable(operation.path)
              const current = await input.workspace.read(operation.path)
              const needle = operation.search.replace(/\r\n/g, '\n')
              const first = current.content.indexOf(needle)
              if (!current.truncated && first >= 0 && current.content.indexOf(needle, first + needle.length) < 0) {
                input.onEvent?.({ type: 'tool_call', name: operation.action, args: operation.path, ok: true, result: 'Verified unchanged content; no operation needed.' })
                continue
              }
            }
            const applied = await input.workspace.apply(operation)
            appliedOperations++
            input.onEvent?.({ type: 'tool_call', name: operation.action, args: operation.path, ok: true, result: applied.summary })
          } catch (error) {
            result.invalidToolCalls += 1
            const message = error instanceof Error ? error.message : String(error)
            errors.push(`${operation.action} ${operation.path}: ${message}`)
            input.onEvent?.({ type: 'tool_call', name: operation.action, args: operation.path, ok: false, result: message })
          }
        }
        result.summary = typeof parsed.summary === 'string' ? parsed.summary.slice(0, 300) : ''
        if (appliedOperations && !errors.length && input.workspace.touched.size) { feedback = ''; break }
        feedback = errors.join('\n') || 'No actual changes were returned.'
      }
      if (feedback || !input.workspace.touched.size) {
        result.error = feedback || 'The model did not produce applicable file operations.'
        result.errorKind = 'invalid_output'
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    result.errorKind = error instanceof OllamaError ? error.kind : undefined
    if (deadlineSignal.aborted && !callerSignal?.aborted) { result.error = 'Agent task time limit reached.'; result.errorKind = 'timeout' }
  }

  result.filesTouched = [...input.workspace.touched]
  result.durationMs = Date.now() - started
  // An incomplete attempt must never turn into success just because some files changed.
  result.status = result.error ? 'failed' : result.filesTouched.length ? 'completed' : 'no_changes'
  return result
}

function toOperation(raw: unknown): FileOperation | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const item = raw as Record<string, unknown>
  const pathValue = typeof item.path === 'string' ? item.path : ''
  if (!pathValue) return undefined
  if (item.action === 'write' && typeof item.content === 'string') return { action: 'write', path: pathValue, content: item.content }
  if (item.action === 'edit' && typeof item.search === 'string' && item.search && typeof item.replace === 'string') {
    return { action: 'edit', path: pathValue, search: item.search, replace: item.replace }
  }
  return undefined
}

function summarizeArgs(call: OllamaToolCall): string {
  try {
    const args = typeof call.function.arguments === 'string' ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : call.function.arguments
    const target = args.path ?? args.query ?? ''
    return String(target).slice(0, 200)
  } catch {
    return ''
  }
}
