---
id: TASK-016
titel: Prisma, DesignService/Controller, Gate in requestPlan
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-21
phase: 4
abhaengig: TASK-014, TASK-015
plan: plans/2026-10-21-design-phase.md
---

# TASK-016: Prisma, DesignService/Controller, Gate in requestPlan

## Ziel
Design-Phase in der API: Persistenz, Designer-Wahl, Job, Freigabe-/Überarbeiten-/Überspringen-Routen, Gate vor der
Planung, `design-001` im Plan, Design-Guidance für Executor.

## Akzeptanzkriterien
- [x] Migration `20261021120000_design_drafts` (additiv: `Task.designMode`, Tabelle `DesignDraft`, Index).
- [x] `OrchestratorService.designer()` – Claude vor Codex, API-Key-Regel, nur Adapter mit `createDesign`;
      MCP-Rollenmap `createDesign: 'designer'`.
- [x] `DesignService` + `DesignController` (`GET tasks/:id/design[/versions]`, `POST …/approve|reject|skip|regenerate`),
      Job `design.create`, ModelCall `purpose: 'design'` (Fehler via `failedCallFields`), Chat `design_draft`/`design_error`.
- [x] Gate in `requestPlan`; `plan()` mit Entwurf: kein Fast Path, `design` im Input, `maxTasks - 1`,
      `design-<type>` requested, `design-001` (write-files in `Subtask.fastPath`) + Abhängigkeiten.
- [x] Guidance-Hook in `runJob`; `startLocked` sperrt `designing`/`awaiting_design_approval`; `designMode` beim Anlegen.
- [x] api 195 grün (8 skipped), api-typecheck, api-lint, desktop-typecheck grün. Kein Live-Aufruf.

## Log
- 2026-10-21 (experte): Umsetzung. Kein Feature-Modul (App hat nur `AppModule`). DI ohne Zyklus über
  `@Optional() design` + `design.setPlanner()`. `designMarkdown` in `apps/api/src/design/design-files.ts`.
  `start()` ersetzt offene Entwürfe (draft → rejected, generating → failed); Job füllt nur noch `generating`-Entwürfe
  (`updateMany`). Digest-Budget Designer 3000 Tokens. Tests `design.test.ts` (19), `designer.test.ts` (4).
- 2026-10-21 (Hauptagent): Review. Risiko „design-001 fällt auf Agent zurück“ (bei `no_changes` im Re-Run oder bei
  Fehlern) behoben in `engine/execution.ts`: write-files mit identischen Dateien → completed ohne Commit; sonst
  failed ohne Agent-Fallback (ein Agent kann den Entwurfsinhalt nicht rekonstruieren). Tests dazu (entwickler).
- 2026-10-21 (entwickler): 3 Tests in `execution.test.ts` (integriert ohne Modell; identische Datei → completed,
  abhängiger Task läuft; `../x` → failed ohne Fallback).
  - Bug gefunden: Bei einem CRLF-Checkout ist `changed` nicht leer, `commitIfChanged` findet aber nichts zu committen.
  - Fix: Die Bedingung lautet jetzt `result.ok && !commit && kind === 'write-files'` (`execution.ts:748`).
  - Engine: 327 Tests grün, typecheck und build grün.
  - Bekannte Grenze: Ein Lauf, der nur aus write-files-Tasks ohne Änderung besteht, endet als failed
    („No task produced …“). Das ist in der Praxis ausgeschlossen.

## Ergebnis
API-Seite der Design-Phase steht.

## Übergabe
Offen für TASK-017: Chat-Folgenachrichten in Design-Zuständen, „Analysiere das Repository …“-Text nach Gate,
`markPlanInterrupted`/`recover`, `session-model`, Self-Test. Weitere Restrisiken: Plan-Nachricht zeigt bei design-001
evtl. ein lokales Modell als Ziel; `design-<type>` wird nur requested, wenn der Skill im Coder-Katalog steht;
MCP-Proxy-Pfad für `createDesign` nur per Code-Inspektion geprüft.
