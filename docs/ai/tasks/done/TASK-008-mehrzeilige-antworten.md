---
id: TASK-008
titel: Mehrzeiliges Antwortfeld für Rückfragen
status: done   # offen | in-arbeit | blockiert | done
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
- [x] Rückfrage-Dialog: mehrzeiliges Textfeld. Die Fragen sind sichtbar, Enter erzeugt eine neue Zeile, Absenden per Button bzw. Strg+Enter.
      Belegt: Fragenermittlung per Unit-Test (`openQuestions`), Dialog und Tastaturverhalten per Code-Review (`experte`).
- [x] Sichtprüfung in der Dev-App (Darstellung, Enter/Strg+Enter) durch den Nutzer – bestätigt 2026-10-20.
- [x] Übrige `PromptDialog`-Aufrufer unverändert (einzeilig, Enter sendet). Belegt per Code-Review (gleiches DOM, `multiline` nicht gesetzt).
- [x] UI-Texte Deutsch. Renderer-Tests grün (75/75), `pnpm typecheck` grün (alle Pakete).

## Plan
1. Aufrufer von `PromptDialog` finden (`sucher`), Rückfrage-Aufrufer im Leitstand identifizieren.
2. Option `multiline` (oder eigener Dialog) ergänzen, Rückfrage-Aufrufer umstellen.
3. Tests, Typecheck; Sichtprüfung in der Dev-App durch den Nutzer.

## Log
- 2026-10-20: Aus TASK-005-Restpunkt (2) angelegt (Nutzerentscheidung in TASK-006: eigene Tasks).
- 2026-10-20 (Schritt 1, Hauptagent, ohne Subagent – drei Treffer per grep): Aufrufer von `PromptDialog`:
  `Leitstand.tsx` (Neu planen / Rückfragen in `RunHeader`, ein gemeinsamer Dialog mit Titel-Weiche auf
  `stage.state === 'plan_questions'`), `Leitstand.tsx` (Hinweis an Teilaufgabe), `ExplorerPanel.tsx` (Datei/Ordner anlegen).
  Fragen liegen nur in der Chat-Nachricht (`metadata: { kind: 'plan_questions', questions }`,
  `apps/api/src/execution/execution.service.ts:310`), im Renderer über `useSessionState(state.active.messages)`.
- 2026-10-20 (Schritt 2, Hauptagent): Umsetzung.
  - `apps/desktop/src/renderer/components/common.tsx:85` `PromptDialog`: optionale Props `multiline` und `children`
    (Inhalt zwischen Titel und Feld). `multiline` → `<textarea className="textarea" rows={6}>`, Enter = neue Zeile
    (Standardverhalten), Strg/⌘+Enter sendet (`onKeyDown`, Idiom aus `OrchestratorChat.tsx:157` übernommen), Hinweis
    „Strg+Enter sendet" links neben den Buttons. Ohne `multiline` unverändertes `<input>` → Enter sendet per Form-Submit.
  - `apps/desktop/src/renderer/lib/leitstand.ts:36` neue reine Funktion `openQuestions(messages, taskId)`: jüngste
    Assistant-Nachricht des Tasks mit `kind: 'plan_questions'`, leere Fragen gefiltert, kaputte Metadaten → `[]`.
  - `Leitstand.tsx` `RunHeader`: Rückfrage-Dialog als eigener Zweig (`multiline`, Titel „Rückfragen beantworten",
    Fragenliste per neuer Komponente `ClarificationQuestions` als nummerierte Liste, max. 220 px scrollbar; ohne geladene
    Fragen Fallback „Die Fragen stehen im Chat."). Neu-planen-Dialog getrennt, unverändert einzeilig.
  - Verworfen: eigener Key-Helper in `lib/` nur für die Testbarkeit – der Renderer hat kein DOM-Testsetup
    (kein jsdom/testing-library), und das Inline-Idiom existiert bereits im Chat. Tastaturverhalten daher per
    Sichtprüfung belegen. `findLast` verworfen (tsconfig-lib < ES2023) → `[...messages].reverse().find(...)`.
  - Tests: `apps/desktop/src/renderer/lib/leitstand.test.ts` – `describe('openQuestions')` mit 2 Fällen (jüngste
    Fragen des Tasks; leer ohne Task/Fragen/bei kaputten Metadaten).
  - `pnpm --filter @multi-ai-coder/desktop test`: 12 Dateien, 75/75 grün. `pnpm --filter @multi-ai-coder/desktop typecheck`
    grün (erster Lauf rot: `noUncheckedIndexedAccess` in der Schleife, dann `findLast` nicht in lib – beides behoben).
    `pnpm typecheck` (gesamt) bis auf diesen Fehler grün; Nachlauf siehe Abschluss.
- 2026-10-20 (Schritt 3, `experte`-Review): 0 Blocker, 0 Sollte, 3 Kann – alle umgesetzt (Hauptagent):
  (1) `common.tsx:92` Hintergrund-Klick schließt den mehrzeiligen Dialog nicht mehr, sobald Text eingegeben ist
  (sonst Verlust längerer Antworten durch Fehlklick; „Abbrechen" bleibt). (2) `Leitstand.tsx:177/190` `key="questions"`
  / `key="replan"`, damit React den Eingabe-State nicht zwischen beiden Dialogen überträgt, falls `stage.state` bei
  offenem Dialog wechselt. (3) `leitstand.test.ts:89` deterministische Test-IDs statt `Math.random()`.
  Review bestätigte außerdem: Enter in `<textarea>` sendet kein Form-Submit, Strg+Enter genau einmal, IME unkritisch
  (`key === 'Process'`), Fragen-Nachricht hat immer `taskId` und liegt in der neuesten Seite (200 Nachrichten).
- 2026-10-20 (Abschluss): `pnpm --filter @multi-ai-coder/desktop test` 12 Dateien, 75/75 grün;
  `pnpm typecheck` alle Pakete `Done`, Exit 0.
- 2026-10-20 (Sichtprüfung, Nutzer): Live-Rückfrage mit Auftrag „Bau die Funktion ein, über die wir gestern gesprochen
  haben …" ausgelöst (Codex stellte 2 Fragen). Dialog in der Dev-App geprüft – Nutzer: „das klappt".

## Ergebnis
Der Rückfrage-Dialog („Antworten & neu planen") ist jetzt mehrzeilig: `PromptDialog` hat die optionalen Props
`multiline` und `children` (`apps/desktop/src/renderer/components/common.tsx:85`). Über dem Feld stehen die Fragen des
Planners als nummerierte Liste (`ClarificationQuestions` in `Leitstand.tsx`, Daten aus `openQuestions()` in
`apps/desktop/src/renderer/lib/leitstand.ts:36`), Enter macht eine neue Zeile, Strg+Enter oder „OK" sendet. Der
Neu-planen-Dialog, der Hinweis-Dialog und der Explorer-Dialog bleiben einzeilig. 2 neue Unit-Tests.

## Übergabe
Erledigt und vom Nutzer in der Dev-App bestätigt, nicht committet. Kein DOM-Testsetup im Renderer – falls künftig mehr UI-Verhalten belegt werden soll,
wäre jsdom + testing-library ein eigener Task.
