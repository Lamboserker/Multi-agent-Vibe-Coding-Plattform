---
id: TASK-022
titel: Hardware-Anzeige: Echtzeit und ehrlicher Modellstatus
status: in-arbeit   # offen | in-arbeit | blockiert | done
erstellt: 2026-10-21
phase: 9
plan: plans/2026-10-21-duo-hardware-lokal.md
---

# TASK-022: Hardware-Anzeige: Echtzeit und ehrlicher Modellstatus

## Ziel
Siehe Abschnitt TASK-022 im Plan `plans/2026-10-21-duo-hardware-lokal.md`.

## Akzeptanzkriterien
- [x] Umsetzung laut Plan
- [x] Tests grün (api 228, desktop 97, engine 380)
- [ ] Sichtprüfung nach Neustart von `pnpm dev` (TASK-027)
- [x] Voller `pnpm lint` nach TASK-024 (grün)

## Log

## Übergabe
- 2026-10-21 (`experte`): umgesetzt.
  - Ein 1-s-Live-Sampler läuft, solange Snapshot-Anfragen kommen, und stoppt 5 s nach der letzten.
  - Snapshot: `sampledAt`/`intervalMs`, beide Instanzen (`extraOllamaUrls`, Default ist der andere Port und folgt
    `ollamaBaseUrl`).
  - Pro Modell: `state`, `unloadsInSec`; dazu `vram.appModelsGb/otherGb`.
  - VRAM-Warnung: unterscheidet Auslagerung von „belegt durch andere Prozesse".
  - nvidia-smi: erneuter Versuch nach 30 s.
  - `unloadAfterRun` (Default true): `unloadRunModels` im `finally` von `runJob`. Ausgenommen sind andere aktive
    Läufe und frische Warm-ups für andere Tasks; beim Shutdown wird nichts entladen.
  - Warm-up beim Planungsstart entfernt; manuelles Laden nutzt `keepAliveMinutes`.
  - Popover: Live-Label, Status pro Modell, „Entladen" und „Alle entladen", Lücken statt 0.
  - Risiken:
    - Der „Entladen"-Knopf ist auch während der Generierung sichtbar.
    - Die Historie mischt sich nach einer langen Pause.

Übergabe: Sichtprüfung offen (TASK-027).
