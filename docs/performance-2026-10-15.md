# Zeit bis zur geprüften Codeänderung – 15. Oktober 2026

Die Optimierung ist umgesetzt. Im gepaarten Test mit echtem Codex-Planer, kaltem lokalem Modell, Git-Worktrees und Prüfungen vor und nach der Integration sank die Zeit von **119,2 auf 26,1 Sekunden (78 %)**. Das ist eine einzelne Paarmessung, keine allgemeine Geschwindigkeitsgarantie.

Die [Messdaten](benchmarks/task-latency-2026-10-15.json) enthalten auch Versuche, Tokenzahlen, Prüfergebnisse und Stichprobengrößen. Der [Benchmark](../packages/engine/bench/task-latency.mjs) verwendet echte Modellaufrufe und ausführbare Abnahmetests.

## Tatsächlich getestete Umgebung

- RTX 4060 Ti, 16.380 MiB VRAM; Ryzen 7 5800X, 8 Kerne/16 Threads; 32 GiB DDR4, konfigurierte Taktrate 3.600 MHz.
- Windows 11 Pro, Node 24.14.1, Ollama 0.30.10, CUDA; vorhandenes `qwen3:4b`, Q4_K_M, Modell-ID `359d7dd4bcda`. Laut Ollama vollständig auf der GPU, 16.384 Kontexttokens.
- Bereits konfigurierte Ollama-Einstellungen: `OLLAMA_NUM_PARALLEL=1`, Flash Attention, KV-Cache `q8_0`. Diese wurden nicht geändert.
- Codex CLI 0.153.4 und Claude Code 2.1.86 mit vorhandenen Abonnement-Anmeldungen. Keine Modellinstallation, kein Training und kein neuer Dienst waren erforderlich.

**Schwächere Hardware wurde nicht physisch getestet.** 8-GiB-RAM-Rechner ohne GPU und 4-GiB-GPUs wurden in den Speicherpolitik-Tests simuliert. Deren Inferenzgeschwindigkeit ist nicht gemessen; Speicherentscheidungen bleiben Schätzungen.

## Ursachen und Änderungen

1. **Zu viel Planungskontext.** Die bisherige Vorbereitung füllte den Kontext auch mit unpassendem Quellcode. Jetzt werden genannte Dateien, starke Relevanztreffer, Importbeziehungen und Build-Manifeste bevorzugt. Normale Planung erhält bis zu 6.000, breite Architektur-/Migrationsaufgaben bis zu 10.000 geschätzte Tokens. Gezielt erforderliche weitere Dateien können beide Planer weiterhin lesen. Kleine zusammengehörige Änderungen sollen einschließlich ihrer Tests in einer Aufgabe bleiben.
2. **Teure lokale Werkzeugschleifen.** Selbst die einzeilige Korrektur erzeugte zuvor rund 4.800 Ausgabetokens. Kleine Aufgaben mit höchstens drei vollständig bereitgestellten Zieldateien können nun eine strukturierte Erstantwort liefern. Unvollständiger Kontext, zusätzliche Werkzeuge, kritische Dateien und höhere Komplexität behalten die Werkzeugschleife. Fehlgeschlagene Projektprüfungen führen zur Werkzeugschleife für Reparaturen. Ein explizit fehlgeschlagener strukturierter Modell-Selbsttest verhindert diese automatische Auswahl.
3. **Doppelte Werkzeugaufrufe.** XML-Aufrufe innerhalb von Markdown-Codeblöcken konnten doppelt zurückgewonnen werden. Das fügte beispielsweise Imports zweimal ein. Der Parser verarbeitet solche verschachtelten Darstellungen jetzt einmal und ignoriert Beispiele vor einem abgeschlossenen Denkblock. Ein erfolgreicher `finish` beendet seine Aufrufgruppe. Identische Ersetzungen gelten als Eingabefehler.
4. **Wachsende und veraltete Kontexte.** Vor jedem lokalen Aufruf wird Platz für die Antwort reserviert. Bei Bedarf werden alte vollständige Werkzeugrunden entfernt, während Auftrag und letzte Runde erhalten bleiben. Bereitgestellte Dateien werden dabei neu gelesen. Strukturierte Wiederholungen sehen bereits erfolgreich angewendete Operationen; Teilinhalte werden als solche gekennzeichnet. Unpassend große Anweisungen werden vor dem Modellaufruf abgelehnt.
5. **Speicherdruck und Modellwechsel.** Warmup, Ausführung und automatische Slot-Berechnung verwenden eine gemeinsame Schätzung einschließlich Kontext/KV-Cache und Laufzeitaufwand. Gleichzeitige Warmups reservieren Speicher, statt jeweils vom gleichen freien Speicher auszugehen. Auf CPU-Systemen wird der automatisch bestimmte Kontext zusätzlich begrenzt. Bei mehreren Rollen wird vor der Planung kein möglicherweise falsches Modell spekulativ geladen. Der Scheduler berücksichtigt das zuletzt gestartete lokale Modell auch zwischen seriellen Aufgaben. Bei gleicher nachgewiesener Zuverlässigkeit entscheidet die gemessene Zeit pro validiertem Ergebnis über die Modellreihenfolge.
6. **Abschlussprüfung.** Ein bestandener Patch-Check allein genügte bisher für den Status `awaiting_approval`, selbst wenn die abschließenden Projektprüfungen fehlschlugen. Jetzt muss auch die abschließende Validierung erfolgreich sein. Prüfungen, Isolation, Berechtigungen, Review-Politik und Freigabe vor Übernahme bleiben erhalten.

Installation und Auswahl beliebiger lokaler Modelle sowie Claude-/Codex-Anbindungen bleiben bestehen. Speicherpolitik und Ausführungsstrategie enthalten keine Modellnamen. Größere Modelle mit partieller CPU-Auslagerung bleiben auswählbar.

## Vergleichbare Messungen

Baseline: unveränderte Engine aus Commit `bc1bd58`, vor den Änderungen gebaut und separat aufbewahrt. Alle Aufgaben beginnen mit derselben Repository-Vorlage, unveränderten Abnahmetests und 24 unbeteiligten Quelldateien. Lokale Inferenzmessreihen wurden seriell ausgeführt. Die Modelle waren für die folgende Tabelle bereits geladen.

| Aufgabe bis zur finalen Prüfung | Vorher, Mittelwert | Nachher, Mittelwert | Zeitersparnis | Erfolgreiche Aufgaben vorher / nachher |
| --- | ---: | ---: | ---: | --- |
| Fehler in `clamp` korrigieren | 82,8 s | 10,7 s | 87 % | 2/2 / 2/2 |
| `slugify` ergänzen und exportieren | 263,0 s | 157,7 s | 40 % | 1/1 / 2/2 |
| Gemeinsamen Steuer-Helfer über drei Dateien einführen | 176,6 s | 12,0 s | 93 % | 1/1 / 2/2 |

Mit gleicher Gewichtung der drei Aufgabentypen: **174,2 → 60,1 Sekunden, rund 65 % weniger Zeit**. Die Stichprobe ist klein und vor/nach unterschiedlich groß; die Einzelmessungen sind deshalb mitgeliefert. Reparaturen und fehlgeschlagene Versuche innerhalb einer abgeschlossenen Aufgabe sind vollständig enthalten. Insbesondere wurde der langsame `slugify`-Reparaturfall nicht ausgeblendet. Die geprüfte letzte Messreihe besteht **6/6 Aufgaben**; explorative Zwischenstände hatten Fehler, die zu den Parser- und Reparaturkorrekturen führten.

Die Fixtures sind JavaScript: ausgeführt werden Syntaxprüfungen und `node:test`, jeweils in Aufgaben- und Integrations-Worktree. Die Tests prüfen Grenzen und Innenwerte, Leer-/Sonderzeichen einschließlich Unterstrichen sowie erhaltenes Verhalten beim Refactoring. Eine Aufgabe zählt nur mit bestandener finaler Prüfung, unveränderten Abnahmetests und sauberer ursprünglicher Arbeitskopie als erfolgreich. TypeScript-Prüfungen der Plattform werden separat ausgeführt.

| Premium-Planung, je sechs reale Aufrufe | Vorher, Median | Nachher, Median | Veränderung |
| --- | ---: | ---: | ---: |
| Claude Code | 15,95 s | 13,65 s | 14 % kürzer |
| Codex | 18,16 s | 17,38 s | 4 % kürzer |

Die geschätzten Digest-Größen sanken von 8.560–9.373 auf 237–304 Tokens. Die tatsächlich gemeldeten durchschnittlichen Eingabetokens sanken bei Claude von 36.613 auf 9.910 und bei Codex von 25.800 auf 14.947. CLI-/Systemkontext ist darin enthalten. Alle 24 Planungsaufrufe lieferten Aufgaben mit Beschreibung und Abnahmekriterien; diese separate Reihe prüft die Planstruktur, nicht die spätere Implementierung. Die dortigen CLI-Standardmodelle und deren bestehender automatischer Fallback wurden beibehalten; die genaue zurückgegebene Modellkennung wurde in dieser Reihe nicht protokolliert. Besonders der kleine Codex-Zeitunterschied lässt keine belastbare Verallgemeinerung zu.

Der zusätzliche vollständige Paarvergleich verwendet ausdrücklich dasselbe kataloggestützte Codex-Modell `gpt-6-astra`, dieselbe Fehlerkorrektur und ein jeweils entladenes lokales Modell:

| Gesamte Engine-Kette | Vorher | Nachher |
| --- | ---: | ---: |
| Kontext → Premium-Planung → lokale Änderung → Prüfungen → Integration → Prüfungen | 119,194 s | 26,052 s |

Beide Aufgaben wurden beim ersten Implementierungsversuch erfolgreich validiert. Der Modell-Ladevorgang ist enthalten. Das ist die automatisierte Zeit bis zum freigabebereiten Ergebnis; Installation, Serverstart, UI-/Jobwarteschlange und menschliche Freigabezeit werden nicht gemessen. Der Benchmark ruft den Premium-Planer ausdrücklich auf; die Anwendung darf für geeignete Aufgaben weiterhin ihren vorhandenen Fast Path verwenden.

Bei einer zusätzlichen Verbindungsprobe lehnte die Codex-CLI das in der Benutzerkonfiguration genannte Modell ab. Die Benutzerkonfiguration wurde nicht geändert. Der Paarvergleich verwendet deshalb auf beiden Seiten dieselbe vom CLI-Katalog angebotene Modellkennung. Eine überlappende frühere Kaltstartprobe wurde verworfen, weil ein anderer Test das Modell zwischenzeitlich wieder geladen hatte. Ein anfänglicher LF-/CRLF-Vergleichsfehler im Harness wurde nach Kontrolle der unveränderten Testdateien korrigiert; seine Zeitmessungen blieben unverändert.

## Prüfergebnisse

- Engine und API: **279 bestanden, 8 optionale Tests übersprungen, keine Fehler**. Enthalten sind echte Git-/Validierungs-Integrationstests sowie Regressionen für verschachtelte Werkzeugaufrufe, `finish`, Reparatur-Fallback, aktuelle Dateiinhalte, Kontextbegrenzung, Warmup-Reservierungen, Scheduling und fehlgeschlagene Endprüfungen.
- Desktop: **52 Tests bestanden**.
- `pnpm typecheck`: alle Workspace-Pakete erfolgreich.
- `pnpm --filter @multi-ai-coder/desktop build`: vollständiger Desktop-Build erfolgreich.
- `git diff --check` und Syntaxprüfung des Benchmark-Skripts: erfolgreich.

## Wiederholen und Grenzen

```powershell
pnpm --filter @multi-ai-coder/engine build
node packages/engine/bench/task-latency.mjs --model <installiertes-modell> --planner none --repeats 2 --label local
node packages/engine/bench/task-latency.mjs --model <installiertes-modell> --planner claude-code --plan-only true --repeats 2 --label planning
node packages/engine/bench/task-latency.mjs --model <installiertes-modell> --planner codex --planner-model <unterstütztes-cli-modell> --scenario fix --cold true --label end-to-end
```

`--engine <pfad-zur-baseline/dist/index.js>` verwendet eine separat gebaute Baseline. Ergebnisse stehen standardmäßig unter `.cache/task-latency-<label>.json`; temporäre Repositories bleiben zur Prüfung erhalten. Keine zwei lokalen Inferenzmessungen gleichzeitig starten. Die Tests benötigen vorhandene Modelle und bei Premium-Planung eine bestehende CLI-Anmeldung.

Das getestete Modell erzeugt in Werkzeugrunden trotz angefordertem `think: false` teilweise sehr lange Antworten. Dieser [Ollama-API-Schalter](https://ollama.com/blog/thinking) wird bereits verwendet; sein tatsächlicher Effekt hängt auch von Modell und Template ab. Eine schnelle strukturierte Antwort ersetzt keine semantische Prüfung. Schlechte oder sehr kleine Modelle, komplexe Aufgaben, große Kontexte, CPU-Auslagerung und langsame Projektprüfungen können weiterhin dominieren. Die Speicherformel ist eine konservative Heuristik, keine architekturspezifische VRAM-Garantie. Andere Hardware, Modelle und große reale Kundenprojekte benötigen eigene Messreihen; dafür liefert diese Änderung den reproduzierbaren Harness.
