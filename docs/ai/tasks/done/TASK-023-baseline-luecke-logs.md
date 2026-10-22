---
id: TASK-023
titel: Qualitätslücke Baseline und Log-Reihenfolge
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-21
phase: 9
plan: plans/2026-10-21-duo-hardware-lokal.md
---

# TASK-023: Qualitätslücke Baseline und Log-Reihenfolge

## Ziel
Siehe Abschnitt TASK-023 im Plan `plans/2026-10-21-duo-hardware-lokal.md`.

## Akzeptanzkriterien
- [x] Umsetzung laut Plan
- [x] Tests grün (betroffene Pakete)

## Log

## Übergabe
- 2026-10-21 (`entwickler`): `againstBaseline` hat neue Regeln. Hatte die Baseline keine Testzahlen, blockiert der
  Task, wenn er gezählte Fehler hat. Er wird nur freigegeben, wenn `failureSignature` gleich ist oder beide Seiten
  einen Spawn-Fehler haben.
  - Zwei alte Tests hingen an der Lücke und wurden angepasst.
  - `agentCards`: Logs sind nach Zeit sortiert; bei fertigen Tasks gilt das letzte gespeicherte Ereignis als
    `lastLog`.
  - Ergebnis: engine 375, desktop 92, typecheck grün.

Übergabe: erledigt, nicht committet.
