---
id: TASK-024
titel: Mehr lokal ausführen (Bewertungsraster, Router, Premium-Hinweise)
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-21
phase: 9
plan: plans/2026-10-21-duo-hardware-lokal.md
---

# TASK-024: Mehr lokal ausführen (Bewertungsraster, Router, Premium-Hinweise)

## Ziel
Siehe Abschnitt TASK-024 im Plan `plans/2026-10-21-duo-hardware-lokal.md`.

## Akzeptanzkriterien
- [x] Umsetzung laut Plan
- [x] Tests grün (betroffene Pakete)

## Log

## Übergabe
- 2026-10-21 (`experte`): umgesetzt.
  - Planer-Raster für complexity/risk; `suggestedExecutor: premium` nur bei complexity 4–5.
  - Router: In `balanced` gibt es eine höhere Stufe nur bei c≥4/r≥3. Ein Downgrade per Statistik geht auch bei
    Risiko 3, bei hoher Konfidenz und nie bei Security-Dateien.
  - Neue Ketten-Stufe „Premium-Hinweis":
    - `repairHint` (beide Adapter, read-only, `REPAIR_HINT_SCHEMA`) liefert „alt/neu"-Edits. Damit macht das
      stärkste lokale Modell eine Reparaturrunde.
    - Erst danach kommt `executeComplexTask`.
    - Einstellung `premiumHints` (Default an); Zweck `repair_hint` wird gebucht, auch fehlgeschlagene Aufrufe.
  - Ergebnis: engine 395, api 228, desktop 98, typecheck und lint grün.
  - Offen (Nutzerfrage): Hinweis auch bei `premiumExecutionAllowed=false` bzw. Agent `escalation: 'local'`?
  - Live-Test von `repairHint` nur mit Zustimmung.
