// The built-in UI design skills reach a small local model: a new component follows the design rules
// (tokens instead of ad-hoc colors, interaction states, tabular numbers). Local model only, no premium call.
//
//   MAC_E2E_LIVE=1 MAC_E2E_MODEL=qwen2.5-coder:7b MAC_E2E_OLLAMA_URL=http://127.0.0.1:11435 \
//   MAC_E2E_OLLAMA_MODELS=D:\ollama-models node --test e2e/ui-skill.live.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { launch, newProfile, openProject, prepareRepository, quit, waitUntil } from './helpers.mjs'

const live = process.env.MAC_E2E_LIVE === '1'
const model = process.env.MAC_E2E_MODEL ?? 'qwen2.5-coder:7b'
const ollamaUrl = process.env.MAC_E2E_OLLAMA_URL ?? 'http://127.0.0.1:11434'
const REQUEST =
  'Erstelle eine React-Komponente `StatCard` in `src/components/StatCard.tsx` (Props `label: string`, `value: string`, `trend: number`) für ein Dashboard, ' +
  'mit eigenem Stylesheet `src/components/StatCard.css`, das die Komponente importiert. Die Karte zeigt Label, Wert und den Trend in Prozent.'

test('a UI task gets the design skill and the result follows it', { skip: !live && 'set MAC_E2E_LIVE=1 (needs Ollama with the model)', timeout: 60 * 60_000 }, async () => {
  const repo = prepareRepository({ install: true })
  const { app, page, api } = await launch(newProfile())
  try {
    await api('PATCH', '/settings', { orchestrator: null, ollamaBaseUrl: ollamaUrl, ollamaModelsDir: process.env.MAC_E2E_OLLAMA_MODELS ?? null, planApproval: true, autoStartSmallPlans: false, approvalMode: 'manual', premiumReviewPolicy: 'never', fastPath: false })
    if (!(await api('GET', '/local-models/ollama')).data.reachable) await api('POST', '/local-models/ollama/start')
    await waitUntil(async () => (await api('GET', '/local-models/ollama')).data.reachable, 60_000, 'ollama reachable')
    await api('PUT', '/local-models/roles', { fast: model, balanced: model, advanced: model })
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    await openProject(app, page, repo)
    await page.locator('#chat-input').fill(REQUEST)
    await page.getByRole('button', { name: 'Senden' }).click()
    await page.getByRole('button', { name: 'Ausführung starten' }).waitFor({ timeout: 180_000 })
    await page.getByRole('button', { name: 'Ausführung starten' }).click()
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const sessionId = (await api('GET', `/projects/${projectId}/sessions`)).data[0].id
    const executionId = await waitUntil(async () => (await api('GET', `/sessions/${sessionId}`)).data.tasks[0]?.execution?.id, 30_000, 'execution')
    const status = await waitUntil(async () => { const value = (await api('GET', `/executions/${executionId}`)).data.status; return ['pending', 'running', 'integrating'].includes(value) ? null : value }, 45 * 60_000, 'run finished', 2000)
    const events = (await api('GET', `/executions/${executionId}/events`)).data.map((event) => `${event.type}: ${event.message}`)
    console.log('[e2e] agent', JSON.stringify(events.filter((line) => line.startsWith('agent_started'))))
    assert.ok(events.some((line) => /agent_started: .*ui-design/.test(line)), 'the agent started with the ui-design skill')
    const run = (await api('GET', `/executions/${executionId}`)).data
    // the integrated diff, or the last attempt's patch when the run failed (to see the design anyway)
    const diff = run.finalDiff || (await api('GET', `/sessions/${sessionId}`)).data.tasks[0]?.subtasks?.[0]?.patchText || ''
    const added = (file) => {
      const section = diff.split('diff --git ').find((part) => part.includes(`+++ b/${file}`)) ?? ''
      return section.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1)).join('\n')
    }
    const css = added('src/components/StatCard.css')
    console.log(`[e2e] StatCard.css\n${css}`)
    assert.equal(status, 'awaiting_approval', JSON.stringify(events.slice(-8)))
    assert.match(css, /var\(--/, 'uses design tokens')
    // every token the result uses is defined (by the model or by the deterministic design fixes)
    const defined = new Set([...diff.matchAll(/^\+.*?(--[\w-]+)\s*:/gm)].map((match) => match[1]))
    const used = [...new Set([...diff.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]))]
    assert.deepEqual(used.filter((name) => !defined.has(name)), [], `undefined tokens (defined: ${[...defined].join(', ')})`)
    assert.match(css, /border-radius/)
    assert.doesNotMatch(css, /^\s*\/\//m, 'CSS comments only as /* */')
    assert.doesNotMatch(added('src/components/StatCard.tsx'), /style=\{\{[^}]*['"]--[\w-]+['"]/, 'JSX styles use var(--…)')
    console.log('[e2e] model followed', JSON.stringify({ tabularNums: /tabular-nums/.test(css), hover: /:hover|:focus/.test(css), designFixes: events.filter((line) => line.startsWith('design_fixed')) }))
  } finally {
    await quit(app)
  }
})
