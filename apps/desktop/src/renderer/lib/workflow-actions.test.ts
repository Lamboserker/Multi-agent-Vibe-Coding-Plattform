import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionRun } from './types'

const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), getSession: vi.fn(), reloadExecution: vi.fn(), reloadTask: vi.fn(), loadActivity: vi.fn(), notify: vi.fn() }))
vi.mock('./api', () => ({ api: { post: mocks.post, get: mocks.get } }))
vi.mock('./stores', () => ({ sessionStore: { get: mocks.getSession } }))
vi.mock('./actions', () => ({ reloadExecution: mocks.reloadExecution, reloadTask: mocks.reloadTask, loadActivity: mocks.loadActivity, notify: mocks.notify }))
import { approveRun, controlRun, designAction, discardRun, latestDesign, replanTask } from './workflow-actions'

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

describe('design phase actions', () => {
  it('posts approve, skip and regenerate to the design routes and reloads the task', async () => {
    mocks.post.mockResolvedValue({})
    for (const action of ['approve', 'skip', 'regenerate'] as const) await designAction('task', action)
    expect(mocks.post.mock.calls.map(([path]) => path)).toEqual(['/tasks/task/design/approve', '/tasks/task/design/skip', '/tasks/task/design/regenerate'])
    expect(mocks.reloadTask).toHaveBeenCalledTimes(3)
  })
  it('sends the feedback of a revision', async () => {
    mocks.post.mockResolvedValue({})
    await designAction('task', 'reject', 'dunkler, mehr Weißraum')
    expect(mocks.post).toHaveBeenCalledWith('/tasks/task/design/reject', { feedback: 'dunkler, mehr Weißraum' })
  })
  it('shares the task lock with planning, so approve and replan cannot race', async () => {
    let resolve!: (value: unknown) => void
    mocks.post.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const approval = designAction('task', 'approve')
    await expect(replanTask('task')).rejects.toThrow('bereits ausgeführt')
    await expect(designAction('task', 'skip')).rejects.toThrow('bereits ausgeführt')
    resolve({})
    await approval
    expect(mocks.post).toHaveBeenCalledTimes(1)
  })
  it('loads the latest draft and maps an empty answer to null', async () => {
    mocks.get.mockResolvedValueOnce({ id: 'draft', version: 2 }).mockResolvedValueOnce(null).mockResolvedValueOnce(undefined)
    expect(await latestDesign('task')).toEqual({ id: 'draft', version: 2 })
    expect(await latestDesign('task')).toBeNull()
    expect(await latestDesign('task')).toBeNull()
    expect(mocks.get).toHaveBeenCalledWith('/tasks/task/design')
  })
})
