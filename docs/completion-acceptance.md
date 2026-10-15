# Restarbeiten und Abnahme nach Audit

> Aktuelle Abnahme: [Gezielte Stabilisierung vom 13.10.2026](stabilization-2026-10-13.md).
> Die folgenden Angaben sind der historische Übergabebericht, keine vollständige Abnahme des
> inzwischen geänderten Quellstands. Der zweite Codex-Lauf ist jetzt durch das lokale CLI-Archiv
> belegt; weitere Nachweislücken und der veraltete Installer sind im neuen Bericht getrennt aufgeführt.

Stand des historischen Berichts: 13.10.2026. Ausgangspunkt: `codex/platform-completion`, HEAD
`a88dd760bda5abcf856ccbd1bf3d8b9e4060002e`, vorhandene uncommittete Änderungen erhalten.
Der ursprüngliche Auftrag liegt im externen Scratchpad unter
`audit/mandate.txt`; die Audit-Sicherung enthält `tracked.diff`, `untracked-files/`,
`gitlab-check.mjs` und `installed-smoke.test.mjs`. Eine `AGENTS.md` wurde im
Projekt und im zugehörigen Scratchpad bisher nicht gefunden.

Diese Liste ist die Abnahmegrundlage; alte Testergebnisse sind keine Nachweise für
nachträgliche Änderungen. „Offen“ umfasst Implementierung und erneute Prüfung.

| Befund / ursprüngliche Anforderung | Abnahmekriterium | Status |
|---|---|---|
| MCP an Claude/Codex (§5) | Offizielle CLI-Konfiguration; isolierte, rollenbezogene Server/Werkzeuge; keine globale Änderung; stdio/HTTP/SSE; echte lokale MCP-Aufrufe über CLI-Konfiguration ohne Modellkosten prüfen | umgesetzt, lokal geprüft (N1, N2) und live mit echtem Modell über Claude Code und Codex bestanden |
| MCP-Kontextoptimierung (§5) | Hauptorchestrator erhält kleine Discovery-Schnittstelle; tatsächliche Werkzeugschemas erst bei Suche; Zugriff bei jedem Aufruf erneut prüfen | umgesetzt, geprüft (N1, N3) |
| MCP-OAuth (§5) | SDK-Autorisierung mit Discovery, PKCE, State, Callback, verschlüsselter Tokenablage und Refresh; Auth-Fehler/Abbruch/Logout prüfen | umgesetzt, gegen lokalen OAuth-Server geprüft (N4); echter Anbieter nicht geprüft |
| Gekürzte MCP-Ergebnisse (§5) | Vollständiger paginierter Abruf über opaque Referenz, begrenzte Lebensdauer und gleiche Agentenberechtigungen | umgesetzt, geprüft für Orchestrator, lokale Agenten und UI (N3, N5) |
| Sechs Plugin-Erweiterungspunkte (§3.2) | Implementierungen im Host erhalten; typsichere RPC-Aufrufe; Routing für Modell, Orchestrator, Analyzer, Tests, Sprache, Git; Referenzimplementierungen mit Fehler/Disable/Restart prüfen | umgesetzt, geprüft (E1–E4) |
| GitHub (§3.4) | Repositories, Branches, PRs, Issues und Review lesen/erstellen; Schreibtests ausschließlich lokale API-Testumgebung | umgesetzt, gegen lokale API geprüft (F1, F2) |
| GitLab (§3.4) | Projekte, MRs, Issues über gültige API-Endpunkte; lokale API-Verifikation und Auth-Fehler | umgesetzt, gegen lokale API geprüft (F1, F2) |
| Docker (§3.4) | Devcontainer aus Konfiguration starten, Status/Logs/Stop; Integration mit laufendem Daemon | umgesetzt, mit laufendem Daemon geprüft (D1) |
| PostgreSQL (§3.4) | Tatsächliches Database-Plugin gegen isolierten Server: Schema, Read-only und bestätigte Schreibabfrage | über das Plugin gegen isolierten PostgreSQL-16-Container geprüft (D2) |
| Skills (§4.2/4.4) | Export inkl. Ressourcen; Builder für Tools, Aktionen, Ressourcen, Testaufgabe; Projektaktivierung; Roundtrip und Isolation prüfen | umgesetzt, geprüft (S1) |
| Editor-KI (§6) | Refaktorieren, Tests, Fix, Review mit überprüfbarem Ergebnis; Datei/Ordner/Diff-Kontext; Task aus Problem; GUI-Abnahme | GUI-geprüft (G1); Ergebnis eines Tasks über die Run-Pipeline (Validierung + Freigabe) |
| Terminal (§6) | Befehlshistorie erfassen, anzeigen, wiederverwenden und getrennt vom Scrollback persistieren | umgesetzt (Windows/PowerShell), mit echter Shell geprüft (T1) |
| Agentenlimits (§7) | Kontextbudget, Datei-/Prozess-/Toolberechtigungen und Zeit-/Ressourcenlimits bei echter Ausführung durchsetzen | umgesetzt, bei echter Ausführung geprüft (A1) |
| LSP (§6) | Standard-LSP-Client mit initialize, Dokument-Sync, Requests, Diagnosen und Shutdown an vorhandenem Language Server | behoben, geprüft (L1) |
| UI-Listen (§2.3/9) | 10.000 Logs, große Chats, 1.000 Explorer-Dateien; DOM-Arbeit begrenzen und Messwerte dokumentieren | umgesetzt (V1); Messwerte siehe Verifikation |
| TTFT (§2.9) | Tatsächlichen ersten Streaming-Token messen und Diagnoseansicht/Export anbinden | umgesetzt, geprüft (V2) |
| Belastung (§9) | Parallele Agenten, häufige Events und lange Sessions mit Messbedingungen, Speicher- und Latenzwerten prüfen | gemessen (G2) |
| Persistenz (§1/11) | Navigation ≥30 Wechsel, Reload, Neustart, Crash-Recovery mit isoliertem Profil; keine doppelten Runs/Datenverluste | GUI-geprüft am finalen Stand (G3); Live-Neustarttest: Wiederaufnahme ok, Endergebnis vom lokalen Modell abhängig |
| Regression (§9/11) | Tests, Typecheck, Lint, Build erfolgreich; Skips konkret nennen; keine Abo-/API-Aufrufe ohne Zustimmung | am finalen Stand grün (R1); Skips benannt |
| Packaging (§10 G) | Finalen NSIS-Installer bauen; installieren; isoliertes Profil testen; Version, SHA-256 und Build-Zuordnung erfassen | erledigt (P1) |

## Ausführungsgrenzen

Keine Commits, Resets oder Änderung globaler CLI-Konfigurationen. Keine echten
Reviews/Issues veröffentlichen. Premium-Live-Tests bleiben bis ausdrücklicher
Zustimmung ungestartet; CLI-Hilfe und lokale MCP-/Plugin-Prozesse verbrauchen kein
Modellkontingent. Eine Installer-Signatur ist keine offene Pflichtanforderung.

## Nachweise dieser Umsetzung

Installierte CLI-Versionen
per `--version`: Codex 0.153.4, Claude Code 2.1.86. CLI-Hilfe und offizielle
[Codex-MCP-Dokumentation](https://developers.openai.com/codex/mcp/),
[Codex-Konfigurationsreferenz](https://developers.openai.com/codex/config-reference/),
[Claude-MCP-Dokumentation](https://code.claude.com/docs/en/mcp) gelesen.

### MCP

- **N1 – Gesamtkette ohne Modellaufruf** (`apps/api/src/mcp/orchestrator-mcp.test.ts`, 3/3 grün):
  OrchestratorService → Claude-/Codex-Adapter → Aufrufkonfiguration → Session-Gateway → McpService →
  echter stdio-MCP-Server (offizielles SDK). Die CLI-Binärdateien sind lokale Stellvertreter
  (`MAC_CLAUDE_BINARY`/`MAC_CODEX_BINARY`), die die übergebene Konfiguration wie die echte CLI
  auswerten und per SDK-Client `search_tools` → `call_tool` ausführen. Geprüft: Antwort enthält
  das Ergebnis des echten Tools (7341); Claude erhält `--mcp-config` mit nur dem Gateway und
  `--strict-mcp-config`; Codex erhält `--disable plugins`, `mcp_servers.<nutzer>.enabled=false`
  je aktivem Nutzer-Server und `enabled_tools` nur für die drei Gateway-Werkzeuge; ein nur dem
  Coder zugewiesener Server ist für den Chat unsichtbar und nicht aufrufbar; das Gateway ist nach
  dem Aufruf geschlossen. Keine globale Konfiguration wird geschrieben (Claude: temporäre Datei pro
  Aufruf; Codex: `-c` pro Aufruf).
- **N2 – echte CLIs ohne Modellaufruf:** `claude mcp list` mit isoliertem `CLAUDE_CONFIG_DIR`
  und der vom Adapter erzeugten Konfiguration meldet das Gateway als „✓ Connected“;
  `codex mcp list --json` mit den Adapter-Overrides zeigt nur `app` aktiv. Ein Werkzeugaufruf durch
  das echte Modell ist erst nach Zustimmung möglich (siehe „Ausstehende Live-Tests“).
- **N3 – Discovery und vollständige Ergebnisse:** `mcp-gateway.test.ts` (Schemas erst bei Suche,
  Isolation, `read_result`, 404 bei falscher Route) und `mcp.test.ts`: lokale Agenten erhalten bei
  langen Ergebnissen Seite 1 plus Referenz; `mcp_read_result` liefert den vollständigen Text
  (50.000 Zeichen zusammengesetzt geprüft); die Referenz ist aus einem anderen Lauf nicht lesbar.
  Gemeinsame Implementierung: `apps/api/src/mcp/mcp-results.ts` (16 Ergebnisse, 16 MB je Lauf).
- **N4 – OAuth** (`apps/api/src/mcp/mcp-oauth.test.ts`, 5/5 grün) gegen einen lokalen
  Autorisierungsserver nach MCP-Spezifikation: Protected-Resource- und AS-Metadaten, dynamische
  Registrierung, PKCE S256 (Server prüft Verifier), State (gefälschter Callback → 400, Login bleibt
  gültig), Loopback-Callback einmalig, Tokens nur im (simulierten) Desktop-Tresor und nicht in der
  Datenbank, transparenter Refresh nach Token-Entzug, Logout löscht Client und Tokens. Behobener
  Fehler: ohne Anmeldung kam eine unverständliche SDK-Meldung und eine nutzlose Registrierung –
  jetzt „OAuth login required … OAuth anmelden“ ohne Registrierung. Entfernte Endpunkte ohne HTTPS
  werden abgelehnt.
- **N5 – UI:** manuelle Aufrufe zeigen eine Vorschau (100.000 Zeichen); bei Kürzung zeigt der
  MCP-Manager „gekürzt: x von y Zeichen“ und „Vollständig speichern…“ (Speicherdialog,
  vollständiger Text); API-Test in `mcp.test.ts`.
- **N6 – Fehlerdiagnose:** `diagnoseMcpError` ergänzt Statusmeldungen um Handlungshinweise
  (fehlender Befehl – unter Windows nur als „Connection closed“ sichtbar, daher Pfadauflösung –,
  nicht erreichbar, 401/403/404, TLS, Timeout, fehlende Secrets/OAuth); Unit- und Integrationstest.

### Plugin-Erweiterungspunkte

- **E1 – Referenz-Plugin** `plugins/reference-extensions` (mitgeliefert, deaktiviert bis zur
  Rechtevergabe) implementiert alle sechs Verträge mit echter Funktion: OpenAI-kompatibler lokaler
  Modellanbieter (nur 127.0.0.1/localhost), lokaler Orchestrator darauf (Analyse, Plan,
  Ausführung mit Dateiänderungen, Review, Chat), Manifest-Analyse, Test-Runner (npm/pnpm/yarn
  test, pytest; Zählung für vitest/jest/node:test/mocha/pytest), JSON-Diagnosen mit exakter
  Fehlerposition, Git über die git-CLI.
- **E2 – Aufrufstellen** (`apps/api/src/plugins/reference-extensions.test.ts`, 7/7 grün, lokaler
  Attrappen-Modellserver): Modellanbieter über `LocalModelsService.engineProfiles/clientFor`;
  Orchestrator über `OrchestratorService.active()` mit allen fünf Operationen, Ausführung schreibt
  nur in den übergebenen Worktree; Analyzer im Planungs-Digest (`RepoContextService.digest`);
  Test-Runner über `runValidationChecks` (3 bestanden/0 fehlgeschlagen); Sprache über
  `IdeService.fileDiagnostics` (JSON-Fehler Zeile 4; `.ts` fällt per `{ unsupported: true }` auf
  den eingebauten Server zurück); Git-Status/-Diff/-Branches identisch zur eingebauten Git-Ansicht.
  UI: Auswahl je Erweiterungsart im Plugin-Panel (`PluginsPanel`).
- **E3 – Behobene Fehler:** (a) Analyse und Plan kamen beide als `plan` ohne Unterscheidung an –
  jetzt `operation` und strenges `schema` je Aufruf, Ergebnisse werden wie bei Claude/Codex
  normalisiert/validiert; (b) Sprach- und Git-Erweiterungen übernahmen alle Dateien – jetzt
  Rückfall per `{ unsupported: true }`, Git-Ergebnisse werden geprüft; (c) einheitlich 30 s
  Zeitlimit mit Plugin-Neustart – jetzt je Art (Tests 10 min, Orchestrator 15 min, Modell
  10 min); (d) `fs`/`process` arbeiteten nur im geöffneten Projekt, ein Test-Runner hätte den
  falschen Ordner statt des Agenten-Worktrees geprüft – jetzt delegierte Verzeichnisse für die
  Dauer eines Aufrufs.
- **E4 – Isolation/Fehler/Neustart:** `plugins.test.ts` (11/11): alle Verträge im isolierten
  Host, Fehlerweitergabe, nicht deklarierte Methoden abgelehnt, Disable → kein stiller Rückfall,
  Enable → neuer Prozess; ein Plugin kann keine beliebigen Pfade über `root` lesen und eine
  Freigabe nach Ende des Aufrufs nicht weiter nutzen. Referenz-Plugin: Server nicht erreichbar →
  klare Meldung, nicht-lokale URL abgelehnt, Disable/Enable im laufenden Betrieb.

### LSP

- **L1** – `apps/api/src/ide/lsp-client.ts`: Ursache der leeren Diagnosen war die fehlende
  Client-Fähigkeit `publishDiagnostics` (typescript-language-server sendet sonst keine) und
  unterschiedliche URI-Schreibweisen (`file:///c%3A/…`). Jetzt: Versionsabgleich der Diagnosen mit
  Ruhephase, semantische Anfragen erst nach Projekt-Laden (vorher zeigte „Definition“ auf den
  Import), Plattenänderungen über `workspace/didChangeWatchedFiles` und Invalidierung.
  `ide.test.ts` vollständig grün (Definition/Referenzen/Umbenennen/Hover über Dateien,
  Diagnosen für ungespeicherten Inhalt und nach Änderung einer importierten Datei).

### GitHub, GitLab, Docker, PostgreSQL

- **F1 – Host-Freigabe per Einstellung:** Die Einstellungen „GitHub/GitLab API-URL“ waren
  wirkungslos (nur `api.github.com`/`gitlab.com` freigegeben, keine weitere Freigabe möglich).
  Neu: `SettingContribution.grantsHost` – der vom Nutzer eingetragene Host (genau Host:Port) ist
  für dieses Plugin erreichbar; Plugins können ihre Einstellungen nicht selbst ändern. Test in
  `plugins.test.ts` (nur lokal): ohne Einstellung bzw. mit nicht markierter Einstellung verweigert,
  danach nur exakt dieser Host:Port.
- **F2 – `forge-plugins.test.ts` (5/5 grün)** – die mitgelieferten Plugins gegen einen lokalen
  API-Testserver, Token aus dem (simulierten) Desktop-Tresor: GitHub Repositories, Branches,
  Reviews, PR-/Issue-Kontext, Agent-Tool; Review veröffentlichen nur mit Bestätigung und mit genau
  dem eingegebenen Inhalt (aufgezeichneter POST), Issue anlegen; ungültiges Token → klare Meldung.
  GitLab Projektsuche, Merge Requests, Issues, Pipelines, Logs fehlgeschlagener Jobs, nur GET.
  **Hinweis:** Ein erster, inzwischen entfernter Testentwurf schickte mit dem Standardwert der
  API-URL eine einzelne Lese-Anfrage (GET Branches von `acme/demo`) mit Platzhalter-Token an
  `api.github.com` (Antwort 401). Es wurde nichts veröffentlicht; der Test setzt die API-URL jetzt
  vor jeder Anfrage auf den lokalen Server.
- **D1 – Devcontainer** (`docker-services.integration.test.ts`, opt-in `MAC_TEST_DOCKER=1`,
  Docker 29.3.1, nur lokal vorhandene Images, eigene Container/Images werden entfernt): JSONC mit
  Kommentaren/Schlusskommas, `containerEnv`, Projekt-Mount, `postCreateCommand` einmalig,
  `postStartCommand` bei jedem Start, Stopp/Start/Logs/Entfernen, Build-Variante mit Kontext
  `..` und `workspaceFolder`; `features` werden mit Begründung abgelehnt, `initializeCommand`
  (liefe auf dem Host) ebenso. Vorher: JSONC scheiterte, `postCreateCommand` wurde pauschal
  abgelehnt, Build-Kontext `..` (üblich) war verboten.
- **D2 – PostgreSQL über das Database-Plugin** gegen einen isolierten `postgres:16`-Container:
  Schema (Befehl und Agent-Tool), Lesen, Schreiben ohne Bestätigung nicht ausgeführt, mehrere
  Anweisungen gelten als Schreiben, ein schreibendes `SELECT nextval(…)` wird von PostgreSQL in
  der READ-ONLY-Transaktion abgelehnt, bestätigtes Schreiben ausgeführt, Agent-Tool nur lesend,
  falsches Passwort → Fehlermeldung.

### Skills und Agentenlimits

- **S1 – Skills** (`skills.test.ts`, 9/9): Die Builder-Felder wurden bisher nur gespeichert.
  Jetzt wirksam: „Erlaubte Aktionen“ begrenzen die Skripte, die Agenten ausführen dürfen (auch
  freigegebene andere Skripte werden abgelehnt, das Agent-Tool nennt nur erlaubte); Tools,
  Aktionen und Ressourcen stehen in den Anweisungen, die der Agent erhält; Ressourcen nur als
  Dateien im Skill-Ordner oder http(s)-URL (Validierung); „Testaufgabe prüfen“ (UI und
  `POST /skills/:key/test`) prüft ohne Modellaufruf Auswahl/Relevanz, fehlende Ressourcen, für
  die Rolle nicht verfügbare Tools und Aktionen ohne Skript. **Behobener Fehler:** Der Export
  kopierte `SKILL.md` nicht mit (exportierter Skill unbrauchbar). Roundtrip aller Felder,
  Export inkl. Ressourcen/Skripte, Aktivierung nur für ein Projekt geprüft.
- **A1 – Agentenlimits** (`packages/engine/src/engine/execution.test.ts`, 17/17, echtes git,
  echte Validierung): lokal – ohne Schreibrecht jede Schreiboperation abgelehnt, Dateilimit,
  Kontextbudget (`num_ctx`), Ausgabe-Token-Limit (`num_predict`) und Zeitlimit eines
  hängenden Modellaufrufs. Premium – bisher ignoriert, jetzt durchgesetzt: Zeitlimit und „keine
  externen Tools“ (keine MCP-Server) im CLI-Aufruf, ohne Schreibrecht wird jede Änderung der CLI
  vor der Integration verworfen, `maxRepairs` wird beachtet (vorher fest 2 Runden), „kein
  Leserecht“ ist bei einer CLI nicht durchsetzbar und wird vor dem Aufruf abgelehnt.
  Validierung der Profile in `agent-profiles.test.ts`.

### Terminal, Listen, TTFT

- **T1 – Befehlshistorie** (`apps/desktop/src/main/terminal.test.ts`, echte PowerShell im PTY):
  Befehle werden über die PSReadLine-Integration erfasst, Eingaben an `Read-Host` (z. B.
  Passwörter) nicht; die Historie wird getrennt vom Scrollback gespeichert und nach einem
  Neustart wiederhergestellt; Anzeige/Wiederverwendung im Terminal („Befehlshistorie“).
  Einschränkung: Für bash/zsh (macOS/Linux) gibt es noch keine Shell-Integration – Ziel-Plattform
  dieses Builds ist Windows.
- **V1 – Listen:** neue `VirtualList` (gemessene Zeilenhöhen, nur sichtbarer Ausschnitt im DOM,
  Mitlaufen am Ende). Run-Logs: vorher wurden ab 1.500 Zeilen ältere ausgeblendet und waren nicht
  mehr erreichbar – jetzt alle Zeilen scrollbar bei begrenztem DOM. Explorer: aufgeklappter Baum
  als virtualisierte Zeilen. Chat: ältere Nachrichten seitenweise nachladbar (vorher nur über den
  Export), Nachrichten außerhalb des Sichtbereichs per `content-visibility` ohne Layout/Paint.
- **V2 – TTFT:** lokal (Ollama-Stream, erster Token) bereits gemessen, aber nicht angezeigt; neu
  für Claude Code der echte erste Token (`--include-partial-messages`, Text-Delta) und für Codex
  das erste Modell-Ausgabeereignis (Codex `exec --json` liefert keine Token-Deltas – als „erste
  Ausgabe“ gekennzeichnet). Diagnoseansicht zeigt p50/p95, der Diagnose-Export enthält Werte und
  Stichproben. Geprüft in `orchestrator-mcp.test.ts`.

## Ausstehende Live-Tests (nur nach ausdrücklicher Zustimmung)

Vorbereitet in `apps/api/src/mcp/orchestrator-mcp.live.test.ts`, gesperrt durch `MAC_LIVE_PREMIUM_MCP`.
Je CLI genau **ein** Modellaufruf über das jeweilige Abo (Chat-Rolle, kurze Frage, keine Dateiänderung,
temporärer Arbeitsordner, globale CLI-Konfiguration unverändert):

```
cd apps/api
MAC_LIVE_PREMIUM_MCP=claude npx vitest run src/mcp/orchestrator-mcp.live.test.ts   # 1 Aufruf Claude Code
MAC_LIVE_PREMIUM_MCP=codex  npx vitest run src/mcp/orchestrator-mcp.live.test.ts   # 1 Aufruf Codex
```

Erwartet: Das echte Modell ruft über das Session-Gateway `search_tools` und `call_tool` auf, das
MCP-Protokoll zeigt `agent call magic_number`, die Antwort enthält 7341. Nebenbei entsteht je ein
echter TTFT-Messwert (Claude: erster Token, Codex: erste Ausgabe).

## Verifikation am finalen Stand (13.10.2026)

- **R1 – Regression:** `pnpm build`, `pnpm typecheck`, `pnpm lint` fehlerfrei. `pnpm test`: Engine 136,
  API 84 grün/8 übersprungen (nach einer Timing-Korrektur im Sitzungstest: Antwort wird vor dem Löschen von `pendingAsk` gespeichert, der Test wartet jetzt auf beides – unter Last war er einmal rot), Desktop 29, Plugin-SDK 4, Shared 3 – alle grün. Übersprungen: 4 Docker-Tests
  (opt-in `MAC_TEST_DOCKER=1`; mit laufendem Daemon heute zweimal grün, beim Schlusslauf war Docker Desktop
  außerhalb dieser Arbeit beendet), 2 Premium-Live-Tests (opt-in; mit Zustimmung separat ausgeführt und bestanden), PostgreSQL-Direkttreiber
  (`MAC_TEST_POSTGRES_URL`; ersetzt durch D2 über das Plugin), echtes GitHub (`MAC_TEST_NETWORK`, bewusst nicht
  ausgeführt). Kein Claude-/Codex-Aufruf und keine kostenpflichtige API in allen Tests.
  Zusätzlich behoben: Plugin-Deinstallation scheiterte unter Windows sporadisch mit `EBUSY` (Ordner noch vom
  beendeten Host-Prozess gehalten) – jetzt mit Wiederholungen.
- **G1 – Editor-KI (GUI, `e2e/load-and-editor.test.mjs`):** „KI: Code refaktorieren / Tests generieren /
  Fehler korrigieren / Code-Review“, Datei-/Ordner-/Git-Diff-Kontext und „Task erstellen“ aus dem
  Probleme-Panel landen im Chat-Eingabefeld (Task-/Fragemodus) und laufen von dort durch Planung,
  Ausführung im Worktree, Validierung und Freigabe. **Behobene Fehler:** (a) das Eingabefeld übernahm
  extern vorbereitete Entwürfe nur bei Sitzungswechsel – alle diese Befehle waren in der UI wirkungslos;
  (b) ein verzögerter Tipp-Schreibvorgang konnte einen gerade vorbereiteten Entwurf überschreiben;
  (c) `.tsx`/`.jsx` wurden dem Language Server als `typescript` gemeldet (JSX-Parserfehler, keine
  Definitionen in React-Projekten).
- **G2 – Belastung** (Referenzsystem Ryzen 7 5800X, 32 GB, Windows 11; isoliertes Profil):

  | Szenario | Messwert |
  |---|---|
  | Explorer, Ordner mit 1.000 Dateien aufklappen | 280–311 ms (2,2 s in einem Lauf parallel zum CPU-lastigen Agenten-Belastungstest), 49 DOM-Zeilen, letzte Datei per Scroll erreichbar und öffnbar |
  | Chat mit 2.000 Nachrichten öffnen | 10–21 ms bis sichtbar, 200 DOM-Nachrichten; ältere Seite (100) 81–101 ms |
  | Run-Log mit 10.000 Zeilen | vollständig geladen, 32 DOM-Zeilen, Anfang/Mitte/Ende per Scroll erreichbar |
  | Long Tasks nach Neustart mit diesen Daten | 0; Renderer-Heap 27–31 MB |
  | 12 parallele lokale Agenten (Modell-Attrappe 400 ms/Aufruf, echtes git + Validierung) | sequentiell 22,1 s, 4 Slots 7,5 s (×2,97), alle 12 integriert, keine Worktree-Reste (gemessen unter Last parallel zur GUI-Suite) |
  | Lange Session mit echtem lokalem Lauf (`qwen2.5-coder:7b`, finaler Build) | 40 Navigationen während des Laufs p50 31 ms/p95 54 ms; Persistenztest: 32 Navigationen p50 37/p95 92 ms, Reload 358 ms, Renderer-Absturz 1,1 s, Neustart 1,3 s; 0 Premium-Aufrufe |

- **GUI-Suite am finalen Build:** agents, fast-path, ide-features, plugins, session-persistence, skills-mcp,
  terminal, load-and-editor, packaged-smoke: 9/9 grün; Live mit lokalem Modell: navigation-run (Lauf über
  Navigation/Reload/Neustart) grün. Nicht ausgeführt: `live-react-component` (nutzt Codex-Abo),
  `agent-tools.live`/`ai-edit.live` (lokal, in dieser Runde nicht wiederholt).
- **G3 – Persistenz/Recovery am finalen Stand:** `session-persistence` (Navigation, Reload, Renderer-Absturz,
  Neustart) grün; Live-Test „echter Lauf über Navigation, Reload, Neustart“ grün; Live-Test „Neustart während
  eines Laufs“: Lauf korrekt als `interrupted` markiert, fortgesetzt und in seiner Sitzung geblieben, endete
  aber in zwei Durchgängen mit `failed`, weil das lokale 7B-Modell die Validierung dreimal nicht bestand
  (dasselbe Modell scheiterte im selben Durchgang auch ohne Unterbrechung) – Modellqualität, nicht Recovery.
- **P1 – Installer:** `apps/desktop/release/Multi-AI Coder Setup 0.3.0.exe`, 148 362 225 Bytes,
  SHA-256 `223e4078407e88715d73f8ce529533ef3c680e33b46c6b2d2c0b20806b3d8374` (Neubau nach der Codex-Korrektur), Version 0.3.0 (vorher 0.2.0).
  Build-Zuordnung im Paket (`resources/app/build-info.json`): Commit `a88dd760` auf
  `codex/platform-completion` + 171 uncommittete Änderungen, Arbeitsstand-Hash
  `f0ea0525fca11cb3092e17f408aa6e8069faca479a55e5b297b4d72e2da984ec`, gebaut 2026-10-13 13:02 UTC.
  Still installiert in einen Temp-Ordner, Smoke-Test der **installierten** EXE mit isoliertem Profil
  (Version 0.3.0, `packaged: true`, Laufzeit 1,7–2,5 s, 7 Plugins, Skills, Plugin-Host, TS-Worker, MCP,
  Laufzeit-Absturz → Neustart) grün, danach rückstandslos deinstalliert (Ordner, Registry, Verknüpfungen);
  der echte Profilordner `%APPDATA%Multi-AI Coder` wurde nicht verändert. Nicht signiert (laut Audit keine Pflicht).

### Live-Tests nach Zustimmung (13.10.2026)

- **Claude Code – bestanden:** echter Modellaufruf über das Abo (`billing: subscription`), das Modell rief
  über das Session-Gateway `search_tools` und `call_tool` auf, das MCP-Protokoll zeigt `agent call
  magic_number`, Antwort `7341`. Dauer 7,6 s, 12.871 Eingabe-/265 Ausgabe-Token (9.499 aus dem Cache),
  erster Token nach 2,35 s.
- **Codex – fehlgeschlagen, Ursache behoben:** Antwort „automatic approval review rejected search_tools
  because approval is required but the approval policy is set to never“. `codex exec` läuft mit
  Freigaberegel „never“; MCP-Werkzeuge ohne Annotationen verlangen im Standardmodus `auto` eine Freigabe
  und werden deshalb abgelehnt (bestätigt im Codex-Quellcode: `requires_mcp_tool_approval_for_mode`,
  `Approve => false`). Korrektur: nur die drei Gateway-Werkzeuge des App-Servers erhalten pro Aufruf
  `mcp_servers.app.tools.<tool>.approval_mode="approve"`; hinter `call_tool` liegen nur Werkzeuge, die
  in der App für Agenten erlaubt sind, und jeder Aufruf wird von der App erneut geprüft. Von Codex 0.153.4
  offline als gültig akzeptiert (ungültiger Wert wird abgelehnt), Unit-Test ergänzt.
- **Codex – erneuter Lauf mit Zustimmung bestanden:** Antwort `7341` über `search_tools` → `call_tool`,
  12,8 s, 57.697 Eingabe-/126 Ausgabe-Token (42.496 aus dem Cache), erste Ausgabe nach 5,0 s.
  Insgesamt verbraucht: 1 Claude-Aufruf, 2 Codex-Aufrufe (Abo, keine API-Kosten).
