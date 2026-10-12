# AI Handoff Handbuch

> **Stand 2026-10-09:** Das Projekt ist jetzt eine Desktop-App (Electron + lokale NestJS-Laufzeit + packages/engine). Architektur, Entscheidungen und Status stehen in [desktop-architecture.md](desktop-architecture.md). Die Abschnitte unten beschreiben den früheren Web-/Hybrid-Stand und gelten nur noch für die optionale Web-UI (pnpm dev:web); der Dry-Run-Modus wurde durch echte Ausführung ersetzt.

Dieses Dokument ist fuer spaetere AI-Agents gedacht, die an dieser Plattform weiterarbeiten. Es beschreibt Zielbild, aktuellen Stand, wichtige Architekturentscheidungen, bekannte Grenzen und sichere naechste Schritte.

## 1. Produktziel

Die Anwendung ist eine Cost-Aware Multi-AI-Coding-Plattform. Sie soll sich langfristig anfuehlen wie ein Coding-Cockpit im Stil von Cursor, Replit Agent oder Codex Workspace, aber mit expliziter Kostenkontrolle und transparenter Modellzuweisung.

Das Produkt soll nicht nur ein Statistik- oder Admin-Dashboard sein. Der Kern ist ein Workspace, in dem Nutzer:

- einen Coding-Task eingeben,
- Analyse und Planung starten,
- Subtasks sehen,
- pro Subtask Agent und Modell sehen,
- Modellwahl und Kosten nachvollziehen,
- Runs starten,
- Logs, Diff und Validation sehen,
- Feedback fuer Follow-up-Runs geben,
- spaeter Patches sicher anwenden oder verwerfen koennen.

## 2. Repository-Struktur

Wichtige Pfade:

- `apps/web`: Next.js App Router Frontend.
- `apps/api`: NestJS Backend API.
- `apps/worker`: BullMQ Worker Stub.
- `packages/shared`: gemeinsame Typen und Modellrouting-Logik.
- `packages/agents`: Agent-Prompt-/Agent-Hilfen.
- `prisma`: Datenmodell und Migrationen.
- `docs`: Architektur- und Handoff-Dokumentation.

Lokaler Start laut README:

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm prisma:generate
pnpm prisma:migrate
pnpm dev
```

Frontend:

```text
http://localhost:3000
```

API:

```text
http://localhost:4000
```

## 3. Aktuelle Hauptseite

Die Hauptarbeitsoberflaeche ist:

```text
/workspace
```

Die Root-Route `/` leitet auf `/workspace` weiter. Das alte Dashboard bleibt unter:

```text
/dashboard
```

Wichtige Frontend-Dateien:

- `apps/web/src/app/page.tsx`: Redirect nach `/workspace`.
- `apps/web/src/app/workspace/page.tsx`: Workspace-Seite.
- `apps/web/src/components/workspace-cockpit.tsx`: Hauptkomponente des Cockpits.
- `apps/web/src/components/theme-provider.tsx`: globaler Theme-Initializer.
- `apps/web/src/components/theme-toggle.tsx`: Dark/Light Toggle.
- `apps/web/src/app/globals.css`: globale Styles, Workspace Styles, Theme-Variablen.
- `apps/web/src/lib/api.ts`: API-Client zum Next.js Proxy.
- `apps/web/src/app/api/backend/[...path]/route.ts`: Proxy zu NestJS Backend.

## 4. Workspace-Funktionen

Der Workspace bietet aktuell:

- Projekt-Auswahl.
- Task-Eingabefeld.
- Modus-Auswahl: `cheapest`, `balanced`, `quality`.
- Kostenlimit.
- erlaubte Modellklassen:
  - `no_llm`
  - `local_llm`
  - `free_llm`
  - `cheap_api_llm`
  - `premium_llm`
- Premium-Allow Checkbox.
- Workflow Buttons:
  - `Analyze`
  - `Plan`
  - `Assign Models`
  - `Run All`
  - `Stop`
  - `Retry Failed`
  - `Review`
  - `Apply Patch`
  - `Discard`
- Execution Timeline.
- Subtask-/Agent-/Model Assignment Panel.
- Live Run Console.
- Diff & Validation Panel.
- Feedback Loop.
- Dark/Light Theme Toggle in der Sidebar und im Header.

## 5. Wichtige Backend-Komponenten

Backend-Dateien:

- `apps/api/src/tasks/tasks.controller.ts`
- `apps/api/src/tasks/tasks.service.ts`
- `apps/api/src/runs/runs.controller.ts`
- `apps/api/src/runs/runs.service.ts`
- `apps/api/src/subtasks/subtasks.controller.ts`
- `apps/api/src/subtasks/subtasks.service.ts`
- `apps/api/src/orchestrator/task-analyzer.service.ts`
- `apps/api/src/orchestrator/planner.service.ts`
- `apps/api/src/orchestrator/cost-router.service.ts`
- `apps/api/src/orchestrator/agent-runner.service.ts`
- `apps/api/src/orchestrator/review-engine.service.ts`
- `apps/api/src/validation/validation.service.ts`
- `apps/api/src/models/models.controller.ts`
- `apps/api/src/models/models.service.ts`

## 6. Datenmodell

Das Prisma-Schema liegt in:

```text
prisma/schema.prisma
```

Wichtige Modelle:

- `Project`
- `Task`
- `Subtask`
- `ModelProvider`
- `AgentRun`
- `Review`
- `ContextSnapshot`
- `RunFeedback`
- `PaymentAccount`
- `CreditLedger`

### Task

Wichtige Felder:

- `status`: grober Taskstatus.
- `mode`: `cheapest`, `balanced` oder `quality`.
- `maxCostEuro`: Kostenlimit.
- `premiumAllowed`: ob Premium erlaubt ist.
- `currentStep`: UI-/Workflow-Schritt.
- `lastRunId`: letzter Run.
- `projectId`: Projektzuordnung.

### Subtask

Wichtige Felder:

- `title`
- `goal`
- `status`
- `assignedAgentType`
- `selectedModelClass`
- `selectedProviderId`
- `selectedModelName`
- `modelReason`
- `skippedModels`
- `estimatedCostEuro`
- `allowedFiles`
- `deniedFiles`
- `validationCommands`

Hinweis: Im UI wird `assignedAgentType` als Agent Type angezeigt.

### AgentRun

Wichtige Felder:

- `status`
- `startedAt`
- `finishedAt`
- `logs`
- `currentStep`
- `selectedModelClass`
- `selectedModelName`
- `providerId`
- `estimatedCostEuro`
- `actualCostEuro`
- `diffSummary`
- `validationStatus`
- `validationResults`
- `patchText`
- `patchStatus`
- `errorMessage`

### RunFeedback

Speichert Nutzerfeedback fuer Follow-up-Runs:

- `taskId`
- `runId`
- `userFeedback`
- `requestedAction`
- `createdAt`

## 7. Migrationen

Relevante Migrationen:

- `prisma/migrations/20260515203947_init/migration.sql`
- `prisma/migrations/20260516000100_workspace_flow/migration.sql`

Nach Schemaaenderungen immer:

```bash
pnpm prisma:generate
pnpm prisma migrate dev
```

Falls die Migration bereits existiert und nur lokal angewendet werden soll:

```bash
pnpm prisma migrate deploy
```

## 8. API-Endpunkte

### Projekte

```text
POST /projects
GET /projects
GET /projects/:id
POST /projects/:id/index
```

### Tasks

```text
POST /tasks
GET /tasks
GET /tasks/:id
POST /tasks/:id/analyze
POST /tasks/:id/plan
POST /tasks/:id/assign-models
POST /tasks/:id/run
POST /tasks/:id/stop
POST /tasks/:id/retry
POST /tasks/:id/review
POST /tasks/:id/apply
POST /tasks/:id/discard
POST /tasks/:id/feedback
GET /tasks/:id/runs
GET /tasks/:id/subtasks
POST /tasks/:id/validate
```

### Subtasks

```text
POST /subtasks/:id/run
POST /subtasks/:id/retry
POST /subtasks/:id/escalate
PATCH /subtasks/:id/model
```

### Runs

```text
GET /runs/:id
GET /runs/:id/logs
GET /runs/:id/diff
GET /runs/:id/validation
```

### Models

```text
GET /models
GET /models/availability
POST /models
PATCH /models/:id
POST /models/test-connection
POST /models/test
```

## 9. Aktueller Workflow

Der vertikale Workspace-Flow ist:

1. Nutzer gibt Task ein.
2. `POST /tasks` erzeugt Task.
3. `POST /tasks/:id/analyze` analysiert Task und Repo.
4. `POST /tasks/:id/plan` erzeugt Subtasks.
5. `POST /tasks/:id/assign-models` persistiert Modellwahl, Provider, Kosten und Begruendung.
6. `POST /tasks/:id/run` erzeugt echte persistierte `AgentRun`-Zeilen.
7. Der TestAgent fuehrt Validation-Kommandos aus.
8. Logs, Diff Summary, Validation Results und Patch Status werden gespeichert.
9. Nutzer kann Feedback ueber `POST /tasks/:id/feedback` speichern.

## 10. Sehr wichtiger aktueller Limit: Hybrid Mode

Aktuell ist die Plattform im Hybrid-/Dry-Run-Modus.

Das bedeutet:

- Runs werden echt persistiert.
- Logs werden echt persistiert.
- Validation wird durch den TestAgent echt ausgefuehrt.
- Kosten werden geschaetzt und gespeichert.
- Modellzuordnung wird gespeichert.
- `diffSummary` wird gespeichert.
- `patchStatus` wird gespeichert.

Aber:

- Es wird noch kein echter Code-Patch durch ein Modell erzeugt.
- `patchText` ist normalerweise `null`.
- `Apply Patch` darf ohne `patchText` keine Dateien veraendern.
- `Apply Patch` markiert solche Runs als `blocked/no_patch_artifact`.

Wenn ein Nutzer sagt "es wurde nichts gebaut", ist das korrekt, solange keine echte Patch-Generation implementiert wurde.

## 11. Validation-Verhalten

Validation liegt in:

```text
apps/api/src/validation/validation.service.ts
```

Wichtige Windows-/Dev-Server-Gotchas:

1. `execFile('pnpm')` funktioniert unter Windows nicht zuverlaessig.
2. Die API nutzt fuer Windows:

```text
cmd.exe /d /s /c <command>
```

3. Root-Kommandos wie `pnpm typecheck` koennen im Dev-Modus Build-Artefakte schreiben und dadurch `node --watch` neu starten.
4. Deshalb generiert live Workspace Validation fuer pnpm Workspaces sichere Kommandos:

```bash
pnpm -r --filter ./packages/** --filter ./apps/** typecheck
pnpm -r --filter ./packages/** --filter ./apps/** lint
pnpm -r --filter ./packages/** --filter ./apps/** test
```

5. `build` wird in live Workspace Validation uebersprungen, weil es Artefakte schreibt und den API-Watcher neu starten kann.
6. Vollstaendiger Build soll trotzdem manuell oder in CI laufen:

```bash
pnpm build
```

## 12. Modellrouting

Routing-Logik:

```text
packages/shared/src/routing.ts
apps/api/src/orchestrator/cost-router.service.ts
```

Modellklassen:

- `no_llm`: deterministische Analyse, Validation, Repo-Metadaten.
- `local_llm`: lokale Ollama-kompatible Modelle.
- `free_llm`: Free-Quota Provider.
- `cheap_api_llm`: guenstige API-Modelle.
- `premium_llm`: Architektur, Security, Auth, Payment, DB-Migrationen, kritische Reviews.

Premium ist approval-/policy-gated und soll nicht Standard fuer einfache Implementierung sein.

## 13. Task Analyzer

Datei:

```text
apps/api/src/orchestrator/task-analyzer.service.ts
```

Bekannter Fix:

Nur weil das Repo Prisma-Dateien enthaelt, darf nicht jeder Task als Database-Task klassifiziert werden.

Database wird nur als affected area gesetzt, wenn der Prompt auch database-relevante Begriffe enthaelt, z. B.:

- database
- db
- prisma
- schema
- migration
- query
- sql
- postgres

Das verhindert, dass UI-Aufgaben wie "dark and lightmode" als High-Risk-Database-Task geroutet werden.

## 14. Theme-Funktion

Dark/Light Mode wurde direkt in der App implementiert, nicht durch Agent-Run.

Dateien:

- `apps/web/src/components/theme-provider.tsx`
- `apps/web/src/components/theme-toggle.tsx`
- `apps/web/src/app/layout.tsx`
- `apps/web/src/components/workspace-cockpit.tsx`
- `apps/web/src/app/globals.css`

Verhalten:

- Theme wird in `localStorage` unter `multi-ai-coder-theme` gespeichert.
- Theme wird am HTML-Element gesetzt:

```text
document.documentElement.dataset.theme = "dark" | "light"
```

- CSS nutzt:

```css
html[data-theme='light'] { ... }
```

Der Toggle ist sichtbar:

- in der Sidebar unter dem Logo,
- im Header neben Refresh.

Wenn der Toggle scheinbar fehlt:

- Seite hart neu laden: `Ctrl + F5`.
- Pruefen, ob `apps/web` Dev-Server Hot Reload uebernommen hat.
- Pruefen, ob man auf `/workspace` ist, nicht auf altem `/dashboard`.

## 15. Bekannte UX-Probleme

1. `Run All` klingt so, als wuerde Code implementiert. Aktuell erzeugt es aber Hybrid-Runs und Validation.
2. Besser waere eine Umbenennung:

```text
Run All -> Run Dry-Run
```

oder ein klares Banner:

```text
Hybrid dry-run: no patch will be generated or applied.
```

3. `Apply Patch` sollte im UI disabled sein, solange kein `patchText` existiert.
4. Die Console kann sehr lange Validation-Ausgaben enthalten. Spaeter sollte sie faltbare Loggruppen bekommen.
5. Timeline-Zeiten sind aktuell grob aus Task-/Run-Zeitstempeln abgeleitet.

## 16. Naechste grosse Implementierungsaufgabe: echte Patch-Generation

Um aus dem Cockpit ein echtes AI-Coding-System zu machen, braucht es Patch-Generation.

Empfohlener sicherer Ablauf:

1. Subtask-Kontext bauen.
2. Aus `allowedFiles` relevante Inhalte lesen.
3. Modell mit strikt begrenztem Prompt aufrufen.
4. Modell darf nur Unified Diff ausgeben.
5. Diff validieren:
   - nur erlaubte Dateien,
   - kein Zugriff auf denied files,
   - gueltiges Patch-Format,
   - keine Secrets,
   - keine Migrationen ohne explizite Freigabe.
6. `AgentRun.patchText` speichern.
7. `AgentRun.patchStatus = "ready"`.
8. Optional Patch in temporaeren Worktree anwenden.
9. Validation ausfuehren.
10. UI zeigt Diff und Validation.
11. `Apply Patch` darf nur bei `patchStatus = "ready"` und vorhandener `patchText` aktiv sein.

Wichtig: Niemals ungeprueft Modelloutput direkt ins Dateisystem schreiben.

## 17. Empfohlene neue Backend-Services fuer echte Patches

Sinnvolle kuenftige Services:

```text
apps/api/src/orchestrator/patch-generator.service.ts
apps/api/src/orchestrator/patch-validator.service.ts
apps/api/src/orchestrator/worktree.service.ts
apps/api/src/providers/model-inference.service.ts
```

Aufgaben:

- `patch-generator`: Modellprompt, Kontext, Unified Diff erzwingen.
- `patch-validator`: Dateigrenzen, Patch-Format, denied files pruefen.
- `worktree`: isolierte Testumgebung fuer Patch-Anwendung.
- `model-inference`: Ollama/OpenAI-compatible/Gemini CLI Adapter.

## 18. Provider-Status

Aktuell existieren ModelProvider-Eintraege und Provider-Testadapter.

Aber:

- Es gibt noch keine echte generische Inference-Pipeline fuer Code-Patches.
- Lokale Ollama-Provider koennen getestet werden, werden aber fuer Patch-Generation noch nicht verwendet.
- API-Schluessel werden nur serverseitig ueber Env-Var-Namen referenziert.

## 19. Frontend-Design-Prinzipien

Workspace soll funktional bleiben:

- Task-Eingabe ist prominent.
- Agent-/Modell-Zuordnung ist sichtbar.
- Kosten und Modellgruende sind sichtbar.
- Logs und Validation sind Teil des Arbeitsflusses.
- Keine grossen KPI-Karten als Hauptinhalt.
- Keine reine Admin-Oberflaeche.

Bei UI-Aenderungen:

- Keine verschachtelten Karten in Karten, wenn vermeidbar.
- Karten nur fuer wiederholte Items, Panels und Tools.
- Button-Labels sollen echte Aktion beschreiben.
- Lange Console-Ausgaben muessen scrollen, nicht Layout sprengen.
- Mobile Layout darf nicht ueberlappen.

## 20. Wichtige Validierungsbefehle

Nach Backend-/Frontend-Aenderungen:

```bash
pnpm prisma:generate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose config
```

Gezielte Checks:

```bash
pnpm --filter @multi-ai-coder/api lint
pnpm --filter @multi-ai-coder/api build
pnpm --filter @multi-ai-coder/web lint
pnpm --filter @multi-ai-coder/web build
pnpm --filter @multi-ai-coder/web test
```

Live Workspace Validation benutzt bewusst nicht `pnpm build`, weil Build-Artefakte den Watch-Prozess stoeren koennen.

## 21. Haeufige Fehler und Diagnose

### Run dauert nur wenige Millisekunden

Dann wurde wahrscheinlich nur ein Dry-Run ohne echte Validation ausgefuehrt oder die Validation ist sofort fehlgeschlagen.

Pruefen:

```text
AgentRun.logs
AgentRun.validationResults
AgentRun.validationStatus
```

### `spawn pnpm ENOENT`

Windows konnte `pnpm` nicht direkt ueber `execFile` starten. Loesung ist bereits implementiert: unter Windows `cmd.exe /d /s /c`.

### `spawn EINVAL`

Windows `.cmd`-Aufruf ueber `execFile` war weiterhin ungeeignet. Loesung ist ebenfalls `cmd.exe`.

### `No projects matched the filters`

Quote-/Shell-Problem bei pnpm filter. Die live commands sollen unquoted sein:

```bash
pnpm -r --filter ./packages/** --filter ./apps/** typecheck
```

Nicht:

```bash
pnpm -r --filter "./packages/**" --filter "./apps/**" typecheck
```

### Task wird faelschlich als Database klassifiziert

Pruefen:

```text
apps/api/src/orchestrator/task-analyzer.service.ts
```

Repo-Metadaten duerfen Klassifikation nicht allein bestimmen.

### Dark/Light Toggle fehlt

Pruefen:

- Ist `/workspace` geoeffnet?
- Ist Dev-Server aktuell?
- Hard reload `Ctrl + F5`.
- Datei `workspace-cockpit.tsx` muss `ThemeToggle` in Sidebar und Header rendern.

## 22. Akzeptanzkriterien fuer naechste AI-Agents

Eine spaetere AI sollte nicht behaupten, dass Code implementiert wurde, wenn nur Validation lief.

Korrekte Formulierungen:

- "Der Run wurde persistiert."
- "Validation wurde ausgefuehrt."
- "Kein Patch-Artefakt wurde erzeugt."
- "Apply ist blockiert, weil `patchText` fehlt."

Falsche Formulierungen:

- "Der Task wurde umgesetzt", wenn `patchText` leer ist.
- "Apply Patch funktioniert", wenn es nur blockiert.
- "Das Modell hat Code geschrieben", wenn keine Inference-Pipeline existiert.

## 23. Entscheidende offene Punkte

1. Echte Modell-Inference fuer Patch-Generation fehlt.
2. Patch-Validierung fehlt.
3. Worktree-Isolation fehlt.
4. Apply/Discard ist noch kein echter Patch-Lifecycle.
5. Console braucht bessere Darstellung langer Ausgaben.
6. UI sollte Hybrid-/Dry-Run-Zustand deutlicher machen.
7. Build-Validation sollte in separatem Prozess/Worker laufen, nicht im API-Watch-Prozess.
8. Subtask-Einzelrun sollte wirklich nur einen Subtask ausfuehren.

## 24. Empfohlener naechster Schritt

Der naechste sinnvolle Schritt ist nicht noch mehr Dashboard-UI, sondern echte Patch-Artefakte.

Minimaler erster Patch-Generator:

1. Nur lokale Dateien aus `allowedFiles` lesen.
2. Ollama-Provider fuer `local_llm` ansprechen.
3. Modell muss Unified Diff ausgeben.
4. Diff nur speichern, nicht anwenden.
5. UI zeigt Diff.
6. Validation bleibt wie jetzt.
7. `Apply Patch` bleibt blockiert, bis Patch-Validator existiert.

Damit waere die Plattform erstmals ein echtes Coding-Cockpit statt ein Dry-Run-Orchestrator.
