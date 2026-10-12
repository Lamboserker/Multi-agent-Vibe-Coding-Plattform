# Fertigstellungsauftrag für Hermes

Arbeitsverzeichnis: `D:\Programmieren\Multi-Agent-Vibe-Coding-Plattform`

## Ziel

Die bestehende Multi-AI-Coder-Desktop-Plattform lokal zuverlässig lauffähig machen und verbleibende Fehler bis zu einer überprüfbaren Windows-Version beheben. Bestehende Funktionen und Nutzerdaten erhalten.

## Vorgehen

1. README.md, docs/desktop-architecture.md, docs/state-architecture.md und docs/performance.md lesen. Das alte ai-handoff-handbuch.md beschreibt überwiegend den abgelösten Web-Stand.
2. Den vorhandenen Stand prüfen: Typprüfung, Tests, Lint, Desktop-Build und Start der paketierten Anwendung.
3. Lokale Laufzeit, SQLite-Migrationen, Projektöffnung, Modellverwaltung, Planung, isolierte Ausführung, Diff und Freigabe prüfen. Gefundene Fehler konkret reproduzieren und beheben.
4. Vorhandene Ollama-Modelle und CLI-Anmeldungen nutzen. Keine neuen kostenpflichtigen Provider aktivieren; keine Zugangsdaten in Dateien oder Logs kopieren.
5. Den Live-E2E-Test mit einem verfügbaren lokalen Modell in seinem Testprojekt durchführen. Fehlende Anmeldung als tatsächlichen Blocker nennen.
6. Windows-Installer erstellen und Ergebnis, Testergebnisse sowie verbleibende Einschränkungen in docs/fertigstellungsstatus.md festhalten.

## Grenzen

Keine bestehenden Dateien oder Nutzerdaten löschen. Keine globalen Sicherheitseinstellungen lockern. Kein Push, keine Veröffentlichung und keine kostenpflichtigen Downloads. Keine alten Web-Dry-Run-Annahmen als aktuelle Architektur behandeln. Bestehende Tests mit echtem Fehlerbezug ergänzen. Nur tatsächlich geprüfte Ergebnisse als fertig melden.

## Ausgangsbefund am 12.10.2026

- Abhängigkeiten sind vorhanden; die vollständige Typprüfung besteht.
- Der Projektordner hatte keine Git-Historie. Eine lokale Ausgangssicherung wird eingerichtet, damit die Engine Worktrees verwenden kann.
- Ollama ist installiert, war beim ersten Check aber nicht erreichbar.
- Hermes ist installiert und läuft; das Projekt ist als aktives Hermes-Projekt registriert.

Nicht behaupten, die gesamte Plattform sei fertig, bevor Build, Start und Ausführungsablauf verifiziert sind.
