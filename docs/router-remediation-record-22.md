# Router remediation record 22

Date: 2026-07-12

## User report

- CodexBridge reported 39 sessions under project `aaa`.
- ChatGPT Desktop initially displayed only five session titles below `aaa`.
- The two screens appeared to disagree about whether the remaining project sessions existed.

## Evidence and root cause

- The ChatGPT screenshot shows an `展开显示` control immediately below the fifth session.
- ChatGPT Desktop therefore has more project sessions available but collapses the project list to a recent subset by default.
- CodexBridge reads `local_thread_catalog` from `codex-dev.db` and groups non-missing local history rows by their recorded `cwd` and current workspace roots.
- That value is a local history index total. It is not a measurement of how many rows the ChatGPT sidebar currently expands.
- The CodexBridge labels `项目内会话` and `39 个会话` incorrectly implied that both screens used the same visible-row count.

## Corrected behavior

- The session overview now labels the values as `本机历史会话索引`, `项目历史索引`, and `无项目历史会话`.
- Each project displays `N 个本地历史会话` instead of claiming that N rows are currently visible in ChatGPT.
- A visible note explains that ChatGPT normally expands only a recent subset and that `展开显示` reveals the remaining sidebar sessions.
- Project recovery remains limited to the supported `--open-project` workflow. CodexBridge does not modify ChatGPT databases, pin threads, or fabricate sidebar assignments.

## TDD evidence

- Added a renderer regression test requiring the history-index labels and the ChatGPT sidebar expansion explanation.
- RED: renderer suite 48 passed, 1 failed because the old UI still used `项目内会话`.
- GREEN: renderer suite 49 passed, 0 failed after the minimal wording correction.

## Files changed

- `desktop/renderer/app.js`
- `tests/desktop-renderer.test.js`
- `docs/router-remediation-record-22.md`

## Verification and combined test package

- Full `npm run check`: 778 passed, 0 failed.
- `npm run desktop:smoke`: passed.
- Packaged desktop and Router lifecycle smoke: passed.
- Packaged renderer inspection: live-log retention, history-index labels, and sidebar expansion note are present.
- `git diff --check`: exit 0; only existing line-ending warnings remain.
- Archive: `dist-artifacts/test-20260712-0400/CodexBridge-Windows-x64-Portable.zip`
- Size: 141,381,861 bytes.
- Entries: 721; unsafe paths: 0; duplicate paths: 0; root `CodexBridge.exe`: 1.
- SHA-256: `073B0AC30F317269FF0D5F50B1C5C36F10666D2C86CA1C32813D3915AAD8C75B`
