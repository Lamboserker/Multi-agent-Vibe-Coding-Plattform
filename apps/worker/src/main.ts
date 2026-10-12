import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null })

export const agentQueue = new Queue('agent-runs', { connection })

const worker = new Worker(
  'agent-runs',
  async (job) => {
    const { taskId, subtaskId, simulate = true } = job.data as {
      taskId: string
      subtaskId?: string
      simulate?: boolean
    }

    return {
      taskId,
      subtaskId,
      simulate,
      status: 'stubbed',
      message:
        'Worker queue is wired for BullMQ. Real file-changing agent execution is deferred until worktree isolation and file locks are enabled.',
    }
  },
  { connection },
)

worker.on('completed', (job) => {
  console.log(`agent-runs:${job.id} completed`)
})

worker.on('failed', (job, error) => {
  console.error(`agent-runs:${job?.id ?? 'unknown'} failed: ${error.message}`)
})

console.log('Agent worker listening on BullMQ queue "agent-runs".')
