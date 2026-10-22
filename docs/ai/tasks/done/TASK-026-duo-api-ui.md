---
id: TASK-026
titel: Duo-Modus in API, Einstellungen und UI
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-21
phase: 9
plan: plans/2026-10-21-duo-hardware-lokal.md
---

# TASK-026: Duo-Modus in API, Einstellungen und UI

## Ziel
Siehe Abschnitt TASK-026 im Plan `plans/2026-10-21-duo-hardware-lokal.md`.

## Akzeptanzkriterien
- [x] Umsetzung laut Plan
- [x] Tests grün (betroffene Pakete)

## Log

## Übergabe
- 2026-10-21 (`experte`): umgesetzt.
  - Settings `orchestratorMode`/`duoLead`; `activeWithNotice(override)` und `designerWithNotice`.
  - Die Wahl pro Auftrag steht in `ChatMessage.metadata.orchestrator` (`taskOverride`, keine Migration);
    `ExecutionRun.orchestrator = 'duo:<lead>+<partner>'`.
  - Die Partner-Session steht in `metadata.duo.partnerSessionId` der letzten Antwort.
  - Chat-Art `duo_reconciled`; Hinweise `orchestrator_notice`; `premium.byProvider`.
  - UI: Composer-Seg „Claude | Codex | Beide", `DuoReconciledCard`, `DuoAnswers`, `DuoSettings`, Verbrauch je
    Anbieter, Header „Claude Code + Codex".
  - Ergebnis: api 252 (+ reference-extensions flaky, einzeln grün), desktop 107, engine 423.
  - Offen: Sichtprüfung; `POST /tasks` (Web) ohne Override; UsageScreen ohne `byProvider`.
