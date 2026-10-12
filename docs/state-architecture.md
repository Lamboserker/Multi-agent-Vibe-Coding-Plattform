# Session- und State-Architektur (Phase 0.3 / Phase A)

Stand: 2026-10-09. Ergebnis des State-Audits und Beschreibung der neuen Architektur. Dateiverweise auf den
Stand **vor** der Änderung sind mit „alt:“ markiert.

## 1. Gefundene Ursachen für verlorene Sessions, Einstellungen und Arbeitskontexte

| # | Ursache | Betroffene Stelle (alt) | Reproduzierbares Szenario | Korrektur |
|---|---|---|---|---|
| 1 | Erneutes Auswählen des **bereits offenen** Projekts setzte Tabs, aktive Aufgabe und Ausführung zurück | alt: `renderer/lib/store.tsx` `selectProject()` (`setTabs([])`, `setTaskId(undefined)`, `setExecutionId(undefined)`) | Projekte → aktuelles Projekt anklicken → alle Tabs (inkl. ungespeicherter Inhalte) und der Chat sind weg | `actions.selectProject` ist für dasselbe Projekt ein No-Op; beim Projektwechsel wird der Arbeitsstand gespeichert und der des Zielprojekts geladen |
| 2 | Ein Neustart der lokalen Laufzeit (Absturz + automatischer Neustart) **unmountete die gesamte IDE** | alt: `App.tsx` (`if (runtime.state !== 'ready') return <RuntimeSplash/>`) | Laufzeit stürzt ab → Terminals werden beendet (Cleanup killte die PTYs), Chat-Entwurf, Fragen-Antworten, Download-Fortschritt weg | Splash nur bis zum ersten Start; danach bleibt die IDE gemountet, ein Banner zeigt den Neustart, `sync.resync()` liest alles neu aus der Laufzeit |
| 3 | Kein persistenter Arbeitsstand: Tabs, aktive Aufgabe/Session, Ansicht, Panel-Zustand, Cursor nur im React-State | alt: `store.tsx`, `execution.tsx` | „Ansicht → Neu laden“, Renderer-Absturz oder App-Neustart → nur das letzte Projekt kam zurück | Main-Process-State-Store (`main/state-store.ts`) + Persistenz-Controller (`renderer/lib/persistence.ts`) |
| 4 | **Ungespeicherte Editor-Inhalte** lebten nur im React-State; Schließen eines geänderten Tabs ohne Rückfrage | alt: `store.tsx` (`EditorTab.content`), `EditorArea.tsx` | Reload/Crash → Änderungen weg; Mittelklick auf Tab → weg | Inhalte in Monaco-Modellen (`editor-models.ts`), entprellte Drafts im Main-Prozess, Konflikterkennung per mtime, Rückfrage beim Schließen |
| 5 | **Race Condition im Settings-Cache**: Read-Modify-Write über mehrere `await` ohne Sperre; verschachtelte Objekte wurden aus veralteten Kopien komplett geschrieben | alt: `api/src/runtime/settings.service.ts` `update()`, `markOnboardingStep()`, `local-models.service.ts` `selfTest()` | Modell-Selbsttest (Minuten) läuft, währenddessen Rolle zuweisen oder Onboarding abschließen → Selbsttests anderer Modelle/Rollen bzw. `onboarding.completed` werden in der DB überschrieben; Einrichtungsassistent erscheint erneut | Mutex, eine Transaktion pro Update, Merge-Semantik für `onboarding`/`modelRoles`/`modelSelfTests`, Versionszähler, `settings_changed`-Event |
| 6 | Antworten paralleler Settings-Requests konnten in falscher Reihenfolge ankommen und neuere Werte in der UI zurücksetzen | alt: `store.tsx` `updateSettings()` | zwei Einstellungen schnell nacheinander ändern | Version im Response; ältere Versionen werden ignoriert (`actions.applySettings`) |
| 7 | Zahlenfelder in den Einstellungen mit `defaultValue` + `onBlur` | alt: `SettingsPanel.tsx` `numberField` | Wert tippen, per Tastatur/Shortcut die Ansicht wechseln oder neu laden → Wert verloren; externe Änderungen nicht sichtbar | `NumberField` mit Entwurf, Commit nach Pause/Enter/Blur/Unmount |
| 8 | Antworten im Modus „Frage“ nur im lokalen Komponenten-State; ohne Aufgabe mit `taskId = null` gespeichert und nie wieder angezeigt; blockierender HTTP-Request bis 5 min | alt: `ChatPanel.tsx` (`answers`), `orchestrator.controller.ts` `chat()` | Frage stellen → „Neue Aufgabe“, Reload oder Projektwechsel → Verlauf weg | Fragen laufen als Job `chat.ask` in einer persistenten Session; Migration ordnet alte Fragen einer Session „Fragen (übernommen)“ zu |
| 9 | Nach einem Neustart blieb eine unterbrochene Planung für immer „läuft“ | alt: `job-queue.service.ts` `recover()` markierte den Job, nicht aber `Task.currentStep = 'planning'` | Während der Planung App schließen → Spinner „Plan wird erstellt …“ dauerhaft | Recovery-Hooks: Status `plan_interrupted`, Systemnachricht, „Erneut planen“ (kein automatischer Premium-Aufruf) |
| 10 | Anzeige aktiver Ausführungen aus seit dem Mount gezählten Events abgeleitet | alt: `App.tsx` `activeRuns` | Reload während eines Runs → Statusleiste „bereit“, obwohl der Run läuft | `/activity` aus der Laufzeit (Runs, Planungen, Fragen) |
| 11 | Terminal-Prozesse gehörten React-Komponenten | alt: `TerminalInstance.tsx` (Cleanup `terminal.kill`), `BottomPanel.tsx` (`bottomOpen=false` unmountete das Panel) | Panel schließen → alle Shells beendet; Reload → PTYs verwaisen im Main-Prozess, Ausgabe verloren | `TerminalManager` im Main-Prozess mit Scrollback-Puffer, Attach/Detach, Verlauf über App-Neustarts |
| 12 | Ansichtsgebundener Zustand ging beim Wechsel der Seitenleiste verloren | alt: `ExplorerPanel.tsx` (aufgeklappte Ordner), `GitPanel.tsx` (Commit-Nachricht), `LocalModelManager.tsx` (Download-Fortschritt) | Commit-Nachricht tippen → Explorer → zurück: leer; Download läuft, Ansicht gewechselt → Fortschritt weg, erneuter „Laden“-Klick möglich | Keep-Alive der Seitenpanels, Workspace-State, Fortschritt aus der Job-Queue |
| 13 | Doppelstart-Races | alt: `execution.service.ts` `start()`/`approve()`, `job-queue.service.ts` `enqueue()` (Dedupe prüfte nur den neuesten Job eines Typs) | Doppelklick „Ausführung starten“ oder Request-Wiederholung nach Reload → zwei Runs; doppelte Freigabe → Change-Set doppelt angewendet | Sperren pro Aufgabe/Run, Dedupe über alle aktiven Jobs, Idempotenz-Schlüssel (`clientId`) für Nachrichten |
| 14 | Datei-Watcher nach Laufzeit-Neustart nicht neu registriert | alt: nur in `projects/open` | Laufzeit startet neu → externe Dateiänderungen erscheinen nicht mehr im Editor | `resync()` öffnet das Projekt erneut |
| 15 | StrictMode führte den Start-Effekt doppelt aus (zwei `projects/open`, zwei Resets) | alt: `AppProvider` `useEffect` | Dev-Modus: Restore konkurriert mit ersten Nutzeraktionen | Lebenszyklus außerhalb von React (`sync.startApp`, genau einmal pro Seite) |

Beim Audit zusätzlich gefunden und behoben (nicht UI-bezogen, aber datenrelevant):

- **Engine:** Erzeugte der deterministische Formatierer nach dem Agenten-Commit einen zweiten Commit, wurde bei der Integration nur dieser per `cherry-pick` übernommen – die eigentlichen Änderungen des Agenten fehlten. Jetzt werden die Commits einer Aufgabe vorher zusammengefasst (`squashSince`).
- **Job-Queue:** Ein neuer Job wurde von einem laufenden Tick verpasst bzw. durch Rundung der DB-Uhr erst beim nächsten Intervall (750 ms) gestartet.
- **Datenbank:** `busy_timeout` galt nur für die Migrationsverbindung; Migrationen liefen ohne Backup.

## 2. State-Klassen und wo sie leben

| Klasse | Beispiele | Ort | Schreibstrategie |
|---|---|---|---|
| 1. Globale Benutzereinstellungen | Orchestrator, Kostenmodus, Modellrollen, Selbsttests, Onboarding | Laufzeit, SQLite `AppSetting` | Mutex + Transaktion, Version, Bestätigung vor Anzeige als gespeichert |
| 2. Projekteinstellungen | (vorbereitet für Skills/Agenten je Projekt) | SQLite `Project.settings` | wie 1 |
| 3. Persistente Arbeitszustände | offene Tabs, aktiver Tab, Cursor/Scroll, aktive Session, Explorer, Chat- und Commit-Entwürfe, aktives Terminal, Ansicht, Panel | Main-Prozess `state-store.ts` (`ui`, `workspace:<projectId>`) | Write-Behind (300 ms), atomar (Temp-Datei + Rename, `.bak`), Epoch-Schutz, synchroner Flush bei Reload/Beenden |
| 3a. Ungespeicherte Editor-Inhalte | Text geänderter Dateien | Monaco-Modelle + Drafts im Main-Prozess | entprellt (400 ms), kein Snapshot pro Tastendruck, Konflikterkennung per mtime |
| 4. Kurzlebiger UI-State | offene Dialoge, Hover, Suchtreffer | Komponenten-State | nicht persistiert |
| 5. Laufende Prozesse & Recovery | Sessions, Runs, Jobs, Planungen, Fragen, Terminals | Laufzeit (SQLite) bzw. Main-Prozess (PTYs) | Zustandsübergänge transaktional; Recovery beim Start |

Grundsatz: **Laufende Arbeit gehört nie einer Komponente.** Runs, Planungen und Fragen sind Jobs der Laufzeit,
Terminals Prozesse des Main-Prozesses. Die UI zeigt sie nur an und kann beliebig neu gemountet werden.

## 3. Sessions

Neues Modell `ChatSession` (Migration `20261010090000_sessions_and_state`, nur `ADD COLUMN`/`CREATE`, Backup vor der Migration):

- Felder: ID, Projekt, Titel, Status, Provider, externe CLI-Session-ID (`externalSessionId`), angeheftet, archiviert, letzte Aktivität, aktive Aufgabe, Recovery-Metadaten (`pendingAsk`, `interruptedAsk`).
- Nachrichten und Aufgaben gehören zu einer Session; Nachrichten tragen einen optionalen Idempotenz-Schlüssel (`clientId`, unique).
- Status (`active | idle | running | paused | interrupted | completed | failed | archived`) wird in `session-model.ts` **aus dem tatsächlichen Laufzeitzustand abgeleitet** (Runs, Plan-/Frage-Jobs) und bei Zustandsänderungen neu berechnet. Ein beendeter Prozess wird nie als laufend angezeigt.
- Bestehende Daten werden migriert: jede Aufgabe → eine Session; Fragen ohne Aufgabe → Session „Fragen (übernommen)“.

API: `GET/POST /projects/:id/sessions`, `GET/PATCH/DELETE /sessions/:id`, `POST /sessions/:id/messages` (`mode: task|ask`, `clientId`), `POST /sessions/:id/retry-plan`, `GET /sessions/:id/export?format=md|json`, `GET /projects/:id/session-search?q=`, `GET /activity`.

## 4. Recovery nach Neustart (Reihenfolge)

1. `ExecutionService.recover()` – aktive Runs → `interrupted` (fortsetzbar), verwaiste Task-Worktrees entfernen.
2. `JobQueueService.start()` – laufende Jobs → `requeue` (Downloads) bzw. `interrupt`; Hooks melden Unterbrechungen an die Sessions (Planung → `plan_interrupted`, Frage → `interruptedAsk` + Systemnachricht).
3. `SessionsService.recover()` – hängende Planungen ohne Job, verwaiste `pendingAsk`, alle Status neu berechnen.
4. Renderer: `ui`-Dokument → Einstellungen → letztes Projekt → Workspace (Tabs aus Datei + Draft, Diff-Tabs aus ihrer Quelle) → Sitzungsliste → aktive Session → Aufgabe/Run.

**Idempotente Wiederaufnahme eines Runs:** Der Integrations-Branch ist die Quelle der Wahrheit. Beim Fortsetzen erkennt
`ExecutionRunner.reconcileIntegrated()` bereits integrierte Aufgaben am Commit-Betreff `<key>: <titel>` und führt sie nicht
erneut aus – auch wenn das DB-Update vor der Unterbrechung verloren ging. Eine als „completed“ markierte Aufgabe ohne
Commit auf dem Branch läuft erneut. Premium-Aufrufe werden nach einer Unterbrechung nie automatisch wiederholt.

**Terminals:** Ein App-Neustart beendet die Shell-Prozesse (eine echte Fortsetzung eines beendeten Prozesses ist
nicht möglich). Wiederhergestellt werden Titel, Arbeitsverzeichnis und die letzten 64 KB Ausgabe, gekennzeichnet als
„Verlauf der letzten Sitzung“; „Neu starten“ startet eine neue Shell im selben Verzeichnis. Navigation, Schließen des
Panels und Renderer-Reloads beenden dagegen keinen Prozess mehr (Re-Attach mit Scrollback).

## 5. Autosave-Regeln

- Debouncing: UI/Workspace 300 ms, Editor-Drafts 400 ms, Chat-Entwurf 250 ms, Settings-Zahlenfelder 700 ms.
- Atomare Writes (Temp + Rename), `.bak` der letzten lesbaren Datei, Epoch-Schutz gegen veraltete Writes nach Reload.
- Flush: synchron bei `beforeunload` (Reload/Schließen) und auf Anforderung des Main-Prozesses beim Beenden (`app:flush`).
- Bestätigte Persistenz vor Erfolgsanzeige: Chat-Nachrichten erscheinen sofort als „wird gespeichert …“ und gelten erst
  nach Bestätigung der Laufzeit als gesendet; Fehlschläge behalten den Text („Erneut senden“ mit demselben
  Idempotenz-Schlüssel). Freigaben und Run-Übergänge sind serverseitig gesperrt und transaktional.

## 6. Tests

| Test | Datei |
|---|---|
| Migration mit Bestandsdaten (kein Datenverlust, Backfill, Backup, Idempotenz) | `apps/api/src/runtime/migrator.test.ts` |
| Settings: parallele Updates, Merge, Version, Neustart | `apps/api/src/runtime/settings.test.ts` |
| Sessions: Idempotenz, Fragen als Job, Recovery Planung/Frage, Archiv/Suche/Export; kein doppelter Run | `apps/api/src/sessions/sessions.test.ts` |
| Idempotente Wiederaufnahme, Squash vor Integration | `packages/engine/src/engine/execution.test.ts`, `packages/engine/src/git/git.test.ts` |
| State-Store (atomar, Epoch, Drafts, `.bak`), Terminal-Scrollback | `apps/desktop/src/main/state-store.test.ts`, `apps/desktop/src/main/terminal.test.ts` |
| GUI: 32 Ansichtswechsel, Reload, Renderer-Crash, App-Neustart | `apps/desktop/e2e/session-persistence.test.mjs` |
| GUI: Navigation während eines echten lokalen Runs | `apps/desktop/e2e/navigation-run.test.mjs` |
