// Bundles the Electron main process and the sandboxed preload script.
import { build, context } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron', '@lydell/node-pty'],
}

const targets = [
  { ...shared, entryPoints: [path.join(root, 'src/main/main.ts')], outfile: path.join(root, 'dist/main/main.cjs') },
  // Sandboxed preload: a single CommonJS file that only requires "electron".
  { ...shared, entryPoints: [path.join(root, 'src/preload/preload.ts')], outfile: path.join(root, 'dist/preload/preload.cjs') },
]

if (watch) {
  for (const options of targets) await (await context(options)).watch()
} else {
  await Promise.all(targets.map((options) => build(options)))
}
