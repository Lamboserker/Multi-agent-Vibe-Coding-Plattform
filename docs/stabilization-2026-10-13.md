# Gezielte Stabilisierung nach der lesenden Prüfung

Stand: 13.10.2026. Branch `codex/platform-completion`, HEAD
`a88dd760bda5abcf856ccbd1bf3d8b9e4060002e`. Der vorhandene Stand mit 171 Änderungen wurde
erhalten und ergänzt. Keine Repository-Commits, Resets, Installationen, langen GUI-/Lastsuiten
oder neuen echten Modell-/Abo-/API-Aufrufe. Prüfungen liefen einzeln mit festem äußeren Timeout
und Prozessbesitz über Windows-Jobs. Lokale HTTP-Modellattrappen erzeugen keine Modellkosten.

**Keine vollständige Fertigstellung:** Es fehlen weiterhin Pflichtfunktionen bzw. ihre Nachweise;
der vorhandene Installer enthält die neuen Korrekturen nicht.

## 1. Ursachen der beiden Coding-Fehlschläge

Die Profile konnten anhand der in den Berichten gespeicherten Execution-IDs gefunden werden.
SQLite wurde mit `DatabaseSync(..., { readOnly: true })` geöffnet. Aufgaben, Patches,
Agentenprotokolle und vollständige gespeicherte Validierungsresultate wurden nach
[`stabilization-retained-runs.json`](../apps/desktop/e2e/results/stabilization-retained-runs.json)
exportiert. Die historischen Daten und Patches wurden nicht korrigiert oder erneut mit einem
Modell ausgeführt.

| Bericht / Versuch | Typprüfung | Testausgabe / Modelländerung | Einordnung |
|---|---|---|---|
| `11-46-00-112Z`, 0 | TS2741: `<Greeting />` ohne erforderliches `name` | 3 bestanden / 1 fehlgeschlagen; selbst erfundener Test erwartet `.toThrow(/name/)` | Modellfehler |
| derselbe Lauf, 1 | derselbe TS2741 | derselbe falsche Test; fehlgeschlagenes `edit_file` wegen nicht passendem Suchtext, anschließende Änderung behebt den Test nicht | Modellfehler |
| derselbe Lauf, 2 | derselbe TS2741 | 2 bestanden / 1 fehlgeschlagen; ein gültiger Test entfällt, falscher Fehler-Test bleibt | Modellfehler |
| `12-11-51-401Z`, 0 | TS2304: `Greeting` in `App.tsx` ohne Import; zusätzlich TS2741 im Test | 3 bestanden / 1 fehlgeschlagen; Modell änderte zusätzlich `App.tsx` | Modellfehler |
| derselbe Lauf, 1 | dieselben TS2304/TS2741 | 2 bestanden / 1 fehlgeschlagen; weiterhin fehlender Import und falscher Fehler-Test | Modellfehler |
| derselbe Lauf, 2 | TS2304 bleibt | 1 bestanden / 0 fehlgeschlagene Testfälle, **aber eine fehlgeschlagene Suite**: `No test suite found`; beide neuen Dateien bestehen nur noch aus TODO-Kommentaren | Modellfehler; Testlauf korrekt fehlgeschlagen |

Die Aufgabe verlangte eine Komponente mit `name: string`, den beschriebenen HTML-Inhalt und
einen Vitest-Test nach dem vorhandenen Muster. Sie verlangte keinen Laufzeitfehler für fehlende
Props. TypeScript, Vitest und React waren verfügbar; bestehende Tests liefen. Die Ausgaben
belegen Codefehler, keine fehlenden Abhängigkeiten oder nicht gestarteten Prüfprogramme.
Ein Fehler der Aufgabenstellung oder eine falsche Plattformvalidierung ist hier nicht belegt.
Die Reparaturausgaben belegen außerdem, dass Änderungen der vorherigen Versuche erhalten waren.

**Nachgewiesene Plattform-/Nachweislücke:** `navigation-run.test.mjs` meldete `ok: true` für
Navigation/Persistenz auch bei fehlgeschlagenem Coding-Ergebnis; der Abschlussbericht nannte
dies undifferenziert einen grünen Live-Lauf. Der Test speichert künftig zusätzlich
`acceptance.navigation`, `acceptance.persistence`, `acceptance.coding` sowie Aufgaben,
Versuche und Validierung. Die Coding-Anforderungen wurden nicht gelockert. Der bestehende
Resume-Test verlangt weiterhin `awaiting_approval`.

## 2. Behobene Implementierungslücken

* Lokale Agenten prüfen gemeldete Kontext-/Ausgabetokens **vor** Tool-/Dateioperationen und
  verwerfen übergroße Antworten als `resource_limit`. Auch strukturierte Reparaturrunden ziehen
  verbrauchte Ausgabetokens ab. Eine gemeinsame Deadline umfasst Modell-/Toolarbeit;
  Zeitüberschreitung wird von Benutzerabbruch unterschieden.
* Plugin-Modelladapter übergeben Kontext, verbleibende Ausgabetokens, Timeout und AbortSignal.
  Fehlende/ungültige Verbrauchsangaben bei angeforderten Limits führen zur Ablehnung. Der
  Referenzanbieter prüft vor HTTP die konservative Eingabegröße in UTF-8-Bytes (einschließlich
  Schema und Reserve) und danach gemeldete Tokens. Das ist bewusst strenger als eine
  modellabhängige Tokenschätzung; die API bietet keinen portablen Kontextfenster-Override.
* Harte Kontext-/Ausgabetokenlimits bei Premium-CLIs bzw. generischen Plugin-Orchestratoren
  werden vor Modellaufruf ausdrücklich abgelehnt. Die Engine ignoriert sie nicht mehr.
  **Funktionale Unterstützung solcher begrenzten Premium-Aufrufe bleibt offen.**
* Plugin-Orchestratoren setzen Timeout/AbortSignal und `cancelRun` durch. Die Deadline beginnt
  bereits vor Host-Aktivierung. Stop/Crash des Hosts bricht delegierte HTTP-/Prozessarbeit ab.
  Neustart-Timer werden beim Runtime-Shutdown entfernt; während Shutdown startet kein neuer Host.
* `runProcess` behandelt vorab abgebrochene Aufrufe ohne Spawn, liest beide Ausgabeströme,
  begrenzt Bytes und meldet überschrittene strukturierte Ausgabe statt stiller Kürzung.
  Die Spawn-Fehlerbehandlung hat keine Referenz auf noch nicht initialisierte Timer mehr.
* CLI-, Validierungs- und delegierte Plugin-Prozesse verwenden unter Windows einen
  Kill-on-close-Job. Der eigentliche Prozess wird suspendiert erzeugt, vor Resume zugeordnet;
  damit bleiben auch abgekoppelte Kinder im Besitz des Jobs. LSP-Server verwenden dieselbe
  Besitzstrategie. Der Job-Launcher beobachtet zusätzlich einen geöffneten Handle des besitzenden
  Runtime-Prozesses; dessen Ende schließt den Job auch bei einem Runtime-Crash. POSIX verwendet
  eigene Prozessgruppen; diese Variante wurde hier nicht geprüft.
* Ollama-Start wird je Endpoint zusammengeführt und verwendet einen verfügbaren Server weiter.
  Eigene Starts werden über Prozessobjekte geführt, bei Startfehler/Timeout und Runtime-Shutdown
  bereinigt. Fremde Instanzen werden nicht beendet. In dieser Arbeit wurde **keine echte Ollama-
  Instanz gestartet**; die Wiederverwendung wurde mit einem lokalen Versions-Endpunkt geprüft.
* MCP-Ergebnisreferenzen prüfen bei jedem Lesen erneut die ursprüngliche Tool-Berechtigung und
  Server-/Rollenzuweisung. Entzogene Referenzen werden dauerhaft entfernt. Der Speicher ist nach
  der Summe der UTF-8-Bytes begrenzt; übergroße Ergebnisse werden ausdrücklich abgewiesen.
  Akzeptierte paginierte/manuell gespeicherte Ergebnisse werden nicht vorher unbemerkt gekürzt.
* Der Referenz-Test-Runner nimmt unbekannte/leer gebliebene Testergebnisse nicht als Erfolg an.
  Der echte Testlauf deckte fehlende Unterstützung des `node:test`-Spec-Reporters auf; TAP und Spec
  werden jetzt gezählt. Die Attrappe mit gedruckten Erfolgszahlen ist durch drei echte Tests
  (Addition, Begrüßung, gerade/ungerade) ersetzt. Markerdatei und gezielter fehlgeschlagener Test
  belegen tatsächliche Ausführung im delegierten Worktree. Ein hängender Testprozess wird abgebrochen.
* Ein vollständig geliefertes Plugin-Modellergebnis wird nicht als erster Streaming-Token an
  `onToken` gemeldet. Codex-Diagnosen bleiben ausdrücklich „erste Ausgabe“ / `kind: event`;
  Claude-/Ollama-Streaming und Codex-Ereignisse werden nicht vermischt.

Separate Prozess-/CPU-/RAM-Quoten je Agent sind weiterhin nicht implementiert. Die vorhandenen
Agentenressourcen umfassen Kontext, Ausgabe, Zeit, Datei-Anzahl und Dateigröße; Plugin-Hosts
besitzen davon getrennte globale Speichergrenzen. Erzwungene Crash-Bereinigung aller nativen
Plugins wurde nicht vollständig neu geprüft.

## 3. Wiedergefundener zweiter Codex-Live-Test

Der vorherige lesende Audit suchte im Repository und konnte den Lauf dort nicht nachweisen.
Die gezielte Suche im lokalen Codex-Sitzungsarchiv fand jetzt das Originalprotokoll:

`C:\Users\lukas\.codex\sessions\2026\10\13\rollout-2026-10-13T14-59-11-01a13558-727b-72c0-929a-576f9beb6f47.jsonl`

Ein belegbarer Auszug mit Quelldatei-SHA-256, CLI-Version, isoliertem Live-Test-Arbeitsordner,
Aufruf-IDs, Aufrufcode und Werkzeugantworten steht in
[`stabilization-codex-existing-evidence.json`](../apps/desktop/e2e/results/stabilization-codex-existing-evidence.json).

* 13.10.2026 **14:59:18,603 Uhr Europe/Berlin**: `tools.mcp__app__search_tools({query:"magic number"})`.
* Die Werkzeugantwort enthält das Schema für `mcp_config_magic_number`.
* **14:59:21,383 Uhr**: `tools.mcp__app__call_tool({name:"mcp_config_magic_number",arguments:{}})`.
* **14:59:21,441 Uhr**: zugehörige Werkzeugantwort `{"content":[{"type":"text","text":"7341"}]}`.
* Die aufgezeichnete Gesamtnutzung beträgt 57.697 Eingabe-/126 Ausgabe-Token, 42.496 Cache-Token;
  CLI 0.153.4 und Arbeitsordner `mac-live-mcp-cwd-WpBGlM` passen zum vorbereiteten Live-Test.

Auch die vorherige Freigabeablehnung um 14:51 Uhr ist im Archiv vorhanden. Der erfolgreiche
Wiederholungslauf ist damit **ausgeführt und mit tatsächlichem Werkzeugergebnis nachgewiesen**,
nicht nur durch eine Modellantwort. Die pro Aufruf gesetzte Gateway-Freigabe ist im Adapter und
im damaligen Paket vorhanden; der dokumentierte Lauf gehört zur damaligen korrigierten
Implementierung. Er belegt keine erneute Live-Ausführung nach der jetzigen Stabilisierung.
Es gab in dieser Arbeit keinen neuen Modellaufruf. Der externe Ordner `audit/` wurde nicht
lokalisiert und nicht als verfügbar vorausgesetzt.

## 4. Build-Zuordnung durch Inhalte

Der **vor den neuen Codeänderungen** gespeicherte Inhaltsvergleich steht in
[`stabilization-package-comparison.json`](../apps/desktop/e2e/results/stabilization-package-comparison.json).
Verglichen wurden 270 Paketdateien mit Build-/Plugin-/Skill-/Migrationsquellen und 116 lokale
Source-Map-Inhalte. Die 116 geprüften Inhalte stimmen überein. Bei den Paketdateien sind
102 TypeScript-Deklarationen nicht vorhanden; die übrigen verglichenen Dateien stimmen byteweise.

Diese fehlenden `.d.ts`-Dateien, darunter `lib.d.ts`, `lib.es5.d.ts` und `lib.dom.d.ts`, sind
Runtime-Eingaben des Language Servers. `electron-builder.yml` kopiert den TypeScript-Runtime-
Ordner künftig explizit als `extraResources`; `packaged-smoke` verlangt die Bibliotheksdateien.
Diese Packaging-Korrektur wurde syntaktisch geprüft, **noch nicht neu paketiert/installiert**.

Die frühere Differenz `f0ea0525…` (Paket) gegen `74b2a009…` (Audit-Arbeitsstand) lässt sich
damit für die geprüften Code-/Artefaktinhalte eingrenzen; sie ist kein Beleg für deren Änderung.
Ein vollständiger Beweis „nur zwei Abschlussdokumente geändert“ ist mit den alten Metadaten
dennoch nicht möglich: Sie enthalten keinen Datei-Inhaltsmanifest, und die ursprünglichen
Renderer-Quellen sind nicht vollständig durch Source Maps abgedeckt. Zeitstempel ersetzen
diesen Beweis nicht. `stage.mjs` schreibt künftig zusätzlich einen Inhaltsmanifest `sourceFiles`
und `sourceSha256`, getrennt von der gesamten Working-Tree-Zuordnung.

Der vorhandene Installer 0.3.0 bleibt unverändert, SHA-256
`223e4078407e88715d73f8ce529533ef3c680e33b46c6b2d2c0b20806b3d8374`.
Dokumentänderungen allein würden keinen neuen Installer verlangen. **Die jetzigen Code- und
Packaging-Änderungen erfordern jedoch einen neuen Build/Installer und dessen gezielte Abnahme.**

## 5. Vollständiger Abgleich der Audit-Matrix

„Fertig“ bezeichnet den jeweils belegten lokalen Teil. Die Spalten trennen Implementierung,
fehlende Ausführungsnachweise und externe Integration. Frühere GUI-/Lastprotokolle werden nicht
als neue Abnahme der jetzigen Backend-/Engine-Änderungen ausgegeben.

| Punkt | Status / Implementierung | Lokaler Nachweis oder noch fehlender Nachweis | Externe Integration |
|---|---|---|---|
| MCP Claude Code | teilweise; isolierte CLI-Konfiguration vorhanden | echte Live-Ausführung bisher nur historisch berichtet; Mock-/Konfigurationsnachweis ersetzt sie nicht | echter Claude-Lauf nicht unabhängig neu belegt |
| MCP Codex | fertig für den damaligen korrigierten Gateway-Lauf | Originalarchiv belegt Discovery, Aufruf und 7341; aktueller Gateway lokal getestet | keine neue Live-Ausführung nach Stabilisierung |
| Agentenbezogene MCP-Rechte | fertig lokal | `mcp.test.ts`, Gateway-Test; erneute Rechteprüfung | kein externer Anbieter notwendig |
| Vollständige MCP-Ergebnisse/Rechteentzug | fertig innerhalb des expliziten Byte-Limits | 50.000 Zeichen rekonstruiert; Revocation, Isolation und Budget getestet | große externe Ergebnisse nicht live geprüft |
| Plugin Modell-Anbieter | fertig lokal; Grenzen/Abbruch angebunden | Aufrufstelle/Host tatsächlich ausgeführt; lokale Modell-HTTP-Attrappe | echtes kompatibles Modell nicht geprüft |
| Plugin Orchestrator-Adapter | teilweise; alle fünf Operationen und Cancellation ausgeführt | Worktree-Dateiänderung, Timeout und cancelRun geprüft; harte Tokenlimits bewusst abgelehnt | Modell-HTTP-Attrappe |
| Plugin Test-Runner | fertig lokal | echte positive/negative Tests, Marker und Abbruch eigener Testprozesse | keine externe API |
| Plugin Repository-Analyzer | fertig lokal | tatsächlicher Aufruf im Planungsdigest | keine externe API |
| Plugin Sprachintegration | fertig lokal | JSON-Diagnosen, TS-Rückfall durch echten LSP | keine externe API |
| Plugin Git-Integration | fertig lokal | echte Git-CLI, Status/Diff/Branches an Aufrufstellen | lokale Git-Repositories |
| MCP OAuth | teilweise | Code und lokaler Test vorhanden; in dieser Runde kein neuer OAuth-Lauf | echter Anbieter ungeprüft; historisch nur lokaler Server/simulierter Tresor |
| GitHub Repositories/Branches/Reviews | teilweise | Implementierung und lokale API-Tests vorhanden; kein neuer Forge-Lauf | echte Integration ungeprüft |
| GitLab Projektliste | teilweise | Implementierung und lokale API-Tests vorhanden; kein neuer Forge-Lauf | echte Integration ungeprüft |
| Docker Devcontainer | teilweise | Code/opt-in Test vorhanden; Daemon-Erfolg nur historisch berichtet, Schlusslauf übersprungen | in dieser Runde nicht geprüft |
| Devcontainer Features | fehlt | werden ausdrücklich abgelehnt | kein Nachweis |
| PostgreSQL über Database-Plugin | teilweise | opt-in Containertest vorhanden; erfolgreicher Lauf nur historisch berichtet | in dieser Runde nicht geprüft |
| Skills Export/Builder/Projektaktivierung | fertig implementiert | Roundtrip-Test vorhanden; nicht nach Backendänderungen neu ausgeführt | keine externe API notwendig |
| Editor-KI Refaktorieren/Tests/Fix/Review | teilweise | Entwurfsübergaben vorhanden; überprüfte Endergebnisse dieser vier konkreten Aktionen fehlen | keine neuen Modellaufrufe zulässig |
| Datei-/Ordner-/Diff-Kontext und Fehler-Task | teilweise | GUI-Test prüft Entwürfe; durchgehende Ergebnisabnahme fehlt | keine neuen Modellaufrufe |
| Terminal-Befehlshistorie | teilweise | PowerShell-Integration und Shell-Test vorhanden; nicht erneut ausgeführt | Bash/Zsh fehlen |
| Agenten-Kontext/Ausgabe/Zeit/Dateigrenzen | teilweise | lokale und Plugin-Grenzen, Verwerfen, Abbruch gezielt geprüft; Premium weist harte Tokenlimits vor Aufruf ab | Premium-Hardlimits, separate Prozess-/CPU-/RAM-Quoten fehlen |
| Echter LSP-Client/Server | fertig lokal, Paketabnahme offen | echter TS-Server über Plugin-Rückfall geprüft; owned Prozessstart | korrigiertes Paket noch nicht geprüft |
| Listenvirtualisierung | teilweise | Logs/Explorer virtualisiert; Chat paginiert/content-visibility, ohne vollständige DOM-Virtualisierung | vorhandene alte GUI-Messungen |
| TTFT/erste Ausgabe | teilweise | Fixture-CLI testet Ereigniskennzeichnung; Plugin-Komplettantwort ist kein Token | neuer echter TTFT-Lauf nicht ausgeführt |
| 10.000 Logs / 2.000 Chatnachrichten / 1.000 Dateien | teilweise in der aktuellen Abnahme | gespeicherte alte Lastmessungen vorhanden; keine neue lange Suite | nicht extern |
| Parallele Agenten | teilweise | Last-Test vorhanden; berichtete 22,1/7,5 s weiterhin ohne auffindbares Ergebnisartefakt | Modell-Attrappe, kein echter paralleler Modelllauf |
| Lange Sessions | teilweise | alte 40-Navigations-Berichte vorhanden, Coding dort fehlgeschlagen | keine mehrstündige Prüfung |
| Persistenz/Recovery | teilweise | alte Reload-/Crash-/Neustartberichte; aktuelle GUI-/Crash-Abnahme nicht wiederholt | erfolgreiche Coding-Recovery weiterhin nicht belegt |
| Installer/Regression | teilweise | gezielte aktuelle Prüfungen grün; vorhandener Installer ist der alte Stand | Neubau/Installation/Smoke fehlen; unsigniert |

## 6. Tatsächlich ausgeführte Prüfungen

Alle Befehle und vollständigen Ausgaben stehen in `apps/desktop/e2e/results/stabilization-check-*.json`
(Timeout, Start/Ende, Exitcode und Windows-Job-Bereinigung eingeschlossen).

| Prüfdatei / Ergebnisdatei | Ergebnis | Äußerer Timeout |
|---|---|---|
| `process.test.ts` / `processes-owner-final` | 8 bestanden; stdout/stderr, stdin/Quoting, vorab Abbruch, Abschluss/Timeout/Abbruch/Fehler mit abgekoppeltem Kind, Byte-Limit und Ende des Runtime-Besitzers | 90 s |
| `limits.test.ts`, CLI-Limits, Ollama-Reuse und MCP-Gateway/-Results / `source-regression` | 11 bestanden; nur lokale Fixtures/HTTP | 60 s |
| ausgewählte `execution.test.ts` / `engine-agent-limits` | 6 bestanden, 12 nicht ausgewählt; echte lokale Ausführung/Validierung mit Modell-Attrappe | 90 s |
| `checks.test.ts` / `validation` | 11 bestanden; echtes erfolgreiches/fehlgeschlagenes node:test und ignorierter AbortSignal-Timeout | 60 s |
| `mcp.test.ts` / `mcp-service` | 10 bestanden; echte lokale MCP-Server, Pagination/Rechteentzug/Fehler | 60 s |
| `reference-extensions.test.ts` / `plugin-lsp-complete` | 10 bestanden; alle sechs Aufrufstellen, echte Testausführung, Fehler/Restart/Abbruch und echter LSP | 120 s |
| ausgewählte Tests / `ownership-lsp-final` | 2 bestanden, 8 nicht ausgewählt; LSP-Standardprotokoll und abgebrochener Testprozess mit dem abschließenden Runtime-Besitzer-Watch | 60 s |
| `tsconfig.stabilization.json` / `final-source-typecheck` | Exit 0; abschließende API-/Engine-/SDK-Quellen einschließlich Tests, ohne Ausgabe von Build-Dateien | 90 s |
| `stabilization-syntax.mjs` / `syntax` | 6 JS-Dateien syntaktisch geprüft; kein Stage-/GUI-Test gestartet | 60 s |

Kein äußerer Timeout wurde erreicht. Fehlgeschlagene Vorläufe sind ebenfalls erhalten:
`processes` (Prüfkonfiguration konnte `vitest/config` am Repository-Root nicht auflösen),
`typecheck`/`typecheck-current` (Fehler in meinen neuen Änderungen/Testtypen, anschließend
korrigiert) sowie `reference-extensions`/`runner-diagnostic` (nachgewiesener Spec-Reporter-
Parserfehler). Die späteren Resultate wurden unter eigenen Namen gespeichert.

Die frühere blockierte Hash-Abfrage wurde anhand der vollständigen Prozesskette, Pfade,
Befehlszeilen und Erstellungszeiten erneut identifiziert. Nur ihr verifizierter PowerShell-
Prozess wurde beendet; die Git-Kinder endeten anschließend ebenfalls. Alte PIDs wurden nicht
blind verwendet. Die abschließende Prozess-/Portmomentaufnahme wird separat unter
`stabilization-process-snapshot.json` gespeichert.

## 7. Abschließende Prozessbelegung

Momentaufnahme **13.10.2026, 16:35:40 Uhr Europe/Berlin**:
[`stabilization-process-snapshot.json`](../apps/desktop/e2e/results/stabilization-process-snapshot.json).
Keine blockierte Audit-Abfrage, keine verbliebenen eigenen Job-/Prüfhelfer und keine Ollama-
Instanz gefunden. Alle Prüf-Harnesses sind beendet; Port 11435 ist ohne Listener.

Während der Arbeit wurde eine **andere, nicht von diesen Prüfungen gestartete** Dev-Instanz
geöffnet. Die Kette ist `VS Code -> Terminal-PowerShell 37616 -> pnpm run dev ->
pnpm --filter @multi-ai-coder/desktop dev -> scripts/dev.mjs`. Start des Dev-Skripts:
15:52:30 Uhr. Sein Build/Watcher schreibt generierte Ausgaben; deshalb ist die alte
Inhaltsvergleich-Datei ausdrücklich eine vorher gespeicherte Momentaufnahme und kein Vergleich
mit den später durch diesen Dev-Lauf erzeugten Dateien. Für parallele Agenten-Quelländerungen
liegt kein Nachweis vor. Ich habe keine weiteren Schreibagenten eingesetzt und diese fremde
Dev-Instanz nicht beendet oder neu gestartet.

| PID / Eltern-PID | Rolle | Working Set |
|---|---|---|
| 55568 / 46896 | Dev-Skript/Vite, Port 5199 | 181,9 MiB |
| 13900 / 55568 | Main-/Preload-Watcher | 48,7 MiB |
| 30564 / 13900 | esbuild aus diesem Repository | 60,7 MiB |
| 51212 / 55568 | Electron-App-Main aus diesem Repository | 185,8 MiB |
| 18192 / 51212 | GPU-Prozess | 94,4 MiB |
| 4368 / 51212 | Electron-Utility | 46,8 MiB |
| 55792 / 51212 | Electron-Renderer | 187,4 MiB |
| 2124 / 51212 | Electron-Utility/Backend, Port 59830 | 112,9 MiB |
| 38232, 20128 / 51212 | Terminal-Konsole / PowerShell | 8,6 / 52,8 MiB |
| 11932, 10892 / 51212 | weitere Terminal-Konsole / PowerShell | 8,8 / 58,4 MiB |

Die Prozesse wurden anhand von Executable-Pfaden und der Elternkette zugeordnet. Diese Dev-
Instanz ist kein von mir ausgeführter Smoke-Test und belegt keine Abnahme des finalen Quellstands.
Die erneute Kontrolle nach der letzten gezielten Prüfung steht in
[`stabilization-final-process-snapshot.json`](../apps/desktop/e2e/results/stabilization-final-process-snapshot.json).
Sie erfolgte um 16:39:37 Uhr und fand weiterhin keine eigene blockierte Hash-Abfrage, keinen
eigenen Job-Helfer und kein Ollama. In der fremden Dev-Kette waren inzwischen zusätzlich
PowerShell 4972 und Claude-CLI 2324 (450,3 MiB) unter Backend 2124 sowie Port 49755 vorhanden.
Diese Prozesse wurden nicht von den Prüfungen gestartet und nicht beendet; ihre Anwesenheit
ist kein Nachweis eines von mir genehmigten oder ausgeführten Live-Tests.
