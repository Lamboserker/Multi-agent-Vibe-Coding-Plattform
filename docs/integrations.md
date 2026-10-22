# Integrationskatalog

Im Setup unter **MCP-Server → Integrationskatalog** oder **Skills → Integrationskatalog** stehen
30 MCP-Vorlagen, 40 zusätzliche Skills und acht Workflow-Pakete bereit. Die bestehenden Manager
bleiben für eigene Server, JSON-Importe, Rollen und Werkzeugrichtlinien verfügbar.

## Einrichtung

1. Integration auswählen. Der Assistent prüft Betriebssystem und lokale Voraussetzungen.
2. Fehlende Programme bei Bedarf über die angebotenen Windows-Paketmanager-Schritte installieren.
   Andere Systeme benötigen vorhandene Laufzeiten; kompatible Serverpakete lassen sich dort ebenfalls installieren.
3. Serverpaket in der angegebenen Version installieren, benötigte Ordner auswählen und Zugangsdaten
   hinterlegen oder beim Anbieter anmelden. Die App verändert keine Konfigurationen anderer MCP-Clients.
4. Verbindung und Werkzeugliste prüfen. Bei Blender zuerst das angebotene Add-on in Blender aktivieren
   und dessen Server starten. Bei Higgsfield ist ein passendes kostenpflichtiges Konto erforderlich.
5. Konkrete Werkzeuge und Agentenrollen freigeben. Nicht ausgewählte und neue Werkzeuge bleiben
   bestätigungspflichtig; Agenten erhalten ausschließlich `allow`-Werkzeuge.

Aufträge laufen im Hintergrund. Man kann den Katalog verlassen, die Einrichtung später wieder öffnen,
Fehler korrigieren und erneut versuchen. Nach einem App-Neustart bleiben Anmeldungs- und Freigabeschritte
erhalten; unterbrochene Installations-/Prüfschritte können wiederholt werden. Ein Abbruch entfernt keine
bereits installierten Programme oder eingerichteten Verbindungen.

Lokale Serverpakete und deren Arbeitsdaten liegen unter `<userData>/integrations/`. Node-Pakete werden
ohne Installationsskripte installiert. Python-Server nutzen von uv verwaltete Umgebungen; Windows-MCP
verwendet Python 3.14. Geheimnisse liegen ausschließlich im vorhandenen verschlüsselten Tresor.

Anbieter können Konten, Tarife oder eine Client-Zulassung verlangen, insbesondere Figma. Ein Katalogeintrag
garantiert keinen Anbieterzugang; erst ein erfolgreicher Verbindungstest führt zum Freigabeschritt.

## Skills und Pakete

Die 40 neuen Skills sind zunächst deaktiviert. Sie lassen sich einzeln einschalten oder durch ein
Workflow-Paket aktivieren. Bereits vorhandene Skills behalten ihren Aktivierungszustand.
Pakete unterscheiden erforderliche und optionale Integrationen. Aktiviert werden passende Skills für
die ausgewählten Dienste. Bestehende Rollen und Werkzeugfreigaben werden nicht überschrieben.
Beim Entfernen einer Paketzuordnung bleiben Server, Skills und Freigaben bestehen; sie lassen sich
danach weiterhin einzeln verwalten. Skills sind keine zusätzlichen Werkzeugberechtigungen.

## Bilder und Agenten

Das Orchestrator-MCP-Gateway reicht unterstützte PNG-, JPEG-, WebP- und GIF-Bilder als Bildblöcke an
Codex/Claude weiter. Lokale Textmodelle erhalten weiterhin Text mit Bildbeschreibungen. Ergebnisse sind
auf insgesamt 16 MB begrenzt; lange Texte bleiben seitenweise lesbar. Bilder werden nicht in Laufzeitereignisse
geschrieben. Das Gateway prüft entzogene Freigaben auch nach einem länger laufenden Werkzeugaufruf.

## Entwicklung und Prüfung

Der versionierte Katalog liegt im Shared-Paket. Skill-Dateien werden mit
`node scripts/sync-integration-skills.mjs` aus dessen gebautem Katalog erzeugt; `--check` prüft Konsistenz.
Die bestehenden Staging-Skripte übernehmen die Skills und die additive Migration in das Desktop-Paket.

Automatisierte Tests verwenden temporäre Datenbanken und lokale SDK-Testserver. Der Desktop-E2E-Test
`apps/desktop/e2e/integrations.test.mjs` prüft Suche, Einrichtung, explizite Freigaben, Pakete und Neustart.
Optionale native Pakettests laufen mit `MAC_TEST_INTEGRATIONS_NATIVE=1` gegen eine lokale Browser-Testseite
und einen Windows-MCP-Handshake. Sie installieren keine OS-Voraussetzungen, rufen keine Modelle auf und
verwenden keine Konten. Blender wird ohne vorhandene Installation übersprungen. Anbieter-Anmeldungen und
kostenpflichtige Generierungen bleiben gesonderte Live-Abnahmen.
