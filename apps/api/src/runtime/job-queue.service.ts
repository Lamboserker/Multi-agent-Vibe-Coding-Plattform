import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import type { Job } from '@prisma/client'
import { PrismaService } from '../common/prisma.service.js'
import { asJson } from '../common/json.js'
import { EventBusService } from './event-bus.service.js'

export interface JobContext {
  job: Job
  signal: AbortSignal
  progress: (data: Record<string, unknown>) => void
}

export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<unknown>

interface JobTypeOptions {
  /** Maximum concurrently running jobs of this type. */
  concurrency: number
  /** On restart after a crash: requeue ("resume") or mark failed ("interrupt"). */
  onRecover: 'requeue' | 'interrupt'
}

/**
 * Persistent local job queue on SQLite (replaces Redis/BullMQ for the desktop runtime).
 * Jobs survive restarts; jobs found "running" after a crash are recovered per job type.
 */
@Injectable()
export class JobQueueService implements OnApplicationShutdown {
  private readonly logger = new Logger('JobQueue')
  private readonly handlers = new Map<string, { handler: JobHandler; options: JobTypeOptions }>()
  private readonly running = new Map<string, { type: string; controller: AbortController; promise: Promise<void> }>()
  /** Last progress report per active job, so a UI that (re)connects sees the current state immediately. */
  private readonly lastProgress = new Map<string, Record<string, unknown>>()
  private readonly recoveredListeners: Array<(job: Job, outcome: 'requeued' | 'interrupted') => Promise<void> | void> = []
  private timer?: NodeJS.Timeout
  private stopping = false
  private ticking = false
  private tickAgain = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
  ) {}

  register(type: string, handler: JobHandler, options: Partial<JobTypeOptions> = {}) {
    this.handlers.set(type, { handler, options: { concurrency: options.concurrency ?? 1, onRecover: options.onRecover ?? 'interrupt' } })
  }

  async start() {
    await this.recover()
    this.timer = setInterval(() => void this.tick(), 750)
    void this.tick()
  }

  async enqueue(type: string, payload: Record<string, unknown>, options: { priority?: number; maxAttempts?: number; dedupeKey?: string } = {}): Promise<Job> {
    if (options.dedupeKey) {
      // Any active job with the same key (not only the newest one of the type) makes the request a no-op.
      const active = await this.prisma.job.findMany({ where: { type, status: { in: ['queued', 'running'] } }, orderBy: { createdAt: 'desc' } })
      const existing = active.find((job) => (job.payload as Record<string, unknown>).dedupeKey === options.dedupeKey)
      if (existing) return existing
    }
    // runAfter comes from the same clock the tick compares against (the database default can round up
    // into the next millisecond, which made a new job wait for the next interval tick).
    const job = await this.prisma.job.create({
      data: { type, payload: asJson({ ...payload, dedupeKey: options.dedupeKey }), priority: options.priority ?? 0, maxAttempts: options.maxAttempts ?? 1, runAfter: new Date(Date.now() - 1) },
    })
    this.events.publish('jobs', 'queued', { jobId: job.id, type })
    void this.tick()
    return job
  }

  async cancel(jobId: string) {
    const active = this.running.get(jobId)
    if (active) active.controller.abort()
    await this.prisma.job.updateMany({ where: { id: jobId, status: 'queued' }, data: { status: 'cancelled' } })
  }

  isRunning(jobId: string) {
    return this.running.has(jobId)
  }

  /** Called for every job that was found running after a restart (services clean up their own state). */
  onRecovered(listener: (job: Job, outcome: 'requeued' | 'interrupted') => Promise<void> | void) {
    this.recoveredListeners.push(listener)
  }

  async list(limit = 50, filter: { type?: string; active?: boolean } = {}) {
    const jobs = await this.prisma.job.findMany({
      where: { ...(filter.type ? { type: filter.type } : {}), ...(filter.active ? { status: { in: ['queued', 'running'] } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return jobs.map((job) => ({ ...job, progress: this.lastProgress.get(job.id) ?? null }))
  }

  /** Queued or running jobs of a type whose payload matches (e.g. the plan job of a task). */
  async activeFor(type: string, match: (payload: Record<string, unknown>) => boolean) {
    const jobs = await this.prisma.job.findMany({ where: { type, status: { in: ['queued', 'running'] } } })
    return jobs.filter((job) => match(job.payload as Record<string, unknown>))
  }

  private async recover() {
    const stale = await this.prisma.job.findMany({ where: { status: 'running' } })
    for (const job of stale) {
      const options = this.handlers.get(job.type)?.options
      const requeue = options?.onRecover === 'requeue' && job.attempts < job.maxAttempts + 1
      await this.prisma.job.update({
        where: { id: job.id },
        data: requeue ? { status: 'queued', lockedAt: null } : { status: 'failed', lastError: 'Interrupted: the application stopped while this job was running.', lockedAt: null },
      })
      this.logger.warn(`Recovered job ${job.id} (${job.type}) → ${requeue ? 'requeued' : 'interrupted'}`)
      for (const listener of this.recoveredListeners) {
        try {
          await listener(job, requeue ? 'requeued' : 'interrupted')
        } catch (error) {
          this.logger.error(`Recovery hook for job ${job.id} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.stopping) return
    if (this.ticking) {
      // A job enqueued while a tick is scanning would otherwise wait for the next interval.
      this.tickAgain = true
      return
    }
    this.ticking = true
    this.tickAgain = false
    try {
      for (const [type, { options }] of this.handlers) {
        const active = [...this.running.values()].filter((entry) => entry.type === type).length
        if (active >= options.concurrency) continue
        const jobs = await this.prisma.job.findMany({
          where: { type, status: 'queued', runAfter: { lte: new Date() } },
          orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
          take: options.concurrency - active,
        })
        for (const job of jobs) {
          // Atomic claim: only one tick can move the job from queued to running.
          const claimed = await this.prisma.job.updateMany({ where: { id: job.id, status: 'queued' }, data: { status: 'running', lockedAt: new Date(), attempts: { increment: 1 } } })
          if (claimed.count !== 1) continue
          this.execute({ ...job, attempts: job.attempts + 1, status: 'running' })
        }
      }
    } catch (error) {
      // The database may be temporarily unavailable (locked, disk full); the next tick retries.
      this.logger.error(`Queue tick failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.ticking = false
    }
    if (this.tickAgain) await this.tick()
  }

  private execute(job: Job) {
    const registration = this.handlers.get(job.type)
    if (!registration) return
    const controller = new AbortController()
    const promise = (async () => {
      this.events.publish('jobs', 'started', { jobId: job.id, type: job.type })
      try {
        await registration.handler(job.payload as Record<string, unknown>, {
          job,
          signal: controller.signal,
          progress: (data) => {
            this.lastProgress.set(job.id, data)
            this.events.publish('jobs', 'progress', { jobId: job.id, type: job.type, ...data })
          },
        })
        await this.prisma.job.update({ where: { id: job.id }, data: { status: controller.signal.aborted ? 'cancelled' : 'done', lockedAt: null } })
        this.events.publish('jobs', 'finished', { jobId: job.id, type: job.type, status: controller.signal.aborted ? 'cancelled' : 'done' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const retry = !controller.signal.aborted && job.attempts < job.maxAttempts
        await this.prisma.job
          .update({
            where: { id: job.id },
            data: retry
              ? { status: 'queued', lastError: message, lockedAt: null, runAfter: new Date(Date.now() + 5000 * job.attempts) }
              : { status: controller.signal.aborted ? 'cancelled' : 'failed', lastError: message, lockedAt: null },
          })
          .catch(() => undefined)
        this.events.publish('jobs', 'failed', { jobId: job.id, type: job.type, error: message, retry })
        this.logger.error(`Job ${job.id} (${job.type}) failed: ${message}`)
      } finally {
        this.running.delete(job.id)
        this.lastProgress.delete(job.id)
        void this.tick()
      }
    })()
    this.running.set(job.id, { type: job.type, controller, promise })
  }

  /** Graceful shutdown: stop claiming jobs, abort running ones and wait briefly for them to persist state. */
  async onApplicationShutdown() {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    for (const entry of this.running.values()) entry.controller.abort()
    await Promise.race([Promise.allSettled([...this.running.values()].map((entry) => entry.promise)), new Promise((resolve) => setTimeout(resolve, 8000))])
  }
}
