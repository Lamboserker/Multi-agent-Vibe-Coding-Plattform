---
id: TASK-005
titel: Leerer Plan zeigt Rückfragen statt Fallback
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-20
phase: 5
plan: docs/ai/plans/2026-10-20-orchestrierung.md
---

# TASK-005: Leerer Plan zeigt Rückfragen statt Fallback

## Ziel
Liefert der Orchestrator keinen Task, aber Rückfragen oder Gründe, sieht der Nutzer diese Fragen im Chat und kann sie
über „Antworten & neu planen" beantworten. Es entsteht kein irreführender Ein-Task-Fallback-Plan und kein zweiter
Premium-Aufruf (ADR-002).

## Akzeptanzkriterien
- [x] Neuer `OrchestratorErrorKind` `'needs_clarification'` (`packages/engine/src/orchestrator/types.ts`).
- [x] `normalizePlan`: 0 Tasks **mit** `analysis.openQuestions` oder `warnings` → `needs_clarification`, Fragen in Message
      bzw. `details`; 0 Tasks ohne jede Begründung → weiterhin `invalid_output` (dann wie bisher Fallback).
- [x] `ExecutionService.plan()`: bei `needs_clarification` kein `deterministicPlan`; vorhandene Subtasks bleiben unberührt;
      Task `status: 'planned'`(oder passender bestehender Status), `currentStep: 'plan_clarification'`;
      Chat-Nachricht `kind: 'plan_questions'`: „Der Orchestrator hat Rückfragen:" + nummerierte Fragen + Hinweis;
      `recordPlanCall(..., 'error', ..., 'needs_clarification')`.
- [x] Renderer: `apps/desktop/src/renderer/lib/leitstand.ts` leitet aus `currentStep === 'plan_clarification'` einen Stage-Zustand ab;
      `Leitstand.tsx` (~Zeile 113) zeigt „Antworten & neu planen", das den vorhandenen Replan-Dialog mit Feedback öffnet
      (`replanTask(task.id, feedback)` in `workflow-actions.ts`).
- [x] Plugin-Orchestrator (`apps/api/src/orchestration/orchestrator.service.ts:103`) erbt das Verhalten über `normalizePlan`.
- [x] Tests: schemas (beide Fälle), execution.service (keine Fallback-Subtasks, `plan_questions`-Nachricht), Renderer-Stage (falls Tests existieren).

## Plan
1. types.ts: Kind ergänzen; prüfen, wo Kinds erschöpfend gematcht werden (`grep "invalid_output"` in engine/api/desktop).
2. schemas.ts `normalizePlan` Zeile 214 anpassen.
3. execution.service.ts `plan()` catch-Zweig (~Zeile 264): Sonderfall vor dem Fallback; danach `return` ohne Subtask-Transaktion.
   Prüfen, dass `planJob` und `planningStatus` mit diesem Ausgang zurechtkommen (kein `plan_failed`).
4. Renderer: Stage + Button; Texte Deutsch; vorhandene Komponenten/Stile verwenden.
5. Tests ergänzen.

## Log
- 2026-10-20: Task angelegt. Entscheidung Nutzer: direkt Rückfragen zeigen, kein Retry (ADR-002).
- 2026-10-20 (Handoff nach TASK-004): Prompt-Seite ist erledigt. `prompts.ts:75-76` lautet ADR-002-konform „Never return zero
  tasks without questions: if the request truly cannot be planned, return no tasks and put concrete questions into
  "analysis.openQuestions"." – abgedeckt durch `prompts.test.ts` („allows an empty plan only together with open questions").
- 2026-10-20 Schritt 1–3 (entwickler, geprüft vom Hauptagent): `types.ts:15` Kind `needs_clarification`, `details.questions`
  (`retryable` bleibt false → kein Retry). `schemas.ts:219-228` `normalizePlan`: 0 Tasks + `openQuestions` (sonst
  `warnings` als Fragen) → `needs_clarification`; ohne beides weiter `invalid_output`. Prüfung: kein Adapter retryt
  `createPlan` (Retry-Schleifen in claude-code.ts/codex.ts nur bei `chat`); Plugin-Orchestrator erbt über `normalizePlan`.
  `execution.service.ts:57-60` `questionsMessage`, `:290-297` Sonderfall im catch nach `recordPlanCall` (errorClass
  `needs_clarification`): Task `planned`/`plan_clarification`, Chat `kind: 'plan_questions'` mit `questions`, Event
  `planned` (tasks 0, source `clarification`) damit der Renderer neu lädt, früher `return` ohne Subtask-/TaskPlan-Änderung.
  `tasks.service.ts:140-144` `run()`: bei `source === 'clarification'` BadRequest mit deutscher Meldung (sonst
  „The task has no plan yet." aus `start()`). Bewusst offen: hat der Task schon einen alten Plan, startet `run()` diesen.
  Tests: neu `packages/engine/src/orchestrator/schemas.test.ts` (4), `planning-progress.test.ts` „planner without tasks" (2:
  Rückfragen statt Fallback + 1 Planner-Aufruf; `invalid_output` → weiter Fallback). engine 237 grün + `catch-up.test.ts`
  (Last-Timeout, einzeln 8/8), engine build ok, `pnpm typecheck` sauber. api-Volllauf: 5 Fehler in
  `plugins/reference-extensions.test.ts` (Plugin-Prozess-Timeouts unter Last) – einzeln geprüft: grün (zusammen mit
  `planning-progress.test.ts` 19/19), also nicht vom Diff.
- 2026-10-20 Schritt 4 Renderer (entwickler, Diff geprüft): Stage wird in `lib/workflow.ts` abgeleitet (nicht in
  `leitstand.ts`, Task-File-Annahme korrigiert). `workflow.ts:4,17` neuer State `plan_questions` aus
  `currentStep === 'plan_clarification'`, steht direkt nach `plan_error` und schlägt alte Executions/Subtasks.
  `leitstand.ts:38` Tone `tool`. `Leitstand.tsx`: Header-Button „Antworten & neu planen" (öffnet den vorhandenen
  Replan-Dialog → `replanTask(task.id, feedback)`), Dialog-Titel „Rückfragen beantworten", `orchestratorSummary`-Fall,
  neue `PlanQuestions`-Leerstelle (Icon `MessageCircleQuestion`, `var(--warn)`) in RunGraph und RunTiles. `PromptDialog`
  hat keine Description-Prop → kein Zusatzhinweis im Dialog (nicht erweitert). Tests: `workflow.test.ts` (plan_clarification
  ohne/mit alter Execution), `leitstand.test.ts` (+1 Zeile). Renderer-lib 42/42 grün, `pnpm typecheck` sauber.
- 2026-10-20 Nachzug (Hauptagent): weitere `currentStep`-Abnehmer gefunden. `session-model.ts:36` Sitzung mit
  `plan_clarification` gilt als `active` (wartet auf Nutzer, wie `awaiting_plan_approval`); `self-test.controller.ts:66,83`
  Rückfragen beenden das Polling mit Fehlertext, sonst Hängen bis Timeout. Test `sessions.test.ts:90`. sessions +
  planning-progress 16/16 grün. Hinweis: Eine Chat-Nachricht ohne Button verfeinert den Task ebenfalls
  (`sessions.service.ts:261` `continueTask`, „Follow-up:" + neue Planung) – zweiter Antwortweg (später angepasst, s. u.).
- 2026-10-20 Abschluss-Review (experte): Urteil ok, kein Blocker, alle Akzeptanzkriterien erfüllt (Stage in `workflow.ts`
  statt `leitstand.ts` akzeptiert, `stageInfo` baut darauf auf). Kein Pfad mit zweitem Premium-Aufruf/Retry. Befunde:
  (major) Planner sieht beim Neuplanen nur die Antworten, nicht seine Fragen, und Button-Antworten gehen bei späterem
  „Neu planen" verloren; (minor) kein Start-Guard gegen alten Plan, Sitzungsstatus nach altem Lauf „failed", Chat-Antwort
  nach altem Lauf erzeugt neuen Task, Token-Verbrauch des Rückfrage-Aufrufs geht verloren, einzeiliges Antwortfeld.
- 2026-10-20 Review-Fixes (entwickler, Diff + Tests vom Hauptagent geprüft): `execution.service.ts:142-160`
  `clarificationAnswer()` (letzte `plan_questions`-Nachricht → Block „Clarification – the planner asked: … The user
  answered: …"); `requestPlan` hängt den Block bei `plan_clarification` an `userPrompt` an und plant ohne `feedback`.
  Entscheidung: dauerhaft im Auftrag statt Einmal-Feedback – spätere Neuplanungen behalten die Antworten, keine Doppelung;
  verworfen: nur `feedback` anreichern (geht beim nächsten „Neu planen" verloren). `sessions.service.ts:260-267`
  Chat-Antwort bei `plan_clarification` verfeinert denselben Task auch mit altem Lauf, gleicher Block. `startLocked`
  (`:537`) wirft BadRequest bei `plan_clarification` (deckt /execute, /run, /retry). `session-model.ts:33` Rückfragen-Check
  vor interrupted/failed. Tests: `planning-progress.test.ts` „answers to planner questions" (3), `sessions.test.ts:91`.
  Nicht umgesetzt: Token-`meta` bei Fehlern aus `normalizePlan` (betraf schon `invalid_output`, braucht Adapter-Änderung),
  mehrzeiliges Antwortfeld (UX), Test für den `continueTask`-Pfad.
- 2026-10-20 Endprüfung (Hauptagent selbst ausgeführt): `pnpm typecheck` sauber; engine 26 Dateien / 238 grün; api 22
  Dateien / 148 grün, 8 skipped; desktop renderer-lib 7 Dateien / 42 grün.

## Ergebnis
Liefert der Planner 0 Tasks mit Rückfragen (oder Warnungen), entsteht kein Fallback-Plan und kein zweiter Premium-Aufruf:
`normalizePlan` wirft `needs_clarification`, `ExecutionService.plan()` setzt `plan_clarification` und postet die nummerierten
Fragen (`plan_questions`), der Leitstand zeigt die Stage „Rückfragen beantworten" mit „Antworten & neu planen". Die
Antworten landen zusammen mit den Fragen dauerhaft im Auftrag (Button- und Chat-Weg); ein alter Plan lässt sich während
offener Rückfragen nicht starten. 0 Tasks ohne Begründung → weiterhin `invalid_output` + Fallback.

## Übergabe
Stand 2026-10-20: done, nicht committet (liegt zusammen mit TASK-004 in der Arbeitskopie). Offene Punkte für TASK-006/später:
(1) Token-`meta` geht verloren, wenn `normalizePlan` im Adapter wirft (`claude-code.ts:224`, `codex.ts:223`) – Rückfrage-
Aufrufe werden mit 0 Tokens gebucht; (2) `PromptDialog` (`components/common.tsx:85`) ist einzeilig – für mehrere Antworten
unbequem; (3) kein Test für den Chat-Antwortweg (`sessions.service.ts:260`). Live-Test des Rückfragen-Pfads nur mit Freigabe.
Offene Fragen: keine.
