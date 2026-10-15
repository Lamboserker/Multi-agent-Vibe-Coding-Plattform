# Performance – Messverfahren, Baseline und Ergebnisse (Phase 0.3)

Stand: 2026-10-09. Alle Zahlen sind auf der unten genannten Referenzhardware gemessen; sie sind keine
Garantie für andere Systeme. „vorher“ = Stand vor Phase 0.3 (aus einem Snapshot gebaut), „nachher“ = jeweiliger Stand.

## 1. Referenzumgebung und Verfahren

| | |
|---|---|
| Hardware | AMD Ryzen 7 5800X (8C/16T), 32 GB RAM, NVIDIA RTX 4060 Ti 16 GB |
| System | Windows 11 Pro (10.0.26300), Node 24.14.1, Electron 44.5.1 |
| App-Build | Produktions-Build (`pnpm --filter @multi-ai-coder/desktop build`), Renderer über `app://` |
| Profil | jeweils frisches, isoliertes Benutzerprofil (`MAC_USER_DATA_DIR`) |
| Testprojekt | `e2e/fixtures/react-app` (git-Repo) bzw. synthetisches TS-Repo mit 5 000 Dateien (Engine) |

Skripte (reproduzierbar, gleiche Prozedur für alte und neue Version):

- `apps/desktop/e2e/perf-benchmark.mjs --label <name> [--app <apps/desktop-Verzeichnis>] --rounds 5 --launches 3`
  – UI/Runtime: Messung **im Renderer** vom auslösenden DOM-Ereignis bis der DOM den neuen Zustand zeigt
  (Makrotask-genau, keine Playwright-Roundtrips). Monaco rendert in Animation-Frames; Messungen, die davon
  abhängen (Datei öffnen, Tab-Wechsel), laufen nur mit geprüfter Framerate (Fenster ohne Fokuswechsel im
  Vordergrund, `frameChecks` im JSON). Start-Messungen: Prozessstart → First Contentful Paint bzw. → IDE sichtbar
  (Warmstart: Profil und Projekt existieren). p50/p95 über alle Wiederholungen.
- `packages/engine/bench/engine-benchmark.mjs --files 5000 --ollama <url> --model <name>` – Repository-Index,
  Git-Worktrees, Patch-Validierung, Orchestrator-CLI-Start/Status (ohne Modellaufruf), Ollama kalt/warm.

Hinweis zur Gültigkeit: Ist das Testfenster verdeckt, drosselt Chromium die Frames auf ~1/s. Die Benchmarks
starten Electron deshalb mit `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
--disable-features=CalculateNativeWinOcclusion` und weisen die Framerate je Messblock aus. Die zusätzlich
erfasste Metrik `click_to_paint_ms` ist nur gültig, wenn `paintValid=true` im Ergebnis steht.

Premium-Orchestrator-Aufrufe (Claude Code / Codex) wurden **nicht** gemessen, um kein Abo-Kontingent zu
verbrauchen; gemessen wurden nur Prozessstart und Statusabfragen der CLIs.

## 2. Baseline (vor Phase 0.3)

### 2.1 UI und lokale Laufzeit (`perf-before-2026-10-09T14-27-44-859Z.json`)

| Vorgang | p50 | p95 | Ziel |
|---|---:|---:|---|
| Navigation zwischen Ansichten (wiederholt) | 3,0 ms | **748 ms** | < 100 ms |
| Erstbesuch „Modelle“ / „Einstellungen“ / „Nutzung“ | **3 034 / 767 / 212 ms** | | < 100 ms |
| Geladenen Chat öffnen (Aufgabe wechseln) | 6,1 ms | 7,2 ms | < 150 ms |
| Kleine Datei öffnen | 27,9 ms | 32,6 ms | < 200 ms |
| Erste Datei nach Start öffnen | 131 ms | | < 200 ms |
| Tab-Wechsel (bis Inhalt sichtbar) | 17,8 ms | 33,1 ms | unmittelbar |
| Chat-Eingabe (Input-Event → DOM) | 5,0 ms | 6,2 ms | < 50 ms |
| Hintergrundjob starten → Status sichtbar | 51,5 ms | | unmittelbar |
| 2 000 Agenten-Logevents: Renderer-CPU | 317 ms | | – |
| Reload → IDE sichtbar | 75 ms | 81 ms | – (Zustand ging verloren) |
| Start → First Contentful Paint | 502 ms | 522 ms | < 2 s |
| Start → IDE mit Projekt | 1 128 ms | 1 135 ms | < 2 s |
| Laufzeit (NestJS) Start inkl. Migrationen | 588 ms | 605 ms | – |
| API-Roundtrip (IPC+HTTP+SQLite) `settings/tasks/file/tree` | 1,2–2,1 ms | ≤ 2,7 ms | – |
| API `GET /orchestrator` (Status gecacht) | **169 ms** | 190 ms | – |
| Planung ohne Modell (Index + Digest + Routing + DB) | 156 ms | 182 ms | – |
| Speicher (Working Set): Renderer / Runtime / Main | 327 / 176 / 159 MB | | – |

### 2.2 Engine und externe Prozesse (`engine-baseline-2026-10-09T14-34-20-411Z.json`)

| Vorgang | Messwert |
|---|---:|
| Repository-Index 5 000 Dateien: kalt / ohne Änderung / eine Datei geändert | 3 989 / **647** / 596 ms |
| Kontext-Digest | 141 ms |
| Git-Worktree anlegen / entfernen (5 000 Dateien) | **2 768 / 1 525 ms** |
| Patch-Validierung | 146 ms |
| Codex-CLI: Erkennung / Status / `--version` | 57 / 107 / 29 ms |
| Claude-Code-CLI: Erkennung / Status / `--version` | 169 / **548** / 139 ms |
| Ollama `qwen2.5-coder:7b`: Kaltstart (Laden) / Time-to-First-Token kalt | **15 750 / 16 081 ms** |
| Ollama warm: TTFT / Tokens pro Sekunde / VRAM | 223 ms / 49,5 tok/s / 4,5 GB |

Messwerte aus einem echten Lauf (Live-E2E, gleicher Rechner): lokaler Agent (`qwen2.5-coder:7b`) für eine
React-Komponente + Test 29,4 s inkl. Validierung (Typecheck + Vitest im Worktree).

## 3. Die fünf größten Engpässe (nach tatsächlichem Einfluss)

1. **Kaltstart des lokalen Modells: ~16 s bis zum ersten Token.** Ollama entlädt Modelle nach 5 min; der erste
   Agentenaufruf eines Runs wartet dann auf das Laden von 4,7 GB. Warm sind es 0,22 s. Betrifft jeden Run nach einer Pause.
2. **Git-Worktrees: 2,8 s anlegen + 1,5 s entfernen pro Teilaufgabe** (vollständiger Checkout bei 5 000 Dateien),
   zusätzlich für den Integrations-Worktree. Skaliert mit Repository-Größe und Anzahl Teilaufgaben.
3. **Repository-Index bei jeder Planung/jedem Run: ~0,65 s** auf 5 000 Dateien auch ohne jede Änderung
   (`git ls-files` + `stat` jeder Datei + Schreiben des gesamten Index-Caches).
4. **Orchestrator-Erkennung/-Status: 170–880 ms pro Abfrage** – `GET /orchestrator` startet bei jedem Aufruf
   Prozesse zur CLI-Erkennung; mit `refresh=1` (Einstellungen, Onboarding) zusätzlich Statusabfragen (Claude 548 ms).
   Folge: Erstbesuch „Einstellungen“ ~0,75 s.
5. **Ansicht „Modelle“: ~3 s beim ersten Öffnen und (vorher) bei jedem Wechsel** – Hardware-Erkennung und
   Registry-Abfragen; vorher wurden Modelle/Einstellungen bei jedem Ansichtswechsel neu geladen (Navigation p95 748 ms).

Weitere gemessene Punkte mit geringerem Einfluss: Start bis IDE 1,1 s (Ziel erreicht), Renderer-Arbeit pro
Logevent (317 ms CPU je 2 000 Events), Planung ohne Modell 0,16 s.

## 4. Umgesetzte Optimierungen (Phase C) und Ergebnisse

### 4.1 Maßnahmen

| Engpass | Maßnahme | Ort |
|---|---|---|
| 1 Modell-Kaltstart | Speicherbewusstes Vorwärmen der geplanten lokalen Modelle während Planung (Standardrolle), nach dem Plan (zugewiesene Modelle) und beim Run-Start; gleiches `num_ctx` wie der Agent (sonst lädt Ollama neu); nur wenn das Modell neben den bereits geladenen in 85 % des VRAM passt; `keep_alive` konfigurierbar (`keepAliveMinutes`), abschaltbar (`modelWarmup`) | `LocalModelsService.warmup`, `ExecutionService` |
| 2 Worktrees | Worktree-Pool (3 Slots/Projekt): Wiederverwendung per `checkout -B` + `reset --hard` + `clean -fdx -e node_modules` statt vollständigem Checkout; Fallback auf frischen Worktree; Recovery-kompatibel | `WorktreeManager` |
| 3 Repository-Index | Invalidierung über Datei-Watcher + Git-HEAD: ohne Änderung kein Datei-I/O, gemeldete Pfade einzeln (`refreshRepoIndex`), Vollscan nur bei HEAD-Wechsel, unvollständiger Meldung oder ohne Watcher; Cache nur bei Änderung, asynchron | `RepoContextService`, `repo-index.ts` |
| 4 CLI-Erkennung | Erkennungs-Cache (10 min, invalidiert bei Login/Logout/Verbinden/Refresh); Einstellungen zeigen erst den gecachten Status, Refresh im Hintergrund | `OrchestratorService`, `OrchestratorConnect` |
| 5 Modelle-Ansicht | Hardware-Profil und Registry-Daten auf Platte gecacht (stale-while-revalidate) | `LocalModelsService` |
| Start | IDE erscheint sofort aus dem zuletzt bekannten Zustand (gecachte Einstellungen, letztes Projekt); Laufzeitaufrufe warten im Main-Prozess, danach Abgleich; ein Lookup (inkl. Git-Prozess) weniger; NestJS-Startlog gefiltert | `sync.showCachedShell`, `main.ts` |
| Editor | Monaco wird im Leerlauf vorgeladen (Lazy-Load ohne Wartezeit beim ersten Öffnen) | `sync.boot` |
| Logs | Live-Logzeilen pro Event-Batch statt pro Event angehängt | `sync.appendLive` |

### 4.2 Ergebnisse (gleiche Bedingungen, `perf-before-rerun-2026-10-12T08-25-25-243Z.json` → `perf-after-phaseC-2026-10-12T08-35-50-517Z.json`)

| Vorgang | vorher p50 / p95 | nachher p50 / p95 | Veränderung (p95 bzw. Wert) |
|---|---:|---:|---:|
| Navigation zwischen Ansichten | 2,4 / **712 ms** | 3,8 / **8,7 ms** | −98,8 % |
| Modelle-Ansicht nach App-Neustart | **2 959** / 3 163 ms | **15** / 109 ms | −99,5 % (p50) |
| `GET /orchestrator` | **152** / 171 ms | **0,8** / 1,9 ms | −99,5 % (p50) |
| Erste Datei nach Start öffnen | 109 ms | 87 ms | −20 % |
| Kleine Datei öffnen | 18,6 / 25,9 ms | 15,6 / 22,3 ms | −16 % |
| Tab-Wechsel bis Inhalt sichtbar | 14,4 / 26,6 ms | 11,6 / 16,5 ms | −38 % (p95) |
| Geladenen Chat öffnen | 5,1 / 6,6 ms | 3,6 / 14,6 ms | ≈ (beide < 15 ms) |
| Chat-Eingabe | 4,9 / 6,2 ms | 4,8 / 6,1 ms | ≈ |
| 2 000 Logevents: Renderer-CPU | 257 ms | 176 ms | −32 % |
| Start → IDE sichtbar | 1 111 ms | **319 ms** | −71 % |
| Start → Arbeitsstand wiederhergestellt | – (Tabs/Session gingen verloren) | 800 ms | neu |
| Reload → IDE / → Tabs wieder da | 66 ms / – | 54 / 139 ms | Tabs neu wiederhergestellt |
| Laufzeit-Start | 573 ms | 528 ms | −8 % |

Engine (`engine-baseline-…` → `engine-phaseC-…`, 5 000 Dateien):

| Vorgang | vorher | nachher | Veränderung |
|---|---:|---:|---:|
| Index-Aktualisierung ohne Änderung | 647 ms (Vollscan) | ~30 ms (nur HEAD-Prüfung) | −95 % |
| Index nach einer geänderten Datei | 596 ms | 26 ms | −96 % |
| Worktree anlegen pro Teilaufgabe | 2 768 ms | 358–388 ms (Pool) | −86 % |
| Worktree entfernen pro Teilaufgabe | 1 525 ms | 350–376 ms (Pool) | −75 % |
| Erster lokaler Agentenaufruf (7B) | 21,7 s (Kaltstart, Datei-Cache kalt) bzw. 16 s | 0,30 s nach Vorwärmen | Ladezeit läuft parallel zur Planung |

Nicht verbessert / offen: Erstbesuch der Modelle-Ansicht in einem **neuen** Profil (~2,6 s, Hardware-Erkennung
und Registry ohne Cache); Laufzeit-Start ~0,5 s (Nest + Prisma + Recovery) – durch die sofort sichtbare IDE nicht
mehr wahrnehmungsrelevant. Premium-Aufrufe (Claude/Codex) wurden nicht gemessen (Abo-Kontingent).

## 5. Weitere Beschleuniger aus Phase C (Kurzbeschreibung)

**Fast Path** (`packages/engine/src/fastpath/fast-path.ts`, Einstellung „Fast Path“, Standard an): Vor der
Premium-Planung wird die Anfrage regelbasiert klassifiziert (keine Modellaufrufe):

| Regel | Ergebnis |
|---|---|
| „formatieren/format“ + benannte Dateien, Prettier im Projekt | deterministisches Werkzeug `prettier --write` |
| „lint/eslint … fix“ + benannte Dateien, ESLint im Projekt | `eslint --fix` |
| „Importe organisieren/organize imports“ + TS/JS-Datei | TypeScript-LanguageService `organizeImports` |
| „umbenennen/rename X in/zu Y“ (Funktion, Variable, Komponente, Typ, Interface …) | TypeScript-LanguageService `findRenameLocations` |
| genau eine benannte Datei, kurze Anfrage ohne Architektur-/Sicherheits-/Mehrdatei-Signale, Kostenmodus ≠ quality, lokales Modell verfügbar | ein lokaler Agent ohne Premium-Planung |
| sonst | normale Planung |

Werkzeug-Teilaufgaben laufen ohne Modell (Ausführer „deterministic“) mit voller Validierung; scheitert ein
Werkzeug, übernimmt ein Agent. GUI-Test: `e2e/fast-path.test.mjs` (Umbenennen in 5,75 s inkl. Typecheck und Tests,
0 Modellaufrufe).

**Diagnose-Dashboard** (Aktivitätsleiste → „Diagnose & Performance“): nur gemessene Werte – Laufzeit (RSS, Heap, CPU),
System (CPU-Last, RAM, GPU/VRAM über `nvidia-smi`), geladene Modelle, Tokens/s je Modell, Vorwärmungen,
CLI-Statuszeiten, Premium-Aufrufdauern, Job-Warte-/Laufzeiten, Validierungsdauern, Cache-Trefferquoten,
p50/p95 je API-Route, langsame Operationen (≥ 200 ms), Renderer-Long-Tasks und Startmarken; exportierbar als
JSON-Bericht ohne Geheimnisse: keine Umgebungsvariablen, Tokens, Prompts oder Dateiinhalte; API-Routen ohne
Query-Parameter (dort stünden Dateipfade) und mit maskierten IDs; App-Angaben ohne Datenordner.

**Chat-Sitzungen der Orchestrator-CLIs**: Folgefragen einer Sitzung setzen die CLI-Sitzung fort
(`--resume` / Codex-Thread) statt Kontext und Verlauf erneut zu senden; schlägt die Fortsetzung fehl, wird
automatisch ohne sie neu gefragt.

## 6. Leistungsprüfung nach den Erweiterungen (Phasen D–F)

Nach Plugins, Skills, MCP und IDE-Funktionen wurde dieselbe Messung wiederholt. Sie zeigte **echte Rückschritte**,
die behoben wurden, bevor die Phasen als abgeschlossen galten:

| Messung (p50) | Phase C | nach D–F, vor Korrektur | Ursache | Korrektur |
|---|---:|---:|---|---|
| Laufzeit-Start | 528 ms | 676 ms | 14-MB-Bundle wird bei jedem Start von V8 kompiliert (≈ 160 ms im CPU-Profil); MCP-SDK beim Start ausgewertet; Plugin-Registrierung vor `listen` | **V8-Compile-Cache** im Datenordner (`boot.cjs` aktiviert ihn, Flush nach dem Start; Messung: 520 → 356 ms bei warmem Cache), MCP-SDK erst beim ersten Verbindungsaufbau, Plugins 1,5 s nach der Bereitmeldung; außerdem griff der Nest-Startlog-Filter wegen umbenannter Klassen (`_RouterExplorer`) nicht – behoben |
| Erste Datei öffnen | 87 ms | 188 ms | TypeScript-Programmaufbau (Live-Diagnosen) lief synchron im Laufzeit-Thread und blockierte andere Anfragen | Sprachdienst in einem **Worker-Thread** (`ts-worker`), eigener Compile-Cache |
| Start → Arbeitsstand | 800 ms | 970 ms | beide oben | beide oben |

Verworfen nach Messung: Lazy-Loading der Seitenpanels. Es verkleinerte das Start-Bundle (833 → 721 KB), brachte
beim Start aber keinen messbaren Gewinn und verlangsamte den ersten Besuch einer Ansicht um ~300 ms – zurückgenommen.

Endstand (drei Läufe nacheinander, `perf-final-1/-2/-3-2026-10-12…json`; die Streuung zwischen Läufen auf diesem
Rechner beträgt bis ±15 %, deshalb Spannbreiten):

| Vorgang | Phase C | Endstand (3 Läufe) |
|---|---:|---:|
| Laufzeit-Start | 528 ms | 438 / 464 / 517 ms |
| Start → IDE sichtbar | 319 ms | 319 / 356 / 388 ms |
| Start → Arbeitsstand wiederhergestellt | 800 ms | 716 / 762 / 908 ms |
| Erste Datei öffnen | 87 ms | 95 / 91 / 124 ms |
| Navigation p95 | 8,7 ms | 10,4 / 10,8 / 10,9 ms |
| Reload → Tabs wieder da (p50) | 139 ms | 143 / 151 / 179 ms |
| 2 000 Logevents: Renderer-CPU | 176 ms | 163 / 200 / 218 ms |
| Modelle nach Neustart (p50) | 15 ms | 14 / 14 / 45 ms |

Bewertung: Der Laufzeitstart ist schneller als nach Phase C; die übrigen Werte liegen im Bereich der Messstreuung,
im Mittel leicht darüber (Start → IDE sichtbar im Mittel +11 %, Navigation p95 +2 ms). Gegenüber der ursprünglichen
Baseline bleiben alle Verbesserungen aus Abschnitt 4 erhalten (z. B. Start → IDE 1 111 → 319–388 ms, Navigation
p95 712 → ~11 ms).

Gepackte App (`e2e/packaged-smoke.test.mjs`, NSIS-Build, frisches Profil, Kaltstart ohne Compile-Cache):
Laufzeit bereit nach 927 ms ab Prozessstart.
