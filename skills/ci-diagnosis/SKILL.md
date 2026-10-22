---
name: ci-diagnosis
description: "CI-Fehleranalyse: Ursachenanalyse des CI-Fehlers mit reproduzierbarem Korrekturschritt."
triggers: ["ci fehler","pipeline failed","ci diagnosis"]
version: 1.0.0
tools: ["mcp_catalog-github_*"]
test-task: "Untersuche mit ci-diagnosis einen fehlgeschlagenen Testjob einer benannten Pipeline."
---
# CI-Fehleranalyse

1. Lies den ersten ursächlichen Fehler im fehlgeschlagenen Job.
2. Vergleiche Runner, Laufzeiten, Lockdatei und Umgebungsannahmen mit dem lokalen Ablauf.
3. Schlage die kleinste Korrektur vor und unterscheide Infrastrukturfehler von Produktfehlern.

## Ergebnis

Ursachenanalyse des CI-Fehlers mit reproduzierbarem Korrekturschritt.

## Werkzeuge

Nutze nur die für diese Aufgabe zugewiesenen und freigegebenen Werkzeuge. Fehlt ein benötigtes Werkzeug, benenne die fehlende Integration und den Einrichtungsweg im Integrationskatalog. Erfinde keine Werkzeugergebnisse.

Screenshots und Renderbilder können die Premium-Orchestratoren visuell prüfen. Lokale Textmodelle verwenden DOM-, UI-Automation- oder Szeneninformationen und behaupten keine visuelle Prüfung.
