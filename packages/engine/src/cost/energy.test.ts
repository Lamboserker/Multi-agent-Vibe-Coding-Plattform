import { describe, expect, it } from 'vitest'
import { basePerDay, costPerHour, dayKey, emptyLedger, integrate, lastDays, powerReading, summarizeEnergy, type ElectricityTariff } from './energy.js'

const tariff: ElectricityTariff = { pricePerKwh: 0.3, basePricePerMonth: 12.17, systemBaseWatts: 60, cpuMaxWatts: 100 }

describe('electricity', () => {
  it('combines measured GPU power with the estimated rest of the system', () => {
    expect(powerReading({ gpuPowerW: 120.04, inferenceActive: true, cpuPct: 50, tariff })).toEqual({ gpuW: 120, gpuSource: 'nvidia-smi', systemW: 110, systemSource: 'estimate', totalW: 230 })
    // no telemetry: the configured GPU wattage counts only while a local model works
    expect(powerReading({ gpuWattsSetting: 200, inferenceActive: false, cpuPct: 0, tariff: null })).toMatchObject({ gpuW: 0, gpuSource: 'setting', systemSource: 'none', totalW: 0 })
    expect(powerReading({ gpuWattsSetting: 200, inferenceActive: true, cpuPct: 0, tariff: null }).totalW).toBe(200)
    expect(powerReading({ inferenceActive: true, cpuPct: 30 })).toEqual({ gpuW: undefined, gpuSource: 'none', systemW: undefined, systemSource: 'none', totalW: 0 })
  })

  it('integrates power over time per local day and skips gaps', () => {
    const reading = (totalW: number, gpuW = totalW) => ({ totalW, gpuW, gpuSource: 'nvidia-smi' as const, systemSource: 'none' as const })
    const t0 = new Date(2026, 9, 16, 10, 0, 0)
    let ledger = integrate(emptyLedger(), undefined, { at: t0, reading: reading(100), inferenceActive: false })
    expect(ledger.since).toBe(t0.toISOString())
    ledger = integrate(ledger, { at: t0, reading: reading(100), inferenceActive: false }, { at: new Date(t0.getTime() + 36_000), reading: reading(300), inferenceActive: true })
    // trapezoid: 200 W average for 36 s = 2 Wh, counted as inference (a model worked at one end)
    expect(ledger.days[dayKey(t0)]).toEqual({ wh: 2, inferenceWh: 2, gpuWh: 2, seconds: 36 })
    const gap = integrate(ledger, { at: t0, reading: reading(100), inferenceActive: false }, { at: new Date(t0.getTime() + 10 * 60_000), reading: reading(100), inferenceActive: false })
    expect(gap).toBe(ledger)
  })

  it('costs: unit price per kWh plus the pro-rata base price', () => {
    expect(basePerDay(tariff)).toBeCloseTo(0.4001, 4)
    const ledger = { version: 1 as const, days: { '2026-10-15': { wh: 1500, inferenceWh: 500, gpuWh: 900, seconds: 7200 }, '2026-10-16': { wh: 500, inferenceWh: 0, gpuWh: 100, seconds: 3600 } } }
    const keys = lastDays(new Date(2026, 9, 16, 12), 2)
    expect(keys).toEqual(['2026-10-15', '2026-10-16'])
    expect(summarizeEnergy(ledger, keys, tariff)).toEqual({ kWh: 2, inferenceKWh: 0.5, hours: 3, energyCost: 0.6, baseCost: 0.800219, totalCost: 1.400219, days: 2 })
    expect(summarizeEnergy(ledger, keys, null)).toMatchObject({ kWh: 2, energyCost: null, baseCost: null, totalCost: null })
    expect(costPerHour(250, tariff)).toEqual({ energy: 0.075, base: 0.01667, total: 0.09167 })
  })
})
