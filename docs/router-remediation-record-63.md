# Router remediation record 63: lifecycle cleanup fail-safe and watchdog recovery

Date: 2026-07-20

## Risk addressed

1. An explicit Router stop or application quit could terminate Router even when the managed Codex configuration failed to restore. Codex could then remain pointed at a dead local port.
2. After the Router watchdog exhausted all automatic restart attempts, it stopped retrying without restoring the original Codex configuration.

## Root causes

- Lifecycle cleanup failures were converted into warnings, so process termination continued after the configuration transaction had already failed.
- Watchdog exhaustion updated health state only; it did not enter the existing cleanup-first stop transaction.

## Repairs

- Treat managed configuration cleanup as a required precondition for Router process termination.
- On cleanup failure, keep Router alive, preserve the running lifecycle state, return the stable diagnostic code `ROUTER_CONFIG_CLEANUP_FAILED`, and expose the underlying bounded cause code.
- Cancel application quit when cleanup fails so the existing user-visible quit failure path can report the problem without leaving Codex on a dead route.
- After watchdog restart exhaustion, invoke the same cleanup-first lifecycle transaction used by explicit stops.
- Retry watchdog configuration recovery every five seconds when a transient file or transaction conflict prevents restoration.
- Cancel pending restart and recovery timers on explicit lifecycle actions.

## Regression boundaries

- Normal start, stop, quit, unexpected-exit, and confirmed process termination behavior remains unchanged when configuration cleanup succeeds.
- No provider selection, model routing, request conversion, failover, rate-limit, or usage-accounting behavior was modified.
- A failed cleanup can no longer publish a false stopped state or kill a still-required Router process.
- Watchdog recovery reuses the existing managed configuration transaction instead of adding a second configuration writer.

## Verification

- Lifecycle and desktop route-sync targeted tests: 69/69 passed.
- Full syntax, Router, desktop, and recovery check: 858/858 passed; recovery subset 16/16 passed.
- Electron desktop smoke: passed in 61 seconds, including packaged resource rendering and Router desktop integration.
- `git diff --check`: required clean before handoff.
