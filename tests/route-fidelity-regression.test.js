import test from "node:test";
import assert from "node:assert/strict";
import { filterPayloadForAdapter } from "../src/adapter-profile.js";
import { buildCompactChatRequest, compactResponseFromChat } from "../src/compact.js";
import {
  assistantHistoryMessageFromChat,
  chatResponseToResponse,
} from "../src/chat-to-responses.js";
import { ResponseHistory } from "../src/history.js";
import { buildModelCatalog } from "../src/model-catalog.js";
import {
  responseInputToChatMessages,
  responsesToChatRequest,
} from "../src/responses-to-chat.js";

const gptRoute = {
  id: "gpt-5.5",
  displayName: "GPT-5.5",
  api: "responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  model: "gpt-5.5",
  authMode: "codex_openai",
  inputModalities: ["text", "image"],
};

const deepseekRoute = {
  id: "deepseek-v4-pro",
  displayName: "DeepSeek V4 Pro",
  provider: "deepseek",
  api: "chat_completions",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-v4-pro",
  apiKey: "deepseek-key",
  dropParams: ["response_format", "parallel_tool_calls"],
};

const kimiRoute = {
  id: "kimi-k2-code",
  displayName: "Kimi K2 Code",
  provider: "kimi",
  api: "chat_completions",
  baseUrl: "https://api.moonshot.cn/v1",
  model: "kimi-k2-code",
  apiKey: "kimi-key",
  inputModalities: ["text", "image"],
  dropParams: ["response_format", "parallel_tool_calls"],
};

const customRoute = {
  id: "custom-openai",
  displayName: "Custom OpenAI-Compatible",
  provider: "custom",
  custom: true,
  api: "chat_completions",
  baseUrl: "https://api.example.com/v1",
  model: "custom-openai",
  apiKey: "custom-key",
  inputModalities: ["text", "image"],
};

test("route fidelity catalog keeps Codex tool capability across native, chat, and custom models", () => {
  const catalog = buildModelCatalog({
    models: [gptRoute, deepseekRoute, kimiRoute, customRoute],
  });

  assert.equal(catalog.models.length, 4);
  for (const model of catalog.models) {
    assert.equal(model.shell_type, "shell_command");
    assert.equal(model.apply_patch_tool_type, "freeform");
    assert.equal(model.supports_parallel_tool_calls, true);
    assert.deepEqual(
      model.supported_reasoning_levels.map((level) => level.effort),
      ["low", "medium", "high", "xhigh"],
    );
  }

  assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
  assert.deepEqual(catalog.models[1].input_modalities, ["text"]);
  assert.deepEqual(catalog.models[2].input_modalities, ["text", "image"]);
  assert.deepEqual(catalog.models[3].input_modalities, ["text", "image"]);
});

test("route fidelity preserves custom OpenAI-compatible params while honoring provider drops", () => {
  const request = {
    input: "return json after using lookup",
    response_format: { type: "json_object" },
    parallel_tool_calls: true,
    tools: [
      {
        type: "function",
        name: "lookup",
        description: "Lookup a value.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string" },
          },
          required: ["key"],
        },
      },
    ],
    tool_choice: {
      type: "function",
      name: "lookup",
    },
  };

  const custom = responsesToChatRequest(request, customRoute, new ResponseHistory());
  const customFiltered = filterPayloadForAdapter(custom.body, customRoute);
  assert.deepEqual(customFiltered.response_format, { type: "json_object" });
  assert.equal(customFiltered.parallel_tool_calls, true);
  assert.equal(customFiltered.tools[0].function.name, "lookup");
  assert.deepEqual(customFiltered.tool_choice, {
    type: "function",
    function: { name: "lookup" },
  });

  const deepseek = responsesToChatRequest(request, deepseekRoute, new ResponseHistory());
  const deepseekFiltered = filterPayloadForAdapter(deepseek.body, deepseekRoute);
  assert.equal(deepseekFiltered.response_format, undefined);
  assert.equal(deepseekFiltered.parallel_tool_calls, undefined);
  assert.equal(deepseekFiltered.tools[0].function.name, "lookup");
  assert.deepEqual(deepseekFiltered.tool_choice, {
    type: "function",
    function: { name: "lookup" },
  });
});

test("route fidelity keeps MCP namespace tools callable and mapped back to Codex names", () => {
  const converted = responsesToChatRequest(
    {
      input: "read the selected file through MCP",
      tools: [
        {
          type: "namespace",
          name: "mcp__filesystem__",
          tools: [
            {
              type: "function",
              name: "read_file",
              description: "Read a file.",
              parameters: {
                type: "object",
                properties: {
                  path: { type: "string" },
                },
                required: ["path"],
              },
            },
          ],
        },
      ],
    },
    kimiRoute,
    new ResponseHistory(),
  );

  assert.match(converted.body.messages[0].content, /MCP namespace tools/);
  assert.equal(converted.body.tools[0].function.name, "mcp__filesystem__read_file");

  const response = chatResponseToResponse(
    {
      id: "chatcmpl_mcp_read",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_read",
                type: "function",
                function: {
                  name: "mcp__filesystem__read_file",
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
        },
      ],
    },
    kimiRoute.id,
    converted.toolContext,
  );

  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].name, "mcp__filesystem__read_file");
  assert.equal(response.output[0].call_id, "call_read");
});

test("route fidelity degrades images and files intentionally for chat routes", () => {
  const hugeDataUrl = `data:image/png;base64,${"a".repeat(2_100_000)}`;
  const converted = responsesToChatRequest(
    {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "summarize all attached context" },
            {
              type: "input_image",
              image_url: hugeDataUrl,
              detail: "high",
            },
            {
              type: "input_file",
              filename: "large-log.txt",
              file_data: "data:text/plain;base64,abc123",
            },
          ],
        },
      ],
    },
    customRoute,
    new ResponseHistory(),
  );

  const content = converted.body.messages.at(-1).content;
  assert.equal(Array.isArray(content), true);
  assert.deepEqual(
    content.map((part) => part.type),
    ["text", "text", "text"],
  );
  assert.equal(content[0].text, "summarize all attached context");
  assert.match(content[1].text, /image input omitted because it is too large/);
  assert.match(content[2].text, /file input not forwarded to chat provider: large-log\.txt/);
  assert.doesNotMatch(JSON.stringify(content), /data:image\/png;base64/);
  assert.doesNotMatch(JSON.stringify(content), /data:text\/plain;base64/);
});

test("route fidelity does not forward images to text-only chat routes", () => {
  const request = {
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "describe this screenshot" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,abc123",
            detail: "high",
          },
        ],
      },
    ],
  };

  const textOnly = responsesToChatRequest(request, deepseekRoute, new ResponseHistory());
  const textOnlyPayload = JSON.stringify(textOnly.body.messages);
  assert.doesNotMatch(textOnlyPayload, /"image_url"/);
  assert.match(textOnlyPayload, /image input not forwarded/);

  const imageCapable = responsesToChatRequest(request, kimiRoute, new ResponseHistory());
  assert.match(JSON.stringify(imageCapable.body.messages), /"image_url"/);
});

test("route fidelity keeps unified history when switching between small and large chat models", () => {
  const history = new ResponseHistory();
  const criticalDetail = "critical cache key and route decision must survive. ";
  history.record("resp_gpt_large", [
    { role: "user", content: criticalDetail.repeat(300) },
    { role: "assistant", content: "GPT answer with a tool decision." },
    { role: "user", content: "recent user context" },
  ]);

  const small = responsesToChatRequest(
    {
      previous_response_id: "resp_gpt_large",
      input: "small model turn",
    },
    {
      ...deepseekRoute,
      contextWindow: 2048,
    },
    history,
  );
  const smallPayload = JSON.stringify(small.body.messages);
  assert.doesNotMatch(smallPayload, /critical cache key/);
  assert.match(smallPayload, /small model turn/);

  history.record("resp_small_chat", [
    ...small.messagesForHistory,
    { role: "assistant", content: "small model answer" },
  ]);
  const large = responsesToChatRequest(
    {
      previous_response_id: "resp_small_chat",
      input: "large model turn",
    },
    {
      ...customRoute,
      contextWindow: 300_000,
    },
    history,
  );
  const largePayload = JSON.stringify(large.body.messages);
  assert.match(largePayload, /critical cache key and route decision must survive/);
  assert.match(largePayload, /small model answer/);
  assert.match(largePayload, /large model turn/);
});

test("route fidelity compaction strips tools from upstream summarization and replays summary as context", () => {
  const compact = buildCompactChatRequest(
    {
      model: deepseekRoute.id,
      input: [
        {
          type: "message",
          role: "user",
          content: "first task detail",
        },
        { type: "compaction_trigger" },
      ],
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run shell.",
          parameters: { type: "object" },
        },
      ],
      tool_choice: { type: "function", name: "shell_command" },
      parallel_tool_calls: true,
    },
    deepseekRoute,
    new ResponseHistory(),
  );

  assert.equal(compact.body.tools, undefined);
  assert.equal(compact.body.tool_choice, undefined);
  assert.equal(compact.body.parallel_tool_calls, undefined);
  assert.doesNotMatch(JSON.stringify(compact.body.messages), /compaction_trigger/);
  assert.match(JSON.stringify(compact.body.messages), /CONTEXT CHECKPOINT COMPACTION/);

  const response = compactResponseFromChat(
    {
      id: "chatcmpl_compact",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Summary: preserve the route decision and latest user task.",
          },
        },
      ],
    },
    deepseekRoute.id,
  );
  const replay = responseInputToChatMessages([
    response.output[0],
    {
      type: "message",
      role: "user",
      content: "continue after compact",
    },
  ]);

  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].type, "compaction");
  assert.match(replay[0].content, /Summary: preserve the route decision/);
  assert.equal(replay[1].content, "continue after compact");
});

test("route fidelity preserves prior tool history before switching chat models", () => {
  const history = new ResponseHistory();
  const first = responsesToChatRequest(
    {
      model: kimiRoute.id,
      input: "run shell",
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run shell.",
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
    kimiRoute,
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
  const response = chatResponseToResponse(chat, kimiRoute.id, first.toolContext);
  history.record(response.id, [
    ...first.messagesForHistory,
    assistantHistoryMessageFromChat(chat),
  ]);

  const second = responsesToChatRequest(
    {
      model: deepseekRoute.id,
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
    deepseekRoute,
    history,
  );

  assert.equal(second.body.messages.at(-2).role, "assistant");
  assert.equal(second.body.messages.at(-2).tool_calls[0].id, "call_shell");
  assert.equal(second.body.messages.at(-1).role, "tool");
  assert.equal(second.body.messages.at(-1).tool_call_id, "call_shell");
});
