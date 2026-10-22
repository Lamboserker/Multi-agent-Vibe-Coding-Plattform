---
id: TASK-019
titel: Renderer: Design-Review und Schalter
status: done   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-21
abgeschlossen: 2026-10-21
phase: 7
abhaengig: TASK-016, TASK-017
plan: plans/2026-10-21-design-phase.md
---

# TASK-019: Renderer: Design-Review und Schalter

## Ziel
Der Leitstand zeigt die Design-Zustände an. Ein Entwurf lässt sich mit Vorschau prüfen, freigeben, überarbeiten oder
überspringen. Im Composer gibt es einen Schalter für die Design-Phase.

## Akzeptanzkriterien
- [x] Workflow-Zustände `designing`, `design_review` und `design_error` mit deutschen Labels; alle Renderer-Stellen
      aus der Übergabe von TASK-017 sind angepasst.
- [x] `DesignReview` mit `sandbox=""`-srcdoc-iframe, Farbfeldern, Komponenten, Screens, Fragen und den Buttons
      „Design freigeben“, „Überarbeiten…“ und „Ohne Design planen“.
- [x] Composer-Schalter „Design-Phase: Automatisch / Immer / Überspringen“ sendet `designMode`.
- [x] desktop typecheck, test (90) und lint grün; api typecheck und test (209) grün. Kein Live-Aufruf.
- [ ] Sichtprüfung, Teil von TASK-020.

## Log
- 2026-10-21: Delegiert an `experte`.
- 2026-10-21: Umgesetzt:
  - `lib/workflow.ts`: Zustände, `isPrePlan`, `isWorking`, `DESIGN_MODES` und `designModeOf`.
  - `lib/leitstand.ts`: reine Design-Helfer `designView`, `isColorValue`, `designRevision` und `designInterrupted`.
  - `lib/workflow-actions.ts`: `latestDesign` und `designAction` mit der Sperre `task:<id>`.
  - `sync.ts`: Design-Events.
  - `planning-progress.ts`: eigene Design-Uhr.
  - `Leitstand.tsx`: `DesignStage`, `DesignPending`, `DesignError` und `DesignReview`, dazu der Pipeline-Chip „Design“.
  - `OrchestratorChat.tsx`: `DesignDraftCard` und der Schalter.
  - `shell.css`: Stile `.design-*`.
  - API: Die Design-Buttons posten jetzt dieselben Chat-Notizen wie die Chat-Antwort, über `DesignService.note()` und
    gemeinsame Text-Konstanten.

## Ergebnis
Entscheidungen:
- **CSP bleibt unverändert.** `frame-src 'none'` blockiert `about:srcdoc` nicht. Eine Probe mit Electron 44.5.1 hat das
  bestätigt (`scratchpad/csp-probe`). Das srcdoc übernimmt die App-CSP, deshalb blockiert sie externe Bilder, Fonts und
  Verbindungen zusätzlich.
- `latestDesign` liegt in `workflow-actions.ts`, weil `leitstand.ts` per Kopfkommentar rein bleiben soll.
- `designMode` wird nur gesendet, wenn der Nutzer ihn gewählt hat. So setzt ein Folge-Prompt kein per Button gesetztes
  `skip` zurück.

## Übergabe
Offene Risiken:
- Nicht visuell geprüft.
- Der iframe hat einen weißen Hintergrund. Ein dunkles Mockup ohne eigenen `body`-Hintergrund wirkt deshalb hell.
- Nach der Freigabe gibt es keinen Pipeline-Chip „Design“ mehr. Der Entwurf ist dann nur über design-001 sichtbar.
- Der Dialog „Überarbeiten“ verliert den Text, wenn der Request scheitert (wie „Neu planen“).

Sichtprüfung ohne Live-Call:
- `pnpm dev` neu starten, damit die Migration angewendet wird.
- Einen Entwurf per SQL einspielen: `DesignDraft`, `Task.currentStep` und optional eine `ChatMessage`. Die Statements
  stehen im Bericht des Agenten und sind in TASK-020 übernommen.
- Die Buttons lösen Premium-Calls aus, zum Ansehen also nicht klicken.
