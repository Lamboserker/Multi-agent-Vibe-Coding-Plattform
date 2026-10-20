---
id: TASK-009
titel: Test für den Chat-Antwortweg bei Rückfragen
status: offen   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-20
phase: –
abhaengig: TASK-005
plan: –
---

# TASK-009: Test für den Chat-Antwortweg bei Rückfragen

## Ziel
Antwortet der Nutzer im Chat auf Rückfragen des Planners (statt über den Leitstand-Button), baut
`sessions.service.ts:264` den Folgeauftrag über `executions.clarificationAnswer()`. Dieser Weg hat keinen Test.

## Akzeptanzkriterien
- [ ] Test in `apps/api/src/sessions/sessions.test.ts`: Task in `plan_clarification` + Chat-Nachricht → `clarificationAnswer`
      wird mit Task-ID und Inhalt aufgerufen. Das Ergebnis (Fragen + Antworten) geht an die Neuplanung, nicht `Follow-up: …`.
- [ ] Gegenprobe: ohne Rückfrage-Zustand bleibt der `Follow-up:`-Pfad unverändert.
- [ ] api-Tests grün (`pnpm --filter @multi-ai-coder/api test`), kein Live-Aufruf.

## Plan
1. Bestehende Mocks in `sessions.test.ts` sichten, Test ergänzen (`entwickler`).
2. Falls der Test einen Fehler aufdeckt: Ursache im Log, Fix mit eigenem Test.

## Log
- 2026-10-20: Aus TASK-005-Restpunkt (3) angelegt (Nutzerentscheidung in TASK-006: eigene Tasks).

## Ergebnis

## Übergabe
Noch nicht begonnen. Startpunkt: `apps/api/src/sessions/sessions.service.ts:264`.
