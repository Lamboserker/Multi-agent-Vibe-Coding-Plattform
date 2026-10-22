---
id: TASK-025
titel: Duo-Orchestrator in der Engine
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-21
phase: 9
plan: plans/2026-10-21-duo-hardware-lokal.md
---

# TASK-025: Duo-Orchestrator in der Engine

## Ziel
Siehe Abschnitt TASK-025 im Plan `plans/2026-10-21-duo-hardware-lokal.md`.

## Akzeptanzkriterien
- [x] Umsetzung laut Plan
- [x] Tests grün (betroffene Pakete)

## Log

## Übergabe
- 2026-10-21 (`experte`): `DuoOrchestrator` (`orchestrator/duo.ts`) umgesetzt; `id = lead.id`, dazu `duo`, `leadAdapter`
  und `partnerAdapter`.
  - Plan und Design: parallel, danach Abgleich durch den Lead über `structuredCall` (`RECONCILE_PLAN_SCHEMA`,
    `reconcileDesignPrompt`). Rückfragen werden vereinigt bzw. als Warnungen übernommen.
  - Review: deterministisch, das strengere Urteil gilt.
  - Repair-Hint: die höhere Konfidenz gilt.
  - Chat: Lead-Antwort plus `duo.partnerAnswer`.
  - Ausführung: in `runDuoPremium` mit Schwester-Worktree `-duo`. Es gewinnt der bessere Validierungsstand, bei
    Gleichstand entscheidet `duo_choose`. Danach `reset` und der Diff des Gewinners; die Schwester-Worktree wird im
    `finally` entfernt.
  - Buchung: `meta.parts` und `bookableCalls`; API-Helfer `modelCallRows`/`failedCallRows` an allen Buchungsstellen.
  - Ergebnis: engine 423, api 232, desktop 98, typecheck und lint grün.
  - Für TASK-026 offen: `partnerAnswer` und Partner-Session in der API, `meta.duo` als Chat-Nachricht, Plan-`source`.
  - Risiken: doppelte Checks bei der Duo-Ausführung; der Reconcile-Prompt ist groß.
