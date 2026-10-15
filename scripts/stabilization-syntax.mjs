import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const files = ['apps/desktop/scripts/stage.mjs', 'apps/desktop/e2e/navigation-run.test.mjs', 'apps/desktop/e2e/packaged-smoke.test.mjs', 'plugins/reference-extensions/index.cjs', 'scripts/stabilization-inspect.mjs', 'scripts/run-local-check.mjs']
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  assert.equal(result.status, 0, `${file}: ${result.stderr}`)
}
console.log(JSON.stringify({ checked: files, ok: true }))
