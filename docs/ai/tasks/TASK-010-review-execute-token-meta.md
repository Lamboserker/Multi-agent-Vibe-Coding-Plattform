---
id: TASK-010
titel: Token-meta bei verworfenen Review-/Execute-Ergebnissen erhalten
status: offen   # offen | in-arbeit | blockiert | done
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
- [ ] `reviewResult` (und `executeComplexTask`, falls dort normalisiert wird) beider Adapter hängen `call.meta` an einen OrchestratorError aus der Normalisierung.
- [ ] Die Fehlerpfade in `engine/execution.ts` buchen `error.details.meta?.usage`, sonst wie bisher 0/unmeasured.
- [ ] Unit-Tests (Fake-CLI bzw. Mocks), kein Live-Aufruf. engine-Tests und `pnpm typecheck` grün.

## Plan
1. Fehlerpfade in `engine/execution.ts` und die Normalisierung in beiden Adaptern prüfen (`sucher`).
2. `normalizeWithMeta` einsetzen, Buchung anpassen.
3. Tests, engine build, api-Tests, typecheck.

## Log
- 2026-10-20: Aus dem TASK-007-Review (Nit N3) angelegt.

## Ergebnis

## Übergabe
Noch nicht begonnen. Vorlage: TASK-007 (`tasks/done/TASK-007-rueckfrage-token-meta.md`).
Startpunkte: `packages/engine/src/execution.ts` (`reviewResult`, Execute-Pfad). Muster aus TASK-007: Normalisierung in
`normalizeWithMeta(call.meta, …)` kapseln, Aufrufer buchen `error.details.meta`. Nach Engine-Änderungen
`pnpm --filter @multi-ai-coder/engine build` vor api-Typecheck/-Tests (Lesson 9).
