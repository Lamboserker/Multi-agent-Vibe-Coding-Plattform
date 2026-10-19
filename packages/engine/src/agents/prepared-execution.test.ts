import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { requiredToolNames, runLocalAgent, type LocalAgentInput } from './local-agent.js'
import { OllamaClient, type OllamaChatResult } from '../ollama/client.js'
import { WorkspaceFiles, DEFAULT_SCOPE } from '../patch/workspace-files.js'
import { tempDir } from '../test-utils.js'

const patch = { summary: 'Fixed value', needs_tools: false, operations: [{ action: 'edit', path: 'src/a.ts', search: 'value = 1', replace: 'value = 2' }] }
const reply = (value: unknown): OllamaChatResult => ({ message: { role: 'assistant', content: JSON.stringify(value) }, promptTokens: 20, completionTokens: 30, totalDurationMs: 1, loadDurationMs: 0, doneReason: 'stop' })
async function setup(): Promise<LocalAgentInput> {
  const root = tempDir()
  await fs.mkdir(path.join(root, 'src'))
  await fs.writeFile(path.join(root, 'src/a.ts'), 'export const value = 1\n')
  return { workspace: new WorkspaceFiles(root, DEFAULT_SCOPE), model: 'user-selected-model', supportsTools: true, preferStructured: true,
    task: { id: 'small', title: 'Fix value', description: 'Change value to 2', relevantFiles: ['src/a.ts'], newFiles: [], acceptanceCriteria: ['value equals 2'] },
    context: '', client: { async chat() { return reply(patch) } } }
}

describe('prepared local execution', () => {
  it('allows required post-edit actions to see their prepared input before completion', async () => {
    const input = await setup()
    input.task.description = 'Call build_check after updating src/a.ts'
    let calls = 0
    input.extraTools = [{ name: 'build_check', description: 'Check prepared files', readOnly: false, parameters: {}, async execute() {
      expect(await fs.readFile(path.join(input.workspace.root, 'src/a.ts'), 'utf8')).toContain('value = 2')
      return 'passed'
    } }]
    input.client.chat = async () => {
      calls++
      const names = calls === 1 ? [
        { function: { name: 'edit_file', arguments: { path: 'src/a.ts', search: 'value = 1', replace: 'value = 2' } } },
      ] : calls === 2 ? [{ function: { name: 'build_check', arguments: {} } }] : [{ function: { name: 'finish', arguments: { summary: 'Checked' } } }]
      return { ...reply(''), message: { role: 'assistant', content: '', tool_calls: names } }
    }
    expect(await runLocalAgent(input)).toMatchObject({ status: 'completed', steps: 3 })
  })

  it('verifies redundant identity edits without retrying a complete response with real changes', async () => {
    const input = await setup()
    input.client.chat = async () => reply({ ...patch, operations: [...patch.operations, { action: 'edit', path: 'src/a.ts', search: 'value = 2', replace: 'value = 2' }] })
    expect(await runLocalAgent(input)).toMatchObject({ status: 'completed', steps: 1, invalidToolCalls: 0, filesTouched: ['src/a.ts'] })
  })

  it('cannot complete a task using identity edits alone', async () => {
    const input = await setup()
    input.client.chat = async () => reply({ ...patch, operations: [{ action: 'edit', path: 'src/a.ts', search: 'value = 1', replace: 'value = 1' }] })
    expect(await runLocalAgent(input)).toMatchObject({ status: 'failed', filesTouched: [] })
  })

  it('distinguishes explicit invocation from availability, source mentions and prohibitions', () => {
    const tools = [{ name: 'remote_value', description: 'Available', parameters: {}, async execute() { return 'data' } }]
    expect(requiredToolNames(tools, 'Call remote_value and use the returned data.')).toEqual(['remote_value'])
    expect(requiredToolNames(tools, 'Do not call remote_value. Rename its mention in docs.')).toEqual([])
    expect(requiredToolNames(tools, "Don't call remote_value.")).toEqual([])
    expect(requiredToolNames(tools, 'remote_value is available. Fix the title.')).toEqual([])
    expect(requiredToolNames(tools, 'Den Wert kennst du nicht: rufe remote_value auf.')).toEqual(['remote_value'])
  })

  it('fails without inference or writes when a required tool is unavailable', async () => {
    const input = await setup()
    input.requiredTools = ['remote_value']
    input.supportsTools = false
    input.client.chat = async () => { throw new Error('Must not infer a replacement value') }
    expect(await runLocalAgent(input)).toMatchObject({ status: 'failed', steps: 0, filesTouched: [] })
  })

  it.each(['named', 'declared'])('requires %s tool results in a prior response before writes or finish', async kind => {
    const input = await setup()
    if (kind === 'named') input.task.description = 'Call remote_value and use its result in src/a.ts'
    let calls = 0, toolUsed = false
    input.extraTools = [{ name: 'remote_value', description: 'Fetch required data', required: kind === 'declared', readOnly: true, parameters: {}, async execute() { toolUsed = true; return '27' } }]
    input.client.chat = async request => {
      expect(request.format).toBeUndefined()
      calls++
      const edit = { function: { name: 'edit_file', arguments: { path: 'src/a.ts', search: 'value = 1', replace: calls === 3 ? 'value = 27' : 'value = 42' } } }
      const finish = { function: { name: 'finish', arguments: { summary: 'done' } } }
      if (calls === 2) {
        expect(await fs.readFile(path.join(input.workspace.root, 'src/a.ts'), 'utf8')).toContain('value = 1')
        return { ...reply(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'remote_value', arguments: {} } }, edit, finish] } }
      }
      if (calls === 3) {
        expect(toolUsed).toBe(true)
        expect(await fs.readFile(path.join(input.workspace.root, 'src/a.ts'), 'utf8')).toContain('value = 1')
        expect(request.messages.some(message => message.tool_name === 'remote_value' && message.content === '27')).toBe(true)
      }
      return { ...reply(''), message: { role: 'assistant', content: '', tool_calls: [edit, finish] } }
    }
    expect(await runLocalAgent(input)).toMatchObject({ status: 'completed', mode: 'tools', steps: 3 })
    expect(await fs.readFile(path.join(input.workspace.root, 'src/a.ts'), 'utf8')).toContain('value = 27')
  })

  it('preloads a nominally new file that already exists before allowing structured edits', async () => {
    const input = await setup()
    input.task.newFiles = input.task.relevantFiles
    input.task.relevantFiles = []
    input.client.chat = async request => {
      expect(request.messages[1]?.content).toContain('export const value = 1')
      return reply(patch)
    }
    expect(await runLocalAgent(input)).toMatchObject({ status: 'completed', mode: 'structured' })
  })

  it('keeps skill instructions and uses structured output despite available extra tools', async () => {
    const input = await setup()
    input.extraInstructions = 'Required style: preserve the named export.'
    input.extraTools = [{ name: 'load_skill', description: 'Load other skills', parameters: {}, async execute() { throw new Error('unused') } }]
    input.client.chat = async request => {
      expect(request.model).toBe('user-selected-model')
      expect(request.format).toBeDefined()
      expect(request.tools).toBeUndefined()
      expect(request.messages[0]?.content).toContain(input.extraInstructions)
      expect(request.options?.num_predict).toBe(2048)
      return reply(patch)
    }
    expect(await runLocalAgent(input)).toMatchObject({ status: 'completed', mode: 'structured', steps: 1 })
  })

  it('switches before editing when a required skill or external tool must be read', async () => {
    const input = await setup()
    let calls = 0, loaded = false
    input.extraTools = [{ name: 'load_skill', description: 'Read required skill', parameters: {}, async execute() { loaded = true; return 'value must equal 2' } }]
    input.client.chat = async request => {
      calls++
      if (calls === 1) return reply({ summary: 'Need the required skill', needs_tools: true, operations: [] })
      expect(request.tools?.some(tool => tool.function.name === 'load_skill')).toBe(true)
      if (calls === 2) return { ...reply(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'load_skill', arguments: {} } }] } }
      expect(loaded).toBe(true)
      return { ...reply(''), message: { role: 'assistant', content: '', tool_calls: [
        { function: { name: 'edit_file', arguments: { path: 'src/a.ts', search: 'value = 1', replace: 'value = 2' } } },
        { function: { name: 'finish', arguments: { summary: 'Fixed' } } },
      ] } }
    }
    expect(await runLocalAgent(input)).toMatchObject({ status: 'completed', mode: 'tools', steps: 3, completionTokens: 90 })
  })

  it.each(['structured', 'tools'])('discards a token-truncated %s batch before any writes', async mode => {
    const input = await setup()
    input.preferStructured = mode === 'structured'
    input.client.chat = async () => ({ ...reply(patch), doneReason: 'length', message: { ...reply(patch).message, tool_calls: [
      { function: { name: 'edit_file', arguments: patch.operations[0]! } }, { function: { name: 'finish', arguments: { summary: 'partial' } } },
    ] } })
    expect(await runLocalAgent(input)).toMatchObject({ status: 'failed', errorKind: 'resource_limit', filesTouched: [] })
    expect(await fs.readFile(path.join(input.workspace.root, 'src/a.ts'), 'utf8')).toContain('value = 1')
  })

  it('does not report a partially applied structured batch as success after exhausted retries', async () => {
    const input = await setup()
    input.client.chat = async () => reply({ ...patch, operations: [...patch.operations, { ...patch.operations[0], path: '../escape.ts' }] })
    expect(await runLocalAgent(input)).toMatchObject({ status: 'failed', errorKind: 'invalid_output' })
  })

  it('cannot clear a failed remaining operation with an empty follow-up response', async () => {
    const input = await setup()
    let calls = 0
    input.client.chat = async () => reply(calls++ === 0
      ? { ...patch, operations: [...patch.operations, { ...patch.operations[0], path: '../escape.ts' }] }
      : { summary: 'Finished', operations: [] })
    expect(await runLocalAgent(input)).toMatchObject({ status: 'failed', errorKind: 'invalid_output' })
  })

  it('rejects a disconnected stream even when the received JSON is parseable', async () => {
    const client = new OllamaClient('http://unused', async () => new Response(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(patch) }, done: false }) + '\n'))
    await expect(client.chat({ model: 'any', messages: [] })).rejects.toMatchObject({ kind: 'invalid_response' })
  })
})
