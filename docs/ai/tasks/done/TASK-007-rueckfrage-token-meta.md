---
id: TASK-007
titel: Token-meta bei Rückfrage-Aufrufen erhalten
status: offen   # offen | in-arbeit | blockiert | done
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
- [ ] Bei `needs_clarification` landen `inputTokens`/`outputTokens` (und `tokensMeasured`) des Planungsaufrufs im `ModelCall`.
- [ ] Gilt für beide Adapter (Codex, Claude Code). Kein zweiter Premium-Aufruf und kein Fallback (ADR-002 bleibt).
- [ ] Unit-Tests in engine (Adapter/Fehler trägt `meta`) und api (ModelCall-Buchung) – ohne Live-Aufruf.
- [ ] `pnpm typecheck`, engine- und api-Tests grün.

## Plan
1. Mit `sucher` ermitteln, wo der Fehler im api ankommt und der ModelCall geschrieben wird (`execution.service.ts`, Planungspfad).
2. Fehler um `meta` erweitern (z. B. Feld am Clarification-Error) oder `meta` vor dem Normalisieren sichern – Designentscheidung im Log.
3. Tests, engine build, api-Tests.

## Log
- 2026-10-20: Aus TASK-005-Restpunkt (1) angelegt (Nutzerentscheidung in TASK-006: eigene Tasks).

## Ergebnis

## Übergabe
Noch nicht begonnen. Startpunkt: `claude-code.ts:224`, `codex.ts:223`. api-Seite: Im Fehlerpfad bucht
`execution.service.ts` (ca. Z. 302) `recordPlanCall(…, 'error', …, undefined, kind)` mit `meta = undefined`. Dort muss
das `meta` aus dem Fehler ankommen (Hinweis aus dem TASK-006-Review).
