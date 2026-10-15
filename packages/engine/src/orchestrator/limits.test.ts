import { describe, expect, it } from 'vitest'
import { CliOrchestratorBase, orchestratorFirstOutputs } from './cli-base.js'
import { type CallContext } from './types.js'

class LocalFixtureCli extends CliOrchestratorBase {
  protected readonly binaryName = 'fixture'
  protected readonly knownLocations: string[] = []
  protected readonly apiBillingEnvKeys: string[] = []
  constructor() { super({ binaryPath: process.execPath }) }
  run(ctx: CallContext) { return this.runJsonl(['-e', `process.stdout.write(JSON.stringify({type:'sample'}))`], ctx, '', () => this.markFirstOutput(ctx, 'event')) }
}

describe('premium hard limits and first-output semantics (fixture CLI only)', () => {
  it.each([{ maxContextTokens: 4096 }, { maxOutputTokens: 1024 }])('rejects unsupported token limits before model execution', async (limits) => {
    await expect(new LocalFixtureCli().run({ runId: 'blocked', cwd: process.cwd(), limits })).rejects.toMatchObject({ kind: 'resource_limit', retryable: false })
  })
  it('records a final output event without pretending it is a token delta', async () => {
    const result = await new LocalFixtureCli().run({ runId: 'final-json-line', cwd: process.cwd(), timeoutMs: 6000 })
    expect(result.exitCode).toBe(0)
    expect(orchestratorFirstOutputs.at(-1)).toMatchObject({ orchestrator: 'fixture', kind: 'event' })
  })
})
