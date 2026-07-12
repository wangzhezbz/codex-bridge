# Router remediation record 14

Date: 2026-07-12

## Reported symptoms

- Long ChatGPT tasks ended with `HTTP 504` and `upstream request timed out after 300000ms`.
- ChatGPT could fall back to a full-window loading screen while CodexBridge was running.
- Statistics showed GPT-5.5, GPT-5.6 and Kimi rows even though automatic model selection and failover were disabled and the auxiliary model was GPT-5.6.

## Root causes

1. The upstream timeout covered the complete lifetime of an SSE response body. A healthy long-running stream was aborted at five minutes even after its response headers had arrived.
2. Automatic project restoration launched every missing project with a fixed 350ms gap. A machine with many historical projects could send a burst of `ChatGPT.exe --open-project` activations into the running ChatGPT process.
3. Usage data is persisted request history, but the page labelled matching routes as current and did not store route-plan provenance. The auxiliary-model setting only handles ChatGPT auxiliary model requests; it does not override normal conversation model selection.
4. The supplied log screenshot contains older client/runtime records (`0.142.3`, 23:58), so those lines are not evidence that the current package automatically enabled failover.

## Changes

- For streaming Responses and Chat Completions, the configured request timeout now protects connection/response-header establishment. Once a valid SSE response starts, the five-minute total-duration abort is removed while client cancellation remains active.
- Non-streaming and hung-before-headers requests still use the configured timeout.
- Automatic project recovery is sequential and waits for ChatGPT to expose each project as active (or for a bounded wait to expire) before launching the next project.
- Usage parsing now records route-plan kind, reason, requested model and source.
- Recent-request rows and request details now identify `ChatGPT 辅助任务`, `自动路由` or `会话直接选择`.
- Statistics explicitly state that rows are historical requests and do not mean those models are currently running in the background. The old `当前` route label is now `当前配置`.

## TDD evidence

- A streaming response whose headers arrive within 30ms but whose terminal event arrives after 80ms failed with `upstream_timeout` before the fix and passes after the fix.
- Sequential recovery test proves the second project is not launched until the first activation wait resolves.
- Usage test proves auxiliary route-plan metadata survives through the finalized request record.
- Renderer tests require visible request-source attribution and the historical-request explanation.

## Files changed

- `src/upstream.js`
- `desktop/main.cjs`
- `desktop/openai-desktop-compat.cjs`
- `desktop/usage.mjs`
- `desktop/renderer/app.js`
- `tests/server.test.js`
- `tests/desktop-main-route-sync.test.js`
- `tests/desktop-usage.test.js`
- `tests/desktop-renderer.test.js`

## Verification

- Focused related suites: 339 passed, 0 failed.
- Full `npm run check`: 774 passed, 0 failed.
- `git diff --check`: passed.
- Packaged Windows smoke: passed against the generated `CodexBridge.exe`.
- Portable archive validation: 713 entries, 0 unsafe paths, 0 duplicate paths, and exactly one root `CodexBridge.exe`.

## Test package

- Archive: `dist-artifacts/test-20260712-0048/CodexBridge-Windows-x64-Portable.zip`
- Size: 141,368,534 bytes.
- SHA-256: `C223F250A440382F74419E6283E5136D6661B8D75D3F62C3BC577BE0945D5B0F`
