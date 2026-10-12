import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'

const db = useTempDatabase('mac-settings-')
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('./migrator.js')
const { EventBusService } = await import('./event-bus.service.js')
const { SettingsService, mergeSettings, DEFAULT_SETTINGS } = await import('./settings.service.js')

const prisma = new PrismaService()
const events = new EventBusService()

beforeAll(async () => {
  await prisma.onModuleInit()
  await applyMigrations(prisma, MIGRATIONS_DIR)
})
afterAll(async () => {
  await prisma.$disconnect()
  db.cleanup()
})

describe('mergeSettings', () => {
  it('merges nested objects instead of replacing them with a stale copy', () => {
    const current = { ...DEFAULT_SETTINGS, onboarding: { completed: true, steps: { a: { ok: true, at: 'x' } } }, modelRoles: { fast: 'm1', balanced: 'm2', advanced: null } }
    const next = mergeSettings(current, { onboarding: { steps: { b: { ok: false, at: 'y' } } } as never, modelRoles: { advanced: 'm3' } as never })
    expect(next.onboarding).toEqual({ completed: true, steps: { a: { ok: true, at: 'x' }, b: { ok: false, at: 'y' } } })
    expect(next.modelRoles).toEqual({ fast: 'm1', balanced: 'm2', advanced: 'm3' })
  })

  it('removes a self-test entry with null and ignores unknown keys', () => {
    const current = { ...DEFAULT_SETTINGS, modelSelfTests: { a: { at: '1', ok: true, toolCalling: 'verified' as const, structuredOutput: true } } }
    const next = mergeSettings(current, { modelSelfTests: { a: null } as never, ...({ evil: 1 } as object) })
    expect(next.modelSelfTests).toEqual({})
    expect('evil' in next).toBe(false)
  })
})

describe('SettingsService', () => {
  it('serializes concurrent updates: no change is lost and versions increase monotonically', async () => {
    const service = new SettingsService(prisma, events)
    const published: number[] = []
    const subscription = events.stream().subscribe((event) => event.type === 'settings_changed' && published.push(event.data.version as number))

    const results = await Promise.all([
      service.updateVersioned({ costMode: 'quality' }),
      service.updateVersioned({ onboarding: { completed: true } as never }),
      service.updateVersioned({ modelSelfTests: { 'a:1b': { at: 'now', ok: true, toolCalling: 'verified', structuredOutput: true } } }),
      service.markOnboardingStep('ollama', true),
      service.updateVersioned({ modelRoles: { fast: 'a:1b' } as never }),
      service.updateVersioned({ maxTasks: 5 }),
    ])
    subscription.unsubscribe()

    const versions = results.map((result) => result.version)
    expect([...versions].sort((a, b) => a - b)).toEqual(versions)
    expect(new Set(versions).size).toBe(versions.length)
    expect(published).toEqual(versions)

    // A fresh service (= app restart) reads everything back from the database.
    const restarted = new SettingsService(prisma, events)
    const settings = await restarted.getVersioned()
    expect(settings.costMode).toBe('quality')
    expect(settings.onboarding.completed).toBe(true)
    expect(settings.onboarding.steps.ollama?.ok).toBe(true)
    expect(settings.modelSelfTests['a:1b']?.ok).toBe(true)
    expect(settings.modelRoles).toEqual({ fast: 'a:1b', balanced: null, advanced: null })
    expect(settings.maxTasks).toBe(5)
    expect(settings.version).toBe(versions.at(-1))
  })

  it('does not bump the version for a no-op patch', async () => {
    const service = new SettingsService(prisma, events)
    const before = await service.getVersioned()
    const result = await service.updateVersioned({ costMode: before.costMode })
    expect(result.version).toBe(before.version)
    expect(result.changed).toEqual([])
  })
})
