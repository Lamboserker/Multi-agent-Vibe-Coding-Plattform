---
description: Stand für die nächste Session sichern (vor /clear oder bei vollem Kontext)
argument-hint: "[optional: done – Task abschließen]"
---

Sichere den Arbeitsstand so, dass eine neue Session nur mit `docs/ai/` weitermachen kann:

1. Aktives Task-File (`docs/ai/tasks/TASK-NNN-*.md`):
   - `## Log`: datierte Stichpunkte zu dieser Session ergänzen (Entscheidungen, verworfene Ansätze + warum, Validierung + Ergebnis).
   - Akzeptanzkriterien abhaken, die nachweislich erfüllt sind.
   - `## Übergabe` **überschreiben**: aktueller Stand, geänderte Dateien, was noch fehlt, exakter nächster Schritt, offene Fragen.
2. Ist der Task fertig (oder Argument `$ARGUMENTS` = `done`): `## Ergebnis` füllen, `status: done`, Datei nach
   `docs/ai/tasks/done/` verschieben und einen ehrlichen Eintrag in `docs/ai/ai-log/JJJJ-MM.md` schreiben
   (Format und Note A–D nach Skill `projekt-doku`). Bei Note C/D oder Wiederholungsfehler: Regel in `docs/ai/lessons.md`.
3. `docs/ai/CONTEXT.md` aktualisieren (überschreiben, ≤ 60 Zeilen): Stand-Datum, aktiver Task, nächste Schritte,
   Phasen-Status, neue Stolpersteine.
4. Test: Würde jemand ohne Chatverlauf mit CONTEXT.md + Task-File wissen, was als Nächstes zu tun ist? Wenn nein, nachbessern.
5. Kurz melden, was gesichert wurde. Nicht committen, außer der Nutzer verlangt es.
