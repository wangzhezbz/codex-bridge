# Router remediation record 58: custom provider directory visibility verification

Date: 2026-07-18

## Symptom

On CodexBridge v0.3.10, refreshing a custom OpenAI-compatible provider could report that 13 remote models were found while the provider editor continued to show only the two locally saved seed models.

## Root cause and version boundary

- v0.3.10 stored the remote directory but the custom-provider editor catalog still used the locally saved custom-model records.
- The effective custom-provider directory merge entered the main branch in v0.3.11, so the screenshot showing v0.3.10 is exercising the old display path.
- The issue is limited to the custom-provider catalog after a successful model-directory refresh. Router request conversion, provider authentication, model adapters, and built-in provider catalogs are unchanged.

## Verification

- Added a 13-model PPToken-style regression fixture with two pre-existing saved seed models.
- Verified the refresh result reports 13 and the effective provider catalog exposes all 13 compatible remote models.
- Verified every refreshed model keeps the provider's `responses` API and custom-provider identity.

## User action

Upgrade to v0.3.11 or later, reopen the custom provider, and click “同步模型列表” once. The list below the button should then replace the two seed entries with the refreshed compatible model directory.

## Safety boundary

This verification does not change Router routing behavior, API keys, selections, or built-in model definitions. It does not add unsupported embedding, image, audio, or video endpoints to the chat model catalog.
