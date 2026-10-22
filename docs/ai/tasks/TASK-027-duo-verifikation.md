---
id: TASK-027
titel: Gesamtverifikation Duo/Hardware/Lokal
status: in-arbeit   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-21
phase: 9
plan: plans/2026-10-21-duo-hardware-lokal.md
---

# TASK-027: Gesamtverifikation Duo/Hardware/Lokal

## Ziel
Siehe Abschnitt TASK-027 im Plan `plans/2026-10-21-duo-hardware-lokal.md`.

## Akzeptanzkriterien
- [x] Umsetzung laut Plan + Review-Fixes
- [x] Tests grün (engine 434, api 260, desktop 107)

## Log

## Übergabe
- 2026-10-21: Abschluss-Review (`experte`, read-only). Build, typecheck, lint und Tests grün (engine 423, api 254,
  desktop 107).
  - Blocker B1: `againstBaseline` lässt bei roter Baseline neue Typecheck-Fehler durch. Gründe: Signatur nur
    20 Zeilen, Ziffern in Dateinamen entfernt, `errorCount` ignoriert.
  - Nicht blockierend:
    - Eine explizite Einzelwahl wird auf die andere CLI umgeleitet.
    - Die Reihenfolge der Signaturzeilen zählt.
    - Fehlender Runner (Playwright) ohne eigene Einstufung.
    - Das Entladen kennt keine Eskalationsmodelle anderer Läufe.
    - Ein gesperrter Duo-Partner wird erneut aufgerufen.
    - `cancelled` im Duo nutzt die andere Seite.
    - Fragen setzen den Orchestrator des Tasks.
- 2026-10-21: Behebung delegiert (`experte`): B1 plus die Punkte 1, 2, 3, 4, 5, 7, 8.
- 2026-10-21: Fixes erledigt.
  - B1: `failureLines` (volle, sortierte Menge) plus Teilmengen-Regel plus `errorCount`. Das Repro blockiert jetzt.
  - Explizite Einzelwahl ohne Fallback auf die andere CLI.
  - Duo: Sperre pro Seite; `cancelled` wird weitergereicht.
  - Fragen nutzen `askOrchestrator`.
  - Entladen wartet auf Warm-ups und kennt Eskalationsmodelle; der Monitor zeigt laufende Agent-Runs.
  - Ergebnis: engine 434, api 260, desktop 107, typecheck und lint grün.

## Übergabe
Offen, nur mit dem Nutzer:
1. `pnpm dev` neu starten (Lesson 14).
2. Sichtprüfung:
   - Hardware-Popover: Live-Label, Status, Entladen, VRAM-Aufteilung, andere Instanz.
   - Composer-Seg „Claude | Codex | Beide".
   - Duo-Einstellungen.
   - Duo-Karten im Chat.
   - Verbrauch je Anbieter.
3. Live-Test Duo nur mit Zustimmung (≈2–3× Kontingent pro Phase).
4. (erledigt: Premium-Hinweis auch ohne Premium-Ausführung)
- Bekannte Kosmetik:
  - Doppelte Meldung „nicht angemeldet" + „Kein Orchestrator verbunden".
  - `orchestrator_unavailable` nennt die Setting-CLI.
  - UsageScreen ohne `byProvider`.
- 2026-10-21: Nutzer sagt „ja" zum Premium-Hinweis ohne Premium-Ausführung.
  - `chainFor`: Fällt der Premium-Schritt wegen `premiumExecutionAllowed=false` oder Agent `escalation: 'local'`
    weg, beendet die Hinweis-Runde die Kette. `escalation: 'none'` bleibt ohne Hinweis.
  - 2 neue Tests; engine 436 grün, typecheck und lint grün.
  - Settings-Text angepasst.
  - `pnpm dev` lief seit 15:44 mit aktuellem Code; die Engine-Änderung von 15:50 braucht einen Neustart.
