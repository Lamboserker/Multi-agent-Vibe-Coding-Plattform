---
id: TASK-004
titel: Feinere Zerlegung und maxTasks 12
status: offen   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-20
phase: 4
plan: docs/ai/plans/2026-10-20-orchestrierung.md
---

# TASK-004: Feinere Zerlegung und maxTasks 12

## Ziel
Der Planner zerlegt Aufgaben in kleine, präzise Tasks (≈ 1 Datei/Komponente/Doku-Datei je Task), damit kleine lokale
Modelle sie lösen können und mehrere Agenten parallel arbeiten. Kein Satz im Prompt drängt mehr zu „einem Task".

## Akzeptanzkriterien
- [ ] `ORCHESTRATOR_SYSTEM_PROMPT`: der Satz „Minimize time to a validated change: keep a small cohesive change in ONE task …"
      ist ersetzt durch: 1 Task = 1 Datei oder 1 Komponente/Seite/Doku-Datei inkl. Test; nur triviale Edits derselben Datei
      bündeln; Setup-Task zuerst; Unabhängiges ohne Abhängigkeit, damit es parallel läuft.
- [ ] `planningPrompt` hat eine Greenfield-Regel („Grundstruktur", leeres Repo): Setup-Task + je Datei ein Task,
      ausdrücklich inkl. Doku-Dateien, jeder mit passendem Agent (TASK-001-Feld).
- [ ] `planningPrompt`: „Never return zero tasks. If the request truly cannot be planned, put concrete questions into
      `analysis.openQuestions`." (Grundlage für TASK-005.)
- [ ] `apps/api/src/runtime/settings.service.ts:87`: Default `maxTasks: 12`; gespeicherte Nutzerwerte bleiben unverändert
      (prüfen, wie Defaults mit gespeicherten Settings gemergt werden).
- [ ] Bestehende Prompt-Tests angepasst; kein Test erwartet mehr die alte Formulierung.

## Plan
1. `packages/engine/src/orchestrator/prompts.ts` Zeile 9 ersetzen; Regeln in `planningPrompt` (Abschnitt `# Planning rules`) ergänzen.
   Die bestehenden Regeln für lokale Tasks (Zeilen 52–63) bleiben; Widersprüche entfernen.
2. `apps/api/src/runtime/settings.service.ts`: Default ändern; `settings.test.ts` prüfen (erwartet ggf. 8).
3. `grep -r "ONE task"` und Prompt-Snapshots in `packages/engine/src/orchestrator/*.test.ts` anpassen.
4. Hinweis Latenz: Die alte Regel stammt aus der Messung vom 2026-10-15 (`docs/performance-2026-10-15.md`). Feinere Pläne
   kosten mehr Output-Tokens beim Planen und mehr Worktrees; das ist laut ADR-003 bewusst akzeptiert.

## Log
- 2026-10-20: Task angelegt. Entscheidung Nutzer: feine Zerlegung + maxTasks 12 (ADR-003).

## Ergebnis

## Übergabe
Stand 2026-10-20: noch nicht begonnen (Status `offen`). Voraussetzung TASK-001 ist erfüllt: `PlannedTask.agent` und
`PlannedTask.skills` existieren (PLAN_SCHEMA strict), der Planner bekommt `# Available agents` / `# Available skills`.
Zeilenbezüge geprüft am 2026-10-20: `prompts.ts:9` enthält noch „Minimize time to a validated change …", `# Planning rules`
steht jetzt bei `prompts.ts:70` (durch TASK-001 verschoben; die Lokal-Task-Regeln liegen entsprechend weiter unten),
`settings.service.ts:87` `maxTasks: 8`.
Arbeitskopie: TASK-001–003 committet als `61ba058` (nicht gepusht); `git status` sollte sauber sein, sonst melden.
Baseline: engine 231 grün, api 142 grün / 8 skipped, `pnpm typecheck` sauber.
**Nächster Schritt:** Plan-Schritt 1 (`prompts.ts:9` ersetzen, Regeln in `# Planning rules`), Prompt-Tests in
`packages/engine/src/orchestrator/prompts.test.ts` anpassen; nach Engine-Änderungen `pnpm --filter @multi-ai-coder/engine build`.
Offene Fragen: keine.
