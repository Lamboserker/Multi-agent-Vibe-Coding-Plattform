import { describe, expect, it, vi } from 'vitest'
import { OrchestratorService } from './orchestrator.service.js'

type Status = { installed: boolean; authenticated: boolean; usesApiKeyBilling?: boolean }

/** OrchestratorService with stubbed CLI status and adapters (no process is spawned). */
function service(statuses: Record<string, Status>, options: { authMode?: string; orchestrator?: string | null; withDesign?: string[] } = {}) {
  const settings = { get: vi.fn().mockResolvedValue({ orchestrator: options.orchestrator ?? 'codex', orchestratorAuthMode: options.authMode ?? 'subscription', claudeModel: '', codexModel: '' }) }
  const orchestrators = new OrchestratorService(settings as never, { publish: vi.fn() } as never)
  const withDesign = options.withDesign ?? ['claude-code', 'codex']
  Object.assign(orchestrators, {
    status: vi.fn(async (id: string) => statuses[id] ?? { installed: false, authenticated: false }),
    adapter: vi.fn(async (id: string) => ({ id, displayName: id, ...(withDesign.includes(id) ? { createDesign: vi.fn() } : {}) })),
  })
  return orchestrators
}

const ok: Status = { installed: true, authenticated: true }

describe('OrchestratorService.designer', () => {
  it('prefers Claude Code regardless of the selected orchestrator', async () => {
    expect((await service({ 'claude-code': ok, codex: ok }, { orchestrator: 'codex' }).designer())?.id).toBe('claude-code')
    expect((await service({ 'claude-code': ok, codex: ok }, { orchestrator: null }).designer())?.id).toBe('claude-code')
  })

  it('falls back to Codex when Claude Code is missing or logged out', async () => {
    expect((await service({ 'claude-code': { installed: true, authenticated: false }, codex: ok }).designer())?.id).toBe('codex')
    expect((await service({ codex: ok }).designer())?.id).toBe('codex')
  })

  it('applies the API-key billing rule of active()', async () => {
    const apiKey = { ...ok, usesApiKeyBilling: true }
    expect((await service({ 'claude-code': apiKey, codex: ok }).designer())?.id).toBe('codex')
    expect((await service({ 'claude-code': apiKey }, { authMode: 'api_key' }).designer())?.id).toBe('claude-code')
    expect(await service({ 'claude-code': apiKey }).designer()).toBeUndefined()
  })

  it('only offers adapters that implement createDesign', async () => {
    expect((await service({ 'claude-code': ok, codex: ok }, { withDesign: ['codex'] }).designer())?.id).toBe('codex')
    expect(await service({ 'claude-code': ok }, { withDesign: [] }).designer()).toBeUndefined()
  })
})
