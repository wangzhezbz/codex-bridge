# Router remediation record 19

Date: 2026-07-12

## Reported symptoms

- The latest ChatGPT sidebar showed several conversations while CodexBridge reported only one local conversation.
- Project/history recovery controls did not correct the session count.
- The user required locally retained history to be recovered rather than hidden by the new index.

## Root cause

- New ChatGPT/Codex installations can contain both `sqlite/codex-dev.db` (`local_thread_catalog`) and `state*.sqlite` history databases.
- CodexBridge treated any non-empty `local_thread_catalog` as a complete replacement for every `state*.sqlite` database.
- Even one catalog row therefore suppressed all additional user conversations retained in state databases and rollout files.
- The existing test explicitly expected this replacement behavior and labeled every state-only row stale.

## Changes

- The latest local thread catalog remains authoritative for duplicate thread IDs and its metadata wins.
- Additional non-archived user conversations from `state*.sqlite` are merged only when their referenced rollout file still exists as a real file.
- State-only rows without recoverable rollout evidence remain excluded, preventing deleted or stale database entries from inflating totals.
- Existing user-facing filtering still excludes archived and subagent conversations.
- Session tree totals, project grouping, search, and Markdown exports now operate on the merged deduplicated history automatically.

## TDD evidence

- The regression fixture contains one latest-catalog thread, one state-only row without a rollout, and one state-only row with a real rollout file.
- Before the fix, only the catalog thread was returned.
- After the fix, the catalog thread and recoverable state thread are returned while the stale row remains excluded.
- Catalog-only export and cross-database deduplication tests remain green.

## Real latest-structure evidence

- Read-only local comparison before the fix: latest catalog 104; unarchived user state rows 128; state-only rows 24.
- All 24 state-only rows referenced existing rollout files.
- The fixed session reader returned 128 deduplicated user sessions and reported no load-cap truncation.

## Files changed

- `desktop/settings.mjs`
- `tests/desktop-settings.test.js`

## Verification

- Focused merge, catalog export, and deduplication tests: 3 passed, 0 failed.
- Full `npm run check`: 776 passed, 0 failed.
- Packaged desktop and Router lifecycle smoke: passed.
- Packaged source check: recoverable-state merge is present.
- `git diff --check`: passed.

## Combined recovery test package

- Includes records 17-19: confirmed Router shutdown, GPT-5.6 custom image routing, and merged local history recovery.
- Archive: `dist-artifacts/test-20260712-0205/CodexBridge-Windows-x64-Portable.zip`
- Size: 141,377,832 bytes.
- Entries: 718; unsafe paths: 0; duplicate paths: 0; root `CodexBridge.exe`: 1.
- SHA-256: `4C5DCB8A553E1D356776A8D54F2DDCE3E7EC61ECD82609ABC8184F99A9854DB6`
