import { Injectable } from '@nestjs/common'
import os from 'node:os'
import { inferenceTimings, orchestratorFirstOutputs, resolveExecutable, runProcess } from '@multi-ai-coder/engine'
import { PrismaService } from '../common/prisma.service.js'
import { RepoContextService } from '../execution/repo-context.service.js'
import { LocalModelsService } from '../local-models/local-models.service.js'
import { OrchestratorService } from '../orchestration/orchestrator.service.js'
import { JobQueueService } from './job-queue.service.js'

interface RequestSample {
  method: string
  route: string
  status: number
  ms: number
  at: string
}

const requests: RequestSample[] = []

/** Records one HTTP request of the runtime (called by the timing middleware in main.ts). */
export function recordRequest(sample: RequestSample) {
  requests.push(sample)
  if (requests.length > 1000) requests.shift()
}

/** Route pattern of a URL (ids replaced) so timings can be grouped. */
export function routeOf(url: string) {
  return (url.split('?')[0] ?? '').replace(/\/c[a-z0-9]{20,}/g, '/:id').replace(/\/[0-9a-f-]{32,}/gi, '/:id')
}

function percentile(values: number[], q: number) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!
}

function summary(values: number[]) {
  return { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null }
}

async function cpuLoadPercent(sampleMs = 250): Promise<number> {
  const snapshot = () => os.cpus().reduce((acc, cpu) => ({ idle: acc.idle + cpu.times.idle, total: acc.total + Object.values(cpu.times).reduce((sum, value) => sum + value, 0) }), { idle: 0, total: 0 })
  const before = snapshot()
  await new Promise((resolve) => setTimeout(resolve, sampleMs))
  const after = snapshot()
  const total = after.total - before.total
  return total > 0 ? Math.round((1 - (after.idle - before.idle) / total) * 1000) / 10 : 0
}

async function gpuStatus() {
  const smi = resolveExecutable('nvidia-smi')
  if (!smi) return null
  const result = await runProcess(smi, ['--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits'], { timeoutMs: 5000 })
  if (result.exitCode !== 0) return null
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, total, used, utilization, temperature] = line.split(',').map((part) => part.trim())
      return { name, vramTotalMb: Number(total), vramUsedMb: Number(used), utilizationPercent: Number(utilization), temperatureC: Number(temperature) }
    })
}

/**
 * Performance and health snapshot of the local runtime (Phase 0.3, 2.9). Everything is measured;
 * nothing contains secrets (no environment, no tokens, no prompts).
 */
@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobQueueService,
    private readonly orchestrators: OrchestratorService,
    private readonly localModels: LocalModelsService,
    private readonly repoContext: RepoContextService,
  ) {}

  async collect() {
    const since = new Date(Date.now() - 7 * 86_400_000)
    const [load, gpu, running, localCalls, premiumCalls, runs] = await Promise.all([
      cpuLoadPercent(),
      gpuStatus().catch(() => null),
      this.localModels.running().catch(() => []),
      this.prisma.modelCall.findMany({ where: { kind: 'local', createdAt: { gte: since } }, select: { model: true, durationMs: true, inputTokens: true, outputTokens: true, peakMemoryMb: true, status: true }, orderBy: { createdAt: 'desc' }, take: 500 }),
      this.prisma.modelCall.findMany({ where: { kind: 'orchestrator', createdAt: { gte: since } }, select: { provider: true, purpose: true, durationMs: true, status: true }, orderBy: { createdAt: 'desc' }, take: 500 }),
      this.prisma.executionRun.findMany({ where: { createdAt: { gte: since } }, select: { finalValidation: true }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ])
    const memory = process.memoryUsage()
    const cpu = process.cpuUsage()

    const byModel = new Map<string, Array<{ durationMs: number; outputTokens: number; inputTokens: number }>>()
    for (const call of localCalls) if (call.status === 'ok') byModel.set(call.model, [...(byModel.get(call.model) ?? []), call])
    const inference = [...byModel.entries()].map(([model, calls]) => ({
      model,
      calls: calls.length,
      tokensPerSecond: percentile(calls.filter((call) => call.durationMs > 0).map((call) => (call.outputTokens / call.durationMs) * 1000), 0.5),
      durationMs: summary(calls.map((call) => call.durationMs)),
    }))

    const byPurpose = new Map<string, number[]>()
    for (const call of premiumCalls) if (call.status === 'ok') byPurpose.set(`${call.provider}:${call.purpose}`, [...(byPurpose.get(`${call.provider}:${call.purpose}`) ?? []), call.durationMs])

    const checks = new Map<string, number[]>()
    for (const run of runs) {
      for (const result of ((run.finalValidation as { results?: Array<{ kind: string; durationMs: number; status: string }> })?.results ?? [])) {
        if (result.status === 'skipped') continue
        checks.set(result.kind, [...(checks.get(result.kind) ?? []), result.durationMs])
      }
    }

    const jobsByType = new Map<string, { wait: number[]; run: number[] }>()
    for (const timing of this.jobs.timings) {
      const entry = jobsByType.get(timing.type) ?? { wait: [], run: [] }
      entry.wait.push(timing.waitMs)
      if (timing.runMs !== undefined) entry.run.push(timing.runMs)
      jobsByType.set(timing.type, entry)
    }

    const routes = new Map<string, number[]>()
    for (const sample of requests) routes.set(`${sample.method} ${sample.route}`, [...(routes.get(`${sample.method} ${sample.route}`) ?? []), sample.ms])
    const orchestratorMetrics = this.orchestrators.metrics
    const statusCalls = orchestratorMetrics.statusCalls.length
    const detectCalls = orchestratorMetrics.detectCalls.length
    const index = this.repoContext.counters
    const indexTotal = index.hits + index.incremental + index.full

    return {
      collectedAt: new Date().toISOString(),
      runtime: { pid: process.pid, uptimeSec: Math.round(process.uptime()), rssMb: Math.round(memory.rss / 1024 / 1024), heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024), cpuUserMs: Math.round(cpu.user / 1000), cpuSystemMs: Math.round(cpu.system / 1000) },
      system: { platform: `${os.type()} ${os.release()}`, cpuModel: os.cpus()[0]?.model.trim(), logicalCores: os.cpus().length, cpuLoadPercent: load, memoryTotalMb: Math.round(os.totalmem() / 1024 / 1024), memoryFreeMb: Math.round(os.freemem() / 1024 / 1024) },
      gpu,
      models: {
        loaded: running.map((entry) => ({ name: entry.name, vramMb: Math.round((entry.size_vram ?? 0) / 1024 / 1024), sizeMb: Math.round(entry.size / 1024 / 1024), expiresAt: entry.expires_at })),
        inference,
        firstTokenMs: summary(inferenceTimings.map((entry) => entry.firstTokenMs)),
        firstTokenSamples: inferenceTimings.slice(-20),
        warmups: this.localModels.warmups.slice(-10),
      },
      orchestrator: {
        cliStatusMs: orchestratorMetrics.statusCalls.slice(-10),
        cliDetectMs: orchestratorMetrics.detectCalls.slice(-10),
        premiumCallMs: [...byPurpose.entries()].map(([key, values]) => ({ key, ...summary(values) })),
        // time to first token (Claude: text delta) / first output event (Codex) of premium calls
        firstOutputMs: [...new Set(orchestratorFirstOutputs.map((entry) => entry.orchestrator))].map((orchestrator) => {
          const samples = orchestratorFirstOutputs.filter((entry) => entry.orchestrator === orchestrator)
          return { orchestrator, kind: samples.at(-1)!.kind, ...summary(samples.map((entry) => entry.firstOutputMs)) }
        }),
        firstOutputSamples: orchestratorFirstOutputs.slice(-20),
      },
      queue: [...jobsByType.entries()].map(([type, entry]) => ({ type, waitMs: summary(entry.wait), runMs: summary(entry.run) })),
      validation: [...checks.entries()].map(([kind, values]) => ({ kind, ...summary(values) })),
      caches: {
        repoIndex: { ...index, hitRatio: indexTotal ? Math.round(((index.hits + index.incremental) / indexTotal) * 100) / 100 : null },
        orchestratorStatus: { hits: orchestratorMetrics.statusCacheHits, misses: statusCalls, hitRatio: orchestratorMetrics.statusCacheHits + statusCalls ? Math.round((orchestratorMetrics.statusCacheHits / (orchestratorMetrics.statusCacheHits + statusCalls)) * 100) / 100 : null },
        cliDetection: { hits: orchestratorMetrics.detectCacheHits, misses: detectCalls },
      },
      requests: [...routes.entries()].map(([route, values]) => ({ route, ...summary(values) })).sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0)).slice(0, 25),
      slowOperations: requests.filter((sample) => sample.ms >= 200).slice(-30).reverse(),
    }
  }
}
