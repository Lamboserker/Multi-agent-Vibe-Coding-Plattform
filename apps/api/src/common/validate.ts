import { BadRequestException } from '@nestjs/common'

/** Minimal request-body validation helpers (the API is local-only but still validates every input). */
export function str(body: unknown, key: string, options: { optional?: boolean; max?: number } = {}): string {
  const value = (body as Record<string, unknown> | undefined)?.[key]
  if (value === undefined || value === null || value === '') {
    if (options.optional) return ''
    throw new BadRequestException(`"${key}" is required.`)
  }
  if (typeof value !== 'string') throw new BadRequestException(`"${key}" must be a string.`)
  if (value.length > (options.max ?? 100_000)) throw new BadRequestException(`"${key}" is too long.`)
  return value
}

export function bool(body: unknown, key: string, fallback = false): boolean {
  const value = (body as Record<string, unknown> | undefined)?.[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new BadRequestException(`"${key}" must be a boolean.`)
  return value
}

export function oneOf<T extends string>(body: unknown, key: string, values: readonly T[], fallback?: T): T {
  const value = (body as Record<string, unknown> | undefined)?.[key]
  if ((value === undefined || value === null) && fallback !== undefined) return fallback
  if (typeof value !== 'string' || !values.includes(value as T)) throw new BadRequestException(`"${key}" must be one of ${values.join(', ')}.`)
  return value as T
}

export function strList(body: unknown, key: string, max = 500): string[] {
  const value = (body as Record<string, unknown> | undefined)?.[key]
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new BadRequestException(`"${key}" must be a list of strings.`)
  return value.slice(0, max) as string[]
}

export function num(body: unknown, key: string, options: { optional?: boolean; min?: number; max?: number } = {}): number | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[key]
  if (value === undefined || value === null) {
    if (options.optional) return undefined
    throw new BadRequestException(`"${key}" is required.`)
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BadRequestException(`"${key}" must be a number.`)
  if (options.min !== undefined && value < options.min) throw new BadRequestException(`"${key}" must be ≥ ${options.min}.`)
  if (options.max !== undefined && value > options.max) throw new BadRequestException(`"${key}" must be ≤ ${options.max}.`)
  return value
}
