// The shipped GitHub and GitLab plugins against local API test servers (127.0.0.1). Nothing is sent
// to real repositories: the API URL setting points at the test server, which records every request.
// The token comes from the (simulated) desktop vault, exactly like in the app.
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'

const vault = new Map<string, string>([['plugin:github/token', 'gh-test-token'], ['plugin:gitlab/token', 'gl-test-token']])
const listeners: Array<(message: { data: unknown }) => void> = []
;(process as unknown as { parentPort: unknown }).parentPort = {
  on: (_event: string, listener: (message: { data: unknown }) => void) => listeners.push(listener),
  postMessage: (message: { id: number; method: string; params: { scope: string; name: string } }) => {
    const value = message.method === 'secret:get' ? vault.get(`${message.params.scope}/${message.params.name}`) ?? null : null
    queueMicrotask(() => listeners.forEach((listener) => listener({ data: { type: 'shell-response', id: message.id, ok: true, value } })))
  },
}

const here = path.dirname(fileURLToPath(import.meta.url))
const db = useTempDatabase('mac-forge-plugins-')
process.env.MAC_DATA_DIR = db.dir
process.env.MAC_BUILTIN_PLUGINS_DIR = path.resolve(here, '../../../../plugins')
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { SettingsService } = await import('../runtime/settings.service.js')
const { PluginsService } = await import('./plugins.service.js')

const hostBuilt = existsSync(path.resolve(here, '../../dist/plugins/host/plugin-host.cjs'))
const prisma = new PrismaService()
const events = new EventBusService()
const plugins = new PluginsService(prisma, events, new SettingsService(prisma, events))
const requests: Array<{ method: string; url: string; auth?: string; body?: unknown }> = []
let server: Server
let base = ''

const user = (login: string) => ({ login, username: login })
const GITHUB: Record<string, unknown> = {
  '/user/repos?per_page=100&page=1': [{ full_name: 'acme/demo', default_branch: 'main', private: true }, { full_name: 'acme/lib', default_branch: 'dev', private: false }],
  '/repos/acme/demo/branches?per_page=100&page=1': [{ name: 'main', commit: { sha: 'abc123' }, protected: true }, { name: 'feature/x', commit: { sha: 'def456' }, protected: false }],
  '/repos/acme/demo/pulls/7/reviews?per_page=100': [{ user: user('bob'), state: 'APPROVED', body: 'LGTM' }],
  '/repos/acme/demo/pulls/7': { number: 7, title: 'Add feature', state: 'open', draft: false, head: { ref: 'feature/x' }, base: { ref: 'main' }, user: user('alice'), body: 'Beschreibung' },
  '/repos/acme/demo/pulls/7/files?per_page=100': [{ filename: 'src/a.ts', additions: 3, deletions: 1 }],
  '/repos/acme/demo/pulls/7/comments?per_page=50': [{ user: user('bob'), path: 'src/a.ts', line: 2, body: 'Nit' }],
  '/repos/acme/demo/issues/5': { number: 5, title: 'Bug', state: 'open', user: user('carol'), labels: [{ name: 'bug' }], body: 'Fehler' },
  '/repos/acme/demo/issues/5/comments?per_page=30': [],
  '/repos/acme/demo/issues?state=open&per_page=50': [{ number: 5, title: 'Bug', labels: [{ name: 'bug' }] }, { number: 7, title: 'PR', labels: [], pull_request: {} }],
}
const GITLAB: Record<string, unknown> = {
  '/projects?per_page=100&page=1&simple=true&search=demo&membership=true': [{ id: 42, path_with_namespace: 'group/demo', default_branch: 'main' }],
  '/projects/group%2Fdemo/merge_requests?state=opened&per_page=30': [{ iid: 3, title: 'MR', author: user('dora'), source_branch: 'fix', updated_at: '2026-10-01T10:00:00Z' }],
  '/projects/group%2Fdemo/issues?state=opened&per_page=30': [{ iid: 9, title: 'Issue', labels: ['bug'], updated_at: '2026-10-01T10:00:00Z' }],
  '/projects/group%2Fdemo/pipelines?per_page=10': [{ id: 100, status: 'failed', ref: 'main', created_at: '2026-10-01T10:00:00Z' }],
  '/projects/group%2Fdemo/pipelines?per_page=1': [{ id: 100, status: 'failed' }],
  '/projects/group%2Fdemo/pipelines/100/jobs?per_page=100': [{ id: 555, name: 'test', stage: 'test', status: 'failed' }, { id: 556, name: 'lint', stage: 'test', status: 'success' }],
  '/projects/group%2Fdemo/jobs/555/trace': 'FAIL src/a.test.ts\nexpected 1 to be 2',
  '/projects/group%2Fdemo/merge_requests/3': { iid: 3, title: 'MR', state: 'opened', source_branch: 'fix', target_branch: 'main', author: user('dora'), description: 'Fix' },
  '/projects/group%2Fdemo/merge_requests/3/diffs?per_page=100': [{ new_path: 'src/b.ts', new_file: true }],
}

beforeAll(async () => {
  await applyMigrations(prisma, MIGRATIONS_DIR, () => undefined)
  server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const url = request.url!
      const forge = url.startsWith('/github') ? 'github' : 'gitlab'
      const route = url.replace(/^\/(github|gitlab\/api\/v4)/, '')
      const auth = forge === 'github' ? request.headers.authorization : request.headers['private-token']
      requests.push({ method: request.method!, url, auth: auth as string | undefined, body: raw ? JSON.parse(raw) : undefined })
      const expected = forge === 'github' ? 'Bearer gh-test-token' : 'gl-test-token'
      if (auth !== expected) return response.writeHead(401).end('{"message":"Bad credentials"}')
      if (forge === 'github' && request.method === 'POST' && route === '/repos/acme/demo/pulls/7/reviews') return response.writeHead(200).end(JSON.stringify({ id: 9001, state: (JSON.parse(raw) as { event: string }).event === 'APPROVE' ? 'APPROVED' : 'COMMENTED' }))
      if (forge === 'github' && request.method === 'POST' && route === '/repos/acme/demo/issues') return response.writeHead(201).end(JSON.stringify({ number: 6, html_url: `${base}/acme/demo/issues/6` }))
      const body = (forge === 'github' ? GITHUB : GITLAB)[route]
      if (body === undefined) return response.writeHead(404).end('{"message":"Not Found"}')
      response.writeHead(200, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  if (!hostBuilt) return
  for (const id of ['github', 'gitlab']) {
    const manifest = JSON.parse(readFileSync(path.join(process.env.MAC_BUILTIN_PLUGINS_DIR!, id, 'multi-ai-coder-plugin.json'), 'utf8')) as { permissions: Record<string, unknown> }
    await plugins.enable(id, manifest.permissions)
  }
  // API URLs point at the local test server before any request is made (never the real services)
  await plugins.updateSettings('github', { apiUrl: `${base}/github`, repository: 'acme/demo' })
  await plugins.updateSettings('gitlab', { apiUrl: `${base}/gitlab/api/v4`, project: 'group/demo' })
}, 60_000)

afterAll(async () => {
  await plugins.onApplicationShutdown()
  server?.close()
  await prisma.$disconnect()
  db.cleanup()
})

const rows = (result: { view?: unknown }) => ((result.view as { rows: Array<{ cells: string[] }> }).rows ?? []).map((row) => row.cells)

describe.skipIf(!hostBuilt)('GitHub plugin against a local API test server', () => {
  it('repositories, branches, reviews, pull request and issue context', async () => {
    expect(rows(await plugins.runCommand('github', 'repositories', {}))).toEqual([['acme/demo', 'main', 'true'], ['acme/lib', 'dev', 'false']])
    expect(rows(await plugins.runCommand('github', 'branches', {}))).toEqual([['main', 'abc123', 'true'], ['feature/x', 'def456', 'false']])
    expect(rows(await plugins.runCommand('github', 'reviews', { number: 7 }))).toEqual([['bob', 'APPROVED', 'LGTM']])
    const pr = await plugins.runCommand('github', 'toChat', { kind: 'pull', number: 7 })
    expect(pr.text).toContain('Pull Request #7: Add feature')
    expect(pr.text).toContain('src/a.ts (+3 −1)')
    expect(pr.text).toContain('bob zu src/a.ts:2: Nit')
    expect((await plugins.runCommand('github', 'toChat', { kind: 'issue', number: 5 })).text).toContain('Labels: bug')
    expect(await plugins.invokeTool('github', 'github_issues', { query: 'bu' })).toEqual([{ number: 5, title: 'Bug', labels: ['bug'] }])
    expect(requests.every((request) => request.auth === 'Bearer gh-test-token')).toBe(true)
  }, 60_000)

  it('creating a review needs the confirmation and posts exactly the entered review', async () => {
    await expect(plugins.runCommand('github', 'createReview', { number: 7, event: 'APPROVE', body: 'ok' })).rejects.toThrow(/Bestätigung/)
    await expect(plugins.runCommand('github', 'createReview', { number: 7, event: 'MERGE', body: 'x', confirmed: true })).rejects.toThrow(/Ungültige/)
    const result = await plugins.runCommand('github', 'createReview', { number: 7, event: 'APPROVE', body: 'Sieht gut aus', confirmed: true })
    expect(result.message).toBe('Review 9001: APPROVED')
    const posted = requests.filter((request) => request.method === 'POST')
    expect(posted).toEqual([{ method: 'POST', url: '/github/repos/acme/demo/pulls/7/reviews', auth: 'Bearer gh-test-token', body: { body: 'Sieht gut aus', event: 'APPROVE' } }])
    expect((await plugins.runCommand('github', 'createIssue', { title: 'Neu', body: 'Text', confirmed: true })).message).toContain('Issue #6 angelegt')
  }, 60_000)

  it('authentication errors are explained', async () => {
    vault.set('plugin:github/token', 'revoked')
    await expect(plugins.runCommand('github', 'branches', {})).rejects.toThrow(/Token ungültig/)
    vault.set('plugin:github/token', 'gh-test-token')
  }, 60_000)
})

describe.skipIf(!hostBuilt)('GitLab plugin against a local API test server', () => {
  it('projects, merge requests, issues, pipelines and failed job logs', async () => {
    expect(rows(await plugins.runCommand('gitlab', 'projects', { search: 'demo' }))).toEqual([['42', 'group/demo', 'main']])
    const view = JSON.stringify(await plugins.renderView('gitlab', 'main'))
    expect(view).toContain('GitLab · group/demo')
    expect(view).toContain('MR')
    expect(view).toContain('Issue')
    expect(view).toContain('"failed"')
    expect((await plugins.runCommand('gitlab', 'toChat', { iid: 3 })).text).toContain('src/b.ts (neu)')
    expect(String(await plugins.invokeTool('gitlab', 'gitlab_failed_jobs', {}))).toContain('expected 1 to be 2')
    expect(requests.filter((request) => request.url.startsWith('/gitlab')).every((request) => request.auth === 'gl-test-token' && request.method === 'GET')).toBe(true)
  }, 60_000)

  it('authentication errors are explained', async () => {
    vault.set('plugin:gitlab/token', 'revoked')
    await expect(plugins.runCommand('gitlab', 'projects', {})).rejects.toThrow(/Token ungültig/)
    vault.set('plugin:gitlab/token', 'gl-test-token')
  }, 60_000)
})
