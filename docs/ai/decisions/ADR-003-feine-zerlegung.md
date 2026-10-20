---
id: ADR-003
titel: Feine Zerlegung – ein Task je Datei
status: accepted   # proposed | accepted | superseded
datum: 2026-10-20
# ersetzt: Latenz-Regel „keep a small cohesive change in ONE task" (ORCHESTRATOR_SYSTEM_PROMPT, Stand 2026-10-15)
---

# ADR-003: Feine Zerlegung – ein Task je Datei

## Kontext
Zur Latenz-Optimierung (2026-10-15) verlangte der System-Prompt, zusammenhängende Änderungen in einem Task zu halten.
Das widerspricht dem Produktprinzip, dass kleine lokale Modelle nur mit präzisen Einzeldatei-Aufgaben zuverlässig
arbeiten, und verhinderte die Verteilung auf spezialisierte Agenten. `maxTasks` stand auf 8.

## Entscheidung
- Ein Task ≈ eine Datei bzw. eine Komponente/Seite/Doku-Datei inklusive ihres Tests. Nur triviale Edits derselben Datei
  werden gebündelt. Setup-Task zuerst, unabhängige Tasks ohne Abhängigkeit (parallel).
- Default `maxTasks` = 12 (gespeicherte Nutzerwerte bleiben).

## Konsequenzen
- Mehr Planner-Output-Tokens, mehr Worktrees und Validierungsläufe pro Auftrag – bewusst akzeptiert zugunsten
  Erfolgsquote kleiner Modelle und paralleler Agenten.
- Benchmarks in `docs/benchmarks/` mit der alten Regel sind nicht mehr direkt vergleichbar.
