import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_DOCUMENT_BYTES, StateStore } from './state-store.js'

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), 'mac-state-'))

describe('StateStore', () => {
  it('persists documents atomically and reads them back after a restart', async () => {
    const dir = tempDir()
    const store = new StateStore(dir, 10)
    expect(store.set('workspace:p1', { tabs: ['a.ts'] })).toEqual({ ok: true, version: 1 })
    expect(store.set('workspace:p1', { tabs: ['a.ts', 'b.ts'] })).toEqual({ ok: true, version: 2 })
    await store.flush()
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])

    const restarted = new StateStore(dir)
    expect(restarted.get('workspace:p1')).toMatchObject({ version: 2, data: { tabs: ['a.ts', 'b.ts'] } })
  })

  it('rejects writes from an older page after a reload (epoch)', () => {
    const store = new StateStore(tempDir())
    store.registerEpoch('page-1')
    expect(store.set('ui', { theme: 'dark' }, 'page-1').ok).toBe(true)
    store.registerEpoch('page-2') // window reloaded
    expect(store.set('ui', { theme: 'light' }, 'page-1')).toEqual({ ok: false, reason: 'stale_epoch' })
    expect(store.get('ui')?.data).toEqual({ theme: 'dark' })
    expect(store.set('ui', { theme: 'light' }, 'page-2').ok).toBe(true)
  })

  it('falls back to the .bak copy when the document is corrupt', async () => {
    const dir = tempDir()
    const store = new StateStore(dir, 10)
    store.set('ui', { theme: 'dark' })
    store.flushSync()
    new StateStore(dir).get('ui') // first successful read creates the .bak copy
    writeFileSync(path.join(dir, 'ui.json'), '{"version": 3, "data": {"the') // torn write
    expect(new StateStore(dir).get('ui')?.data).toEqual({ theme: 'dark' })
  })

  it('keeps drafts of unsaved files per project and removes them when saved', async () => {
    const dir = tempDir()
    const store = new StateStore(dir, 10)
    store.putDraft('p1', { path: 'src/a.ts', content: 'draft 1', baseMtimeMs: 100 })
    store.putDraft('p1', { path: 'src/a.ts', content: 'draft 2', baseMtimeMs: 100 })
    store.putDraft('p1', { path: 'src/b.ts', content: 'other' })
    // pending drafts are visible before they are written
    expect(store.listDrafts('p1').map((draft) => draft.content).sort()).toEqual(['draft 2', 'other'])
    store.flushSync()
    const restarted = new StateStore(dir)
    expect(restarted.listDrafts('p1').find((draft) => draft.path === 'src/a.ts')).toMatchObject({ content: 'draft 2', baseMtimeMs: 100 })
    restarted.deleteDraft('p1', 'src/a.ts')
    await restarted.flush()
    expect(new StateStore(dir).listDrafts('p1').map((draft) => draft.path)).toEqual(['src/b.ts'])
    expect(new StateStore(dir).listDrafts('p2')).toEqual([])
  })

  it('validates keys and sizes', () => {
    const store = new StateStore(tempDir())
    expect(store.set('../evil', {})).toEqual({ ok: false, reason: 'invalid' })
    expect(store.set('ok', 'x'.repeat(MAX_DOCUMENT_BYTES + 1))).toEqual({ ok: false, reason: 'too_large' })
    expect(store.putDraft('../p', { path: 'a', content: '' })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('flushSync writes everything that is pending (app quit)', () => {
    const dir = tempDir()
    const store = new StateStore(dir, 60_000)
    store.set('terminals', [{ title: 'a' }])
    expect(store.pendingWrites).toBe(1)
    store.flushSync()
    expect(store.pendingWrites).toBe(0)
    expect(JSON.parse(readFileSync(path.join(dir, 'terminals.json'), 'utf8')).data).toEqual([{ title: 'a' }])
  })
})
