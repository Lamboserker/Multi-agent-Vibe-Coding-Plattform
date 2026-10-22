---
name: issue-triage
description: "Issue-Triage: Reproduzierbare Problemdefinition mit konkretem nächsten Schritt."
triggers: ["issue triage","fehlerticket","issue analysieren"]
version: 1.0.0
tools: ["mcp_catalog-github_*"]
test-task: "Analysiere mit issue-triage ein benanntes GitHub-Issue und beschreibe seine Reproduktion."
---
# Issue-Triage

1. Lies Beschreibung, Reproduktion und relevante Kommentare vollständig.
2. Trenne beobachtetes Verhalten, Erwartung und unbestätigte Vermutungen.
3. Ordne betroffene Komponente und nächsten reproduzierbaren Prüfschritt zu; ändere Tickets nur im Auftrag.

## Ergebnis

Reproduzierbare Problemdefinition mit konkretem nächsten Schritt.

## Werkzeuge

Nutze nur die für diese Aufgabe zugewiesenen und freigegebenen Werkzeuge. Fehlt ein benötigtes Werkzeug, benenne die fehlende Integration und den Einrichtungsweg im Integrationskatalog. Erfinde keine Werkzeugergebnisse.

Screenshots und Renderbilder können die Premium-Orchestratoren visuell prüfen. Lokale Textmodelle verwenden DOM-, UI-Automation- oder Szeneninformationen und behaupten keine visuelle Prüfung.
