---
id: TASK-013
titel: Engine-Basis der Design-Phase (Typen, Schema, Prompt, Gate, Guidance)
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-21
phase: 1
abhaengig: –
plan: plans/2026-10-21-design-phase.md
---

# TASK-013: Engine-Basis der Design-Phase

## Ziel
Reine Engine-Bausteine ohne API/Renderer: Typen und Adapter-Vertrag, strict `DESIGN_SCHEMA` + Normalizer
(inkl. Mockup-Sanitizer), `designPrompt` mit `MODERN_DESIGN_RULES` und Codex-Block, `shouldDesign`, `designGuidance`
und `tokensCss`.

## Akzeptanzkriterien
- [x] `types.ts`: `DesignMode`, `DESIGN_TYPES`/`DesignType`, `DesignToken/Component/Screen`, `DesignDraft`,
      `DesignBrief`, `DesignInput`; `PlanningInput.design?`; **optionales** `OrchestratorAdapter.createDesign?`
      (Plugin-Orchestratoren müssen es nicht können).
- [x] `DESIGN_SCHEMA` strict (rekursiver Test).
- [x] `normalizeDesignDraft` + `sanitizeMockup` (Basis-Tokens, Kappung, Sanitizer, `invalid_output`).
- [x] `designPrompt` mit Moderne-Regeln; Codex zusätzlich „Avoid dated output“.
- [x] `shouldDesign` Tabellentest DE/EN; `designGuidance`/`tokensCss` getestet.
- [x] engine 307/307, typecheck, build, api-typecheck grün. Kein Live-Aufruf.

## Log
- 2026-10-21 (entwickler): Umsetzung. Abweichung: Normalizer heißt `normalizeDesignDraft`, weil
  `ui/design-normalize.ts` bereits `normalizeDesign` exportiert (TS2308 im Barrel). Token-Namen-Pattern nur im
  Normalizer (PLAN_SCHEMA nutzt keine `pattern`). `DESIGN_TYPES` in `types.ts` (Import-Zyklus mit schemas.ts).
- 2026-10-21 (Hauptagent): Review. Gate zu großzügig – „Erstelle eine neue API-Route für die App“, „Build a REST API
  for my app“ hätten über `app` + Verb eine Design-Phase (2 Premium-Calls + Freigabe) ausgelöst. Fix: starke
  UI-Begriffe (`UI_SUBJECT`) vs. generische (`WEAK_UI_SUBJECT`: app, seite, ansicht, form, *-app), letztere nur ohne
  Backend-Signal (`BACKEND`). 7 neue Tabellenfälle; ui + design-Tests 50/50, engine build grün.

## Ergebnis
Engine-API: `DESIGN_SCHEMA`, `sanitizeMockup`, `normalizeDesignDraft`, `DESIGN_SYSTEM_PROMPT`, `MODERN_DESIGN_RULES`,
`AVOID_DATED_RULES`, `designPrompt`, `shouldDesign`, `tokensCss`, `designGuidance`.

## Übergabe
Folgetasks nutzen `normalizeDesignDraft` (nicht `normalizeDesign`).
