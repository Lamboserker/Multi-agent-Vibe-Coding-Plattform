---
id: TASK-004
titel: Feinere Zerlegung und maxTasks 12
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-20
phase: 4
plan: docs/ai/plans/2026-10-20-orchestrierung.md
---

# TASK-004: Feinere Zerlegung und maxTasks 12

## Ziel
Der Planner zerlegt Aufgaben in kleine, präzise Tasks (≈ 1 Datei/Komponente/Doku-Datei je Task), damit kleine lokale
Modelle sie lösen können und mehrere Agenten parallel arbeiten. Kein Satz im Prompt drängt mehr zu „einem Task".

## Akzeptanzkriterien
- [x] `ORCHESTRATOR_SYSTEM_PROMPT`: der Satz „Minimize time to a validated change: keep a small cohesive change in ONE task …"
      ist ersetzt durch: 1 Task = 1 Datei oder 1 Komponente/Seite/Doku-Datei inkl. Test; nur triviale Edits derselben Datei
      bündeln; Setup-Task zuerst; Unabhängiges ohne Abhängigkeit, damit es parallel läuft.
- [x] `planningPrompt` hat eine Greenfield-Regel („Grundstruktur", leeres Repo): Setup-Task + je Datei ein Task,
      ausdrücklich inkl. Doku-Dateien, jeder mit passendem Agent (TASK-001-Feld).
- [x] `planningPrompt`: „Never return zero tasks. If the request truly cannot be planned, put concrete questions into
      `analysis.openQuestions`." (Grundlage für TASK-005.) – **umgesetzt ADR-002-konform präzisiert:** „Never return zero tasks
      without questions: if the request truly cannot be planned, return no tasks and put concrete questions into …" (siehe Log).
- [x] `apps/api/src/runtime/settings.service.ts:87`: Default `maxTasks: 12`; gespeicherte Nutzerwerte bleiben unverändert
      (prüfen, wie Defaults mit gespeicherten Settings gemergt werden).
- [x] Bestehende Prompt-Tests angepasst; kein Test erwartet mehr die alte Formulierung.

## Plan
1. `packages/engine/src/orchestrator/prompts.ts` Zeile 9 ersetzen; Regeln in `planningPrompt` (Abschnitt `# Planning rules`) ergänzen.
   Die bestehenden Regeln für lokale Tasks (Zeilen 52–63) bleiben; Widersprüche entfernen.
2. `apps/api/src/runtime/settings.service.ts`: Default ändern; `settings.test.ts` prüfen (erwartet ggf. 8).
3. `grep -r "ONE task"` und Prompt-Snapshots in `packages/engine/src/orchestrator/*.test.ts` anpassen.
4. Hinweis Latenz: Die alte Regel stammt aus der Messung vom 2026-10-15 (`docs/performance-2026-10-15.md`). Feinere Pläne
   kosten mehr Output-Tokens beim Planen und mehr Worktrees; das ist laut ADR-003 bewusst akzeptiert.

## Log
- 2026-10-20: Task angelegt. Entscheidung Nutzer: feine Zerlegung + maxTasks 12 (ADR-003).
- 2026-10-20 (Hauptagent, ohne Subagent – reine Textänderungen): Arbeitskopie sauber, Stand = Übergabe.
  - `packages/engine/src/orchestrator/prompts.ts:9`: „Minimize time … ONE task …" ersetzt durch „Decompose finely …: one task =
    one file, or one component, page or documentation file including its test. Bundle only trivial edits of the same file. Plan a
    setup task first … Give independent tasks no dependency, so they run in parallel."
  - `prompts.ts:72-74` (`# Planning rules`): „One task = one file (…) … Bundle only trivial edits of the same file." + neue Regel
    „Never return zero tasks. If the request truly cannot be planned, put concrete questions into "analysis.openQuestions"."
    (Feld existiert in `ANALYSIS_SCHEMA`, `schemas.ts:12/21`.)
  - `prompts.ts:79-83`: bestehende Neuprojekt-Regel zur Greenfield-Regel erweitert statt eine zweite Regel anzulegen (vermeidet
    Doppelung): auch „Grundstruktur"/scaffold, „one local task per file – component, page, style file, test and documentation file
    (README, docs/*.md) alike", Agent-Zusatz nur wenn ein Agentenkatalog existiert (sonst Widerspruch zu `"agent": always ""`).
    Lokal-Task-Regel („at most ONE existing file … at most three new files") bleibt – passt zu „Komponente inkl. Test".
  - `apps/api/src/runtime/settings.service.ts:87`: `maxTasks: 12`. Merge geprüft: `updateVersioned` persistiert nur geänderte Keys,
    `get()` = `mergeSettings(DEFAULT_SETTINGS, stored)` → nie geänderter Wert folgt dem neuen Default, gespeicherte Werte bleiben.
  - `packages/engine/src/planning/fallback-planner.ts:79`: Fallback-Default `?? 8` → `?? 12` (Konsistenz; Aufrufer übergeben
    immer `settings.maxTasks`).
  - Tests: `prompts.test.ts` +3 Tests (feine Zerlegung in System- und Planungsprompt, kein „in ONE task"/„Minimize time";
    Greenfield inkl. Doku + Agent-Zusatz nur mit Katalog; „Never return zero tasks"), bestehende Assertion auf neue
    Neuprojekt-Formulierung angepasst. `settings.test.ts` +1 Test (Default 12, gespeicherte 8 bleibt); der bestehende
    Restart-Test belegt die DB-Seite (gespeicherte 5 überlebt Neustart).
  - Ergebnis: engine 234/234 grün (erster Lauf 1 rot = alte Assertion, danach `src/orchestrator src/planning` 56/56), engine build
    ok, api 143 grün / 8 skipped, `pnpm typecheck` sauber.
- 2026-10-20 Abschluss-Review (`experte`): alle 5 Kriterien erfüllt, kein Blocker. Befunde und Umsetzung (Hauptagent):
  - S1 Greenfield-Regel zählte „test" als eigenen Task, Widerspruch zu „Komponente inkl. Test" → `prompts.ts:82-84` jetzt „one
    local task per file or per component/page with its test – style files and documentation files (README, docs/*.md) alike".
  - S2 „edits at most ONE existing file" hätte Komponente + bestehende Testdatei zu premium gezwungen → `prompts.ts:77` „at most
    ONE existing source file (plus its own test file)".
  - S3 „Never return zero tasks." widerspricht ADR-002 (0 Tasks **mit** Fragen = `needs_clarification`) und verleitet zu
    Schein-Tasks → `prompts.ts:75-76` „Never return zero tasks without questions: if the request truly cannot be planned, return
    no tasks and put concrete questions into "analysis.openQuestions"." Bewusste Abweichung vom Kriteriumswortlaut zugunsten der
    gültigen ADR. Bis TASK-005 fällt ein leerer Plan weiter in den Fallback (`schemas.ts:218` → `execution.service.ts:286`).
  - K1 Gruppier-Ausnahme galt nur für „Large conversions", „Bundle only trivial edits" verbot sie sonst → als allgemeine Regel
    nach `prompts.ts:73-74` verschoben, aus der Konvertierungsregel entfernt.
  - K2 Test, dass der System-Prompt „documentation file including its test" enthält, ergänzt.
  - Tests zu S1/S2/K1/K2/S3 in `prompts.test.ts` ergänzt bzw. angepasst.
  - Läufe: engine 233/234 im Volllauf – rot war nur `src/integration/catch-up.test.ts` (Timeout 5022 ms bei 5000 ms Limit unter
    Last; nicht vom Diff berührt, im ersten Volllauf grün); einzeln mit `src/orchestrator` 33/33 grün. engine build ok, api 143
    grün / 8 skipped, `pnpm typecheck` sauber (alle Pakete).

## Ergebnis
Planner zerlegt jetzt fein: System-Prompt und `# Planning rules` verlangen 1 Task = 1 Datei bzw. 1 Komponente/Seite/Doku-Datei
inkl. Test, Setup-Task zuerst, Unabhängiges parallel; Greenfield-/„Grundstruktur"-Regel mit Doku-Dateien und Agent je Task;
leerer Plan nur mit Rückfragen (ADR-002). Default `maxTasks` 12 (auch Fallback-Planer), gespeicherte Werte bleiben.
Geänderte Dateien: `packages/engine/src/orchestrator/prompts.ts`, `prompts.test.ts`, `packages/engine/src/planning/fallback-planner.ts`,
`apps/api/src/runtime/settings.service.ts`, `settings.test.ts`. Note: B.

## Übergabe
Stand 2026-10-20: **done**, nicht committet (Commit nur auf Nachfrage). Engine-`dist` ist neu gebaut.
Hinweise für Folgephasen:
- TASK-005: Prompt-Regel lautet bereits „return no tasks and put concrete questions into analysis.openQuestions" – nur noch
  `normalizePlan` (`schemas.ts:218`) und die App-Seite umsetzen; Test `prompts.test.ts` („allows an empty plan only together with
  open questions") deckt den Prompt ab.
- Gebaute Bundles (`apps/desktop/release-app/backend/main.cjs`, `.cache/…`) enthalten noch die alte Regel → vor Paketierung neu bauen.
- `catch-up.test.ts` ist unter Volllast knapp am 5-s-Timeout (flaky) – bei TASK-006 beobachten.
- Benchmarks in `docs/benchmarks/` sind mit feiner Zerlegung nicht mehr direkt vergleichbar (ADR-003 akzeptiert).
Offene Fragen: keine.
