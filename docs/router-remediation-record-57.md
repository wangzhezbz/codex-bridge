# Router remediation record 57: startup configuration recovery retry

Date: 2026-07-18

## Symptom

Some Windows users briefly received `config_recovery_incomplete` on startup, while reopening the app later succeeded. The desktop previously attempted pending transaction recovery only once, so a short-lived file lock from another process, antivirus, or sync software was surfaced as a permanent recovery failure.

## Root cause and scope

- Startup transaction recovery had no bounded retry policy.
- The configuration coordinator correctly failed closed, but the desktop could not distinguish transient Windows file occupation from damaged, conflicting, or unsafe recovery journals.
- This change is limited to desktop startup recovery. Router request routing, model selection, provider adapters, and normal configuration transaction semantics are unchanged.

## Fix

- Added a bounded startup retry helper for recovery results whose pending entries are all transient filesystem codes (`EACCES`, `EAGAIN`, `EBUSY`, `EMFILE`, `ENFILE`, `EPERM`, or `ETXTBSY`).
- Mixed failures, conflicts, invalid journals, path violations, and other non-transient failures are never retried and remain fail-closed.
- Added concise Chinese diagnostics containing only the recovery stage, diagnostic code, and recovery ID; configuration paths, API keys, and secret values are not displayed.
- Added retry events to `desktop-runtime.log` for customer diagnosis.

## Test-first evidence

- The new startup-recovery test initially failed because `desktop/config-recovery-startup.cjs` did not exist.
- Targeted startup and desktop wiring tests: 54 passed, 0 failed.
- Configuration coordinator plus startup integration regressions: 113 passed, 0 failed.
- Full `npm run check`: passed all syntax, Router, desktop, and history-recovery gates.

## Safety boundary

This change does not delete `.transactions`, configuration files, or API keys. It does not auto-repair damaged journals and does not weaken the existing path, CAS, rollback, symlink, or ACL checks.
