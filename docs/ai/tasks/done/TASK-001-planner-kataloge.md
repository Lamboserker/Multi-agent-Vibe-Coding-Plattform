---
id: TASK-001
titel: Planner kennt Agenten und Skills
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-20
phase: 1
plan: docs/ai/plans/2026-10-20-orchestrierung.md
---

# TASK-001: Planner kennt Agenten und Skills

## Ziel
Der Premium-Planner (Codex/Claude Code/Plugin) sieht alle aktiven Agentenprofile und Skills und gibt pro Task an,
welcher Agent ihn ausführt und welche Skills er braucht. Ein vom Nutzer genannter Skill (z. B. `"projekt-doku"`)
wird erkannt, statt dass der Planner auf ihn „wartet" und einen leeren Plan liefert.

## Akzeptanzkriterien
- [x] `PlannedTask` hat `agent: string` und `skills: string[]`; `PLAN_SCHEMA` führt beide als `required`.
- [x] `normalizePlan` übernimmt sie (getrimmt, `skills` ≤ 8, Defaults `''`/`[]`); fehlende Felder brechen nichts.
- [x] `planningPrompt` enthält `# Available agents` und `# Available skills` (Beschreibung ≤ ~200 Zeichen, angeforderte
      Skills mit „(requested by the user)") plus Regeln: Agent exakt benennen oder `""`; benötigte Skills pro Task listen;
      angeforderter Skill auf mind. einem Task; Skills nie selbst anwenden und nie darauf warten.
- [x] `skillRelevance` gibt für den vollständigen Skill-Namen im Text +10 (`Nutze den Skill "projekt-doku"` > 0).
- [x] `ExecutionService.plan()` baut die Kataloge und übergibt sie; Fallback- und Fast-Path-Plan setzen `agent: ''`, `skills: []`.
- [x] Tests grün: engine (schemas, prompts), api (skill-format/skills).

## Plan
1. `packages/engine/src/orchestrator/types.ts`
   - `PlanningInput` += `agents?: Array<{ name: string; description: string; categories: string[]; skills: string[] }>`
     und `skills?: Array<{ name: string; description: string; requested: boolean }>`.
   - `PlannedTask` += `agent: string`, `skills: string[]`.
2. `packages/engine/src/orchestrator/schemas.ts`: in `PLAN_SCHEMA.tasks.items` `agent: { type: 'string' }`,
   `skills: stringArray` + in `required`. `normalizePlan`: `agent: str(task.agent).slice(0, 80)`, `skills: strList(task.skills, 8)`.
3. `packages/engine/src/orchestrator/prompts.ts` `planningPrompt`: Abschnitte nach `# Available local models` einfügen
   (nur wenn Listen nicht leer). Regeln in `# Planning rules` ergänzen (siehe Akzeptanzkriterien).
4. `packages/engine/src/planning/fallback-planner.ts`: alle erzeugten Tasks mit `agent: ''`, `skills: []`.
   Ebenso der Fast-Path-Plan in `apps/api/src/execution/execution.service.ts` (~Zeile 212).
5. `apps/api/src/skills/skill-format.ts` `skillRelevance`: `if (words.has(meta.name) || text.includes(meta.name)) score += 10`.
6. `apps/api/src/execution/execution.service.ts` `plan()`: parallel zu den anderen Vorbereitungen laden
   - Agenten: `this.agentProfiles?.list(task.projectId)` → `enabled && role === 'coder'` → `{ name, description, categories, skills }`.
   - Skills: `SkillsService.list(projectId)` (über `AgentResourcesService` einen Helfer `catalog(projectId, goal)` anbieten:
     aktive, fehlerfreie Skills, `requested = skillRelevance(...) >= 10`).
   - an `orchestrator.createPlan({ …, agents, skills })` übergeben. Der Plugin-Pfad (`apps/api/src/orchestration/orchestrator.service.ts:103`) reicht das Input-Objekt durch – prüfen.
7. Tests: `packages/engine/src/orchestrator/*.test.ts` (Schema/normalizePlan/Prompt-Inhalt), `apps/api/src/skills/skills.test.ts`
   (Skill mit Namen in Anführungszeichen wird inlined).

## Log
- 2026-10-20: Task angelegt aus der Analyse (siehe Masterplan, Ursachen 1 und 2).
- 2026-10-20 (Hauptagent, Schritte 1–6 selbst umgesetzt – klein und mit bereits gesichtetem Kontext, Delegation hätte mehr gekostet):
  - `packages/engine/src/orchestrator/types.ts`: neue Typen `AgentOffer`, `SkillOffer` (exportiert über `index.ts`),
    `PlanningInput.agents?`/`skills?`, `PlannedTask.agent`/`skills`.
  - `schemas.ts`: `PLAN_SCHEMA` Task-Items + `agent`/`skills` in `properties` und `required`; `normalizePlan`
    `agent: str(...).slice(0, 80)`, `skills: strList(..., 8)` (fehlende Felder → `''`/`[]`).
  - `prompts.ts`: Helfer `clip()` (Whitespace glätten, ≤ 200 Zeichen mit „…"); `planningPrompt` hängt nach
    `# Available local models` `# Available agents` / `# Available skills` an (nur wenn nicht leer; angeforderte Skills
    mit „(requested by the user)"). Regeln in `# Planning rules`: Agent exakt oder `""`; Skills exakt pro Task (0–2);
    angeforderter Skill auf mind. einem Task; Skills nie selbst anwenden, nie darauf warten, nie deshalb leerer Plan.
    Ohne Kataloge: `"agent": always ""` / `"skills": always []` (strict schema verlangt die Felder trotzdem).
  - `fallback-planner.ts` (3 Tasks) und Fast-Path in `execution.service.ts`: `agent: ''`, `skills: []`.
  - `apps/api/src/skills/skill-format.ts` `skillRelevance`: +10 bei `words.has(meta.name)`. **Abweichung vom Plan:**
    kein `text.includes(meta.name)` – Teilstring-Treffer (Skill `test` in „testing") wären falsch-positiv; die
    Wortzerlegung behält `-`, `"projekt-doku"` wird als ganzes Wort erkannt.
  - `apps/api/src/agents/agent-resources.service.ts`: `catalog(projectId, goal, limit = 40)` – aktive, fehlerfreie Skills
    (rollenunabhängig, weil der Planner sie Coder-Tasks zuweist), `requested = skillRelevance >= 10`, angeforderte zuerst.
  - `execution.service.ts` `plan()`: `agentCatalogPromise` (enabled + role `coder`) und `skillCatalogPromise` starten
    parallel zu den übrigen Vorbereitungen, werden nur im Orchestrator-Zweig awaited, Fehler → `[]`; Übergabe an
    `createPlan({ …, agents, skills })`. Plugin-Pfad (`orchestration/orchestrator.service.ts:103`) reicht `input` durch.
  - Prüfung: `git diff` zeigt nur eigene Änderungen. `pnpm typecheck` zunächst rot in api (engine-`dist` veraltet) →
    `pnpm --filter @multi-ai-coder/engine build` + `pnpm --filter @multi-ai-coder/api typecheck` grün.
- 2026-10-20 (Schritt 7, `entwickler`; vom Hauptagent per Diff und eigenem Testlauf geprüft):
  - `packages/engine/src/orchestrator/prompts.test.ts:21-47`: Prompt mit Katalogen (Abschnitte, „(requested by the user)",
    Pflicht-/Warte-Regel, Kürzung > 200 Zeichen mit „…", Agentenzeile mit categories/skills) und ohne Kataloge
    (keine Abschnitte, `"agent": always ""`, `"skills": always []`).
  - `packages/engine/src/planning/planning.test.ts`: `PLAN_SCHEMA` Task-Items strict (properties == required,
    `additionalProperties: false`, inkl. agent/skills); `normalizePlan` trimmt agent, skills ≤ 8 ohne Leere, Defaults
    `''`/`[]`; `deterministicPlan` liefert `agent: ''`, `skills: []`.
  - `apps/api/src/skills/skills.test.ts:63-67`: `Nutze den Skill "projekt-doku"` ≥ 10, „Doku zum Projekt" < 10;
    `:193-203` `AgentResourcesService.catalog`: genannter Skill `deploy` zuerst + einziger requested, kaputter Skill
    `broken` und deaktivierter `code-review` fehlen (Fixtures existieren, Assertions nicht leer), Limit greift.
  - Testlauf (selbst): engine 25 Dateien / 229 Tests grün; api 22 Dateien grün, 2 übersprungen / 122 grün, 8 übersprungen
    (vorbestehende Skips). Keine Fixture-Anpassungen nötig.
- 2026-10-20 (Abschluss-Review `experte`): alle AC formal erfüllt, Schema strict, keine unbehandelten Rejections, kein
  anderer Plan-Erzeuger bricht (Plugin-Pfad normalisiert, Defaults greifen). Befunde:
  1. **major** – durch +10 landet ein genannter Skill (Dev-Profil `projekt-doku`, 7910 Zeichen < 8000 Budget) per
     `promptContext('planner')` als „## Relevant skills (follow these instructions)" im Planner-Prompt – Widerspruch zur
     neuen Regel „never apply a skill yourself" und genau das ursprüngliche Fehlerbild.
  2. minor – Ganzwort-Matching verpasst `projekt-doku-Skill`.
  3. minor – Einwort-Namen (`changelog` in „Fix the changelog link") würden als „requested" erzwungen.
  4. minor – Agentenkatalog im Prompt unbegrenzt.
  5. minor – Verdrahtung in `plan()` ungetestet.
- 2026-10-20 (Hauptagent, Fixes 1–4; Tests `entwickler`, vom Hauptagent geprüft):
  - Fix 1, Variante (a): `SkillsService.promptContext` Option `exclude` (`apps/api/src/skills/skills.service.ts:348-349`),
    `AgentResourcesService.promptContext(..., exclude?)`; in `plan()` wird der Planner-Skillkontext aus dem Katalog
    abgeleitet und schließt angeforderte Skills aus (`execution.service.ts:~190-200`). Angeforderte Skills sieht der
    Planner nur noch als Katalogzeile. **Verworfen:** Variante (b) „nur Skills mit explizitem `planner`" – hätte das
    bestehende Verhalten für `'*'`-Skills (z. B. ui-design hilft präzise UI-Tasks zu planen) geändert.
  - Fix 2+3: neue Funktion `namesSkill(name, goal)` in `apps/api/src/skills/skill-format.ts` – Name mit `-` als ganzes
    Wort oder `<name>-skill(s)`; Einwort-Name nur markiert (Anführungszeichen, Backticks, `/`, „Skill x", „x-Skill").
    `catalog()` setzt `requested = namesSkill(...)`; `skillRelevance` +10 bei `words.has(name) || namesSkill(...)`.
  - Fix 4: `planningPrompt` begrenzt auf 20 Agenten, 40 Skills, je Agent 12 categories / 12 skills (`prompts.ts:~47-52`).
  - Tests (`entwickler`): `skills.test.ts` – `namesSkill` 9 positive / 5 negative Fälle (u. a. `redeploy`, `add tests`,
    `ui-design-system` → false), `exclude` lässt Skill aus inlined/indexed/text, catalog: `changelog` bei „Fix the
    changelog link" nicht requested; `prompts.test.ts` – Kappung 20 Agenten / 12 categories;
    `execution/planning-progress.test.ts` – `plan()` übergibt nur aktive Coder-Agenten + Katalog, ruft `promptContext`
    mit `exclude ['projekt-doku']`, Kontext ohne `### Skill: projekt-doku` (Fake-`createPlan` bricht mit `cancelled` ab,
    damit kein Speicher-Mocking nötig ist). Nicht abgedeckt: Skill-Limit 40 und 12 skills pro Agent (trivial `slice`).
  - Prüfung (selbst): engine 25 Dateien / 230 Tests grün; api 22 grün + 2 übersprungen / 125 grün + 8 übersprungen;
    `pnpm typecheck` alle 8 Projekte Done; `pnpm lint` grün. Kein zweites `experte`-Review der Fixes (klein, je durch
    Tests belegt) – bewusst, um Kosten zu sparen.

## Ergebnis
Der Premium-Planner bekommt `# Available agents` (aktive Coder-Profile) und `# Available skills` (aktive, fehlerfreie
Skills; ausdrücklich genannte als „(requested by the user)") und gibt pro Task `agent` und `skills` zurück
(`PLAN_SCHEMA` strict, `normalizePlan` mit Defaults). Ein genannter Skill wie `"projekt-doku"` wird erkannt
(`namesSkill`), muss auf mindestens einem Task stehen und wird dem Planner nicht mehr als „follow these instructions"
untergeschoben. Fallback-/Fast-Path-Pläne setzen `agent: ''`, `skills: []`. Die Felder werden noch **nicht** an Subtasks
gespeichert oder ausgewertet – das ist TASK-002 (Agent) und TASK-003 (Skills). Live-Verhalten mit Codex/Claude
ungetestet (keine Freigabe für bezahlte Aufrufe) – gehört in TASK-006.

## Übergabe
Abgeschlossen 2026-10-20, nicht committet (Commit nur auf Nachfrage). Für die Folgetasks:
- TASK-002: `PlannedTask.agent` ist der Profil-**Name** (nicht eindeutig: global + Projekt können gleich heißen) –
  beim Auflösen Projektprofil vor globalem, sonst `agentProfiles.match()` als Fallback.
- TASK-003: „im Task-Text genannte Skills" mit `namesSkill()` (`apps/api/src/skills/skill-format.ts`) erkennen, nicht mit
  `skillRelevance`. `planned.skills` gegen den Katalog filtern (Planner kann Namen erfinden).
- api-Typecheck/-Tests lesen die engine-`dist`: nach Engine-Änderungen erst `pnpm --filter @multi-ai-coder/engine build`.
