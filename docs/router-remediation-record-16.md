# Router remediation record 16

Date: 2026-07-12

## Reported symptoms

- A two-second HyperFrames task failed with DeepSeek, Kimi, and Doubao.
- DeepSeek could remain running without producing a result.
- The same workflow worked with an earlier Codex Desktop version.

## Root cause

- DeepSeek, Kimi, and Doubao all use CodexBridge's Chat Completions adapter, so the common failure was in protocol conversion rather than three independent provider outages.
- New ChatGPT Desktop built-in tools use plain namespace identities such as `collaboration`, `image_gen`, and `codex_app`.
- CodexBridge must flatten those names only when sending tools to a Chat Completions provider, for example `collaboration__spawn_agent`, and must restore the original namespace in the Responses tool call returned to ChatGPT.
- The converter incorrectly stored the flattened prefix (`collaboration__`) as the Responses namespace. ChatGPT could not dispatch the returned collaboration/subagent call, so HyperFrames agent chains failed or waited indefinitely.
- Older Codex Desktop tool namespaces were predominantly MCP-style names already ending in `__`; existing tests covered that shape and therefore did not expose the new ChatGPT compatibility gap.

## Changes

- Preserve the exact incoming Responses namespace identity.
- Derive a separate `__`-suffixed prefix only for the flattened Chat Completions function name.
- Restore the exact original namespace for both non-streaming and SSE tool-call results.
- Existing MCP-style namespaces remain unchanged.

## TDD evidence

- Added a regression test using the new plain `collaboration` namespace.
- Before the fix, the returned namespace was `collaboration__` and the test failed.
- After the fix, the provider receives `collaboration__spawn_agent`, while ChatGPT receives namespace `collaboration` in both response forms.
- Synthetic checks also cover `image_gen`, `codex_app`, and legacy `mcp__figma__` namespaces.

## Files changed

- `src/tools.js`
- `tests/conversion.test.js`
- `desktop/main.cjs` (packaged-smoke timeout diagnostics only)

## Verification

- Focused conversion, server, and proxy suites: 341 passed, 0 failed.
- Full `npm run check`: 774 passed, 0 failed.
- Source desktop smoke: passed.
- Packaged desktop and Router lifecycle smoke: passed.
- `git diff --check`: passed.

## Test package

- Archive: `dist-artifacts/test-20260712-0122/CodexBridge-Windows-x64-Portable.zip`
- Size: 141,372,385 bytes.
- Entries: 715; unsafe paths: 0; duplicate paths: 0; root `CodexBridge.exe`: 1.
- Packaged source check: exact-namespace fix present.
- SHA-256: `5C0B80696C9857AA26CBEADC398CF5DDE25D9FC1DC126F08EE22B1FE00D2E3F4`
