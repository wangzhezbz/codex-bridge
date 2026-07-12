# Router remediation record 20

Date: 2026-07-12

## User correction

- GPT models must use ChatGPT native `image_gen`.
- CodexBridge must not silently switch GPT image requests to SiliconFlow, Kolors, Pollinations, or any other external provider.

## Root cause

- ChatGPT Desktop sends a standard `POST /v1/images/generations` request to its configured API base.
- CodexBridge originally appended `/images/generations` to the ChatGPT Codex subscription backend.
- The subscription backend exposes native generation through the Responses API tool contract, not that direct path, so the constructed endpoint returned 404.
- Record 18 incorrectly treated the 404 as permission to change providers instead of translating the request into the native contract.

## Corrected behavior

- A GPT/Codex subscription route converts the standard image request into a native Responses request.
- The upstream request stays on the selected GPT route and uses `tools: [{ type: "image_generation" }]` with matching `tool_choice`.
- ChatGPT subscription authentication remains unchanged.
- The native `image_generation_call.result` is converted back into the standard image response expected by ChatGPT Desktop.
- A configured custom image provider is never considered for a GPT native image request.
- Non-GPT/API-Key direct image routes keep their existing behavior.

## TDD evidence

- The regression fixture contains GPT-5.6 plus an enabled SiliconFlow Kolors provider.
- Before correction, the request reached Kolors and the test failed with `custom provider must not be called`.
- After correction, the native `/backend-api/codex/responses` endpoint receives the GPT-5.6 request, subscription bearer, native image tool, and prompt.
- The native image result is returned to the desktop as `b64_json` and the custom provider receives zero calls.

## Files changed

- `src/server.js`
- `src/image-generation.js`
- `tests/server.test.js`
- `docs/router-remediation-record-18.md`

## Verification

- Focused native, API-Key direct-image, and image-fallback tests: 6 passed, 0 failed.
- Full `npm run check`: 776 passed, 0 failed.
- Packaged desktop and Router lifecycle smoke: passed.
- Packaged source check: native bridge present; withdrawn custom-provider selector and request helper absent.
- `git diff --check`: passed.

## Corrected combined test package

- Includes records 17, 19, and 20; record 18 is explicitly withdrawn.
- Archive: `dist-artifacts/test-20260712-0220/CodexBridge-Windows-x64-Portable.zip`
- Size: 141,378,630 bytes.
- Entries: 719; unsafe paths: 0; duplicate paths: 0; root `CodexBridge.exe`: 1.
- SHA-256: `5D1F53A633157CB8144FC90537220B8EAFBFC58E04693413F9D1B87A4F692C56`
