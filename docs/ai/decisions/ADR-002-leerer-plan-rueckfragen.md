---
id: ADR-002
titel: Leerer Plan mit Rückfragen wird als Rückfrage gezeigt
status: accepted   # proposed | accepted | superseded
datum: 2026-10-20
---

# ADR-002: Leerer Plan mit Rückfragen wird als Rückfrage gezeigt

## Kontext
Lieferte der Orchestrator `tasks: []`, warf `normalizePlan` `invalid_output`, und die App ersetzte den Plan durch den
deterministischen Ein-Task-Fallback. Die Gründe des Orchestrators (offene Fragen) gingen verloren, und der Fallback-Plan
täuschte eine Planung vor.

## Entscheidung
- 0 Tasks mit `analysis.openQuestions` oder `warnings` → Fehlerart `needs_clarification`.
- Die App zeigt die Fragen im Chat (`kind: 'plan_questions'`) und bietet „Antworten & neu planen" (Feedback-Replan).
- Kein automatischer zweiter Premium-Aufruf, kein Fallback-Plan in diesem Fall.
- 0 Tasks ohne jede Begründung bleibt `invalid_output` mit dem bisherigen Fallback.

## Konsequenzen
- Neuer Task-Schritt `plan_clarification` und ein Stage-Zustand im Leitstand.
- Der Planner-Prompt verlangt ausdrücklich, nie ohne Fragen leer zu antworten.
