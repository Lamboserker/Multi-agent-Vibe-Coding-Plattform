import 'reflect-metadata'
import path from 'node:path'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { runtimeConfig } from './runtime/runtime-config.js'

/**
 * Local runtime entry point. Started by the Electron shell (desktop mode, random port, per-launch
 * token) or by `pnpm dev:api` (web mode). Binds to 127.0.0.1 only.
 */
async function bootstrap() {
  const config = runtimeConfig() // sets DATABASE_URL before Prisma is loaded

  const { PrismaClient } = await import('@prisma/client')
  const { applyMigrations } = await import('./runtime/migrator.js')
  const migrator = new PrismaClient()
  try {
    const applied = await applyMigrations(migrator, config.migrationsDir, (message) => console.log(`[migrate] ${message}`), {
      databaseFile: config.databaseUrl.replace(/^file:/, ''),
      backupDir: path.join(config.dataDir, 'backups'),
    })
    if (applied.length) console.log(`[migrate] ${applied.length} migration(s) applied.`)
  } finally {
    await migrator.$disconnect()
  }

  const { NestFactory } = await import('@nestjs/core')
  const { AppModule } = await import('./app.module.js')
  const { ExecutionService } = await import('./execution/execution.service.js')
  const { JobQueueService } = await import('./runtime/job-queue.service.js')
  const { SessionsService } = await import('./sessions/sessions.service.js')

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] })
  app.enableShutdownHooks()
  if (!config.desktop) app.enableCors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] })
  app.useBodyParser('json', { limit: '8mb' })

  // Recovery order: runs (interrupted), then jobs (plan/ask jobs report their interruption to the
  // sessions), then sessions (statuses recomputed from what is actually running now).
  const executions = app.get(ExecutionService)
  await executions.recover()
  await app.get(JobQueueService).start()
  await app.get(SessionsService).recover()

  const shutdown = async (signal: string) => {
    console.log(`[runtime] ${signal} received, shutting down gracefully…`)
    executions.markShuttingDown()
    await app.close()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
  // Electron utilityProcess: the shell asks for a graceful stop through the parent port.
  const parentPort = (process as unknown as { parentPort?: { on: (event: string, listener: (message: { data: unknown }) => void) => void; postMessage: (message: unknown) => void } }).parentPort
  parentPort?.on('message', (message) => {
    if ((message.data as { type?: string })?.type === 'shutdown') void shutdown('shell')
  })

  await app.listen(config.port, config.host)
  const address = app.getHttpServer().address() as { port: number }
  console.log(`MAC_RUNTIME_READY port=${address.port}`)
  parentPort?.postMessage({ type: 'ready', port: address.port })
}

bootstrap().catch((error: unknown) => {
  console.error('[runtime] fatal startup error', error)
  process.exit(1)
})
