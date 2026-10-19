import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { summarizeUsage, type UsageCall } from '../cost/usage.js'
import { parseNvidiaSmi, type HardwareProfile } from '../hardware/detect.js'
import { buildContextDigest, buildRepoIndex, extractSymbols, rankFiles, searchCode } from '../index/repo-index.js'
import { createTempRepo } from '../test-utils.js'
import { classifyFit, estimateRuntimeMemory, lookupRegistryModel, recommendModels, runtimeContextTokens, type RegistryModelInfo } from './catalog.js'

const GB = 1024 ** 3

function profile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    os: { platform: 'win32', release: '10', arch: 'x64' },
    cpu: { model: 'Ryzen', logicalCores: 16 },
    memory: { totalBytes: 32 * GB, freeBytes: 16 * GB },
    gpus: [{ name: 'RTX 4060 Ti', vendor: 'nvidia', vramTotalMb: 16380, vramReliable: true, vramSource: 'nvidia-smi' }],
    acceleration: ['cuda', 'cpu'],
    disks: { ollamaModels: { path: 'C:/x', freeBytes: 200 * GB } },
    ollamaModelsDir: 'C:/x',
    detectedAt: '',
    warnings: [],
    ...overrides,
  }
}

// Sizes as reported by registry.ollama.ai on 2026-10-09.
const registry: RegistryModelInfo[] = [
  { model: 'qwen2.5-coder:1.5b', exists: true, downloadBytes: 986_061_602, toolTemplate: 'yes' },
  { model: 'qwen2.5-coder:7b', exists: true, downloadBytes: 4_683_087_074, toolTemplate: 'yes' },
  { model: 'gpt-oss:20b', exists: true, downloadBytes: 13_793_440_755, toolTemplate: 'yes' },
  { model: 'qwen3-coder:30b', exists: true, downloadBytes: 18_556_700_222, toolTemplate: 'unknown' },
  { model: 'starcoder2:3b', exists: true, downloadBytes: 1_709_901_383, toolTemplate: 'no' },
  { model: 'gone:1b', exists: false, toolTemplate: 'unknown' },
]

describe('hardware parsing and fit classification', () => {
  it('sizes arbitrary models for reliable GPU and weak CPU profiles, respecting both limits', () => {
    expect(runtimeContextTokens(16384, 32768, 4 * GB, profile())).toBe(16384)
    const smallGpu = profile({ gpus: [{ name: 'small GPU', vendor: 'other', vramTotalMb: 4096, vramReliable: true, vramSource: 'registry' }] })
    const tokens = runtimeContextTokens(32768, 32768, 2 * GB, smallGpu)
    expect(tokens).toBeLessThan(16384)
    expect(estimateRuntimeMemory(2 * GB, tokens)).toBeLessThanOrEqual(4096 * 1024 ** 2 * 0.85)
    const weak = profile({ gpus: [], memory: { totalBytes: 8 * GB, freeBytes: 4 * GB } })
    expect(runtimeContextTokens(16384, 32768, GB, weak)).toBe(8192)
    expect(runtimeContextTokens(4096, 2048, GB, weak)).toBe(2048)
    expect(runtimeContextTokens(16384, 32768, 20 * GB, profile())).toBe(4096)
  })
  it('parses nvidia-smi CSV', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 4060 Ti, 16380, 10855, 610.88\n')).toEqual([
      { name: 'NVIDIA GeForce RTX 4060 Ti', vendor: 'nvidia', vramTotalMb: 16380, vramUsedMb: 10855, vramReliable: true, vramSource: 'nvidia-smi', driver: '610.88' },
    ])
  })

  it('classifies GPU, offload, CPU and too-large fits', () => {
    expect(classifyFit(5 * GB, profile()).fit).toBe('gpu')
    expect(classifyFit(20 * GB, profile()).fit).toBe('partial_offload')
    expect(classifyFit(60 * GB, profile()).fit).toBe('too_large')
    expect(classifyFit(5 * GB, profile({ gpus: [] })).fit).toBe('cpu')
    // a 4 GB WMI-capped value must not be trusted
    expect(classifyFit(5 * GB, profile({ gpus: [{ name: 'GPU', vendor: 'nvidia', vramTotalMb: 4095, vramReliable: false, vramSource: 'wmi-capped' }] })).fit).toBe('cpu')
  })
})

describe('recommendModels', () => {
  it('assigns fast/balanced/advanced roles on a 16 GB GPU', () => {
    const recs = recommendModels({ profile: profile(), registry })
    const roles = Object.fromEntries(recs.filter((rec) => rec.roles.length).map((rec) => [rec.model, rec.roles]))
    expect(roles['qwen2.5-coder:1.5b']).toEqual(['fast'])
    expect(roles['qwen2.5-coder:7b']).toEqual(['balanced'])
    expect(Object.values(roles).flat()).toContain('advanced')
    expect(recs.find((rec) => rec.model === 'starcoder2:3b')!.recommended).toBe(false)
    expect(recs.find((rec) => rec.model === 'gone:1b')).toBeUndefined()
  })

  it('respects free disk space and lets one model take all roles on weak hardware', () => {
    const lowDisk = recommendModels({ profile: profile({ disks: { ollamaModels: { path: 'C:/x', freeBytes: 6 * GB } } }), registry })
    expect(lowDisk.find((rec) => rec.model === 'gpt-oss:20b')!.diskOk).toBe(false)
    expect(lowDisk.find((rec) => rec.model === 'gpt-oss:20b')!.recommended).toBe(false)

    const weak = recommendModels({ profile: profile({ gpus: [], memory: { totalBytes: 8 * GB, freeBytes: 4 * GB } }), registry })
    const assigned = weak.filter((rec) => rec.roles.length)
    expect(assigned).toHaveLength(1)
    expect(assigned[0]!.roles).toEqual(['fast', 'balanced', 'advanced'])
  })

  it('prefers verified tool capability of installed models', () => {
    const recs = recommendModels({ profile: profile(), registry, installed: [{ name: 'qwen2.5-coder:7b', size: 1, capabilities: ['completion'] }] })
    expect(recs.find((rec) => rec.model === 'qwen2.5-coder:7b')!.toolCalling).toBe('none')
  })

  it('validates model names before querying the registry', async () => {
    const info = await lookupRegistryModel('../../etc:passwd', async () => {
      throw new Error('must not be called')
    })
    expect(info.exists).toBe(false)
  })
})

describe('summarizeUsage', () => {
  const calls: UsageCall[] = [
    { kind: 'orchestrator', provider: 'claude-code', model: 'sonnet', purpose: 'plan', status: 'ok', durationMs: 4000, inputTokens: 10_000, outputTokens: 1000, cachedInputTokens: 0, tokensMeasured: true, apiEquivalentUsd: 0.045, billing: 'subscription' },
    { kind: 'orchestrator', provider: 'claude-code', model: 'sonnet', purpose: 'review', status: 'error', durationMs: 100, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, tokensMeasured: false, billing: 'unknown' },
    { kind: 'local', provider: 'ollama', model: 'qwen:7b', purpose: 'execute', status: 'ok', durationMs: 60_000, inputTokens: 40_000, outputTokens: 4000, cachedInputTokens: 0, tokensMeasured: true, billing: 'subscription', peakMemoryMb: 5200 },
  ]

  it('separates measured usage, actual spend and an explicitly estimated baseline', () => {
    const summary = summarizeUsage(calls, { gpuWatts: 160 })
    expect(summary.premium).toMatchObject({ calls: 2, failedCalls: 1, inputTokens: 10_000, measuredCalls: 1, unmeasuredCalls: 1 })
    expect(summary.premium.apiEquivalentUsd).toEqual({ value: 0.045, basis: 'reported', reportedCalls: 1 })
    expect(summary.spend.actualUsd).toBe(0)
    expect(summary.local).toMatchObject({ calls: 1, inputTokens: 40_000, peakMemoryMb: 5200 })
    expect(summary.local.energyWh?.value).toBeCloseTo(2.67, 1)
    expect(summary.baseline?.estimate).toBe(true)
    // effective rate: 0.045 / (10000 + 5*1000) per token
    expect(summary.baseline?.localTokensAtPremiumPriceUsd).toBeCloseTo((40_000 + 5 * 4000) * (0.045 / 15_000), 5)
  })

  it('does not invent a baseline without reported or configured prices', () => {
    const summary = summarizeUsage(calls.filter((call) => call.kind === 'local'))
    expect(summary.baseline).toBeUndefined()
    expect(summary.notes.join(' ')).toMatch(/No savings baseline/)
  })
})

describe('repository index', () => {
  it('extracts symbols, resolves imports, ranks files and builds a budgeted digest', async () => {
    const repo = await createTempRepo({
      'package.json': JSON.stringify({ name: 'shop', dependencies: { react: '19', next: '16' }, scripts: { test: 'vitest run' } }),
      'src/components/LoginForm.tsx': "import { validateEmail } from '../lib/validation.js'\nexport function LoginForm() { return null }\n",
      'src/lib/validation.ts': 'export function validateEmail(value: string) { return value.includes("@") }\nexport const MAX = 3\n',
      'src/lib/cart.ts': 'export class Cart { add() {} }\n',
      '.env': 'SECRET=1\n',
    })
    const index = await buildRepoIndex(repo)
    expect(index.files.map((file) => file.path)).not.toContain('.env')
    expect(index.frameworks).toEqual(expect.arrayContaining(['Next.js', 'React']))
    const form = index.files.find((file) => file.path === 'src/components/LoginForm.tsx')!
    expect(form.symbols[0]).toMatchObject({ name: 'LoginForm', kind: 'component', exported: true })
    expect(form.dependsOn).toEqual(['src/lib/validation.ts'])

    const ranked = rankFiles(index, 'Add password validation to the login form')
    expect(ranked[0]!.path).toBe('src/components/LoginForm.tsx')
    expect(ranked.map((entry) => entry.path)).toContain('src/lib/validation.ts')

    const digest = await buildContextDigest(index, 'Add password validation to the login form', { budgetTokens: 1500 })
    expect(digest.tokenEstimate).toBeLessThanOrEqual(1500)
    expect(digest.relevantFiles[0]!.outline).toContain('LoginForm')

    // planning: files no keyword matched are added too, with their complete content
    const full = await buildContextDigest(index, 'Add password validation to the login form', { budgetTokens: 20_000, excerptFiles: 10, excerptChars: 20_000, fillUnranked: true })
    expect(full.relevantFiles.map((file) => file.path)).toContain('src/lib/cart.ts')
    expect(full.relevantFiles.find((file) => file.path === 'src/lib/cart.ts')).toMatchObject({ complete: true, excerpt: expect.stringContaining('class Cart') })

    // incremental rebuild reuses unchanged files
    await fs.writeFile(path.join(repo, 'src/lib/cart.ts'), 'export class Cart { add() {} remove() {} }\n')
    const second = await buildRepoIndex(repo, index)
    expect(second.stats.reusedFromCache).toBeGreaterThanOrEqual(3)
    expect(second.stats.indexedFiles).toBe(1)

    const hits = await searchCode(repo, 'validateEmail')
    expect(hits.map((hit) => hit.path)).toEqual(expect.arrayContaining(['src/lib/validation.ts', 'src/components/LoginForm.tsx']))
    expect(await searchCode(repo, 'SECRET')).toEqual([])
  })

  it('extracts python and prisma symbols with the regex fallback', () => {
    expect(extractSymbols('app.py', 'class User:\n    pass\ndef login():\n    pass\n').symbols.map((symbol) => symbol.name)).toEqual(['User', 'login'])
    expect(extractSymbols('schema.prisma', 'model User {\n}\nenum Role {\n}\n').symbols.map((symbol) => symbol.name)).toEqual(['User', 'Role'])
  })
})
