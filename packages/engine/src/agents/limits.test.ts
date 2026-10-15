import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runLocalAgent } from './local-agent.js'
import { OllamaClient } from '../ollama/client.js'
import { WorkspaceFiles } from '../patch/workspace-files.js'
import { tempDir } from '../test-utils.js'

const task = { id: 'bounded', title: 'Create a file', description: 'Create src/a.ts', relevantFiles: [], newFiles: ['src/a.ts'], acceptanceCriteria: ['valid'] }
const scope = { writablePatterns: ['src/**'], deniedPatterns: [], maxWriteBytes: 10000, maxReadBytes: 10000, allowDelete: false }
const reply = (content: string, promptTokens = 10, completionTokens = 10) => ({ message: { role: 'assistant' as const, content }, promptTokens, completionTokens, totalDurationMs: 1, loadDurationMs: 0 })

describe('local hard resource limits', () => {
  it.each(['tools', 'structured'])('discards an oversized %s response before file operations', async (mode) => {
    const root = tempDir(); await fs.mkdir(path.join(root, 'src'))
    const workspace = new WorkspaceFiles(root, scope)
    const response = { ...reply(JSON.stringify({ operations: [{ action: 'write', path: 'src/a.ts', content: 'export {}' }] }), 10, 10), message: { ...reply('').message, content: JSON.stringify({ operations: [{ action: 'write', path: 'src/a.ts', content: 'export {}' }] }), tool_calls: [{ function: { name: 'write_file', arguments: { path: 'src/a.ts', content: 'export {}' } } }] } }
    const client = { chat: async () => response } as Pick<OllamaClient, 'chat'>
    const result = await runLocalAgent({ client, workspace, task, context: '', model: 'fake', supportsTools: mode === 'tools', maxOutputTokens: 5 })
    expect(result.errorKind).toBe('resource_limit'); expect(result.status).toBe('failed'); expect(result.filesTouched).toEqual([])
  })
  it('discards a context-overflow response', async () => {
    const root = tempDir(); const workspace = new WorkspaceFiles(root, scope)
    const client = { chat: async () => reply('{}', 2048, 1) } as Pick<OllamaClient, 'chat'>
    const result = await runLocalAgent({ client, workspace, task, context: '', model: 'fake', supportsTools: false, numCtx: 1024 })
    expect(result.errorKind).toBe('resource_limit'); expect(result.filesTouched).toEqual([])
  })
  it('deducts output tokens between structured repair rounds', async () => {
    const root = tempDir(); const workspace = new WorkspaceFiles(root, scope)
    const limits: Array<number | undefined> = []
    const client = { chat: async (request) => { limits.push(request.options?.num_predict); return reply('invalid json', 10, 3) } } as Pick<OllamaClient, 'chat'>
    const result = await runLocalAgent({ client, workspace, task, context: '', model: 'fake', supportsTools: false, maxOutputTokens: 5 })
    expect(limits).toEqual([5, 2]); expect(result.errorKind).toBe('resource_limit')
  })
})
