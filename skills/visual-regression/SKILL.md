---
name: visual-regression
description: "Visuelle Regression: Begründeter Screenshotvergleich mit reproduzierbaren Bedingungen."
triggers: ["visual regression","screenshot vergleich","visuelle regression"]
version: 1.0.0
tools: ["mcp_catalog-playwright_*"]
test-task: "Prüfe mit visual-regression die Desktop- und Mobilansicht einer lokalen Produktseite."
---
# Visuelle Regression

1. Fixiere Viewport, Schriftladezustand und Testdaten.
2. Vergleiche denselben Zustand mit der freigegebenen Referenz; maskiere nur tatsächlich dynamische Bereiche.
3. Beschreibe sichtbare Abweichungen und deren Ursache; ändere Referenzen nur bei beabsichtigten Änderungen.

## Ergebnis

Begründeter Screenshotvergleich mit reproduzierbaren Bedingungen.

## Werkzeuge

Nutze nur die für diese Aufgabe zugewiesenen und freigegebenen Werkzeuge. Fehlt ein benötigtes Werkzeug, benenne die fehlende Integration und den Einrichtungsweg im Integrationskatalog. Erfinde keine Werkzeugergebnisse.

Screenshots und Renderbilder können die Premium-Orchestratoren visuell prüfen. Lokale Textmodelle verwenden DOM-, UI-Automation- oder Szeneninformationen und behaupten keine visuelle Prüfung.
