---
id: TASK-021
titel: Vorbestehend rote Projektchecks blockieren keine Tasks
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-21
phase: –
abhaengig: –
plan: –
---

# TASK-021: Vorbestehend rote Projektchecks blockieren keine Tasks

## Ziel
Lauf „Erstelle ein deutlich moderneres Design“ (MAVCP-Neues Testprojekt) scheiterte komplett:
- `pnpm run test` (Playwright) ist schon im Ausgangsstand rot. Ursache: Browser `chromium_headless_shell-1194` fehlt.
- task-001 (Codex) wurde deshalb zweimal verworfen (~2,2 Mio. Tokens), alle abhängigen Tasks übersprungen.

Fix: Die Engine prüft beim ersten roten Check einmal den Basis-Commit des Laufs (eigener Worktree). Checks, die dort
schon rot sind, blockieren einen Task nur, wenn er mehr Testfehler erzeugt. Nebenbefund: Der Planer schrieb
„Ausführung mit devstral:24b“ in den Task-Text, der Router gab ihn an Codex, und Codex rief devstral selbst über
Ollama auf. Abhilfe: eine Planer-Regel, dass Beschreibungen keine Modelle nennen.

## Akzeptanzkriterien
- [x] `parseTestCounts` erkennt Playwright-Zusammenfassungen.
- [x] `againstBaseline`: vorbestehend rote Checks → nicht blockierend (`preexisting`), außer bei mehr Testfehlern.
- [x] `failureDigest` lässt vorbestehende Fehler weg.
- [x] ExecutionRunner: Baseline lazy und einmal pro Lauf, gilt für Agenten-Tasks, Fast-Path, deterministicFix und
      Finalisierung; Event `baseline_failing` mit Playwright-Hinweis.
- [x] Planer-Prompt: keine Modell-/Executor-Namen in Beschreibungen.
- [x] Tests, Typecheck und Lint grün (engine 368, api 220 + 8 übersprungen).

## Log
- 2026-10-21: Analyse anhand Live-Protokoll und Dev-DB (read-only).
- 2026-10-21: Umsetzung: checks.ts (Playwright-Zählung, `againstBaseline`, `baselineFailures`, `preexisting`),
  execution.ts (`validate`/`baselineReport`), Planer-Regel. Tests vom `entwickler`. Ein bestehender Test mit
  Aufrufzähler-Fake wurde angepasst, weil der Baseline-Lauf sonst als roter Ausgangsstand galt.
- Offen: Live-Beleg per „Erneut ausführen“ nach Neustart von `pnpm dev` (nur mit Zustimmung). Ohne Testzahlen im
  Ausgangsstand erkennt die Engine keine zusätzliche Verschlechterung desselben Checks.
- 2026-10-21 (Nachtrag): Übernahme hing. Ursache: task-002 committete `test-results/.last-run.json`; catchUp führte die
  Datei per Modell zusammen und prüfte danach ohne Baseline (12 alte Fehler = rot), bis zu 3 Runden.
  Fix: `stageAll` schließt Testausgaben aus (`TEST_OUTPUT_EXCLUDES`: test-results, playwright-report, blob-report,
  coverage, .nyc_output); catchUp vergleicht mit `run.finalValidation` (`baselineFailures` zählt `preexisting` mit).
  Laufender Lauf: Artefakt im Integrationsbranch per Commit `aa28b3c` entfernt. engine/api grün, typecheck/lint grün.
