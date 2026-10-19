# Kurzauswertung – 15.10.2026

**114,1 Sekunden vom UI-Senden bis zum sichtbar geprüften, freigabebereiten Ergebnis.** Lauf-ID: `ui-2026-10-15T12-09-36-841Z`. Ein realer Coding-Auftrag über die Electron-Oberfläche, isoliertes Repository/Profil, keine parallelen Testläufe. Die neu gebaute App enthielt die vorhandenen Optimierungen; Commit, Quell- und Bundle-Hashes sind dokumentiert.

Die Aufgabe ergänzt und exportiert `slugify`, mit unveränderten Abnahmetests. Codex plant mit `gpt-6-astra` in 24,5 s; die Planansicht bis zum Freigabeklick beansprucht 3,1 s. Die lokale Ausführung mit `qwen3:4b` dauert 74,5 s: 0,144 s Laden, 1,255 s Kontextverarbeitung, 73,118 s Tokenerzeugung. Die drei Werkzeuge benötigen zusammen 4,35 ms. Warteschlangen: 25 ms für Planung, 5 ms für Ausführung. Aufgaben- und Endprüfungen bestehen; keine Reparatur nötig. Nach Messende wurden Diff und Ergebnis über die UI freigegeben und die Arbeitskopie erneut erfolgreich geprüft.

Start separat: App bis Runtime-Bereitschaft 1,015 s, darin Backend 0,503 s; Ollama-Start-API 3,622 s. Modell-Warmup während der Planung: 5,201 s, im Auftragsintervall enthalten.

Die historischen Feature-Läufe scheitern beide an `export ... from './slug'` ohne `.mjs`. Zusätzlich fehlt das Entfernen äußerer Bindestriche. Beide Fehler sind offline reproduziert. Reparatur-Agentenzeit: **142,359 / 143,429 s**. Lauf 0 enthält 142,351 s Serverzeit. Bei Lauf 1 fehlen die Abschlusswerte der ersten Reparaturantwort: 26.880 Zeichen Ausgabe sind vorhanden, Zeit und Tokens unbekannt; rund **95,974 s** verbleiben außerhalb der erhaltenen zweiten Serverzeit. Die gemeldeten 2.723 Ausgabetokens umfassen nur die zweite Antwort.

**Messlücken:** Historische Kontext-/Thinking-/Ausgabezeiten und Werkzeugdauern sind nicht rekonstruierbar. Im Live-Lauf fehlen eine getrennte Premium-Zerlegung und ein echter Pixel-Present-Zeitstempel. `think=false` verhindert hier keine ausführlichen Überlegungen im Content; deren Dekodierzeit lässt sich nicht separat bestimmen. Messinstrumentierungs-Overhead wurde nicht isoliert gemessen. Es ist eine Einzelmessung.

[Detaillierter Ablauf, Modellparameter und historische Analyse](ui-latency-2026-10-15.md) · [durchgängiges Rohprotokoll](ui-2026-10-15T12-09-36-841Z/trace.jsonl) · [Buildstand](ui-2026-10-15T12-09-36-841Z/build.json) · [sichtbares Ergebnis](ui-2026-10-15T12-09-36-841Z/03-ready.png).
