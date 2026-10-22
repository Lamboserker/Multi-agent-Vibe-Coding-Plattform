---
name: blender-export
description: "3D-Export: Geprüfte Exportdatei mit passenden Einheiten und vollständig referenzierten Assets."
triggers: ["blender export","gltf","3d export"]
version: 1.0.0
tools: ["mcp_catalog-blender_*"]
test-task: "Exportiere mit blender-export ein Testobjekt als GLB und prüfe den Reimport."
---
# 3D-Export

1. Kläre Zielformat, Zielanwendung und benötigte Objekte.
2. Prüfe Einheiten, Achsen, Transformationen, Materialien und Texturpfade.
3. Exportiere eine Kopie und importiere sie zur Kontrolle in eine leere Szene.

## Ergebnis

Geprüfte Exportdatei mit passenden Einheiten und vollständig referenzierten Assets.

## Werkzeuge

Nutze nur die für diese Aufgabe zugewiesenen und freigegebenen Werkzeuge. Fehlt ein benötigtes Werkzeug, benenne die fehlende Integration und den Einrichtungsweg im Integrationskatalog. Erfinde keine Werkzeugergebnisse.

Screenshots und Renderbilder können die Premium-Orchestratoren visuell prüfen. Lokale Textmodelle verwenden DOM-, UI-Automation- oder Szeneninformationen und behaupten keine visuelle Prüfung.
