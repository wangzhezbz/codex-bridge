# Router remediation record 15

Date: 2026-07-12

## Reported symptoms

- A two-second HyperFrames video task stayed on step 3/5 for more than 17 minutes.
- The parent repeatedly created and closed replacement agents after delegated agents were interrupted.
- The final visible failure was `HTTP 504 - CodexBridge upstream request timed out after 300000ms` for GPT-5.6-Sol.
- ChatGPT could repeatedly show its loading or error screen and eventually stop opening conversations.

## Evidence correction

- A first local inspection found a corrupt process registry on the development machine. The user clarified that the failure occurred on another test machine, so that local finding was not used as the test-machine root cause and the related draft change was removed.

## Root cause

- Record 14 already changed healthy SSE streams so the route timeout ends after valid event-stream headers arrive. Therefore the new 300-second error occurs before a usable streaming response starts.
- Earlier diagnostics from the test flow showed the ChatGPT subscription request using the Windows local proxy and also recorded `UND_ERR_SOCKET`.
- CodexBridge retried direct after immediate proxy network errors, but an otherwise silent proxy connection that stalled until `UpstreamTimeoutError` was not refreshed or retried.
- During a delegated task, one stalled child request therefore waited five minutes, was interrupted, and caused the parent to create a replacement. Repetition stretched a tiny render task into a long retry loop and increased ChatGPT UI load.

## Changes

- Streaming requests through a configured proxy now use a dedicated response-header timeout capped at 60 seconds while retaining the configured route timeout for established SSE streams and non-proxy traffic.
- If the streaming proxy connection reaches that header timeout, CodexBridge removes only the cached proxy dispatcher entry and retries once with a new proxy connection.
- Existing active streams are not closed when the dispatcher entry is refreshed.
- Immediate proxy network failures keep the existing direct-fallback behavior.
- The Router log now emits `streaming_headers_timeout action=refresh_dispatcher` with the retry timeout.

## TDD evidence

- The regression test creates a proxy-backed GPT-5.6 streaming request whose first dispatcher never returns headers.
- Before the fix it failed with `UpstreamTimeoutError` and made one request.
- After the fix it creates a different proxy dispatcher, retries, receives a completed Responses SSE stream, and returns HTTP 200.

## Files changed

- `src/proxy.js`
- `src/upstream.js`
- `tests/upstream-proxy.test.js`

## Verification

- Focused Router and proxy suites: 237 passed, 0 failed.
- Full `npm run check`: 774 passed, 0 failed.
- Packaged desktop smoke: the first run reached `window-ready` but its UI-render probe timed out; no packaged process remained and no Router/proxy error was logged. A clean second run passed the complete desktop and Router lifecycle smoke.
- `git diff --check`: passed.

## Test package

- Archive: `dist-artifacts/test-20260712-0106/CodexBridge-Windows-x64-Portable.zip`
- Size: 141,370,800 bytes.
- Entries: 714; unsafe paths: 0; duplicate paths: 0; root `CodexBridge.exe`: 1.
- Packaged source check: proxy-refresh fix present.
- SHA-256: `59BF9C055F433B574A83453847B870FF4B3E5EE4691B6AED845E5287D70EBC94`
