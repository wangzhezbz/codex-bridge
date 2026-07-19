# Router remediation record 61: explicit GPT-5.6 subscription-compatible model

Date: 2026-07-19

## User-visible problem

Some ChatGPT subscription accounts reject the explicit `gpt-5.6-sol` model with HTTP 400, while the CodexBridge model picker previously exposed only Sol, Terra, and Luna. Record 60 attempted to retry Sol silently as generic `gpt-5.6`, but that made the selected model name disagree with the actual upstream request.

## Root cause

`gpt-5.6-sol` and `gpt-5.6` are distinct upstream model identifiers. A user who explicitly selects Sol must either receive Sol or see the provider rejection. Replacing Sol behind the scenes obscures entitlement differences and makes routing diagnostics inaccurate.

## Repair

- Add a separate visible preset: `GPT-5.6（订阅兼容）`.
- Route that preset directly to the official generic model identifier `gpt-5.6`.
- Explain in the model card and model catalog that this is for ChatGPT subscription accounts that do not accept explicit GPT-5.6-Sol.
- Explain that generic GPT-5.6 is not fixed to Sol, Terra, or Luna; Codex provides the configuration currently available to the account.
- Remove the Sol-to-generic silent retry. Explicit Sol, Terra, and Luna selections remain exact.
- Do not add the compatibility preset to the default model selection, so existing installations are unchanged until the user selects it.

## Verification contract

- Selecting `GPT-5.6（订阅兼容）` must create route `cb-gpt-5-6` with upstream model `gpt-5.6`.
- Selecting `GPT-5.6-Sol` must send exactly one upstream request whose model remains `gpt-5.6-sol`.
- An account rejection for Sol must be surfaced as HTTP 400 and must not trigger an alias retry.
- Other routes, providers, automatic routing, failover, and default selections are unchanged.

## Supersession

This record supersedes the silent compatibility retry described in remediation record 60. Record 60 remains in the repository as an audit trail of the rejected approach.
