---
id: TASK-014
titel: Adapter createDesign (Claude + Codex)
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-21
phase: 2
abhaengig: TASK-013
plan: plans/2026-10-21-design-phase.md
---

# TASK-014: Adapter createDesign (Claude + Codex)

## Ziel
Optionales `createDesign` in `ClaudeCodeAdapter` und `CodexAdapter`, read-only, strict `DESIGN_SCHEMA`, Token-Meta
auch bei verworfener Ausgabe.

## Akzeptanzkriterien
- [x] Claude: `callStructured`, `--json-schema`, Tools `Read,Glob,Grep`, maxTurns 6, `systemPrompt: DESIGN_SYSTEM_PROMPT`,
      keine Session-Persistenz; Provider im Prompt erzwungen `claude-code` (kein Codex-Block).
- [x] Codex: `DESIGN_SYSTEM_PROMPT` + `designPrompt({provider:'codex'})`, `--output-schema`, `--sandbox read-only`,
      `--ephemeral`.
- [x] Beide über `normalizeWithMeta` + `normalizeDesignDraft`.
- [x] Fake-CLI-Tests (4 neu): Flags, Prompt-Inhalt, Normalisierung/Sanitizer, `invalid_output` mit `details.meta.usage`.
- [x] engine 324/324, build, api-typecheck grün. Kein Live-Aufruf.

## Log
- 2026-10-21 (entwickler): Umsetzung. Codex nutzt nicht `withSystem` (hart auf `ORCHESTRATOR_SYSTEM_PROMPT`), sondern
  stellt `DESIGN_SYSTEM_PROMPT` voran. Keine neuen CLI-Flags → Fakes unverändert (Lesson 16 nicht berührt).
  Nur Claude- und Codex-Adapter implementieren `OrchestratorAdapter`.
- 2026-10-21 (Hauptagent): engine komplett 324/324, build + api-typecheck grün.

## Ergebnis
Beide Adapter können Design-Entwürfe liefern.

## Übergabe
–
