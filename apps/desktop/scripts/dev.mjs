// Development: backend bundle, main/preload in watch mode, Vite dev server, Electron.
// Set MAC_DEVTOOLS=1 to open the renderer DevTools automatically.
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const run = (commandLine) => {
  // single command string: no argument arrays with shell:true (Node DEP0190)
  const result = spawnSync(commandLine, { cwd: root, stdio: 'inherit', shell: true })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('pnpm --filter @multi-ai-coder/shared build')
run('pnpm --filter @multi-ai-coder/agents build')
run('pnpm --filter @multi-ai-coder/engine build')
run('pnpm --filter @multi-ai-coder/api build')
run('node scripts/build-backend.mjs')
run('node scripts/build-main.mjs')
const watcher = spawn(process.execPath, ['scripts/build-main.mjs', '--watch'], { cwd: root, stdio: 'inherit' })

const server = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port: 5199, strictPort: true } })
await server.listen()
const url = 'http://localhost:5199/'
console.log(`renderer dev server: ${url}`)

const electronBinary = (await import('electron')).default
const env = { ...process.env, MAC_DEV_RENDERER_URL: url }
delete env.ELECTRON_RUN_AS_NODE // set when started from a VS Code terminal; would make Electron run as plain Node
const electron = spawn(electronBinary, ['.'], { cwd: root, stdio: 'inherit', env })
electron.on('exit', async (code) => {
  watcher.kill()
  await server.close()
  process.exit(code ?? 0)
})
