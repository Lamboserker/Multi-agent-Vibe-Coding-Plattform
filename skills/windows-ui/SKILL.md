---
name: windows-ui
description: "Windows-Oberflächen bedienen: Geprüfter Bedienablauf in der ausdrücklich gewählten Anwendung."
triggers: ["windows automation","windows oberfläche","desktop bedienen"]
version: 1.0.0
tools: ["mcp_catalog-windows-mcp_*"]
test-task: "Öffne mit windows-ui einen Texteditor und schreibe einen kurzen Testtext in ein neues Dokument."
---
# Windows-Oberflächen bedienen

1. Lies den aktuellen Fenster- und UI-Automation-Zustand, bevor du Eingaben sendest.
2. Aktiviere das Zielfenster und verwende zugängliche Elemente; Koordinaten nur anhand eines aktuellen Screenshots.
3. Prüfe den Zustand nach jeder Navigation; stoppe bei unklarem Zielfenster.

## Ergebnis

Geprüfter Bedienablauf in der ausdrücklich gewählten Anwendung.

## Werkzeuge

Nutze nur die für diese Aufgabe zugewiesenen und freigegebenen Werkzeuge. Fehlt ein benötigtes Werkzeug, benenne die fehlende Integration und den Einrichtungsweg im Integrationskatalog. Erfinde keine Werkzeugergebnisse.

Screenshots und Renderbilder können die Premium-Orchestratoren visuell prüfen. Lokale Textmodelle verwenden DOM-, UI-Automation- oder Szeneninformationen und behaupten keine visuelle Prüfung.
