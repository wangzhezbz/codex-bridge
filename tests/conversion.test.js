import test from "node:test";
import assert from "node:assert/strict";
import { buildModelCatalog } from "../src/model-catalog.js";
import { authModeForRoute, validateConfig } from "../src/config.js";
import { ResponseHistory } from "../src/history.js";
import { responsesToChatRequest } from "../src/responses-to-chat.js";
import {
  assistantHistoryMessageFromChat,
  chatResponseToResponse,
} from "../src/chat-to-responses.js";

const route = {
  id: "deepseek-v4-pro",
  model: "deepseek-v4-pro",
  api: "chat_completions",
  baseUrl: "http://example.test/v1",
  apiKey: "test",
  dropParams: ["response_format", "parallel_tool_calls"],
};

test("model catalog keeps Codex tool capability fields", () => {
  const catalog = buildModelCatalog({
    models: [
      {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        api: "chat_completions",
        baseUrl: "http://example.test/v1",
        model: "deepseek-v4-pro",
      },
    ],
  });

  assert.equal(catalog.models[0].display_name, "DeepSeek V4 Pro");
  assert.equal(catalog.models[0].shell_type, "shell_command");
  assert.equal(catalog.models[0].apply_patch_tool_type, "freeform");
  assert.equal(catalog.models[0].supports_parallel_tool_calls, true);
  assert.deepEqual(
    catalog.models[0].supported_reasoning_levels.map((level) => level.effort),
    ["low", "medium", "high", "xhigh"],
  );
  assert.equal(catalog.models[0].default_reasoning_level, "medium");
});

test("model catalog uses model context window for truncation instead of a 10k cap", () => {
  const catalog = buildModelCatalog({
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        model: "gpt-5.5",
        contextWindow: 1_000_000,
        effectiveContextWindowPercent: 95,
      },
    ],
    catalog: {
      autoCompactPercent: 80,
    },
  });

  assert.equal(catalog.models[0].truncation_policy.limit, 950_000);
  assert.equal(catalog.models[0].auto_compact_token_limit, 800_000);
});

test("chat catalog exposes a bridge-sized context window to avoid Codex local overflow", () => {
  const catalog = buildModelCatalog({
    models: [
      {
        id: "gpt-5.2",
        displayName: "ERNIE 4.0 Turbo 8K",
        api: "chat_completions",
        baseUrl: "http://example.test/v1",
        model: "ernie-4.0-turbo-8k",
        contextWindow: 8192,
      },
    ],
  });

  assert.equal(catalog.models[0].context_window, 1_000_000);
  assert.equal(catalog.models[0].truncation_policy.limit, 950_000);
  assert.equal(catalog.models[0].auto_compact_token_limit, 800_000);
});

test("chat catalog accepts standard Codex reasoning levels for model switching", () => {
  const catalog = buildModelCatalog({
    models: [
      {
        id: "gpt-5.2",
        displayName: "Kimi K2.7 Code",
        api: "chat_completions",
        baseUrl: "http://example.test/v1",
        model: "kimi-k2.7-code",
      },
    ],
  });

  assert.deepEqual(
    catalog.models[0].supported_reasoning_levels.map((level) => level.effort),
    ["low", "medium", "high", "xhigh"],
  );
  assert.equal(catalog.models[0].default_reasoning_level, "medium");
});

test("responses passthrough models expose reasoning levels", () => {
  const catalog = buildModelCatalog({
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: "http://example.test/v1",
        model: "gpt-5.5",
      },
    ],
  });

  assert.equal(catalog.models[0].display_name, "GPT-5.5");
  assert.equal(Array.isArray(catalog.models[0].supported_reasoning_levels), true);
  assert.equal(catalog.models[0].default_reasoning_level, "medium");
});

test("gpt responses catalog entries allow image input", () => {
  const catalog = buildModelCatalog({
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        model: "gpt-5.5",
        authMode: "codex_openai",
      },
    ],
  });

  assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
  assert.equal(catalog.models[0].supports_image_detail_original, true);
});

test("chat catalog entries with image modality allow image input", () => {
  const catalog = buildModelCatalog({
    models: [
      {
        id: "gpt-5.2",
        displayName: "Kimi K2.7 Code",
        api: "chat_completions",
        baseUrl: "https://api.moonshot.cn/v1",
        model: "kimi-k2.7-code",
        inputModalities: ["text", "image"],
      },
      {
        id: "gpt-5.3-codex",
        displayName: "DeepSeek V4 Pro",
        api: "chat_completions",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-v4-pro",
      },
    ],
  });

  assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
  assert.equal(catalog.models[0].supports_image_detail_original, true);
  assert.deepEqual(catalog.models[1].input_modalities, ["text"]);
  assert.equal(catalog.models[1].supports_image_detail_original, false);
});

test("chat conversion preserves image_url content arrays", () => {
  const converted = responsesToChatRequest(
    {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe this image" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,abc123",
              detail: "high",
            },
          ],
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.deepEqual(converted.body.messages.at(-1).content, [
    { type: "text", text: "describe this image" },
    {
      type: "image_url",
      image_url: {
        url: "data:image/png;base64,abc123",
        detail: "high",
      },
    },
  ]);
});

test("chat conversion replaces oversized data images with text placeholders", () => {
  const hugeDataUrl = `data:image/png;base64,${"a".repeat(2_100_000)}`;
  const converted = responsesToChatRequest(
    {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe this screenshot" },
            {
              type: "input_image",
              image_url: hugeDataUrl,
              detail: "high",
            },
          ],
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.deepEqual(converted.body.messages.at(-1).content, [
    { type: "text", text: "describe this screenshot" },
    {
      type: "text",
      text: "[image input omitted because it is too large for this chat provider]",
    },
  ]);
});

test("chat conversion keeps file inputs visible when chat provider cannot forward them", () => {
  const converted = responsesToChatRequest(
    {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "summarize this file" },
            {
              type: "input_file",
              filename: "brief.pdf",
              file_data: "data:application/pdf;base64,abc123",
            },
          ],
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.equal(
    converted.body.messages.at(-1).content,
    "summarize this file\n[file input not forwarded to chat provider: brief.pdf]",
  );
});

test("chat conversion trims old history to fit the upstream model context window", () => {
  const history = new ResponseHistory();
  history.record("resp_long", [
    { role: "user", content: "old ".repeat(20_000) },
    { role: "assistant", content: "old answer ".repeat(20_000) },
    { role: "user", content: "recent context" },
  ]);

  const converted = responsesToChatRequest(
    {
      previous_response_id: "resp_long",
      input: "current question",
    },
    {
      ...route,
      contextWindow: 2048,
    },
    history,
  );

  const allText = converted.body.messages
    .map((message) => JSON.stringify(message.content))
    .join("\n");
  assert.doesNotMatch(allText, /old answer/);
  assert.match(allText, /recent context/);
  assert.match(allText, /current question/);
});

test("chat conversion trims CJK-heavy history by token budget instead of loose character budget", () => {
  const history = new ResponseHistory();
  history.record("resp_cjk_long", [
    { role: "user", content: "旧项目上下文".repeat(700) },
    { role: "assistant", content: "旧回答".repeat(700) },
    { role: "user", content: "最近上下文" },
  ]);

  const converted = responsesToChatRequest(
    {
      previous_response_id: "resp_cjk_long",
      input: "当前问题",
    },
    {
      ...route,
      contextWindow: 2048,
    },
    history,
  );

  const allText = converted.body.messages
    .map((message) => JSON.stringify(message.content))
    .join("\n");
  assert.doesNotMatch(allText, /旧项目上下文旧项目上下文旧项目上下文/);
  assert.match(allText, /最近上下文/);
  assert.match(allText, /当前问题/);
});

test("chat conversion keeps current input when system instructions exceed context budget", () => {
  const converted = responsesToChatRequest(
    {
      instructions: "system instructions ".repeat(30_000),
      input: "current question",
    },
    {
      ...route,
      contextWindow: 2048,
    },
    new ResponseHistory(),
  );

  const allText = converted.body.messages
    .map((message) => JSON.stringify(message.content))
    .join("\n");
  assert.match(allText, /Earlier conversation history was omitted/);
  assert.match(allText, /current question/);
});

test("chat conversion keeps unified history untrimmed when a small-context model trims its upstream payload", () => {
  const criticalDetail = "critical architecture detail: unified raw history. ";
  const history = new ResponseHistory();
  history.record("resp_large", [
    { role: "user", content: criticalDetail.repeat(500) },
    { role: "assistant", content: "old answer ".repeat(500) },
    { role: "user", content: "recent context" },
  ]);

  const small = responsesToChatRequest(
    {
      previous_response_id: "resp_large",
      input: "small model question",
    },
    {
      ...route,
      contextWindow: 2048,
    },
    history,
  );

  const smallPayloadText = small.body.messages
    .map((message) => JSON.stringify(message.content))
    .join("\n");
  assert.doesNotMatch(smallPayloadText, /critical architecture detail/);
  assert.match(smallPayloadText, /small model question/);

  history.record("resp_small", [
    ...small.messagesForHistory,
    { role: "assistant", content: "small answer" },
  ]);

  const large = responsesToChatRequest(
    {
      previous_response_id: "resp_small",
      input: "large model question",
    },
    {
      ...route,
      contextWindow: 300_000,
    },
    history,
  );

  const largePayloadText = large.body.messages
    .map((message) => JSON.stringify(message.content))
    .join("\n");
  assert.match(largePayloadText, /critical architecture detail/);
  assert.match(largePayloadText, /small answer/);
  assert.match(largePayloadText, /large model question/);
});

test("hybrid auth modes validate and default to api_key", () => {
  const config = {
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        api: "responses",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.5",
        authMode: "codex_openai",
      },
      {
        id: "gpt-5.2",
        displayName: "Kimi K2.7 Code",
        api: "chat_completions",
        baseUrl: "https://api.moonshot.cn/v1",
        model: "kimi-k2.7-code",
      },
    ],
  };

  assert.doesNotThrow(() => validateConfig(config));
  assert.equal(authModeForRoute(config.models[0]), "codex_openai");
  assert.equal(authModeForRoute(config.models[1]), "api_key");
});

test("invalid auth modes fail config validation", () => {
  assert.throws(
    () =>
      validateConfig({
        models: [
          {
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            api: "responses",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-5.5",
            authMode: "browser_magic",
          },
        ],
      }),
    /unsupported authMode browser_magic/,
  );
});

test("custom apply_patch maps to chat function and back to custom_tool_call", () => {
  const converted = responsesToChatRequest(
    {
      model: "deepseek-v4-pro",
      input: "edit a file",
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          description: "Use apply_patch.",
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.equal(converted.body.tools[0].function.name, "apply_patch");
  assert.deepEqual(converted.body.tools[0].function.parameters.required, ["input"]);

  const response = chatResponseToResponse(
    {
      id: "chatcmpl_apply",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_patch",
                type: "function",
                function: {
                  name: "apply_patch",
                  arguments:
                    '{"input":"*** Begin Patch\\n*** Add File: x.txt\\n+hi\\n*** End Patch"}',
                },
              },
            ],
          },
        },
      ],
    },
    "deepseek-v4-pro",
    converted.toolContext,
  );

  assert.equal(response.output[0].type, "custom_tool_call");
  assert.equal(response.output[0].name, "apply_patch");
  assert.match(response.output[0].input, /\*\*\* Begin Patch/);
});

test("previous_response_id restores assistant tool calls before tool output", () => {
  const history = new ResponseHistory();
  const first = responsesToChatRequest(
    {
      model: "deepseek-v4-pro",
      input: "run pwd",
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run command",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    },
    route,
    history,
  );

  const chat = {
    id: "chatcmpl_shell",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_shell",
              type: "function",
              function: {
                name: "shell_command",
                arguments: '{"command":"pwd"}',
              },
            },
          ],
        },
      },
    ],
  };
  const response = chatResponseToResponse(chat, "deepseek-v4-pro", first.toolContext);
  history.record(response.id, [
    ...first.messagesForHistory,
    assistantHistoryMessageFromChat(chat),
  ]);

  const second = responsesToChatRequest(
    {
      model: "deepseek-v4-pro",
      previous_response_id: response.id,
      input: [
        {
          type: "function_call_output",
          call_id: "call_shell",
          output: "F:\\game_code\\router",
        },
      ],
      tools: first.body.tools,
    },
    route,
    history,
  );

  assert.equal(second.body.messages.at(-2).role, "assistant");
  assert.equal(second.body.messages.at(-2).tool_calls[0].id, "call_shell");
  assert.equal(second.body.messages.at(-1).role, "tool");
  assert.equal(second.body.messages.at(-1).tool_call_id, "call_shell");
});

test("Gemini chat conversion flattens prior tool calls because thought signatures cannot be replayed", () => {
  const history = new ResponseHistory();
  history.record("resp_gemini_tool", [
    { role: "user", content: "run pwd" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_shell",
          type: "function",
          function: {
            name: "shell_command",
            arguments: '{"command":"pwd"}',
          },
        },
      ],
    },
  ]);

  const converted = responsesToChatRequest(
    {
      model: "gemini-3.1-pro-preview",
      previous_response_id: "resp_gemini_tool",
      input: [
        {
          type: "function_call_output",
          call_id: "call_shell",
          output: "F:\\game_code\\router",
        },
      ],
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run command",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    },
    {
      ...route,
      id: "gemini-3-1-pro",
      provider: "gemini",
      model: "gemini-3.1-pro-preview",
    },
    history,
  );

  assert.equal(
    converted.body.messages.some((message) => Array.isArray(message.tool_calls)),
    false,
  );
  assert.equal(
    converted.body.messages.some((message) => message.role === "tool"),
    false,
  );
  assert.match(
    converted.body.messages.map((message) => String(message.content || "")).join("\n"),
    /shell_command/,
  );
  assert.match(
    converted.body.messages.map((message) => String(message.content || "")).join("\n"),
    /F:\\game_code\\router/,
  );
  assert.equal(converted.body.tools.length, 1);
});

test("chat conversion keeps orphan tool output visible as user text", () => {
  const converted = responsesToChatRequest(
    {
      model: "deepseek-v4-pro",
      input: [
        {
          type: "function_call_output",
          call_id: "call_missing",
          output: "tool result that must not disappear",
        },
      ],
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run command",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
          },
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.equal(converted.body.messages.length, 1);
  assert.equal(converted.body.messages[0].role, "user");
  assert.match(converted.body.messages[0].content, /call_missing/);
  assert.match(converted.body.messages[0].content, /tool result that must not disappear/);
});

test("chat conversion drops stale assistant tool calls without tool outputs", () => {
  const history = new ResponseHistory();
  history.record("resp_stale_tool", [
    { role: "user", content: "create a file" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_stale",
          type: "function",
          function: {
            name: "shell_command",
            arguments: '{"command":"touch stale.txt"}',
          },
        },
      ],
    },
  ]);

  const converted = responsesToChatRequest(
    {
      model: "deepseek-v4-pro",
      previous_response_id: "resp_stale_tool",
      input: "hello again",
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run command",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    },
    route,
    history,
  );

  assert.equal(
    converted.body.messages.some((message) => Array.isArray(message.tool_calls)),
    false,
  );
  assert.deepEqual(
    converted.body.messages.map((message) => message.content),
    ["create a file", "hello again"],
  );
});

test("namespace tools are flattened for chat providers", () => {
  const converted = responsesToChatRequest(
    {
      input: "use mcp",
      tools: [
        {
          type: "namespace",
          name: "mcp__demo__",
          tools: [
            {
              type: "function",
              name: "demo_read",
              description: "Read",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.equal(converted.body.tools.length, 1);
  assert.equal(converted.body.tools[0].function.name, "mcp__demo__demo_read");
});

test("namespace tools keep unique names so MCP tools are not dropped", () => {
  const converted = responsesToChatRequest(
    {
      input: "use mcp",
      tools: [
        {
          type: "namespace",
          name: "mcp__filesystem__",
          tools: [
            {
              type: "function",
              name: "read",
              description: "Read file",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
        {
          type: "namespace",
          name: "mcp__browser__",
          tools: [
            {
              type: "function",
              name: "read",
              description: "Read page",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.deepEqual(
    converted.body.tools.map((tool) => tool.function.name),
    ["mcp__filesystem__read", "mcp__browser__read"],
  );
});

test("chat namespace tool calls are returned with full Codex tool names", () => {
  const converted = responsesToChatRequest(
    {
      input: "use node repl",
      tools: [
        {
          type: "namespace",
          name: "mcp__node_repl__",
          tools: [
            {
              type: "function",
              name: "js",
              description: "Run JavaScript.",
              parameters: {
                type: "object",
                properties: {
                  code: { type: "string" },
                },
                required: ["code"],
              },
            },
          ],
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  const response = chatResponseToResponse(
    {
      id: "chatcmpl_mcp",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_mcp",
                type: "function",
                function: {
                  name: "mcp__node_repl__js",
                  arguments: '{"code":"1 + 1"}',
                },
              },
            ],
          },
        },
      ],
    },
    "deepseek-v4-pro",
    converted.toolContext,
  );

  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].namespace, undefined);
  assert.equal(response.output[0].name, "mcp__node_repl__js");
  assert.equal(response.output[0].arguments, '{"code":"1 + 1"}');
});

test("namespace tool choice is flattened for chat providers", () => {
  const converted = responsesToChatRequest(
    {
      input: "use node repl",
      tool_choice: {
        type: "function",
        namespace: "mcp__node_repl__",
        name: "js",
      },
      tools: [
        {
          type: "namespace",
          name: "mcp__node_repl__",
          tools: [
            {
              type: "function",
              name: "js",
              description: "Run JavaScript.",
              parameters: {
                type: "object",
                properties: {
                  code: { type: "string" },
                },
                required: ["code"],
              },
            },
          ],
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.deepEqual(converted.body.tool_choice, {
    type: "function",
    function: { name: "mcp__node_repl__js" },
  });
});

test("chat providers get guidance for flattened MCP tools", () => {
  const converted = responsesToChatRequest(
    {
      input: "open Chrome",
      tools: [
        {
          type: "namespace",
          name: "mcp__node_repl__",
          tools: [
            {
              type: "function",
              name: "js",
              description: "Run JavaScript.",
              parameters: {
                type: "object",
                properties: {
                  code: { type: "string" },
                },
                required: ["code"],
              },
            },
          ],
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.equal(converted.body.messages[0].role, "system");
  assert.match(converted.body.messages[0].content, /mcp__node_repl__js/);
  assert.match(converted.body.messages[0].content, /Start-Process/);
});

test("chat providers get command guidance for explicit git push tasks", () => {
  const converted = responsesToChatRequest(
    {
      input: "push this commit to GitHub",
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run a shell command.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string" },
            },
            required: ["command"],
          },
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.equal(converted.body.messages[0].role, "system");
  assert.match(converted.body.messages[0].content, /git push/);
  assert.match(converted.body.messages[0].content, /attempted command returns that error/);
});

test("non-function Codex tools with schemas are exposed to chat providers", () => {
  const converted = responsesToChatRequest(
    {
      input: "take screenshot",
      tools: [
        {
          type: "computer_use",
          name: "computer_screenshot",
          description: "Capture the screen.",
          parameters: {
            type: "object",
            properties: {
              display_id: { type: "string" },
            },
          },
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.equal(converted.body.tools.length, 1);
  assert.equal(converted.body.tools[0].function.name, "computer_screenshot");
});

test("chat computer tool calls are returned as computer_call items", () => {
  const converted = responsesToChatRequest(
    {
      input: "take screenshot",
      tools: [
        {
          type: "computer_use",
          name: "computer_screenshot",
          description: "Capture the screen.",
          parameters: {
            type: "object",
            properties: {
              display_id: { type: "string" },
            },
          },
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  const response = chatResponseToResponse(
    {
      id: "chatcmpl_computer",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_screen",
                type: "function",
                function: {
                  name: "computer_screenshot",
                  arguments: '{"display_id":"main"}',
                },
              },
            ],
          },
        },
      ],
    },
    "deepseek-v4-pro",
    converted.toolContext,
  );

  assert.equal(response.output[0].type, "computer_call");
  assert.equal(response.output[0].call_id, "call_screen");
  assert.equal(response.output[0].name, "computer_screenshot");
  assert.deepEqual(response.output[0].arguments, { display_id: "main" });
});

test("computer call items are kept as paired chat tool calls", () => {
  const converted = responsesToChatRequest(
    {
      input: [
        {
          type: "computer_call",
          call_id: "call_screen",
          name: "computer_screenshot",
          arguments: { display_id: "main" },
        },
        {
          type: "computer_call_output",
          call_id: "call_screen",
          output: { text: "screenshot captured" },
        },
      ],
      tools: [
        {
          type: "computer_use",
          name: "computer_screenshot",
          description: "Capture the screen.",
          parameters: {
            type: "object",
            properties: {
              display_id: { type: "string" },
            },
          },
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.equal(converted.body.messages.at(-2).role, "assistant");
  assert.equal(
    converted.body.messages.at(-2).tool_calls[0].function.name,
    "computer_screenshot",
  );
  assert.equal(converted.body.messages.at(-1).role, "tool");
  assert.equal(converted.body.messages.at(-1).tool_call_id, "call_screen");
  assert.match(converted.body.messages.at(-1).content, /screenshot captured/);
});

test("chat conversion deduplicates exact tool names while keeping namespaced tools", () => {
  const converted = responsesToChatRequest(
    {
      input: "hello",
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run shell",
          parameters: { type: "object", properties: {} },
        },
        {
          type: "namespace",
          name: "mcp__duplicate__",
          tools: [
            {
              type: "function",
              name: "shell_command",
              description: "Run shell from namespace",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
        {
          type: "custom",
          name: "apply_patch",
          description: "Edit files.",
        },
        {
          type: "custom",
          name: "apply_patch",
          description: "Edit files again.",
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.deepEqual(
    converted.body.tools.map((tool) => tool.function.name),
    ["shell_command", "mcp__duplicate__shell_command", "apply_patch"],
  );
});

test("kimi chat conversion rewrites legacy JSON schema refs to $defs", () => {
  const converted = responsesToChatRequest(
    {
      input: "use typed tool",
      tools: [
        {
          type: "function",
          name: "select_body_parts",
          description: "Select body parts.",
          parameters: {
            type: "object",
            properties: {
              excludedBodyParts: {
                type: "array",
                items: {
                  $ref: "#/definitions/BodyPart",
                },
              },
            },
            definitions: {
              BodyPart: {
                type: "string",
                enum: ["head", "arm", "leg"],
              },
            },
          },
        },
      ],
    },
    {
      ...route,
      id: "gpt-5.2",
      displayName: "Kimi K2.7 Code",
      provider: "kimi",
      model: "kimi-k2.7-code",
      baseUrl: "https://api.moonshot.cn/v1",
    },
    new ResponseHistory(),
  );

  const parameters = converted.body.tools[0].function.parameters;
  assert.equal(parameters.properties.excludedBodyParts.items.$ref, "#/$defs/BodyPart");
  assert.deepEqual(parameters.$defs.BodyPart.enum, ["head", "arm", "leg"]);
  assert.equal(parameters.definitions, undefined);
});

test("kimi chat conversion inlines local property refs that Moonshot rejects", () => {
  const converted = responsesToChatRequest(
    {
      input: "use typed tool",
      tools: [
        {
          type: "function",
          name: "select_body_parts",
          description: "Select body parts.",
          parameters: {
            type: "object",
            properties: {
              excludedBodyParts: {
                type: "array",
                items: {
                  $ref: "#/properties/bodyPart",
                },
              },
              bodyPart: {
                type: "string",
                enum: ["head", "arm", "leg"],
              },
            },
          },
        },
      ],
    },
    {
      ...route,
      id: "gpt-5.2",
      displayName: "Kimi K2.7 Code",
      provider: "kimi",
      model: "kimi-k2.7-code",
      baseUrl: "https://api.moonshot.cn/v1",
    },
    new ResponseHistory(),
  );

  const parameters = converted.body.tools[0].function.parameters;
  assert.equal(parameters.properties.excludedBodyParts.items.$ref, undefined);
  assert.deepEqual(parameters.properties.excludedBodyParts.items.enum, [
    "head",
    "arm",
    "leg",
  ]);
});

test("minimax chat routes request separated reasoning output", () => {
  const converted = responsesToChatRequest(
    {
      input: "hello",
    },
    {
      ...route,
      id: "gpt-5.4-mini",
      provider: "minimax",
      model: "MiniMax-M3",
      baseUrl: "https://api.minimaxi.com/v1",
    },
    new ResponseHistory(),
  );

  assert.equal(converted.body.reasoning_split, true);
});

test("minimax reasoning tags are hidden from Codex output", () => {
  const response = chatResponseToResponse(
    {
      id: "chatcmpl_minimax",
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "<think>\nI should not show this internal reasoning.\n</think>\n我是 MiniMax M3。",
          },
        },
      ],
    },
    "gpt-5.4-mini",
    {},
    { stripReasoningTags: true },
  );

  assert.equal(response.output_text, "我是 MiniMax M3。");
  assert.equal(response.output[0].content[0].text, "我是 MiniMax M3。");
});
