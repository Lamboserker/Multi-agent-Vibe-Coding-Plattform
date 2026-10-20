---
id: TASK-002
titel: Agenten-Zuweisung reparieren
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-20
phase: 2
abhaengig: TASK-001
plan: docs/ai/plans/2026-10-20-orchestrierung.md
---

# TASK-002: Agenten-Zuweisung reparieren

## Ziel
Jeder Plan-Task bekommt den fachlich passenden Agenten: zuerst die Wahl des Planners, dann ein vom Nutzer namentlich
genannter Agent, zuletzt eine Heuristik, in der die Kategorie Stichwörter dominiert. Doku-Tasks landen beim Doku-Agent,
nicht beim Frontend-Agent.

## Akzeptanzkriterien
- [x] Reihenfolge in `ExecutionService.plan()`: (a) `planned.agent` case-insensitiv auf einen aktiven Profilnamen,
      (b) Nutzer-Prompt nennt genau ein Profil beim Namen **und** der Plan hat 1 Task, (c) `agentProfiles.match()`.
- [x] `profileMatches`: Kategorietreffer = 10 Punkte; `CATEGORY_ALIASES` bildet Planner-Kategorien auf Agenten-Stichwörter ab
      (`react-ui|styling|frontend-logic → frontend, ui`; `api-endpoint|backend-service|database-schema|database-migration → backend`;
      `tests → test`; `documentation → docs`; `refactor → refactoring`). Alias-Treffer zählt wie Kategorietreffer.
- [x] Wirkt mit den bereits gespeicherten Profilen (keine Datenmigration).
- [x] `planMessage` zeigt pro Task Agent und Skills: `→ Premium · Doku-Agent · Skills: projekt-doku`.
- [x] Tests grün; neue Fälle: `documentation`-Task mit Frontend-Wörtern → Doku-Agent; `react-ui` → Frontend über Alias;
      Planner-`agent` schlägt Heuristik; unbekannter Planner-Agent fällt auf Heuristik zurück.

## Plan
1. `apps/api/src/agents/agent-profiles.service.ts`
   - `CATEGORY_ALIASES: Record<string, string[]>` neben `AGENT_TEMPLATES`.
   - `profileMatches`: `if (keywords.includes(category) || (CATEGORY_ALIASES[category] ?? []).some((alias) => keywords.includes(alias))) return 10`.
   - Optional Helfer `byName(projectId, name)` und `namedIn(projectId, text)` (Profilname als ganzes Wort, case-insensitiv).
2. `apps/api/src/execution/execution.service.ts` `plan()` (~Zeile 283, `agentIds`): Reihenfolge (a)→(b)→(c) umsetzen;
   die in TASK-001 geladene Profilliste wiederverwenden statt erneut abzufragen.
3. `planMessage` (~Zeile 383): Agentennamen über eine Map `agentId → name` und `planned.skills` anhängen.
4. Renderer prüfen: zeigt die Plan-Karte den Agenten bereits (Subtask `agentId`)? Falls nicht, nur Label ergänzen – kein Redesign.
5. Tests: `apps/api/src/agents/agent-profiles.test.ts` (Zeile 28 erwartet `toBe(3)` → auf `10` ändern), neue Fälle;
   execution-Test für die Reihenfolge (bestehende Test-Helfer in `apps/api/src/execution/*.test.ts` nutzen).

## Log
- 2026-10-20: Task angelegt. Beleg aus der Dev-DB: Subtask „Dashboard-Grundstruktur und Umsetzung dokumentieren"
  (`documentation`) → Frontend-Agent.
- 2026-10-20 (aus TASK-001): `PlannedTask.agent` = Profil-**Name** aus `# Available agents` (nur aktive `coder`-Profile)
  oder `''`. Namen sind nicht eindeutig (global + Projekt) → Projektprofil vor globalem; unbekannt/leer → `match()`.
  Persistiert wird `agent` noch nicht. api liest engine-`dist`: nach Engine-Änderungen erst engine bauen.
- 2026-10-20 Schritt 1–3, 5 (entwickler, geprüft vom Hauptagent):
  - `apps/api/src/agents/agent-profiles.service.ts`: `CATEGORY_ALIASES` (~Z. 83); `profileMatches` Kategorie/Alias = 10,
    Stichwortsumme auf 9 gedeckelt (Abweichung vom Plan, vom entwickler eingeführt: ohne Deckel erreichte der
    Frontend-Agent bei einem Doku-Task voller UI-Wörter >10 Punkte → Lesson 4 verlangt, dass Kategorie immer gewinnt).
    Neue reine Helfer `bestProfile`, `profileByName`, `profilesNamedIn`, `assignAgents` (generisch über Profil-Pick,
    damit Tests Teilobjekte übergeben können); `match()` delegiert an `bestProfile`.
  - Entscheidung: Reihenfolge als reine Funktion `assignAgents` statt Logik in `plan()` – testbar ohne die vielen
    Prisma-Mocks von `plan()`; verworfen: execution-Test über komplettes `plan()` (Mock-Aufwand, wenig Mehrwert).
  - `apps/api/src/execution/execution.service.ts`: `agentProfilesPromise` einmal geladen, `agentCatalogPromise` daraus
    abgeleitet (~Z. 192); `assignAgents(...)` ersetzt die `match()`-Schleife (~Z. 295); `planMessage` bekommt
    `agentNames` und hängt ` · <Agent> · Skills: a, b` an (`smallPlan` jetzt Pflichtparameter).
  - Renderer (sucher): Leitstand zeigt den Agenten schon (`apps/desktop/src/renderer/components/leitstand/Leitstand.tsx:646`,
    `lib/leitstand.ts:196`) inkl. `AgentSwitcher` → Schritt 4 ohne Änderung erledigt.
  - Dev-DB (read-only): alle 4 Profile global → Projekt-Bonus (+1000 im Rang) spielt im gemeldeten Fall keine Rolle.
  - Tests: `agent-profiles.test.ts` (Z. 28 → 10, neuer describe mit 7 Fällen), `planning-progress.test.ts` (planMessage).
    `pnpm --filter @multi-ai-coder/api test`: 22 Dateien / 132 Tests grün (8 skipped); api-typecheck sauber.
- 2026-10-20 Abschluss-Review (experte): alle Kriterien erfüllt; 1 medium-Mangel behoben: der additive Rang
  (`score*100 + priority + 1000·Projekt`) ließ eine Projektkopie des Frontend-Agent mit einem UI-Stichwort (1210) den
  globalen Doku-Agent mit Kategorietreffer (1020) schlagen; zudem konnte `priority` (UI −100..100, serverseitig
  ungeprüft) einen Kategorietreffer kippen. Neu: `bestProfile` vergleicht lexikografisch
  `[Kategorietreffer, Projekt, Score, Priorität]` (`agent-profiles.service.ts:118-136`, `CATEGORY_SCORE = 10` :93).
  Entscheidung: Projekt vor global bleibt bei reinen Stichwort-Treffern erhalten (unscharfes Signal → Nutzerprofil zählt);
  bestehender Test „project agent with the same keywords wins" bleibt grün. Zwei neue Tests (Ranking; Namen mit
  Leerzeichen/Regex-Zeichen). Nicht geändert (low): Stichwort-Treffer ≥ 9 entscheiden über Priorität; kein
  Integrationstest `plan()` → `agentId` (eine Zeile Verdrahtung, im Review geprüft). Rangfolge als Nachtrag in ADR-001.
  Hauptagent: `docs/ide-features.md:76` an die neue Reihenfolge angepasst. Selbst bestätigt:
  `pnpm --filter @multi-ai-coder/api test` 22 Dateien / 134 Tests grün (8 skipped), api-typecheck 0 Fehler.

## Ergebnis
Jeder Plan-Task bekommt seinen Agenten in der Reihenfolge Planner-Wahl (`planned.agent`, case-insensitiv, Projekt vor
global) → im Auftrag genau ein Profil namentlich genannt (nur 1-Task-Pläne) → Heuristik. In der Heuristik ist ein
Kategorie- oder Alias-Treffer (`CATEGORY_ALIASES`) unschlagbar: 10 Punkte, Stichwörter max. 9, Rang lexikografisch
(Kategorie > Projekt > Score > Priorität). Doku-Tasks voller UI-Wörter landen beim Doku-Agent – auch wenn eine
Projektkopie des Frontend-Agent existiert. Logik als reine Funktionen (`assignAgents`, `bestProfile`, `profileByName`,
`profilesNamedIn`) in `apps/api/src/agents/agent-profiles.service.ts`; `plan()` lädt die Profile einmal. Die Plan-Nachricht
zeigt `→ Premium · Doku-Agent · Skills: projekt-doku`. Keine Datenmigration; Renderer zeigte den Agenten schon.
Live mit Codex/Claude ungetestet (keine Freigabe) – TASK-006.

## Übergabe
Abgeschlossen 2026-10-20, nicht committet (zusammen mit TASK-001 uncommittet). Für die Folgetasks:
- TASK-003: `planned.skills` wird in `planMessage` noch ungefiltert angezeigt – beim Persistieren gegen den Katalog
  filtern und die Anzeige auf die gefilterte Liste umstellen.
- `PlannedTask.agent` wird nicht gespeichert, nur das aufgelöste `Subtask.agentId`.
- `match()` hat keinen produktiven Aufrufer mehr (nur Tests); bewusst behalten.
