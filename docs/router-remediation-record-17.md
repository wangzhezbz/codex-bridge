# Router remediation record 17

Date: 2026-07-12

## Reported symptom

- Clicking the running Router switch returned `router:stop` / `ConfigTransactionError: Configuration transaction failed`.
- The UI continued to show Router running and the local gateway could not be turned off.

## Root cause

- The explicit stop lifecycle awaited managed ChatGPT/Codex configuration cleanup before attempting to terminate the Router child process.
- A configuration transaction error therefore exited the stop function before the first process termination instruction.
- The existing lifecycle test explicitly encoded this unsafe cleanup-first behavior, so it protected the bug instead of the user's primary stop action.

## Changes

- A managed configuration cleanup failure no longer blocks an explicit Router shutdown.
- The lifecycle records a sanitized cleanup warning, terminates the Router, waits for confirmed child exit, stops the local executor, publishes stopped state, and returns success with the warning.
- The renderer reports that Router is closed while clearly warning that the original ChatGPT/Codex configuration was not restored; it includes the safe diagnostic cause code.
- Runtime and normal logs distinguish a clean stop from a confirmed stop with cleanup failure.
- Process termination failures remain hard failures and cannot be mislabeled as a successful stop.

## TDD evidence

- The regression test injects the exact `ConfigTransactionError` family from the report.
- Before the fix, the test failed with the configuration error and observed no process kill.
- After the fix, the child receives a stop signal, exits, stopped state is published, and the result contains `managed_config_cleanup_failed`.
- Separate renderer and desktop-main tests verify the warning shown to the user and the non-misleading log entry.

## Files changed

- `desktop/router-lifecycle.mjs`
- `desktop/main.cjs`
- `desktop/renderer/app.js`
- `tests/desktop-router-lifecycle.test.js`
- `tests/desktop-main-route-sync.test.js`
- `tests/desktop-renderer.test.js`

## Verification

- Focused lifecycle suite: 16 passed, 0 failed.
- Focused renderer warning test: passed.
- Focused desktop-main logging test: passed.
- Full `npm run check`: 776 passed, 0 failed.
- Source desktop smoke: passed.
- Packaged desktop and Router lifecycle smoke: passed.
- `git diff --check`: passed.

## Test package

- Archive: `dist-artifacts/test-20260712-0138/CodexBridge-Windows-x64-Portable.zip`
- Size: 141,374,236 bytes.
- Entries: 716; unsafe paths: 0; duplicate paths: 0; root `CodexBridge.exe`: 1.
- Packaged source checks: lifecycle fallback and renderer warning are present.
- SHA-256: `356772B63E5DD4A3AB1F83D3C97927614AACA67DCB8A3A90ED08647FCBC9925B`
