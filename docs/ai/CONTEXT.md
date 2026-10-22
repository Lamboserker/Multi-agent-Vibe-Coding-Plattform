# Projektkontext
<!-- Nur aktueller Stand. Wird überschrieben, nicht ergänzt. Max. ~60 Zeilen. -->

**Projekt:** Multi-AI Coder – Desktop-Coding-IDE (Electron + lokale NestJS-API + `packages/engine`), in der ein
Premium-Orchestrator (Codex / Claude Code) plant und kleine lokale Modelle (Ollama) die Tasks ausführen.
**Stand:** 2026-10-22

## Aktiver Task
TASK-028 (Integrationskatalog) implementiert, nicht committet; Übergabe in `tasks/done/TASK-028-integrations-katalog.md`.
30 MCP-Vorlagen, 40 neue Skills, acht Pakete; API 274, Desktop 107, gezielte Engine 60, GUI/Native/Staging geprüft.
Anbieter-Konten und Blender-Szene nicht live abgenommen; gesamte Engine-Suite blieb hängen (Details im Task).

TASK-027 (Gesamtverifikation Duo, Hardware und Lokal). Plan: `docs/ai/plans/2026-10-21-duo-hardware-lokal.md`,
ADR-004 (proposed).
- Erledigt: TASK-023 (Baseline-Lücke, Log-Reihenfolge), TASK-024 (Raster, Router, Premium-Hinweis `repairHint`),
  TASK-025 (`DuoOrchestrator`) und TASK-026 (Duo in API und UI). Review-Blocker behoben; engine 434, api 260,
  desktop 107.
- TASK-022 (Hardware) ist umgesetzt; die Sichtprüfung fehlt noch.
- Es fehlen: Neustart von `pnpm dev`, Sichtprüfung, Duo-Live-Test (nur mit Zustimmung) (Nutzerfrage zum Premium-Hinweis erledigt)
  Alles **nicht committet**.

TASK-020 (Gesamtverifikation Design-Phase), Masterplan `docs/ai/plans/2026-10-21-design-phase.md`, wartet weiter
auf den Nutzer.
- TASK-013 … TASK-019 sind erledigt; Review-Blocker behoben; volle Verifikation grün (engine 357, api 220, desktop 91).
- Es fehlen: Neustart von `pnpm dev` mit Migrationscheck, Sichtprüfung mit Seed-Entwurf, Live-Test (nur mit
  Zustimmung) und eine Nutzerfrage. Details im Abschnitt Übergabe von TASK-020.

## Nächste Schritte
1. Design-Phase (TASK-012 … TASK-020) ist **nicht committet**. Commits nur auf Nachfrage. Bis TASK-011 ist alles
   committet und gepusht (letzter Commit `3ed14cf`).
2. TASK-012 (Codex-Resume `--sandbox`, Pool-node_modules-Link) erledigt, **nicht committet**; Live-Beleg nach Neustart
   von `pnpm dev` per „Erneut ausführen" steht aus (nur mit Zustimmung).
3. TASK-021 (Baseline-Vergleich der Projektchecks, Planer nennt keine Modelle) erledigt, **nicht committet**; Live-Beleg
   per „Erneut ausführen“ nach Neustart von `pnpm dev` steht aus (nur mit Zustimmung).
4. Optionale Ideen ohne Task: Planner-`agent` in `TaskPlan.dag.tasks[].agent` speichern (`tasks/done/TASK-006-*.md`);
   Merge-Erfolgszeile im conflictResolver ohne `sessionId` (`tasks/done/TASK-011-*.md`) – jeweils Abschnitt Übergabe.

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
  `error.details.meta` (Plan TASK-007, Review/Execute TASK-010). Adapter hängen meta an „no structured output" und an
  CLI-Fehler mit Usage (nur wenn das Result `usage` hat); api-catches buchen über `failedCallFields`
  (`orchestration/model-call.ts`); Chat-Resume summiert den verworfenen Versuch per `mergeCallMeta`/`withErrorMeta` (TASK-011).
- Fix-Runde nach Review läuft nur bei Blocker-Issue und löst ein Re-Review nur aus, wenn sie den Inhalt wirklich ändert
  (Test-Fakes müssen in der 2. Ausführung anderen Inhalt schreiben).
- Vor Live-Tests prüfen, ob der aktuelle Code läuft: `pnpm dev` bündelt das Backend nur beim Start (Lesson 14).
- `PromptDialog` (`components/common.tsx`) kann `multiline` + `children`; Rückfragen holt `openQuestions()` (`lib/leitstand.ts`)
  aus den Chat-Metadaten. Renderer hat kein DOM-Testsetup – UI-Verhalten per Sichtprüfung belegen.
- `codex exec resume` kennt weder `--sandbox` noch `-C` → Sandbox per `-c sandbox_mode=…`; Fake-Codex lehnt die Flags ab.
- Dev-Daten liegen in `%APPDATA%\Multi-AI Coder Dev` (DB `multi-ai-coder.db`, User-Skills unter `skills/`).
- Design-Phase:
  - Steps `designing`, `awaiting_design_approval` und `design_failed` müssen überall mit behandelt werden (Lesson 12).
  - Das Gate ist `shouldDesign` (engine `ui/design-gate.ts`); Chat-Freigabe über `designAnswer()` (`session-model.ts`).
  - design-001 ist ein `write-files`-Fast-Path ohne Agent-Fallback.
  - Heuristiken mit bezahlten Folgen immer gegen Mischfälle testen (Lesson 17).
- Duo:
  - `DuoOrchestrator` hat `id = lead.id`; Buchung nur über `meta.parts`/`bookableCalls`, in der API über
    `modelCallRows`/`failedCallRows`.
  - Die Wahl pro Task steht in `ChatMessage.metadata.orchestrator` (Fragen: `askOrchestrator`).
  - Bei expliziter Einzelwahl gibt es keinen Fallback auf die andere CLI.
- Baseline: `againstBaseline` mit Teilmengen-Regel über `failureLines` plus `errorCount`. Lockerungen gegen
  versteckte neue Fehler testen (Lesson 18).
- Hardware: Snapshot mit `state`/`instance`/`unloadsInSec`; `unloadAfterRun` entlädt im `finally` von `runJob`.

## Wichtige Entscheidungen
- ADR-001 Planner weist Agent + Skills pro Task zu
- ADR-002 Leerer Plan mit Rückfragen → Rückfragen zeigen, kein Fallback
- ADR-003 Feine Zerlegung (1 Task ≈ 1 Datei), maxTasks 12
- ADR-004 Duo-Orchestrierung: parallel + Abgleich (proposed, ersetzt ADR-002 teilweise)

## Offene Tasks
- TASK-020, TASK-022, TASK-027 (warten auf Nutzer). Übrige erledigte Tasks liegen in `tasks/done/`.
