# Router remediation record 18 — withdrawn

Date: 2026-07-12
Status: Withdrawn and superseded by record 20.

## Why this record was withdrawn

- This iteration routed GPT-5.6 direct image requests to an enabled custom image provider when the ChatGPT subscription `/images/generations` path returned 404.
- That changed the selected capability source without user authorization.
- GPT routes must retain ChatGPT native `image_gen`; configured external image providers are for routes where the user explicitly selected or configured them.

## Removal evidence

- The custom-provider selection helper added by this iteration was removed.
- The direct custom-provider request builder added by this iteration was removed.
- A replacement regression test now requires GPT image requests to use native Responses `image_generation` even when a custom provider exists, and requires custom-provider calls to remain zero.

## Correct replacement

See `docs/router-remediation-record-20.md`.
