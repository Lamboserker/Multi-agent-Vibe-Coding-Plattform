import { describe, expect, it } from 'vitest'
import { localizeEngineText, runStatusLabel } from './engine-text'

describe('localizeEngineText', () => {
  it('translates the run summary', () => {
    expect(localizeEngineText('1/1 task(s) integrated; 3 file(s), +5/-5. Validation: typecheck: passed; test: passed (1 passed, 0 failed)')).toBe(
      '1/1 Teilaufgabe(n) integriert; 3 Datei(en), +5/−5. Prüfung: typecheck: bestanden; test: bestanden (1 bestanden, 0 fehlgeschlagen)',
    )
  })

  it('translates review reasons and keeps details', () => {
    expect(localizeEngineText('Low-risk change with passing validation: automated review only.')).toBe('Geringes Risiko und Prüfungen bestanden: automatisches Review genügt.')
    expect(localizeEngineText('Premium review because: large change (512 lines); quality mode.')).toBe('Premium-Review, weil: große Änderung (512 Zeilen); Quality-Modus.')
    expect(localizeEngineText('Premium review required (no passing test run) but no orchestrator is available. Review the diff carefully.')).toBe(
      'Premium-Review nötig (kein erfolgreicher Testlauf), aber kein Orchestrator verfügbar. Bitte den Diff sorgfältig prüfen.',
    )
  })

  it('passes unknown text through and handles empty values', () => {
    expect(localizeEngineText('Something else')).toBe('Something else')
    expect(localizeEngineText(undefined)).toBe('')
  })

  it('labels run states', () => {
    expect(runStatusLabel('awaiting_approval')).toBe('wartet auf Freigabe')
    expect(runStatusLabel('unknown_state')).toBe('unknown_state')
  })
})
