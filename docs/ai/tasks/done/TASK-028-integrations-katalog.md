# TASK-028 — Integrationen, Skills und Workflow-Pakete

## Auftrag
Den vom Nutzer bestätigten One-Click-Plan umsetzen: 30 MCP-Vorlagen, 40 zusätzliche Skills,
acht Pakete, Windows-Einrichtung, persistente Jobs und Bilder über das Orchestrator-Gateway.

## Ausgangslage
Die Arbeitskopie enthält uncommittete Design-/Duo-/Hardware-Änderungen. Diese bleiben erhalten.
Bestehende MCP-/Skill-Manager, OAuth, Tresor, Rollen und SDK-Gateway werden wiederverwendet.
Keine Commits und keine kostenpflichtigen Live-Aufrufe.

## Umsetzung
- Gemeinsamer versionierter Katalog: genau 30 MCP-Vorlagen, 40 erzeugte SKILL.md und acht Pakete.
- Hintergrund-Einrichtung mit geprüften Installationsaktionen, OAuth/Tresor, expliziter Wiederverwendung,
  Wiederholung, Abbruch, Neustarterkennung und konkreten Werkzeug-/Rollenfreigaben.
- Additive Migration für Installationen, Jobs und Paketmitgliedschaften. Bestehende Zustände bleiben erhalten.
- Katalog und Assistent aus MCP-/Skill-Manager erreichbar; Suche, Filter, Skill-/Paketaktivierung.
- Optionale strukturierte MCP-Ausführung für Bildblöcke, Fehler und lange Texte im Orchestrator-Gateway;
  lokale Textmodelle behalten den Textpfad. Größenlimit und Rechteprüfung nach langen Aufrufen.
- Skill-Dateierkennung liest begrenzt parallel und hasht Skripte weiterhin bei jeder Erkennung.

## Verifikation
- Vollständiger Workspace-Typecheck und Desktop-Build erfolgreich.
- API: 274 Tests bestanden, 11 bewusst übersprungen (`--maxWorkers=2`).
- Desktop: 107 Unit-Tests bestanden.
- Engine: 60 gezielte Agenten-/Adapter-/Git-Integrationstests bestanden.
- Vollständige Engine-Suite blieb in zwei Versuchen hängen und wurde gezielt beendet. Der anfänglich
  unter Last abgelaufene catch-up-Test bestand isoliert; keine vollständige Engine-Abnahme behauptet.
- Desktop-E2E zweimal bestanden: Suche, 40 Skills, acht Pakete, explizite Freigaben, Aktivierung und Neustart.
- Native Pakete: Playwright 0.0.83 gegen lokale HTTP-Testseite mit DOM-Snapshot und echtem Screenshot;
  Windows-MCP 0.8.8 mit verwaltetem Python 3.14 installiert, Werkzeugliste/SDK-Handshake erfolgreich.
- Staging erfolgreich; genau 40 neue Skill-Dateien, Katalog und Migration im Paket geprüft.
- Keine Premium-Modellaufrufe und keine Commits. Bestehende uncommittete Änderungen erhalten.

## Übergabe
- Einstieg nach App-Neustart: Setup → MCP-Server/Skills → Integrationskatalog.
- Dokumentation: `docs/integrations.md`. Skill-Konsistenz: `node scripts/sync-integration-skills.mjs --check`.
- Kontoabhängige Hersteller-Logins und kostenpflichtige Generierungen sind nicht live abgenommen.
- Blender fehlt auf diesem Rechner; der native Blender-Test wurde übersprungen. Add-on-/Szenenprüfung
  muss auf einem Rechner mit Blender erfolgen. Es wurde keine OS-Anwendung für Tests installiert.
