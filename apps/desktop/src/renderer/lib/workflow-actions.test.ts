import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionRun } from './types'

const mocks = vi.hoisted(() => ({ post: vi.fn(), getSession: vi.fn(), reloadExecution: vi.fn(), reloadTask: vi.fn(), loadActivity: vi.fn(), notify: vi.fn() }))
vi.mock('./api', () => ({ api: { post: mocks.post } }))
vi.mock('./stores', () => ({ sessionStore: { get: mocks.getSession } }))
vi.mock('./actions', () => ({ reloadExecution: mocks.reloadExecution, reloadTask: mocks.reloadTask, loadActivity: mocks.loadActivity, notify: mocks.notify }))
import { approveRun, controlRun, discardRun } from './workflow-actions'

const execution = { id: 'run', taskId: 'task' } as ExecutionRun
beforeEach(() => {
  vi.resetAllMocks()
  mocks.getSession.mockReturnValue({ task: { id: 'task' }, execution: { id: 'run' } })
})

describe('workflow mutation coordination', () => {
  it('prevents approval and discard from being submitted concurrently', async () => {
    let resolve!: (value: { ok: boolean; message: string }) => void
    mocks.post.mockReturnValue(new Promise((done) => { resolve = done }))
    const approval = approveRun(execution, 'working_tree')
    await expect(discardRun(execution)).rejects.toThrow('bereits ausgeführt')
    expect(mocks.post).toHaveBeenCalledTimes(1)
    resolve({ ok: true, message: 'applied' })
    await approval
    expect(mocks.reloadTask).toHaveBeenCalledTimes(1)
  })
  it('releases the action lock after a failed request so the user can retry', async () => {
    mocks.post.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({})
    await expect(controlRun(execution, 'pause')).rejects.toThrow('offline')
    await controlRun(execution, 'pause')
    expect(mocks.post).toHaveBeenCalledTimes(2)
  })
  it('does not replace the selected session after an approval completes in another session', async () => {
    let resolve!: (value: { ok: boolean; message: string }) => void
    mocks.post.mockReturnValue(new Promise((done) => { resolve = done }))
    const approval = approveRun(execution, 'branch')
    mocks.getSession.mockReturnValue({ task: { id: 'other-task' }, execution: { id: 'other-run' } })
    resolve({ ok: true, message: 'retained' })
    await approval
    expect(mocks.reloadExecution).not.toHaveBeenCalled()
    expect(mocks.reloadTask).not.toHaveBeenCalled()
    expect(mocks.loadActivity).toHaveBeenCalledTimes(1)
  })
})
