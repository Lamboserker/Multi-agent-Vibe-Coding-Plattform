---
name: higgsfield-images
description: "Bilder erzeugen: Bilddatei oder Asset-Link mit dokumentiertem Prompt und Ergebnisprüfung."
triggers: ["higgsfield bild","image generation","bild erzeugen"]
version: 1.0.0
tools: ["mcp_catalog-higgsfield_*"]
test-task: "Erzeuge mit higgsfield-images nach Kostenfreigabe ein quadratisches Produktbild für einen Testartikel."
---
# Bilder erzeugen

1. Kläre Motiv, Stil, Seitenverhältnis und Verwendungszweck aus dem Auftrag.
2. Prüfe verfügbare Modelle und Kostenfreigabe; übergib einen konkreten Prompt.
3. Verfolge den vorhandenen Auftrag bis zum Ergebnis und prüfe Motiv sowie Format; starte bei Timeout keine zweite Generierung.

## Ergebnis

Bilddatei oder Asset-Link mit dokumentiertem Prompt und Ergebnisprüfung.

## Werkzeuge

Nutze nur die für diese Aufgabe zugewiesenen und freigegebenen Werkzeuge. Fehlt ein benötigtes Werkzeug, benenne die fehlende Integration und den Einrichtungsweg im Integrationskatalog. Erfinde keine Werkzeugergebnisse.

Screenshots und Renderbilder können die Premium-Orchestratoren visuell prüfen. Lokale Textmodelle verwenden DOM-, UI-Automation- oder Szeneninformationen und behaupten keine visuelle Prüfung.
