import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionService } from './execution.service.js'

function fixture() {
  const prisma = { task: { update: vi.fn().mockResolvedValue({}), findUniqueOrThrow: vi.fn().mockResolvedValue({ projectId: 'p', project: { name: 'repo', repoPath: 'C:/repo' }, userPrompt: 'change a component' }) } }
  const settings = { get: vi.fn().mockResolvedValue({ modelRoles: {} }) }
  const orchestrators = { active: vi.fn().mockResolvedValue(undefined) }
  const localModels = { warmup: vi.fn().mockResolvedValue(undefined), engineProfiles: vi.fn().mockResolvedValue([]) }
  const repoContext = { digest: vi.fn() }
  const jobs = {
    enqueue: vi.fn().mockImplementation(async (_type, payload) => ({ id: 'job', payload, createdAt: new Date(), status: 'queued' })),
    activeFor: vi.fn(),
  }
  const events = { publish: vi.fn() }
  const service = new ExecutionService(prisma as never, settings as never, orchestrators as never, localModels as never, repoContext as never, jobs as never, events as never)
  return { service, prisma, repoContext, jobs, events }
}

afterEach(() => vi.useRealTimers())

describe('planning timing', () => {
  it('stores the request time in the job before preparation and uses the original time on duplicate enqueue', async () => {
    vi.useFakeTimers()
    const requestedAt = '2026-10-14T10:00:00.000Z'
    vi.setSystemTime(new Date(requestedAt))
    const { service, jobs, events } = fixture()
    await service.requestPlan('task')
    expect(jobs.enqueue).toHaveBeenCalledWith('execution.plan', expect.objectContaining({ taskId: 'task', requestedAt }), { dedupeKey: 'plan:task' })
    vi.setSystemTime(new Date('2026-10-14T10:00:30.000Z'))
    jobs.enqueue.mockResolvedValueOnce({ id: 'job', payload: { requestedAt }, createdAt: new Date(requestedAt), status: 'running' })
    await service.requestPlan('task')
    expect(events.publish).toHaveBeenLastCalledWith('run', 'plan_requested', { taskId: 'task', jobId: 'job', requestedAt })
  })

  it('announces preparation while the repository digest is still pending', async () => {
    const { service, repoContext, events } = fixture()
    let fail!: (error: Error) => void
    repoContext.digest.mockReturnValue(new Promise((_resolve, reject) => { fail = reject }))
    const requestedAt = '2026-10-14T10:00:00.000Z'
    const planning = service.plan('task', undefined, false, requestedAt)
    const rejected = expect(planning).rejects.toThrow('test preparation failure')
    await vi.waitFor(() => expect(repoContext.digest).toHaveBeenCalled())
    expect(events.publish).toHaveBeenCalledWith('run', 'planning_started', { taskId: 'task', requestedAt })
    fail(new Error('test preparation failure'))
    await rejected
  })

  it('restores the exact planning clock from the active job after a renderer reload', async () => {
    const { service, jobs } = fixture()
    const requestedAt = '2026-10-14T10:00:00.000Z'
    jobs.activeFor.mockResolvedValue([{ status: 'running', payload: { taskId: 'task', requestedAt }, createdAt: new Date() }])
    expect(await service.planningStatus('task')).toEqual({ startedAt: requestedAt, phase: 'preparing' })
    jobs.activeFor.mockResolvedValue([])
    expect(await service.planningStatus('task')).toBeUndefined()
  })
})
