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

describe('explainApplyRejection', () => {
  it('explains dirty files, a moved branch with missing files, conflicts and old raw messages', async () => {
    const { explainApplyRejection } = await import('./engine-text')
    expect(explainApplyRejection('Uncommitted changes in src/a.ts, src/b.ts would be overwritten. Commit or stash them first, or keep the result as a branch.')).toEqual({ kind: 'dirty', text: 'Deine nicht committeten Änderungen in src/a.ts, src/b.ts würden überschrieben. Committe oder stashe sie zuerst – oder behalte das Ergebnis als Branch.' })
    const moved = explainApplyRejection('"master" moved since the run started (base 8957ffa4, now 9cbcea2e); 1 file(s) the change builds on are missing in the working copy: index.html. Keep the result as a branch or run the task again on the current state.')
    expect(moved.kind).toBe('base_moved')
    expect(moved.text).toBe('Dein Branch hat sich seit dem Start des Laufs geändert (Ausgangsstand 8957ffa4, jetzt 9cbcea2e). 1 Datei(en), auf denen die Änderung aufbaut, fehlen in deiner Arbeitskopie: index.html.')
    expect(explainApplyRejection('The working copy differs from the state the run started from; the change conflicts with the current files (error: patch failed). Keep the result as a branch or run the task again on the current state.').kind).toBe('conflict')
    expect(explainApplyRejection('The patch does not apply to the current files: Falling back to direct application...\nerror: index.html: does not exist in index').kind).toBe('conflict')
  })
})
