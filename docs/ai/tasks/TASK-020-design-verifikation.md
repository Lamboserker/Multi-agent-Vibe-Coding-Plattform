---
id: TASK-020
titel: Gesamtverifikation Design-Phase
status: in-arbeit   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-21
phase: 8
abhaengig: TASK-013 … TASK-019
plan: plans/2026-10-21-design-phase.md
---

# TASK-020: Gesamtverifikation Design-Phase

## Ziel
Gesamtprüfung der Design-Phase (TASK-013 … TASK-019): volle Verifikation, Abschluss-Review durch den `experte`,
Beheben der Blocker, Sichtprüfung und Live-Test (nur mit Zustimmung).

## Akzeptanzkriterien
- [x] Volle Verifikation vor den Review-Fixes: engine build, typecheck, lint und test grün (engine 327, api 209 + 8
      übersprungen, desktop 90).
- [x] Abschluss-Review erledigt.
- [x] Blocker B1–B3 behoben, Verifikation erneut grün (engine 357, api 220 + 8 übersprungen, desktop 91; typecheck
      und lint grün).
- [ ] Migration in der Dev-DB geprüft (nach Neustart von `pnpm dev`).
- [ ] Sichtprüfung im Leitstand.
- [ ] Live-Test „Erstelle ein CRM-Dashboard“, nur mit Zustimmung.

## Log
- 2026-10-21: Volle Verifikation grün.
- 2026-10-21: Abschluss-Review (`experte`, read-only). Blocker:
  - B1: Das Gate meldet Backend-Aufgaben mit UI-Begriff als Design-Aufgaben, z. B. „REST-API für das Admin-Backend“
    oder „Tests für den Shop-Checkout“. Das kostet einen bezahlten Design-Call.
  - B2: Höfliche Freigaben im Chat („Ja, bitte“, „passt so, danke“, „👍“) zählen als Feedback und starten einen
    bezahlten Neuentwurf.
  - B3: `sanitizeMockup` lässt durch:
    - `<svg/onload>`, `"onerror` ohne Leerzeichen und `javascript:` mit gemischten oder Entity-Quotes;
    - `meta refresh`, `srcset`/`poster`/`action` und `image-set` mit externen URLs.
    Die Vorschau bleibt sicher (`sandbox=""` und App-CSP). Gefährdet ist `design/mockup.html` im Repo.
- 2026-10-21: Behebung delegiert:
  - Engine (`entwickler`): B1, B3-Sanitizer, Token-Werte prüfen, Überarbeitung mit kompakter Vorversion,
    Prompt-Widersprüche.
  - API/Renderer (`experte`):
    - B2 mit Hinweis bei unklaren Kurzantworten;
    - CSP-Meta in `mockup.html`;
    - `designMode='skip'` schlägt einen freigegebenen Entwurf;
    - Zustandsprüfungen (409) für approve, reject, regenerate und skip;
    - kein Design-Gate beim Neuplanen;
    - Composer-`designMode` nach dem Senden zurücksetzen;
    - `requestPlan` ohne Gate nach dem Designer-Fallback.
- 2026-10-21: Engine-Fixes zurück (`entwickler`).
  - Gate: `BACKEND` schließt jetzt auch bei starkem UI-Begriff aus, außer ein visuelles Wort steht im Prompt
    (`VISUAL_WORD`).
  - Sanitizer: `neutralizeTagUrls` prüft pro Attribut (Entities und Whitespace normalisiert); `meta http-equiv` und
    `base` werden entfernt; externe URLs in `srcset`/`poster`/`action`/`url()`/`image-set` werden neutralisiert.
  - `isSafeTokenValue` prüft Token-Werte.
  - `previousDraft` gibt die Vorversion kompakt mit (≤ 2400 Zeichen).
  - Prompt-Widersprüche behoben.
  - Hauptagent-Probe gegen `dist`: Die Handler-Regex lief über den ganzen Text und zerstörte harmlosen Inhalt
    (`<p>Mode: online = true</p>` → `<p>Mode:>`). Behoben: Handler werden jetzt pro Tag in `neutralizeTagUrls`
    entfernt (quote-aware). Tests für harmlosen Text ergänzt.
  - `src/orchestrator` und `src/ui`: 142 Tests grün; Build grün.
- 2026-10-21: API/Renderer-Fixes zurück (`experte`):
  - `designAnswer()` → approval | feedback | unclear. Unklar heißt: höchstens 4 Wörter und kein Änderungshinweis; dann
    folgt ein Hinweis (`design_unclear`), kein Job.
  - `DesignService.requireStep()` → 409. Neu ist `regenerate()` mit Guard.
  - `withMockupCsp()` in `design-files.ts`.
  - `requestPlan(..., { skipDesign })`: Das Gate greift nur ohne TaskPlan oder in einem Design-Schritt, nicht bei
    `plan_clarification`.
  - `designMode='skip'` hat Vorrang vor einem freigegebenen Entwurf.
  - Button „Planung starten“ bei einem freigegebenen Entwurf im Schritt awaiting.
  - `composerAfterSend()` setzt `designMode` zurück.
  - Ergebnisse: api 220 Tests + 8 übersprungen, desktop 91, lint grün.

## Ergebnis

## Übergabe
Nächste Schritte (brauchen den Nutzer):
1. `pnpm dev` neu starten, damit die Migration `20261021120000_design_drafts` angewendet wird. Danach read-only per
   `node:sqlite` prüfen: `_mac_migrations`, Spalte `Task.designMode` und Tabelle `DesignDraft`.
2. Sichtprüfung mit eingespieltem Entwurf, ohne Live-Call:
   - Das SQL steht im Bericht von TASK-019: `UPDATE Task … currentStep='awaiting_design_approval'`, `INSERT DesignDraft
     'seed-design-1'` (crm, Tokens, 2 Komponenten, Mockup) und optional `ChatMessage` mit kind `design_draft`.
   - Vorher `PRAGMA table_info("ChatMessage")` prüfen. DateTime-Werte sind Millisekunden-Ganzzahlen.
   - Prüfen: Review (Graph und Kacheln), Desktop/Mobil, Farbfelder, Chat-Karte, Composer-Schalter sowie die Zustände
     `designing` und `design_failed`.
   - Buttons nicht klicken: Sie lösen Premium-Calls aus.
   - Danach die Seed-Zeilen löschen und `currentStep` zurücksetzen.
3. Live-Test „Erstelle ein CRM-Dashboard“, nur mit Zustimmung.
4. Offene Nutzerfrage: Soll die Design-Phase übersprungen werden, wenn kein Orchestrator gewählt ist?

Bewusst offen aus dem Review:
- Ein UI-Task, der einmal ohne Design geplant wurde, bekommt beim Neuplanen kein automatisches Design mehr (nur mit
  „Immer“).
- Antworten auf Planer-Rückfragen ohne Plan und ohne Entwurf können das Gate noch öffnen.
- Der Planner sieht den Feedback-Verlauf der Design-Phase nicht. Fachliche Wünsche im Design-Feedback können
  verloren gehen.
- design-001 durchläuft die Projektvalidierung: Ist die Baseline rot, scheitert es ohne Fallback.
- Ohne gewählten Orchestrator (`settings.orchestrator` leer) wird trotzdem Claude/Codex als Designer genutzt. Das muss
  der Nutzer klären.
- Die Uhr nach einem Reload in `designing` fehlt (`tasks.service.ts:84`).
- Die Button-Freigabe verliert `autoRun` der ursprünglichen Nachricht.
