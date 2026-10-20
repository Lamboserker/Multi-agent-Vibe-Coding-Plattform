---
id: TASK-007
titel: Token-meta bei Rückfrage-Aufrufen erhalten
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-20
phase: –
abhaengig: TASK-005
plan: –
---

# TASK-007: Token-meta bei Rückfrage-Aufrufen erhalten

## Ziel
Wenn der Planner 0 Tasks mit Rückfragen liefert, wirft `normalizePlan` im Adapter (`needs_clarification`), bevor
`call.meta` zurückgegeben wird (`packages/engine/src/orchestrator/claude-code.ts:224`, `codex.ts:223`). Der `ModelCall`
wird dann mit 0 Tokens gespeichert, obwohl der Aufruf das Kontingent verbraucht hat. Tokens und Kosten müssen auch in
diesem Fall gebucht werden.

## Akzeptanzkriterien
- [x] Bei `needs_clarification` landen `inputTokens`/`outputTokens` (und `tokensMeasured`) des Planungsaufrufs im `ModelCall`.
- [x] Gilt für beide Adapter (Codex, Claude Code). Kein zweiter Premium-Aufruf und kein Fallback (ADR-002 bleibt).
- [x] Unit-Tests in engine (Adapter/Fehler trägt `meta`) und api (ModelCall-Buchung) – ohne Live-Aufruf.
- [x] `pnpm typecheck`, engine- und api-Tests grün.

## Plan
1. Mit `sucher` ermitteln, wo der Fehler im api ankommt und der ModelCall geschrieben wird (`execution.service.ts`, Planungspfad).
2. Fehler um `meta` erweitern (z. B. Feld am Clarification-Error) oder `meta` vor dem Normalisieren sichern – Designentscheidung im Log.
3. Tests, engine build, api-Tests.

## Log
- 2026-10-20: Aus TASK-005-Restpunkt (1) angelegt (Nutzerentscheidung in TASK-006: eigene Tasks).
- 2026-10-20 (Schritt 1, Hauptagent, ohne `sucher` – Pfade waren aus der Übergabe bekannt): Einziger Aufrufer von
  `createPlan` mit ModelCall-Buchung ist `execution.service.ts:269` → Fehlerpfad `:302`. Plugin-Orchestratoren
  (`orchestrator.service.ts:103`) liefern ohnehin `measured: false`/0 Tokens → nicht betroffen.
- 2026-10-20 (Schritt 2, Hauptagent): **Entscheidung:** `OrchestratorError.details.meta?: CallMeta` plus Helfer
  `normalizeWithMeta(meta, fn)` (`packages/engine/src/orchestrator/types.ts`), der einen OrchestratorError aus `fn` mit
  dem `meta` des Aufrufs neu wirft (vorhandenes `meta` bleibt). Eingesetzt in `createPlan` beider Adapter
  (`claude-code.ts:225`, `codex.ts:224`). api bucht `error.details.meta` im Fehlerpfad (`execution.service.ts:302f`).
  Begründung: generischer Weg über das bestehende `details`-Objekt statt eigener Error-Klasse – deckt auch
  `invalid_output` aus `normalizePlan` ab (gleiche Lücke), `status: 'error'` und `errorClass` bleiben unverändert.
  Verworfen: `meta` vor dem Normalisieren im Adapter zurückgeben (`createPlan`-Rückgabetyp müsste für den Fehlerfall
  ein Union werden; alle Aufrufer betroffen). Kein zweiter Aufruf, kein Fallback (ADR-002 unberührt).
- 2026-10-20 (Schritt 3, `entwickler`): Tests ergänzt – `adapters.test.ts` (je ein needs_clarification-Test für Claude
  Code und Codex mit Fake-CLI: `questions` + `details.meta.usage` gemessen), neu `types.test.ts` (4 Tests
  `normalizeWithMeta`), `planning-progress.test.ts` (ModelCall mit Tokens aus `meta`; ohne `meta` 0/unmeasured; kein
  Fallback, `createPlan` 1×). Hauptagent: Assertion „vorhandenes meta bleibt" von `toThrow(original)` (prüft nur die
  Message) auf Instanz- + `details.meta`-Gleichheit verschärft. Ergebnisse: entwickler – engine 244/244, engine build ok,
  api-Suite 151 passed/8 skipped, `pnpm typecheck` grün; Hauptagent nachgeprüft – engine (types/adapters/schemas) 24/24,
  api `planning-progress` 14/14.
- 2026-10-20 (Schritt 4, `experte`-Review): alle Kriterien PASS, keine Blocker/Should-fix. Nits umgesetzt (Hauptagent):
  N1 Stack des Originalfehlers in `normalizeWithMeta` übernehmen (`types.ts:34ff`, Test `types.test.ts` prüft
  `stack`); N2 api-Test „books the tokens of an invalid plan and still falls back" (`planning-progress.test.ts`).
  N3 (Review/Execute-Fehlerpfade buchen ebenfalls 0 Tokens) → Folgetask TASK-010 (außerhalb des Scopes).
  Verworfen für N1: `meta` in-place an `details` hängen – würde ein readonly deklariertes Objekt mutieren.
- 2026-10-20 (Abschluss, Hauptagent): engine `vitest run src/orchestrator` 35/35, engine build ok, api
  `planning-progress` 15/15, `pnpm typecheck` alle Pakete grün.

## Ergebnis
`OrchestratorError.details.meta` + `normalizeWithMeta` (engine `types.ts`) erhalten das `CallMeta` eines abgeschlossenen
Aufrufs, wenn `normalizePlan` ihn verwirft. Beide Adapter nutzen es in `createPlan`; die api bucht es im Fehlerpfad
(`execution.service.ts:302f`). Damit erscheinen Tokens/Kosten bei `needs_clarification` und `invalid_output` im
`ModelCall`. Belegt durch Fake-CLI-Tests beider Adapter, `types.test.ts` und `planning-progress.test.ts` – ohne
Live-Aufruf. ADR-002 unverändert (1× `createPlan`, kein Fallback bei Rückfragen).

## Übergabe
Erledigt, committet als `b9a2854` (2026-10-20). Folgetask TASK-010: dieselbe Lücke bei Review/Execute (`engine/execution.ts:966`, `:1120`
buchen im Fehlerfall 0 Tokens; `reviewResult` nutzt `normalizeWithMeta` noch nicht).
