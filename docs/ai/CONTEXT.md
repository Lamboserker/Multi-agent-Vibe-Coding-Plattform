# Projektkontext
<!-- Nur aktueller Stand. Wird überschrieben, nicht ergänzt. Max. ~60 Zeilen. -->

**Projekt:** Multi-AI Coder – Desktop-Coding-IDE (Electron + lokale NestJS-API + `packages/engine`), in der ein
Premium-Orchestrator (Codex / Claude Code) plant und kleine lokale Modelle (Ollama) die Tasks ausführen.
**Stand:** 2026-10-20

## Aktiver Task
TASK-004 – Feinere Zerlegung und maxTasks 12 – `docs/ai/tasks/TASK-004-feine-zerlegung.md`

## Nächste Schritte
1. TASK-004 umsetzen (feine Zerlegung, 1 Task ≈ 1 Datei, maxTasks 12; ADR-003). TASK-005 (Rückfragen) ist unabhängig.
2. TASK-006 Gesamtverifikation nach 1–5 (Live-Test nur mit Freigabe); offene Punkte aus der Übergabe von TASK-003 prüfen.
3. TASK-001–003 committet als `61ba058` (nicht gepusht). Commits nur auf Nachfrage.

## Phasen (Masterplan `docs/ai/plans/2026-10-20-orchestrierung.md`)
| Phase | Task | Status |
|---|---|---|
| 1 | TASK-001 Planner kennt Agenten und Skills | done (2026-10-20, `61ba058`) |
| 2 | TASK-002 Agenten-Zuweisung | done (2026-10-20, `61ba058`) |
| 3 | TASK-003 Skills erreichen den Agenten | done (2026-10-20, `61ba058`) |
| 4 | TASK-004 Feine Zerlegung, maxTasks 12 | aktiv |
| 5 | TASK-005 Leerer Plan → Rückfragen | offen |
| 6 | TASK-006 Gesamtverifikation | offen (nach 1–5) |

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
- Dev-Daten liegen in `%APPDATA%\Multi-AI Coder Dev` (DB `multi-ai-coder.db`, User-Skills unter `skills/`).

## Wichtige Entscheidungen
- ADR-001 Planner weist Agent + Skills pro Task zu
- ADR-002 Leerer Plan mit Rückfragen → Rückfragen zeigen, kein Fallback
- ADR-003 Feine Zerlegung (1 Task ≈ 1 Datei), maxTasks 12

## Offene Tasks
- TASK-004 … TASK-006 (siehe Tabelle); TASK-001 … TASK-003 in `tasks/done/`
