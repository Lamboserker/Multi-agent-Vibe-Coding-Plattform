# Skills und MCP

Stand: Phase 0.3 (E).

Erweiterung 2026-10-22: Der **Integrationskatalog** in beiden Managern bietet 30 MCP-Vorlagen,
40 zusätzliche, zunächst deaktivierte Skills und acht Workflow-Pakete. Einrichtung, Freigaben,
Persistenz und Bildweitergabe sind in [Integrationskatalog](integrations.md) beschrieben.

## Agentenrollen

Skills, MCP-Server und Plugin-Werkzeuge werden **Rollen** zugewiesen (`*` = alle):

| Rolle | Wer | Was sie erhält |
|---|---|---|
| `planner` | Premium-Orchestrator beim Planen | passende Skills vollständig im Planungskontext (max. 12000 Zeichen) |
| `coder` | lokale Agenten bei der Ausführung einer Teilaufgabe | Skills progressiv, MCP- und Plugin-Werkzeuge |
| `chat` | Orchestrator bei „Frage“-Nachrichten | passende Skills vollständig im Kontext |
| `designer` | Premium-Designer der Design-Phase | bekommt passende Design-Skills inline (max. 9000 Zeichen) |

Die Engine kennt dafür einen generischen Haken `EngineDeps.agentResources(task)` → `{ tools, instructions }`;
der lokale Agent bietet diese Werkzeuge neben den Datei-Werkzeugen an (`LocalAgentInput.extraTools`,
`extraInstructions`). Datei-Werkzeuge können nicht überschattet werden. Werkzeugaufrufe, die ein Modell als
JSON-Text statt als `tool_calls` ausgibt (qwen2.5-coder), werden auch für diese Werkzeuge erkannt.

## Skills

**Format** (kompatibel zum verbreiteten Agent-Skill-Layout): ein Ordner je Skill mit `SKILL.md`:

```markdown
---
name: api-conventions          # a-z, 0-9, "-", max. 64
description: REST-Konventionen des Teams. Gilt für neue Endpunkte.
triggers: [endpoint, rest, api]   # optional; Inline- oder Blockliste
version: 1.0.0                    # optional
---
# Anweisungen in Markdown …
```

Optional: weitere Dateien (Referenzen) und `scripts/` mit Skripten (`.js/.mjs/.cjs` über Node, `.py`, `.ps1`, `.sh`).

**Automatische Erkennung** aus drei Quellen: mitgeliefert (`<app>/skills`: `writing-tests`, `code-review`,
`changelog`), Benutzer (`<userData>/skills`), Projekt (`.multi-ai-coder/skills` und `.claude/skills`).
Fehlerhafte Skills werden mit Fehlermeldung angezeigt, nicht verwendet.

**Progressiver Kontext**: Skills, deren Auslöser oder Namensteile in der Aufgabe vorkommen, erhält der Agent
vollständig (Budget 5000 Zeichen mit Werkzeugen, 8000 ohne). Alle übrigen erscheinen nur als Zeile
„Name: Beschreibung“; Agenten mit Werkzeugen laden sie bei Bedarf mit `load_skill`, Dateien mit
`read_skill_file` (pfadgeprüft). Modelle ohne Tool-Calling erhalten nur die passenden Skills.

**Skripte** laufen nur nach ausdrücklicher Genehmigung: Die Oberfläche zeigt den Inhalt aller Skripte, die
Genehmigung ist an den SHA-256 des `scripts/`-Ordners gebunden – jede Änderung hebt sie auf. Ausführung über
`run_skill_script`: ohne Shell, bereinigte Umgebung, im Arbeitsordner der Aufgabe, Timeout 120 s, Ausgabe begrenzt.

**Skill-Manager** (Aktivitätsleiste → Skills): Liste mit Suche/Quellenfilter, Details, aktivieren/deaktivieren,
Rollen, Skript-Genehmigung, Bearbeiten/Löschen (eigene und Projekt-Skills), „Als eigenen Skill kopieren“
(mitgelieferte), Import eines Ordners, **Skill-Builder** (Speicherort, Name, Beschreibung, Auslöser,
Anweisungen) und eine Vorschau „Welche Skills bekommt ein Agent für Aufgabe X?“.

## MCP-Manager

Umsetzung mit dem offiziellen SDK `@modelcontextprotocol/sdk` 1.30.1 (Client).

* **Transporte**: stdio (lokaler Prozess, stderr ins Protokoll) und HTTP (Streamable HTTP, Fallback auf SSE).
* **Authentifizierung**: geheime Umgebungsvariablen (stdio) und geheime Header, z. B.
  `Authorization: Bearer …` (HTTP). Werte liegen verschlüsselt im Tresor des Hauptprozesses (`mcp:<id>`); in der
  Datenbank stehen nur ihre Namen. HTTP-Server können sich über den integrierten OAuth-Fluss anmelden;
  dessen Tokens und Client-Zugangsdaten liegen ebenfalls im Tresor.
* **Lazy**: Verbindung erst beim Testen oder beim ersten Werkzeugaufruf; die Werkzeugliste wird
  zwischengespeichert, sodass Agenten Definitionen ohne Verbindungsaufbau erhalten. Nach 10 min ohne Nutzung
  wird getrennt.
* **Health / Reconnect**: Ping alle 60 s für aktive Verbindungen; bei unerwartetem Abbruch erneuter Aufbau mit
  Backoff (1 s, 2 s, 4 s, max. 3 Versuche), sonst beim nächsten Aufruf.
* **Timeouts**: pro Server (Standard 60 s; Fortschrittsmeldungen verlängern ihn).
* **Berechtigungen je Werkzeug**: „Agenten erlaubt“ / „nur mit Bestätigung“ / „aus“. Werkzeuge mit
  `destructiveHint` stehen standardmäßig auf Bestätigung; der Standard für neue Werkzeuge ist einstellbar.
  Autonome Agenten erhalten **nur** erlaubte Werkzeuge; bestätigungspflichtige ruft nur der Benutzer im Manager
  auf („Ausprobieren“ mit Bestätigungsdialog).
* **Zuweisung**: Rollen je Server.
* **Kontextsparsamkeit**: max. 24 Werkzeuge je Agent (nach Relevanz zur Aufgabe), kompakte Schemas
  (ohne `$schema`/Beispiele/Titel, Beschreibungen ≤ 200 Zeichen), Ergebnisse für Agenten auf 12 000 Zeichen
  gekürzt, Bilder/Ressourcen zusammengefasst; Modell-Name `mcp_<server>_<werkzeug>`.
* **Protokoll** je Server (Verbindung, stderr, jeder Aufruf mit Dauer).
* **Import** im Format `{ "mcpServers": { … } }` (Claude Desktop/Code): Werte, die wie Zugangsdaten aussehen,
  gehen in den Tresor; importierte Server starten **deaktiviert**. `.mcp.json` / `.vscode/mcp.json` /
  `.cursor/mcp.json` im Projekt werden angezeigt, aber nie automatisch gestartet.

Plugin-Werkzeuge ohne Seiteneffekte aktiver Plugins werden Coder-Agenten ebenfalls angeboten
(`plugin_<id>_<werkzeug>`).

## Tests

* `apps/api/src/mcp/mcp.test.ts` – echter stdio-Server (separater Prozess) und Streamable-HTTP-Server mit
  Bearer-Auth (beide mit dem SDK gebaut, `src/mcp/testing/test-server.mjs`): Erkennung, Aufrufe, Fehlerergebnisse,
  Richtlinien, Rollen, Kürzung, Timeout, Absturz + Wiederverbindung, geheime Umgebungsvariablen, falsches Token,
  Import, Deaktivieren, Validierung.
* `apps/api/src/skills/skills.test.ts` – Format, Relevanz, Erkennung aller Quellen, Builder, progressiver
  Kontext, `load_skill`/`read_skill_file` (inkl. Pfad-Ausbruch), Rollen, Skript-Genehmigung inkl. Invalidierung,
  Import.
* `packages/engine/src/agents/local-agent.test.ts` – zusätzliche Werkzeuge im Agentenlauf, Text-Tool-Calls.
* `apps/desktop/e2e/skills-mcp.test.mjs` – GUI: Skill-Builder (Projekt-Skill), Rollen, Vorschau,
  Skript-Genehmigung; MCP-Server anlegen, Geheimnis über die Oberfläche (verschlüsselt geprüft), Verbindung,
  Werkzeuge, Richtlinie, Aufrufe mit Bestätigung, Import.
* `apps/desktop/e2e/agent-tools.live.test.mjs` (`MAC_E2E_LIVE=1`) – **echter Lauf** mit `qwen2.5-coder:7b`:
  der lokale Agent ruft das zugewiesene MCP-Werkzeug auf (Wert 7341, den das Modell nicht kennen kann), folgt der
  Namensregel eines Benutzer-Skills, Validierung bestanden, 0 Premium-Aufrufe. Dieser Test deckte einen Fehler
  auf (Text-Tool-Calls nur für Datei-Werkzeuge erkannt), der behoben ist.

## Offene Punkte

* Premium-Orchestratoren nutzen zugewiesene MCP-Werkzeuge über das sitzungsbezogene SDK-Gateway.
  Dieses gibt jetzt auch Bilder weiter; lokale Textmodelle behalten den Textpfad.
* Anbieterabhängige OAuth-/Konto-Freigaben und kostenpflichtige Generierungen benötigen separate Live-Abnahmen.
