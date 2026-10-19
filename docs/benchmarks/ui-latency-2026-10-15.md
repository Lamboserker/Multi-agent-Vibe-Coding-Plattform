# UI-Durchlauf und Reparaturanalyse – 15.10.2026

**114,093 s vom Senden in der echten Desktop-Oberfläche bis zur bestätigten sichtbaren Freigabeanzeige.** Ein einzelner Live-Auftrag, keine parallelen Testläufe. Der Lauf war erfolgreich; alle Projektprüfungen bestanden, keine Reparatur war erforderlich. Danach wurden Diff und Prüfungen kontrolliert, die Änderung über die Oberfläche freigegeben und die Arbeitskopie erneut geprüft.

## Messung und Buildstand

- Lauf-ID: `ui-2026-10-15T12-09-36-841Z`; Aufgabe: `cmv9hxoxz0004v2gw12jwkapl`; Ausführung: `cmv9hyc73000iv2gwa6yybrwy`.
- Senden: **14:09:43,549 MESZ**; sichtbare Freigabe bestätigt: **14:11:37,642 MESZ**. Die Rohdaten verwenden UTC und prozessübergreifende Epoch-Millisekunden.
- Reale Electron-App mit Playwright bedient. Nur die Antwort des nativen Ordnerdialogs wurde vorgegeben. Einrichtung über die reguläre Einstellungs-API; Auftrag, Planfreigabe, Diffansicht und Ergebnisfreigabe über UI-Klicks.
- Isoliertes Profil, SQLite-Datenbank, Git-Repository und Worktrees. Eigener Ollama-Port `11436`; vorhandener Modellbestand, keine Downloads. Fixture: `slugify` hinzufügen und exportieren, unveränderte Abnahmetests und 24 unbeteiligte Quelldateien wie im bisherigen Benchmark. Vollständige Vorlage in [fixture.json](ui-2026-10-15T12-09-36-841Z/fixture.json).
- Frischer erfolgreicher Build: `pnpm --filter @multi-ai-coder/desktop build`, einschließlich Engine und API vor dem Backend-Bundle. Ausgangscommit `bc1bd58475d0be331f838867c90c3bda28af40c2` **plus sämtliche vorhandenen, noch nicht committeten Optimierungen**. Deshalb ist die Commit-ID allein keine Buildkennung.
- SHA-256 des erfassten App-/Package-Quellbaums: `257db61eddce29204bafca11a15e1ff4cdc7ab1f08d06fb62c55d8a210cc67b5`. Einzeldateien, Dirty-Status und Buildartefakte: [build.json](ui-2026-10-15T12-09-36-841Z/build.json); [Buildprotokoll](ui-2026-10-15T12-09-36-841Z/build.log).
- Für Beobachtungen wurde ausschließlich das frisch erzeugte, unminifizierte Backend-Bundle um Messhüllen ergänzt. Original: `1890181239d67729cefd1e789dcc7c7fec151df69ba83a5f72cd71ae58d51654`; instrumentiert: `1b4aa74a0381e97ee0d0a010c5ff77edf44fd9585af02639217a46a5b182ffa1`. Das Original wurde nach dem Lauf wiederhergestellt. Produktquellen wurden hierfür nicht geändert.

**Separater Start:** App-Launch bis beobachteter Runtime-Bereitschaft **1,015 s**; Backend-Start bis Ready-Log **0,503 s**, darin die Migrationen der neuen Datenbank. Ollama-Start-API **3,622 s**; Beobachtungsfenster einschließlich vorheriger Statusabfrage **3,736 s**. Diese Zeiten liegen vor dem Senden und sind nicht Teil der 114,093 s. Das spätere Modell-Warmup gehört dagegen zum Auftrag und überlappt dessen Planung.

## Ablaufprotokoll

Alle Zeiten relativ zum tatsächlichen Senden-Klick. Geschachtelte oder überlappende Spannen dürfen nicht addiert werden. [Durchgängiges JSONL-Protokoll](ui-2026-10-15T12-09-36-841Z/trace.jsonl), [ausgewertete Zeitleiste und sämtliche HTTP-Anfragen](ui-2026-10-15T12-09-36-841Z/summary.json).

| Zeitpunkt / Bereich | Beobachtung |
| --- | --- |
| 0,000 s | Senden-Klick im Renderer erfasst |
| 0,002 / 0,006 s | API empfängt Session-Erstellung / Auftragsnachricht; Nachricht in 37,627 ms verarbeitet |
| 0,040 s | Planjob übernommen; Datenbank-Erstellung → Übernahme: **25 ms** |
| 0,045–0,364 s | Planungskontext aufbereitet: **319,207 ms**, darin Digest-Erstellung 68,917 ms |
| 1,958–7,160 s | Lokales Modell geladen: **5,201 s**, parallel zur Planung |
| 1,961–26,439 s | Echter Codex-Planungsaufruf: **24,478 s** |
| 27,003 s | Planansicht und lokale Modellzuordnung geprüft; Screenshot gespeichert |
| 30,084 s | Plan über „Ausführung starten“ freigegeben; Planansicht → Klick **3,081 s**, darin 3 s bewusste Prüfzeit |
| 30,085 s | Execute-API empfangen; Verarbeitung **65,173 ms** |
| 30,154 s | Ausführungsjob übernommen; Warteschlange **5 ms** |
| 30,947–31,032 s | Ausführungskontext: Digest **52,922 ms**, Dateivorladung **20,478 ms** |
| 31,033–105,567 s | Ein lokaler Modellaufruf: **74,534 s** |
| 105,567–105,573 s | `write_file src/slug.mjs` **2,173 ms**; `edit_file src/index.mjs` **1,892 ms**; `finish` **0,288 ms**; alle erfolgreich |
| 106,037–109,075 s | Aufgabenprüfungen: Syntaxcheck **2,071 s**, Test **0,964 s**, beide bestanden |
| 109,128–109,264 s | Integration per Cherry-pick **135,243 ms**; Patch-Prüfungen und Git-Kommandos separat im JSONL |
| 109,646–112,618 s | Endprüfungen im Integrations-Worktree: Syntaxcheck **2,001 s**, Test **0,969 s**, beide bestanden |
| 112,831 s | Deterministisches Review bestanden; bestehende `risk_based`-Politik verlangt bei diesem geringen Risiko kein Premium-Review |
| 112,834 / 112,849 s | Backend meldet freigabebereit / sendet abschließende Chatnachricht und Abschlussereignis |
| 112,852 s | Electron Main leitet das Ereignispaket an den Renderer weiter |
| 113,667 / 113,750 s | Freigabekarte im DOM / zweite Animationsframe-Gelegenheit zur Darstellung |
| **114,093 s** | Freigabetext und Übernehmen-Schaltfläche als sichtbar bestätigt; [Screenshot](ui-2026-10-15T12-09-36-841Z/03-ready.png) |
| 114,297–116,180 s | Nach Messende: UI-Freigabe in Arbeitskopie, erneuter Test und Syntaxcheck bestanden |

Ausgeführt wurden drei Modellwerkzeuge. Die Antwort enthielt sechs generierte Werkzeugaufrufe; drei nach dem erfolgreichen `finish` wurden gemäß regulärer Engine-Semantik nicht ausgeführt. Es gab **0 fehlgeschlagene Prüfungen und 0 Reparaturrunden** im Live-Lauf. [Ausführungsdetail](ui-2026-10-15T12-09-36-841Z/execution.json), [Diff](ui-2026-10-15T12-09-36-841Z/result.diff), [Test nach Übernahme](ui-2026-10-15T12-09-36-841Z/post-apply-tests.txt).

## Modellaufrufe und Zeitanteile

| Aufruf | Modellkennung und Einstellungen | Tokens Eingang / Ausgang | Dauer |
| --- | --- | ---: | ---: |
| Planung | Codex CLI `-m gpt-6-astra`, Effort `low`, Schema, read-only, ephemeral; Abonnement, kein Fallback beobachtet | 15.320 / 547; Cache 0 | 24.478 ms Hülle; 24.385 ms CLI-Prozess |
| Lokale Ausführung | Serverantwort `qwen3:4b`; Q4_K_M; Kontext 16.384, Temperatur 0,15, `think=false`, keep-alive 15 min, Tools-Modus; keine explizite Seed-/Ausgabelängenbegrenzung | 3.934 / 4.605 | 74.534 ms Client; 74.531 ms Server |

Der lokale Digest lautet `359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7`. [Runtime-Snapshot](ui-2026-10-15T12-09-36-841Z/ollama-runtime.json): Ollama 0.30.10, Modell vollständig im VRAM, tatsächlich 16.384 Kontexttokens. Modellparameter laut lokalem Manifest: `top_k=20`, `top_p=0.95`, `repeat_penalty=1`; die Modelltemperatur 0,6 wird vom Request auf 0,15 überschrieben. [Parameterdatei](ui-2026-10-15T12-09-36-841Z/model-default-parameters.json).

Ollama zerlegt die lokale Serverzeit in **144,284 ms Laden**, **1.255,370 ms Kontextverarbeitung**, **73.118,326 ms Dekodierung** und **13,360 ms Rest**. Damit entfallen rund **98,1 %** der Serverzeit auf Tokenerzeugung. Erstes Content-Stück nach 1,416 s; Content bis 66,241 s, Werkzeugausgabe zwischen 67,251 und 74,500 s nach Aufrufbeginn. Die eigentliche Werkzeugausführung danach benötigt zusammen nur **4,353 ms**.

Es erschien kein separates `thinking`-Feld. Allerdings entstanden 16.253 Zeichen Content mit ausführlicher Erläuterung vor den Werkzeugen. Deshalb bedeutet `think=false` hier **keine separat gemeldete Thinking-Phase**, keinesfalls nachgewiesene Abwesenheit jeglicher Überlegungen. GPU-Zeit für solche Erläuterungen und nützliche Ausgabe lässt sich nicht getrennt angeben. Die reale App stellt zusätzlich `load_skill`/`read_skill_file` bereit; deshalb greift hier vom ersten Aufruf an der Tools-Modus. Der frühere Engine-Benchmark hatte diese App-Werkzeuge nicht und begann strukturiert. Die 114,1 s sind kein direkter Vorher-/Nachher-Vergleich zu dessen 157,7 s.

## Die beiden historischen Feature-Reparaturen

[Auswertung mit vollständigen Testfehlern](feature-repair-analysis-2026-10-15.json), [Originalantworten Lauf 0](historical-feature-0-responses.jsonl), [Lauf 1](historical-feature-1-responses.jsonl). Zuordnung über `.cache/task-latency-after-release.json`, Artefaktpfade und passende Token-/Zeitwerte; Quellen mit SHA-256 gesichert.

**Konkreter Erstfehler in beiden Läufen:** `src/index.mjs` exportiert aus `'./slug'`, obwohl die Datei `slug.mjs` heißt. Node bricht mit `ERR_MODULE_NOT_FOUND` ab, bevor die Assertions laufen. Der als „typecheck“ bezeichnete Fixture-Check prüft nur Syntax und erkennt den Importfehler nicht. Zusätzlich fehlt das Entfernen äußerer Bindestriche: Nach alleiniger Importkorrektur liefert `' Hello, WORLD! '` den Wert `'hello-world-'`. Beides wurde nach dem UI-Lauf offline mit den gespeicherten Operationen und unveränderten Tests reproduziert: Original fehlgeschlagen, nur Import korrigiert fehlgeschlagen, beide Fehler korrigiert bestanden. [Reproduktionsprotokoll](feature-failure-reproduction-2026-10-15.json).

| Messgröße | Feature 0 | Feature 1 |
| --- | ---: | ---: |
| Strukturierte Erstantwort, Agentenzeit | 2.865 ms | 2.733 ms |
| Reparatur, gesamte Agentenzeit | **142.359 ms** | **143.429 ms** |
| Reparatur einschließlich Prüfungen/Versuchsabschluss | 146.162 ms | 146.971 ms |
| Darin Syntaxcheck + Test | 3.217 ms | 3.008 ms |
| Rest außerhalb Agent und Prüfungen, u. a. Git/Patch/Integration | 586 ms | 534 ms |
| Reparatur-HTTP-Antworten | 1 | 2 |
| Erhaltene Ollama-Serverzeit | 142.351 ms | nur zweite Antwort: 47.455 ms |
| Erhaltene Eingangs-/Ausgangstokens | 4.072 / 9.284 | nur zweite Antwort: 10.596 / 2.723 |

Feature 0: Der Server meldet 143 ms Laden; die übrigen **142.208 ms** enthalten Kontextverarbeitung, Generierung und internen Rest. Die gesamte Antwort enthält 36.091 Content-Zeichen, keine separate Thinking-Ausgabe, zwei Dateireparaturen und `finish`. Gegenüber der Serverzeit verbleiben lediglich 8 ms Agenten-Wandzeit; das ist ein gemischter Rest verschiedener Messgrenzen, **keine exakte Werkzeugzeit**.

Feature 1: Die erste Reparaturantwort enthält **26.880 Content-Zeichen**, aber **keine verwertbaren terminalen Zeit-/Tokenwerte**. Die bisher gespeicherten Nullen bedeuten daher fehlende Messung. Erst die zweite Antwort enthält 47.455 ms Serverzeit, darin 153 ms Laden, sowie 2.723 Ausgabetokens und 8.235 Content-Zeichen. **95.974 ms** der Agentenzeit liegen außerhalb dieser erhaltenen Serverzeit; sie umfassen insbesondere die erste Antwort und Client-/Schleifenaufwand. Dieser Rest darf weder vollständig als Thinking noch als Kontextzeit bezeichnet werden. Die nominellen 2.723 Tokens unterschätzen die Gesamtausgabe dieser Reparatur.

## Messlücken und Einordnung

- Historisch fehlen `prompt_eval_duration`, `eval_duration`, Chunk-Zeitstempel und Werkzeug-Einzeldauern. Kontext, Überlegungen im Content und eigentliche Ausgabe sind rückwirkend nicht exakt trennbar. Auch Sampling-Einstellungen und zurückgemeldete Modellkennung wurden nicht je Antwort archiviert; `qwen3:4b` ist dort die angeforderte Serienkennung. Warum Feature 1 terminale Werte fehlen, ist ohne ursprünglichen HTTP-Stream nicht beweisbar.
- Im Live-Lauf ist der UI-Klick → HTTP-Empfang gemessen; Renderer-Handler, Preload-IPC, Main-Bridge und Loopback-Transport sind darin zusammengefasst. Main-Ereignisweitergabe und sichtbare Endanzeige haben eigene Zeitmarken. Ein echter Compositor-/Pixel-Present-Zeitstempel fehlt; DOM, Animationsframes, Sichtbarkeitsprüfung und Screenshot grenzen die Anzeige ein.
- Die CLI liefert Tokenzahlen und Aufrufdauer, aber keine getrennten Premium-Prefill-/Thinking-/Ausgabezeiten. `gpt-6-astra` ist durch CLI-Argument und Adapter-Metadaten belegt; eine unabhängige serverseitige Modellattestierung enthält ihr Ereignisstrom nicht.
- Messhüllen schreiben synchron JSONL und lesen den Ollama-Stream zusätzlich. Ihr Overhead wurde nicht separat gegen einen uninstrumentierten Kontrolllauf gemessen. Ein Live-Sample erlaubt keine p50-/p95-Aussage.
- Zwei vorherige reine Einrichtungsläufe endeten **vor dem Senden**: falscher Modellordner, anschließend fehlendes `require` im Playwright-Main-Kontext. Ihre Protokolle bleiben in den beiden früheren `ui-*`-Ordnern erhalten. Es wurde nur ein Coding-Auftrag abgesendet und inferiert.
- Die PowerShell-Umleitung meldete beim Aufruf Exit 1 trotz abgeschlossener Gates und ohne `run.error`. Ein separater Minimaltest reproduzierte das mit einer erfolgreichen Node-Ausgabe auf stderr; explizites `exit $LASTEXITCODE` liefert 0. Runtime-Shutdown meldet ebenfalls Code 0. Diese Shell-Anomalie wird nicht als fehlgeschlagener Projekttest gezählt.

Die lange Wartezeit liegt im beobachteten Live-Lauf bei der lokalen Textgenerierung, nicht bei Jobwarteschlange oder Dateizugriffen. Die alten Reparaturen kombinieren dieselbe ausführliche Content-Erzeugung mit dem Wechsel vom strukturierten Erstversuch zur Werkzeugschleife; Lauf 1 hat zusätzlich eine wesentliche Telemetrielücke. Ein sinnvoller nächster Optimierungsversuch wäre, die Ausgabeform bei einfachen Reparaturen zu begrenzen und dabei sämtliche bestehenden Prüf- und Freigabegates beizubehalten. Hier wurden keine weiteren Laufzeitoptimierungen vorgenommen.

## Wiederholung

Im Repository zuerst den Desktop vollständig bauen, danach **einen** Recorder starten:

```powershell
pnpm --filter @multi-ai-coder/desktop build *> .cache/ui-latency-build.log
if ($LASTEXITCODE -ne 0) { throw 'Build fehlgeschlagen' }
node docs/benchmarks/ui-latency.mjs *> .cache/ui-latency-run.log
$runExit = $LASTEXITCODE
exit $runExit
```

Danach `node docs/benchmarks/summarize-ui-latency.mjs docs/benchmarks/<neue-Lauf-ID>`. Vorhandene Abonnementanmeldung und lokales `qwen3:4b` im Standardmodellordner werden benötigt. Aufzeichnungsquellen: [Recorder](ui-latency.mjs), [Messhüllen](ui-latency-hook.cjs), [historische Analyse](analyze-feature-latency.mjs). Die beim gemessenen Lauf verwendeten Recorderdateien sind zusätzlich unverändert in dessen Artefaktordner gesichert. Ein manueller UI-Schritt ist für diese Aufzeichnung nicht erforderlich.
