---
id: TASK-012
titel: Codex-Reparatur scheitert an `exec resume --sandbox`; Pool-Worktree ohne node_modules-Link
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-20
phase: –
abhaengig: –
plan: –
---

# TASK-012: Codex-Reparatur scheitert an `exec resume --sandbox`; Pool-Worktree ohne node_modules-Link

## Ziel
Lauf `cmvgrhlrc000pv2b4rrnycu3x` (Projekt „MAVCP-Neues Testprojekt“) endet mit „No task produced a validated change“:
task-001 (Premium/Codex) baut, aber Validierung `pnpm run test` schlägt fehl; die Reparatur bricht sofort mit
`process_failed: error: unexpected argument '--sandbox' found` (Usage `codex exec resume …`) ab, task-002–004 werden
übersprungen.

## Akzeptanzkriterien
- [x] `codex exec resume` bekommt keine Flags, die die CLI dort ablehnt; Sandbox bleibt wirksam.
- [x] Fake-CLI lehnt die exec-only-Flags bei `resume` ab wie die echte CLI; Test für Execute-Resume (Reparatur).
- [x] Pool-Worktree mit eigenem, nur Caches enthaltendem `node_modules` bekommt den Link auf die Abhängigkeiten.
- [x] engine-Tests, typecheck, build grün. Kein Live-Aufruf.

## Log
- 2026-10-20 (Hauptagent): Ursache 1. `codex exec resume --help` (codex-cli 0.153.4, kein Modellaufruf) kennt weder
  `--sandbox` noch `-C`. `codex.ts` `callOnce` setzte `--sandbox` für beide Varianten. Beim Chat fiel das nicht auf
  (stiller Fallback auf neuen Thread), `executeComplexTask` hat keinen Fallback → jede Codex-Reparatur scheiterte.
  Fix: bei Resume `-c sandbox_mode="<sandbox>"`, sonst `--sandbox`; cwd kommt beim Resume aus dem Prozess (`ctx.cwd`).
  Fake-Codex in `adapters.test.ts` lehnt `--sandbox`/`-s`/`-C`/`--cd` bei `resume` mit Exit 2 ab; Chat-Resume-Test prüft
  `sandbox_mode="read-only"`, neuer Test „a repair round resumes the execution thread with a writable sandbox via config“.
- 2026-10-20 (Hauptagent): Ursache 2 (Validierung `test` rot). DB-Events: Codex meldet „Playwright fehlt lokal“. Das
  Hauptprojekt hat `node_modules` (seit 14:25), `pool-0` aber ein **echtes** `node_modules` (14:09, nur `.vite`) – ein
  `vite build` vor der Installation. `linkDependencyFolders` übersprang vorhandene Ziele, `git clean -e node_modules`
  behält den Ordner → der Slot bekam den Link nie. Fix `worktrees.ts`: echtes, nur aus Cache-Einträgen (Punkt-Namen
  außer `.bin`/`.pnpm`) bestehendes Ziel wird entfernt und verlinkt (`isCacheOnlyFolder`). Test in `git.test.ts`
  „replaces a cache-only node_modules left in a pooled slot by the dependency link“.
- Prüfung: engine komplett 267/267 (vor Fix 2), `git.test.ts` 11/11 nach Fix 2, engine typecheck + build grün.

## Ergebnis
Codex-Reparaturrunden laufen wieder (Resume mit Sandbox per Config); Pool-Slots heilen einen Cache-only-`node_modules`
beim nächsten Leasing selbst. Restrisiko: Live-Lauf steht aus (Dev-Instanz muss neu starten, Lesson 14).

## Übergabe
Nicht committet. Nach Neustart von `pnpm dev` Lauf „Erneut ausführen“ als Live-Beleg (Codex-Kontingent, nur mit Zustimmung).
