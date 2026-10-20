# Masterplan: Orchestrierung, Skill-Nutzung und Agenten-Zuweisung

Stand: 2026-10-20 · Tasks: TASK-001 … TASK-006 · Entscheidungen: ADR-001 … ADR-003

## Ausgangslage

Prompt im Dev-Profil: „Erstelle eine Grundstruktur für modernes Vibe Coding. Nutze den Skill "projekt-doku"
und einen Doku-Agent." Ergebnis: Fallback-Plan mit einem Haupt-Task, Warnung
`OpenAI Codex planning failed (invalid_output): The plan contained no usable tasks.` Erst nach mehreren
Anläufen wurde überhaupt ein anderer Agent als der Frontend-Agent genutzt; Pläne enthalten nur 1–5 grobe Tasks.

## Befund (Dev-DB `%APPDATA%\Multi-AI Coder Dev\multi-ai-coder.db`, read-only ausgewertet)

| Tabelle | Beobachtung |
|---|---|
| `ModelCall` (purpose `plan`) | 2× `codex` `error` / `invalid_output` nach ~17 s; dazwischen 1× ok (1314 Output-Tokens) |
| `TaskPlan` (codex, ok) | Summary: „Der angeforderte Skill ‚projekt-doku' fehlt … Ausführung wartet auf die Skill-Anleitung" – nur 1 Task; Warnung „Umgebung erlaubt nur Lesezugriffe" |
| `Subtask` | `documentation`-Task → **Frontend-Agent**; frühere Pläne: alle Tasks Frontend-Agent |
| `AgentProfile` | Frontend (prio 10, Skills `einzigartiges-webdesign, code-review, ui-tailwind, ui-design`), Doku (prio 20, Skills nur `changelog`), Test, Refactoring |
| Skill `projekt-doku` | `%APPDATA%\Multi-AI Coder Dev\skills\projekt-doku`, Standard-Frontmatter ohne `triggers`, `agents` = `*` |

## Ursachen

1. **Planner kennt weder Agenten noch Skills.** `planningPrompt` (`packages/engine/src/orchestrator/prompts.ts`) enthält
   keinen Agenten-Katalog. Skills gelangen nur über `agentResources.promptContext('planner', …)` hinein, und dort nur bei
   `skillRelevance > 0` (kein Index, `canLoad: false`). Codex wartet deshalb auf einen „fehlenden" Skill und liefert
   `tasks: []` → `normalizePlan` (`schemas.ts:214`) wirft `invalid_output` → `deterministicPlan` (Ein-Task-Fallback).
2. **Skill-Name wird nicht erkannt.** `skillRelevance` (`apps/api/src/skills/skill-format.ts:108`) trennt Wörter an allem
   außer `-`, prüft aber nur Namensteile (`projekt`, `doku`). Das Wort `projekt-doku` erzielt 0 Punkte.
3. **Agenten-Zuordnung bevorzugt das Frontend.** `profileMatches` (`apps/api/src/agents/agent-profiles.service.ts:86`):
   Kategorietreffer = 3 Punkte, jedes Stichwort im Text = 2 (Teilstring = 1). Ein `documentation`-Task, der „Dashboard,
   Tailwind, Komponente" erwähnt, landet beim Frontend-Agent. Planner-Kategorien (`TASK_CATEGORIES`: `react-ui`,
   `styling`, `frontend-logic`, `api-endpoint`, …) stehen in keiner Agenten-Kategorieliste.
4. **Agenten-Skills sind exklusiv.** `AgentResourcesService.forAgent` übergibt `profile.skills` als `only`-Filter an
   `SkillsService.promptContext/agentTools` → der Doku-Agent sieht `projekt-doku` nie.
5. **Prompt erzwingt große Tasks.** `ORCHESTRATOR_SYSTEM_PROMPT`: „keep a small cohesive change in ONE task … Split only
   for independent work" (Latenz-Optimierung vom 2026-10-15) widerspricht der Regel „präzise Einzeldatei-Tasks für kleine
   Modelle". Default `maxTasks` = 8 (`apps/api/src/runtime/settings.service.ts:87`).

## Entscheidungen

- ADR-001: Der Planner weist pro Task Agent + Skills zu; die Stichwort-Heuristik ist nur Fallback.
- ADR-002: Leerer Plan mit Rückfragen → Rückfragen im Chat zeigen, kein Retry, kein Fallback-Plan.
- ADR-003: Feine Zerlegung (1 Task ≈ 1 Datei), `maxTasks`-Default 12.

## Phasen

| Phase | Task | Inhalt | Abhängig von |
|---|---|---|---|
| 1 | TASK-001 | Planner bekommt Agenten- und Skill-Katalog; Plan-Tasks tragen `agent` + `skills`; Skill-Name-Matching | – |
| 2 | TASK-002 | Agenten-Zuweisung: Planner-Agent → genannter Agent → verbesserte Heuristik; Plan-Nachricht zeigt Agent/Skills | 1 |
| 3 | TASK-003 | `Subtask.skills` (Migration) → `EngineTask.skills` → gepinnte Skills erreichen den Agenten | 1 |
| 4 | TASK-004 | Feinere Zerlegung im Prompt, `maxTasks` 12 | – (am besten nach 1) |
| 5 | TASK-005 | Leerer Plan → `needs_clarification` → Rückfragen im Chat + „Antworten & neu planen" | – |
| 6 | TASK-006 | Gesamtverifikation, Live-Planung nur mit Zustimmung | 1–5 |

Details, Dateien und Akzeptanzkriterien stehen in den Task-Files `docs/ai/tasks/TASK-00N-*.md`.

## Gemeinsame Regeln für alle Phasen

- Pro Phase: Code + Tests, dann `pnpm --filter @multi-ai-coder/engine test` / `pnpm --filter @multi-ai-coder/api test`
  und `pnpm typecheck`; Ergebnis im Task-Log festhalten.
- Keine Live-Aufrufe von `claude`/`codex` (kostet Kontingent) ohne Zustimmung; Prompts per Unit-Test prüfen.
- Strict JSON-Schema beibehalten: neue Felder in `PLAN_SCHEMA` immer in `required`, `additionalProperties: false`.
- Migrationen nur additiv, SQLite-Syntax wie `prisma/migrations/20261013120000_agent_limits/migration.sql`.
- Bestehende Agentenprofile in der DB nicht migrieren; Verbesserungen müssen auch mit den gespeicherten Kategorien wirken.
