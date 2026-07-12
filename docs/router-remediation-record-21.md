# Router remediation record 21

Date: 2026-07-12

## User report

- ChatGPT Desktop displayed a Router `HTTP 502` / `UND_ERR_CONNECT_TIMEOUT` failure.
- The CodexBridge real-time log page still showed only startup and history-recovery messages.
- The missing request and error lines prevented diagnosis on the separate test machine.

## Root cause

- The Router child process already emitted access, upstream, status, timeout, and proxy diagnostics to stdout/stderr.
- The desktop main process already captured those streams and published the complete bounded buffer through `logs:update`.
- The preload bridge also exposed `onLogs`, so the main-to-renderer IPC chain was intact in the distributed package.
- The renderer handled `logs:update` by changing only the log DOM. It did not update `state.logs`.
- Opening the log navigation item calls `renderActiveSection("logs")`, which rendered the older `state.logs` snapshot over the live DOM. This made successful live delivery appear as if the Router had never logged the request.

## Corrected behavior

- Every `logs:update` event first copies the latest bounded log buffer into renderer state.
- The visible log output is then rendered from the same buffer.
- Opening or reopening the log page can no longer replace request/error lines with the startup snapshot.
- Existing Router log capture, usage parsing, diagnostic copying, and the 300-line bound remain unchanged.

## TDD evidence

- Added a regression assertion requiring the `onLogs` handler to retain live lines in renderer state before rendering.
- RED: renderer suite 47 passed, 1 failed; the new test proved that `onLogs` only called `renderLogs`.
- GREEN: renderer suite 48 passed, 0 failed after the minimal state synchronization.

## Files changed

- `desktop/renderer/app.js`
- `tests/desktop-renderer.test.js`
- `docs/router-remediation-record-21.md`

## Remaining environmental diagnosis

- The screenshot's `UND_ERR_CONNECT_TIMEOUT` is a real upstream connectivity failure on the test machine, separate from this display defect.
- With this correction, the next test run will retain the request route, upstream URL, status, timeout cause, and effective proxy diagnostics needed to distinguish proxy/VPN reachability from provider reachability.

## Verification and test package

- Full `npm run check`: 777 passed, 0 failed.
- `npm run desktop:smoke`: passed.
- Packaged desktop and Router lifecycle smoke: passed.
- Packaged renderer inspection: live log state retention present.
- `git diff --check`: exit 0; only existing line-ending warnings remain.
- Archive: `dist-artifacts/test-20260712-0300/CodexBridge-Windows-x64-Portable.zip`
- Size: 141,380,259 bytes.
- Entries: 720; unsafe paths: 0; duplicate paths: 0; root `CodexBridge.exe`: 1.
- SHA-256: `EB677545060436C314E0F78EAC209155938A92665C76DA54FC8BE1FEA3EC63DB`
