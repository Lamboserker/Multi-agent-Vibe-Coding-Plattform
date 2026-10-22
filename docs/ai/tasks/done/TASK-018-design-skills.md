---
id: TASK-018
titel: Design-Skills und Rolle designer
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-21
phase: 6
abhaengig: –
plan: plans/2026-10-21-design-phase.md
---

# TASK-018: Design-Skills und Rolle designer

## Ziel
Sechs mitgelieferte Design-Skills (Dashboard, CRM, Landingpage, SaaS-App, Admin/Formulare, E-Commerce) und eine neue
Skill-Rolle `designer` für den Premium-Designer der Design-Phase.

## Akzeptanzkriterien
- [x] `skills/design-{dashboard,crm,landing-page,saas-app,admin-forms,ecommerce}/SKILL.md`: DE+EN-Trigger, Layout,
      Pflicht-Komponenten, Zustände, Modern look, Planungsrezept, test-task; je ≤ 3,5k Zeichen (2,5–2,8k).
- [x] `ui-design` verweist auf `design/tokens.css`, wenn vorhanden.
- [x] Rolle `designer` in `AGENT_ROLES` (deckt updateState, MCP-Validierung, Controller ab) und `SkillsPanel` ROLES.
- [x] Tests in `skills.test.ts`: Parsen/Größe/Trigger, testSkill je Skill, Designer-Kontext CRM/Landingpage, Rolle.
- [x] api-Tests (172/8 skipped), api- und desktop-typecheck grün.

## Log
- 2026-10-21 (entwickler): Skills, Rolle, Tests, `docs/skills-mcp.md` Rollentabelle. Token-Namen der Skills gegen
  `ui-design` geprüft (Hauptagent): alle definiert.
- 2026-10-21 (Hauptagent): Nebenwirkung – Planner-Test „reach the planner" (Dashboard + Bootstrap) scheiterte, weil
  `design-dashboard` (2,7k) `ui-bootstrap` aus dem 8000-Zeichen-Budget verdrängte. Der Subagent hatte nur das Test-Budget
  erhöht. Korrigiert in der Produktion: `AgentResourcesService.promptContext` (Planner/Chat) 8000 → 12000, Test und
  `docs/skills-mcp.md` angeglichen. `src/skills` + `src/agents` 44/44 grün.

## Ergebnis
Design-Skills und Rolle `designer` stehen; Premium-Prompts bekommen bis zu 12000 Zeichen Skill-Text.

## Übergabe
Restrisiko: lokale Coder ohne Tools haben weiter 8000 Zeichen Budget (`forAgent`); bei UI-Tasks konkurrieren ui-design,
design-* und ui-bootstrap/-tailwind – gepinnte Skills ignorieren das Budget ohnehin. In TASK-020 beobachten.
