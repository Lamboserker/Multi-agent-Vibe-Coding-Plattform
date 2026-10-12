import { describe, expect, it } from 'vitest'
import { DagScheduler, type SchedulableTask } from './scheduler.js'

const task = (id: string, overrides: Partial<SchedulableTask> = {}): SchedulableTask => ({ id, dependsOn: [], writes: [], priority: 0, resource: 'local', ...overrides })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('DagScheduler', () => {
  it('runs independent tasks in parallel up to the slot limit and respects dependencies', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const order: string[] = []
    const scheduler = new DagScheduler([task('a'), task('b'), task('c'), task('d', { dependsOn: ['a', 'b', 'c'] })], {
      slots: { local: 2, premium: 1, none: 1 },
      run: async (current) => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await sleep(20)
        order.push(current.id)
        concurrent -= 1
        return 'succeeded'
      },
    })
    const result = await scheduler.run()
    expect(maxConcurrent).toBe(2)
    expect(order.at(-1)).toBe('d')
    expect(Object.values(result.states).every((state) => state === 'succeeded')).toBe(true)
  })

  it('skips dependents of failed tasks but continues independent work', async () => {
    const scheduler = new DagScheduler([task('a'), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['b'] }), task('x')], {
      slots: { local: 1, premium: 1, none: 1 },
      run: async (current) => (current.id === 'a' ? 'failed' : 'succeeded'),
    })
    const result = await scheduler.run()
    expect(result.states).toEqual({ a: 'failed', b: 'skipped', c: 'skipped', x: 'succeeded' })
  })

  it('never runs two tasks writing the same file at once', async () => {
    let active = new Set<string>()
    let overlap = false
    const scheduler = new DagScheduler([task('a', { writes: ['f.ts'] }), task('b', { writes: ['f.ts'] }), task('c', { writes: ['g.ts'] })], {
      slots: { local: 3, premium: 1, none: 1 },
      run: async (current) => {
        if (current.writes.includes('f.ts') && [...active].some((id) => id !== 'c')) overlap = true
        active.add(current.id)
        await sleep(15)
        active.delete(current.id)
        return 'succeeded'
      },
    })
    await scheduler.run()
    expect(overlap).toBe(false)
    active = new Set()
  })

  it('serializes different local models that cannot share memory', async () => {
    let running: string[] = []
    let mixed = false
    const scheduler = new DagScheduler([task('a', { model: 'big' }), task('b', { model: 'small' }), task('c', { model: 'big' })], {
      slots: { local: 3, premium: 1, none: 1 },
      modelsCanCoexist: () => false,
      run: async (current) => {
        running.push(current.model!)
        if (new Set(running).size > 1) mixed = true
        await sleep(10)
        running = running.filter((model, index) => index !== running.indexOf(current.model!))
        return 'succeeded'
      },
    })
    await scheduler.run()
    expect(mixed).toBe(false)
  })

  it('separates local and premium slots', async () => {
    const active: Record<string, number> = { local: 0, premium: 0 }
    let both = false
    const scheduler = new DagScheduler([task('l'), task('p', { resource: 'premium' })], {
      slots: { local: 1, premium: 1, none: 1 },
      run: async (current) => {
        active[current.resource] = (active[current.resource] ?? 0) + 1
        if (active.local && active.premium) both = true
        await sleep(15)
        active[current.resource]! -= 1
        return 'succeeded'
      },
    })
    await scheduler.run()
    expect(both).toBe(true)
  })

  it('supports pause/resume and cancellation', async () => {
    const started: string[] = []
    const scheduler = new DagScheduler([task('a'), task('b'), task('c')], {
      slots: { local: 1, premium: 1, none: 1 },
      run: async (current, signal) => {
        started.push(current.id)
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 30)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve(undefined)
          })
        })
        return 'succeeded'
      },
    })
    const promise = scheduler.run()
    await sleep(5)
    scheduler.pause()
    await sleep(60)
    expect(started).toEqual(['a'])
    scheduler.resume()
    await sleep(5)
    scheduler.cancel()
    const result = await promise
    expect(result.cancelled).toBe(true)
    expect(result.states.c).toBe('cancelled')
  })

  it('retries infrastructure failures once and resumes from persisted states', async () => {
    let calls = 0
    const scheduler = new DagScheduler([task('done'), task('flaky', { dependsOn: ['done'] })], {
      slots: { local: 1, premium: 1, none: 1 },
      initialStates: { done: 'succeeded' },
      maxInfraRetries: 1,
      run: async (current) => {
        if (current.id === 'done') throw new Error('must not re-run completed tasks')
        calls += 1
        if (calls === 1) throw new Error('worker crashed')
        return 'succeeded'
      },
    })
    const result = await scheduler.run()
    expect(calls).toBe(2)
    expect(result.states).toEqual({ done: 'succeeded', flaky: 'succeeded' })
  })
})
