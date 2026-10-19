# Lokale Umsetzung und Reparatur im UI – 15. Oktober 2026

Die geprüfte Umsetzung reduziert in der wiederholten realen UI-Serie die mittlere Gesamtdauer von **169,8 auf 43,8 Sekunden (74,2 %)** und die lokalen Ausgabetokens um **97,9 %**. Je Stand wurden sechs Aufgaben erfolgreich geprüft und über die UI übernommen. Die unveränderte Ausgangsmessung bleibt unter [ui-2026-10-15T12-09-36-841Z](ui-2026-10-15T12-09-36-841Z/summary.json) erhalten: 114,093 Sekunden bis zum sichtbaren Ergebnis, 74,534 Sekunden lokaler Aufruf, 4.605 lokale Ausgabetokens und 16.253 Zeichen Erläuterung. Dieser einzelne historische Wert ist nicht der Mittelwert der neuen Vergleichsserie.

## Umsetzung

- Die Engine verwendet für vorbereitete Aufgaben geringer Komplexität und geringen Risikos strukturierte Operationen. Bis zu sechs kleine Zieldateien müssen vollständig in den bereitgestellten Kontext passen. Auch nominell neue, bereits vorhandene Dateien werden vorgelesen; nur bestätigtes Fehlen erlaubt eine Neuanlage ohne Inhalt im Prompt. Partielle oder unbekannte Bestandsdateien, kritische Pfade und ausdrücklich fehlgeschlagene Struktur-Selbsttests behalten die bisherigen Einschränkungen.
- Das bloße Angebot zusätzlicher Werkzeuge verhindert diesen Weg nicht mehr. Alle Skill- und Rollenanweisungen bleiben im Prompt. Relevante Skills, die nicht vollständig in den Prompt passen, erfordern den Ladezugriff. Explizit verlangte oder vom Aufrufer als Voraussetzung markierte Werkzeuge wählen ebenfalls die Werkzeugschleife. Benötigte Informationswerkzeuge liefern ihre Ergebnisse vor abhängigen Änderungen; andere Aktionen können nach vorbereitenden Änderungen laufen, müssen aber vor dem Abschluss erfolgen. Die vorhandenen Berechtigungen entscheiden weiterhin über jeden Zugriff. Reine Katalogeinträge, Quelltext-Erwähnungen und verneinte Aufrufe gelten nicht als Aufrufauftrag.
- Für erst während der Bearbeitung erkennbare Werkzeugbedürfnisse kann das Modell mit `needs_tools: true` vor Änderungen in die vollständige Werkzeugschleife wechseln. Gemischte Werkzeuganforderungen und vorzeitige Änderungen werden verworfen. Es werden keine Werkzeuge als vermeintlich unnötig entfernt.
- Derselbe Weg ist für kleine Reparaturen verfügbar. Sie erhalten die aktuellen Dateien des vorherigen Versuchs und die fehlgeschlagenen Prüfungen. Scheitert das strukturierte Protokoll selbst, bleibt der vorhandene Rückfall zur Werkzeugschleife erhalten.
- Vorbereitete Antworten erhalten höchstens 2.048 Tokens pro Aufruf, sonstige Antworten höchstens 4.096, bei kleinem Kontext zusätzlich höchstens ein Viertel des Kontextfensters. Standardbudget pro Agentenversuch: 8.192 beziehungsweise 16.384 Tokens; explizite Agentenlimits bleiben verbindlich. Werkzeugwechsel zieht bereits verbrauchte Tokens, Schritte und Zeit ab. Vor dem Aufruf wird im Kontext Platz für die begrenzte Antwort reserviert. Zusammenfassungen werden auf 300 Zeichen begrenzt; Dateioperationen werden niemals durch Zeichenabschneiden verkürzt.
- Ein Antwortende wegen Tokenlimit oder ein Stream ohne Abschlussmarker wird vor Anwendung seiner Operationen verworfen. Ausgeschöpfte Schritte, fehlerhafte strukturierte Restoperationen oder fehlender ausdrücklicher Abschluss gelten auch nach einer Teiländerung als fehlgeschlagener Versuch. Solche Änderungen werden nicht als Erfolg integriert; eine begrenzte Reparatur kann sie im isolierten Worktree vervollständigen. Erst abgeschlossene Versuche durchlaufen die unveränderte Patch-, Projekt-, Integrations-, Review- und Freigabekette.
- Identische strukturierte Ersetzungen werden nur nach Prüfung von Schreibbereich, Leserechten und eindeutig vorhandenem aktuellen Inhalt als wirkungslos erkannt. Sie zählen nicht als Änderung. Eine vollständig empfangene Antwort mit echten Änderungen muss deshalb keine unnötige Reparatur durchlaufen; reine Identitätsoperationen ergeben weiterhin keinen Erfolg. Fehlerhafte übrige Operationen bleiben Fehler.
- Nicht ladbare Agentenanweisungen führen zum Abbruch statt zu einem Aufruf ohne diese Anweisungen. Freie Modellwahl, Claude Code, Codex, Berechtigungen, Isolation, Eskalationsgrenzen und manuelle Übernahme bleiben bestehen. Es gibt keine Sonderbehandlung bestimmter Modellnamen oder Benchmark-Aufgaben im Produktcode.

## Messmethode

[Harness](ui-execution-comparison.mjs), [Beobachtungshooks](ui-latency-hook.cjs), [Auswertung](summarize-ui-execution.mjs), [Audit](audit-ui-execution.mjs). Die Baseline ist das vor dieser Arbeit gebaute tatsächliche Backend-Bundle. Quellfingerprint `257db61e…` und Bundle-Prüfsumme `18901812…` stimmen exakt mit der vorliegenden 114,093-Sekunden-Messung überein. Das [Baseline-Archiv](ui-execution-baseline.zip) enthält Bundle, Buildmanifest und Buildlog. Der endgültige Desktop wurde vollständig neu gebaut; seine Bundle-Prüfsumme ist `87aa47faa9df97581784b330d534c089dbe105e41e3986391c890961f2b4c0f4`.

Bundle-Prüfsummen stehen je Lauf in `build.json`. Bei Baseline-Läufen beschreibt die zusätzliche Quelldatei-Inventur den inzwischen bearbeiteten Workspace; maßgeblich für den ausgeführten Stand sind die Bundle-Prüfsumme und der erste Baseline-Quellfingerprint. Der Audit bestätigt einen festen Build je Stand, identische komplette Fixtures und tatsächliche lokale Chat-/Premium-CLI-Aufrufe in Übereinstimmung mit den gemeldeten Zählern. Nach dem Benchmark ist das unveränderte endgültige Produkt-Bundle wiederhergestellt; die Beobachtungshooks sind dort nicht enthalten.

Gemessen wird der echte Electron-Weg: Projekt öffnen, Aufgabe senden, Premium-Plan anzeigen, Plan freigeben, lokale Umsetzung im Worktree, Projektprüfungen, Integration, Abschlussprüfungen, sichtbare Ergebnisfreigabe, Diff anzeigen, Übernahme per UI, erneute Tests in der Arbeitskopie. Nur der native Ordnerdialog wird automatisch beantwortet. Einrichtung erfolgt in einem separaten App-Profil; Aufgaben, Freigaben und Übernahme benutzen die UI. Die instrumentierten Funktionen werden beobachtet, nicht durch simulierte Implementierungen ersetzt.

Gesamtdauer: Klick auf „Senden“ bis zum sichtbaren Freigabeergebnis, einschließlich der fest vorgegebenen drei Sekunden Planlesezeit. App-Start, Einrichtung, anschließende Diffansicht und Übernahme liegen außerhalb dieses Endpunkts. Die unveränderten Abnahmetests werden sowohl vor der Übernahme im Integrations-Worktree als auch danach in der Arbeitskopie kontrolliert. Vor der Freigabe muss die ursprüngliche Arbeitskopie sauber sein.

Aufgaben: die ursprüngliche `slugify`-Ergänzung mit Export; eine konkrete einzeilige `clamp`-Korrektur; eine `clamp`-Reparatur mit kontrolliertem Fehler nach der ersten Modellantwort. Im letzten Fall setzt der Beobachtungshook einmal `return -999` ein, bevor die unveränderte Validierung läuft. Dieser ausschließlich im Harness aktive Fehler ist auf beiden Ständen identisch und erzwingt eine echte Reparaturrunde mit realem Modell. Zusätzliche natürliche Reparaturen werden mitgezählt. Kein Test und keine Modellantwort wird dafür simuliert.

Pro Stand wurden zwei Wiederholungen je Aufgabe ausgeführt. Die endgültige Serie lief seriell ohne parallele Plattformtests oder andere von diesem Harness gestartete Modellmessungen. Die [Laufauswahl](ui-execution-selection.json) enthält alle geplanten Läufe des endgültigen Builds, unabhängig vom Ergebnis. Rohdaten und ausgeschlossene Zwischenstände bleiben erhalten. Anfangs liefen zusätzlich Plattformtests; eine erste `clamp`-Probe traf den planungsfreien Fast Path. Zusätzliche Desktop-Klicks unterbrachen zwei frühe Messabläufe. Deren vollständiger Umsetzungserfolg und fehlende Terminalmetriken sind unbekannt, nicht null. Eine weitere Probe endete bei der Einrichtung wegen PowerShells Behandlung einer Git-Zeilenendewarnung.

Die zusätzliche Live-MCP-Prüfung fand im ersten Zwischenstand einen erfundenen Werkzeugwert. Daraus entstanden die allgemeinen Voraussetzungen für benötigte Werkzeuge und die Unterscheidung von Informationszugriffen und nachgelagerten Aktionen. Eine weitere Zwischenmessung deckte unnötige Reparaturen nach identischen Ersetzungen auf. Nach beiden Korrekturen wurden die sechs Nachher-Läufe neu mit dem festen endgültigen Build ausgeführt. Die älteren Nachher-Builds werden nicht mit diesem Ergebnis vermischt. Eine Premium-Eskalation in einem Zwischenstand bleibt in dessen Rohdaten sichtbar.

Die Serie deaktiviert den bestehenden planungsfreien Fast Path ausschließlich im isolierten Messprofil auf beiden Ständen, um ausdrücklich Premium-Planung plus lokale Ausführung zu vergleichen. Die isolierten Messfenster bleiben gerendert; native Desktop-Klicks sind dort gesperrt, während Playwright die normalen UI- und Freigabehandler bedient. Dies verändert keine Produktberechtigung oder Freigaberegel.

Lokales Modell: `qwen3:4b`, Q4_K_M, Digest `359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7`; 16.384 Kontexttokens, `think: false`, `keep_alive: 15m`, Temperatur 0,15 bei Umsetzung und 0,35 bei Reparaturen. Die Originalparameter aus `/api/show`, Modellbelegung und Ollama-Version werden je Lauf gespeichert. Im Vorher-Build wird kein `num_predict` überschrieben; danach gilt die obige Begrenzung. Seed und nicht ausdrücklich gesetzte Samplingparameter sind als effektive Werte unbekannt. Premium-Planung: Codex über vorhandene Subscription-Anmeldung mit angefordertem `gpt-6-astra`; CLI-Argumente und gemeldete Nutzung stehen im Trace. Eine unabhängige Server-Modellkennung und die Aufteilung in interne Denk- und sichtbare Ausgabetokens sind unbekannt. Modell und Premium-Plan bleiben trotz gleicher Aufgabe nicht deterministisch.

Fehlende Terminalmetriken werden als `null`/unbekannt ausgewiesen. Modellaufrufe zählen tatsächliche lokale Chat- und Premium-Inferenzaufrufe, nicht nur die pro Agentenversuch zusammengefassten Datenbankeinträge. Modellladen und Statusabfragen zählen nicht als Textgenerierung. Lokale Ausgabetokens werden separat von allen gemeldeten Ausgabetokens einschließlich Premium-Planung ausgewiesen. Reparaturen zählen erneute Agentenversuche nach fehlgeschlagener Prüfung; interne Protokollkorrekturen sind in Aufrufen und Tokens enthalten und werden nicht zusätzlich als Validierungsreparatur gezählt.

Beobachteraufwand, tatsächlicher Pixel-Präsentationszeitpunkt und Premium-Serverlatenz sind unbekannt. Die Nachher-Beobachtung prüft den Endstatus zusätzlich mit bis zu 750 ms Pollintervall; die separat protokollierten DOM- und Paint-Opportunity-Marken sind davon unabhängig. Die reale UI-Serie verwendet Codex. Live-Zeitwerte für Claude Code, andere Modelle und andere Hardware sind in dieser Serie unbekannt. Adapter- und MCP-Regressionen für beide Premium-Anbindungen sind Bestandteil der Tests. Die kleine Stichprobe erlaubt Aussagen über diese Aufgaben auf diesem Rechner, keine allgemeine Geschwindigkeitsgarantie.

## Ergebnisse und Prüfungen

[Messdaten mit Einzelwerten und Modellparametern](ui-execution-comparison.json), [Auditprotokoll](ui-execution-audit.json), [Prüfprotokoll](ui-execution-validation.json).

| Je zwei Wiederholungen vorher / nachher | Ø UI-Gesamtdauer | Ø lokale Modellzeit | Ø lokale Ausgabetokens | Modellaufrufe gesamt | Reparaturen gesamt | Erfolg |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Ursprüngliche `slugify`-Aufgabe | 221,0 → 44,8 s | 183,2 → 4,0 s | 10.475,5 → 184,5 | 7 → 4 | 1 → 0 | 2/2 → 2/2 |
| Konkrete `clamp`-Korrektur | 99,4 → 40,1 s | 66,7 → 2,8 s | 4.391,5 → 100,5 | 4 → 4 | 0 → 0 | 2/2 → 2/2 |
| Erzwungene `clamp`-Reparatur | 189,0 → 46,6 s | 148,6 → 5,7 s | 9.708 → 235,5 | 6 → 6 | 2 → 2 | 2/2 → 2/2 |

| Gesamte feste Serie, je sechs Aufgaben | Vorher | Nachher |
| --- | ---: | ---: |
| UI-Gesamtdauer, Mittel je Aufgabe | 169,8 s | 43,8 s |
| Summe der sechs UI-Gesamtdauern | 1.018,7 s | 262,9 s |
| Lokale Modellzeit, Mittel je Aufgabe | 132,8 s | 4,1 s |
| Lokale Ausgabetokens, Summe | 49.150 | 1.041 |
| Alle gemeldeten Ausgabetokens, Summe | 51.918 | 3.900 |
| Modellaufrufe, lokal + Premium | 17 (11 + 6) | 14 (8 + 6) |
| Reparaturrunden | 3 | 2 |
| Erfolgreiche vollständige UI-Aufgaben | 6/6 (100 %) | 6/6 (100 %) |

Die lokalen Ausgabetokens sinken um 97,9 %, alle gemeldeten Ausgabetokens um 92,5 %. Die erzwungenen Reparaturen bleiben absichtlich erhalten. In der endgültigen Nachher-Serie waren keine weiteren Reparaturen oder Premium-Ausführungen nötig; jeder Premium-Aufruf diente der Planung. Jetzt bestimmen vor allem Planung, Prüfungen und UI-/Jobablauf die Gesamtdauer. Die Modellqualität wird dadurch nicht allgemein garantiert; die bestehenden Reparatur-, Eskalations- und Freigaberegeln bleiben notwendig.

- **296 Engine-/API-Tests bestanden**, 8 optionale Tests übersprungen, keine Testfehler oder unbehandelten Fehler. Enthalten sind Rechte, Ressourcenlimits, beide Premium-Adapter, Git-Isolation, Patchprüfung, Abschlussvalidierung, benötigte Werkzeugzugriffe, Skill-Überlauf, abgeschnittene Ausgaben, unvollständige Versuche und geprüfte Identitätsoperationen.
- **52 Desktop-Tests bestanden**; vollständiger Desktop-Build und `pnpm typecheck` erfolgreich.
- **Zwei zusätzliche echte UI-Tests bestanden:** [Skill-/MCP-Nachweis](ui-required-tools-proof.json) mit tatsächlichem Dienstwert 7341 und befolgter Skill-Vorgabe; modellfreies Rename mit null Modellaufrufen, Freigabe, Übernahme und Undo. [UI-Testprotokoll](ui-extra-validation.txt).
- Beim älteren MCP-Test wurde ausschließlich die Annahme einer festen Kataloggröße korrigiert: Der vorhandene Katalog enthält zusätzlich das Resultat-Paging-Werkzeug. Tatsächlicher MCP-Aufruf, Serverlog, Wert 7341 und Skill-Vorgabe werden weiterhin geprüft. Die Abnahmetests aller Vergleichsfixtures sind unverändert.
- `git diff --check`, Syntaxprüfungen der Benchmark-Skripte und der Audit aller zwölf UI-Läufe erfolgreich. PowerShell klassifizierte eine Git-LF/CRLF-Warnung des Testrunners als `NativeCommandError`; die vollständige Vitest-Zusammenfassung weist 296 bestandene und null fehlgeschlagene Tests aus.

## Wiederholen

Das Baseline-Archiv kann in `.cache` entpackt werden; die vollständigen ursprünglichen Prüfsummen stehen im enthaltenen Manifest. Für einen neuen Vergleich vor der Produktänderung den Desktop bauen und `apps/desktop/dist/backend/main.cjs` als `.cache/ui-optimization-baseline.cjs` sichern; Buildmanifest und Buildlog entsprechend sichern. Danach den optimierten Desktop bauen und dessen Buildlog als `.cache/ui-latency-build.log` bereitstellen. Der Harness wählt mit `BENCH_PHASE=before|after` das jeweilige Bundle; `BENCH_SCENARIO=slug|clamp|repair` wählt die Aufgabe. Alle Aufrufe seriell ohne parallele Tests ausführen. `.cache/ui-execution.pause` stoppt neue Läufe zwischen zwei Aufgaben, ohne eine laufende Ausführung abzuschneiden. Die Baseline ist ein Benchmark-Artefakt, kein zweiter Produktimplementierungspfad.

```powershell
$env:BENCH_PHASE = 'after'
$env:BENCH_SCENARIO = 'slug'
node docs/benchmarks/ui-execution-comparison.mjs
node docs/benchmarks/summarize-ui-execution.mjs <explizite-Laufordner>
```
