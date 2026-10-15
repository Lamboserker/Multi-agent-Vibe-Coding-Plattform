# Multi-AI Coder – Phase 0.3: Implementierungsbericht

> Aktuelle Bewertung: [Gezielte Stabilisierung vom 13.10.2026](stabilization-2026-10-13.md).
> Die früheren Abschlussaussagen unten sind historische Angaben. Zwei gespeicherte Coding-Läufe
> endeten tatsächlich mit fehlgeschlagener Validierung; Navigationserfolg ist davon getrennt.
> Nachträgliche Codekorrekturen wurden gezielt lokal geprüft, noch nicht in den Installer übernommen.

> Korrektur vom 13.10.2026: Dieser Bericht dokumentiert den bisherigen Stand vom
> 12.10.2026, keine vollständige Erfüllung des ursprünglichen Auftrags. Insbesondere
> die sechs Plugin-Erweiterungspunkte, MCP für Premium-Orchestratoren/OAuth und die
> weiteren Audit-Lücken sind Pflichtanforderungen. Die vollständige Zuordnung und
> aktuellen Abnahmekriterien stehen in [completion-acceptance.md](completion-acceptance.md).
> Frühere grüne Tests gelten nur für den damaligen Stand.
>
> **Nachtrag 13.10.2026:** Die Audit-Lücken wurden umgesetzt und am finalen Stand geprüft – siehe
> Abschnitt 10 und die Nachweise N1–N6, E1–E4, F1–F2, D1–D2, S1, A1, T1, V1–V2, L1, G1–G3, R1, P1 in
> [completion-acceptance.md](completion-acceptance.md). Abschnitte 1–9 beschreiben den Stand vom 12.10.2026.

Stand: 12.10.2026 · Branch `codex/platform-completion` (Änderungen nicht committet) · Referenzsystem: Ryzen 7 5800X,
32 GB RAM, RTX 4060 Ti 16 GB, Windows 11 Pro, Electron 44.5.1 (Node 24.21), lokale Modelle über Ollama
(`qwen2.5-coder:7b`).

Detaildokumente: [state-architecture.md](state-architecture.md) (A), [performance.md](performance.md) (B/C und
Prüfung nach D–F), [plugins.md](plugins.md) (D), [skills-mcp.md](skills-mcp.md) (E),
[ide-features.md](ide-features.md) (F).

## 1. Zusammenfassung

| Phase | Ergebnis | Nachweis |
|---|---|---|
| A Stabilität | 15 Ursachen für verlorene Sessions/Einstellungen/Arbeitsstände gefunden und behoben; persistente Sessions, Recovery, Autosave | GUI-Tests Persistenz (32 Navigationen, Reload, Renderer-Absturz, Neustart) und Live-Abnahmetest (echter Lauf + 40 Navigationen + Reload + Neustart) |
| B Messung | reproduzierbares Messverfahren, Baseline mit p50/p95, Top-5-Engpässe | `perf-before-…json`, `engine-baseline-…json` |
| C Optimierung | Navigation p95 712 → ~9–11 ms, Start → IDE 1 111 → 319–388 ms, Modelle nach Neustart 2 959 → ~15 ms, Index −95 %, Worktrees −86 %, Fast Path, Diagnose-Dashboard | Messtabellen in performance.md |
| D Plugins | Plugin-SDK v1, isolierte Plugin-Prozesse mit Berechtigungen, Manager-UI, 6 funktionierende Referenz-Plugins | API- und GUI-Tests, echte Ziele (Chrome, SQLite, HTTP, GitHub-API) |
| E Skills & MCP | Skill-System mit progressivem Kontext und genehmigungspflichtigen Skripten; MCP-Manager mit offiziellem SDK; Anbindung an lokale Agenten | Tests gegen echte MCP-Server; Live-Lauf: lokales Modell ruft MCP-Werkzeug auf und folgt einem Skill |
| F IDE & Agenten | Palette, Quick Open, Suche/Ersetzen, Definition/Referenzen/Umbenennen/Live-Diagnosen, Probleme, Format-on-Save, lokale Historie, Git-Gutter, Split-Editor, KI-Bearbeitung, Terminal-Erweiterungen, Agent-Manager | GUI-Tests, Live-Test KI-Bearbeitung |
| G Validierung | damalige Tests und Packaging durchgeführt; Skips und fehlgeschlagener Live-Test siehe Abschnitt 8; vollständige Abnahme noch offen | Abschnitt 8 und completion-acceptance.md |

## 2. Ursachen des Session-Verlusts und Korrekturen

Die Analyse fand 15 Ursachen (vollständige Tabelle mit alter Codestelle, Reproduktion und Korrektur:
[state-architecture.md §1](state-architecture.md)). Die wichtigsten:

1. Erneutes Auswählen des offenen Projekts setzte Tabs, Session und Ausführung zurück.
2. Ein Neustart der lokalen Laufzeit **unmountete die gesamte IDE** (Terminals beendet, Entwürfe weg).
3. Arbeitsstand (Tabs, aktive Session, Ansicht, Cursor) existierte nur im React-State.
4. Ungespeicherte Editor-Inhalte lebten im React-State; geänderte Tabs ließen sich ohne Rückfrage schließen.
5. **Race Condition** im Settings-Service (Read-Modify-Write ohne Sperre) überschrieb Onboarding-Status,
   Modellrollen und Selbsttests – Ursache für „Einstellungen verschwinden“.
6. Fragen-Antworten nur im Komponenten-State; unterbrochene Planungen blieben dauerhaft „läuft“;
   Doppelstart-Races; Terminals gehörten React-Komponenten.

Korrekturprinzip: **Laufende Arbeit gehört nie einer Komponente.** Runs, Planungen und Fragen sind Jobs der
Laufzeit (SQLite), Terminals Prozesse des Main-Prozesses, Arbeitsstand und Editor-Entwürfe liegen im
Main-Process-State-Store (atomar, versioniert, synchroner Flush bei Reload/Beenden). Einstellungen: Mutex,
Transaktion, Merge-Semantik, Versionszähler. Sessions: eigenes Modell `ChatSession` mit abgeleitetem Status
(active/idle/running/paused/interrupted/completed/failed/archived), externer CLI-Sitzungs-ID, Idempotenz-Schlüsseln,
Recovery in fester Reihenfolge (Ausführungen → Job-Queue → Sessions) ohne doppelt angewendete Änderungen
(Integrations-Commits je Teilaufgabe werden beim Fortsetzen erkannt).

## 3. Neue State-Architektur

| Klasse | Ort | Strategie |
|---|---|---|
| Globale Einstellungen | Laufzeit, SQLite | Mutex + Transaktion, Version, `settings_changed`-Event |
| Projekteinstellungen | `Project.settings` | wie oben |
| Persistenter Arbeitsstand | Main-Prozess `state-store.ts` | Write-Behind 300 ms, atomar (Temp + Rename + `.bak`), Epoch-Schutz, synchroner Flush |
| Ungespeicherte Editor-Inhalte | Monaco-Modelle + Drafts im Main-Prozess | entprellt 400 ms, Konflikterkennung per mtime |
| Kurzlebiger UI-State | Komponenten | nicht persistiert |
| Laufende Prozesse | Laufzeit (Jobs, Runs, Sessions) bzw. Main-Prozess (PTYs) | transaktional, Recovery beim Start |
| Geheimnisse (neu) | Main-Prozess `secret-vault.ts`, `safeStorage` | Renderer schreibt/löscht nur; Laufzeit liest nur für berechtigte Plugins/MCP-Server |

Renderer: externe Stores mit Selektoren (`useSyncExternalStore`), Seitenpanels bleiben gemountet, ein
Monaco-Editor mit Modellwechsel, gebündelte IPC-Events.

## 4. Performance

Verfahren, Baseline, Top-5-Engpässe und alle Messwerte: [performance.md](performance.md). Kernergebnisse
(Baseline → Endstand, gleiche Messprozedur):

| Vorgang | Baseline | Endstand | Veränderung |
|---|---:|---:|---:|
| Navigation zwischen Ansichten (p95) | 712 ms | 10–11 ms | −98,5 % |
| Start → IDE sichtbar | 1 111 ms | 319–388 ms | −65 bis −71 % |
| Modelle-Ansicht nach Neustart (p50) | 2 959 ms | 14–45 ms | −98 % |
| `GET /orchestrator` (p50) | 152 ms | ~1 ms | −99 % |
| Laufzeit-Start | 573 ms | 438–517 ms | −10 bis −24 % |
| Repository-Index ohne Änderung | 647 ms | ~30 ms | −95 % |
| Worktree anlegen | 2 768 ms | 358–388 ms | −86 % |
| Erster Aufruf des lokalen 7B-Modells | 21,7 s | 0,30 s nach Vorwärmen | Ladezeit parallel zur Planung |

Nach den Phasen D–F zeigte die Wiederholungsmessung echte Rückschritte (Laufzeitstart +28 %, erste Datei
+116 %); behoben durch V8-Compile-Cache, TypeScript-Sprachdienst im Worker-Thread, spätes Laden des MCP-SDK,
verzögerte Plugin-Registrierung und einen reparierten Start-Logfilter. Ein Lazy-Loading-Versuch für Panels wurde
nach Messung verworfen. Die Endwerte liegen im Bereich der Messstreuung (±15 %) um die Phase-C-Werte, der
Laufzeitstart darunter.

## 5. Plugin-System

Siehe [plugins.md](plugins.md). Versioniertes SDK (`@multi-ai-coder/plugin-sdk`, `MultiAICoderPlugin` mit
`manifest`/`activate`/`deactivate`), alle geforderten Erweiterungspunkte deklarierbar; funktional angebunden sind
Commands, deklarative UI-Views, Settings (inkl. verschlüsselter Secrets), Agent-Tools (an lokale Agenten), Event-Hooks
und Context Provider (Premium-Planung). Isolation: eigener Prozess je Plugin mit Node-Berechtigungsmodell, kontrollierte
RPC mit Berechtigungsprüfung, Netzwerk-/Prozessmodule für Fremd-Plugins gesperrt (auch für ES-Module über
`module.registerHooks`), Timeouts, Absturzisolierung mit Backoff-Neustart, Speicher-/CPU-Überwachung, SHA-256-
Integritätsprüfung vor jeder Aktivierung, Vertrauensstufen (mitgeliefert/Fremd), `native`-Berechtigung nur für
mitgelieferte Plugins. Manager mit Installation aus Ordner/Git, Update, Downgrade-Bestätigung, Aktivieren mit
Berechtigungsdialog, Deinstallieren, Protokoll; Marktplatz-Schnittstelle vorbereitet.

Referenz-Plugins (alle mit echten Kernfunktionen): **GitHub** (PRs/Issues, Issue anlegen, Context Provider für
`#123`), **GitLab** (Pipelines inkl. fehlgeschlagener Job-Logs, MRs, Issues), **Docker** (Container steuern, Logs,
Compose), **Database Tools** (SQLite und PostgreSQL, lesende Abfragen DB-seitig read-only, schreibende nur nach
Bestätigung), **API Tools** (REST-Client mit Sammlungen und Umgebungsvariablen), **Browser Testing** (lokaler
Chrome/Edge über `--remote-debugging-pipe`: Screenshots, Konsole, fehlgeschlagene Requests, Automatisierung).

## 6. Skills und MCP

Siehe [skills-mcp.md](skills-mcp.md). **Skills**: `SKILL.md`-Format (kompatibel zum verbreiteten Agent-Skill-Layout),
automatische Erkennung (App, Benutzer, Projekt inkl. `.claude/skills`), Manager und Builder, Rollen-Zuweisung,
progressiver Kontext (passende Skills vollständig, übrige als Index mit `load_skill`), Skripte nur nach
Genehmigung (an SHA-256 gebunden). **MCP**: offizielles SDK 1.30.1, stdio und Streamable HTTP (SSE-Fallback),
Authentifizierung über verschlüsselte Secrets, lazy Verbindung, Werkzeug-Cache, Health-Check und Reconnect mit
Backoff, Timeouts, Richtlinie je Werkzeug (erlaubt/Bestätigung/aus, destruktive Werkzeuge standardmäßig
Bestätigung), Rollen-Zuweisung, Protokoll, Import im `mcpServers`-Format (Zugangsdaten in den Tresor, importierte
Server deaktiviert), kompakte Schemas, Ergebniskürzung, max. 24 relevante Werkzeuge je Agent.

Der Live-Test belegt die Wirkung: `qwen2.5-coder:7b` ruft im echten Lauf das zugewiesene MCP-Werkzeug auf
(Wert 7341, den das Modell nicht kennen kann) und wendet die Namensregel eines Benutzer-Skills an; dieser Test deckte
einen Fehler in der Text-Tool-Call-Erkennung auf, der behoben ist.

## 7. IDE-Funktionen und Agent-Manager

Siehe [ide-features.md](ide-features.md). Befehlspalette, Quick Open, Tastenkürzel (inkl. AltGr-Tastaturen),
Workspace-Suche/Ersetzen (geöffnete Dateien im Editor, geschlossene auf Platte mit Historie), projektweite
TypeScript-Sprachfunktionen im Worker-Thread (Definition, Referenzen, Umbenennen über offene und geschlossene
Dateien, Hover, Live-Diagnosen mit ungespeichertem Inhalt), Probleme-Panel mit Projektprüfung (tsc + ESLint),
Format-on-Save mit Prettier des Projekts, lokale Historie, Git-Änderungsmarken und Diff gegen HEAD, Split-Editor,
KI-Bearbeitung einer Auswahl mit lokalem Modell (Diff-Vorschau, ein Rückgängig-Schritt), Erklären im Chat,
Terminal-Suche/-Umbenennen/-Teilung. Sitzungsverwaltung (Suche, Export, Umbenennen, Anheften, Archiv) aus Phase A.

**Agent-Manager**: Profile mit Zuständigkeit, Projektbezug, Modell, Skills, MCP-Servern, Plugin-Werkzeugen,
Eskalationsgrenze, Schritt-/Reparaturlimits und Rollenanweisung; Vorlagen; automatische Zuordnung beim Planen,
änderbar je Teilaufgabe; strukturierte kompakte Übergaben zwischen abhängigen Teilaufgaben.

## 8. Tests

| Ebene | Umfang | Ergebnis (12.10.2026) |
|---|---|---|
| Typecheck aller Pakete | `pnpm run typecheck` | fehlerfrei |
| Engine | 129 Tests (u. a. Ausführung mit echtem Git, Resume, Fast Path, Agenten-Übergaben, Eskalationsgrenze, zusätzliche Agentenwerkzeuge) | grün |
| Laufzeit (API) | 57 Tests (Sessions, Settings, Migrator, Repo-Kontext, Plugins mit echten Host-Prozessen, Referenz-Plugins, Skills, MCP gegen echte Server, IDE-Dienst inkl. Worker, Agentenprofile) | 55 grün, 2 übersprungen (PostgreSQL ohne Server, GitHub nur mit `MAC_TEST_NETWORK=1` – einmal manuell grün) |
| Desktop (Unit) | 28 Tests (State-Store, Terminal, Validierung, Text-Hilfen) | grün |
| Shared, Plugin-SDK | 6 + 4 Tests | grün |
| GUI (echte App) | `session-persistence`, `fast-path`, `plugins`, `skills-mcp`, `ide-features`, `agents`, `terminal` | alle grün (zuletzt nach allen Leistungskorrekturen erneut) |
| Gepackte App | `packaged-smoke` (NSIS-Build: Laufzeit, Plugins, Skills, Plugin-Host, TS-Worker, MCP, Laufzeit-Absturz → Neustart mit erhaltenem Zustand) | grün |
| Live mit lokalem Modell | `navigation-run` (Abnahmetest: echter Lauf, 40 Navigationen während des Laufs, Reload, Neustart, 0 Premium-Aufrufe), `agent-tools.live`, `ai-edit.live` | grün |
| Live mit Orchestrator | `live-react-component` (Planung über das verbundene Codex-Abonnement) | 2× ausgeführt: 1× fehlgeschlagen (Ursache nicht protokolliert), 1× grün |

Hinweis zu Kosten: Alle neuen Tests vermeiden Premium-Aufrufe (kein Orchestrator, deterministische Planung,
lokales Modell). Der bereits vorhandene Test `live-react-component` nutzt dagegen den verbundenen Codex-Orchestrator;
er lief während der Regression zweimal und verbrauchte dabei zwei Planungsaufrufe aus dem Abo-Kontingent
(Abrechnungsart „subscription“, keine API-Kosten).

Während der Validierung gefundene und behobene Fehler (Auswahl): Text-Tool-Calls von MCP-Werkzeugen wurden verworfen;
`transport.onclose` überschrieb den Close-Handler des MCP-SDK (Absturz wurde nicht erkannt); `module.register`
scheitert unter dem Berechtigungsmodell (ersetzt durch `registerHooks`); Terminal stahl Eingabefeldern den Fokus;
Plugin-Registrierung nach Startoptimierung zu spät für die erste Anzeige und `enable` (404); Start-Logfilter griff
im Bundle nicht; Rollen-/Richtlinien-Schalter ohne sofortige Rückmeldung.

## 9. Offene Punkte (Stand 12.10.2026, überholt – aktuelle Liste in Abschnitt 10)


* PostgreSQL-Client des Database-Plugins nicht gegen einen echten Server getestet (keiner verfügbar).
* Erweiterungspunkte Model Providers, Orchestrator Adapters, Repository Analyzers, Test Runner,
  Language/Git Integrations: Registrierung und Anzeige vorhanden, Routing/Planung/Validierung nutzen sie noch nicht.
* Netzwerkisolation von Fremd-Plugins auf Modulebene (Node hat kein Netzwerk-Berechtigungsflag); Herausgeber-
  Signaturen fehlen (nur Integritäts-Hashes).
* Premium-Orchestratoren (Claude Code/Codex) erhalten Skills als Kontext, aber keine MCP-Server der App;
  OAuth-Anmeldung für entfernte MCP-Server fehlt.
* Sprachfunktionen nur für TypeScript/JavaScript; Vervollständigung weiterhin aus Monacos Einzeldatei-Worker.
* Agentenprofile gelten für Coder-Agenten (Planer/Chat über Rollen-Zuweisung).
* Erstbesuch der Modelle-Ansicht in einem neuen Profil ~2,6 s (Hardware-Erkennung ohne Cache).
* Messstreuung auf dem Referenzrechner bis ±15 %; Endwerte deshalb als Spannbreiten angegeben.
* Der Installer wird von electron-builder signiert, sofern ein Zertifikat konfiguriert ist; ohne Zertifikat
  ist er unsigniert (Windows SmartScreen-Hinweis).
* Alle Änderungen liegen uncommittet auf `codex/platform-completion`; die von einem anderen Agenten vorgenommene
  Korrektur in `sessions.service.ts` (Löschen von `pendingAsk` unter der Sitzungssperre) ist erhalten.

## 10. Nachtrag 13.10.2026: Abschluss der Audit-Lücken

Umsetzung (Details und Nachweise in completion-acceptance.md):

* **MCP für Claude Code und Codex:** pro Aufruf ein lokales Session-Gateway (offizielles SDK) mit nur drei
  Werkzeugen (`search_tools`, `call_tool`, `read_result`); Claude über `--mcp-config` +
  `--strict-mcp-config`, Codex über `-c`-Overrides mit deaktivierten Nutzer-Servern/Plugins; keine globale
  Konfiguration geändert; Zuweisung je Rolle/Agent, bei jedem Aufruf neu geprüft. MCP-OAuth (Discovery,
  dynamische Registrierung, PKCE, State, Loopback-Callback, verschlüsselte Tokens, Refresh, Logout),
  vollständiger Abruf gekürzter Ergebnisse für Orchestrator, lokale Agenten und UI, Fehlerdiagnose.
* **Sechs Erweiterungspunkte** an ihren Aufrufstellen verdrahtet und durch ein mitgeliefertes
  Referenz-Plugin mit echter Funktion belegt; delegierte Verzeichnisse, Zeitlimits je Art, Validierung.
* **GitHub/GitLab** (API-URL-Einstellung jetzt wirksam), **Docker-Devcontainer** (JSONC, Lifecycle, Build),
  **PostgreSQL** über das Plugin gegen einen isolierten Server, **Skills** (Felder wirksam, Testaufgabe,
  Export-Fehler behoben), **Agentenlimits** (auch Premium), **Terminal-Befehlshistorie**, **LSP**
  (Diagnosen, Definition, TSX), **Editor-KI-Übergaben** (vorher in der UI wirkungslos), **virtualisierte
  Listen**, vollständige Run-Logs, nachladbarer Chat, **TTFT** lokal und Premium.

Ergebnis der Verifikation: Build/Typecheck/Lint grün; alle Unit-/Integrationstests grün (Skips benannt);
GUI-Suite am finalen Stand siehe completion-acceptance.md (G1–G3); Installer 0.3.0 gebaut, installiert,
mit isoliertem Profil geprüft und deinstalliert (P1).

**Verbleibende Lücken und Blockaden**

* Live-Prüfung mit echtem Modell (nach Zustimmung): Claude Code und Codex rufen ein zugewiesenes MCP-Werkzeug
  über das Session-Gateway auf (Antwort 7341). Der erste Codex-Lauf deckte auf, dass `codex exec` (Freigaberegel
  „never“) die Gateway-Werkzeuge ablehnte; behoben durch gezielte Vorab-Freigabe nur dieser drei Werkzeuge.
* MCP-OAuth gegen einen echten Anbieter nicht geprüft (lokaler Autorisierungsserver nach Spezifikation).
* GitHub/GitLab nur gegen lokale Test-APIs (keine Veröffentlichung in echten Repositories, wie gefordert).
* Docker-Tests beim Schlusslauf übersprungen, weil Docker Desktop außerhalb dieser Arbeit beendet wurde
  (zuvor zweimal grün).
* Live-Neustarttest: Recovery korrekt, Endergebnis hängt von der Qualität des lokalen 7B-Modells ab.
* Terminal-Befehlshistorie nur mit PowerShell (Windows); bash/zsh ohne Shell-Integration.
* Devcontainer-`features` (Dev-Container-CLI) werden abgelehnt, nicht unterstützt.
* Codex-TTFT misst das erste Ausgabeereignis (Codex liefert keine Token-Deltas).
* Netzwerkisolation von Fremd-Plugins auf Modulebene; Installer unsigniert (keine Pflicht laut Audit).
* Alle Änderungen uncommittet auf `codex/platform-completion`.
