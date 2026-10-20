# Projektkontext
<!-- Nur aktueller Stand. Wird überschrieben, nicht ergänzt. Max. ~60 Zeilen. -->

**Projekt:** Multi-AI Coder – Desktop-Coding-IDE (Electron + lokale NestJS-API + `packages/engine`), in der ein
Premium-Orchestrator (Codex / Claude Code) plant und kleine lokale Modelle (Ollama) die Tasks ausführen.
**Stand:** 2026-10-20

## Aktiver Task
keiner. Nächster Kandidat: TASK-008 – Mehrzeiliges Antwortfeld für Rückfragen – `docs/ai/tasks/TASK-008-mehrzeilige-antworten.md`

## Nächste Schritte
1. Nutzer wählt den nächsten Task (Vorschlag: TASK-008, dann TASK-010) und startet ihn mit `/weiter TASK-0NN`.
2. Committet und gepusht: TASK-001–003 `61ba058`, TASK-004–006 `24f6e37` + Doku `9b3321c`, TASK-007 `b9a2854`
   + Doku. TASK-009 (nur Tests, `sessions.test.ts`) erledigt, **nicht committet**. Commits nur auf Nachfrage.
3. Optionale Idee ohne Task: Planner-`agent` in `TaskPlan.dag.tasks[].agent` speichern, um die Herkunft einer Zuweisung
   zu belegen (siehe `tasks/done/TASK-006-*.md`, Übergabe).

## Phasen (Masterplan `docs/ai/plans/2026-10-20-orchestrierung.md`, erledigt)
| Phase | Task | Status |
|---|---|---|
| 1 | TASK-001 Planner kennt Agenten und Skills | done (2026-10-20, `61ba058`) |
| 2 | TASK-002 Agenten-Zuweisung | done (2026-10-20, `61ba058`) |
| 3 | TASK-003 Skills erreichen den Agenten | done (2026-10-20, `61ba058`) |
| 4 | TASK-004 Feine Zerlegung, maxTasks 12 | done (2026-10-20, `24f6e37`) |
| 5 | TASK-005 Leerer Plan → Rückfragen | done (2026-10-20, `24f6e37`) |
| 6 | TASK-006 Gesamtverifikation | done (2026-10-20, `24f6e37`; Live-Plan: 5 Tasks, Doku-Agent + projekt-doku) |

## Bekannte Stolpersteine
- Keine Live-Aufrufe von `claude`/`codex` (Planung, Ausführung, Diagnose) ohne Zustimmung des Nutzers.
- Codex arbeitet in derselben Arbeitskopie: unerwartete Änderungen nicht überschreiben, erst melden.
- `prisma generate` scheitert bei laufendem `pnpm dev` am DLL-Lock → Workaround in CLAUDE.md.
- `PLAN_SCHEMA` ist strict: neue Felder immer in `required`, sonst lehnt Codex `--output-schema` ab.
- api-Typecheck/-Tests lesen die engine-`dist`: nach Engine-Änderungen erst `pnpm --filter @multi-ai-coder/engine build`.
- Planner bekommt angeforderte Skills nur als Katalogzeile (`promptContext` mit `exclude`), nie inline „zum Befolgen".
- Agenten-Zuordnung: reine Funktion `assignAgents` (`apps/api/src/agents/agent-profiles.service.ts`), Rang lexikografisch
  Kategorie > Projekt > Score > Priorität – keine additiven Boni wieder einführen.
- Gepinnte Skills: `Subtask.skills` → `EngineTask.skills` → `forAgent({ pinned })`; ohne Tools werden Skills inline geliefert,
  nie `load_skill` verlangen. Katalog und `forRole` filtern beide nach Rolle `*`/`coder`.
- Planner-Prompt: neue Regeln immer gegen den ganzen Prompt und die ADRs lesen (Lesson 11); Tests in `prompts.test.ts`.
- `catch-up.test.ts` (engine) und `plugins/reference-extensions.test.ts` (api) sind unter Volllast timeout-anfällig –
  einzeln nachprüfen, bevor man Rot dem Diff zuschreibt.
- `sessions.test.ts` (api) loggt sporadisch `Session refresh failed … Response from the Engine was empty` im Teardown
  (`refresh` nach `$disconnect`) – harmlos, Test bleibt grün.
- Rückfragen: `needs_clarification` → Task `currentStep: 'plan_clarification'`, Chat `plan_questions`, Renderer-State
  `plan_questions`; Antworten werden per `clarificationAnswer()` samt Fragen an `userPrompt` angehängt; `startLocked` sperrt.
- Verworfene Premium-Ausgaben: Normalisierung in `normalizeWithMeta(call.meta, …)` kapseln, Aufrufer buchen
  `error.details.meta` (Planung erledigt in TASK-007; Review/Execute offen in TASK-010).
- Vor Live-Tests prüfen, ob der aktuelle Code läuft: `pnpm dev` bündelt das Backend nur beim Start (Lesson 14).
- Dev-Daten liegen in `%APPDATA%\Multi-AI Coder Dev` (DB `multi-ai-coder.db`, User-Skills unter `skills/`).

## Wichtige Entscheidungen
- ADR-001 Planner weist Agent + Skills pro Task zu
- ADR-002 Leerer Plan mit Rückfragen → Rückfragen zeigen, kein Fallback
- ADR-003 Feine Zerlegung (1 Task ≈ 1 Datei), maxTasks 12

## Offene Tasks
- TASK-008 Mehrzeiliges Antwortfeld für Rückfragen (`PromptDialog`)
- TASK-010 Token-meta bei verworfenen Review-/Execute-Ergebnissen (`engine/execution.ts`, `reviewResult`)
- TASK-001 … TASK-007, TASK-009 in `tasks/done/`
