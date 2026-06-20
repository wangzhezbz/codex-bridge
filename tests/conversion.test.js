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
    ["none", "high", "max"],
  );
  assert.equal(catalog.models[0].default_reasoning_level, "high");
});

test("kimi catalog uses binary reasoning levels", () => {
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
    ["none", "max"],
  );
  assert.equal(catalog.models[0].default_reasoning_level, "max");
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
  assert.equal(converted.body.tools[0].function.name, "demo_read");
});
