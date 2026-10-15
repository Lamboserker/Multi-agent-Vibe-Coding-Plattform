// Docker and Database Tools plugins against a running Docker daemon (opt-in: MAC_TEST_DOCKER=1).
// Uses only images that are already present locally (nginx:alpine, postgres:16), creates its own
// uniquely named containers/images and removes them afterwards; existing containers are untouched.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'

const vault = new Map<string, string>()
const listeners: Array<(message: { data: unknown }) => void> = []
;(process as unknown as { parentPort: unknown }).parentPort = {
  on: (_event: string, listener: (message: { data: unknown }) => void) => listeners.push(listener),
  postMessage: (message: { id: number; method: string; params: { scope: string; name: string } }) => {
    const value = message.method === 'secret:get' ? vault.get(`${message.params.scope}/${message.params.name}`) ?? null : null
    queueMicrotask(() => listeners.forEach((listener) => listener({ data: { type: 'shell-response', id: message.id, ok: true, value } })))
  },
}

const here = path.dirname(fileURLToPath(import.meta.url))
const db = useTempDatabase('mac-docker-services-')
process.env.MAC_DATA_DIR = db.dir
process.env.MAC_BUILTIN_PLUGINS_DIR = path.resolve(here, '../../../../plugins')
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { SettingsService } = await import('../runtime/settings.service.js')
const { PluginsService } = await import('./plugins.service.js')

const enabled = process.env.MAC_TEST_DOCKER === '1' && existsSync(path.resolve(here, '../../dist/plugins/host/plugin-host.cjs'))
const prisma = new PrismaService()
const events = new EventBusService()
const settings = new SettingsService(prisma, events)
const plugins = new PluginsService(prisma, events, settings)
const suffix = Date.now().toString(36)
const pgName = `mac-test-postgres-${suffix}`
const created: { containers: string[]; images: string[] } = { containers: [pgName], images: [] }
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim()
const projects: Record<string, { id: string; dir: string }> = {}

async function project(key: string, devcontainer: string, files: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `mac-dev-${key}-`))
  mkdirSync(path.join(dir, '.devcontainer'))
  writeFileSync(path.join(dir, '.devcontainer', 'devcontainer.json'), devcontainer)
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(dir, file), content)
  writeFileSync(path.join(dir, 'README.md'), `project ${key}\n`)
  const record = await prisma.project.create({ data: { name: `dev-${key}`, repoPath: dir } })
  projects[key] = { id: record.id, dir }
  created.containers.push(`mac-dev-${record.id}`.replace(/[^\w.-]/g, '-'))
  created.images.push(`mac-dev-${record.id}:dev`.replace(/[^\w.:-]/g, '-'))
}

async function open(key: string) {
  await settings.update({ lastProjectId: projects[key]!.id })
  // fs-granted plugins follow the open project (host restart)
  await plugins.disable('docker')
  await plugins.enable('docker', { processes: ['docker'], fs: 'project-read' })
}

beforeAll(async () => {
  if (!enabled) return
  await applyMigrations(prisma, MIGRATIONS_DIR, () => undefined)
  await project('image', `{
  // JSONC like VS Code writes it
  "name": "image variant",
  "image": "nginx:alpine",
  "containerEnv": { "MAC_TEST_VALUE": "aus-containerEnv" },
  "postCreateCommand": "echo \\"$MAC_TEST_VALUE\\" > created-by-postcreate.txt",
  "postStartCommand": ["sh", "-c", "echo started >> starts.txt"], /* every start */
}`)
  await project('build', `{ "build": { "dockerfile": "Dockerfile", "context": ".." }, "workspaceFolder": "/work" }`, {})
  writeFileSync(path.join(projects.build!.dir, '.devcontainer', 'Dockerfile'), 'FROM nginx:alpine\nCOPY README.md /baked-readme.md\n')
  await project('features', `{ "image": "nginx:alpine", "features": { "ghcr.io/devcontainers/features/node:1": {} } }`)
  await plugins.enable('docker', { processes: ['docker'], fs: 'project-read' })
  const manifest = JSON.parse(readFileSync(path.join(process.env.MAC_BUILTIN_PLUGINS_DIR!, 'database-tools', 'multi-ai-coder-plugin.json'), 'utf8')) as { permissions: Record<string, unknown> }
  await plugins.enable('database-tools', manifest.permissions)
}, 120_000)

afterAll(async () => {
  for (const name of created.containers) spawnSync('docker', ['rm', '-f', name], { timeout: 60_000 })
  for (const image of created.images) spawnSync('docker', ['rmi', '-f', image], { timeout: 60_000 })
  await plugins.onApplicationShutdown()
  await prisma.$disconnect()
  db.cleanup()
}, 120_000)

describe.skipIf(!enabled)('Docker plugin: devcontainer against the running daemon', () => {
  it('image variant: JSONC, containerEnv, project mount, postCreate once, postStart on every start, logs, stop', async () => {
    await open('image')
    const name = created.containers[1]!
    const first = await plugins.runCommand('docker', 'devcontainer', { confirmed: true })
    expect(first.message).toContain('(running)')
    // postCreateCommand ran inside the container with containerEnv, in the mounted project folder
    expect(readFileSync(path.join(projects.image!.dir, 'created-by-postcreate.txt'), 'utf8').trim()).toBe('aus-containerEnv')
    expect(docker('exec', name, 'cat', '/workspaces/dev-image/README.md')).toBe('project image')
    expect(docker('inspect', '--format', '{{index .Config.Labels "multi-ai-coder.devcontainer"}}', name)).toBe('1')
    expect(JSON.stringify(await plugins.invokeTool('docker', 'docker_containers', {}))).toContain(name)
    await plugins.runCommand('docker', 'stop', { container: name })
    expect(docker('inspect', '--format', '{{.State.Status}}', name)).toBe('exited')
    // start again: existing container, postStart again, postCreate not repeated
    writeFileSync(path.join(projects.image!.dir, 'created-by-postcreate.txt'), 'unchanged')
    await plugins.runCommand('docker', 'devcontainer', { confirmed: true })
    expect(readFileSync(path.join(projects.image!.dir, 'starts.txt'), 'utf8').trim().split('\n')).toEqual(['started', 'started'])
    expect(readFileSync(path.join(projects.image!.dir, 'created-by-postcreate.txt'), 'utf8')).toBe('unchanged')
    expect(JSON.stringify(await plugins.runCommand('docker', 'logs', { container: name }))).toBeTruthy()
    await plugins.runCommand('docker', 'remove', { container: name, confirmed: true })
    expect(spawnSync('docker', ['inspect', name]).status).not.toBe(0)
  }, 300_000)

  it('build variant: Dockerfile with ".." context and workspaceFolder', async () => {
    await open('build')
    const name = created.containers[2]!
    const result = await plugins.runCommand('docker', 'devcontainer', { confirmed: true })
    expect(result.message).toContain('(running)')
    expect(JSON.stringify(result.view)).toContain('Arbeitsordner: /work')
    expect(docker('exec', name, 'cat', '/baked-readme.md')).toBe('project build')
    expect(docker('exec', name, 'pwd')).toBe('/work')
  }, 300_000)

  it('features are refused with an explanation instead of being ignored', async () => {
    await open('features')
    await expect(plugins.runCommand('docker', 'devcontainer', { confirmed: true })).rejects.toThrow(/Features benötigen die Dev-Container-CLI/)
    expect(spawnSync('docker', ['inspect', created.containers[3]!]).status).not.toBe(0)
  }, 60_000)
})

describe.skipIf(!enabled)('Database Tools plugin: PostgreSQL in an isolated container', () => {
  it('schema, read-only queries (enforced by the server) and confirmed writes', async () => {
    docker('run', '-d', '--rm', '--name', pgName, '-e', 'POSTGRES_PASSWORD=mac-test-pw', '-e', 'POSTGRES_DB=mactest', '-p', '127.0.0.1::5432', 'postgres:16')
    const port = docker('port', pgName, '5432/tcp').split('\n')[0]!.split(':').pop()
    const deadline = Date.now() + 90_000
    while (spawnSync('docker', ['exec', pgName, 'pg_isready', '-U', 'postgres', '-d', 'mactest']).status !== 0) {
      if (Date.now() > deadline) throw new Error('PostgreSQL did not start')
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    // pg_isready can succeed during the init restart; wait for a real query
    while (spawnSync('docker', ['exec', pgName, 'psql', '-U', 'postgres', '-d', 'mactest', '-c', 'select 1']).status !== 0) await new Promise((resolve) => setTimeout(resolve, 500))
    docker('exec', pgName, 'psql', '-U', 'postgres', '-d', 'mactest', '-c', 'CREATE TABLE notes (id serial primary key, body text not null); INSERT INTO notes (body) VALUES (\'erste\');')
    vault.set('plugin:database-tools/postgresUrl', `postgres://postgres:mac-test-pw@127.0.0.1:${port}/mactest`)
    await plugins.updateSettings('database-tools', { connection: 'postgres' })

    const schema = await plugins.runCommand('database-tools', 'schema', {})
    expect(JSON.stringify(schema.view)).toContain('notes(id')
    expect(String(await plugins.invokeTool('database-tools', 'db_schema', {}))).toContain('notes(')
    expect(JSON.stringify(await plugins.runCommand('database-tools', 'query', { sql: 'SELECT body FROM notes' }))).toContain('erste')
    // a write without confirmation is not executed
    const unconfirmed = JSON.stringify(await plugins.runCommand('database-tools', 'query', { sql: "INSERT INTO notes (body) VALUES ('ohne')" }))
    expect(unconfirmed).toContain('Schreibend ausführen')
    expect(docker('exec', pgName, 'psql', '-U', 'postgres', '-d', 'mactest', '-tAc', 'SELECT count(*) FROM notes')).toBe('1')
    // several statements count as a write (confirmation first, nothing executed)
    expect(JSON.stringify(await plugins.runCommand('database-tools', 'query', { sql: 'SELECT 1; DELETE FROM notes' }))).toContain('Schreibend ausführen')
    expect(docker('exec', pgName, 'psql', '-U', 'postgres', '-d', 'mactest', '-tAc', 'SELECT count(*) FROM notes')).toBe('1')
    // a writing SELECT passes the classifier but runs in a READ ONLY transaction: PostgreSQL rejects it
    const sequence = () => docker('exec', pgName, 'psql', '-U', 'postgres', '-d', 'mactest', '-tAc', 'SELECT last_value FROM notes_id_seq')
    const before = sequence()
    await expect(plugins.runCommand('database-tools', 'query', { sql: "SELECT nextval('notes_id_seq')" })).rejects.toThrow(/read-only transaction/i)
    expect(sequence()).toBe(before)
    // confirmed write
    await plugins.runCommand('database-tools', 'query', { sql: "INSERT INTO notes (body) VALUES ('bestätigt')", confirmed: true })
    expect(docker('exec', pgName, 'psql', '-U', 'postgres', '-d', 'mactest', '-tAc', 'SELECT body FROM notes ORDER BY id')).toBe('erste\nbestätigt')
    // the agent tool only reads
    await expect(plugins.invokeTool('database-tools', 'db_query', { sql: "DELETE FROM notes" })).rejects.toThrow()
    expect(docker('exec', pgName, 'psql', '-U', 'postgres', '-d', 'mactest', '-tAc', 'SELECT count(*) FROM notes')).toBe('2')
    // wrong password: clear error
    vault.set('plugin:database-tools/postgresUrl', `postgres://postgres:wrong@127.0.0.1:${port}/mactest`)
    await expect(plugins.runCommand('database-tools', 'query', { sql: 'SELECT 1' })).rejects.toThrow(/password|Passwort|authentication/i)
  }, 180_000)
})
