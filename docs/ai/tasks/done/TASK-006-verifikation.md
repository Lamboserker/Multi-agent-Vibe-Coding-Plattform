---
id: TASK-006
titel: Gesamtverifikation Orchestrierung
status: offen   # offen | in-arbeit | blockiert | done
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
- [ ] `pnpm typecheck` und `pnpm test` grün (Ausgabe im Log zusammengefasst).
- [ ] Migration im Dev-Profil angewendet, App startet (`pnpm dev`).
- [ ] Prompt-Test ohne Modell: gerenderter Planner-Prompt für den Ausgangs-Prompt enthält Doku-Agent, Frontend-Agent und
      `projekt-doku (requested by the user)`.
- [ ] **Nur nach Zustimmung des Nutzers** Live-Planung im Dev-App: mehrere kleine Tasks; Doku-Tasks → Doku-Agent mit Skill
      `projekt-doku`; UI-Tasks → Frontend-Agent; kein Fallback.
- [ ] DB-Check read-only (Node `node:sqlite`, Kopie des Skripts im Log): `ModelCall` (purpose `plan`, status ok),
      `TaskPlan.source = codex|claude-code`, `Subtask.agentId/skills` plausibel.
- [ ] Erkenntnisse in `docs/ai/lessons.md`, AI-Log-Eintrag, Masterplan als erledigt markiert.

## Plan
1. Tests/Typecheck laufen lassen, Fehler beheben (zurück in die jeweilige Phase loggen).
2. `prisma generate` + Migration (DLL-Lock beachten), App starten.
3. Nutzer um Freigabe für einen Live-Planungsaufruf bitten; sonst Nutzer den Prompt selbst ausführen lassen.
4. DB auswerten; Abweichungen als neue Tasks anlegen.

## Log
- 2026-10-20: Task angelegt.

## Ergebnis

## Übergabe
Erst starten, wenn TASK-001 bis TASK-005 `done` sind.
