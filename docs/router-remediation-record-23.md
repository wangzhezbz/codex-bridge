# Router remediation record 23

Date: 2026-07-12

## User report

- GPT-5.6 native image generation still failed with a parameter error.
- ChatGPT showed 11 plugins, 1 MCP, and 16 skills while CodexBridge showed 5 plugins, 2 MCPs, and 30 skills.

## Evidence and root cause

- The GPT image route converted `/v1/images/generations` into a Responses request but copied legacy Images API fields such as `quality: "standard"` into the native `image_generation` tool.
- It also forced an unnecessary `tool_choice` object. The current OpenAI Responses contract supports forcing generation with `tools: [{ "type": "image_generation", "action": "generate" }]`.
- The resource page mixed three unrelated inventories: enabled plugins, all enabled runtime MCP servers, and every skill visible in the full prompt. Those are not the three tab counts shown by ChatGPT's Plugins page.
- ChatGPT's plugin count includes every installed plugin, including disabled entries. Its MCP and skill tabs describe resources contributed by active plugins, not global MCP configuration or system/user skills.

## Corrected behavior

- GPT routes remain native-only and never switch to a configured third-party image provider.
- The native request now sends only the current Responses image tool contract and does not forward legacy Images API parameters.
- The resource response keeps the existing runtime-wide diagnostic inventory for compatibility and adds a separate `pluginPage` projection.
- The resource UI uses that projection for its first three cards and lists: all installed plugins, MCPs declared by active plugins, and skills declared by active plugins.
- Global runtime MCPs, prompt-wide system/user skills, cache entries, and marketplace candidates remain available only as diagnostics and no longer inflate the ChatGPT plugin-page counts.

## TDD evidence

- Image RED: the native image regression failed because the upstream payload lacked `action: "generate"` and still contained the forced legacy selection contract.
- Image GREEN: the focused native-only test passed after the minimal request correction; the configured external image provider received zero calls.
- Resource RED: the screenshot-equivalent fixture reproduced 5/2/30 instead of 11/1/16.
- Resource GREEN: the `pluginPage` projection reports 11/1/16 while preserving the existing runtime inventory contract.
- Desktop settings suite: 333 passed, 0 failed.
- Desktop renderer suite: 49 passed, 0 failed.

## Files changed in this remediation

- `src/server.js`
- `desktop/settings.mjs`
- `desktop/renderer/app.js`
- `desktop/renderer/index.html`
- `tests/server.test.js`
- `tests/desktop-settings.test.js`
- `tests/desktop-renderer.test.js`
- `docs/router-remediation-record-23.md`

## Final verification and package

- Full `npm run check`: 779 passed, 0 failed.
- `npm run release:code-ready`: passed; 15 pass, 7 environment/config warnings, 0 failures.
- `npm run desktop:smoke`: passed after updating the smoke expectation to the same plugin-page projection used by the renderer.
- Packaged desktop and Router lifecycle smoke: passed.
- `git diff --check`: exit 0; only existing line-ending warnings remain.
- Archive: `dist-artifacts/test-20260712-0340/CodexBridge-Windows-x64-Portable.zip`
- Size: 141,384,215 bytes.
- Entries: 722; unsafe paths: 0; duplicate paths: 0; root `CodexBridge.exe`: 1.
- SHA-256: `50AF47F39AC814E07068FDDE02C39739B1F37F812CF4ED912F26C7F71E785E7A`
