# All-Model Session Safety Design

## Summary

CodexBridge needs a stronger session layer before adding more model-switching behavior. The product must keep all built-in and custom models usable without breaking Codex tasks, losing tool capability, sending unsupported provider parameters, corrupting history, looping on tools, or burning user tokens after a task is already stuck.

This design adds an all-model compatibility contract around the existing router. The router keeps its current Responses endpoint and provider adapters, but introduces explicit session state, model capability metadata, request rendering budgets, attachment policy, compression policy, and safety watchdogs.

The goal is not to make every upstream model equally capable. Some models do not support tools, images, files, long context, or Responses-native workflows. The goal is to make those limits explicit and safe: unsupported capability should degrade locally or route to a capable model, not fail through repeated upstream trial-and-error.

## Non-Negotiable Release Gates

No release should ship if any of these regress:

- Any built-in preset model cannot complete a normal text request.
- Any built-in preset model receives a known-unsupported parameter and returns provider 400 or 422 because of CodexBridge.
- Tool results disappear during a model switch.
- MCP namespace tools are dropped or renamed incorrectly.
- A provider that does not support images or files is repeatedly called with image or file payloads.
- A task keeps making upstream requests after repeated identical tool calls, identical tool outputs, identical provider errors, or client disconnect.
- A small-context model permanently truncates or overwrites the global conversation state.
- A model switch causes Codex to see only a short generic answer when tool output or conversation state should still be available.

These gates apply to all built-in model categories, not only DeepSeek and Kimi:

- GPT / native Responses routes.
- OpenAI-compatible chat routes.
- Domestic providers such as DeepSeek, Kimi, MiniMax, Doubao, Qwen, Baidu, and any enabled presets.
- Vision-capable routes.
- Text-only routes.
- Conservative custom-model routes.

Custom models cannot be guaranteed to support every Codex task, but CodexBridge must not make them unsafe. Unknown custom models default to conservative behavior: text-only, minimal parameters, short context budget, no images, no files, no speculative tool features unless the user explicitly enables them.

## Existing State

The current implementation already has useful protections:

- `ResponseHistory` keeps a unified local chat history so a small model's upstream truncation does not overwrite the larger history.
- Chat routes trim payloads to the route's `contextWindow` before sending upstream.
- MCP namespace tools are flattened for chat-completions providers.
- Tool call and tool result pairs are normalized so providers receive coherent history.
- Images can be removed and retried when a chat provider rejects image content.
- Oversized data-image URLs are replaced with placeholders before chat requests.
- Request bodies are capped at 25 MB, including decoded compressed bodies.
- Client disconnect aborts upstream fetches.
- Upstream timeouts, failure caching, rate-limit local fallback, and chat tool-loop guard reduce runaway token use.

The missing piece is a coherent protocol that tells the router how to render one canonical conversation safely for many different model capabilities.

## Architecture

### 1. Conversation State

Introduce a `ConversationState` layer behind `ResponseHistory`.

It owns the canonical session record:

- User turns.
- Assistant text.
- Reasoning-visible public summaries only, not hidden chain of thought.
- Tool calls.
- Tool outputs.
- Attachment metadata.
- Local fallback messages.
- Compression summaries.
- Per-response metadata.

The canonical record is model-neutral and never stores a provider-trimmed payload as the source of truth. A small model may receive a short rendered view, but that view cannot replace the canonical conversation.

The existing `ResponseHistory` can remain as the first storage backend, but its responsibilities should narrow:

- Store canonical turns.
- Store provider response objects for Codex probes.
- Store metadata needed for handoff and safety decisions.
- Keep byte and entry limits so memory stays bounded.

### 2. Model Capability Matrix

Every route gets normalized capabilities. Built-in presets define them explicitly; custom models derive safe defaults.

Capability fields:

- `api`: `responses` or `chat_completions`.
- `providerFamily`: OpenAI, DeepSeek, Kimi, MiniMax, Doubao, Qwen, Gemini, Baidu, generic OpenAI-compatible, or custom.
- `contextWindow`: real upstream input window.
- `catalogContextWindow`: what Codex sees in model catalog.
- `supportsTools`: native, chat-functions, limited, or none.
- `supportsMcpNamespaces`: true only when the adapter can preserve names safely.
- `supportsImages`: native, chat-image-url, text-placeholder, or none.
- `supportsFiles`: native, text-placeholder, or none.
- `supportsResponsePreviousId`: true for known upstream Responses routes that can own previous response state.
- `supportsPromptCaching`: unknown, provider-native, or false.
- `safeParams`: allow-list of request fields that may be forwarded.
- `dropParams`: explicit denied fields, used after `safeParams`.
- `maxToolContinuationTurns`: per-route loop limit.
- `upstreamTimeoutMs`: per-route timeout.

The router should generate a single normalized `AdapterProfile` for each route at startup and after config reload. Tests should assert that each built-in preset has a profile.

### 3. Provider Adapters

Provider-specific logic should move out of scattered conditionals and into adapters.

Each adapter handles:

- Parameter allow-listing.
- Tool schema shaping.
- Tool-call response conversion.
- Image and file rendering.
- Provider-specific schema quirks.
- Error classification.
- Cache-awareness hints.
- Fallback behavior.

Initial adapters:

- `responses-native`: GPT / Codex auth routes.
- `chat-openai-compatible`: generic conservative baseline.
- `chat-deepseek`.
- `chat-kimi`.
- `chat-minimax`.
- `chat-doubao`.
- `chat-qwen`.
- `chat-gemini`.
- `custom-conservative`.

The generic adapter must be strict. A provider-specific adapter may add capabilities only when tests prove support.

### 4. Render Budget

Before each upstream request, CodexBridge renders the canonical conversation into a provider payload.

Render steps:

1. Gather canonical history from `ConversationState`.
2. Choose adapter profile for the selected route.
3. Build stable system prefix:
   - User/developer instructions.
   - Bridge tool guidance only when needed.
   - Capability limitation note only when needed.
4. Add global compressed summary if present.
5. Add recent turns with tool-call pairs preserved.
6. Add current user input and current tool outputs.
7. Apply adapter-specific trimming.
8. Validate the final payload against adapter rules before fetch.

The stable prefix matters for provider prompt caching. The renderer should avoid inserting volatile text such as timestamps, random IDs, noisy diagnostics, or repeated guidance unless the request actually needs it.

The renderer should report budget diagnostics internally:

- Canonical token estimate.
- Rendered token estimate.
- Summary tokens.
- Recent-turn tokens.
- Attachment placeholder tokens.
- Dropped historical turns count.
- Whether tool-call pairs were flattened.

These diagnostics go to sanitized logs and tests, not to the model unless needed.

### 5. Prompt Cache Strategy

CodexBridge cannot force provider prompt caching, but it can avoid destroying cacheable prefixes.

Rules:

- Keep stable instructions stable across model switches.
- Put bridge guidance in deterministic sections and only when relevant.
- Do not include provider error text in the reusable prefix.
- Do not include route names or transient request IDs in prompt content.
- Prefer canonical summaries over reflowed raw history for older context.
- For same provider and same model, keep rendered older context byte-identical when the canonical history has not changed.

Model switching still lowers cache hit rate because the upstream model/provider changes. The target is not cross-provider cache reuse; the target is preventing unnecessary churn inside a provider.

### 6. Compression Policy

Compression is global by default, model-specific only as a rendered view.

Canonical state can contain:

- `globalSummary`: provider-neutral summary for all models.
- `toolLedger`: compact record of completed tools and important outputs.
- `attachmentLedger`: compact record of attachments, screenshots, images, and omitted file details.
- `modelViewCache`: optional per-model rendered summaries used for performance, never source of truth.

Compression trigger:

- Canonical estimated size exceeds a configured threshold.
- A route cannot fit required recent turns plus minimum tool ledger.
- User explicitly asks to compress or continue long context.

Compression model selection:

- Prefer a native Responses route with strong context and tool compatibility.
- If no native route is available, use the best configured model marked `canSummarizeSafely`.
- If no safe summarizer exists, do not compress destructively. Use deterministic truncation plus a local warning.

Compression output must be structured:

- Current objective.
- Decisions.
- Files and paths.
- Tool results that matter.
- External constraints.
- Open tasks.
- Known failed attempts.
- Attachments and whether their contents were actually seen.

A small model's rendered context or summary cannot overwrite `globalSummary` unless it was produced by the selected compression policy and passes validation.

### 7. Attachment Policy

Attachment handling must be explicit and per-model.

Images:

- Native image-capable Responses routes receive image parts when within request size limits.
- Chat routes that support image URLs receive image URL parts when the adapter allows it.
- Text-only or unknown routes receive a deterministic placeholder with filename/type/size when known.
- Oversized data images are not forwarded to chat providers. They become attachment ledger entries and placeholders.

Files:

- Native file-capable routes may receive supported file input only when the request format is known safe.
- Chat providers do not receive raw file data by default.
- Unsupported file input becomes a placeholder that says the file was not forwarded and includes safe metadata.
- If a task clearly needs file contents and the selected model cannot receive them, CodexBridge should prefer a capable native route when auto-routing is enabled, or return a local explanation when auto-routing is disabled.

Large request bodies:

- Keep the existing 25 MB decoded request cap.
- Add tests for compressed-body expansion over the limit.
- Add adapter tests for oversized image, unsupported image, unsupported file, and mixed text/image/file turns.

### 8. Tool, MCP, Skill, And Hook Safety

Codex owns local tools. CodexBridge must preserve the tool contract while translating model APIs.

Rules:

- Never drop current-turn tools silently.
- Never expose a tool call name that Codex cannot map back.
- Preserve namespace prefixes for MCP tools.
- Preserve complete assistant tool-call plus tool-output pairs when the provider supports them.
- Flatten historical tool-call pairs into system context only when the provider cannot replay them safely.
- Do not ask chat providers to bootstrap native Browser, Chrome, or Computer Use plugins unless the required tool is present and supported.
- If a model cannot use the needed tool class, local fallback should be explicit.

Hook and plugin behavior should be treated as current-turn capability, not historical memory. Old prompts mentioning a plugin must not force new plugin bootstrap on later turns.

### 9. Safety Watchdog

Add a request-level and conversation-level watchdog.

It tracks:

- Upstream request count per user turn.
- Consecutive tool continuations.
- Repeated tool call name plus arguments.
- Repeated tool output with no new user input.
- Repeated provider error fingerprint.
- Repeated local fallback reason.
- Client disconnect and timeout.
- Token usage growth per turn.

Actions:

- Stop locally when a loop threshold is reached.
- Do not call upstream again after stop.
- Preserve the latest useful tool result.
- Return a concise local response explaining why CodexBridge stopped.
- Log sanitized diagnostics.

Default limits:

- Upstream timeout: 5 minutes.
- Consecutive chat tool continuations: 2 by default, lower for weak adapters.
- Repeated identical tool call: stop on second repeat within the same user turn.
- Repeated identical upstream error: short-circuit for a bounded cooldown.
- Provider 401: do not cache; user may fix auth.

### 10. Auto-Routing Policy

Model switching should remain user-controlled by default. Automatic route changes are allowed only for safety or capability preservation and must be visible in metadata/logs.

Allowed automatic decisions:

- Use native Responses route for compression when configured.
- Use native file/image-capable route when a selected model cannot handle a required attachment and `autoRouteCapabilities` is enabled.
- Return local fallback instead of upstream call when no safe route exists.

Disallowed decisions:

- Silently switch providers for ordinary text because another model might answer better.
- Retry across providers after a provider rejects parameters.
- Keep trying weaker models after a tool loop.

### 11. Observability

Diagnostics must help prove where a request went and why.

Add sanitized logs for:

- Route id.
- Upstream model.
- Adapter id.
- Capability decisions.
- Dropped params.
- Attachment handling decision.
- Render budget summary.
- Watchdog decisions.
- Token usage and cached token usage when provider reports it.

Diagnostics must not include:

- API keys.
- Bearer tokens.
- URL userinfo.
- Raw large file contents.
- Raw base64 image/file payloads.

### 12. Verification Plan

Tests are part of the design, not cleanup work.

Adapter contract tests:

- Every built-in preset has a normalized adapter profile.
- Every adapter has a safe parameter allow-list.
- Unsupported params are dropped before fetch.
- Custom conservative adapter forwards only minimal safe fields.

Conversation rendering tests:

- Large canonical history renders differently for small and large models without mutating canonical state.
- Stable prefix remains byte-identical across repeated same-provider turns when history does not change.
- Tool-call pairs remain paired or flatten with safe headers.
- MCP names survive round trip.
- Current user input is always preserved.

Attachment tests:

- Oversized data image becomes placeholder.
- Text-only model does not receive image payload.
- Unsupported file is not forwarded to chat provider.
- Native image route receives image content when within limits.
- Mixed image/file/text turns remain coherent.

Compression tests:

- Global summary is inserted before older raw turns.
- Per-model view cannot overwrite global state.
- Compression failure does not discard canonical history.
- Tool ledger survives compression.

Watchdog tests:

- Client disconnect aborts upstream.
- Upstream timeout stops request.
- Identical tool call repeats stop locally.
- Repeated provider error short-circuits without upstream call.
- Tool-output continuation loop stops without another upstream call.

End-to-end provider category smoke tests:

- Native Responses text.
- Generic chat text.
- DeepSeek-style chat tools.
- Kimi-style schema.
- Vision-capable route.
- Text-only route with image placeholder.
- Custom conservative route.

Packaging gate:

- `npm run check`.
- `npm run desktop:smoke`.
- `npm run package:win`.
- `npm run package:win:smoke`.
- GitHub Actions release run must pass before calling a version released.

## Implementation Phases

### Phase 1: Contract Lock

Add adapter profile generation and tests without changing runtime behavior. Lock current behavior for all built-in presets. Add regression tests for unsupported params, model category smoke paths, and custom conservative defaults.

### Phase 2: Renderer Boundary

Extract conversation rendering from `responses-to-chat.js` into a bounded renderer that takes canonical state and adapter profile. Keep output equivalent where current tests already pass.

### Phase 3: Safety Watchdog

Add repeated tool-call detection, repeated error detection, per-user-turn upstream budget, and clearer local stop responses.

### Phase 4: Attachment And Compression Policy

Add attachment ledger, global summary representation, compression routing policy, and tests for small/large model switching.

### Phase 5: Observability And UI Surfacing

Expose adapter id, dropped params, attachment decisions, watchdog stops, and cache/cached-token signals in diagnostics and usage summaries.

## Rollback Strategy

Each phase should be independently shippable. If a phase causes provider regressions:

- Revert the phase commit.
- Keep any tests that captured the regression when possible.
- Do not ship a release with known provider-category failures.

Runtime config should include a temporary `compatMode: "legacy"` switch only for emergency support. It should preserve the old conversion path for one release cycle while the new path is fixed. The switch must not disable watchdog protections against loops, disconnects, or repeated upstream failures.

## Acceptance Criteria

The design is complete when:

- All built-in presets have adapter profiles and compatibility tests.
- Custom models default to conservative safe behavior.
- Provider-specific parameter filtering is tested.
- Canonical history survives small-model rendering, compression, and model switching.
- Tool, MCP, and tool-output continuation behavior is covered by regression tests.
- Attachment behavior is explicit and tested.
- Watchdog stops repeated token-wasting behavior locally.
- Diagnostics explain capability decisions without leaking secrets or payloads.
- Full local and packaged verification passes before release.
