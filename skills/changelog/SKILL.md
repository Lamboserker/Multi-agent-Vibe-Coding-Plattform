---
name: changelog
description: How to write CHANGELOG entries (Keep a Changelog format) from the commits since the last release. Use when asked to update the changelog or write release notes.
triggers: [changelog, release notes, release, versionshinweise, änderungsprotokoll]
---
# Changelog entries

Format: [Keep a Changelog](https://keepachangelog.com/) – newest version on top, sections in this order:
`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`. Unreleased changes go under
`## [Unreleased]`.

1. Collect the changes since the last release. If the script of this skill is approved, call
   `run_skill_script` with skill `changelog` and script `scripts/recent-changes.mjs`; it prints the commit
   subjects since the last tag (or the last 50 commits). Otherwise read the existing CHANGELOG and the task.
2. Write one line per user-visible change, in the imperative and from the user's point of view
   ("Add export of sessions as Markdown"), not commit-speak ("refactor foo").
3. Group related commits into one entry; leave out pure refactorings, test-only and CI-only changes.
4. Keep the existing style of the file (language, bullet style, links to issues like `(#123)`).
