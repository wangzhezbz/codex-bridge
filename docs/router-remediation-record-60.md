# Router remediation record 60: GPT-5.6 Sol subscription compatibility

Date: 2026-07-19

## Symptom

Some accounts using a newer Codex desktop build can select GPT-5.6 Sol, but the ChatGPT subscription backend rejects the request with HTTP 400:

`The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.`

Other accounts can still use the explicit `gpt-5.6-sol` model successfully.

## Root cause

CodexBridge always overwrote the outgoing Responses payload with the route's explicit upstream model, `gpt-5.6-sol`. This bypassed the account-compatible `gpt-5.6` alias recommended by the current Codex configuration documentation. Accounts whose subscription entitlement does not accept the explicit Sol slug therefore failed even though the general GPT-5.6 route remained available.

## Repair

- Keep the explicit `gpt-5.6-sol` request as the first choice so existing supported accounts retain the requested Sol variant.
- Only when the ChatGPT subscription Responses endpoint returns the exact account-scoped unsupported-model HTTP 400, retry once with `gpt-5.6`.
- Record the retry as `subscription_model_compat` in route diagnostics.
- Do not retry arbitrary HTTP 400 errors.
- Do not apply the alias to API-key Responses routes, custom providers, chat-completions routes, or other models.

## Verification

- Added an end-to-end upstream fixture that rejects `gpt-5.6-sol` and accepts `gpt-5.6`; the request completes successfully after exactly one compatibility retry.
- Added a guard test proving unrelated subscription HTTP 400 errors are sent only once.
- Added a guard test proving API-key Responses routes never apply the ChatGPT subscription alias.
- Full upstream proxy suite: 27/27 passed.
- Full server suite: 136/136 passed.
- Route contract, fidelity, and model-selection regression suites: 21/21 passed.

## Safety boundary

This change does not alter model selection, automatic routing, failover order, API keys, custom providers, GPT-5.5, GPT-5.6 Terra, DeepSeek, Kimi, Doubao, image generation, or route configuration. It activates only after the subscription backend explicitly rejects `gpt-5.6-sol` for the current ChatGPT account.
