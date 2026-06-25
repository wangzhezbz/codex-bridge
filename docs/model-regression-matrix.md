# Model Regression Matrix

CodexBridge is a router first. Any feature is allowed only when normal model
usage still works for built-in and custom routes.

Run before release:

```powershell
npm run check
```

Router-focused quick pass:

```powershell
node --test tests\conversion.test.js tests\route-fidelity-regression.test.js tests\server.test.js
```

## Must Pass

| Area | GPT Responses route | DeepSeek chat route | Kimi chat route | Custom chat route | Guard |
| --- | --- | --- | --- | --- | --- |
| Plain text | Pass through without conversion loss. | Convert to chat messages. | Convert to chat messages. | Convert to chat messages. | No forced tool use or one-line truncation. |
| Custom params | Native Responses payload remains native. | Drop only configured unsupported params. | Drop only configured unsupported params. | Preserve OpenAI-compatible params by default. | `response_format`, `parallel_tool_calls`, and `tool_choice` must follow route policy. |
| Tools | Native tool calls and outputs remain available. | Valid tool pairs stay as native chat `tool` messages. | Valid tool pairs stay as native chat `tool` messages. | Valid tool pairs stay as native chat `tool` messages. | No `role: "tool"` message may be sent without a matching `tool_call_id`. |
| Extra or malformed tool outputs | Keep content in history. | Convert orphan, missing-id, or stale outputs to internal context. | Convert orphan, missing-id, or stale outputs to internal context. | Convert orphan, missing-id, or stale outputs to internal context. | Never retry the same completed tool only because an old result exists. |
| MCP and plugins | Keep native behavior. | Flatten MCP names and map them back to Codex names. | Flatten MCP names and map them back to Codex names. | Flatten MCP names and map them back to Codex names. | Hooks, skills, MCP, and plugin history must not disappear after model switching. |
| Chrome / Computer Use | Prefer native plugin route. | Hide native-only tools and guide to command fallback. | Hide native-only tools and guide to command fallback. | Hide native-only tools and guide to command fallback. | Do not expose Node REPL or plugin bootstrap internals to chat providers. |
| Images | Forward when model supports images. | Omit or describe when text-only. | Forward when enabled and supported. | Forward only when enabled and supported. | Oversized images must become placeholders, not giant payloads. |
| Files, PDF, PPT, large inputs | Keep native attachments when supported. | Extract readable text when possible; otherwise explain limitation. | Extract/read only what is explicitly forwarded. | Follow custom route capability flags. | Do not ask the model to repeatedly call local tools for unsupported attachments. |
| Context window | Use route catalog window. | Trim upstream payload only for the selected small route. | Trim upstream payload only for the selected small route. | Use configured custom window. | Unified local history must remain available when switching back to a larger model. |
| Compaction | Native compaction remains valid. | Summary request has no tools and replays summary as context. | Summary request has no tools and replays summary as context. | Summary request has no tools and replays summary as context. | Compact output must contain exactly one usable summary item. |
| Loop guard | Allow distinct multi-step work. | Stop repeated identical tool loops. | Stop repeated identical tool loops. | Stop repeated identical tool loops. | Guard must not block normal multi-step tool chains. |

## Current Locked Tests

- `tests/conversion.test.js`
  - request conversion, attachments, tool history, malformed tool outputs,
    interactive plugin fallbacks, provider schema compatibility.
- `tests/route-fidelity-regression.test.js`
  - cross-route contract for GPT, DeepSeek, Kimi, and custom models.
- `tests/server.test.js`
  - router request handling, upstream selection, history switching, streaming,
    loop guard, image routing, and compaction behavior.
- `tests/adapter-profile.test.js`
  - provider-specific parameter filtering.

If a provider requires a new compatibility rule, add the smallest route-specific
adapter policy and a regression test. Do not globally strip tools, parameters,
history, or attachments just to make one provider accept one request.
