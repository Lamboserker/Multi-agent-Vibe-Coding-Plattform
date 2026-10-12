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
