// Regenerates the installer artwork in build/ (see scripts/installer-art/render.cjs).
// The files are committed, so packaging does not depend on rendering them on the build machine.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = (await import('electron')).default
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE // set in VS Code terminals; would start Electron as plain Node
const result = spawnSync(electron, [path.join(root, 'scripts/installer-art/render.cjs')], { cwd: root, stdio: 'inherit', env })
process.exit(result.status ?? 1)
