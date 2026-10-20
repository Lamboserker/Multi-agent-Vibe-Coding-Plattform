---
description: Arbeit am aktiven Task aus docs/ai fortsetzen (nach /clear oder in neuer Session)
argument-hint: "[optional: TASK-NNN oder Hinweis]"
---

Setze die Arbeit fort, ohne den alten Chatverlauf zu brauchen. Du bist der **Hauptagent**: du planst, delegierst,
prüfst und dokumentierst. Ein Durchlauf = **eine Phase (ein Task-File)**.

## 1. Einlesen
1. `docs/ai/CONTEXT.md` und `docs/ai/lessons.md` lesen.
2. Aktives Task-File aus CONTEXT.md vollständig lesen (bei Argument mit Task-ID stattdessen diesen Task). Masterplan
   `docs/ai/plans/2026-10-20-orchestrierung.md` und ADRs nur öffnen, wenn das Task-File darauf verweist und Details fehlen.
3. `git status` und `git log --oneline -5`: entspricht der Code dem Stand in `## Übergabe`? Fremde Änderungen (Codex
   teilt die Arbeitskopie) nicht überschreiben, sondern melden.
4. In 3–5 Zeilen zusammenfassen: Ziel, erledigt, Schritte dieses Durchlaufs. Status im Task-File auf `in-arbeit`.

## 2. Delegieren (Subagents aus `.claude/agents/`)
| Arbeit | Subagent | Modell |
|---|---|---|
| Dateien, Symbole, Aufrufer, Texte finden; Datei zusammenfassen | `sucher` | Haiku |
| klar spezifizierter Schritt mit bekannten Dateien; Tests schreiben/anpassen; Tests/Typecheck laufen lassen | `entwickler` | Sonnet |
| modulübergreifende Änderung, Schema/Migration, unklare Ursache, Designentscheidung; **Abschluss-Review jeder Phase** | `experte` | Opus |

- Jeder Auftrag an einen Subagent ist selbsttragend: Task-ID, exakte Dateien (`pfad:zeile`), gewünschte Änderung,
  Akzeptanzkriterium, Testbefehl. Subagents kennen den Chat nicht.
- Unabhängige Suchen parallel starten. Schreibende Subagents **nacheinander**, nie zwei gleichzeitig auf denselben Dateien.
- Kleinigkeiten (eine Zeile, ein Wort) selbst erledigen statt delegieren.
- Ergebnisse der Subagents nicht blind übernehmen: Diff ansehen und Tests selbst bestätigen.

## 3. Dokumentieren (gewissenhaft, laufend – nicht erst am Ende)
- Nach **jedem** abgeschlossenen Schritt im Task-File unter `## Log` datiert festhalten: was geändert wurde (`pfad:zeile`),
  Entscheidungen + Begründung, verworfene Ansätze + warum, ausgeführte Tests mit Ergebnis, welcher Subagent beteiligt war.
- Erfüllte Akzeptanzkriterien erst abhaken, wenn ein Test oder eine Prüfung es belegt.
- Nur der Hauptagent schreibt in `docs/ai/`.
- Neue projektweite Entscheidung → ADR in `docs/ai/decisions/`. Wiederholter Fehler → Regel in `docs/ai/lessons.md`.

## 4. Phase abschließen
1. `experte` reviewt den Diff gegen die Akzeptanzkriterien; Mängel beheben (lassen).
2. Relevante Tests + `pnpm typecheck` grün (Ausgabe im Log zusammenfassen).
3. Dann wie `/handoff done`: `## Ergebnis`, `## Übergabe`, Status `done`, Task nach `docs/ai/tasks/done/`, AI-Log-Eintrag
   mit ehrlicher Note, CONTEXT.md auf die nächste Phase setzen.
4. Kurz berichten und **stoppen** – nächste Phase erst nach `/clear` + `/weiter`. Commit nur, wenn der Nutzer es verlangt.

## Grenzen
- Keine Live-Aufrufe von `claude`/`codex` (Planung, Ausführung, Diagnose) ohne ausdrückliche Zustimmung.
- Wird der Kontext knapp: sofort `/handoff`-Schritte ausführen, dann melden.

Zusatzhinweis des Nutzers: $ARGUMENTS
