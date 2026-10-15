import { describe, expect, it } from 'vitest'
import { ScrollbackBuffer, TerminalManager } from './terminal.js'

describe('ScrollbackBuffer', () => {
  it('keeps the newest output up to the limit', () => {
    const buffer = new ScrollbackBuffer(10)
    buffer.append('12345')
    buffer.append('67890')
    buffer.append('abc')
    expect(buffer.toString()).toBe('4567890abc')
    buffer.append('a very long chunk that alone exceeds the limit')
    expect(buffer.toString()).toBe(' the limit')
    expect(buffer.toString(4)).toBe('imit')
  })
})

describe('TerminalManager history', () => {
  it('restores the output of a previous app session as read-only history', () => {
    const manager = new TerminalManager(() => undefined, () => undefined)
    manager.restore([{ title: 'repo', cwd: 'C:/repo', projectId: 'p1', scrollback: 'npm test\r\nok\r\n', endedAt: '2026-10-09T10:00:00.000Z' }])
    const [info] = manager.list('p1')
    expect(info).toMatchObject({ title: 'repo', status: 'restored', projectId: 'p1' })
    const attached = manager.attach(info!.id)
    expect(attached?.scrollback).toContain('npm test')
    expect(attached?.scrollback).toContain('Verlauf wiederhergestellt')
    // a restored terminal is part of the next snapshot until the user closes it
    expect(manager.snapshot()[0]).toMatchObject({ title: 'repo', cwd: 'C:/repo' })
    manager.kill(info!.id)
    expect(manager.list()).toEqual([])
  })
})

describe('TerminalManager command history (real shell)', () => {
  it.skipIf(process.platform !== 'win32')('records executed commands, never Read-Host input, and keeps them separate from the scrollback across a restart', async () => {
    // PSReadLine asks its terminal for the cursor position before accepting input. xterm answers
    // in the app; this headless PTY test must supply that reply too (including split output chunks).
    let pendingQuery = ''
    const manager = new TerminalManager((id, data) => {
      pendingQuery += data
      const query = '\x1b[6n'
      let index: number
      while ((index = pendingQuery.indexOf(query)) >= 0) {
        pendingQuery = pendingQuery.slice(index + query.length)
        manager.write(id, '\x1b[1;1R')
      }
      pendingQuery = pendingQuery.slice(-query.length + 1)
    }, () => undefined)
    const info = await manager.create({ cols: 120, rows: 30 })
    const until = async (condition: () => boolean, label: string) => {
      const deadline = Date.now() + 30_000
      while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timeout: ${label} (scrollback: ${manager.attach(info.id)?.scrollback.slice(-400)})`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    try {
      await until(() => /PS [^\r\n]*>/.test(manager.attach(info.id)?.scrollback ?? ''), 'prompt')
      manager.write(info.id, 'Write-Output mac-history-1\r')
      await until(() => manager.history(info.id).includes('Write-Output mac-history-1'), 'first command')
      // a secret typed at a Read-Host prompt is input to a running command, not a command line
      manager.write(info.id, '$s = Read-Host -Prompt geheim\r')
      await until(() => (manager.attach(info.id)?.scrollback ?? '').includes('geheim:'), 'Read-Host prompt')
      manager.write(info.id, 'top-secret-value\r')
      manager.write(info.id, 'Write-Output mac-history-2\r')
      await until(() => manager.history(info.id).includes('Write-Output mac-history-2'), 'second command')
      expect(manager.history(info.id)).toEqual(['Write-Output mac-history-1', '$s = Read-Host -Prompt geheim', 'Write-Output mac-history-2'])
      // persisted separately from the scrollback; restored after the next start
      const snapshot = manager.snapshot()
      expect(snapshot[0]!.commandHistory).toEqual(manager.history(info.id))
      const next = new TerminalManager(() => undefined, () => undefined)
      next.restore(snapshot)
      expect(next.history(next.list()[0]!.id)).toEqual(['Write-Output mac-history-1', '$s = Read-Host -Prompt geheim', 'Write-Output mac-history-2'])
    } finally {
      manager.killAll()
    }
  }, 60_000)
})
