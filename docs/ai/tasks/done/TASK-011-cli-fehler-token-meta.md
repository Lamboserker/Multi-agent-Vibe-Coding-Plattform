---
id: TASK-011
titel: Token-meta bei CLI-Fehlern mit Usage und in Chat-/Merge-Fehlerpfaden buchen
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-20
phase: –
abhaengig: TASK-010
plan: –
---

# TASK-011: Token-meta bei CLI-Fehlern mit Usage und in Chat-/Merge-Fehlerpfaden buchen

## Ziel
TASK-007/010 buchen den Verbrauch verworfener Plan-/Review-/Execute-Ausgaben über `OrchestratorError.details.meta`.
Aus dem TASK-010-Review (F1, F2) bleiben Pfade, in denen ein abgeschlossener Aufruf weiter 0 Tokens bucht:
1. **CLI-Fehler-Subtypen mit Usage (F2):** `packages/engine/src/orchestrator/claude-code.ts:362-368` wirft bei
   `is_error` bzw. Subtyp ≠ `success` (z. B. `error_max_turns`, `error_during_execution`) vor der Usage-Berechnung
   (`:370-379`), obwohl das `result`-Event meist `usage` trägt – betrifft v. a. `createPlan` mit `maxTurns` 8/16.
   Codex analog: `codex.ts:386` (`failure && usage`, `turn.failed` nach `turn.completed`).
2. **Chat-/Merge-catches in der api (F1):** `apps/api/src/sessions/sessions.service.ts:344`,
   `apps/api/src/orchestration/orchestrator.controller.ts:93`, `apps/api/src/execution/execution.service.ts:946` buchen
   im catch ohne Tokens, obwohl `invalid_output` jetzt `details.meta` trägt.
3. **Chat-Resume (F1):** `chat` beider Adapter (`claude-code.ts:237-242`, `codex.ts:236-241`) verwirft bei
   fehlgeschlagenem Resume (auch `invalid_output`) den ersten Aufruf; dessen Verbrauch geht verloren.

## Akzeptanzkriterien
- [x] Beide Adapter berechnen Usage vor der Fehlerklassifizierung und hängen sie, wenn vorhanden, als `details.meta` an den Fehler aus `classifyCliFailure`.
- [x] Die drei api-catches buchen `error.details.meta?.usage` (sonst 0/unmeasured).
- [x] Der Verbrauch eines verworfenen ersten Chat-Aufrufs wird gebucht (Weg wählen und im Log begründen).
- [x] Unit-Tests mit Fake-CLI (`error_max_turns` mit Usage; Codex `turn.failed` nach `turn.completed`) bzw. Mocks, kein Live-Aufruf. engine- und api-Tests, `pnpm typecheck` grün.

## Plan
1. Fehlerpfade in beiden Adaptern und die drei api-catches prüfen (`sucher`).
2. Adapter: Usage vor `is_error`/`failure` berechnen, meta anhängen; Tests.
3. api-catches + Chat-Resume; engine build (Lesson 9), Tests, typecheck.

## Log
- 2026-10-20: Aus dem TASK-010-Review (F1, F2) angelegt.
- 2026-10-20 (Schritt 1, Hauptagent): Fehlerpfade selbst gelesen statt `sucher` – alle Stellen standen mit Zeilen im
  Task-File. Befund: Claude wirft bei `is_error`/Subtyp ≠ `success` vor der Usage-Berechnung; Codex wirft bei
  `failure || !usage` ohne meta; die drei api-catches buchen `model: adapter.id` ohne Tokens; `chat` beider Adapter
  verwirft beim Resume-Fallback den ersten Fehler samt meta.
- 2026-10-20 (Schritt 2, Hauptagent): Engine.
  - `packages/engine/src/orchestrator/types.ts`: neue Helfer `mergeCallMeta(first?, second)` (summiert Tokens, Dauer,
    `apiEquivalentUsd`; `measured` = beide; Session/Billing vom zweiten Aufruf) und `withErrorMeta(error, meta)` (hängt
    meta an einen `OrchestratorError`, mergt mit vorhandener meta, behält den Stack).
  - `claude-code.ts` `callWithPromptDir`: Usage + meta werden vor der Fehlerprüfung berechnet; bei Fehler-Result wird meta
    nur angehängt, wenn das Result ein `usage`-Objekt hat (`hasUsage`) – ein Result ganz ohne `usage` bleibt
    0/unmeasured statt „gemessen 0". (Ein Error-Result mit `usage`-Nullen, z. B. Auth-Fehler, wird jetzt als gemessen 0
    gebucht – inhaltlich korrekt.) Gilt auch
    für den `quota_exhausted`-Zweig. Das `usage`-Event wird weiter nur bei Erfolg emittiert (Live-Anzeige unverändert).
  - `codex.ts` `callOnce`: bei `failure && usage` (turn.completed, dann turn.failed) meta an den klassifizierten Fehler.
  - Chat-Resume (beide Adapter): **Weg: Verbrauch des verworfenen ersten Aufrufs in die meta des Retry summieren**
    (`mergeCallMeta`), scheitert auch der Retry, trägt dessen Fehler die summierte meta (`withErrorMeta`). Begründung:
    keine Änderung der `OrchestratorAdapter`-Schnittstelle, alle Aufrufer (Sessions, Controller, Merge) buchen ohne
    Anpassung korrekt – eine ModelCall-Zeile pro Anfrage mit Gesamtverbrauch. Verworfen: zusätzliches Feld
    `discardedMeta` im Rückgabewert (jeder Aufrufer müsste eine zweite Zeile buchen) und Buchen über ein Event
    (Adapter kennen keine DB, Event-Konsumenten buchen heute nicht).
  - Nicht angefasst: der `model_unavailable`-Fallback in `codex.ts` `callStructured` – ein Modell-Fehler nach
    abgeschlossenem Turn ist praktisch ausgeschlossen.
  - `pnpm --filter @multi-ai-coder/engine build` grün.
- 2026-10-20 (Schritt 3, Hauptagent): api. Neuer Helfer `apps/api/src/orchestration/model-call.ts` `failedCallFields(error,
  fallbackModel)` (model/sessionId/Tokens/measured/apiEquivalentUsd/billing aus `error.details.meta`, sonst 0/unmeasured).
  `billing` bleibt ohne meta `undefined` → Spalten-Default `subscription` wie bisher (recordPlanCall setzt `unknown`,
  bewusst nicht vereinheitlicht, um bestehende Auswertungen nicht zu verschieben). Eingesetzt in
  `sessions.service.ts` (answerJob-catch), `orchestrator.controller.ts` (chat-catch), `execution.service.ts`
  (conflictResolver-catch). api-`tsc --noEmit` grün.
- 2026-10-20 (Schritt 4, `entwickler`): Tests, kein Produktivcode geändert.
  - `adapters.test.ts`: Fake-Modi Claude `max_turns`, `resume_invalid`, `always_invalid`; Codex `failed_after_turn`
    (nur `exec`), `resume_invalid`, `always_invalid`. Tests: error_max_turns mit Usage (1200/150/200, 0.0123 USD),
    Fehler-Result ohne usage → keine meta, Codex turn.failed nach turn.completed (13000/100/4000), Chat-Resume verworfen
    → Summe im Retry (Claude 2400/300/400, Codex 26000/200/8000), Retry scheitert auch → Fehler mit Summen-meta.
  - `types.test.ts`: je 3 Tests `mergeCallMeta`, `withErrorMeta`.
  - `apps/api/src/orchestration/model-call.test.ts` (neu): `failedCallFields` mit/ohne meta, normaler Error, Nicht-Error.
  - `sessions.test.ts`: `makeSessions(jobs, orchestratorStub?)`; neuer Test „books the measured usage of a rejected chat
    answer on the failed model call" (invalid_output mit meta → ModelCall error mit 10/5/2, measured, errorClass).
  - Controller- und Merge-catch haben keinen eigenen Test (keine Testinfrastruktur dafür); sie nutzen denselben Helfer
    wie der getestete Sessions-catch – Beleg per Diff-Review.
  - entwickler: engine 265/265, api 163 passed/8 skipped, `pnpm typecheck` grün. Hauptagent nachgeprüft:
    `vitest run src/orchestrator` (engine) 52/52, `vitest run src/orchestration src/sessions` (api) 18/18.
- 2026-10-20 (Schritt 5, `experte`-Review): alle 4 Kriterien erfüllt, kein Blocker, keine Doppelbuchung (Leser von
  `details.meta`: api `recordPlanCall`, engine execute/review, `failedCallFields` – je einmal; `usage`-Events bucht
  niemand; `discarded` wird vor dem Merge nirgends gebucht). Sieben „kann"-Befunde:
  1 Resume-Tests prüfen sessionId des Retry nicht, 2 `quota_exhausted`-Zweig mit meta ungetestet, 3 Sessions-Test
  erwartet billing = DB-Default → an `entwickler` (Schritt 6). 4 Docstring `withErrorMeta` (Reihenfolge) → Hauptagent
  `types.ts` ergänzt. 5 Log-Formulierung zu `hasUsage` präzisiert (oben). 6 Merge-Erfolgszeile ohne `sessionId` –
  nicht TASK-011, bewusst gelassen. 7 Controller-/Merge-catch ohne eigenen Test – akzeptiert (gleicher Helfer, trivialer
  Diff). Restrisiko: Codex-`model_unavailable`-Fallback verliert die meta eines ersten Versuchs (bewusst ausgenommen).
- 2026-10-20 (Schritt 6, `entwickler`): Review-Befunde 1–3 umgesetzt (nur Tests): Resume-Fakes liefern im Retry
  `sess-2`/`thread-2`, Erfolgs-Tests prüfen `meta.sessionId`; neuer Claude-Modus `quota_usage` + Test „keeps the measured
  usage on a quota_exhausted error"; Sessions-Test mit `billing: 'api_key'`. Hauptagent nachgeprüft: engine build,
  engine komplett 266/266, api komplett 163 passed / 8 skipped, `pnpm typecheck` alle Pakete grün.

## Ergebnis
Ein abgeschlossener, aber fehlgeschlagener Premium-Aufruf bucht jetzt seinen Verbrauch:
- CLI-Fehler mit Usage (Claude `error_max_turns`/`is_error` inkl. `quota_exhausted`, Codex `turn.failed` nach
  `turn.completed`) tragen `details.meta` → Plan (`recordPlanCall`), Review/Execute (`engine/execution.ts`) buchen sie
  ohne weitere Änderung.
- Chat-/Merge-catches der api (`sessions.service.ts`, `orchestrator.controller.ts`, `execution.service.ts`) buchen über
  `failedCallFields` (`apps/api/src/orchestration/model-call.ts`).
- Chat-Resume: verworfener erster Aufruf wird in die meta des Retry summiert (`mergeCallMeta`/`withErrorMeta` in
  `packages/engine/src/orchestrator/types.ts`) – eine ModelCall-Zeile pro Anfrage.
Restrisiko: Codex-`model_unavailable`-Fallback verliert die meta eines ersten Versuchs (praktisch nicht erreichbar).

## Übergabe
Erledigt, **nicht committet** (liegt zusammen mit dem ebenfalls uncommitteten TASK-010 in der Arbeitskopie). Kein
Folgetask zwingend. Optional: Merge-Erfolgszeile (`execution.service.ts` conflictResolver) bucht keine `sessionId` –
uneinheitlich zur Fehlerzeile, harmlos.
