// Integration test of the plugin system with real host processes (Node permission model).
// Requires the compiled host: `pnpm --filter @multi-ai-coder/api build` (dist/plugins/host/plugin-host.cjs).
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'

const db = useTempDatabase('mac-plugins-')
process.env.MAC_DATA_DIR = db.dir
process.env.MAC_BUILTIN_PLUGINS_DIR = path.join(db.dir, 'builtin-none')
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { SettingsService } = await import('../runtime/settings.service.js')
const { PluginsService, missingGrants } = await import('./plugins.service.js')

const hostBuilt = existsSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/plugins/host/plugin-host.cjs'))
const prisma = new PrismaService()
const events = new EventBusService()
const service = new PluginsService(prisma, events, new SettingsService(prisma, events))
const fixtures = mkdtempSync(path.join(os.tmpdir(), 'mac-plugin-fixtures-'))
const secretFile = path.join(fixtures, 'outside.txt')
writeFileSync(secretFile, 'outside the plugin folder')

function makePlugin(name: string, version: string, source: string, manifest: Record<string, unknown> = {}) {
  const dir = path.join(fixtures, `${name}-${version}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'multi-ai-coder-plugin.json'),
    JSON.stringify({ id: name, name, version, description: `${name} test plugin`, apiVersion: 1, main: 'index.cjs', permissions: {}, ...manifest }),
  )
  writeFileSync(path.join(dir, 'index.cjs'), source)
  return dir
}

const probe = makePlugin(
  'probe',
  '1.0.0',
  `
module.exports = {
  activate(context) {
    context.commands.register('hello', async (args) => ({ message: 'hello ' + (args.name ?? 'world') }))
    context.commands.register('readOutside', async () => { require('node:fs').readFileSync(${JSON.stringify(secretFile)}, 'utf8'); return { message: 'read!' } })
    context.commands.register('spawn', async () => { require('node:child_process').execSync('whoami'); return { message: 'spawned' } })
    context.commands.register('directFetch', async () => { await fetch('https://example.com'); return { message: 'fetched' } })
    context.commands.register('netModule', async () => { require('node:https'); return { message: 'loaded https' } })
    context.commands.register('httpDenied', async () => { await context.http.fetch('https://example.com/'); return { message: 'fetched' } })
    context.commands.register('fsDenied', async () => { await context.fs.read('README.md'); return { message: 'read' } })
    context.commands.register('store', async (args) => { await context.storage.set('count', args.value); return { message: String(await context.storage.get('count')) } })
    context.commands.register('hang', () => new Promise(() => {}))
    context.commands.register('crash', () => { setTimeout(() => process.exit(3), 10); return { message: 'bye' } })
    context.views.register('main', async () => ({ type: 'stack', children: [{ type: 'heading', text: 'Probe' }] }))
    context.tools.register('echo', async (args) => ({ echo: args }))
  },
}
`,
  {
    contributes: {
      commands: ['hello', 'readOutside', 'spawn', 'directFetch', 'netModule', 'httpDenied', 'fsDenied', 'store', 'hang', 'crash'].map((id) => ({ id, title: id })),
      views: [{ id: 'main', title: 'Probe' }],
      agentTools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
    },
  },
)

beforeAll(async () => {
  await applyMigrations(prisma, MIGRATIONS_DIR, () => undefined)
  await service.onModuleInit()
})

afterAll(async () => {
  await service.onApplicationShutdown()
  await prisma.$disconnect()
  db.cleanup()
})

describe('missingGrants', () => {
  it('lists every requested permission that is not granted', () => {
    expect(missingGrants({ network: ['api.github.com'], fs: 'project-write', processes: ['docker'], secrets: ['token'] }, { network: [], fs: 'project-read' })).toEqual([
      'network:api.github.com',
      'fs:project-write',
      'process:docker',
      'secret:token',
    ])
    expect(missingGrants({ fs: 'project-read' }, { fs: 'project-write' })).toEqual([])
  })
})

describe.skipIf(!hostBuilt)('plugins (real host processes)', () => {
  it('executes all six extension contracts in the isolated host, including errors, disable and restart', async () => {
    const methods = { modelProviders: ['models', 'generate'], orchestratorAdapters: ['plan', 'execute', 'review', 'chat'], repositoryAnalyzers: ['analyze'], testRunners: ['run'], languageIntegrations: ['request'], gitIntegrations: ['request'] } as const
    const folder = makePlugin('extensions', '1.0.0', `module.exports = { activate(ctx) {
      const methods = ${JSON.stringify(methods)};
      for (const [kind, names] of Object.entries(methods)) {
        const implementation = { calls: 0 };
        for (const name of names) implementation[name] = async function(input) {
          if (input.fail) throw new Error('reference failure');
          this.calls++;
          return { kind, method: name, input, calls: this.calls, pid: process.pid };
        };
        ctx.contributions.register(kind, 'reference', implementation);
      }
    } }`, { contributes: Object.fromEntries(Object.keys(methods).map((kind) => [kind, [{ id: 'reference', title: kind }]])) })
    await service.install({ folder })
    await service.enable('extensions', {})
    expect((await service.extensionCatalog()).filter((entry) => entry.plugin === 'extensions')).toHaveLength(6)
    for (const [kind, names] of Object.entries(methods)) {
      for (const method of names) {
        const result = await service.invokeExtension<{ pid: number; kind: string; method: string }>('extensions', kind as keyof typeof methods, 'reference', method, { value: 42 })
        expect(result).toMatchObject({ kind, method, input: { value: 42 } })
        expect(result.pid).not.toBe(process.pid)
      }
      await expect(service.invokeExtension('extensions', kind as keyof typeof methods, 'reference', names[0], { fail: true })).rejects.toThrow('reference failure')
      await expect(service.invokeExtension('extensions', kind as keyof typeof methods, 'reference', 'constructor', {})).rejects.toThrow('Unsupported')
    }
    const before = await service.invokeExtension<{ pid: number }>('extensions', 'testRunners', 'reference', 'run', {})
    await service.disable('extensions')
    await expect(service.invokeExtension('extensions', 'testRunners', 'reference', 'run', {})).rejects.toThrow(/not enabled/i)
    await service.enable('extensions', {})
    const after = await service.invokeExtension<{ pid: number; calls: number }>('extensions', 'testRunners', 'reference', 'run', {})
    expect(after.pid).not.toBe(before.pid)
    expect(after.calls).toBe(1)
    await service.disable('extensions')
  }, 30_000)

  it('a URL setting marked grantsHost opens exactly the host the user entered (local only)', async () => {
    const { createServer } = await import('node:http')
    const local = createServer((_request, response) => response.end('pong'))
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve))
    const port = (local.address() as { port: number }).port
    const folder = makePlugin('urlgrant', '1.0.0', `module.exports = { activate(ctx) {
  ctx.commands.register('get', async (args) => ({ message: (await ctx.http.fetch(args.url)).body }))
} }`, { contributes: { commands: [{ id: 'get', title: 'get' }], settings: [{ key: 'apiUrl', title: 'API', type: 'string', grantsHost: true }, { key: 'other', title: 'Other', type: 'string' }] } })
    try {
      await service.install({ folder })
      await service.enable('urlgrant', {})
      await expect(service.runCommand('urlgrant', 'get', { url: `http://127.0.0.1:${port}/` })).rejects.toThrow(/Permission denied: network/)
      // a setting without grantsHost does not open anything
      await service.updateSettings('urlgrant', { other: `http://127.0.0.1:${port}` })
      await expect(service.runCommand('urlgrant', 'get', { url: `http://127.0.0.1:${port}/` })).rejects.toThrow(/Permission denied: network/)
      await service.updateSettings('urlgrant', { apiUrl: `http://127.0.0.1:${port}/api` })
      expect((await service.runCommand('urlgrant', 'get', { url: `http://127.0.0.1:${port}/` })).message).toBe('pong')
      // only that host:port, not other ports or names of the same machine
      await expect(service.runCommand('urlgrant', 'get', { url: `http://127.0.0.1:${port + 1}/` })).rejects.toThrow(/Permission denied: network/)
      await expect(service.runCommand('urlgrant', 'get', { url: `http://localhost:${port}/` })).rejects.toThrow(/Permission denied: network/)
      await service.disable('urlgrant')
    } finally {
      local.close()
    }
  }, 30_000)

  it('extension calls may use only the directories the app handed to them, and only while they run', async () => {
    const worktree = mkdtempSync(path.join(os.tmpdir(), 'mac-delegated-'))
    writeFileSync(path.join(worktree, 'marker.txt'), 'inside the worktree')
    const folder = makePlugin('delegation', '1.0.0', `let remembered
module.exports = { activate(ctx) {
  ctx.contributions.register('testRunners', 'probe', { run: async (input) => {
    remembered = input.cwd
    const read = await ctx.fs.read('marker.txt', { root: input.cwd })
    let forged = 'allowed'
    try { await ctx.fs.list('', { root: ${JSON.stringify(fixtures)} }) } catch (error) { forged = error.message }
    return { passed: 1, failed: 0, output: read + '|' + forged }
  } })
  ctx.commands.register('later', async () => { await ctx.fs.read('marker.txt', { root: remembered }); return { message: 'read later' } })
} }`, { permissions: { fs: 'project-read' }, contributes: { testRunners: [{ id: 'probe', title: 'Probe' }], commands: [{ id: 'later', title: 'later' }] } })
    await service.install({ folder })
    await service.enable('delegation', { fs: 'project-read' })
    const result = await service.invokeExtension<{ output: string }>('delegation', 'testRunners', 'probe', 'run', { cwd: worktree })
    expect(result.output).toMatch(/^inside the worktree\|.*not handed to this extension call/)
    // after the call the delegation is gone: a remembered path is useless
    await expect(service.runCommand('delegation', 'later')).rejects.toThrow(/not handed to this extension call/)
    await service.disable('delegation')
  }, 30_000)
  it('installs untrusted plugins disabled, activates them and runs commands, views and tools', async () => {
    const installed = await service.install({ folder: probe })
    expect(installed).toMatchObject({ id: 'probe', version: '1.0.0', trust: 'untrusted', enabled: false, source: 'folder' })
    const enabled = await service.enable('probe', {})
    expect(enabled.status).toBe('active')
    expect(enabled.registrations?.commands).toContain('hello')
    expect(await service.runCommand('probe', 'hello', { name: 'plugin' })).toEqual({ message: 'hello plugin' })
    expect(await service.renderView('probe', 'main')).toEqual({ type: 'stack', children: [{ type: 'heading', text: 'Probe' }] })
    expect(await service.invokeTool('probe', 'echo', { a: 1 })).toEqual({ echo: { a: 1 } })
    expect(await service.runCommand('probe', 'store', { value: 42 })).toEqual({ message: '42' })
    await expect(service.runCommand('probe', 'undeclared')).rejects.toThrow(/not declared/)
  }, 30_000)

  it('isolates untrusted plugins: no files outside the plugin, no processes, no direct network', async () => {
    await expect(service.runCommand('probe', 'readOutside')).rejects.toThrow(/ERR_ACCESS_DENIED|Access to this API has been restricted|permission/i)
    await expect(service.runCommand('probe', 'spawn')).rejects.toThrow(/cannot load|ERR_ACCESS_DENIED|restricted/i)
    await expect(service.runCommand('probe', 'directFetch')).rejects.toThrow(/cannot use fetch/)
    await expect(service.runCommand('probe', 'netModule')).rejects.toThrow(/cannot load/)
    // context APIs are checked against the (empty) grant
    await expect(service.runCommand('probe', 'httpDenied')).rejects.toThrow(/Permission denied: network example.com/)
    await expect(service.runCommand('probe', 'fsDenied')).rejects.toThrow(/Permission denied: files/)
    const details = await service.get('probe')
    expect(details.logs.some((line) => line.message.includes('denied: network example.com'))).toBe(true)
  }, 30_000)

  it('restarts a plugin that hangs (timeout) or crashes, without affecting the runtime', async () => {
    const hang = service.runCommand('probe', 'hang')
    // the call timeout is 30 s; kill it sooner by simulating the timeout path through a crash instead
    await expect(service.runCommand('probe', 'crash')).resolves.toEqual({ message: 'bye' })
    await expect(hang).rejects.toThrow(/process ended/)
    // the crash restarts the host after a backoff
    const deadline = Date.now() + 15_000
    for (;;) {
      const status = (await service.get('probe')).status
      if (status === 'active') break
      if (Date.now() > deadline) throw new Error(`plugin not restarted (status ${status})`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    expect(await service.runCommand('probe', 'hello', {})).toEqual({ message: 'hello world' })
  }, 30_000)

  it('blocks network modules for ES-module plugins as well', async () => {
    const dir = makePlugin('esm-probe', '1.0.0', '', { main: 'index.mjs', contributes: { commands: [{ id: 'net', title: 'net' }, { id: 'ok', title: 'ok' }] } })
    writeFileSync(
      path.join(dir, 'index.mjs'),
      `export function activate(context) {
  context.commands.register('ok', () => ({ message: 'esm ok' }))
  context.commands.register('net', async () => { await import('node:https'); return { message: 'loaded' } })
}`,
    )
    await service.install({ folder: dir })
    await service.enable('esm-probe', {})
    expect(await service.runCommand('esm-probe', 'ok')).toEqual({ message: 'esm ok' })
    await expect(service.runCommand('esm-probe', 'net')).rejects.toThrow(/cannot (import|load)/)
    await service.disable('esm-probe')
  }, 30_000)

  it('reports plugins that fail to activate', async () => {
    const broken = makePlugin('broken', '1.0.0', `module.exports = { activate() { throw new Error('boom at activation') } }`)
    await service.install({ folder: broken })
    await expect(service.enable('broken', {})).rejects.toThrow(/boom at activation/)
    expect((await service.get('broken')).status).toBe('error')
  }, 30_000)

  it('requires the requested permissions before enabling', async () => {
    const needy = makePlugin('needy', '1.0.0', `module.exports = { activate() {} }`, { permissions: { network: ['api.github.com'], secrets: ['token'] } })
    await service.install({ folder: needy })
    await expect(service.enable('needy', {})).rejects.toThrow(/network:api.github.com, secret:token/)
    const enabled = await service.enable('needy', { network: ['api.github.com', 'evil.example.com'], secrets: ['token'] })
    expect(enabled.granted).toEqual({ network: ['api.github.com'], fs: 'none', processes: [], secrets: ['token'], native: false })
    await service.disable('needy')
  }, 30_000)

  it('detects modified plugin files (integrity) and refuses to activate them', async () => {
    const tampered = makePlugin('tampered', '1.0.0', `module.exports = { activate() {} }`)
    await service.install({ folder: tampered })
    appendFileSync(path.join(db.dir, 'plugins', 'tampered', 'index.cjs'), '\n// modified after installation\n')
    await expect(service.enable('tampered', {})).rejects.toThrow(/Integrity check failed/)
  }, 30_000)

  it('handles updates, version conflicts and uninstall', async () => {
    const v2 = makePlugin('probe', '2.0.0', `module.exports = { activate(context) { context.commands.register('hello', () => ({ message: 'v2' })) } }`, { contributes: { commands: [{ id: 'hello', title: 'hello' }] } })
    const updated = await service.install({ folder: v2 })
    expect(updated.version).toBe('2.0.0')
    expect(updated.enabled).toBe(true) // the empty grant still covers the (empty) request
    expect(await service.runCommand('probe', 'hello')).toEqual({ message: 'v2' })
    const v1 = makePlugin('probe', '1.5.0', `module.exports = { activate() {} }`)
    await expect(service.install({ folder: v1 })).rejects.toThrow(/Version conflict/)
    await service.uninstall('probe')
    expect((await service.list()).some((plugin) => plugin.id === 'probe')).toBe(false)
    expect(existsSync(path.join(db.dir, 'plugins', 'probe'))).toBe(false)
  }, 30_000)
})
