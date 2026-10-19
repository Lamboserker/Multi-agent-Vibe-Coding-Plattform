/*
 * Electricity: live power draw, an energy ledger (integrated over time, per day) and costs from the
 * user's tariff (unit price per kWh + monthly base price). GPU power is measured (nvidia-smi) when
 * available; the rest of the PC can only be estimated from the user's own figures and is labelled so.
 */

export interface ElectricityTariff {
  /** Unit price in € per kWh (e.g. 0.32). */
  pricePerKwh: number
  /** Base price in € per month (paid regardless of consumption). */
  basePricePerMonth: number
  /** Estimated draw of the rest of the PC when idle (board, RAM, disks, monitor not included), W. */
  systemBaseWatts?: number | null
  /** Additional CPU draw at 100 % load, W (scaled by the measured CPU load). */
  cpuMaxWatts?: number | null
}

export interface PowerReading {
  /** Measured or assumed GPU draw, W (undefined = unknown). */
  gpuW?: number
  gpuSource: 'nvidia-smi' | 'setting' | 'none'
  /** Estimated draw of CPU and the rest of the system, W (undefined = not configured). */
  systemW?: number
  systemSource: 'estimate' | 'none'
  totalW: number
}

/**
 * Current draw. Without GPU telemetry the configured GPU wattage counts only while a local model
 * is working (that is when the GPU runs at load); idle GPU draw is then unknown.
 */
export function powerReading(input: { gpuPowerW?: number; gpuWattsSetting?: number | null; inferenceActive: boolean; cpuPct: number; tariff?: ElectricityTariff | null }): PowerReading {
  let gpuW: number | undefined
  let gpuSource: PowerReading['gpuSource'] = 'none'
  if (input.gpuPowerW !== undefined && Number.isFinite(input.gpuPowerW)) {
    gpuW = Math.max(0, input.gpuPowerW)
    gpuSource = 'nvidia-smi'
  } else if (input.gpuWattsSetting) {
    gpuW = input.inferenceActive ? input.gpuWattsSetting : 0
    gpuSource = 'setting'
  }
  const base = input.tariff?.systemBaseWatts ?? null
  const cpuMax = input.tariff?.cpuMaxWatts ?? null
  const configured = base !== null || cpuMax !== null
  const systemW = configured ? (base ?? 0) + ((cpuMax ?? 0) * Math.max(0, Math.min(100, input.cpuPct))) / 100 : undefined
  const totalW = Math.round(((gpuW ?? 0) + (systemW ?? 0)) * 10) / 10
  return { gpuW: gpuW === undefined ? undefined : Math.round(gpuW * 10) / 10, gpuSource, systemW: systemW === undefined ? undefined : Math.round(systemW * 10) / 10, systemSource: configured ? 'estimate' : 'none', totalW }
}

export interface DayEnergy {
  /** Energy of all measured/estimated draw, Wh. */
  wh: number
  /** Part of it while a local model was working on a task, Wh. */
  inferenceWh: number
  gpuWh: number
  /** Seconds covered by samples. */
  seconds: number
}

export interface EnergyLedger {
  version: 1
  since?: string
  days: Record<string, DayEnergy>
}

export const emptyLedger = (): EnergyLedger => ({ version: 1, days: {} })

/** Local calendar day (the tariff is billed in local time). */
export function dayKey(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

/**
 * Adds the energy since the previous sample (trapezoid of the two readings). Gaps longer than
 * `maxGapMs` (sleep, app closed) are not counted: nothing is measured there.
 */
export function integrate(ledger: EnergyLedger, previous: { at: Date; reading: PowerReading; inferenceActive: boolean } | undefined, current: { at: Date; reading: PowerReading; inferenceActive: boolean }, maxGapMs = 60_000): EnergyLedger {
  if (!previous) return { ...ledger, since: ledger.since ?? current.at.toISOString() }
  const dtMs = current.at.getTime() - previous.at.getTime()
  if (dtMs <= 0 || dtMs > maxGapMs) return ledger
  const hours = dtMs / 3_600_000
  const wh = ((previous.reading.totalW + current.reading.totalW) / 2) * hours
  const gpuWh = (((previous.reading.gpuW ?? 0) + (current.reading.gpuW ?? 0)) / 2) * hours
  const key = dayKey(current.at)
  const day = ledger.days[key] ?? { wh: 0, inferenceWh: 0, gpuWh: 0, seconds: 0 }
  const inference = previous.inferenceActive || current.inferenceActive
  return {
    ...ledger,
    days: {
      ...ledger.days,
      [key]: { wh: day.wh + wh, inferenceWh: day.inferenceWh + (inference ? wh : 0), gpuWh: day.gpuWh + gpuWh, seconds: day.seconds + dtMs / 1000 },
    },
  }
}

/** Base price per day: monthly price × 12 / 365. */
export const basePerDay = (tariff: Pick<ElectricityTariff, 'basePricePerMonth'>) => (tariff.basePricePerMonth * 12) / 365

export interface EnergySummary {
  kWh: number
  inferenceKWh: number
  hours: number
  /** kWh × unit price (null without tariff). */
  energyCost: number | null
  /** Pro-rata base price of the covered days (null without tariff). */
  baseCost: number | null
  totalCost: number | null
  days: number
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits

/** Energy and costs of the given days; the base price is counted for every calendar day of the range. */
export function summarizeEnergy(ledger: EnergyLedger, keys: string[], tariff?: ElectricityTariff | null): EnergySummary {
  let wh = 0
  let inferenceWh = 0
  let seconds = 0
  for (const key of keys) {
    const day = ledger.days[key]
    if (!day) continue
    wh += day.wh
    inferenceWh += day.inferenceWh
    seconds += day.seconds
  }
  const kWh = wh / 1000
  const energyCost = tariff ? kWh * tariff.pricePerKwh : null
  const baseCost = tariff ? basePerDay(tariff) * keys.length : null
  return {
    kWh: round(kWh, 4),
    inferenceKWh: round(inferenceWh / 1000, 4),
    hours: round(seconds / 3600, 2),
    energyCost: energyCost === null ? null : round(energyCost, 6),
    baseCost: baseCost === null ? null : round(baseCost, 6),
    totalCost: energyCost === null || baseCost === null ? null : round(energyCost + baseCost, 6),
    days: keys.length,
  }
}

/** The last `count` calendar days ending today (oldest first). */
export function lastDays(today: Date, count: number): string[] {
  const keys: string[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
    keys.push(dayKey(day))
  }
  return keys
}

/** Cost of running at `watts` for one hour, including the base price share of that hour. */
export function costPerHour(watts: number, tariff: ElectricityTariff): { energy: number; base: number; total: number } {
  const energy = (watts / 1000) * tariff.pricePerKwh
  const base = basePerDay(tariff) / 24
  return { energy: round(energy, 5), base: round(base, 5), total: round(energy + base, 5) }
}
