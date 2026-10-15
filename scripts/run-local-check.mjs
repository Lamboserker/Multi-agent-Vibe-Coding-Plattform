// Sequential, bounded checks. The ownership job also cleans children after a successful exit.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { windowsJobCommand } from '../packages/engine/src/util/windows-job.ts'

const [label, timeout, cwd, script, ...args] = process.argv.slice(2)
const timeoutMs = Number(timeout)
if (!label || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw new Error('label timeoutMs cwd localScript [args] required')
const target = path.resolve(script)
if (!target.startsWith(process.cwd() + path.sep) || !fs.existsSync(target)) throw new Error('Only an existing workspace script can be checked')
const command = process.platform === 'win32' ? windowsJobCommand(process.execPath, [target, ...args]) : { file: process.execPath, args: [target, ...args] }
const env = { ...process.env, MAC_LIVE_PREMIUM_MCP: '', MAC_TEST_DOCKER: '', MAC_TEST_NETWORK: '0', MAC_E2E_LIVE: '' }
delete env.ELECTRON_RUN_AS_NODE
const startedAt = new Date().toISOString()
const child = spawn(command.file, command.args, { cwd: path.resolve(cwd), env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = '', stderr = '', timedOut = false
child.stdout.on('data', (chunk) => { stdout += chunk.toString(); process.stdout.write(chunk) })
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); process.stderr.write(chunk) })
const stop = () => {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
  else { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
}
const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
const code = await new Promise((resolve) => {
  child.on('error', (error) => { stderr += error.message; resolve(1) })
  child.on('close', (exitCode) => resolve(exitCode ?? 1))
})
clearTimeout(timer)
if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
const result = { label, startedAt, finishedAt: new Date().toISOString(), cwd: path.resolve(cwd), script: target, args, timeoutMs, timedOut, exitCode: code, stdout, stderr, cleanup: process.platform === 'win32' ? 'Windows kill-on-close ownership job' : 'owned process group' }
const file = path.resolve(`apps/desktop/e2e/results/stabilization-check-${label}.json`)
fs.writeFileSync(file, JSON.stringify(result, null, 2))
console.log(`Result: ${file}`)
process.exitCode = code || (timedOut ? 1 : 0)
