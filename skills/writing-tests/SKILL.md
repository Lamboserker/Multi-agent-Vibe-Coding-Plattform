---
name: writing-tests
description: How to add or fix automated tests so they match the project's existing test setup. Use when a task asks for tests, a failing test, or test coverage.
triggers: [test, tests, testing, vitest, jest, mocha, pytest, coverage, spec, unit, e2e, testfall, testen]
---
# Writing tests

1. **Find the existing setup first.** Look at `package.json` scripts (`test`, `test:unit`), config files
   (`vitest.config.*`, `jest.config.*`, `playwright.config.*`, `pytest.ini`, `pyproject.toml`) and one or two
   existing test files next to the code you change. Copy their structure: file naming (`*.test.ts` vs
   `*.spec.ts`, `__tests__/`), import style, helpers, fixtures.
2. **Never add a new test framework** or new dev dependency when one exists. If the project has no tests at
   all, say so in the summary instead of inventing a setup.
3. **Test behaviour, not implementation.** One `describe` per unit, one `it` per behaviour, names that read as a
   sentence ("returns 0 for an empty cart"). Cover the happy path, one edge case and one error case.
4. **Deterministic tests only:** no real network, no sleeps (use fake timers), no dependence on the current
   date or on test order. Temporary files go into a temp directory that the test removes.
5. **Keep assertions specific** (`toEqual` on the exact value, `toThrow(/message/)`), avoid snapshot tests for
   logic.
6. For a **bug fix**, first write the test that reproduces the bug, then fix the code; the test must fail
   without the fix.
7. Run only the affected test file when iterating (`vitest run path/to/file.test.ts`,
   `jest path/to/file`, `pytest path::test_name`), then the whole suite once.
