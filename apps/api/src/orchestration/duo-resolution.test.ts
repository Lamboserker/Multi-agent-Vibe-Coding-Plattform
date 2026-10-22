import { describe, expect, it, vi } from 'vitest'
import { isDuo, type DuoInfo } from '@multi-ai-coder/engine'
import { OrchestratorService, unusableReason } from './orchestrator.service.js'
import { duoOfLabel, duoReconciledMessage, isOrchestratorOverride, orchestratorLabel, orchestratorLabelName, overrideFromLabel, taskOverride } from './orchestrator-choice.js'

type Status = { installed: boolean; authenticated: boolean; usesApiKeyBilling?: boolean }

const ok: Status = { installed: true, authenticated: true }
const loggedOut: Status = { installed: true, authenticated: false }

/** OrchestratorService with stubbed CLI status and adapters (no process is spawned). */
function service(statuses: Record<string, Status>, settings: Record<string, unknown> = {}, plugin?: { title: string }) {
  const values = { orchestrator: 'claude-code', orchestratorMode: 'single', duoLead: 'claude-code', orchestratorAuthMode: 'subscription', claudeModel: '', codexModel: '', ...settings }
  const plugins = { selectedExtension: vi.fn().mockResolvedValue(plugin ? { plugin: 'p', id: 'x', title: plugin.title } : undefined), invokeExtension: vi.fn() }
  const orchestrators = new OrchestratorService({ get: vi.fn().mockResolvedValue(values) } as never, { publish: vi.fn() } as never, undefined, plugins as never)
  const adapters = new Map<string, object>()
  Object.assign(orchestrators, {
    status: vi.fn(async (id: string) => statuses[id] ?? { installed: false, authenticated: false }),
    adapter: vi.fn(async (id: string) => {
      if (!adapters.has(id)) adapters.set(id, { id, displayName: id === 'codex' ? 'Codex' : 'Claude Code', createDesign: vi.fn(), chat: vi.fn() })
      return adapters.get(id)
    }),
  })
  return orchestrators
}

describe('OrchestratorService.activeWithNotice', () => {
  it('keeps the single mode as before: the selected CLI if usable', async () => {
    expect((await service({ 'claude-code': ok, codex: ok }, { orchestrator: 'codex' }).active())?.id).toBe('codex')
    expect(await service({ codex: loggedOut }, { orchestrator: 'codex' }).active()).toBeUndefined()
    expect(await service({ codex: ok }, { orchestrator: null }).active()).toBeUndefined()
  })

  it('builds a duo with the configured lead when both CLIs are usable (setting or override)', async () => {
    const byMode = await service({ 'claude-code': ok, codex: ok }, { orchestratorMode: 'duo', duoLead: 'codex' }).activeWithNotice()
    expect(isDuo(byMode.adapter)).toBe(true)
    expect(byMode.notice).toBeUndefined()
    expect(byMode.adapter!.id).toBe('codex')
    expect(orchestratorLabel(byMode.adapter!)).toBe('duo:codex+claude-code')
    const byOverride = await service({ 'claude-code': ok, codex: ok }).activeWithNotice('duo')
    expect(isDuo(byOverride.adapter)).toBe(true)
    expect(byOverride.adapter!.displayName).toBe('Claude Code + Codex')
    expect(orchestratorLabel(byOverride.adapter!)).toBe('duo:claude-code+codex')
  })

  it('reuses the duo adapter for the same settings', async () => {
    const orchestrators = service({ 'claude-code': ok, codex: ok }, { orchestratorMode: 'duo' })
    expect(await orchestrators.active()).toBe(await orchestrators.active())
  })

  it('falls back to the usable CLI with a German hint when duo is not possible', async () => {
    const codexMissing = await service({ 'claude-code': ok, codex: loggedOut }, { orchestratorMode: 'duo' }).activeWithNotice()
    expect(codexMissing.adapter?.id).toBe('claude-code')
    expect(isDuo(codexMissing.adapter)).toBe(false)
    expect(codexMissing.notice).toBe('Duo-Modus nicht möglich: Codex ist nicht angemeldet – Claude Code arbeitet allein.')
    const leadMissing = await service({ codex: ok }).activeWithNotice('duo')
    expect(leadMissing.adapter?.id).toBe('codex')
    expect(leadMissing.notice).toBe('Duo-Modus nicht möglich: Claude Code ist nicht installiert – Codex arbeitet allein.')
    const apiKey = await service({ 'claude-code': ok, codex: { ...ok, usesApiKeyBilling: true } }).activeWithNotice('duo')
    expect(apiKey.adapter?.id).toBe('claude-code')
    expect(apiKey.notice).toContain('Codex würde per API-Key abrechnen')
    const none = await service({}).activeWithNotice('duo')
    expect(none.adapter).toBeUndefined()
    expect(none.notice).toContain('Duo-Modus nicht möglich')
  })

  it('an override forces one CLI, also against the duo setting', async () => {
    const forced = await service({ 'claude-code': ok, codex: ok }, { orchestratorMode: 'duo', orchestrator: 'claude-code' }).activeWithNotice('codex')
    expect(forced.adapter?.id).toBe('codex')
    expect(isDuo(forced.adapter)).toBe(false)
    expect(forced.notice).toBeUndefined()
    // the chosen CLI is not signed in: no silent switch to the other CLI, the chat says so
    const loggedOutChoice = await service({ 'claude-code': ok, codex: loggedOut }).activeWithNotice('codex')
    expect(loggedOutChoice.adapter).toBeUndefined()
    expect(loggedOutChoice.notice).toBe('Codex ist nicht angemeldet – bitte anmelden oder im Composer einen anderen Orchestrator wählen.')
    const missing = await service({ codex: ok }).activeWithNotice('claude-code')
    expect(missing.adapter).toBeUndefined()
    expect(missing.notice).toBe('Claude Code ist nicht installiert – bitte installieren oder im Composer einen anderen Orchestrator wählen.')
  })

  it('a selected plugin orchestrator wins over duo mode and the override', async () => {
    const resolved = await service({ 'claude-code': ok, codex: ok }, { orchestratorMode: 'duo' }, { title: 'Mein Plugin' }).activeWithNotice()
    expect(isDuo(resolved.adapter)).toBe(false)
    expect(resolved.adapter?.displayName).toBe('Mein Plugin')
    expect(resolved.notice).toContain('Plugin-Orchestrator „Mein Plugin“')
    const forced = await service({ 'claude-code': ok, codex: ok }, {}, { title: 'Mein Plugin' }).activeWithNotice('duo')
    expect(forced.adapter?.displayName).toBe('Mein Plugin')
  })
})

describe('OrchestratorService.designer in duo mode', () => {
  it('designs with both CLIs in duo mode and with the chosen CLI on an override', async () => {
    const duo = await service({ 'claude-code': ok, codex: ok }, { orchestratorMode: 'duo' }).designer()
    expect(isDuo(duo)).toBe(true)
    expect(typeof duo?.createDesign).toBe('function')
    expect((await service({ 'claude-code': ok, codex: ok }).designer('codex'))?.id).toBe('codex')
    // without an override the single mode keeps preferring Claude Code
    expect((await service({ 'claude-code': ok, codex: ok }, { orchestrator: 'codex' }).designer())?.id).toBe('claude-code')
  })

  it('falls back to one designer with the duo hint', async () => {
    const resolved = await service({ 'claude-code': loggedOut, codex: ok }).designerWithNotice('duo')
    expect(resolved.adapter?.id).toBe('codex')
    expect(resolved.notice).toBe('Duo-Modus nicht möglich: Claude Code ist nicht angemeldet – Codex arbeitet allein.')
  })

  it('does not switch an explicit single choice to the other designer', async () => {
    const resolved = await service({ 'claude-code': loggedOut, codex: ok }).designerWithNotice('claude-code')
    expect(resolved.adapter).toBeUndefined()
    expect(resolved.notice).toBe('Claude Code ist nicht angemeldet – bitte anmelden oder im Composer einen anderen Orchestrator wählen.')
  })
})

describe('OrchestratorService.overview', () => {
  it('reports mode, lead and whether duo is possible', async () => {
    const orchestrators = service({ 'claude-code': ok, codex: loggedOut }, { orchestratorMode: 'duo', duoLead: 'codex' })
    Object.assign(orchestrators, { detect: vi.fn().mockResolvedValue({ installed: true }) })
    const overview = await orchestrators.overview()
    expect(overview).toMatchObject({ mode: 'duo', duoLead: 'codex', usable: ['claude-code'], duo: { available: false } })
    expect(overview.duo.reason).toBe('Duo braucht beide CLIs: Codex ist nicht angemeldet.')
    const both = service({ 'claude-code': ok, codex: ok })
    Object.assign(both, { detect: vi.fn().mockResolvedValue({ installed: true }) })
    expect((await both.overview()).duo).toEqual({ available: true })
  })
})

describe('orchestrator choice helpers', () => {
  it('labels and parses duo runs', () => {
    expect(duoOfLabel('duo:claude-code+codex')).toEqual({ lead: 'claude-code', partner: 'codex' })
    expect(duoOfLabel('duo:codex+codex')).toBeUndefined()
    expect(duoOfLabel('codex')).toBeUndefined()
    expect(orchestratorLabelName('duo:codex+claude-code')).toBe('Codex + Claude Code')
    expect(orchestratorLabelName('claude-code')).toBe('Claude Code')
    expect(overrideFromLabel('duo:claude-code+codex')).toBe('duo')
    expect(overrideFromLabel('codex')).toBe('codex')
    expect(overrideFromLabel(null)).toBeUndefined()
    expect(isOrchestratorOverride('duo')).toBe(true)
    expect(isOrchestratorOverride('gpt')).toBe(false)
  })

  it('names the reason a CLI cannot be used', () => {
    expect(unusableReason(ok, 'subscription')).toBeUndefined()
    expect(unusableReason({ ...ok, usesApiKeyBilling: true }, 'api_key')).toBeUndefined()
    expect(unusableReason({ ...ok, usesApiKeyBilling: true }, 'subscription')).toBe('würde per API-Key abrechnen')
    expect(unusableReason(undefined, 'subscription')).toBe('ist nicht erreichbar')
  })

  it("takes the task's choice from its latest user message that names one", async () => {
    const findMany = vi.fn().mockResolvedValue([{ metadata: { source: 'session_chat' } }, { metadata: { orchestrator: 'duo' } }, { metadata: { orchestrator: 'codex' } }])
    expect(await taskOverride({ chatMessage: { findMany } }, 'task-1')).toBe('duo')
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { taskId: 'task-1', role: 'user' }, orderBy: { createdAt: 'desc' } }))
    expect(await taskOverride({ chatMessage: { findMany: vi.fn().mockResolvedValue([{ metadata: { orchestrator: 'nope' } }]) } }, 't')).toBeUndefined()
    expect(await taskOverride({ chatMessage: { findMany: vi.fn().mockRejectedValue(new Error('db')) } }, 't')).toBeUndefined()
  })

  it('writes the duo_reconciled chat message with both proposals and the result', () => {
    const duo: DuoInfo = { phase: 'plan', lead: 'claude-code', partner: 'codex', proposals: [{ provider: 'claude-code', summary: '3 Task(s): A' }, { provider: 'codex', summary: '2 Task(s): B' }], notes: ['T2 von Codex übernommen.'], winner: 'merged' }
    const message = duoReconciledMessage(duo)
    expect(message.metadata).toEqual({ kind: 'duo_reconciled', phase: 'plan', lead: 'claude-code', partner: 'codex', proposals: duo.proposals, notes: duo.notes, winner: 'merged', fallback: null })
    expect(message.content).toContain('**Duo-Abgleich (Plan)** – Claude Code + Codex')
    expect(message.content).toContain('- Codex: 2 Task(s): B')
    expect(message.content).toContain('Ergebnis: beide Vorschläge zusammengeführt.')
    const fallback = duoReconciledMessage({ ...duo, proposals: [duo.proposals[0]!], notes: [], winner: 'claude-code', fallback: 'Codex ist fehlgeschlagen (timeout); es gilt das Ergebnis von Claude Code.' })
    expect(fallback.metadata).toMatchObject({ winner: 'claude-code', fallback: 'Codex ist fehlgeschlagen (timeout); es gilt das Ergebnis von Claude Code.' })
    expect(fallback.content).toContain('Ergebnis: es gilt der Vorschlag von Claude Code.')
    expect(fallback.content).toContain('⚠ Codex ist fehlgeschlagen')
  })
})
