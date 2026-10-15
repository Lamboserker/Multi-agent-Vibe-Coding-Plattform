# Plugin-System

Stand: Phase 0.3 (D). Plugin-API-Version **1** (`@multi-ai-coder/plugin-sdk`).

## Überblick

Ein Plugin ist ein Ordner mit `multi-ai-coder-plugin.json` (Manifest) und einem JavaScript-Einstiegsmodul
(CommonJS oder ES-Modul), das `activate(context)` und optional `deactivate()` exportiert:

```js
// index.cjs
module.exports = {
  activate(context) {
    context.commands.register('hello', async (args) => ({ message: `Hallo ${args.name ?? 'Welt'}` }))
    context.views.register('main', async () => ({ type: 'stack', children: [{ type: 'heading', text: 'Mein Plugin' }] }))
  },
}
```

```json
{
  "id": "mein-plugin",
  "name": "Mein Plugin",
  "version": "1.0.0",
  "description": "…",
  "apiVersion": 1,
  "main": "index.cjs",
  "categories": ["Beispiel"],
  "permissions": { "network": ["api.example.com"], "fs": "project-read", "processes": ["git"], "secrets": ["token"] },
  "contributes": {
    "views": [{ "id": "main", "title": "Mein Plugin" }],
    "commands": [{ "id": "hello", "title": "Hallo sagen" }],
    "settings": [{ "key": "token", "title": "Token", "type": "secret" }],
    "agentTools": [{ "name": "my_tool", "description": "…", "inputSchema": { "type": "object" } }],
    "hooks": ["run.execution_finished"],
    "contextProviders": [{ "id": "ctx", "title": "Planungskontext" }]
  }
}
```

TypeScript-Autoren nutzen `definePlugin()` und die Typen aus `@multi-ai-coder/plugin-sdk`
(`MultiAICoderPlugin`, `PluginContext`, `ViewNode`, `CommandResult`, `validateManifest`).

## Erweiterungspunkte

| Punkt | API | Wirkung in der App |
|---|---|---|
| Commands | `context.commands.register(id, handler)` | Aufrufbar aus Plugin-Ansichten (Buttons, Formulare, Tabellenaktionen) und über `POST /plugins/:id/commands/:command`; nur im Manifest deklarierte Befehle sind aufrufbar. |
| UI Views | `context.views.register(id, render)` | Deklarativer Baum (`stack`, `heading`, `text`, `markdown`, `code`, `kv`, `badge`, `image`, `table`, `actions`, `form`), den die App rendert. Plugins führen **keinen Code in der Oberfläche** aus. |
| Settings | Manifest `contributes.settings` | Formular im Plugin-Manager; Typ `secret` wird verschlüsselt im Hauptprozess gespeichert. |
| Agent Tools | `context.tools.register(name, handler)` | Schema aus dem Manifest; `GET /plugins/tools` liefert den Katalog (`plugin.tool`), Aufruf über `POST /plugins/:id/tools/:tool`. |
| Event Hooks | `context.events.on('channel.type', handler)` | Laufzeit-Ereignisse (z. B. `run.execution_finished`, `system.settings_changed`) werden an Plugins weitergereicht (Timeout 10 s). |
| Context Providers | `context.contextProviders.register(id, provide)` | Vor der Premium-Planung wird jeder Provider mit dem Ziel aufgerufen (Timeout 3 s, max. 4000 Zeichen je Provider); das Ergebnis wird an den Planungskontext angehängt. Beispiel: GitHub liefert Issue-Texte für `#123`. |
| Model Providers, Orchestrator Adapters, Repository Analyzers, Test Runner, Language Integrations, Git Integrations | `context.contributions.register(kind, id, impl)` | Auswahl je Art im Plugin-Manager. Eingebunden: Modellanbieter → lokale Agenten (`LocalModelsService`), Orchestrator → Analyse/Plan/Ausführung/Review/Chat (Ergebnisse werden wie bei Claude/Codex validiert; Eingabe enthält `operation` und `schema`), Analyzer → Planungskontext, Test-Runner → Validierung eines Laufs im Worktree, Sprache → IDE-Sprachfunktionen, Git → Git-Ansicht. Sprache/Git können mit `{ unsupported: true }` an die eingebaute Implementierung zurückgeben. Eine deaktivierte Auswahl fällt nie still zurück. |

**Delegierte Verzeichnisse:** Während eines Erweiterungsaufrufs dürfen `context.fs` (Option `root`) und
`context.process.run` (Option `cwd`) genau die Verzeichnisse nutzen, die die App dem Aufruf übergibt
(`cwd` z. B. Agenten-Worktree, `project.repoPath`), danach nicht mehr. **Host per Einstellung:** Eine
Einstellung mit `"grantsHost": true` (z. B. API-URL für GitHub Enterprise/GitLab self-hosted) gibt genau den
vom Nutzer eingetragenen Host:Port für `context.http` frei. **Zeitlimits** je Art: Tests 10 min,
Orchestrator 15 min, Modell 10 min, Analyzer 60 s, Sprache/Git 30 s.

`CommandResult` kann `message` (Toast), `view` (Ergebnisansicht), `text` (z. B. in den Chat übernehmen bei
`resultTarget: 'chat'`) und `reloadView` (Ansicht mit neuer Eingabe neu rendern) enthalten.

## Isolation und Berechtigungen

Jedes aktivierte Plugin läuft in **einem eigenen Prozess** (`plugin-host.cjs`, Electron im Node-Modus), gestartet
von der Laufzeit:

* **Node-Berechtigungsmodell** (`--permission`): Lesen nur im Plugin-Ordner und im privaten Datenordner
  (`<userData>/plugin-data/<id>`, dort auch Schreiben). Kindprozesse, Worker, native Addons und `process.binding`
  werden von Node selbst verweigert. Mit `fs`-Berechtigung zusätzlich Zugriff auf den Ordner des geöffneten
  Projekts (Lesen bzw. Lesen/Schreiben); beim Projektwechsel wird der Prozess neu gestartet.
* **Netzwerk**: Node 24 hat kein Netzwerk-Permission-Flag. Für sandboxed Plugins sperrt der Host deshalb
  `net`, `tls`, `http(s)`, `http2`, `dgram`, `dns`, `undici`, `child_process`, `cluster`, `worker_threads`,
  `inspector` für `require` (Hook auf `Module._load`) **und** `import` (`module.registerHooks`; das off-thread
  `module.register` würde einen Worker benötigen) sowie `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest`.
  Netzwerkzugriff gibt es dann nur über `context.http.fetch`, das die Laufzeit gegen die freigegebenen Hosts
  prüft (`*.example.com` für Subdomains, `*` = beliebige Hosts – im Dialog ausdrücklich so benannt).
* **Kontrollierte RPC**: Jede Wirkung (`http`, `fs`, `process`, `secrets`, `storage`, `project`, `settings`)
  ist eine Anfrage an die Laufzeit, die gegen die gewährten Berechtigungen geprüft und protokolliert wird.
  Prozesse: nur freigegebene Programmnamen, ohne Shell, bereinigte Umgebung, Timeout ≤ 10 min, Ausgabe ≤ 4 MB.
  Dateien: nur relativ zum Projekt, nie `.git`.
* **Timeouts**: Befehle/Ansichten/Werkzeuge 30 s (danach wird der Prozess neu gestartet), Hooks 10 s,
  Context Provider 3 s, Aktivierung 20 s.
* **Absturzisolierung**: Ein abgestürzter Plugin-Prozess beeinflusst weder Laufzeit noch Oberfläche;
  Neustart mit Backoff (1 s, 2 s, 4 s), nach mehr als 3 Abstürzen in 5 Minuten wird das Plugin deaktiviert.
* **Ressourcen**: `--max-old-space-size=256`; RSS/Heap/CPU werden alle 5 s gemeldet (Plugin-Manager);
  über 512 MB RSS wird der Prozess beendet.
* **Integrität**: Bei der Installation wird ein SHA-256 je Datei gespeichert und **vor jeder Aktivierung**
  geprüft; veränderte Dateien → Plugin wird deaktiviert, Status „Fehler“. (Signaturen von Herausgebern sind
  vorbereitet, aber es gibt noch keine Schlüsselinfrastruktur.)
* **Umgebung**: Plugins erhalten nur `PATH`, Temp-, Home- und Programmverzeichnisse – keine Tokens oder
  Zugangsdaten aus der Umgebung der App.
* **Geheimnisse**: Werden im Electron-Hauptprozess mit `safeStorage` (DPAPI/Keychain/libsecret) verschlüsselt
  gespeichert (`secrets.json`). Die Oberfläche kann sie setzen und löschen, aber nicht lesen; die Laufzeit
  fragt einen Wert nur für ein Plugin ab, dem genau dieses Geheimnis gewährt wurde.

### Vertrauensstufen

| | mitgeliefert (`trusted`) | Fremd-Plugin (`untrusted`) |
|---|---|---|
| Herkunft | `<app>/plugins` | Ordner oder Git-URL (`git clone --depth 1`, keine Installationsskripte) |
| Startzustand | registriert, deaktiviert | installiert, deaktiviert |
| Aktivierung | nach Bestätigung der Berechtigungen | nach Bestätigung der Berechtigungen |
| `native` (direkte Sockets/Kindprozesse) | möglich, wenn im Manifest angefordert **und** gewährt | **nie** – bleibt immer in der Sandbox |

Updates behalten Berechtigungen nur, soweit die neue Version sie noch anfordert; neue Anforderungen müssen
erneut bestätigt werden. Ältere Versionen werden nur nach ausdrücklicher Bestätigung installiert
(Versionskonflikt → Dialog „Downgrade installieren“).

## Plugin-Manager

Aktivitätsleiste → **Erweiterungen**: installierte und verfügbare Plugins, Suche, Kategorien, Details
(Version, Herkunft, Vertrauensstufe, Status, letzter Fehler), Berechtigungen, Aktivieren (Berechtigungsdialog),
Deaktivieren, Neu starten, Aktualisieren, Deinstallieren, Einstellungen inkl. Geheimnisse, Plugin-Ansichten,
Agenten-Werkzeuge, weitere Erweiterungspunkte, Protokoll, Speicher-/CPU-Werte. Installation aus Ordner oder Git.

**Marktplatz (vorbereitet)**: `GET /plugins/catalog` liefert Einträge aus Quellen; heute die mitgelieferten
Plugins und `plugins/catalog.json` (Git-Quellen). Eine entfernte Quelle liefert dasselbe Format.

## Mitgelieferte Plugins

| Plugin | Funktionen | Berechtigungen |
|---|---|---|
| **GitHub** | offene PRs/Issues des Repos (aus `origin` oder Einstellung), PR-Details mit geänderten Dateien und Review-Kommentaren, Issue anlegen (Token), PR/Issue in den Chat, Agent-Tools `github_issues`, `github_pull_request`, Context Provider für `#123` | `api.github.com`, `git`, Secret `token` |
| **GitLab** | Pipelines (Jobs), offene MRs/Issues (gitlab.com), MR in den Chat, Agent-Tools `gitlab_merge_request`, `gitlab_failed_jobs` (inkl. Log-Ende) | `gitlab.com`, `git`, Secret `token` |
| **Docker** | Devcontainer aus `.devcontainer/devcontainer.json` (JSONC; `image`/`build` inkl. Kontext `..`/Compose; `containerEnv`, `workspaceFolder`, `forwardPorts`, `postCreateCommand`, `postStartCommand`; `features` und `initializeCommand` werden mit Begründung abgelehnt), Container (Start/Stopp/Neustart/Entfernen mit Bestätigung/Logs/Logs → Chat), Images, `docker compose up -d/down` für die Compose-Datei des Projekts, Agent-Tools `docker_containers`, `docker_logs` | `docker`, Projekt lesen |
| **Database Tools** | SQLite-Dateien im Projekt (Auswahl), PostgreSQL (URL als Secret; SCRAM-SHA-256/MD5, optional TLS), Schema-Browser, Tabellenansicht, SQL-Konsole; Leseabfragen laufen **auf DB-Ebene** nur lesend (SQLite read-only geöffnet, PostgreSQL `BEGIN TRANSACTION READ ONLY`), alles andere erst nach Bestätigung; Agent-Tools `db_schema`, `db_query` (nur lesend) | Projekt lesen/schreiben, Secret, `native` |
| **Referenz-Erweiterungen** | Referenzimplementierung aller sechs Erweiterungspunkte: OpenAI-kompatibler lokaler Modellanbieter und Orchestrator (LM Studio, llama.cpp, vLLM; nur 127.0.0.1/localhost), Manifest-Analyse, Test-Runner (npm/pnpm/yarn test, pytest), JSON-Diagnosen, Git über die git-CLI | Netzwerk lokal, Projekt schreiben, `git`, Paketmanager, `python` |
| **API Tools** | REST-Client (Methode, URL, Header, Body), Antwort formatiert, Sammlungen, Umgebungsvariablen `{{name}}`, Sammlung ausführen, Antwort → Chat, Agent-Tool `http_request` (Seiteneffekte) | Netzwerk `*` |
| **Browser Testing** | lokaler Chrome/Edge headless über `--remote-debugging-pipe` (kein Debug-Port), Screenshot, Konsole, Exceptions, fehlgeschlagene Requests, Automatisierung (`goto`, `click`, `type`, `press`, `wait`, `waitFor`, `expectText`, `screenshot`, `eval`), Ergebnis → Chat, Agent-Tool `browser_check`; frisches Profil je Lauf im Plugin-Datenordner | `native` |

## Tests

* `apps/api/src/plugins/plugins.test.ts` – echte Host-Prozesse: Installation, Aktivierung, Befehle/Ansichten/Tools,
  Speicher, Sandbox (Datei außerhalb, `child_process`, `fetch`, `https`-Modul, ESM-`import`), Berechtigungsprüfung
  von `context.http`/`context.fs`, hängender und abstürzender Plugin-Prozess (Neustart), fehlerhafte Aktivierung,
  fehlende Berechtigungen, Integritätsprüfung, Update, Versionskonflikt, Deinstallation.
* `apps/api/src/plugins/builtin-plugins.test.ts` – alle sechs Plugins gegen lokale Ziele (SQLite-Datei,
  HTTP-Server auf 127.0.0.1, echter Chrome); Docker meldet einen gestoppten Daemon verständlich; GitHub gegen
  die öffentliche API nur mit `MAC_TEST_NETWORK=1`, PostgreSQL nur mit `MAC_TEST_POSTGRES_URL`.
* `apps/api/src/plugins/reference-extensions.test.ts` – Referenz-Plugin an allen sechs Aufrufstellen.
* `apps/api/src/plugins/forge-plugins.test.ts` – GitHub/GitLab gegen lokale API-Testserver (Review/Issue anlegen nur lokal).
* `apps/api/src/plugins/docker-services.integration.test.ts` – Devcontainer und PostgreSQL (über das Plugin) gegen den laufenden Docker-Daemon, opt-in `MAC_TEST_DOCKER=1`.
* `packages/plugin-sdk/src/index.test.ts` – Manifest-Validierung, Host-Regeln, Versionsvergleich.
* `apps/desktop/e2e/plugins.test.mjs` – GUI: Liste, Berechtigungsdialog, Datenbank-Ansicht mit bestätigtem
  Schreiben, verschlüsseltes Secret wird vom Plugin gelesen, Fremd-Plugin aus Ordner in der Sandbox,
  App-Neustart (Plugins wieder aktiv), Deinstallieren, Deaktivieren.

## Offene Punkte

* Netzwerkisolierung sandboxed Plugins erfolgt auf Modulebene im Plugin-Prozess (Node hat kein Netzwerk-Flag);
  ein Plugin mit nativem Addon könnte sie umgehen – native Addons verweigert jedoch bereits das
  Berechtigungsmodell.
* Herausgeber-Signaturen: Integritäts-Hashes ja, Signaturprüfung noch nicht.
* Devcontainer-`features` benötigen die Dev-Container-CLI und werden abgelehnt (nicht ignoriert).
