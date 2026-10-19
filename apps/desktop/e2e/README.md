# Live end-to-end test

## GUI regression (no model calls)

The window is a shell with a navigation rail: **Leitstand** (orchestrator chat, plan, agents as graph
or tiles, inspector), **Code** (explorer/search/git, editor, terminal, agent changes), **Freigabe**
(the only place with approval controls), **Sitzungen**, **Modelle**, **Kosten** and **Setup**
(onboarding, settings, agents, plugins, skills, MCP, diagnostics). `Ctrl+Shift+L` and the footer entry
open the Leitstand. The helpers in `helpers.mjs` (`openProject`, `go`, `setupSection`, `codeView`,
`CHAT_MESSAGES`) encapsulate this navigation.

After building the desktop app, run without any premium/model calls:

```bash
node --test --test-concurrency=1 e2e/fast-path.test.mjs e2e/agents.test.mjs e2e/layout.test.mjs e2e/empty-repo.test.mjs \
  e2e/terminal.test.mjs e2e/energy.test.mjs e2e/ide-features.test.mjs e2e/plugins.test.mjs e2e/skills-mcp.test.mjs \
  e2e/session-persistence.test.mjs e2e/load-and-editor.test.mjs
```

- `fast-path`: real planning, isolated execution and project checks, the approval screen with the real
  diff, exactly one approval surface, the agent version in the editor, reload, apply and undo.
- `agents`: agent profiles (Setup → Agenten), automatic assignment at planning, change in the inspector.
- `layout`: splitters, collapse, maximize, persisted sizes, every screen at the 1024 px window minimum.
- `empty-repo`: a repository without commits is explained, the start is blocked, the initial commit is
  created on request and the run then goes through.
- `terminal`: Ctrl+click on a link in the terminal output opens it in the browser (plain click does not), search, rename, split.
- `energy`: tariff (unit price + base price) on the costs screen, live draw, metered energy and pro-rata base price.
- `session-persistence`: drafts, conversation history, renderer crash and app restart while switching screens.

## Premium live run

`live-react-component.test.mjs` drives the real desktop app (Playwright for Electron) through the
complete user flow – nothing is mocked:

1. a fresh test repository (`fixtures/react-app`, React + TypeScript + Vitest) is created and opened via the UI,
2. a React component is requested in the orchestrator chat,
3. the premium orchestrator plans the task (must not be the fallback planner),
4. the task is routed to the local Ollama model, which writes the code,
5. the change is produced in an isolated git worktree,
6. typecheck and tests run (must pass),
7. the diff is shown in the Monaco editor,
8. the user approves ("In Arbeitskopie übernehmen"),
9. the files exist in the repository and its own typecheck/tests pass.

Screenshots and a JSON report are written to `e2e/results/` (git-ignored).

## Requirements

- built desktop app: `pnpm --filter @multi-ai-coder/desktop build`
- Ollama with the chosen model installed (download it in the app – Modelle → Laden)
- the orchestrator CLI logged in with a subscription (`claude auth login` or `codex login`)

## Run

```bash
cd apps/desktop
MAC_E2E_LIVE=1 \
MAC_E2E_MODEL=qwen2.5-coder:7b \
MAC_E2E_OLLAMA_URL=http://127.0.0.1:11434 \
MAC_E2E_ORCHESTRATOR=codex \
MAC_E2E_CODEX_MODEL=gpt-5.6-luna \
pnpm test:e2e
```

Without `MAC_E2E_LIVE=1` the test is skipped (reported as skipped, not as passed). It uses a little
subscription quota (one planning call; more if the local model fails and the engine escalates).

## Last recorded run

2026-10-09, Windows 11, RTX 4060 Ti 16 GB: **passed** in 70 s – Codex (`gpt-5.6-luna`) planned one task,
`qwen2.5-coder:7b` implemented it on the first attempt (5,470 local tokens, 0 premium tokens during
execution), typecheck + 2 tests passed, change applied after approval.
Earlier runs on the same day exposed and led to fixes for: text-formatted tool calls of qwen2.5-coder
(now recovered and validated), repair rounds that did not show the model its own previous files
(now preloaded), and escalation to Codex when local attempts fail (worked as designed).
