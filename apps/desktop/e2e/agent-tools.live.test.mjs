// Live test (Phase 0.3, E): a real local model uses an MCP tool and follows a skill during a real run.
// Real: Electron app, runtime, git worktrees, Ollama model, MCP server process (official SDK).
// No premium call: no orchestrator is selected; the deterministic fallback planner creates the plan.
//
//   MAC_E2E_LIVE=1 MAC_E2E_MODEL=qwen2.5-coder:7b MAC_E2E_OLLAMA_URL=http://127.0.0.1:11435 \
//   MAC_E2E_OLLAMA_MODELS=D:\ollama-models node --test e2e/agent-tools.live.test.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { answerFolderDialog, appDir, launch, newProfile, prepareRepository, quit, resultsDir, stamp, waitUntil } from './helpers.mjs'

const live = process.env.MAC_E2E_LIVE === '1'
const model = process.env.MAC_E2E_MODEL ?? 'qwen2.5-coder:7b'
const ollamaUrl = process.env.MAC_E2E_OLLAMA_URL ?? 'http://127.0.0.1:11434'
const testServer = path.resolve(appDir, '../api/src/mcp/testing/test-server.mjs')
const REQUEST =
  'Erstelle die Datei `src/magic.ts`, die die Konstante für die Magic Number exportiert. ' +
  'Den Wert kennst du nicht: rufe das Werkzeug `mcp_config_magic_number` auf und übernimm die gelieferte Zahl.'

test('a local agent uses an assigned MCP tool and a matching skill in a real run', { skip: !live && 'set MAC_E2E_LIVE=1 (needs Ollama with the model)', timeout: 40 * 60_000 }, async () => {
  const id = stamp()
  const report = { startedAt: new Date().toISOString(), model, steps: [] }
  const step = (name, detail) => {
    report.steps.push({ name, at: new Date().toISOString(), ...detail })
    console.log(`[e2e] ${name}`, detail ? JSON.stringify(detail).slice(0, 600) : '')
  }
  const repo = prepareRepository({ install: true })
  const profile = newProfile()
  const { app, page, api, consoleErrors } = await launch(profile)
  try {
    await api('PATCH', '/settings', { orchestrator: null, ollamaBaseUrl: ollamaUrl, ollamaModelsDir: process.env.MAC_E2E_OLLAMA_MODELS ?? null, planApproval: true, approvalMode: 'manual', premiumReviewPolicy: 'never', fastPath: false })
    if (!(await api('GET', '/local-models/ollama')).data.reachable) await api('POST', '/local-models/ollama/start')
    await waitUntil(async () => (await api('GET', '/local-models/ollama')).data.reachable, 60_000, 'ollama reachable')
    await api('PUT', '/local-models/roles', { fast: model, balanced: model, advanced: model })
    await api('POST', '/onboarding/complete')

    // MCP server for coder agents; only magic_number is allowed for agents
    const server = (await api('POST', '/mcp/servers', { name: 'config', transport: 'stdio', command: process.execPath, args: [testServer], agents: ['coder'], defaultPolicy: 'off', toolPolicies: { magic_number: 'allow' } })).data
    assert.ok(server.id, JSON.stringify(server))
    assert.equal((await api('POST', `/mcp/servers/${server.id}/test`)).status, 201)
    // a user skill whose trigger ("magic") matches the task
    const skill = await api('POST', '/skills', {
      scope: 'user',
      name: 'magic-constants',
      description: 'How configuration constants are written in this project.',
      triggers: ['magic', 'konstante'],
      body: 'Configuration constants are exported as `export const MAGIC_NUMBER = <value>` (UPPER_SNAKE_CASE) and get the JSDoc comment `/** Provided by the configuration service. */` directly above.',
    })
    assert.equal(skill.status, 201, JSON.stringify(skill.data))
    step('MCP server and skill configured', { tools: (await api('GET', `/mcp/servers/${server.id}`)).data.tools.map((tool) => `${tool.name}:${tool.policy}`) })

    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await answerFolderDialog(app, repo)
    await page.getByRole('button', { name: 'Ordner öffnen' }).first().click()
    await page.locator('[data-path="src"]').first().waitFor({ timeout: 30_000 })

    await page.locator('#chat-input').fill(REQUEST)
    await page.getByRole('button', { name: 'Senden' }).click()
    await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 120_000 })
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const sessionId = (await api('GET', `/projects/${projectId}/sessions`)).data[0].id
    await page.getByRole('button', { name: 'Ausführung starten' }).click()
    const executionId = await waitUntil(async () => (await api('GET', `/sessions/${sessionId}`)).data.tasks[0]?.execution?.id, 30_000, 'execution created')
    const finalStatus = await waitUntil(async () => {
      const status = (await api('GET', `/executions/${executionId}`)).data.status
      return ['pending', 'running', 'integrating'].includes(status) ? null : status
    }, 30 * 60_000, 'run finished', 2000)
    const run = (await api('GET', `/executions/${executionId}`)).data
    const events = (await api('GET', `/executions/${executionId}/events`)).data
    const eventList = Array.isArray(events) ? events : (events.events ?? [])
    const started = eventList.filter((event) => event.type === 'agent_started').map((event) => event.message)
    const toolCalls = eventList.filter((event) => event.type === 'tool_call').map((event) => event.message)
    if (run.integrationBranch) report.content = execFileSync('git', ['show', `${run.integrationBranch}:src/magic.ts`], { cwd: repo, encoding: 'utf8' }).slice(0, 2000)
    step('file', { content: report.content })
    step('run finished', { finalStatus, started, toolCalls: toolCalls.slice(0, 20), premiumCalls: run.usage?.premium.calls, validation: run.finalValidation?.summary })

    assert.equal(run.usage?.premium.calls ?? 0, 0, 'no premium call happened')
    assert.ok(started.some((message) => /Skills: .*magic-constants/.test(message) && /1 MCP-Werkzeug/.test(message)), `agent got the skill and the MCP tool: ${started.join(' | ')}`)
    assert.ok(toolCalls.some((message) => message.includes('mcp_config_magic_number')), 'the agent called the MCP tool')
    const mcpLogs = (await api('GET', `/mcp/servers/${server.id}`)).data.logs.map((line) => line.message)
    assert.ok(mcpLogs.some((line) => line.startsWith('agent call magic_number')), 'the MCP server saw the agent call')
    assert.equal(finalStatus, 'awaiting_approval', `run status ${finalStatus}`)
    const content = execFileSync('git', ['show', `${run.integrationBranch}:src/magic.ts`], { cwd: repo, encoding: 'utf8' })
    step('result', { content })
    assert.match(content, /7341/, 'the value from the MCP tool is in the file')
    report.skillFollowed = /MAGIC_NUMBER/.test(content) && /Provided by the configuration service/.test(content)
    step('skill followed', { skillFollowed: report.skillFollowed })
    assert.ok(/MAGIC_NUMBER/.test(content), 'the naming rule of the skill was applied')
    report.ok = true
  } finally {
    report.consoleErrors = consoleErrors
    writeFileSync(path.join(resultsDir, `${id}-agent-tools-live.json`), JSON.stringify(report, null, 2))
    await quit(app)
  }
})
