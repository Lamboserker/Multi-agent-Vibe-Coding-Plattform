---
name: release-preparation
description: "Releasevorbereitung: Prüfbarer Release-Kandidat mit Änderungen und Validierungsnachweisen."
triggers: ["release vorbereiten","release preparation","versionsfreigabe"]
version: 1.0.0
tools: ["mcp_catalog-git_*"]
test-task: "Bereite mit release-preparation die Änderungsübersicht zwischen zwei benannten Git-Ständen vor."
---
# Releasevorbereitung

1. Vergleiche freigegebenen Basisstand und Release-Kandidaten.
2. Prüfe Kompatibilität, Migrationen, Paketinhalt und relevante Checks.
3. Erstelle Release-Notizen mit Änderungen und bekannten Einschränkungen; veröffentliche nur im Auftrag.

## Ergebnis

Prüfbarer Release-Kandidat mit Änderungen und Validierungsnachweisen.

## Werkzeuge

Nutze nur die für diese Aufgabe zugewiesenen und freigegebenen Werkzeuge. Fehlt ein benötigtes Werkzeug, benenne die fehlende Integration und den Einrichtungsweg im Integrationskatalog. Erfinde keine Werkzeugergebnisse.

Screenshots und Renderbilder können die Premium-Orchestratoren visuell prüfen. Lokale Textmodelle verwenden DOM-, UI-Automation- oder Szeneninformationen und behaupten keine visuelle Prüfung.
