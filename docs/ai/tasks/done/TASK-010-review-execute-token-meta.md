---
id: TASK-010
titel: Token-meta bei verworfenen Review-/Execute-Ergebnissen erhalten
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-20
phase: –
abhaengig: TASK-007
plan: –
---

# TASK-010: Token-meta bei verworfenen Review-/Execute-Ergebnissen erhalten

## Ziel
TASK-007 hat die Lücke für die Planung geschlossen (`normalizeWithMeta`, `OrchestratorError.details.meta`). Dieselbe
Lücke besteht bei Premium-Review und -Ausführung: Ist die Ausgabe unbrauchbar, buchen die Fehlerpfade in
`packages/engine/src/engine/execution.ts` (ca. `:966`, `:1120`) 0 Tokens, unmeasured. `reviewResult` (und ggf.
`executeComplexTask`) in `claude-code.ts`/`codex.ts` nutzen `normalizeWithMeta` noch nicht.

## Akzeptanzkriterien
- [x] `reviewResult` (und `executeComplexTask`, falls dort normalisiert wird) beider Adapter hängen `call.meta` an einen OrchestratorError aus der Normalisierung.
- [x] Die Fehlerpfade in `engine/execution.ts` buchen `error.details.meta?.usage`, sonst wie bisher 0/unmeasured.
- [x] Unit-Tests (Fake-CLI bzw. Mocks), kein Live-Aufruf. engine-Tests und `pnpm typecheck` grün.

## Plan
1. Fehlerpfade in `engine/execution.ts` und die Normalisierung in beiden Adaptern prüfen (`sucher`).
2. `normalizeWithMeta` einsetzen, Buchung anpassen.
3. Tests, engine build, api-Tests, typecheck.

## Log
- 2026-10-20: Aus dem TASK-007-Review (Nit N3) angelegt.
- 2026-10-20 (Schritt 1, Hauptagent, ohne Subagent – vier Fundstellen per grep): Befund
  - `executeComplexTask` normalisiert nicht (liest `summary`/`filesChanged` tolerant) → dort kein `normalizeWithMeta`.
  - Die eigentliche Execute-Lücke liegt tiefer: beide `callStructured`-Pfade werfen „returned no structured output"
    (`invalid_output`) **nach** der Usage-Messung, aber ohne meta – trifft Plan, Review und Execute.
  - `normalizeReview` wirft über `asRecord` `invalid_output`, wenn die Ausgabe kein Objekt ist.
  - Review-Fehlerpfad buchte `purpose: 'review'` auch bei `afterFix` (ok-Pfad: `review_fix`) – mit behoben.
  - `analyzeTask` hat keinen Aufrufer außerhalb der Adapter → bewusst nicht angefasst.
- 2026-10-20 (Schritt 2, Hauptagent): Umsetzung
  - `orchestrator/claude-code.ts:384` und `orchestrator/codex.ts:389`: `meta` vor dem `extractJson`-Fallback gebaut und
    an den `invalid_output`-Fehler gehängt (`details.meta`).
  - `reviewResult` beider Adapter (`claude-code.ts:230`, `codex.ts:229`): `normalizeWithMeta(call.meta, () => normalizeReview(…))`.
  - `engine/execution.ts:962` (Execute-catch): bucht `error.details.meta` (model, sessionId, usage), sonst 0/unmeasured;
    Rückgabe trägt dieselben Tokens (wie der ok-Pfad). `sessionId` der Rückgabe bleibt `undefined` – kein
    Verhaltenswechsel beim Resume nach Hard-Failure.
  - `engine/execution.ts:1123` (Review-catch): bucht `error.details.meta`, `purpose` jetzt `afterFix ? 'review_fix' : 'review'`.
  - Dauer im Fehlerfall bleibt Wall-Clock (`Date.now() - started`) wie bei `recordPlanCall` in der api.
  - `tsc --noEmit` (engine): grün.
- 2026-10-20 (Schritt 3, `entwickler`, vom Hauptagent per Diff geprüft): Tests
  - `orchestrator/adapters.test.ts`: `FAKE_CLAUDE` bekommt `FAKE_MODE='no_structured'` (nur `result`-Event mit Usage,
    ohne `structured_output`/StructuredOutput – `FAKE_STRUCTURED='null'` löste den Pfad nicht aus, da `null` ≠ `undefined`).
    Je Adapter zwei Tests: Execute ohne strukturierte Ausgabe und Review mit `'[]'` → `invalid_output` mit gemessener
    `details.meta.usage` (Claude ab `:162`, Codex ab `:269`).
  - `engine/execution.test.ts` ab `:626`: Execute-Fehler mit meta bucht 900/40 measured + model/sessionId; ohne meta
    0/0 unmeasured (Regression); Review-Fehler mit meta bucht 700/30 measured.
  - Hauptagent selbst: engine `test` 27 Dateien / 251 Tests grün; engine `build` ok; `pnpm typecheck` alle Pakete grün;
    api `test` 22 Dateien grün (2 skipped), 157 Tests grün / 8 skipped.
- 2026-10-20 (Schritt 4, Abschluss-Review `experte`): 0 Blocker, 0 Major, alle drei Kriterien erfüllt.
  - Doppelbuchung geprüft, keine: Rückgabe-Tokens des Execute-Pfads gehen nur in `finishAttempt` (`agentRun`), die
    Run-Statistik (`usageSummary`) liest nur `ModelCall`, wie im ok-Pfad.
  - F3 (Nit, umgesetzt vom Hauptagent): neuer Test `execution.test.ts` „rejected review after a fix round is booked as
    review_fix" – erster Review `request_changes` mit Blocker, Fix-Runde, zweiter Review wirft mit meta → `review_fix`,
    600/20 measured. Erster Versuch rot (nur 1 Review): der Fake schrieb in der Fix-Runde denselben Inhalt, ohne Änderung
    gibt es kein Re-Review – Fake schreibt im 2. Aufruf jetzt geänderten Inhalt. (Der bestehende Fix-Round-Test prüft nur
    `reviews >= 1` und deckt das Re-Review daher nicht ab.)
  - F4 (Nit, umgesetzt): Adapter-Review-Tests prüfen zusätzlich `error.message === 'Review is not an object.'` – belegt,
    dass der Fehler aus `normalizeWithMeta` und nicht aus `callStructured` kommt.
  - F1/F2 (Minor, außerhalb des Scopes) → Folgetask TASK-011: Chat-/Merge-catches in der api buchen kein meta, Chat-Resume
    verwirft den ersten Verbrauch; CLI-Fehler-Subtypen (`error_max_turns`, `turn.failed` nach `turn.completed`) werfen
    vor der Usage-Berechnung.
  - Nachlauf Hauptagent: engine `test` 27 Dateien / 252 Tests grün; `pnpm typecheck` alle Pakete grün.

## Ergebnis
Ein abgeschlossener Premium-Aufruf, dessen Ausgabe verworfen wird, behält sein `CallMeta` jetzt auch bei Review und
Ausführung: `reviewResult` beider Adapter kapselt `normalizeReview` in `normalizeWithMeta`, und beide `callStructured`-
Pfade hängen `meta` an „returned no structured output" (gilt damit für alle Aufrufarten). `engine/execution.ts` bucht
im Execute- und Review-Fehlerpfad Modell, Session und gemessene Usage aus `error.details.meta` (sonst 0/unmeasured);
der Review-Fehlerpfad bucht korrekt `review_fix`. Belegt durch Fake-CLI-Tests beider Adapter und Engine-Tests mit
Mock-Orchestrator – ohne Live-Aufruf.

## Übergabe
Erledigt (2026-10-20), nicht committet. Folgetask TASK-011 (`tasks/TASK-011-cli-fehler-token-meta.md`): restliche
Pfade ohne Token-Buchung (Chat/Merge in der api, CLI-Fehler-Subtypen mit Usage).
