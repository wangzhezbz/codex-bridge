# Router remediation record 13

Date: 2026-07-12

## Scope

- Make the resource center refresh the current ChatGPT/Codex CLI and prompt-input authorities when the page opens.
- Accept direct `POST /v1/images/generations` requests from the built-in image generation tool.
- Automatically reopen history-only ChatGPT/Codex projects during deferred desktop startup.

## Root causes

1. The resource center retained the first detailed-state snapshot. Opening another detailed page first could leave plugin and skill totals stale until the user manually clicked refresh.
2. Router only exposed Responses and Chat Completions collection routes. The built-in image tool reached Router correctly, but `POST /v1/images/generations` fell through to the local 404 handler.
3. Project recovery was only wired to manual buttons. Its plan also did not distinguish current active roots from history-only roots, so it could not be used safely at startup.

## Changes

- Resource page entry now requests a fresh CLI/plugin/MCP and prompt-input skill snapshot.
- Direct image requests are authenticated by Router and forwarded without rewriting the image model or prompt. Subscription routes reuse the ChatGPT Codex backend and the incoming ChatGPT bearer token; API-key routes use their configured upstream key.
- Recovery plans now expose `autoLaunchRoots`, containing only existing non-active project roots. Deferred startup invokes that subset once and skips desktop smoke runs.
- Existing generated-workspace filtering and read-only Codex database behavior remain unchanged.

## Verification

- RED tests confirmed the previous local image 404, missing automatic resource refresh, and missing automatic project recovery.
- Focused regression: 647 tests passed across server, upstream, desktop settings, desktop main wiring, and renderer suites.
- Additional direct image tests verify both API-key forwarding and ChatGPT subscription bearer/backend forwarding.
- `npm run check`: passed.
- Packaged Windows smoke: passed, including the packaged Router health lifecycle.
- `npm run release:code-ready`: 15 pass, 7 environment/config reminders, 0 fail.
- Portable ZIP integrity: 712 entries fully read, no unsafe or duplicate entry names; root `CodexBridge.exe` present.

## Test artifact

- `dist-artifacts/test-20260712-0026/CodexBridge-Windows-x64-Portable.zip`
- SHA256: `7B497502FFDAC69225180960AE0E3B0E10683C9FEDC655B7FCED00FA9B7FBDDF`

## Files changed

- `desktop/main.cjs`
- `desktop/renderer/app.js`
- `desktop/settings.mjs`
- `src/server.js`
- `src/upstream.js`
- `tests/desktop-main-route-sync.test.js`
- `tests/desktop-settings.test.js`
- `tests/server.test.js`
