---
id: TASK-015
titel: Planner-Designabschnitt und FastPathTool write-files
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-21
phase: 3
abhaengig: TASK-013
plan: plans/2026-10-21-design-phase.md
---

# TASK-015: Planner-Designabschnitt und FastPathTool write-files

## Ziel
Planner baut auf dem freigegebenen Entwurf auf; deterministisches Werkzeug schreibt die Design-Dateien.

## Akzeptanzkriterien
- [x] `planningPrompt`: Abschnitt `# Design draft (approved by the user)` (Summary, Direction, Typ, Token-Namen,
      Komponenten mit Datei/Spec ≤ 300, Screens; kein Mockup, keine Token-Werte) + Design-Regeln nur mit Entwurf.
- [x] Gesamtprompt gegengelesen (Lesson 11), Widersprüche aufgelöst.
- [x] `FastPathTool` `write-files` (`files` + `contents`), Pfade über `resolveInside`, kein `.git`, kein
      `isSensitivePath`; alles-oder-nichts-Validierung; `changed` nur bei Inhaltsänderung.
- [x] Tests: 4 Prompt-, 2 Fast-Path-Tests; engine 324/324.

## Log
- 2026-10-21 (entwickler): Widersprüche: (1) „at most ONE existing source file“ → Token-Import und App-Shell sind zwei
  Tasks; (2) „Two tasks must not modify the same file unless dependent“ → Screen-Task, der eine Shell-Datei ändert,
  hängt vom Shell-Task ab; (3) maxTasks → Gruppierung kleiner Komponenten, nie mehr als 2 Dateien; (4) ADR-003 passt.
  `executeTool` in `execution.ts` behandelt die neue Art generisch – keine Änderung nötig.
- 2026-10-21 (Hauptagent): engine 324/324, build grün.

## Ergebnis
Planner-Prompt und Fast-Path-Werkzeug bereit für die API-Integration.

## Übergabe
TASK-016: `design-001` zählt nicht in maxTasks des Planners → API übergibt `maxTasks - 1`, wenn ein Entwurf vorliegt.
