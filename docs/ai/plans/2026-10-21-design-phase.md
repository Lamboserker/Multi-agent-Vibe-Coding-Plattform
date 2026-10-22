# Masterplan: Design-Phase vor der Planung

Stand: 2026-10-21 · Tasks: TASK-013 … TASK-020 · Status: TASK-013–019 done, TASK-020 wartet auf Sichtprüfung/Live-Test


## Context
UI-Aufgaben sollen heute ohne Gestaltungsgrundlage direkt geplant werden. Das führt zu uneinheitlichen Ergebnissen, und
Codex erzeugt sichtbar veraltete Oberflächen.

Ziel ist eine eigene **Design-Phase**:
- **Wer entwirft:** Ist die Claude Code CLI installiert und angemeldet, erstellt immer Claude den Entwurf, egal welcher
  Orchestrator plant. Sonst übernimmt Codex als Fallback, mit harten Vorgaben für ein modernes Design.
- **Was entsteht:** Design-Spec, Tokens und ein HTML-Mockup.
- **Freigabe:** Der Nutzer gibt den Entwurf im Leitstand frei.
- **Danach:** Plan und Tasks bauen auf dem Entwurf auf.
- **Neue Skills:** design-dashboard, -crm, -landing-page, -saas-app, -admin-forms und -ecommerce geben Entwurf und
  Umsetzung typspezifische Rezepte.

Entscheidungen des Nutzers (2026-10-21):
- Design-Phase per Claude CLI, nicht das Web-Produkt „Claude Design“.
- Codex nur als Fallback.
- Die Phase läuft nur bei UI-Aufgaben.
- Vorschau mit Freigabe vor der Planung.

## Kernentscheidungen
1. **Read-only-Aufruf `createDesign`:** Claude bekommt `Read,Glob,Grep` und maxTurns 6, Codex läuft mit
   `--sandbox read-only --ephemeral`.
   - Kein Dateischreiben durch das Modell, weil Codex dieselbe Arbeitskopie nutzt.
   - Der Entwurf landet in der DB.
2. **Strict `DESIGN_SCHEMA`** in `packages/engine/src/orchestrator/schemas.ts`:
   - Felder: `summary`, `designType`, `direction` sowie `tokens[{name,value,darkValue,group}]`,
     `components[{name,purpose,file,spec,tokens}]`, `screens[{name,route,layout,components}]`, `mockupHtml`, `questions`.
     Alle Felder in `required`, `additionalProperties:false`.
   - `designType` ist ein Enum: dashboard, crm, landing-page, saas-app, admin-forms, ecommerce, other.
   - `normalizeDesign()`:
     - ergänzt fehlende Basis-Tokens aus `DESIGN_TOKENS` (`ui/design-normalize.ts`), damit der Design-Normalizer
       kompatibel bleibt;
     - kappt die Listen;
     - säubert `mockupHtml`: kein `<script>`, keine `on*`-Attribute, keine externen URLs, max. 200 kB.
3. **Dateien ins Repo über deterministischen Task `design-001`:**
   - Nach der Planung stellt die API einen Fast-Path-Task mit neuem `FastPathTool` `{kind:'write-files'}` voran
     (`packages/engine/src/fastpath/fast-path.ts`, `EngineTask.tool` gibt es schon in `engine/execution.ts:44,479`).
   - Er schreibt `design/tokens.css` (aus den Tokens generiert), `design/DESIGN.md` und `design/mockup.html`.
   - Alle geplanten Tasks hängen per `dependsOn` von `design-001` ab. Das setzt die API, weil `normalizePlan` unbekannte
     Ids verwirft.
4. **Designer-Wahl:** `OrchestratorService.designer()` in `apps/api/src/orchestration/orchestrator.service.ts`.
   - Nimmt Claude, wenn es installiert und angemeldet ist (dieselbe API-Key-Regel wie `active()`), sonst Codex.
   - Ist keiner verfügbar, wird die Phase mit einem Chat-Hinweis übersprungen.
   - `createDesign: 'designer'` kommt in die MCP-Rollenmap (`:75`).
5. **Gate `shouldDesign(prompt, mode)`** als reine Funktion in `packages/engine/src/ui/design-gate.ts`:
   - `force` → ja, `skip` → nein.
   - `auto` → ja, wenn der Prompt ein UI-Objekt (Dashboard, Landingpage, Oberfläche, CRM, Shop, Admin, Formular,
     Website …, DE und EN) und ein Erstellen- oder Redesign-Verb enthält.
   - Nein bei Fix/Bug/Typo und bei kurzen Einzeldatei-Änderungen.
   - Pro Task gibt es `designMode` (`auto|force|skip`).
6. **Skills für den Designer:**
   - Neue Rolle `designer` in `AGENT_ROLES` (`apps/api/src/skills/skills.service.ts:16`, `mcp.service.ts:211`,
     `skills.controller.ts`, `SkillsPanel.tsx` ROLES).
   - Der Designer-Prompt bekommt `promptContext('designer', …, { pinned:['ui-design'], budgetChars:9000 })` und den
     `design-*`-Katalog.
   - Beim Planen wird der Skill `design-<designType>` als `requested` markiert. So erreicht er über die bestehende Regel
     die Coder.
7. **Executor-Guidance `designGuidance(design, task, 3000)`** in `packages/engine/src/ui/design-guidance.ts`:
   - Gilt für UI-Tasks und liefert die `:root`-Tokens, die passenden Komponenten-Specs (max. 3) und das Screen-Layout.
   - Dazu die Regel „nur `var(--…)` aus design/tokens.css, Mockup als Referenz“.
   - Eingehängt über den `agentResources`-Callback in `execution.service.ts`, damit sie auch bei lokalen Modellen ohne
     Tools ankommt (Lesson 10).
8. **Moderne Vorgaben:** Die Konstante `MODERN_DESIGN_RULES` geht in beide Prompts. Codex bekommt zusätzlich den Block
   „Avoid dated output“.
   - Gewollt: neutrale Zinc/Slate-Basis mit genau einem Akzent, Inter/Geist, 8-px-Raster, Hairline-Borders, weiche
     Schatten, Radius 10–12, Skeletons und Empty-States, Bento-Grid für Landingpages.
   - Verboten: Bootstrap-Blau, Gradient-Buttons, Zebra-Tabellen, Jumbotron, Emoji-Icons, dicke graue Borders.

## Ablauf
1. `requestPlan` prüft zuerst das Gate. Trifft es zu und gibt es noch keinen freigegebenen Entwurf:
   - `currentStep: 'designing'`, Job `design.create` (dedupe `design:<id>`, Recover → `design_failed`).
2. Der Job baut Digest, Skills und Feedback zusammen, ruft `designer.createDesign` auf und bucht den ModelCall
   (`purpose:'design'`, Fehler über `failedCallFields`).
   - Ergebnis: `DesignDraft` mit Status `draft`, `currentStep: 'awaiting_design_approval'` und Chat-Nachricht
     `{kind:'design_draft'}`.
3. **Freigeben** (`POST tasks/:id/design/approve`): Status `approved`, dann `requestPlan`. Das Gate ist jetzt erfüllt.
   - Auch eine Chat-Bestätigung („ok“, „passt“) gibt frei.
4. **Überarbeiten** (`…/reject {feedback}`): Der Entwurf wird mit dem Feedback neu erzeugt (Version +1). Freitext im Chat
   gilt als Feedback.
5. **Ohne Design planen** (`…/skip`): `designMode='skip'`, dann `requestPlan`.
6. In `plan()`:
   - Kein Fast-Path, wenn ein freigegebener Entwurf existiert.
   - `PlanningInput.design` (Brief ohne Mockup) kommt als Abschnitt `# Design draft (approved by the user)` in
     `planningPrompt`, mit diesen Regeln:
     - design-001 schreibt die Design-Dateien bereits.
     - Der erste Task bindet tokens.css ein und baut die Shell.
     - Danach ein Task pro Komponente, mit exaktem Namen und Datei.
   - Nach `normalizePlan` werden `design-001` und die Abhängigkeiten gesetzt.

DI ohne Zyklus: `DesignController` injiziert `DesignService` und `ExecutionService`. `ExecutionService` bekommt
`@Optional() design`.

## Persistenz (additive Migration `prisma/migrations/20261021120000_design_drafts`)
- `ALTER TABLE "Task" ADD COLUMN "designMode" TEXT NOT NULL DEFAULT 'auto'`
- `CREATE TABLE "DesignDraft"` mit den Spalten id, taskId (FK, cascade), version, status
  (generating|draft|approved|rejected|failed), provider, designType, summary, spec (JSON), mockupHtml, feedback,
  createdAt und updatedAt, plus Index (taskId, createdAt).

## Phasen (je ein Task-File in docs/ai/tasks/; Engine vor API bauen, Lesson 9)
| Task | Inhalt | Tests |
|---|---|---|
| TASK-013 | Engine: Typen (`DesignInput`, `DesignDraft`, `DesignBrief`, `createDesign`, `PlanningInput.design`), `DESIGN_SCHEMA`, `normalizeDesign`, `design-prompt.ts` + `MODERN_DESIGN_RULES`, `design-gate.ts`, `design-guidance.ts` | Schema strikt (rekursiv required==keys), Normalizer/Sanitizer, Gate-Tabelle DE/EN, Guidance-Budget, Prompt enthält Regeln bzw. Codex-Block |
| TASK-014 | Adapter `createDesign` in `claude-code.ts` und `codex.ts` über `normalizeWithMeta` | Fake-CLI in `adapters.test.ts`: Schema-Flag, Meta bei ungültiger Ausgabe, Codex-Avoid-Block (Fakes lehnen unbekannte Flags ab) |
| TASK-015 | `planningPrompt` mit Design-Abschnitt, FastPathTool `write-files` (Pfade über `normalizeRelative`) | `prompts.test.ts` mit Gesamtprompt-Gegenlesen auf Widersprüche (Lesson 11), Fast-Path-Tests Pfadflucht/Schreiben |
| TASK-016 | Prisma (Migration, Schema), `apps/api/src/design/` (Service, Controller, Modul), `designer()`, Gate in `requestPlan`, design-001 und requested Skill in `plan()`, Guidance-Hook | Stub-Adapter: Gate→designing, approve→Plan mit `input.design`, reject→v2, skip, Fehler bucht Tokens, Plan enthält design-001 samt Abhängigkeiten |
| TASK-017 | Neue Steps durchgängig (`designing`, `awaiting_design_approval`, `design_failed`) in `session-model.ts`, `sessions.service.ts` (continueTask, Chat-Freigabe/Feedback, markPlanInterrupted), `self-test.controller.ts`, `startLocked`, recover (Lesson 12: grep `plan_failed`) | `sessions.test.ts`, `planning-progress.test.ts` |
| TASK-018 | 6 Skills `skills/design-{dashboard,crm,landing-page,saas-app,admin-forms,ecommerce}/SKILL.md`: DE- und EN-Trigger, Layout-Rezept, Pflicht-Komponenten mit Specs, Zustände, Planungsrezept, test-task, je ≤ 3,5k Zeichen; Rolle `designer`; `ui-design` verweist auf `design/tokens.css` | `skills.test.ts`: Parsen, testSkill je Skill, „Erstelle ein CRM“ inlined ui-design + design-crm |
| TASK-019 | Renderer: `workflow.ts`-States mit deutschen Labels, `latestDesign()` in `lib/leitstand.ts`, `DesignReview` in `Leitstand.tsx` (iframe `sandbox=""` srcdoc, Token-Swatches, Komponentenliste, Buttons „Design freigeben“ / „Überarbeiten…“ / „Ohne Design planen“), Composer-Schalter „Design-Phase: Automatisch / Immer / Überspringen“ | `workflow.test.ts`, `leitstand.test.ts`; Sichtprüfung. CSP `frame-src 'none'` (`apps/desktop/src/main/main.ts:122`) gegen srcdoc prüfen, sonst nur `frame-src 'self'` ergänzen |
| TASK-020 | Gesamtverifikation + Abschluss-Review (experte) | s. u. |

Delegation: TASK-013/015/018 an `entwickler`, TASK-016/017 an `experte`, TASK-014/019 nach Umfang.

## Verifikation
- `pnpm --filter @multi-ai-coder/engine build && pnpm typecheck && pnpm lint && pnpm test`. Die bekannten
  timeout-anfälligen Tests einzeln nachprüfen.
- `pnpm prisma:generate`, bei laufendem `pnpm dev` mit dem DLL-Workaround aus CLAUDE.md. Die Migration in der Dev-DB
  prüfen (read-only per `node:sqlite`).
- Sichtprüfung in `pnpm dev` (nach Neustart, Lesson 14):
  - Schalter und Design-Review.
  - Die iframe-Vorschau mit einem eingespielten Test-Entwurf, ohne Live-Call.
- **Live-Test nur mit Zustimmung:** „Erstelle ein CRM-Dashboard“ → Claude-Entwurf → Freigabe → Plan mit design-001
  und Komponenten-Tasks → Ausführung durch lokale Modelle.

## Risiken
- **Mockup-Größe** (8–12k Output-Tokens): Timeout 10 min, Fortschritts-Events `design_progress`.
- **Fehlalarme des Gates:** konservative Heuristik, dazu „Ohne Design planen“ und der Schalter pro Task.
- **Kontingent:** zwei Premium-Calls pro UI-Erstellaufgabe. Die Design-Calls werden gebucht wie die Planung.
