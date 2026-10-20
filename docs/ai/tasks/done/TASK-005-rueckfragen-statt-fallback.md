---
id: TASK-005
titel: Leerer Plan zeigt Rückfragen statt Fallback
status: offen   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-20
phase: 5
plan: docs/ai/plans/2026-10-20-orchestrierung.md
---

# TASK-005: Leerer Plan zeigt Rückfragen statt Fallback

## Ziel
Liefert der Orchestrator keinen Task, aber Rückfragen oder Gründe, sieht der Nutzer diese Fragen im Chat und kann sie
über „Antworten & neu planen" beantworten. Es entsteht kein irreführender Ein-Task-Fallback-Plan und kein zweiter
Premium-Aufruf (ADR-002).

## Akzeptanzkriterien
- [ ] Neuer `OrchestratorErrorKind` `'needs_clarification'` (`packages/engine/src/orchestrator/types.ts`).
- [ ] `normalizePlan`: 0 Tasks **mit** `analysis.openQuestions` oder `warnings` → `needs_clarification`, Fragen in Message
      bzw. `details`; 0 Tasks ohne jede Begründung → weiterhin `invalid_output` (dann wie bisher Fallback).
- [ ] `ExecutionService.plan()`: bei `needs_clarification` kein `deterministicPlan`; vorhandene Subtasks bleiben unberührt;
      Task `status: 'planned'`(oder passender bestehender Status), `currentStep: 'plan_clarification'`;
      Chat-Nachricht `kind: 'plan_questions'`: „Der Orchestrator hat Rückfragen:" + nummerierte Fragen + Hinweis;
      `recordPlanCall(..., 'error', ..., 'needs_clarification')`.
- [ ] Renderer: `apps/desktop/src/renderer/lib/leitstand.ts` leitet aus `currentStep === 'plan_clarification'` einen Stage-Zustand ab;
      `Leitstand.tsx` (~Zeile 113) zeigt „Antworten & neu planen", das den vorhandenen Replan-Dialog mit Feedback öffnet
      (`replanTask(task.id, feedback)` in `workflow-actions.ts`).
- [ ] Plugin-Orchestrator (`apps/api/src/orchestration/orchestrator.service.ts:103`) erbt das Verhalten über `normalizePlan`.
- [ ] Tests: schemas (beide Fälle), execution.service (keine Fallback-Subtasks, `plan_questions`-Nachricht), Renderer-Stage (falls Tests existieren).

## Plan
1. types.ts: Kind ergänzen; prüfen, wo Kinds erschöpfend gematcht werden (`grep "invalid_output"` in engine/api/desktop).
2. schemas.ts `normalizePlan` Zeile 214 anpassen.
3. execution.service.ts `plan()` catch-Zweig (~Zeile 264): Sonderfall vor dem Fallback; danach `return` ohne Subtask-Transaktion.
   Prüfen, dass `planJob` und `planningStatus` mit diesem Ausgang zurechtkommen (kein `plan_failed`).
4. Renderer: Stage + Button; Texte Deutsch; vorhandene Komponenten/Stile verwenden.
5. Tests ergänzen.

## Log
- 2026-10-20: Task angelegt. Entscheidung Nutzer: direkt Rückfragen zeigen, kein Retry (ADR-002).

## Ergebnis

## Übergabe
Unabhängig von den anderen Phasen umsetzbar. TASK-004 ergänzt die Prompt-Regel „never return zero tasks".
