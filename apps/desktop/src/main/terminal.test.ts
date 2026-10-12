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
