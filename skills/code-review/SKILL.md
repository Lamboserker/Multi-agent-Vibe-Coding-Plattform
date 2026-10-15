---
name: code-review
description: Checklist for reviewing a change before it is merged (correctness, security, tests, scope). Use when asked to review, check or audit code or a diff.
triggers: [review, reviewen, prüfen, audit, diff, pull request, merge request, code review]
---
# Code review checklist

Review the change, not the whole file. Report findings ordered by severity with file:line and a concrete
fix; say explicitly when there is nothing to report.

**Correctness**
- Does the change do what the task says, completely? Edge cases: empty input, null/undefined, large input,
  concurrency, error paths.
- Off-by-one, wrong comparison, missing `await`, unhandled promise, mutated shared state.

**Security**
- User input reaching SQL, shell commands, file paths, HTML or `eval` without validation/escaping.
- Secrets in code, logs or error messages; overly broad permissions or CORS.
- Path traversal (`..`) and symlink handling for file operations.

**Tests**
- New behaviour has tests; a bug fix has a test that fails without the fix.
- Tests are deterministic (no network, no timing assumptions).

**Scope and maintainability**
- No unrelated changes (formatting churn, renamed files, dependency bumps) mixed in.
- Follows the existing conventions of the code around it; no dead code or commented-out blocks.
- Public API or schema changes are reflected in callers, migrations and documentation.
