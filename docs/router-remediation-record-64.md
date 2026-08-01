# Router remediation record 64: lifecycle ordering and exact Windows file identity

Date: 2026-07-20

## Risks addressed

1. The managed application quit path stopped the independent Double Quota service before Router configuration cleanup had succeeded. A cancelled quit could therefore stop an unrelated service unnecessarily.
2. A failed Router start stopped the child process before restoring managed Codex configuration. If restoration failed, Codex could be left pointing at a dead local Router.
3. Windows configuration transaction identity checks converted NTFS file IDs to JavaScript numbers. File IDs above `Number.MAX_SAFE_INTEGER` could round to the same value, allowing a replaced journal or staging directory to evade the identity-change check.

## Root causes

- Quit side effects were performed when quit was requested rather than after the cleanup-first Router lifecycle transaction completed.
- Failed-start rollback used process-first ordering instead of the same configuration-first safety invariant as explicit stop and quit.
- `fs.Stats.dev` and `fs.Stats.ino` were read as ordinary numbers. Distinct 64-bit NTFS file IDs can lose precision when represented as JavaScript `Number` values.

## Repairs

- Stop the Double Quota service only from the confirmed quit-ready callback. A Router cleanup failure now cancels quit without stopping the independent service.
- Restore managed Codex configuration before terminating a failed-start Router child.
- If failed-start restoration fails, retain the live Router child and local executor and return the existing rollback failure instead of publishing a false stopped state.
- Read path identities with `fs.promises.lstat(path, { bigint: true })` for journal files, the journal directory, and private staging directories.
- Keep existing normal-number file type, size, permission, and link-count validation unchanged; BigInt is used only for exact identity comparison.

## Regression boundaries

- No model selection, provider routing, request conversion, failover, rate-limit, image generation, history, or usage-accounting logic was changed.
- Normal Router start, stop, restart, watchdog, and application quit behavior remains unchanged when configuration restoration succeeds.
- Double Quota remains independent from Router start and stop; it is stopped only when the application is actually ready to quit.
- The Windows identity hardening changes only transaction race detection and does not change target paths or configuration bytes.

## Test-first evidence

- Three lifecycle regression tests failed before the implementation change:
  - quit request stopped Double Quota before quit confirmation;
  - failed-start rollback stopped the process before cleanup;
  - failed cleanup still stopped the failed-start process and executor.
- The existing Windows journal-directory replacement regression test failed consistently before exact BigInt identities were used. Live inspection confirmed two different NTFS file IDs rounded to the same normal-number `dev:ino` string.

## Verification

- Lifecycle and impacted desktop suites: 163/163 passed.
- Configuration transaction suite: 59/59 passed.
- Full syntax, Router, desktop, and recovery check: 860/860 passed; recovery subset 16/16 passed.
- Packaged Electron desktop smoke: passed in 98 seconds.
- `git diff --check`: clean.
