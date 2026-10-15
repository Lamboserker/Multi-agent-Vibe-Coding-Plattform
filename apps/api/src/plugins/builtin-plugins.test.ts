// End-to-end tests of the plugins shipped in <repo>/plugins, running in real host processes.
// Local only: HTTP and browser checks use a server on 127.0.0.1. GitHub/GitLab are exercised only
// with MAC_TEST_NETWORK=1 (unauthenticated public API calls), Docker only when the daemon runs,
// PostgreSQL only with MAC_TEST_POSTGRES_URL.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const db = useTempDatabase('mac-builtin-plugins-')
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
const settings = new SettingsService(prisma, events)
const service = new PluginsService(prisma, events, settings)
const repo = mkdtempSync(path.join(os.tmpdir(), 'mac-plugin-project-'))
let server: Server
let baseUrl = ''

function dockerRunning() {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe', timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

beforeAll(async () => {
  await applyMigrations(prisma, MIGRATIONS_DIR, () => undefined)
  await service.onModuleInit()
  await service.start()
  // a project with a SQLite database
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(path.join(repo, 'prisma'))
  const { DatabaseSync } = await import('node:sqlite')
  const sqlite = new DatabaseSync(path.join(repo, 'prisma', 'dev.db'))
  sqlite.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO users (name) VALUES ('Ada'), ('Linus');")
  sqlite.close()
  const project = await prisma.project.create({ data: { name: 'plugin-project', repoPath: repo } })
  await settings.update({ lastProjectId: project.id })
  // local web server for API Tools and Browser Testing
  server = createServer((request, response) => {
    if (request.url === '/api/echo') {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ method: request.method, body, auth: request.headers.authorization ?? null }))
      })
      return
    }
    if (request.url === '/missing.js') {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<!doctype html><title>Plugin Test Page</title><h1 id="greeting">Hallo</h1><input id="name"><button id="go" onclick="document.getElementById('greeting').textContent = 'Hallo ' + document.getElementById('name').value">Go</button><script>console.error('deliberate console error'); console.log('page ready')</script><script src="/missing.js"></script>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
}, 60_000)

afterAll(async () => {
  await service.onApplicationShutdown()
  server?.close()
  await prisma.$disconnect()
  db.cleanup()
})

describe.skipIf(!hostBuilt)('built-in plugins', () => {
  it('registers all shipped plugins as trusted, disabled until permissions are granted', async () => {
    const plugins = await service.list()
    expect(plugins.map((plugin) => plugin.id).sort()).toEqual(['api-tools', 'browser-testing', 'database-tools', 'docker', 'github', 'gitlab', 'reference-extensions'])
    for (const plugin of plugins) {
      expect(plugin).toMatchObject({ source: 'builtin', trust: 'trusted', enabled: false })
      expect(plugin.missingGrants.length).toBeGreaterThan(0)
    }
    const catalog = await service.catalog()
    expect(catalog.entries).toHaveLength(7)
  })

  it('Database Tools: schema, read queries, confirmed writes, read-only agent tool', async () => {
    await service.enable('database-tools', { fs: 'project-write', secrets: ['postgresUrl'], native: true })
    await service.updateSettings('database-tools', { sqliteFile: 'prisma/dev.db' })
    const view = JSON.stringify(await service.renderView('database-tools', 'main'))
    expect(view).toContain('users')
    expect(view).toContain('prisma/dev.db')
    const select = JSON.stringify(await service.runCommand('database-tools', 'query', { sql: 'SELECT name FROM users ORDER BY id' }))
    expect(select).toContain('Ada')
    expect(select).toContain('nur lesend')
    // a write is not executed without confirmation
    const pending = JSON.stringify(await service.runCommand('database-tools', 'query', { sql: "INSERT INTO users (name) VALUES ('Grace')" }))
    expect(pending).toContain('erst nach Bestätigung')
    expect(JSON.stringify(await service.invokeTool('database-tools', 'db_query', { sql: 'SELECT count(*) AS n FROM users' }))).toContain('"2"')
    await service.runCommand('database-tools', 'query', { sql: "INSERT INTO users (name) VALUES ('Grace')", confirmed: true })
    expect(JSON.stringify(await service.invokeTool('database-tools', 'db_query', { sql: 'SELECT count(*) AS n FROM users' }))).toContain('"3"')
    await expect(service.invokeTool('database-tools', 'db_query', { sql: 'DELETE FROM users' })).rejects.toThrow(/read-only/)
    expect(await service.invokeTool('database-tools', 'db_schema', {})).toContain('users(id INTEGER PK, name TEXT)')
  }, 60_000)

  it.skipIf(!process.env.MAC_TEST_POSTGRES_URL)('Database Tools: PostgreSQL (SCRAM, read-only transaction)', async () => {
    await service.updateSettings('database-tools', { connection: 'postgres' })
    // the secret normally comes from the shell's vault; the test runtime has no shell
    const result = await import('../../../../plugins/database-tools/postgres.cjs' as string).then((module: { query: (url: string, sql: string) => Promise<Array<{ rows: unknown[][] }>> }) => module.query(process.env.MAC_TEST_POSTGRES_URL!, 'BEGIN TRANSACTION READ ONLY; SELECT 1 + 1; COMMIT;'))
    expect(result[1]!.rows[0]![0]).toBe('2')
    await service.updateSettings('database-tools', { connection: 'sqlite' })
  }, 60_000)

  it('API Tools: requests with environment variables, collections and the agent tool', async () => {
    await service.enable('api-tools', { network: ['*'] })
    await service.runCommand('api-tools', 'saveEnvironment', { variables: `baseUrl=${baseUrl}\ntoken=abc` })
    const sent = JSON.stringify(await service.runCommand('api-tools', 'send', { method: 'POST', url: '{{baseUrl}}/api/echo', headers: 'Authorization: Bearer {{token}}', body: '{"hello":"world"}', name: 'echo' }))
    expect(sent).toContain('200 POST')
    expect(sent).toContain('Bearer abc')
    expect(sent).toContain('hello')
    expect(JSON.stringify(await service.renderView('api-tools', 'main'))).toContain('"echo"')
    expect(JSON.stringify(await service.runCommand('api-tools', 'runCollection'))).toContain('"200"')
    const tool = (await service.invokeTool('api-tools', 'http_request', { url: '{{baseUrl}}/api/echo' })) as { status: number }
    expect(tool.status).toBe(200)
  }, 60_000)

  it('Browser Testing: screenshot, console errors, failed requests and automation steps', async () => {
    await service.enable('browser-testing', { native: true })
    const checked = (await service.runCommand('browser-testing', 'check', { url: baseUrl })) as { title: string; view: unknown }
    expect(checked.title).toBe('Plugin Test Page')
    const view = JSON.stringify(checked.view)
    expect(view).toContain('data:image/jpeg;base64,')
    expect(view).toContain('deliberate console error')
    expect(view).toContain('/missing.js')
    const run = JSON.stringify(await service.runCommand('browser-testing', 'run', { steps: `goto ${baseUrl}\ntype #name Welt\nclick #go\nexpectText Hallo Welt\nscreenshot` }))
    expect(run).toContain('5 Schritt(e) erfolgreich')
    const failing = JSON.stringify(await service.runCommand('browser-testing', 'run', { steps: `goto ${baseUrl}\nexpectText gibt es nicht` }))
    expect(failing).toContain('Fehlgeschlagen')
    expect(await service.invokeTool('browser-testing', 'browser_check', { url: baseUrl })).toContain('deliberate console error')
    // every run used its own profile in the plugin's data folder and removed it afterwards
    const profiles = path.join(db.dir, 'plugin-data', 'browser-testing', 'profiles')
    const deadline = Date.now() + 10_000
    while (existsSync(profiles) && readdirSync(profiles).length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200))
    expect(existsSync(profiles) ? readdirSync(profiles) : []).toEqual([])
  }, 120_000)

  it('Docker: lists containers and images through the docker CLI (or reports a stopped daemon)', async () => {
    await service.enable('docker', { processes: ['docker'], fs: 'project-read' })
    const view = JSON.stringify(await service.renderView('docker', 'main'))
    if (!dockerRunning()) {
      expect(view).toContain('Docker läuft nicht')
      await expect(service.invokeTool('docker', 'docker_containers', {})).rejects.toThrow(/Docker läuft nicht/)
      return
    }
    expect(view).toMatch(/Docker \d+\.\d+/)
    expect(view).toContain('Keine compose-Datei im Projekt.')
    expect(Array.isArray(await service.invokeTool('docker', 'docker_containers', {}))).toBe(true)
  }, 60_000)

  it('GitHub/GitLab: explain a missing remote instead of failing', async () => {
    await service.enable('github', { network: ['api.github.com'], processes: ['git'], secrets: ['token'] })
    expect(JSON.stringify(await service.renderView('github', 'main'))).toContain('keinen GitHub-Remote')
    await service.enable('gitlab', { network: ['gitlab.com'], processes: ['git'], secrets: ['token'] })
    expect(JSON.stringify(await service.renderView('gitlab', 'main'))).toContain('keinen gitlab.com-Remote')
  }, 60_000)

  it.skipIf(!process.env.MAC_TEST_NETWORK)('GitHub: public repository without token (network)', async () => {
    await service.updateSettings('github', { repository: 'octocat/Hello-World' })
    const view = JSON.stringify(await service.renderView('github', 'main'))
    expect(view).toContain('GitHub · octocat/Hello-World')
    expect(Array.isArray(await service.invokeTool('github', 'github_issues', {}))).toBe(true)
  }, 60_000)
})
