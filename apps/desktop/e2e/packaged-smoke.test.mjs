// Smoke and recovery test of the PACKAGED app (release/win-unpacked), as installed by the NSIS installer.
//
//   pnpm --filter @multi-ai-coder/desktop package   (or package:dir)
//   node --test e2e/packaged-smoke.test.mjs
//
// Checks that everything that is only assembled at packaging time works: bundled runtime (boot.cjs +
// compile cache), migrations, shipped plugins and skills, plugin host process, TypeScript worker,
// lazily loaded MCP SDK, and that a crashed runtime is restarted while the window keeps its state.
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { appDir, go, newProfile, openProject, prepareRepository, waitUntil } from './helpers.mjs'

const executable = path.join(appDir, 'release', 'win-unpacked', 'Multi-AI Coder.exe')
const testServer = path.resolve(appDir, '../api/src/mcp/testing/test-server.mjs')

test('packaged app: startup, plugins, skills, TypeScript worker, MCP, runtime crash recovery', { skip: !existsSync(executable) && 'package the app first', timeout: 10 * 60_000 }, async () => {
  const { _electron: electron } = await import(pathToFileURL(path.join(appDir, 'node_modules', 'playwright-core', 'index.mjs')).href)
  const profile = newProfile()
  const env = { ...process.env, MAC_USER_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const started = Date.now()
  const app = await electron.launch({ executablePath: executable, args: [], env })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const api = (method, url, body) => page.evaluate(([m, u, b]) => window.mac.api(m, u, b), [method, url, body])
  try {
    await waitUntil(async () => (await page.evaluate(() => window.mac.runtime.status())).state === 'ready', 120_000, 'runtime ready')
    const readyMs = Date.now() - started
    const info = (await page.evaluate(() => window.mac.app.info())).packaged
    assert.equal(info, true, 'running the packaged build')
    for (const name of ['lib.d.ts', 'lib.es5.d.ts', 'lib.dom.d.ts']) {
      assert.ok(existsSync(path.join(appDir, 'release/win-unpacked/resources/app/backend/typescript/lib', name)), `packaged TypeScript runtime requires ${name}`)
    }

    // shipped plugins and skills are part of the package
    // a fresh installation is empty and opens the setup wizard
    const fresh = (await api('GET', '/settings')).data
    assert.equal(fresh.onboarding.completed, false, 'setup wizard pending')
    assert.equal(fresh.lastProjectId, null)
    assert.deepEqual((await api('GET', '/projects')).data, [], 'no projects')
    await page.locator('.onboarding').waitFor({ timeout: 30_000 })

    const plugins = (await api('GET', '/plugins')).data
    assert.equal(plugins.length, 7, JSON.stringify(plugins.map((plugin) => plugin.id)))
    const skills = (await api('GET', '/skills')).data
    assert.deepEqual(skills.filter((skill) => skill.source === 'builtin').map((skill) => skill.name).sort(), ['changelog', 'code-review', 'ui-bootstrap', 'ui-design', 'ui-tailwind', 'writing-tests'])

    // plugin host process (sandboxed) runs from the package
    assert.equal((await api('POST', '/plugins/api-tools/enable', { grant: { network: ['*'] } })).status, 201)
    const view = await api('POST', '/plugins/api-tools/views/main', { input: {} })
    assert.equal(view.status, 201, JSON.stringify(view.data))
    assert.equal(view.data.type, 'stack')

    // project + TypeScript worker
    await api('POST', '/onboarding/complete')
    await page.reload()
    await page.waitForSelector('.ide', { timeout: 60_000 })
    const repo = prepareRepository()
    await openProject(app, page, repo)
    await go(page, 'Code')
    await page.locator('[data-path="src"]').first().waitFor({ timeout: 30_000 })
    const projectId = (await api('GET', '/settings')).data.lastProjectId
    const definition = await api('POST', `/projects/${projectId}/ide/ts/definition`, { path: 'src/App.tsx', line: 6, column: 8 })
    assert.equal(definition.status, 201, JSON.stringify(definition.data))
    assert.equal(definition.data[0]?.path, 'src/components/Badge.tsx')

    // MCP client (SDK loaded on first use) against a stdio server
    const server = (await api('POST', '/mcp/servers', { name: 'smoke', transport: 'stdio', command: process.execPath, args: [testServer], defaultPolicy: 'allow' })).data
    const tested = await api('POST', `/mcp/servers/${server.id}/test`)
    assert.equal(tested.status, 201, JSON.stringify(tested.data))
    assert.equal((await api('POST', `/mcp/servers/${server.id}/tools/add/call`, { args: { a: 2, b: 2 } })).data.text, '4')

    // compile cache written by the runtime
    await waitUntil(() => existsSync(path.join(profile, 'cache', 'v8')) && readdirSync(path.join(profile, 'cache', 'v8')).length > 0, 15_000, 'V8 compile cache written')

    // --- recovery: the runtime process crashes; it is restarted and the window keeps its state ---
    const before = await page.evaluate(() => window.mac.runtime.status())
    process.kill(before.pid)
    await waitUntil(async () => {
      const status = await page.evaluate(() => window.mac.runtime.status())
      return status.state === 'ready' && status.pid !== before.pid ? status : null
    }, 60_000, 'runtime restarted after crash')
    assert.equal((await api('GET', '/settings')).data.lastProjectId, projectId)
    assert.ok(await page.locator('.ide').count(), 'the IDE stayed mounted')
    assert.equal((await api('GET', '/plugins')).data.find((plugin) => plugin.id === 'api-tools').enabled, true)
    console.log(JSON.stringify({ readyMs, restartedPid: (await page.evaluate(() => window.mac.runtime.status())).pid }))
    assert.deepEqual(errors, [])
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined)
    await waitUntil(async () => app.process().exitCode !== null, 30_000, 'app exit').catch(() => app.close())
  }
})
