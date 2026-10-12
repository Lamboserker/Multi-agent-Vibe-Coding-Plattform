# Architecture Notes

## Outcome

The MVP implements a cost-aware orchestrator, not an uncontrolled agent swarm. Every run starts with deterministic analysis, builds a small context snapshot, plans file-scoped subtasks, and routes each subtask through a central policy function.

## Flow

1. Project Manager registers a local repository path.
2. Repo Scanner reads deterministic metadata only: package scripts, frameworks, API routes, Prisma schema hints, tests, docs, and directory structure.
3. Context Builder selects relevant files and redacts secret-like content. It never sends the whole repository to an LLM.
4. Task Analyzer classifies complexity, task type, risk, context need, security sensitivity, and cost tier.
5. Cost Router chooses one model class from `no_llm`, `local_llm`, `free_llm`, `cheap_api_llm`, and `premium_llm`.
6. Planner creates subtasks with allowed files, denied files, validation commands, budgets, and escalation rules.
7. Agent Runner simulates execution in the MVP and records `AgentRun` rows.
8. Review Engine creates review verdicts and human-approval requirements.
9. Cost Ledger is represented by `AgentRun` cost fields and payment-ready `CreditLedger`.

## Safety Boundaries

- Secret-like files are excluded by scanner/context builder.
- Provider API keys are referenced by server-side env var names only.
- Real file-changing agent execution is blocked until worktree isolation and file locks exist.
- Production deployments and production migrations are not automated.
- Auth, payment, security, database migration, and infrastructure work requires human approval.

## Stubs

- Worker queue is wired with BullMQ but does not mutate files.
- Ollama/OpenAI-compatible/Gemini CLI adapters only test connectivity.
- Payment and Apple IAP are data-model/service stubs.
- Git worktrees, patch generation, file locks, and rollback are planned for the next phase.
