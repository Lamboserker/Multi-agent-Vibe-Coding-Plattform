import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeToolCall, recoverTextToolCalls, runLocalAgent } from './local-agent.js'
import { WorkspaceFiles, DEFAULT_SCOPE } from '../patch/workspace-files.js'
import { tempDir } from '../test-utils.js'
import type { OllamaChatRequest, OllamaChatResult } from '../ollama/client.js'

const task = { id: 'task-001', title: 'Fix', description: 'Update src/a.ts', relevantFiles: ['src/a.ts'], newFiles: [], acceptanceCriteria: ['correct'] }
const reply = (content: string, calls?: Array<{ name: string; arguments: Record<string, unknown> }>): OllamaChatResult => ({ message: { role: 'assistant', content, tool_calls: calls?.map(call => ({ function: call })) }, promptTokens: 10, completionTokens: 10, totalDurationMs: 1, loadDurationMs: 0 })
async function setup() {
  const root = tempDir()
  await fs.mkdir(path.join(root, 'src'))
  await fs.writeFile(path.join(root, 'src/a.ts'), 'export const value = 1\n')
  return { root, workspace: new WorkspaceFiles(root, { ...DEFAULT_SCOPE, writablePatterns: ['src/**'] }) }
}

describe('bounded agent work', () => {
  it('recovers nested XML/Markdown calls once and ignores examples in completed reasoning', () => {
    const call = { name: 'edit_file', arguments: { path: 'src/a.ts', search: 'value = 1', replace: 'value = 2' } }
    const text = '<tool_call>{"name":"write_file","arguments":{"path":"src/bad.ts","content":"example"}}</tool_call>\n</think>\n```json\n<tool_call>' + JSON.stringify(call) + '</tool_call>\n```'
    expect(recoverTextToolCalls(text)).toEqual([{ function: call }])
    expect(recoverTextToolCalls('```json\n' + JSON.stringify(call) + '\n```')).toEqual([{ function: call }])
  })

  it('treats a successful finish as terminal within its batch', async () => {
    const { workspace } = await setup()
    const result = await runLocalAgent({ workspace, task, context: '', model: 'arbitrary', supportsTools: true, client: { async chat() { return reply('', [
      { name: 'edit_file', arguments: { path: 'src/a.ts', search: 'value = 1', replace: 'value = 2' } },
      { name: 'finish', arguments: { summary: 'done' } },
      { name: 'write_file', arguments: { path: 'src/bad.ts', content: 'after finish' } },
    ]) } } })
    expect(result.status).toBe('completed')
    expect(result.filesTouched).toEqual(['src/a.ts'])
  })
  it('rejects identical replacements without marking files touched', async () => {
    const { workspace } = await setup()
    const outcome = await executeToolCall({ function: { name: 'edit_file', arguments: { path: 'src/a.ts', search: 'value = 1', replace: 'value = 1' } } }, workspace)
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('identical')
    expect(workspace.touched.size).toBe(0)
  })
  it('reads only final structured output after completed reasoning and fenced JSON', async () => {
    const { root, workspace } = await setup()
    const result = await runLocalAgent({ workspace, task, context: '', model: 'arbitrary', supportsTools: true, preferStructured: true, client: { async chat(request) {
      expect(request.tools).toBeUndefined()
      return reply('An example: {"operations":[{"action":"write","path":"src/bad.ts","content":"wrong"}]}\n</think>\n```json\n' + JSON.stringify({ summary: 'fixed', operations: [{ action: 'edit', path: 'src/a.ts', search: 'value = 1', replace: 'value = 2' }] }) + '\n```')
    } } })
    expect(result.status).toBe('completed')
    expect(result.steps).toBe(1)
    expect(result.filesTouched).toEqual(['src/a.ts'])
    expect(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8')).toContain('value = 2')
  })
  it('rejects oversized instructions before paying for inference', async () => {
    const { workspace } = await setup()
    let calls = 0
    const result = await runLocalAgent({ workspace, task, context: 'x'.repeat(20000), numCtx: 2048, model: 'arbitrary', supportsTools: true, client: { async chat() { calls++; return reply('') } } })
    expect(calls).toBe(0)
    expect(result.errorKind).toBe('resource_limit')
  })

  it('refreshes current files after a partially successful structured response', async () => {
    const { root, workspace } = await setup()
    let count = 0
    const result = await runLocalAgent({ workspace, task, context: '', model: 'arbitrary', supportsTools: false, client: { async chat(request) {
      if (count++ === 0) return reply(JSON.stringify({ operations: [
        { action: 'edit', path: 'src/a.ts', search: 'value = 1', replace: 'value = 2' },
        { action: 'edit', path: 'src/a.ts', search: 'missing', replace: 'fixed' },
      ] }))
      expect(request.messages[1]!.content).toContain('export const value = 2')
      expect(request.messages[1]!.content).toContain('only remaining fixes')
      return reply(JSON.stringify({ operations: [{ action: 'edit', path: 'src/a.ts', search: 'value = 2', replace: 'value = 3' }] }))
    } } })
    expect(result.status).toBe('completed')
    expect(count).toBe(2)
    expect(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8')).toContain('value = 3')
  })

  it('does not finish a batch when an edit failed before finish', async () => {
    const { root, workspace } = await setup()
    let count = 0
    const result = await runLocalAgent({ workspace, task, context: '', model: 'arbitrary', supportsTools: true, client: { async chat() {
      if (count++ === 0) return reply('', [
        { name: 'edit_file', arguments: { path: 'src/a.ts', search: 'missing', replace: 'value = 2' } },
        { name: 'finish', arguments: { summary: 'done' } },
      ])
      return reply('', [
        { name: 'edit_file', arguments: { path: 'src/a.ts', search: 'value = 1', replace: 'value = 2' } },
        { name: 'finish', arguments: { summary: 'done' } },
      ])
    } } })
    expect(result.status).toBe('completed')
    expect(count).toBe(2)
    expect(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8')).toContain('value = 2')
  })

  it('compacts whole old tool rounds, preserving task and refreshed files', async () => {
    const { workspace } = await setup()
    let count = 0
    let compacted = false
    const seen: OllamaChatRequest[] = []
    const result = await runLocalAgent({ workspace, task, context: '', numCtx: 4096, model: 'arbitrary', supportsTools: true,
      extraTools: [{ name: 'inspect', description: 'Inspect', parameters: { type: 'object' }, async execute() { return 'x'.repeat(2500) } }],
      client: { async chat(request) {
        seen.push(structuredClone(request))
        compacted ||= request.messages[1]!.content.includes('Older tool rounds omitted')
        count++
        return count < 6 ? reply('', [{ name: 'inspect', arguments: {} }]) : reply('', [
          { name: 'edit_file', arguments: { path: 'src/a.ts', search: 'value = 1', replace: 'value = 2' } },
          { name: 'finish', arguments: { summary: 'done' } },
        ])
      } },
    })
    expect(result.status).toBe('completed')
    expect(compacted).toBe(true)
    for (const request of seen) {
      expect(request.messages[1]!.content).toContain('Update src/a.ts')
      expect(request.messages[2]?.role).not.toBe('tool')
    }
  })
})
