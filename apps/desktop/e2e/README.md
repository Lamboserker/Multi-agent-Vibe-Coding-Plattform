# Live end-to-end test

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
