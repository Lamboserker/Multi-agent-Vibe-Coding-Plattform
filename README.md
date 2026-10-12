# Multi-AI Coder

Desktop coding IDE in which a premium orchestrator – **Claude Code** or **OpenAI Codex**, signed in with your existing subscription – plans, delegates and reviews, while **local coding models (Ollama)** do most of the implementation. Every change is produced in an isolated git worktree, validated (patch checks, typecheck, tests) and only applied after your approval.

See [docs/desktop-architecture.md](docs/desktop-architecture.md) for architecture, decisions and status.

## Requirements

- Node.js ≥ 22, pnpm 10, Git
- Optional but recommended: [Ollama](https://ollama.com) (the app can install it via winget/brew after you confirm)
- One orchestrator CLI, signed in via its official login: `claude` (Claude Code) or `codex` (Codex CLI)

No PostgreSQL, Redis or Docker is needed: the app uses a local SQLite database and a built-in job queue.

## Start (development)

```bash
pnpm install
pnpm prisma:generate
pnpm dev            # builds everything and starts the desktop app (Electron)
```

- `MAC_DEVTOOLS=1 pnpm dev` additionally opens the renderer DevTools.
- If you start from a VS Code terminal, the dev script removes `ELECTRON_RUN_AS_NODE` automatically (VS Code sets it, which would make Electron behave like plain Node).
- App data (database, worktrees, logs) lives in `%APPDATA%\Multi-AI Coder` (Windows), `~/Library/Application Support/Multi-AI Coder` (macOS) or `~/.config/Multi-AI Coder` (Linux).

### Legacy web UI (optional)

```bash
pnpm dev:web        # local runtime on 127.0.0.1:4000 + Next.js UI on http://localhost:3000
```

The web UI uses its own user login; the desktop app is the primary interface. The old BullMQ worker (`pnpm dev:legacy-worker`) is superseded by the built-in job queue and needs Redis.

## Build an installer

```bash
pnpm package:desktop   # → apps/desktop/release/Multi-AI Coder Setup <version>.exe (Windows NSIS)
```

macOS (`dmg`) and Linux (`AppImage`, `deb`) targets are configured in `apps/desktop/electron-builder.yml` and must be built on the respective OS.

## Tests

```bash
pnpm --filter @multi-ai-coder/engine test     # engine: worktrees, patches, scheduler, router, agents, adapters …
pnpm --filter @multi-ai-coder/desktop test    # IPC validation
pnpm typecheck
```

The live end-to-end test (real Ollama model + real orchestrator) is opt-in, see `apps/desktop/e2e/README.md`.
