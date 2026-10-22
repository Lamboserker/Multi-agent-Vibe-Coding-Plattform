---
name: sentry-triage
description: "Sentry-Triage: Belegter Fehlerbefund mit Auswirkung und Prüfschritt."
triggers: ["sentry triage","sentry fehler","error monitoring"]
version: 1.0.0
tools: ["mcp_catalog-sentry_*"]
test-task: "Analysiere mit sentry-triage ein benanntes Sentry-Issue und dessen betroffene Versionen."
---
# Sentry-Triage

1. Lies Stacktrace, betroffene Versionen und Auftretenshäufigkeit.
2. Verbinde die erste relevante Anwendungsstelle mit dem konkreten Auslöser.
3. Beschreibe Priorität, Reproduktion und einen verifizierbaren Korrekturansatz.

## Ergebnis

Belegter Fehlerbefund mit Auswirkung und Prüfschritt.

## Werkzeuge

Nutze nur die für diese Aufgabe zugewiesenen und freigegebenen Werkzeuge. Fehlt ein benötigtes Werkzeug, benenne die fehlende Integration und den Einrichtungsweg im Integrationskatalog. Erfinde keine Werkzeugergebnisse.

Screenshots und Renderbilder können die Premium-Orchestratoren visuell prüfen. Lokale Textmodelle verwenden DOM-, UI-Automation- oder Szeneninformationen und behaupten keine visuelle Prüfung.
