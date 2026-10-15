import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OllamaClient, OllamaError } from '../ollama/client.js'
import { WorkspaceFiles, DEFAULT_SCOPE } from '../patch/workspace-files.js'
import { startFakeOllama, type FakeOllama } from '../testing/fake-ollama.js'
import { tempDir } from '../test-utils.js'
import { executeToolCall, recoverTextToolCalls, runLocalAgent } from './local-agent.js'

let server: FakeOllama | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

const task = { id: 'task-001', title: 'Add greet', description: 'Create src/greet.ts exporting greet(name).', acceptanceCriteria: ['greet returns Hello <name>'], relevantFiles: ['src/index.ts'], newFiles: ['src/greet.ts'] }

async function workspaceWithIndex() {
  const root = tempDir('mac-agent-')
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const version = 1\n')
  return { root, workspace: new WorkspaceFiles(root, { ...DEFAULT_SCOPE, writablePatterns: ['src/**'] }) }
}

describe('OllamaClient', () => {
  it('reads models, capabilities and running models', async () => {
    server = await startFakeOllama({ chat: () => ({ content: 'hi' }) })
    const client = new OllamaClient(server.url)
    expect(await client.version()).toBe('0.0.0-fake')
    expect((await client.list())[0]!.name).toBe('fake-coder:1b')
    expect((await client.show('fake-coder:1b')).capabilities).toContain('tools')
    await expect(client.show('missing')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('reports an unreachable server', async () => {
    const client = new OllamaClient('http://127.0.0.1:9')
    await expect(client.list()).rejects.toBeInstanceOf(OllamaError)
    expect(await client.isReachable()).toBe(false)
  })

  it('detects a stalled model via the idle timeout', async () => {
    server = await startFakeOllama({ chat: () => ({ content: 'late', stallMs: 1500 }) })
    const client = new OllamaClient(server.url)
    await expect(client.chat({ model: 'fake-coder:1b', messages: [{ role: 'user', content: 'x' }] }, { idleTimeoutMs: 300 })).rejects.toMatchObject({ kind: 'stalled' })
  })

  it('classifies out-of-memory errors', async () => {
    server = await startFakeOllama({ chat: () => ({ error: 'model requires more system memory (12 GiB) than is available', status: 500 }) })
    const client = new OllamaClient(server.url)
    await expect(client.chat({ model: 'fake-coder:1b', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ kind: 'out_of_memory' })
  })
})

describe('tool layer', () => {
  it('validates arguments and blocks path escapes', async () => {
    const { workspace } = await workspaceWithIndex()
    expect((await executeToolCall({ function: { name: 'read_file', arguments: { path: '../x' } } }, workspace)).ok).toBe(false)
    expect((await executeToolCall({ function: { name: 'write_file', arguments: { path: 'src/a.ts' } } }, workspace)).output).toMatch(/content/)
    expect((await executeToolCall({ function: { name: 'rm_rf', arguments: {} } }, workspace)).output).toMatch(/Unknown tool/)
    expect((await executeToolCall({ function: { name: 'write_file', arguments: '{not json' } }, workspace)).ok).toBe(false)
    expect((await executeToolCall({ function: { name: 'write_file', arguments: { path: 'package.json', content: '{}' } } }, workspace)).output).toMatch(/writable scope/)
    const ok = await executeToolCall({ function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/a.ts', content: 'export {}\n' }) } }, workspace)
    expect(ok.ok).toBe(true)
  })
})

describe('runLocalAgent', () => {
  it('implements a task through validated tool calls (tool mode)', async () => {
    const { root, workspace } = await workspaceWithIndex()
    server = await startFakeOllama({
      chat: (_request, index) =>
        index === 0
          ? { toolCalls: [{ name: 'write_file', arguments: { path: 'src/greet.ts', content: 'export function greet(name: string) {\n  return `Hello ${name}`\n}\n' } }] }
          : index === 1
            ? { toolCalls: [{ name: 'edit_file', arguments: { path: 'src/index.ts', search: 'export const version = 1', replace: "export const version = 1\nexport { greet } from './greet'" } }] }
            : { toolCalls: [{ name: 'finish', arguments: { summary: 'Added greet.' } }] },
    })
    const result = await runLocalAgent({ client: new OllamaClient(server.url), model: 'fake-coder:1b', supportsTools: true, workspace, task, context: 'TypeScript project' })
    expect(result.status).toBe('completed')
    expect(result.summary).toBe('Added greet.')
    expect(result.filesTouched.sort()).toEqual(['src/greet.ts', 'src/index.ts'])
    expect(result.promptTokens).toBe(360)
    expect(await fs.readFile(path.join(root, 'src', 'index.ts'), 'utf8')).toContain("export { greet } from './greet'")
    // tools and the task description were sent to the model
    expect(server.requests[0]!.tools).toHaveLength(6)
    expect(server.requests[0]!.messages[1]!.content).toContain('Create src/greet.ts')
    // the preloaded file content saves a read_file round-trip
    expect(server.requests[0]!.messages[1]!.content).toContain('export const version = 1')
  })

  it('recovers text tool calls of application tools (also without arguments)', () => {
    const extra = new Set(['mcp_config_magic_number'])
    expect(recoverTextToolCalls('{"name": "mcp_config_magic_number"}', extra)).toEqual([{ function: { name: 'mcp_config_magic_number', arguments: {} } }])
    expect(recoverTextToolCalls('{"name": "mcp_config_magic_number"}')).toEqual([])
    expect(recoverTextToolCalls('{"name": "unknown_tool", "arguments": {}}', extra)).toEqual([])
  })

  it('offers application tools (skills, MCP, plugins) and instructions next to the file tools', async () => {
    const { workspace } = await workspaceWithIndex()
    const calls: Array<Record<string, unknown>> = []
    server = await startFakeOllama({
      chat: (_request, index) =>
        index === 0
          ? { toolCalls: [{ name: 'load_skill', arguments: { name: 'greeting-style' } }] }
          : index === 1
            ? { toolCalls: [{ name: 'write_file', arguments: { path: 'src/greet.ts', content: 'export const greet = (name: string) => `Hi ${name}!`\n' } }] }
            : { toolCalls: [{ name: 'finish', arguments: { summary: 'done' } }] },
    })
    const result = await runLocalAgent({
      client: new OllamaClient(server.url),
      model: 'fake-coder:1b',
      supportsTools: true,
      workspace,
      task,
      context: 'TypeScript project',
      extraInstructions: 'Available skills: greeting-style – how greetings are phrased.',
      extraTools: [
        {
          name: 'load_skill',
          description: 'Load the instructions of a skill.',
          parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          execute: async (args) => {
            calls.push(args)
            return 'Greetings end with "!"'
          },
        },
        // must not shadow a file tool
        { name: 'write_file', description: 'shadow', parameters: { type: 'object' }, execute: async () => 'shadowed' },
      ],
    })
    expect(result.status).toBe('completed')
    expect(calls).toEqual([{ name: 'greeting-style' }])
    expect(server.requests[0]!.tools).toHaveLength(7)
    expect(server.requests[0]!.messages[0]!.content).toContain('Available skills: greeting-style')
    // the tool result went back to the model
    expect(server.requests[1]!.messages.at(-1)!.content).toBe('Greetings end with "!"')
  })

  it('recovers tool calls a model writes as JSON text (qwen2.5-coder style) and validates them', async () => {
    const { root, workspace } = await workspaceWithIndex()
    // Exact output shape observed from qwen2.5-coder:7b via Ollama 0.30 (content instead of tool_calls).
    const asText = (name: string, args: Record<string, unknown>) => ({ content: JSON.stringify({ name, arguments: args }, null, 2) })
    server = await startFakeOllama({
      chat: (_request, index) =>
        index === 0
          ? asText('write_file', { path: 'src/greet.ts', content: 'export const greet = (n: string) => `Hello ${n}`\n' })
          : index === 1
            ? { content: '```json\n{"name": "write_file", "arguments": {"path": "../outside.ts", "content": "x"}}\n```' }
            : { content: '<tool_call>\n{"name": "finish", "arguments": {"summary": "done"}}\n</tool_call>' },
    })
    const result = await runLocalAgent({ client: new OllamaClient(server.url), model: 'fake-coder:1b', supportsTools: true, workspace, task, context: '' })
    expect(result.status).toBe('completed')
    expect(result.recoveredToolCalls).toBe(3)
    expect(result.invalidToolCalls).toBe(1) // the traversal attempt is rejected exactly like a native call
    expect(await fs.readFile(path.join(root, 'src', 'greet.ts'), 'utf8')).toContain('Hello')
    // the recovered turn is sent back as a proper tool-call message
    expect(server.requests[1]!.messages.at(-2)!.tool_calls).toHaveLength(1)
  })

  it('ignores text that only looks like JSON for unknown tools', () => {
    expect(recoverTextToolCalls('{"name": "rm_rf", "arguments": {"path": "/"}}')).toEqual([])
    expect(recoverTextToolCalls('Here is the component: export const x = 1')).toEqual([])
    expect(recoverTextToolCalls('[{"name":"read_file","arguments":{"path":"a.ts"}},{"name":"list_files","arguments":{}}]')).toHaveLength(2)
  })

  it('feeds tool errors back and stops after too many invalid calls', async () => {
    const { workspace } = await workspaceWithIndex()
    server = await startFakeOllama({ chat: () => ({ toolCalls: [{ name: 'write_file', arguments: { path: '../../evil.ts', content: 'x' } }] }) })
    const result = await runLocalAgent({ client: new OllamaClient(server.url), model: 'fake-coder:1b', supportsTools: true, workspace, task, context: '' })
    expect(result.status).toBe('failed')
    expect(result.invalidToolCalls).toBeGreaterThanOrEqual(6)
    const toolMessages = server.requests.at(-1)!.messages.filter((message) => message.role === 'tool')
    expect(toolMessages[0]!.content).toMatch(/traversal|outside/i)
  })

  it('nudges a model that only talks, then fails without changes', async () => {
    const { workspace } = await workspaceWithIndex()
    server = await startFakeOllama({ chat: () => ({ content: 'I would add a greet function.' }) })
    const result = await runLocalAgent({ client: new OllamaClient(server.url), model: 'fake-coder:1b', supportsTools: true, workspace, task, context: '' })
    expect(result.status).toBe('failed')
    expect(result.errorKind).toBe('tool_misuse')
    expect(server.requests).toHaveLength(2)
  })

  it('uses strict structured output for models without tool calling', async () => {
    const { root, workspace } = await workspaceWithIndex()
    server = await startFakeOllama({
      chat: (request, index) => {
        expect(request.tools).toBeUndefined()
        expect(request.format).toBeTruthy()
        return index === 0
          ? { content: JSON.stringify({ summary: 'bad', operations: [{ action: 'edit', path: 'src/index.ts', content: '', search: 'does not exist', replace: 'x' }] }) }
          : { content: JSON.stringify({ summary: 'ok', operations: [{ action: 'write', path: 'src/greet.ts', content: 'export const greet = (n: string) => `Hello ${n}`\n', search: '', replace: '' }] }) }
      },
    })
    const result = await runLocalAgent({ client: new OllamaClient(server.url), model: 'fake-coder:1b', supportsTools: false, workspace, task, context: '' })
    expect(result.mode).toBe('structured')
    expect(result.status).toBe('completed')
    expect(result.steps).toBe(2)
    expect(server.requests[1]!.messages[1]!.content).toContain('search text not found')
    expect(await fs.readFile(path.join(root, 'src', 'greet.ts'), 'utf8')).toContain('Hello')
  })
})
