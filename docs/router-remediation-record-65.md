# Router remediation record 65: task-local model selection and subscription quota attribution

Date: 2026-07-20

## Risks addressed

1. A model selection recorded by one Codex task could be reused by another task in the same window or installation. The second task could therefore show GPT-5.6 while a reconnect was still sent to Kimi or another previously selected route.
2. A ChatGPT/Codex subscription quota response (`HTTP 429` with `The usage limit has been reached`) was classified and displayed as ordinary provider request throttling. This obscured the actual account-level quota state and made the error appear to belong to the selected non-subscription model.

## Root causes

- Explicit model selection state was stored under thread, window, and installation scopes. The broader window and installation entries survived across tasks and the newest matching entry could overwrite another task's request during reconnect.
- Upstream error classification treated every `HTTP 429` as a generic rate limit before inspecting the response body for the subscription-quota signature.
- Smart failover classification preferred a generic error message over the more specific upstream response body, so account quota exhaustion could not be distinguished from transient request throttling.

## Repairs

- Use the Codex thread ID as the authoritative model-selection scope. Use the window ID only when a request contains no thread ID, and never use installation-wide selection state.
- Add a narrowly matched `subscription_quota_exhausted` classification for ChatGPT/Codex usage-limit responses before generic `429` classification.
- Build smart-routing diagnostics from all available error fields so the upstream response body is not hidden by a generic wrapper message.
- Show a specific Chinese message for exhausted ChatGPT/Codex subscription quota instead of attributing it to ordinary provider throttling.

## Explicitly unchanged

- The subscription-mode default model and model list are unchanged.
- GPT-5.6 Sol, Terra, and Luna routes, aliases, visibility, and account-support behavior are unchanged.
- Manual model selection, automatic model selection, automatic failover, provider cooldown, and ordinary `429` behavior are unchanged outside the two fixes above.
- Normal Router start, stop, configuration, image generation, history, resources, and Double Quota behavior are unchanged.

## Test-first evidence

- Before the implementation change, reconnect tests reproduced model leakage between two tasks sharing one installation and between two threads sharing one window.
- Before the implementation change, route classification and smart-routing tests classified the ChatGPT usage-limit response as ordinary rate limiting.
- The upstream response test verifies that the user-facing error now identifies ChatGPT/Codex subscription quota and does not say provider throttling.

## Verification

- Targeted model-selection, route-health, smart-routing, and upstream suites: 76/76 passed.
- Full Router suite: 540/540 passed.
- Full repository suite, including Router and Desktop behavior: 1416/1416 passed.
- Full project syntax check and model-selection syntax check: passed.
- `git diff --check`: clean.
