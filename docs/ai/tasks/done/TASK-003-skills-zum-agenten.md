---
id: TASK-003
titel: Skills erreichen den ausführenden Agenten
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-20
phase: 3
abhaengig: TASK-001
plan: docs/ai/plans/2026-10-20-orchestrierung.md
---

# TASK-003: Skills erreichen den ausführenden Agenten

## Ziel
Die vom Planner pro Task gewählten und die im Task-Text namentlich genannten Skills („gepinnte Skills") werden dem
ausführenden Agenten (lokal und Premium) immer mitgegeben – auch wenn sie nicht in der Skill-Liste seines Profils stehen.
Die Profil-Skills bleiben die Auswahl für die automatische Relevanz-Suche.

## Akzeptanzkriterien
- [x] Prisma: `Subtask.skills Json @default("[]")` + additive Migration; `prisma generate` erfolgreich.
- [x] Beim Anlegen der Subtasks werden nur Namen existierender, aktiver Skills gespeichert.
- [x] `EngineTask.skills?: string[]`; `engineTasks()` füllt es; der `agentResources`-Callback in `runJob` reicht es weiter.
- [x] `SkillsService.forRole/promptContext/agentTools` und `AgentResourcesService.forAgent` kennen `pinned: string[]`:
      gepinnte Skills umgehen den `only`-Filter, stehen vorne, werden inline gesetzt; passt das Budget nicht → im Index
      und `requiredTools: ['load_skill']`. `agentTools` erhält `only ∪ pinned`, damit `load_skill` sie findet.
- [x] Premium-Ausführung bekommt die Skills über `guidance` (bestehender Pfad `packages/engine/src/engine/execution.ts:926`).
- [x] Tests grün; neuer Fall: Doku-Agent (Profil-Skills `changelog`) + gepinnt `projekt-doku` → beide verfügbar.

## Plan
1. `prisma/schema.prisma` Model `Subtask`: `skills Json @default("[]")` (Kommentar wie bei `agentId`).
   Migration `prisma/migrations/20261020120000_subtask_skills/migration.sql`:
   `ALTER TABLE "Subtask" ADD COLUMN "skills" JSONB NOT NULL DEFAULT '[]';`
   `pnpm prisma:generate` – bei laufendem `pnpm dev` DLL-Lock-Workaround (CLAUDE.md).
2. `apps/api/src/execution/execution.service.ts`
   - `plan()`: `skills: asJson(planned.skills.filter(known))` beim `subtask.create`.
   - `engineTasks()`: `skills: stringList(subtask.skills)`.
   - `runJob` → `agentResources`-Callback: `pinned: task.skills ?? []` an `forAgent` übergeben.
3. `packages/engine/src/engine/execution.ts:26` `EngineTask` += `skills?: string[]`.
4. `apps/api/src/skills/skills.service.ts`
   - `forRole(role, projectId, goal, only?, pinned?)`: Filter `(!only?.length || only.includes(name) || pinned?.includes(name))`;
     Score gepinnter Skills mindestens 100.
   - `promptContext(..., { pinned })` und `agentTools(..., only, pinned)` entsprechend.
   - Im Task-Text genannte Skills über `skillRelevance >= 10` (aus TASK-001) ebenfalls als gepinnt behandeln.
5. `apps/api/src/agents/agent-resources.service.ts` `forAgent`: Input `pinned?: string[]`, durchreichen; `only` bleibt `profile.skills`.
6. Tests: `apps/api/src/skills/skills.test.ts`, ggf. `packages/engine/src/engine/execution.test.ts` (Feld wird durchgereicht).

## Log
- 2026-10-20: Task angelegt. Ursache: `forAgent` nutzt `profile.skills` als exklusiven Filter (Doku-Agent hat nur `changelog`).
- 2026-10-20 (aus TASK-001): Genannte Skills mit `namesSkill(name, goal)` (`apps/api/src/skills/skill-format.ts`) erkennen –
  Einwort-Namen nur mit Markierung. `planned.skills` gegen aktive Skills filtern (Planner kann Namen erfinden).
  `SkillsService.promptContext` hat jetzt `exclude` (Planner bekommt angeforderte Skills nicht inline) – bei `pinned`
  beachten, dass sich die Optionen nicht widersprechen.
- 2026-10-20 (aus TASK-002): Subtasks entstehen in `ExecutionService.plan()` (`apps/api/src/execution/execution.service.ts`
  ~Z. 297: `assignAgents` + `prisma.subtask.create` in einer Transaktion) – dort `skills` mitschreiben. `planMessage`
  (~Z. 390) hängt ` · Skills: …` aus `task.skills` an → auf die gefilterte Liste umstellen.
- 2026-10-20 Umsetzung (Subagent `experte`, vom Hauptagent spezifiziert und geprüft):
  - `prisma/schema.prisma:293` `Subtask.skills Json @default("[]")`; Migration
    `prisma/migrations/20261020120000_subtask_skills/migration.sql` (ADD COLUMN). `pnpm prisma:generate` ohne DLL-Lock ok.
  - `packages/engine/src/engine/execution.ts:47` `EngineTask.skills?: string[]`; engine-dist neu gebaut.
  - `apps/api/src/skills/skills.service.ts:335ff` `forRole(…, only?, pinned?)`: gepinnt = `pinned` **oder**
    `namesSkill(name, goal)`; umgeht `only`, Score `max(score, 100)`; Rollen-/enabled-Filter gelten weiter.
    `promptContext` Option `pinned`, `exclude` unverändert danach.
  - `apps/api/src/agents/agent-resources.service.ts:34-45` `forAgent` Input `pinned`; `agentTools` bekommt als `only`
    die präsentierten Namen (`inlined ∪ indexed`).
  - `apps/api/src/execution/execution.service.ts:195` `activeSkillsPromise` = `catalog(…, Infinity)`, Planner sieht
    weiter `.slice(0, 40)`; `:299-304` Skills pro Task gegen aktive Skills gefiltert + dedupliziert, Ein-Task-Pläne erben
    im Prompt genannte Skills; `plan` wird neu zugewiesen → DB und `planMessage` zeigen dieselbe Liste; `:313`
    `skills` in `subtask.create`; `:451` `engineTasks()`; `:634` `pinned: task.skills ?? []` im Callback.
  - Premium-Pfad (`execution.ts:920-926`) unverändert: derselbe Callback (`supportsTools: false`) → `guidance`.
  - Entscheidungen: „genannt" über `namesSkill`, nicht `skillRelevance >= 10` (zählt sonst zufällige Einwort-Treffer,
    Lesson 3). `agentTools` ohne neuen `pinned`-Parameter (Abweichung vom Plan): präsentierte Namen sind genau
    `only ∪ pinned ∪ genannt` und konsistent mit dem Prompt. Ein-Task-Regel analog `assignAgents`.
  - Tests: `skills.test.ts` Block „pinned skills" (Doku-Agent `changelog` + gepinnt `projekt-doku` → beide; Budget
    gesprengt → Index + `load_skill`; im Text genannt; `only` exklusiv ohne Pins; `forAgent` → `load_skill` findet
    gepinnte, nicht Profil-fremde); `planning-progress.test.ts` `plan()` speichert nur bekannte Skills, Ein-Task-Plan
    erbt genannten Skill, Mehr-Task-Plan nicht. engine 230 grün, api 140 grün/8 skipped, typecheck sauber.
- 2026-10-20 Nachbesserung (Hauptagent): Bei `canLoad: false` (Structured-Output-Modelle, Premium) wurde für einen
  Skill über Budget `requiresSkillLoad` true → lokaler Task scheitert hart („Required task tools are unavailable",
  `local-agent.ts:450`), Premium verliert den Skill still. Fix `skills.service.ts`: `forRole` liefert `pinned`-Flag;
  ohne `canLoad` werden gepinnte Skills auch über Budget inline gesetzt; `requiresSkillLoad = canLoad && …` (behebt auch
  den Altfall für nur relevante Skills). Neuer Test „stay inline beyond the budget…". api 141 grün/8 skipped, typecheck sauber.
  Offen gelassen: Profil mit `permissions.externalTools === false` entfernt Tools (`execution.ts:843`), `requiredTools`
  kann trotzdem `load_skill` enthalten (vorbestehend).
- 2026-10-20 Abschluss-Review (`experte`): alle 6 Akzeptanzkriterien erfüllt, nichts blockierend. „Sollte behoben werden":
  (1) Planner kann Skills anheften, deren Rolle `coder` nicht enthält → gespeichert/angezeigt, erreichen den Coder nie;
  (2) `externalTools: false` + gepinnter Skill über Budget → harter Abbruch. Testlücken: `engineTasks()`-Durchreichung.
  Optional, bewusst offen gelassen (siehe Übergabe): Inline ohne `canLoad` unbegrenzt; Bindestrich-Namen pinnen auch bei
  beiläufiger Nennung (`namesSkill`-Regel aus TASK-001); genannter Skill kann bei Mehr-Task-Plänen verloren gehen;
  `catalog()`-Fehler leert still alle Pins.
- 2026-10-20 Review-Fixes (`entwickler`, vom Hauptagent geprüft):
  - `apps/api/src/agents/agent-resources.service.ts:105-106` `catalog()` nur Skills mit Rolle `*`/`coder`
    (Variante gewählt statt Rollenfilter-Bypass in `forRole`: die Rollenwahl des Nutzers ist explizit und geht vor der
    Planner-Wahl). Test im catalog-Test (`skills.test.ts` ~Z.235): `agents: [chat]` → nicht im Katalog.
  - `packages/engine/src/engine/execution.ts:825-827` agentResources mit `supportsTools: toolCalling && externalTools !== false`
    → Skills kommen dann inline. Engine-Test „asks for inline skills (supportsTools false) when the agent has no external tools…".
  - `planning-progress.test.ts` „hands the pinned skills of a subtask to the engine task" (`engineTasks()`).
  - `execution.service.ts:635` Leerzeichen.
  - Selbst bestätigt: engine 231 grün, api 142 grün / 8 skipped, `pnpm typecheck` alle Pakete Done.

## Ergebnis
Subtasks speichern gepinnte Skills (`Subtask.skills`, additive Migration): die vom Planner gewählten, gefiltert auf
aktive Coder-Skills, bei Ein-Task-Plänen plus die im Nutzer-Prompt genannten. Sie gehen als `EngineTask.skills` →
`pinned` an `forAgent`, umgehen den Profil-Filter, stehen vorne und werden inline gesetzt; passt das Budget nicht, gibt
es sie über `load_skill` (lokale Tool-Agenten) bzw. trotzdem inline (Structured-Agenten, Premium-`guidance`, Agenten
ohne externe Tools). Im Task-Text genannte Skills (`namesSkill`) gelten ebenfalls als gepinnt. Nebenbei behoben: ohne
Tool-Calling verlangte ein großer relevanter Skill `load_skill` und ließ den Task hart scheitern. Live-Verhalten
ungetestet (keine Freigabe) → TASK-006.

## Übergabe
Abgeschlossen 2026-10-20, nicht committet (Commit nur auf Nachfrage). Zusätzlich zu den TASK-001/002-Dateien geändert:
`prisma/schema.prisma`, `prisma/migrations/20261020120000_subtask_skills/` (neu), `packages/engine/src/engine/execution.ts`,
`packages/engine/src/engine/execution.test.ts`. Die Migration ist auf der Dev-DB noch nicht angewandt (passiert beim
nächsten App-Start bzw. `prisma migrate`).
Bewusst offen (Kandidaten für TASK-006 oder später):
- Ohne `canLoad` ist der Inline-Umfang gepinnter Skills unbegrenzt (mehrere große Skills können `numCtx` kleiner Modelle
  sprengen) – ggf. Obergrenze `budgetChars * 3` mit Warnung in `sources`.
- `namesSkill` pinnt Bindestrich-Namen auch bei beiläufiger Nennung („code-review", Pfade `src/ui-design/`) und umgeht
  damit den Profil-Filter; ggf. nur markierte Nennungen pinnen.
- Mehr-Task-Pläne: ein im Prompt genannter Skill, den der Planner keinem Task gibt, geht verloren → ggf. Warnung im Plan.
- `catalog()`-Fehler (`execution.service.ts:196` `.catch(() => [])`) leert still alle Pins und das `exclude`.
- Kein UI, um Subtask-Skills manuell zu ändern (ADR-001 „manuelle Wahl gewinnt").
