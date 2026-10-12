# Multi-AI Coder – Desktop-Architektur, Entscheidungen und Status

Stand: 2026-10-09. Dieses Dokument ersetzt die MVP-Beschreibung in `architecture.md` für die Desktop-Version und ist der Einstiegspunkt für weitere Arbeit.

## 1. Repository-Audit (Ausgangslage)

| Bereich | Vorgefunden | Bewertung |
| --- | --- | --- |
| Datenbank | PostgreSQL + Prisma, 6 Migrationen, `String[]`-Spalten | für Desktop zu schwergewichtig (Docker/Installation) |
| Queue | Redis/BullMQ, Worker nur Stub | Pflichtabhängigkeit ohne Nutzen |
| Run-Engine | `AgentRunnerService` erzeugte simulierte Runs, keine Patches, Kosten geschätzt | ersetzt |
| Provider | Ollama/OpenAI/Gemini nur Verbindungstests | ersetzt durch echte Inferenz (Ollama) und echte Orchestrator-Adapter |
| Planung/Routing | Heuristiken (Keyword-Klassifizierung, `routeModel`) | als deterministische Vorstufe/Fallback erhalten |
| Frontend | Next.js-Workspace (Chat, Plan, Logs), Login | bleibt als „Web-Modus“ erhalten |
| Auth | Nutzer/Sessions (scrypt) | Web-Modus; Desktop nutzt Start-Token |
| Tests | 3 Routing-Tests | stark ausgebaut (siehe §6) |

## 2. Zielarchitektur

```text
Electron Main (apps/desktop/src/main)
 ├─ BrowserWindow (contextIsolation, sandbox, kein nodeIntegration, CSP, app://-Protokoll)
 ├─ Preload-Bridge window.mac  ── validierte IPC (validation.ts) ──┐
 ├─ PTY-Terminals (@lydell/node-pty, prebuilt)                      │
 └─ RuntimeManager → utilityProcess                                 ▼
      Lokale Laufzeit (apps/api, NestJS, gebündelt) – 127.0.0.1, Zufallsport, Bearer-Token pro Start
       ├─ SQLite (Prisma) + eigener Migrator, WAL
       ├─ persistente Job-Queue (Tabelle Job) + Crash-Recovery
       ├─ SSE-Eventstream → Main → Renderer
       ├─ OrchestratorService (Claude Code / Codex Adapter)
       ├─ LocalModelsService (Ollama, Hardware, Katalog, Downloads, Selbsttest)
       ├─ ExecutionService ──► packages/engine ExecutionRunner
       └─ WorkspaceFs (Explorer, Editor, Git-Ansicht, Watcher)
packages/engine (framework-frei, getestet)
 orchestrator/ · ollama/ · agents/ · git/ · patch/ · planning/ · routing/ · scheduler/ · validation/ · integration/ · index/ · cost/ · security/
```

### Entscheidungen

1. **NestJS als lokaler Prozess (Hybrid) statt Rewrite.** Die bestehenden Services/Controller bleiben nutzbar; die neue Kernlogik liegt in `packages/engine` (ohne Nest-Abhängigkeit, dadurch direkt testbar). Die Laufzeit wird aus der `tsc`-Ausgabe mit esbuild gebündelt (Decorator-Metadaten bleiben erhalten) und als Electron-`utilityProcess` gestartet: Absturzisolation, Neustart mit Backoff, Graceful Shutdown.
2. **SQLite statt PostgreSQL.** Prisma 6.19 unterstützt auf SQLite Enums, Json und Decimal; nur `String[]` wurde zu Json. Die alten Postgres-Migrationen liegen unter `prisma/legacy-postgres/`. Da die installierte App keine Prisma-CLI enthält, wendet `apps/api/src/runtime/migrator.ts` die SQL-Migrationen beim Start an (transaktional, erkennt auch `prisma migrate deploy`).
3. **Keine Redis-Pflicht.** Eigene persistente Queue in SQLite (`JobQueueService`): atomare Claims, Prioritäten, Retries mit Backoff, Recovery („requeue“ für Downloads, „interrupt“ für Ausführungen, damit kein Abo-Kontingent ungefragt verbraucht wird).
4. **Renderer neu mit Vite + React** statt Next.js im Electron: Next App Router braucht einen Server oder Static Export; Monaco/xterm lassen sich mit Vite offline unter strikter CSP bündeln. Die Next-Web-UI bleibt als `pnpm dev:web` erhalten.
5. **Orchestratoren nur über offizielle CLIs.** Claude Code: `claude -p --output-format stream-json --json-schema …`, Login über `claude auth login`. Codex: `codex exec --json --output-schema …`, Login über `codex login`. Die App liest/speichert keine Tokens; Login läuft sichtbar im integrierten Terminal. Im Abo-Modus werden `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` u. ä. aus der CLI-Umgebung entfernt, damit nie unbemerkt API-Abrechnung greift. Kein automatischer kostenpflichtiger Fallback.
   *Hinweis:* Anthropic weist darauf hin, dass Drittanbieter-Produkte claude.ai-Login nicht ohne Freigabe anbieten sollen. Die App nutzt ausschließlich die vom Nutzer selbst installierte und angemeldete Claude-Code-CLI auf dessen Rechner; für eine Weiterverteilung an Dritte ist der API-Key-Modus (explizit wählbar) bzw. eine Klärung mit Anthropic vorzusehen.
6. **Ollama als lokale Runtime** über die dokumentierte HTTP-API (`/api/chat` mit Tools bzw. `format`-Schema, `/api/pull`, `/api/show` für Fähigkeiten, `/api/ps` für Speicher). Austauschbar, weil die Engine nur `OllamaClient` nutzt.
7. **Modellkatalog ohne feste Wahrheit.** Kandidatenfamilien (Stand 2026-10) sind nur Ausgangspunkt; Größen kommen live aus der Registry, Tool-Fähigkeit aus dem Template bzw. `/api/show`, und erst ein echter Tool-Call-Selbsttest setzt „verifiziert“. Beispiel aus diesem Rechner: `qwen2.5-coder:7b` hat ein Tool-Template, liefert Tool-Calls aber als JSON-Text → Selbsttest „failed“ → Engine nutzt automatisch den strikten JSON-Patch-Modus.

## 3. Ausführungsablauf (echt, nicht simuliert)

1. **Kontextanalyse (deterministisch):** Repo-Index mit Dateihashes (inkrementell), TypeScript-Compiler-API für Symbole/Imports, Import-Graph, ripgrep-Suche; ein token-budgetierter Digest (Outlines statt ganzer Dateien) geht an den Orchestrator.
2. **Zerlegung:** ein strukturierter Orchestrator-Aufruf liefert Aufgaben mit ID, Komplexität, Risiko, Dateien, Abhängigkeiten, Fähigkeiten, Tokenschätzung, Teststrategie, Akzeptanzkriterien. Das Ergebnis wird normalisiert (IDs, Pfade, unbekannte Abhängigkeiten). Ohne Orchestrator: gekennzeichneter deterministischer Fallback-Plan.
3. **DAG:** Zyklen werden gebrochen, Tasks mit gleichen Dateien serialisiert, parallele Ebenen berechnet.
4. **Routing:** Komplexität/Risiko bestimmen die Stufe (fast/balanced/advanced/premium), Kostenmodus und Orchestrator-Vorschlag verschieben sie, gemessene Erfolgsquoten (Wilson-Untergrenze, ≥5 Stichproben) stufen hoch/runter, Kontextfenster und Verfügbarkeit werden geprüft. Eskalationskette: Reparaturversuche → stärkeres lokales Modell → Premium.
5. **Scheduler:** Slots für lokal/premium (lokal nur > 1, wenn alle Rollenmodelle zusammen in den VRAM passen), Datei-Locks, Modell-Affinität, Pause/Fortsetzen/Abbruch, Infrastruktur-Retries, Deadlock-Schutz.
6. **Worker:** pro Task eigener Worktree (außerhalb des Projekts, `node_modules` per Junction verlinkt), lokaler Agent über validierten Tool-Layer (lesen/suchen/schreiben/editieren, Scope- und Secret-Schutz) oder JSON-Patch-Modus; Premium-Agent über die CLI im Worktree (Claude: nur Read/Edit/Write/Glob/Grep, keine Shell; Codex: `workspace-write`-Sandbox).
7. **Validierung:** Patch-Prüfung (Traversal, Secrets, sensible Dateien, Deny-Liste, Scope, Binärdateien, Symlinks/Modi, Größe, Konfliktmarker, Syntax via TS-Parser/JSON) → Projekt-Checks (typecheck/test/lint) mit Allowlist und secretfreier Umgebung → bei Fehlern Reparatur mit Fehlerausgabe; Lint-Fehler zuerst deterministisch (prettier/eslint --fix).
8. **Integration:** erfolgreiche Commits werden seriell auf einen Integrations-Branch cherry-gepickt; Konflikt → Neuausführung auf neuem Stand. Abhängige Tasks starten auf dem Integrationsstand.
9. **Final:** Gesamtvalidierung im Integrations-Worktree, risikobasierter Premium-Review (nur deterministische Signale entscheiden), eine begrenzte Fix-Runde bei Blockern.
10. **Freigabe:** Arbeitskopie (ohne Commit, schützt eigene ungespeicherte Änderungen), Branch behalten oder Fast-Forward; jeweils mit Undo. Es wird nie gepusht.

## 4. Kosten- und Nutzungstransparenz

`ModelCall`-Tabelle für jeden Modellaufruf. Getrennt ausgewiesen: Premium-Aufrufe und gemessene Tokens, lokale Aufrufe/Tokens/Inferenzzeit/Spitzenspeicher, tatsächliche API-Ausgaben (unter Abo 0), API-Listenpreis-Äquivalent (nur wenn die CLI es meldet), optionale Energieschätzung (nur mit eingetragener GPU-Leistung) und eine **gekennzeichnete** Einsparungsschätzung, deren Preisbasis aus den vom CLI gemeldeten Kosten abgeleitet oder vom Nutzer eingetragen ist. Abo-Rate-Limits (Claude `rate_limit_event`) werden angezeigt.

## 5. Sicherheit

- Electron: contextIsolation, sandbox, kein nodeIntegration, CSP, eigenes `app://`-Protokoll mit Pfadprüfung, Navigation/Popups/Webviews/Berechtigungen blockiert, IPC-Absender- und Payload-Validierung, Terminal-Startbefehle nur aus Allowlist (offizielle Login/Install-Befehle), Terminal-Arbeitsverzeichnis nur in Projekten/Home.
- Laufzeit nur auf 127.0.0.1, Bearer-Token pro Start (constant-time Vergleich).
- Agenten: kein Shell-Zugriff für lokale Modelle; Datei-Scope; Secrets werden nicht gelesen/geschrieben und vor jedem Modell-Kontext geschwärzt.
- **Ehrliche Einschränkung:** Validierungsbefehle (Tests/Typecheck des Projekts) laufen als Nutzer im Worktree mit Allowlist und secretfreier Umgebung – das ist Policy-Isolation, keine OS-Sandbox (in der UI unter Einstellungen gekennzeichnet). Codex bringt für Premium-Ausführung eine eigene OS-Sandbox mit (macOS/Linux), unter Windows nur eingeschränkt.

## 6. Tests

| Bereich | Datei | Art |
| --- | --- | --- |
| Sicherheit, Pfade, Befehls-Policy | `packages/engine/src/security/security.test.ts` | Unit |
| Git, Worktrees, Patch-Validierung, Konflikte, Rollback | `packages/engine/src/git/git.test.ts` | Integration (echtes git) |
| Planung, DAG, Normalisierung | `packages/engine/src/planning/planning.test.ts` | Unit |
| Scheduler (Parallelität, Locks, Pause/Abbruch, Recovery) | `packages/engine/src/scheduler/scheduler.test.ts` | Unit |
| Routing, adaptive Statistik | `packages/engine/src/routing/routing.test.ts` | Unit |
| Ollama-Client, lokaler Agent, Tool-Validierung | `packages/engine/src/agents/local-agent.test.ts` | gegen geskripteten Ollama-HTTP-Server (Mock) |
| Claude-Code-/Codex-Adapter | `packages/engine/src/orchestrator/adapters.test.ts` | Fake-CLIs mit aufgezeichneten Event-Formaten (Mock) |
| Validierung/Test-Parsing | `packages/engine/src/validation/checks.test.ts` | echte `node --test`-Läufe |
| Hardware, Katalog, Kosten, Repo-Index | `packages/engine/src/models/models.test.ts` | Unit |
| Ausführungs-Engine komplett | `packages/engine/src/engine/execution.test.ts` | echtes git + echte Tests, Modell geskriptet |
| Desktop-IPC | `apps/desktop/src/main/validation.test.ts` | Unit |
| **Live-E2E** | `apps/desktop/e2e/live-react-component.test.mjs` | echte App, echtes Modell, echter Orchestrator (opt-in) |

## 7. Status der Qualitätskriterien (verifiziert am 2026-10-09)

| Kriterium | Status | Nachweis |
| --- | --- | --- |
| Installierbare Desktop-Anwendung | ✓ Windows | `apps/desktop/release/Multi-AI Coder Setup 0.2.0.exe` gebaut; paketierte App startet (Laufzeit + Migrationen ok). Installer selbst nicht auf dem Entwicklungsrechner ausgeführt. |
| Lokales Repository öffnen | ✓ | Live-E2E über Ordner-Dialog |
| Claude Code / Codex angebunden, Abo-Login | ✓ | Status beider CLIs erkannt (claude.ai bzw. ChatGPT); Codex live im E2E für Planung genutzt; Claude Code live per Probe-Aufruf (structured output, Usage, Rate-Limit-Event) |
| Lokale Modelle installieren/verwalten | ✓ | `qwen2.5-coder:7b` über die App geladen (Job-Queue, Fortschritt, Speicherplatzprüfung, separater Modellordner), Selbsttest, Rollen |
| Echte lokale Inferenz, echter Patch | ✓ | Live-E2E: Komponente + Test vom lokalen Modell |
| Prüfung im isolierten Worktree, Tests | ✓ | Typecheck + Vitest im Worktree und im Integrations-Worktree |
| Nachvollziehbarer Diff | ✓ | Monaco-Diff-Tab, Bottom-Panel „Git-Diff“ |
| Freigabe & Integration | ✓ | „In Arbeitskopie übernehmen“ im E2E; Branch/Fast-Forward/Undo in Engine-Tests |
| Fehlgeschlagene Runs ohne Projektänderungen | ✓ | Engine-Tests (Abbruch, abgelehnte Patches); Integrations-Branch wird bei 0 integrierten Tasks entfernt |
| Persistente Logs/Run-Historie | ✓ | `RunEvent`, `AgentRun`, `ModelCall`, `ExecutionRun` in SQLite |
| Kosten tatsächlich vs. geschätzt | ✓ | Nutzung & Kosten-Ansicht, `summarizeUsage`-Tests |
| Fehlerzustände | ✓/teilweise | Abo-Limit, Session abgelaufen, Modell fehlt, Ollama nicht erreichbar, OOM, hängendes Modell, ungültiger Patch, Testfehler, Git-Konflikt, Absturz/Neustart der Laufzeit, App-Schließen während Run (→ „unterbrochen“, fortsetzbar) sind implementiert und überwiegend getestet; DB-Ausfall wird in der Queue abgefangen, aber nicht in jedem Service einzeln. |

## 8. Bekannte Einschränkungen / offene Punkte

- macOS-/Linux-Pakete sind konfiguriert, aber nur unter Windows gebaut und getestet.
- Code-Signing ist nicht eingerichtet (unsignierter Installer → SmartScreen-Warnung).
- Kein OS-Sandboxing für Projekt-Testbefehle (siehe §5).
- Die Next-Web-UI (`apps/web`) ist nicht auf die neuen Ausführungsansichten umgestellt; sie nutzt aber die echte Engine.
- Semantische Suche (Embeddings) ist nicht umgesetzt; Kontextauswahl erfolgt über Symbol-/Pfad-Ranking und Import-Graph.
- Ollama-Installation automatisch nur via winget/brew; unter Linux wird der offizielle Befehl angezeigt.
