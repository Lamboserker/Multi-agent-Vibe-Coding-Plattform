---
id: TASK-008
titel: Mehrzeiliges Antwortfeld für Rückfragen
status: offen   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-20
phase: –
abhaengig: TASK-005
plan: –
---

# TASK-008: Mehrzeiliges Antwortfeld für Rückfragen

## Ziel
Bei „Antworten & neu planen" beantwortet der Nutzer mehrere Fragen des Planners. `PromptDialog`
(`apps/desktop/src/renderer/components/common.tsx:85`) ist einzeilig. Für Rückfragen braucht er ein mehrzeiliges Feld,
ohne dass die anderen Aufrufer von `PromptDialog` ihr Verhalten ändern.

## Akzeptanzkriterien
- [ ] Rückfrage-Dialog: mehrzeiliges Textfeld. Die Fragen sind sichtbar, Enter erzeugt eine neue Zeile, Absenden per Button bzw. Strg+Enter.
- [ ] Übrige `PromptDialog`-Aufrufer unverändert (einzeilig, Enter sendet).
- [ ] UI-Texte Deutsch. Renderer-Tests grün, `pnpm typecheck` grün.

## Plan
1. Aufrufer von `PromptDialog` finden (`sucher`), Rückfrage-Aufrufer im Leitstand identifizieren.
2. Option `multiline` (oder eigener Dialog) ergänzen, Rückfrage-Aufrufer umstellen.
3. Tests, Typecheck; Sichtprüfung in der Dev-App durch den Nutzer.

## Log
- 2026-10-20: Aus TASK-005-Restpunkt (2) angelegt (Nutzerentscheidung in TASK-006: eigene Tasks).

## Ergebnis

## Übergabe
Noch nicht begonnen. Startpunkt: `components/common.tsx:85`.
