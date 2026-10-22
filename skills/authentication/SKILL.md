---
name: authentication
description: "Authentifizierung: Geprüfter Anmelde- oder Berechtigungsfluss innerhalb der vorhandenen Architektur."
triggers: ["authentifizierung","authentication","session login"]
version: 1.0.0
tools: ["read_file","edit_file"]
test-task: "Prüfe mit authentication, dass abgemeldete Nutzer einen geschützten Endpunkt nicht erreichen."
---
# Authentifizierung

1. Ermittle vorhandenen Session-/Token-Fluss und Vertrauensgrenzen.
2. Halte Geheimnisse serverseitig und prüfe Ablauf, Abmeldung sowie widerrufene Zugriffe.
3. Nutze bestehende Bibliotheken und teste erlaubte und verweigerte Zugriffe.

## Ergebnis

Geprüfter Anmelde- oder Berechtigungsfluss innerhalb der vorhandenen Architektur.

## Werkzeuge

Nutze nur die für diese Aufgabe zugewiesenen und freigegebenen Werkzeuge. Fehlt ein benötigtes Werkzeug, benenne die fehlende Integration und den Einrichtungsweg im Integrationskatalog. Erfinde keine Werkzeugergebnisse.

Screenshots und Renderbilder können die Premium-Orchestratoren visuell prüfen. Lokale Textmodelle verwenden DOM-, UI-Automation- oder Szeneninformationen und behaupten keine visuelle Prüfung.
