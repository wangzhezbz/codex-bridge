# Router remediation record 68: provider model-list refresh networking

Date: 2026-07-28

## Risk addressed

Users could repeatedly receive `模型列表刷新失败：fetch failed` when
refreshing DeepSeek or another OpenAI-compatible provider. In some environments
Router requests and application updates worked while this one action failed.
The original toast also discarded the actionable cause, while longer lower-level
network errors could be exposed directly to users.

## Root cause

Router upstream requests and the updater already use CodexBridge's shared proxy
discovery. Provider model-directory refreshes instead called the injected or
global `fetch` directly. They therefore bypassed configured environment proxies
and Windows/macOS system proxies.

The refresh error formatter also returned the raw Undici message. A connect
timeout such as `UND_ERR_CONNECT_TIMEOUT` was reduced to the generic
`fetch failed`, which did not tell the user whether to check the provider URL,
DNS, proxy, TLS, or timeout.

## Repair

- Send provider model-directory requests through the same proxy-aware fetch
  initialization used by Router and the updater.
- Classify connection timeout, DNS, TLS, and generic network failures into
  short Chinese messages with stable diagnostic codes.
- Bound any unclassified error returned to the renderer.
- Preserve the last successful model list whenever refresh fails.

## Explicitly unchanged

- Provider credentials, saved provider settings, selected models, Router
  configuration, and Router lifecycle are unchanged.
- Refresh still uses `GET <Base URL>/models` and the saved provider API key.
- A failed refresh does not commit a configuration mutation or clear the
  existing model list.
- No automatic retry or long wait was added.

## Verification

- Added a failing regression proving model-list refresh receives the shared
  proxy dispatcher.
- Added a failing regression proving an Undici connect timeout is classified
  and the cached list is retained.
- Both regressions pass after the repair.
- Full `tests/desktop-settings.test.js`: 351 passed, 0 failed.
