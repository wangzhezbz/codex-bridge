# Router remediation record 59: cross-platform history sidebar recovery

Date: 2026-07-19

## Symptom

- macOS could scan historical Codex threads and calculate planned inserts, but the apply action stopped with “完整会话侧栏恢复目前仅支持 Windows”。
- Some Windows users who had already closed ChatGPT / Codex still could not migrate because CodexBridge could not rediscover a trusted automatic restart target.
- A fully verified migration was reported as failed when the desktop app had to be reopened manually.

## Root cause

- The coordinator called a Windows-only desktop stop helper even though the underlying catalog scanner, backup, SQLite transaction, sidebar synchronization, rollback, and verification code is platform-neutral.
- macOS had app location and restart support elsewhere in the desktop host, but the history-recovery worker had no macOS process probe or quit path.
- The worker treated an automatic restart target as a prerequisite for writing, rather than a convenience after ChatGPT / Codex was confirmed stopped.
- The renderer recognized only the `restarted` terminal phase and ignored a verified migration that required a manual reopen.

## Repair

- Added exact main-process detection for ChatGPT.app and Codex.app on macOS. Helper, Classic, and CodexBridge processes are excluded.
- Added macOS graceful quit, bounded exit polling, database-write gating, and app-bundle restart.
- Kept the fail-closed rule: if process detection fails or any desktop process remains, no catalog write starts.
- Allowed Windows and macOS migration to continue after the user has already closed the desktop app even when no trusted automatic restart target is available.
- Added the successful `completed` phase for verified migrations that require the user to reopen ChatGPT / Codex manually.
- Kept the durable pending plan and the “我已手动退出，重新检测” retry path.

## Verification

- Recovery suite: 16/16 passed.
- Targeted main/flow/renderer suite: 114/114 passed.
- Full desktop regression suite: 853/853 passed.
- Fixtures cover macOS app processes, user paths containing spaces, process-probe failure, verified manual restart, 147-thread catalog gaps, backups, rollback, and idempotent reruns.

## Safety boundary

This change does not alter Router request routing, provider selection, model definitions, API keys, the double-quota service, or normal ChatGPT / Codex restart behavior. History recovery still writes only after the desktop process list is confirmed empty, creates a complete backup, uses a SQLite transaction, and reports success only after catalog and sidebar reread verification.
