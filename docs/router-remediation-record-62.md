# Router remediation record 62: shortcut target verification and custom GPT route identity

Date: 2026-07-19

## User-visible problems

1. Selecting a valid ChatGPT or Codex Windows shortcut failed when the shortcut filename was localized or user-defined.
2. Saving a model selection failed during transaction planning with `config_draft_inconsistent` when a custom API-key model was grouped under the `codex` provider and used the same upstream model name as a native subscription model.

## Root causes

- The manual executable picker validated the shortcut filename as if it were the final executable before resolving the `.lnk` target.
- Route identity treated every model with `providerId = codex` as a native subscription route. Custom API-key models could therefore collide with native routes such as `cb-gpt-5-6-sol`.
- Provider decoration also overwrote explicit custom-model Base URL, API-key environment variable, and authentication mode with values from the built-in provider group.

## Repairs

- Verify that the selected path exists, then resolve and validate `.lnk` targets before applying direct executable-name validation.
- Keep native upstream route IDs only for models whose actual authentication mode is `codex_openai`.
- Give custom API-key models a preset-derived route ID even when their display group is `codex`.
- Preserve explicit custom-model Base URL, API-key environment variable, and authentication mode instead of replacing them with built-in provider defaults.
- Keep the strict whole-draft consistency validator unchanged.

## Regression coverage

- An arbitrary shortcut filename is accepted only after its resolved target passes the existing trusted ChatGPT/Codex target checks.
- A native `codex-gpt-5-6-sol` route and a custom API-key `gpt-5.6-sol` route can be selected together without duplicate route IDs.
- The custom route retains `authMode = api_key`, its own Base URL, and its own API-key environment variable.
- The related desktop locator, configuration mutation, configuration transaction, settings, and IPC suites remain green.
