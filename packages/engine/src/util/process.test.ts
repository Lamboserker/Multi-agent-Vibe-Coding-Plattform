import { describe, expect, it } from 'vitest'
import { runProcess } from './process.js'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

describe('owned process lifecycle', () => {
  it('drains stdout and stderr concurrently and preserves stdin and arguments', async () => {
    const value = await runProcess(process.execPath, ['-e', `process.stdin.on('data',x=>process.stdout.write(x)); process.stdin.on('end',()=>{process.stdout.write(process.argv[1]);process.stderr.write('e'.repeat(100000))})`, 'space " quote'], { input: 'input:', timeoutMs: 6000, cleanupChildren: true })
    expect(value.exitCode).toBe(0)
    expect(value.stdout).toBe('input:space " quote')
    expect(value.stderr.length).toBe(100000)
  })
  it('rejects a pre-aborted call without spawning', async () => {
    const controller = new AbortController(); controller.abort()
    let spawned = false
    const value = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { signal: controller.signal, onSpawn: () => { spawned = true } })
    expect(value.aborted).toBe(true); expect(spawned).toBe(false)
  })
  it.each(['completion', 'timeout', 'abort', 'error'])('cleans a detached child after %s', async (mode) => {
    const controller = new AbortController()
    let descendant = 0
    let abortTimer: NodeJS.Timeout | undefined
    const source = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid);${mode === 'completion' ? 'setTimeout(()=>process.exit(0),100)' : mode === 'error' ? 'setTimeout(()=>process.exit(2),100)' : 'setInterval(()=>{},1000)'}`
    const value = await runProcess(process.execPath, ['-e', source], { timeoutMs: 5000, signal: controller.signal, cleanupChildren: true, onStdout: (chunk) => { descendant = Number(chunk.trim()); if (mode === 'abort') abortTimer = setTimeout(() => controller.abort(), 50) } })
    clearTimeout(abortTimer)
    expect(descendant).toBeGreaterThan(0)
    // OS teardown can complete just after the parent close notification.
    const until = Date.now() + 2000
    while (alive(descendant) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(alive(descendant)).toBe(false)
    if (mode === 'timeout') expect(value.timedOut).toBe(true)
    if (mode === 'abort') expect(value.aborted).toBe(true)
    if (mode === 'error') expect(value.exitCode).toBe(2)
  }, 10000)
  it('discards oversized structured output', async () => {
    const value = await runProcess(process.execPath, ['-e', "process.stdout.write('ä'.repeat(100000));setInterval(()=>{},1000)"], { maxOutputBytes: 1024, failOnOutputLimit: true, timeoutMs: 6000, cleanupChildren: true })
    expect(value.outputLimitExceeded).toBe(true)
    expect(Buffer.byteLength(value.stdout)).toBeLessThanOrEqual(1024)
  })
  it.skipIf(process.platform !== 'win32')('cleans the job when its owning runtime disappears', async () => {
    const moduleUrl = new URL('./windows-job.ts', import.meta.url).href
    const source = `import(${JSON.stringify(moduleUrl)}).then(({windowsJobCommand})=>{const {spawn}=require('node:child_process');const spec=windowsJobCommand(process.execPath,['-e','console.log(process.pid);setInterval(()=>{},1000)']);const c=spawn(spec.file,spec.args,{stdio:['ignore','pipe','ignore'],windowsHide:true});c.stdout.once('data',d=>{console.log(JSON.stringify({native:Number(d.toString().trim()),owner:c.pid}));process.exit(0)});})`
    const value = await runProcess(process.execPath, ['-e', source], { timeoutMs: 6000 })
    expect(value.exitCode).toBe(0)
    const children = JSON.parse(value.stdout.trim()) as { native: number; owner: number }
    const until = Date.now() + 3000
    while ((alive(children.native) || alive(children.owner)) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(alive(children.native)).toBe(false); expect(alive(children.owner)).toBe(false)
  }, 10000)
})
