# Plan: Duo-Orchestrierung (Claude + Codex), ehrliche Hardware-Anzeige, mehr lokale Ausführung

## Context
Der Nutzer will drei Dinge:
1. **Claude und Codex sollen wahlweise zusammen arbeiten**, und zwar in allen Phasen. Beide arbeiten parallel, dann
   folgt ein Abgleich. Die Wahl läuft über die Einstellungen und über einen Schalter im Composer.
2. **Die Hardware-Anzeige ist irreführend.** Die Werte sind zwar echt gemessen (nvidia-smi, `/api/ps`). Aber:
   - Ein Modell bleibt nach dem Warm-up (das sogar schon beim Planungsstart läuft) oder nach einem Lauf bis zu 15 min
     im VRAM und wird als „bereit" angezeigt.
   - Nur eine der beiden Ollama-Instanzen wird abgefragt (:11434/:11435). nvidia-smi zählt aber alles auf der Karte.
   - Der Text „live · 1,5 s" ist fest eingetragen. Die Historie wächst nur bei Abfrage.
   - Nach einem einzigen Fehler versucht die App nvidia-smi nie wieder.
   - Entscheidung des Nutzers: ehrlicher Status plus automatisches Entladen.
3. **Mehr lokal ausführen, ohne an Qualität zu verlieren.** Gefunden wurden:
   - Der Planer bewertet Komplexität und Risiko ohne Leitlinie. Ab 4 oder 5 geht ein Task auf advanced oder premium.
   - Im Modus `balanced` wird ein Premium-Vorschlag des Planers immer um eine Stufe hochgestuft.
   - Ein Downgrade per Statistik ist nur bis Risiko 2 erlaubt.
   - Eine Eskalation führt gleich zur vollen Premium-Ausführung.
   - **Qualitätslücke:** Hatte die Baseline keine geparsten Testzahlen, werden rote Tests durchgewunken. Das erklärt
     „fertig" bei gleichzeitigem „ELIFECYCLE Test failed". Die Log-Anzeige ist zudem unsortiert
     (`leitstand.ts:248-260`).

Umsetzung in Tasks nach `docs/ai`. Der Hauptagent schreibt `docs/ai/`. Ein neues **ADR-004** ersetzt den Satz
„kein automatischer zweiter Premium-Aufruf" (ADR-002) für den Duo-Modus, den der Nutzer selbst wählt.

---

## TASK-022 Hardware-Anzeige: Echtzeit und ehrlicher Modellstatus (entwickler/experte)

**Backend:** `apps/api/src/local-models/resource-monitor.service.ts`, `packages/engine/src/hardware/monitor.ts`,
`apps/api/src/local-models/local-models.service.ts`
- **Echte Live-Daten.**
  - Solange das Fenster sichtbar ist, nimmt ein Hintergrund-Sampler jede Sekunde eine Messung in die Historie auf.
    Nur so entstehen lückenlose Sparklines. Die API bekommt dafür ein `visible`-Signal (Renderer-Poll), sonst gilt
    der 10-s-Takt.
  - Im Snapshot stehen `sampledAt` und `intervalMs`.
  - Nach einem Fehler versucht der Sampler nvidia-smi alle 30 s erneut, statt dauerhaft aufzugeben
    (`monitor.ts:202-204`).
- **Beide Ollama-Instanzen abfragen.**
  - `/api/ps` geht an `settings.ollamaBaseUrl` und an die jeweils andere bekannte Instanz. Die Liste kommt aus einer
    neuen Einstellung `extraOllamaUrls` (Default: die andere Instanz von :11434/:11435).
  - `models[]` bekommt `instance: 'app' | 'external'` und `baseUrl`.
- **Status pro Modell:**
  - `generating`: aktive Agenten nutzen das Modell, wie heute in `resource-monitor.service.ts:171-190`.
  - `idle`: keine Agenten; dazu `unloadsInSec` aus `expires_at`.
  - `external`: das Modell liegt in der anderen Instanz.
- **VRAM aufschlüsseln:**
  - Neue Felder `vram.appModelsGb` (Summe `size_vram` der App-Instanz) und `vram.otherGb`
    (nvidia-smi gesamt − App-Modelle).
  - Die Warnung in `assessResources` (`monitor.ts:131`) unterscheidet zwei Fälle: „belegt durch andere Prozesse"
    und „Modelle werden ausgelagert". Die zweite Meldung kommt nur, wenn `size_vram < size` gilt.
- **Automatisch entladen.** Neue Einstellung `unloadAfterRun` (Default `true`):
  - Wenn ein Lauf endet (completed, failed oder cancelled) und kein anderer aktiver Lauf das Modell nutzt, entlädt
    die App die Modelle dieses Laufs über das bestehende `unload()` (`local-models.service.ts:338`).
  - Die Stellen dafür sind die Lauf-Abschluss-Pfade in `execution.service.ts` (`runJob`).
- **Warm-up erst nach dem Plan.** Das Warm-up beim Planungsstart (`execution.service.ts:182-190`) fällt weg. Was
  bleibt: das Warm-up nach dem Plan (435) und beim Laufstart (660).
- **Manuelles Laden** nutzt `keepAliveMinutes` statt des festen `'15m'` (`local-models.service.ts:330-336`).

**Renderer:** `apps/desktop/src/renderer/components/shell/Shell.tsx` (`HardwarePopover` 191-310),
`lib/resources.ts`, `lib/types.ts`
- Die Live-Angabe errechnet sich aus `sampledAt`/`intervalMs`. Ist der letzte Messwert älter als 5 s, steht dort
  „veraltet".
- Jeder Modell-Eintrag zeigt Status und Instanz: „generiert · task-007", „im Leerlauf · entlädt in 12 min" oder
  „andere Ollama-Instanz".
- Zwei Knöpfe sind neu: „Entladen" pro Modell (POST `/local-models/:model/unload`) und „Alle entladen".
- Die VRAM-Zeile zeigt „davon App-Modelle X GB · Sonstige Y GB".
- Fehlender GPU-Wert: eine Lücke statt 0 (`resourceMetrics`).

**Tests:**
- `monitor.test.ts`: Retry, Warnfälle.
- `plan-insights.test.ts`: zwei Instanzen, `idle`/`generating`/`external`, `unloadsInSec`, VRAM-Aufteilung.
- Unload nach Laufende.
- `resourceMetrics` mit Lücken.

## TASK-023 Qualitätslücke und Log-Reihenfolge (entwickler)
- **Baseline-Lücke schließen:** `packages/engine/src/validation/checks.ts:248-257` `againstBaseline`.
  - Ein `test`-Fehler ist nur dann `preexisting`, wenn Baseline und Task beide geparste Zahlen haben und die Zahl der
    Fehler nicht steigt.
  - Fehlen die Zahlen, prüft die App die Testdateien/-namen der Baseline (falls vorhanden). Gibt es auch die nicht,
    bleibt der Fehler blockierend.
  - Ausnahme: Ist der Test-Runner gar nicht vorhanden (z. B. Playwright fehlt), läuft der Fehler unter
    `environment` mit eigenem Hinweis, nicht still.
- **Log-Reihenfolge:** In `apps/desktop/src/renderer/lib/leitstand.ts:248-260` werden die Zeilen vor `lastLog`
  nach Zeitstempel sortiert. Für einen fertigen Task gilt das letzte gespeicherte Ereignis als `lastLog`, nicht ein
  Live-`check_output`.
- **Tests:** `checks.test.ts` (Baseline ohne Zahlen bleibt rot), `leitstand.test.ts` (Reihenfolge).

## TASK-024 Mehr lokal ausführen (experte; Prompt-Teil entwickler)
- **Bewertungsraster im Planer:** `packages/engine/src/orchestrator/prompts.ts:93-126`.
  - Eine klare Skala für `complexity`/`risk`, zum Beispiel:
    - 1–2: eine Datei mit klarer „alt → neu"-Anweisung
    - 3: neue Komponente plus Test
    - 4: mehrere bestehende Dateien
    - 5: Architektur
  - Risiko 4 und mehr nur bei Auth, Daten-Migration oder Sicherheit.
  - Gegen den ganzen Prompt und die ADRs lesen (Lesson 11). Tests in `prompts.test.ts`.
- **Router:** `packages/engine/src/routing/router.ts`.
  - In `balanced` hebt `suggestedExecutor: 'premium'` die Stufe nur bei complexity ≥4 oder risk ≥3 an (:105-111).
  - Downgrade per Statistik ist auch bei Risiko 3 erlaubt, wenn die Konfidenz „high" ist (:124-139).
- **„Premium berät, lokal führt aus":** neue erste Eskalationsstufe vor der vollen Premium-Ausführung.
  - Ort: `packages/engine/src/engine/execution.ts`, Eskalationskette :466-550, `routing/router.ts:193-203`.
  - Ist die lokale Reparatur gescheitert, bekommt der Orchestrator den Diff und die Check-Ausgabe. Er liefert nur
    präzise „alt → neu"-Reparaturanweisungen. Dafür gibt es ein neues Schema `REPAIR_HINT_SCHEMA` (strict) und einen
    Aufruf über `reviewResult` oder einen neuen Prompt.
  - Mit diesen Anweisungen macht das stärkste lokale Modell eine weitere Reparaturrunde.
  - Erst wenn auch das scheitert, folgt `executeComplexTask`.
  - Neue Einstellung `premiumHints` (Default `true`). Zweck `repair_hint` wird gebucht.
- **Tests:** router-Tests (balanced, Risiko 3), `execution.test.ts` (Hinweis-Stufe mit Fake-Orchestrator, Reihenfolge
  der Kette, Buchung).

## TASK-025 Duo-Orchestrator in der Engine (experte)
**Ansatz:** ein zusammengesetzter Adapter `DuoOrchestrator(lead, partner)` in
`packages/engine/src/orchestrator/duo.ts`. Er implementiert `OrchestratorAdapter` (`types.ts:323-340`). Deshalb
bleibt `deps.orchestrator` in der Engine ein einzelnes Objekt, und alle Aufrufer funktionieren unverändert.

Alle Methoden folgen dem Muster **parallel + Abgleich**: `Promise.allSettled` auf beiden. Scheitert einer, gilt das
Ergebnis des anderen; ein Hinweis darauf kommt in die Meta.

| Methode | Parallel | Abgleich |
|---|---|---|
| `createPlan` | beide planen | Der Lead bekommt beide Pläne und liefert den zusammengeführten Plan plus `decisionNotes`. Schema: `RECONCILE_PLAN_SCHEMA` = { plan: PLAN_SCHEMA, notes } (strict). Stellt einer `needs_clarification`, werden die Fragen vereint. |
| `createDesign` | beide entwerfen | Der Lead führt über `DESIGN_SCHEMA` zusammen, mit beiden Entwürfen als Kontext. |
| `reviewResult` | beide reviewen | deterministisch, ohne dritten Aufruf: Issues vereinen (Dubletten nach Datei und Titel), das strengere Urteil und die niedrigere Punktzahl gelten |
| `executeComplexTask` | beide in getrennten Worktrees | Zuerst deterministisch: Checks grün, weniger Fehler. Bei Gleichstand vergleicht der Lead beide Diffs (Schema `CHOOSE_SCHEMA`: Wahl A oder B plus Begründung). Die Engine legt dafür eine Schwester-Worktree an. Die Logik dafür liegt in `runPremium` (`execution.ts:919-989`) und hängt an `adapter.duo`. |
| `chat` | beide antworten | kein Abgleich: Beide Antworten werden mit Anbieter angezeigt, das spart einen Aufruf |
| `cancelRun` / `detect` / `getStatus` | an beide weiterreichen | – |

- **Buchung:**
  - `CallMeta` bekommt `parts?: Array<CallMeta & { provider: OrchestratorId; role: 'lead'|'partner'|'reconcile' }>`.
  - Neuer Helfer `modelCallRows(adapterId, meta, base)` in `apps/api/src/orchestration/model-call.ts` erzeugt pro
    Teil eine ModelCall-Zeile. Die Spalte `provider` gibt es schon.
  - Der Helfer ersetzt die verstreuten Buchungsstellen: `execution.service.ts:466` (recordPlanCall), `:1009`,
    `design.service.ts:275`, `orchestrator.controller.ts:86`, `sessions.service.ts`, `prisma-engine-store.ts:117`
    und `failedCallFields`.
- **Ereignisse:** Die Engine sendet `duo_proposal` (Anbieter, Kurzfassung) und `duo_reconciled` (Notizen, Gewinner).
  Daraus werden Chat-Meilensteine.
- **Prompts:** `reconcilePlanPrompt`, `reconcileDesignPrompt`, `chooseExecutionPrompt` in `prompts.ts`. Neue Regeln
  gegen den ganzen Prompt prüfen. Tests nur mit Fake-Adaptern, keine Live-Aufrufe.

## TASK-026 Duo-Modus in API, Einstellungen und UI (experte/entwickler)
- **Einstellungen:** `apps/api/src/runtime/settings.service.ts`.
  - `orchestratorMode: 'single' | 'duo'` (Default `single`) und `duoLead: OrchestratorId` (Default `claude-code`).
  - Gespeichert als Key/Value in `AppSetting`, deshalb ist keine Migration nötig.
  - `ExecutionRun.orchestrator` speichert im Duo-Modus `'duo:claude-code+codex'` (String-Feld).
- **Auflösung:** `orchestrator.service.ts`.
  - `active(override?)` liefert im Duo-Modus `new DuoOrchestrator(lead, partner)`, wenn beide installiert und
    angemeldet sind. Sonst gilt der einzelne verfügbare Orchestrator, und im Chat erscheint ein Hinweis.
  - `designer()` beachtet den Modus.
  - Der Override pro Auftrag kommt aus dem Composer.
- **Composer:** `OrchestratorChat.tsx:168-185`. Neue Seg-Auswahl „Claude | Codex | Beide". Sie wird mit der
  Nachricht als `orchestratorOverride` mitgeschickt, bis zu `plan()` und `runJob`.
- **Einstellungen-UI:** `OrchestratorConnect.tsx`/`SettingsPanel.tsx`. Modus-Wahl, Lead-Wahl, Hinweis „≈2–3×
  Premium-Kontingent".
- **Chat und Leitstand:**
  - Neue Nachrichtenarten `duo_proposals` (zwei Spalten: Claude, Codex) und `duo_reconciled` (Abgleich-Notizen,
    Gewinner).
  - Die Leitstand-Karte „Orchestrator" zeigt beide Anbieter mit eigenem Verbrauch, gruppiert aus ModelCall nach
    `provider`.
  - Der TokenMeter in der Shell zeigt „Claude + Codex".
- **Doku:** ADR-004 „Duo-Orchestrierung" (ersetzt einen Teil von ADR-002), `docs/desktop-architecture.md`.

## TASK-027 Gesamtverifikation (experte-Review)
- `pnpm --filter @multi-ai-coder/engine build`, dann `pnpm typecheck`, `pnpm test`, `pnpm lint`.
- Neustart von `pnpm dev` (Lesson 14). Sichtprüfung des Hardware-Popovers:
  - Nach einem Lauf wird das Modell entladen, das VRAM sinkt.
  - Ein Modell in der anderen Instanz zeigt „andere Ollama-Instanz".
  - Der Entladen-Knopf wirkt.
- Lokaler Lauf ohne Premium (Kostenmodus `cheapest`): Ein Task mit rotem Test darf nicht „fertig" werden.
- **Live-Test im Duo-Modus nur mit ausdrücklicher Zustimmung**, zum Beispiel „Erstelle eine Kontaktliste". Danach
  prüfen:
  - zwei Vorschläge plus Abgleich im Chat
  - ModelCall-Zeilen für beide Anbieter
  - Routing-Anteil lokal/premium

## Reihenfolge
023 (kleiner Qualitäts-Fix) → 022 (Hardware) → 024 (lokal) → 025 → 026 → 027. Jede Aufgabe ab 3 Schritten bekommt
ihr Task-File unter `docs/ai/tasks/`. Commits nur auf Nachfrage. TASK-020 bleibt offen und wartet auf den Nutzer.
