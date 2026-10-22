---
id: TASK-017
titel: Design-Zustände Ende-zu-Ende
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-21
abgeschlossen: 2026-10-21
phase: 5
abhaengig: TASK-016
plan: plans/2026-10-21-design-phase.md
---

# TASK-017: Design-Zustände Ende-zu-Ende

## Ziel
Die neuen Steps `designing`, `awaiting_design_approval` und `design_failed` werden in `apps/api` überall behandelt, wo
heute `planning`/`plan_failed`/`plan_clarification` behandelt werden (Lesson 12). Dazu gehören Chat-Freigabe und
Feedback, Recovery, Sitzungsstatus, Self-Test und Start-Guard.

## Akzeptanzkriterien
- [x] Chat: Bestätigung gibt den Entwurf frei, anderer Text ist Feedback (v2). Während `designing` kommt nur ein Hinweis,
      `design_failed` + Nachricht startet einen Neuversuch.
- [x] Bei Gate-Treffer erscheint die Design-Startmeldung statt „Analysiere …“.
- [x] Recovery: `designing` ohne Job wird zu `design_failed`.
- [x] `session-model.ts`, `self-test.controller.ts`, `startLocked` und `activity()` kennen die Steps.
- [x] api typecheck, test (208 grün, 8 übersprungen) und lint grün; desktop typecheck grün. Kein Live-Aufruf.

## Log
- 2026-10-21: Delegiert an `experte`.
- 2026-10-21: Umgesetzt:
  - `session-model.ts`:
    - neues Muster `DESIGN_APPROVAL`; die ganze Nachricht muss eine Bestätigung sein.
    - Mapping: `awaiting_design_approval` → active, `design_failed` → failed, `designing` → running, solange ein
      `design.create`-Job aktiv ist.
  - `sessions.service.ts`:
    - `answerDesign` und `planningMessage` (Chat-`kind`s `design_approval`, `design_feedback`, `design_pending` und
      `design_requested`);
    - `design_failed` + Nachricht läuft als Follow-up und Feedback;
    - `recover()` und `markPlanInterrupted` behandeln `designing`.
  - `DesignService.markInterrupted`.
  - `startLocked` blockiert auch `design_failed`.
  - Der Self-Test nutzt `designMode: 'skip'`; neue reine Helfer `selfTestFinished` und `selfTestStepError`.
  - Neue Tests in `sessions.test.ts` (Mapping, `DESIGN_APPROVAL`, sechs Chat- und Recovery-Fälle),
    `planning-progress.test.ts` und `runtime/self-test.test.ts`.

## Ergebnis
Die Design-Steps sind in der API durchgängig verdrahtet.

Entscheidungen:
- Eigenes `DESIGN_APPROVAL`, weil `RUN_CONFIRMATION` „ok, aber dunkler“ als Freigabe zählen würde.
- Während `designing` wird kein Feedback eingereiht: keine automatische zweite bezahlte Anfrage.
- Feedback ändert den `userPrompt` nicht. Der Planner bekommt den freigegebenen Entwurf.
- Eine Unterbrechung führt zu `design_failed`, im Chat als `design_error` mit `interrupted: true`.

## Übergabe
Renderer-Stellen für TASK-019, vom experte gemeldet:
- `lib/workflow.ts:4,15–17,33`, `workflow.test.ts`
- `Leitstand.tsx:84,114,119,212–219,457,490–512,611–674`
- `OrchestratorChat.tsx:134,187–189`
- `use-leitstand.ts:57` (`designing` fehlt bei running)
- `RunOverview.tsx:30,34`
- `sync.ts:195–196` (Events `design_*` fehlen)
- `planning-progress.ts:19–30`
- `Shell.tsx:411` (Label „◔ Plan:“ zählt jetzt auch Design-Jobs)
- `leitstand.test.ts:38–42`

Offene Risiken:
- `DesignController.approve`/`skip` posten keine Chat-Notiz „Plan wird erstellt“, die Chat-Freigabe schon. In TASK-019
  angleichen.
- `tasks.service.ts:84 findOne` liefert `planningStatus` nur für `planning`. Für `designing` gibt es nach einem Reload
  keine Uhr.
- Schlägt nach einer Chat-Freigabe `requestPlan` fehl, bleibt der Entwurf freigegeben. „Erneut planen“ funktioniert.
- Schon vorher vorhanden: Der Self-Test erkennt `plan_interrupted` nicht als beendet.
