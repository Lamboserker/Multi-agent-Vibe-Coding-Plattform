import { describe, expect, it } from 'vitest'
import { forecastSchedule, type ForecastTask } from './schedule-forecast.js'

const GB = 1024 ** 3
const task = (id: string, patch: Partial<ForecastTask> = {}): ForecastTask => ({ id, dependsOn: [], writes: [`src/${id}.ts`], executor: 'local', model: 'qwen2.5-coder:7b', memoryBytes: 6 * GB, estimatedMs: 60_000, ...patch })

describe('forecastSchedule', () => {
  it('runs independent tasks in parallel up to the slot limits and waits for dependencies', () => {
    const result = forecastSchedule({
      tasks: [task('T1'), task('T2'), task('T3', { executor: 'premium', model: undefined }), task('T4', { dependsOn: ['T1', 'T2'] })],
      slots: { local: 2, premium: 1 },
      vramBytes: 16 * GB,
    })
    expect(result.waves.map((wave) => wave.tasks)).toEqual([['T1', 'T2', 'T3'], ['T4']])
    expect(result.tasks.T1).toMatchObject({ wave: 0, reason: 'ready', detail: 'startet sofort' })
    expect(result.tasks.T4).toMatchObject({ wave: 1, reason: 'dependencies', waitsFor: ['T1', 'T2'], detail: 'wartet auf T1, T2' })
    expect(result.maxParallel).toBe(3)
    expect(result.estimatedMs).toBe(120_000)
    expect(forecastSchedule({ tasks: [task('T1', { executor: 'premium', estimatedMs: undefined })], slots: { local: 1, premium: 1 } }).estimatedMs).toBe(120_000)
  })

  it('serializes local tasks beyond the slot count', () => {
    const result = forecastSchedule({ tasks: [task('T1'), task('T2'), task('T3')], slots: { local: 1, premium: 1 } })
    expect(result.waves.map((wave) => wave.tasks)).toEqual([['T1'], ['T2'], ['T3']])
    expect(result.tasks.T2).toMatchObject({ reason: 'local_slot', waitsFor: ['T1'] })
  })

  it('keeps a second local model out of a wave when both do not fit into VRAM', () => {
    const result = forecastSchedule({
      tasks: [task('T1', { model: 'qwen2.5-coder:14b', memoryBytes: 10 * GB }), task('T2', { model: 'deepseek-coder-v2:16b', memoryBytes: 10 * GB }), task('T3', { model: 'qwen2.5-coder:14b', memoryBytes: 10 * GB })],
      slots: { local: 2, premium: 1 },
      vramBytes: 16 * GB,
    })
    // T3 shares the resident model of T1, T2 has to wait for memory
    expect(result.waves[0]).toMatchObject({ tasks: ['T1', 'T3'], localModels: ['qwen2.5-coder:14b'], fitsVram: true })
    expect(result.tasks.T2).toMatchObject({ wave: 1, reason: 'memory' })
    expect(result.tasks.T2!.detail).toContain('VRAM')
  })

  it('serializes writers of the same file and names the file', () => {
    const result = forecastSchedule({ tasks: [task('T1', { writes: ['src/a.ts'] }), task('T2', { writes: ['src/a.ts'] })], slots: { local: 2, premium: 1 } })
    expect(result.tasks.T2).toMatchObject({ wave: 1, reason: 'file_conflict', waitsFor: ['T1'] })
    expect(result.tasks.T2!.detail).toContain('src/a.ts')
  })

  it('skips completed tasks, keeps running ones first and blocks dependents of unroutable tasks', () => {
    const result = forecastSchedule({
      tasks: [task('T1', { status: 'completed' }), task('T2', { status: 'running', dependsOn: ['T1'] }), task('T3', { executor: 'blocked' }), task('T4', { dependsOn: ['T3'] }), task('T5', { dependsOn: ['T1'] })],
      slots: { local: 1, premium: 1 },
    })
    expect(result.tasks.T1!.reason).toBe('done')
    expect(result.tasks.T2).toMatchObject({ wave: 0, reason: 'running' })
    expect(result.tasks.T5).toMatchObject({ wave: 1, reason: 'local_slot' })
    expect(result.tasks.T3!.reason).toBe('blocked')
    expect(result.tasks.T4).toMatchObject({ reason: 'blocked', waitsFor: ['T3'] })
  })

  it('marks the longest chain as critical path', () => {
    const result = forecastSchedule({
      tasks: [task('T1', { estimatedMs: 10_000 }), task('T2', { estimatedMs: 50_000 }), task('T3', { dependsOn: ['T2'], estimatedMs: 20_000 })],
      slots: { local: 3, premium: 1 },
    })
    expect(result.criticalPath).toEqual(['T2', 'T3'])
    expect(result.tasks.T3!.critical).toBe(true)
    expect(result.tasks.T1!.critical).toBe(false)
  })

  it('survives cyclic dependencies with a warning', () => {
    const result = forecastSchedule({ tasks: [task('T1', { dependsOn: ['T2'] }), task('T2', { dependsOn: ['T1'] })], slots: { local: 2, premium: 1 } })
    expect(result.waves.flatMap((wave) => wave.tasks).sort()).toEqual(['T1', 'T2'])
    expect(result.warnings.join(' ')).toMatch(/Zyklische|Zyklus/)
  })
})
