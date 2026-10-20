---
id: TASK-006
titel: Gesamtverifikation Orchestrierung
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-20
phase: 6
abhaengig: TASK-001, TASK-002, TASK-003, TASK-004, TASK-005
plan: docs/ai/plans/2026-10-20-orchestrierung.md
---

# TASK-006: Gesamtverifikation Orchestrierung

## Ziel
Nachweisen, dass der Ausgangs-Prompt („Grundstruktur … Skill "projekt-doku" … Doku-Agent") einen feinen Plan mit korrekt
zugewiesenen Agenten und Skills ergibt – zuerst ohne Modellaufruf, dann (nur mit Zustimmung) live.

## Akzeptanzkriterien
- [x] `pnpm typecheck` und `pnpm test` grün (Ausgabe im Log zusammengefasst).
- [x] Migration im Dev-Profil angewendet, App startet (`pnpm dev`).
- [x] Prompt-Test ohne Modell: gerenderter Planner-Prompt für den Ausgangs-Prompt enthält Doku-Agent, Frontend-Agent und
      `projekt-doku (requested by the user)`.
- [x] **Nur nach Zustimmung des Nutzers** Live-Planung im Dev-App: mehrere kleine Tasks; Doku-Tasks → Doku-Agent mit Skill
      `projekt-doku`; kein Fallback.
- [ ] UI-Tasks → Frontend-Agent (live). **Akzeptiertes Restrisiko:** Der Live-Plan enthielt keine UI-Tasks. Die
      deterministische Zuordnung ist per Unit-Test belegt (`agent-profiles.test.ts`, gemischter Plan → `[docs, frontend]`),
      das Verhalten des Planners nicht (siehe Log, Review-Befund 3).
- [x] DB-Check read-only (Node `node:sqlite`, Kopie des Skripts im Log): `ModelCall` (purpose `plan`, status ok),
      `TaskPlan.source = codex|claude-code`, `Subtask.agentId/skills` plausibel.
- [x] Erkenntnisse in `docs/ai/lessons.md`, AI-Log-Eintrag, Masterplan als erledigt markiert.

## Plan
1. Tests/Typecheck laufen lassen, Fehler beheben (zurück in die jeweilige Phase loggen).
2. `prisma generate` + Migration (DLL-Lock beachten), App starten.
3. Nutzer um Freigabe für einen Live-Planungsaufruf bitten; sonst Nutzer den Prompt selbst ausführen lassen.
4. DB auswerten; Abweichungen als neue Tasks anlegen.

## Log
- 2026-10-20: Task angelegt.
- 2026-10-20 (Handoff nach TASK-005): noch nicht begonnen; offene Punkte aus TASK-005 in die Übergabe übernommen.
- 2026-10-20: Gestartet. Git-Stand = Übergabe (TASK-004/005 uncommitted, keine fremden Änderungen). Nutzerentscheidungen:
  TASK-005-Restpunkte (1)–(3) werden **eigene Tasks** (nicht in TASK-006); **ein** Live-Planungsaufruf ist freigegeben.
- 2026-10-20 Schritt 1 (Hauptagent): `pnpm --filter @multi-ai-coder/engine build` → ok; `pnpm typecheck` (Root) → exit 0;
  `pnpm test` (Root, alle Pakete zusammen) → exit 0: engine 26 Files / 238 grün, api 22 Files (+2 skipped) / 148 grün,
  8 skipped, desktop 12 Files / 73 grün, shared 3, plugin-sdk 4; agents/web/worker ohne Tests. Keine Flakes diesmal
  (engine-Lauf 154 s unter Volllast).
- 2026-10-20 Schritt 2 (Hauptagent): `pnpm prisma:generate` → erwarteter EPERM am DLL-Lock (Dev-App läuft) → Workaround
  aus CLAUDE.md (`schema.prisma` nach `.prisma/client` kopiert, `.tmp`-DLL gelöscht; `index.d.ts` neu, kennt `skills`).
  Migration read-only geprüft (`_mac_migrations`, nicht `_prisma_migrations` – eigener Migrator `runtime/migrator.ts`):
  `20261020120000_subtask_skills` angewendet 2026-10-20 11:44 UTC, Spalte `Subtask.skills` vorhanden.
  **Befund:** laufende Dev-Instanz (Electron PID 4028) gestartet 13:44, `dist/backend/boot.cjs` ebenfalls 13:44 – die
  TASK-004/005-Quellen sind von 13:55–14:21. Das Backend wird nur beim `pnpm dev`-Start gebündelt (`scripts/dev.mjs`),
  also läuft im Dev-App noch der alte Stand → vor dem Live-Test Neustart nötig.
- 2026-10-20 Prompt-Test ohne Modell (Hauptagent): Skript `render-plan-prompt.mjs` (Scratchpad, unten) rendert
  `planningPrompt` aus frischer engine-`dist` mit echten Dev-Daten: Agentenprofile aus der DB (enabled, role coder,
  global/Projekt), Skill-Katalog über `SkillsService.list` (api-`dist`, unverändert seit `61ba058`) mit Filter wie
  `AgentResourcesService.catalog`, `namesSkill` für `requested`. Projekt des Ausgangs-Tasks `cmvggdqn10002v2lknzi9llwg`.
  Ergebnis: OK `Doku-Agent`, OK `Frontend-Agent`, OK `projekt-doku (requested by the user)`, OK Pflichtregel
  „must appear on at least one task". Agenten: Frontend-, Doku-, Test-, Refactoring-Agent; 8 Skills, requested nur
  `projekt-doku`. Auffällig (kein Fehler): Profil Doku-Agent hat nur Skill `changelog`, `projekt-doku` kommt über die
  Task-Zuweisung des Planners.
  ```js
  // render-plan-prompt.mjs <repo> – read-only, kein Modellaufruf
  process.env.MAC_DATA_DIR = path.join(process.env.APPDATA, 'Multi-AI Coder Dev'); process.env.MAC_BUILTIN_SKILLS_DIR = path.join(repo, 'skills')
  const db = new DatabaseSync(path.join(dataDir, 'multi-ai-coder.db'), { readOnly: true })
  const prisma = { skillState: { findMany: async () => db.prepare('SELECT * FROM SkillState').all().map((r) => ({ ...r, enabled: !!r.enabled, agents: JSON.parse(r.agents) })) },
                   project: { findUnique: async ({ where }) => db.prepare('SELECT * FROM Project WHERE id = ?').get(where.id) ?? null } }
  const skills = (await new SkillsService(prisma, { publish() {} }).list(projectId))
    .filter((s) => !s.error && s.enabled && (s.agents.includes('*') || s.agents.includes('coder')))
    .map((s) => ({ name: s.name, description: s.description, requested: namesSkill(s.name, goal) })).sort((a, b) => Number(b.requested) - Number(a.requested)).slice(0, 40)
  const agents = db.prepare("SELECT * FROM AgentProfile WHERE enabled = 1 AND role = 'coder' AND (projectId IS NULL OR projectId = ?)").all(projectId)
  planningPrompt({ goal, costMode: 'balanced', maxTasks: 12, agents, skills, localModels: [...], context: { summary: '…', relevantFiles: [], validationCommands: [] } })
  ```
- 2026-10-20 Schritt 3 Live-Planung (Nutzer, freigegeben: genau ein Aufruf): Nutzer hat `pnpm dev` neu gestartet (Backend
  mit TASK-004/005 neu gebündelt) und im Projekt „MAVCP-Neues Testprojekt" den Ausgangs-Prompt eingegeben (mit
  Tippfehlern „mordernes", klein geschrieben), Plan nicht gestartet. Ich habe bewusst nicht selbst ausgelöst: Die Dev-Instanz
  gehört dem Nutzer, und der Desktop-Token der API ist nur dem Electron-Main bekannt.
- 2026-10-20 Schritt 4 DB-Check (Hauptagent, read-only, Skript unten): Task `cmvgoyfwk0001v2b81jk930l9` → `planned` /
  `awaiting_plan_approval`. Genau **ein** `ModelCall` seit Task-Anlage: purpose `plan`, provider `codex`, model
  `gpt-6-astra`, status `ok`, 20 794 in / 2 695 out Tokens, 56 s. `TaskPlan.source = codex`, kein Fallback. 5 Subtasks,
  alle `[Doku-Agent]`, `skills ["projekt-doku"]`, `local`, je **eine** neue Datei (`docs/vibe-coding.md`, dann je eine
  Datei für Task-Vorlage, AI-Log, Entscheidungen, Lessons; Tasks 2–5 hängen an task-001). `projekt-doku` stammt vom
  Planner selbst: `execution.service.ts:332–333` ergänzt angeforderte Skills nur bei Ein-Task-Plänen.
  Bewertung: Ziel erreicht. Vorher gab es einen Fallback mit 1 Task und invalid_output, jetzt 5 feine Einzeldatei-Tasks mit dem richtigen
  Agenten und Skill. **Nicht live belegt:** „UI-Tasks → Frontend-Agent". Der Planner hat „Grundstruktur" als
  Doku-Workflow gedeutet (Warnung 1: Vite-Grundstruktur existiert bereits, UI/Backend nicht spezifiziert), daher gibt es
  keine UI-Tasks. Die Zuordnung ist nur per Unit-Test belegt (`agent-profiles.test.ts`, `assignAgents`). Einen zweiten Aufruf
  habe ich nicht gemacht (Freigabe galt für einen). Beobachtungen ohne Handlungsbedarf: task-001 hat 3 bestehende Dateien
  in `relevantFiles` (= lesen *oder* bearbeiten, `prompts.ts:96`), das ist zulässig. Warnung 2 („die Agenten müssen die
  vollständigen projekt-doku-Anweisungen lesen") entspricht dem Design: gepinnte Skills werden dem Agenten inline geliefert (TASK-003).
  ```js
  // db-live-check.mjs <sinceMs> – read-only
  const tasks = db.prepare('SELECT id, userPrompt, status, currentStep, createdAt FROM Task WHERE createdAt > ? ORDER BY createdAt').all(since)
  // je Task:
  db.prepare('SELECT purpose, provider, model, status, errorClass, inputTokens, outputTokens, durationMs, createdAt FROM ModelCall WHERE createdAt > ? ORDER BY createdAt').all(task.createdAt)
  db.prepare('SELECT id, source, summary, dag, createdAt FROM TaskPlan WHERE taskId = ? ORDER BY createdAt').all(task.id)   // dag.warnings
  db.prepare('SELECT s.title, s.category, s.allowedFiles, s.newFiles, s.skills, s.suggestedExecutor, s.dependsOn, a.name AS agent FROM Subtask s LEFT JOIN AgentProfile a ON a.id = s.agentId WHERE s.taskId = ? ORDER BY s.createdAt').all(task.id)
  ```
  Hinweis: `ModelCall` hat keine `taskId`-Spalte (nur `executionId`/`sessionId`), Zuordnung hier über den Zeitraum.
- 2026-10-20 Abschluss-Review (`experte`, read-only): Kriterien 1–3 und 5 belegt, Kriterium 4 teilweise. Der Reviewer hat
  die Skripte selbst nachgeführt, dazu eine Gegenprobe mit dem echten `userPrompt` und der Agenten-Reihenfolge
  `priority desc, name asc` (4× OK). api-/engine-`dist` (14:59) sind neuer als die betroffenen Quellen. Die
  Zeitfenster-Zuordnung des ModelCalls ist belastbar: genau ein Call zwischen Task-Anlage und TaskPlan, keine parallele
  Planung. Befunde und Umgang damit:
  - muss: Kriterium 4 war abgehakt, obwohl der UI-Teil nicht belegt ist → aufgeteilt, UI-Teil offen als akzeptiertes
    Restrisiko.
  - sollte: **Die Herkunft des Agenten ist nicht belegbar.** `assignAgents` (`agent-profiles.service.ts:163–173`) nimmt das
    Planner-`agent`, sonst `bestProfile`. `category: documentation` → Alias `docs` liefert ebenfalls den Doku-Agent, und
    das rohe Planner-Feld `agent` wird nicht gespeichert (`dag` nur id/dependsOn, `execution.service.ts:386`). Meine
    Aussage oben gilt daher nur für die Skills („vom Planner"). Für den Agenten gilt nur „Ergebnis korrekt". Vorschlag für
    später: Planner-`agent` in `dag.tasks[].agent` mitspeichern (JSON, keine Migration).
  - sollte: Restrisiko `profileByName`: Schreibt der Planner bei einer UI-Task `agent: "Doku-Agent"`, gewinnt dieser
    ungeprüft (`agent-profiles.service.ts:170`). Das ist Modellverhalten und per Unit-Test nicht prüfbar. Der Prompt
    verlangt den passenden Agenten pro Task.
  - kann (umgesetzt, Hauptagent): Test `assigns a mixed plan by category although the request names the Doku-Agent` in
    `apps/api/src/agents/agent-profiles.test.ts` (nach dem Ein-Task-Fall): Ausgangs-Prompt, Plan
    `[documentation, react-ui]` mit leerem `agent` → `['docs', 'frontend']`. `vitest run src/agents/agent-profiles.test.ts`
    → 13/13 grün.
  - kann: Zeilenangabe korrigiert (`:332–333` statt `:331`).
  - kann: Bekannte Vereinfachungen von `render-plan-prompt.mjs`: rekonstruierter Prompt statt DB-`userPrompt`, Agenten
    ohne `ORDER BY`, ohne Skill-/Plugin-Kontext der Planner-Rolle (`execution.service.ts:258–264`), feste
    `costMode`/`maxTasks`/`localModels`. Der Skill-Katalog entspricht exakt `catalog().slice(0, 40)`. Auf die Checks haben
    die Abweichungen keinen Einfluss (Gegenprobe des Reviewers).
  - sollte: `## Ergebnis`/`## Übergabe` veraltet → aktualisiert.
  - TASK-007–009: Fundstellen korrekt. TASK-007 um die api-Stelle `recordPlanCall(…, 'error', …)` ergänzt.
  Folge-Tasks angelegt: TASK-007 (Token-meta), TASK-008 (mehrzeilige Antworten), TASK-009 (Test Chat-Antwortweg).

## Ergebnis
Phase 6 ist abgeschlossen, die Orchestrierungs-Phasen 1–6 sind verifiziert. `pnpm typecheck` und `pnpm test` im Root sind
grün. Die Migration `Subtask.skills` ist im Dev-Profil angewendet. Der gerenderte Planner-Prompt (echte Dev-Daten, ohne
Modell) enthält Doku-Agent, Frontend-Agent und `projekt-doku (requested by the user)`.
Live-Planung (ein freigegebener Codex-Aufruf, Nutzer im Dev-App): Für den Ausgangs-Prompt gab es vorher einen Fallback mit
1 Task. Jetzt liefert er 5 feine Einzeldatei-Tasks, alle Doku-Agent + `projekt-doku`, `source = codex`, ModelCall `ok`
mit Tokens, kein Fallback.
Offen als akzeptiertes Restrisiko: „UI-Tasks → Frontend-Agent" live (Plan ohne UI-Tasks; nur deterministisch per
Unit-Test belegt). Die Herkunft des Agenten (Planner vs. Kategorie-Heuristik) ist aus der DB nicht unterscheidbar.
Code-Änderung dieser Phase: nur ein neuer Test in `apps/api/src/agents/agent-profiles.test.ts` (gemischter Plan).
Folge-Tasks: TASK-007, TASK-008, TASK-009.

## Übergabe
Stand 2026-10-20: **done**. TASK-001–003 committet (`61ba058`, nicht gepusht); TASK-004/005/006 uncommitted in der
Arbeitskopie. Commit nur auf Nachfrage. Werkzeuge für spätere Checks (Scratchpad, Kern im Log):
`render-plan-prompt.mjs` (Prompt ohne Modell) und `db-live-check.mjs <sinceMs>` (read-only Plan-Auswertung).
Der Scratchpad gehört zu dieser Session und ist danach weg. Bei Bedarf die Skripte aus den Code-Blöcken im Log neu
anlegen.
Optionale Idee, noch ohne Task: Planner-`agent` in `TaskPlan.dag.tasks[].agent` mitspeichern, damit sich die Herkunft
einer Zuweisung belegen lässt (JSON, keine Migration). Nächste Kandidaten: TASK-007 (Token-meta bei Rückfragen, kostet
sonst unsichtbar Kontingent), TASK-009 (Test), TASK-008 (UI).
