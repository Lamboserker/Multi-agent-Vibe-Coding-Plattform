---
id: TASK-009
titel: Test für den Chat-Antwortweg bei Rückfragen
status: done   # offen | in-arbeit | blockiert | done
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
- [x] Test in `apps/api/src/sessions/sessions.test.ts`: Task in `plan_clarification` + Chat-Nachricht → `clarificationAnswer`
      wird mit Task-ID und Inhalt aufgerufen. Das Ergebnis (Fragen + Antworten) geht an die Neuplanung, nicht `Follow-up: …`.
- [x] Gegenprobe: ohne Rückfrage-Zustand bleibt der `Follow-up:`-Pfad unverändert.
- [x] api-Tests grün (`pnpm --filter @multi-ai-coder/api test`), kein Live-Aufruf.

## Plan
1. Bestehende Mocks in `sessions.test.ts` sichten, Test ergänzen (`entwickler`).
2. Falls der Test einen Fehler aufdeckt: Ursache im Log, Fix mit eigenem Test.

## Log
- 2026-10-20: Aus TASK-005-Restpunkt (3) angelegt (Nutzerentscheidung in TASK-006: eigene Tasks).
- 2026-10-20 (`entwickler`): Tests in `apps/api/src/sessions/sessions.test.ts` ergänzt.
  - `makeSessions()` (`:35-57`): Stub `executions.clarificationAnswer` schneidet Aufrufe mit (`clarificationCalls`) und
    delegiert an die echte `ExecutionService.prototype.clarificationAnswer` mit `{ prisma }` – so wird auch die Suche nach
    der `plan_questions`-Nachricht mitgeprüft statt nur ein Mock-String. `requestPlan` protokolliert `planRequests`.
    Verworfen: reiner Mock mit festem Rückgabewert (hätte das Zusammenspiel Service ↔ `clarificationAnswer` nicht belegt).
  - Helfer `taskInState` (`:126`), Tests: Rückfrage-Antwort → Fragen + Antwort im `userPrompt`, kein `Follow-up:`,
    `requestPlan` mit `feedback === undefined` (keine doppelte Antwort) (`:134`); Gegenprobe `awaiting_plan_approval` →
    `Follow-up:` unverändert, `clarificationAnswer` nicht aufgerufen (`:151`); Randfall `plan_clarification` ohne
    gespeicherte Fragen → Rückfall auf `Follow-up:` (heute `:188`).
  - Kein Produktionsfehler gefunden; Produktionscode unverändert.
  - Hauptagent geprüft: Diff gesichtet; `vitest run src/sessions/sessions.test.ts` 10/10 grün;
    `pnpm --filter @multi-ai-coder/api test` 22 Dateien / 155 Tests grün (2 Dateien / 8 Tests skipped wie bisher);
    `pnpm typecheck` grün. Kein Live-Aufruf.
- 2026-10-20 (`experte`, Abschluss-Review): alle 3 Kriterien erfüllt; gedankliche Mutationen (`clarifying` ignoriert,
  Antwort zusätzlich als `feedback`, Block + `Follow-up:` doppelt, neuer Task statt Verfeinerung) würden rot. Kein Mangel.
  Lücke (mittel): `|| clarifying` in `sessions.service.ts:263` (Rückfrage bei älterer Ausführung) ungetestet – ohne die
  Bedingung würde eine Chat-Antwort still einen neuen Task anlegen und die Fragen verlieren. Nice-to-have: Gegenprobe mit
  veralteter `plan_questions`-Nachricht. Beobachtung (nicht TASK-009): sporadische Teardown-Warnung `Session refresh
  failed … Response from the Engine was empty` (nicht abgewartetes `refresh` nach `$disconnect`), Test bleibt grün.
- 2026-10-20 (Hauptagent): Review-Punkte umgesetzt in `sessions.test.ts`:
  - Gegenprobe (`:151`) legt jetzt eine veraltete `plan_questions`-Nachricht an; `userPrompt` muss trotzdem `Follow-up:` sein.
  - Neu `:164`: `plan_clarification` + `ExecutionRun` (status `failed`) → derselbe Task, Fragen + Antwort im `userPrompt`.
  - Neu `:177`: `awaiting_plan_approval` + `ExecutionRun` → neuer Task (count 2), alter `userPrompt` unverändert.
  - Mutationsprobe: `(!execution || clarifying)` per sed auf `(!execution)` → genau `:164` rot (1 failed / 11 passed);
    zurückgesetzt, `git diff` auf den Service leer.
  - `vitest run src/sessions/sessions.test.ts` 12/12 grün; `pnpm --filter @multi-ai-coder/api test` 22 Dateien / 157 Tests
    grün (2 / 8 skipped); api-Typecheck grün (Root-`pnpm typecheck` vorher grün, seither nur Testdatei geändert).

## Ergebnis
Der Chat-Antwortweg auf Planner-Rückfragen ist durch 5 neue Tests in `apps/api/src/sessions/sessions.test.ts:126-196`
abgesichert. Geprüft werden: die Antwort mit Fragen im `userPrompt` ohne `Follow-up:` und ohne doppeltes `feedback`, die
Gegenprobe ohne Rückfrage-Zustand (auch bei veralteten Fragen), die Rückfrage bei älterer Ausführung (derselbe Task), der
neue Task nach einer Ausführung ohne Rückfrage und der Rückfall ohne gespeicherte Fragen. `clarificationAnswer` läuft
dabei echt (an `{ prisma }` gebunden). Es wurde kein Produktionsfehler gefunden, der Produktionscode ist unverändert.

## Übergabe
Erledigt. Offen (kein eigener Task): sporadische Teardown-Warnung in `sessions.test.ts` (`refresh` nach `$disconnect` in
`afterAll`), harmlos. Nicht committet.
