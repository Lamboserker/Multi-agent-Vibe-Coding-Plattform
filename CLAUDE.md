# Multi-AI Coder

Desktop-Coding-IDE: ein Premium-Orchestrator (OpenAI Codex CLI oder Claude Code CLI, Login des Nutzers) plant,
kleine lokale Modelle (Ollama) führen präzise Teilaufgaben in isolierten Git-Worktrees aus; Review und Integration
übernimmt die Engine. Architektur und Entscheidungen: `docs/desktop-architecture.md`.

## Struktur
- `apps/desktop` – Electron-App (Main + React-Renderer, Leitstand-UI)
- `apps/api` – lokale NestJS-Laufzeit (Planung `execution/`, Agentenprofile `agents/`, Skills `skills/`, MCP, Plugins)
- `packages/engine` – Orchestrator-Adapter (`orchestrator/`), Fallback-Planer (`planning/`), Routing, lokale Agenten, Ausführung
- `prisma` – Schema (SQLite) und Migrationen
- `skills/` – mitgelieferte Skills; Nutzer-Skills liegen im App-Profil
- `apps/web`, `apps/worker` – ältere Web-/Worker-Variante (nur `pnpm dev:web`)

## Befehle
- `pnpm dev` – Desktop-App im Dev-Modus (Vite auf :5199)
- `pnpm typecheck` · `pnpm test` · `pnpm lint`
- einzelnes Paket: `pnpm --filter @multi-ai-coder/engine test`, `pnpm --filter @multi-ai-coder/api test`
- `pnpm prisma:generate` · `pnpm package:desktop` (electron-builder immer über `pnpm exec`, nie `npx`)

## Regeln
- **Keine Live-Aufrufe** von `claude`/`codex` (Planung, Ausführung, Diagnose-Calls) ohne ausdrückliche Zustimmung – sie
  kosten das Kontingent des Nutzers. Prompts über Unit-Tests prüfen.
- **Codex arbeitet in derselben Arbeitskopie.** Unerwartete Dateiänderungen nicht überschreiben oder zurücksetzen, sondern melden.
- UI-Texte Deutsch, Code und Code-Kommentare Englisch. Stil der umgebenden Datei übernehmen.
- Migrationen nur additiv (`ALTER TABLE … ADD COLUMN`, SQLite-Syntax wie in `prisma/migrations/`); nie Daten löschen.
- `PLAN_SCHEMA` & Co. sind strict JSON-Schemas: jedes Feld in `required`, `additionalProperties: false`.
- Produktprinzip: kleine lokale Modelle müssen Tasks lösen können → präzise Einzeldatei-Tasks statt Premium-Eskalation.
- Commits nur auf Nachfrage.

## Umgebung (Windows)
- Dev-Profil der App: `%APPDATA%\Multi-AI Coder Dev` (DB `multi-ai-coder.db`, Skills, Logs). `%APPDATA%\Multi-AI Coder`
  gehört der installierten App und bleibt unangetastet.
- Läuft `pnpm dev`, scheitert `prisma generate` am Lock auf `query_engine-windows.dll.node`: `index.js`/`index.d.ts` sind
  trotzdem neu; `prisma/schema.prisma` in den `.prisma/client`-Ordner kopieren und die `.tmp`-DLL löschen. Dev-Instanz nicht beenden.
- Kein Python auf dem Rechner – Skripte in Node (`node:sqlite` für read-only DB-Abfragen).
- Ollama: :11434 (System) und :11435 (App-Instanz mit `D:\ollama-models`).

## KI-Projektdoku und Handoff
Dieses Projekt nutzt `docs/ai/` (Skill: projekt-doku).
- Session-Start: Ein SessionStart-Hook lädt `docs/ai/CONTEXT.md` und die Übergabe des aktiven Tasks automatisch
  (auch nach `/clear`). Danach `/weiter` – liest `docs/ai/lessons.md` und das aktive Task-File und macht weiter.
- Vor `/clear` oder bei vollem Kontext: `/handoff` – Task-Log, `## Übergabe` und CONTEXT.md aktualisieren.
- Jede Aufgabe ab ~3 Schritten bekommt ein Task-File (`docs/ai/tasks/TASK-NNN-slug.md`); nach Abschluss AI-Log-Eintrag
  mit ehrlicher Selbstbewertung (A–D), Task nach `tasks/done/`, CONTEXT.md aktualisieren.
- Gültige Entscheidungen: `docs/ai/decisions/`. Phasenpläne: `docs/ai/plans/`.
- Abgeschlossene Tasks und alte Logs nur bei Bedarf lesen.

## Subagents (`.claude/agents/`)
- `sucher` (Haiku): Dateien, Symbole, Texte finden – read-only.
- `entwickler` (Sonnet): klar spezifizierte Routine-Schritte, Tests schreiben und ausführen.
- `experte` (Opus): modulübergreifende/schwierige Änderungen, Schema/Migration, Abschluss-Review jeder Phase.
- Der Hauptagent delegiert mit selbsttragenden Aufträgen, prüft die Ergebnisse und ist der Einzige, der `docs/ai/` schreibt.
