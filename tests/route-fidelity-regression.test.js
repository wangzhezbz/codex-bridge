import test from "node:test";
import assert from "node:assert/strict";
import { filterPayloadForAdapter } from "../src/adapter-profile.js";
import {
  buildCompactChatRequest,
  buildCompactResponsesRequest,
  compactResponseFromChat,
} from "../src/compact.js";
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

const minimaxRoute = {
  id: "minimax-m3",
  displayName: "MiniMax M3",
  provider: "minimax",
  api: "chat_completions",
  baseUrl: "https://api.minimaxi.com/v1",
  model: "MiniMax-M3",
  apiKey: "minimax-key",
  dropParams: ["response_format", "parallel_tool_calls"],
};

const doubaoRoute = {
  id: "doubao-seed-1-8",
  displayName: "Doubao Seed 1.8",
  provider: "volcengine",
  api: "chat_completions",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  model: "doubao-seed-1-8-251228",
  apiKey: "doubao-key",
  dropParams: ["response_format", "parallel_tool_calls"],
};

const qwenRoute = {
  id: "qwen3-coder-plus",
  displayName: "Qwen3 Coder Plus",
  provider: "qwen",
  api: "chat_completions",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen3-coder-plus",
  apiKey: "qwen-key",
  dropParams: ["parallel_tool_calls"],
};

const zhipuRoute = {
  id: "glm-4-6",
  displayName: "GLM-4.6",
  provider: "zhipu",
  api: "chat_completions",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  model: "glm-4.6",
  apiKey: "zhipu-key",
  dropParams: ["parallel_tool_calls"],
};

const openrouterRoute = {
  id: "openrouter-sonnet",
  displayName: "OpenRouter Claude Sonnet",
  provider: "openrouter",
  api: "chat_completions",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "anthropic/claude-sonnet-4.5",
  apiKey: "openrouter-key",
  inputModalities: ["text", "image"],
  dropParams: ["parallel_tool_calls"],
};

const siliconflowRoute = {
  id: "siliconflow-qwen3-coder",
  displayName: "SiliconFlow Qwen3 Coder",
  provider: "siliconflow",
  api: "chat_completions",
  baseUrl: "https://api.siliconflow.cn/v1",
  model: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
  apiKey: "siliconflow-key",
  dropParams: ["parallel_tool_calls"],
};

const chatMainChainRoutes = [
  deepseekRoute,
  kimiRoute,
  minimaxRoute,
  doubaoRoute,
  qwenRoute,
  zhipuRoute,
  openrouterRoute,
  siliconflowRoute,
  customRoute,
];

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

test("route fidelity matrix covers provider main-chain chat contracts", () => {
  for (const route of chatMainChainRoutes) {
    const converted = responsesToChatRequest(
      {
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: `matrix text for ${route.id}` },
              {
                type: "input_image",
                image_url: "data:image/png;base64,abc123",
                detail: "high",
              },
              {
                type: "input_file",
                filename: "report.csv",
                file_data: "data:text/csv;base64,Y29sCnZhbHVl",
              },
            ],
          },
        ],
        response_format: { type: "json_object" },
        parallel_tool_calls: true,
        tools: matrixTools(),
        tool_choice: { type: "function", name: "shell_command" },
      },
      route,
      new ResponseHistory(),
    );
    const filtered = filterPayloadForAdapter(converted.body, route);
    const payload = JSON.stringify(filtered);

    assert.equal(filtered.model, route.model, route.id);
    assert.match(payload, new RegExp(`matrix text for ${escapeRegExp(route.id)}`), route.id);
    assert.match(payload, /report\.csv/, route.id);
    assert.doesNotMatch(payload, /data:text\/csv/, route.id);
    assert.deepEqual(
      filtered.tools.map((tool) => tool.function.name),
      ["shell_command", "mcp__filesystem__read_file"],
      route.id,
    );
    assert.deepEqual(
      filtered.tool_choice,
      { type: "function", function: { name: "shell_command" } },
      route.id,
    );

    if ((route.inputModalities || []).includes("image")) {
      assert.match(payload, /"image_url"/, route.id);
    } else {
      assert.doesNotMatch(payload, /"image_url"/, route.id);
      assert.match(payload, /image input not forwarded/, route.id);
    }

    if ((route.dropParams || []).includes("response_format")) {
      assert.equal(filtered.response_format, undefined, route.id);
    } else {
      assert.deepEqual(filtered.response_format, { type: "json_object" }, route.id);
    }
    if ((route.dropParams || []).includes("parallel_tool_calls")) {
      assert.equal(filtered.parallel_tool_calls, undefined, route.id);
    } else {
      assert.equal(filtered.parallel_tool_calls, true, route.id);
    }

    const history = new ResponseHistory();
    history.record(`resp_matrix_${route.id}`, [
      { role: "user", content: `prior matrix context for ${route.id}` },
      { role: "assistant", content: "prior matrix answer" },
    ]);
    const followUp = responsesToChatRequest(
      {
        previous_response_id: `resp_matrix_${route.id}`,
        input: "continue matrix task",
      },
      route,
      history,
    );
    const followUpPayload = JSON.stringify(followUp.body.messages);
    assert.match(followUpPayload, new RegExp(`prior matrix context for ${escapeRegExp(route.id)}`), route.id);
    assert.match(followUpPayload, /continue matrix task/, route.id);

    const compact = buildCompactChatRequest(
      {
        model: route.id,
        stream: true,
        input: [
          { type: "message", role: "user", content: `compact ${route.id}` },
          { type: "compaction_trigger" },
        ],
        tools: matrixTools(),
        tool_choice: { type: "function", name: "shell_command" },
        parallel_tool_calls: true,
      },
      route,
      new ResponseHistory(),
    );
    assert.equal(compact.body.stream, false, route.id);
    assert.equal(compact.body.tools, undefined, route.id);
    assert.equal(compact.body.tool_choice, undefined, route.id);
    assert.equal(compact.body.parallel_tool_calls, undefined, route.id);
    assert.match(JSON.stringify(compact.body.messages), /CONTEXT CHECKPOINT COMPACTION/, route.id);
  }
});

test("route fidelity matrix keeps native GPT Responses contracts separate", () => {
  const catalog = buildModelCatalog({
    models: [gptRoute, ...chatMainChainRoutes],
  });
  const gpt = catalog.models.find((model) => model.slug === gptRoute.id);
  assert.deepEqual(gpt.input_modalities, ["text", "image"]);
  assert.equal(gpt.shell_type, "shell_command");
  assert.equal(gpt.apply_patch_tool_type, "freeform");

  const filtered = filterPayloadForAdapter(
    {
      model: gptRoute.model,
      input: "native responses text",
      metadata: { trace: "ok" },
      store: true,
      response_format: { type: "json_object" },
    },
    gptRoute,
  );
  assert.deepEqual(filtered.metadata, { trace: "ok" });
  assert.equal(filtered.store, true);
  assert.equal(filtered.response_format, undefined);

  const compact = buildCompactResponsesRequest({
    model: gptRoute.id,
    stream: false,
    input: [
      { type: "message", role: "user", content: "native compact text" },
      { type: "compaction_trigger" },
    ],
    tools: matrixTools(),
    tool_choice: { type: "function", name: "shell_command" },
    parallel_tool_calls: true,
    response_format: { type: "json_object" },
  }, { stream: true });

  assert.equal(compact.stream, true);
  assert.equal(compact.tools, undefined);
  assert.equal(compact.tool_choice, undefined);
  assert.equal(compact.parallel_tool_calls, undefined);
  assert.equal(compact.response_format, undefined);
  assert.match(JSON.stringify(compact.input), /CONTEXT CHECKPOINT COMPACTION/);
  assert.doesNotMatch(JSON.stringify(compact.input), /compaction_trigger/);
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
  assert.match(content[2].text, /File attachment unavailable to this chat provider: large-log\.txt/);
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

test("route fidelity compaction uses chat-summary requests for Kimi and custom routes", () => {
  for (const route of [kimiRoute, customRoute]) {
    const compact = buildCompactChatRequest(
      {
        model: route.id,
        stream: true,
        input: [
          {
            type: "message",
            role: "user",
            content: `${route.id} should compact without tools`,
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
      route,
      new ResponseHistory(),
    );

    assert.equal(compact.body.stream, false, route.id);
    assert.equal(compact.body.stream_options, undefined, route.id);
    assert.equal(compact.body.tools, undefined, route.id);
    assert.equal(compact.body.tool_choice, undefined, route.id);
    assert.equal(compact.body.parallel_tool_calls, undefined, route.id);
    assert.match(JSON.stringify(compact.body.messages), /CONTEXT CHECKPOINT COMPACTION/);
    assert.doesNotMatch(JSON.stringify(compact.body.messages), /compaction_trigger/);
  }
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

test("route fidelity prevents malformed tool outputs from reaching chat upstreams", () => {
  for (const route of [deepseekRoute, kimiRoute, customRoute]) {
    const history = new ResponseHistory();
    history.record(`resp_ppt_${route.id}`, [
      { role: "user", content: "create a ppt" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_create_ppt",
            type: "function",
            function: {
              name: "shell_command",
              arguments: '{"command":"New-Item deck.pptx"}',
            },
          },
        ],
      },
    ]);

    const converted = responsesToChatRequest(
      {
        model: route.id,
        previous_response_id: `resp_ppt_${route.id}`,
        input: [
          {
            type: "function_call_output",
            call_id: "call_create_ppt",
            output: "created deck.pptx",
          },
          {
            type: "function_call_output",
            output: "ppt export finished without a call id",
          },
          {
            type: "function_call_output",
            call_id: "call_unmatched_export",
            output: "extra ppt export result from a stale tool call",
          },
        ],
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
      route,
      history,
    );

    const toolMessages = converted.body.messages.filter((message) => message.role === "tool");
    assert.deepEqual(
      toolMessages.map((message) => message.tool_call_id),
      ["call_create_ppt"],
    );
    assert.equal(
      toolMessages.some((message) => !message.tool_call_id),
      false,
    );

    const transcript = JSON.stringify(converted.body.messages);
    assert.match(transcript, /created deck\.pptx/);
    assert.match(transcript, /ppt export finished without a call id/);
    assert.match(transcript, /extra ppt export result from a stale tool call/);
    assert.match(transcript, /CodexBridge tool result context/);
  }
});

test("route fidelity treats generated file tool outputs by call pairing, not file extension", () => {
  const generatedFiles = [
    "deck.pptx",
    "brief.pdf",
    "notes.docx",
    "table.xlsx",
    "archive.zip",
  ];

  for (const route of [deepseekRoute, kimiRoute, customRoute]) {
    for (const fileName of generatedFiles) {
      const history = new ResponseHistory();
      history.record(`resp_file_${route.id}_${fileName}`, [
        { role: "user", content: `create ${fileName}` },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_create_file",
              type: "function",
              function: {
                name: "shell_command",
                arguments: `{"command":"New-Item ${fileName}"}`,
              },
            },
          ],
        },
      ]);

      const converted = responsesToChatRequest(
        {
          model: route.id,
          previous_response_id: `resp_file_${route.id}_${fileName}`,
          input: [
            {
              type: "function_call_output",
              call_id: "call_create_file",
              output: `created ${fileName}`,
            },
            {
              type: "function_call_output",
              output: `post-processing finished for ${fileName}`,
            },
          ],
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
        route,
        history,
      );

      const toolMessages = converted.body.messages.filter((message) => message.role === "tool");
      assert.deepEqual(
        toolMessages.map((message) => message.tool_call_id),
        ["call_create_file"],
      );
      assert.equal(
        toolMessages.some((message) => !message.tool_call_id),
        false,
      );

      const transcript = JSON.stringify(converted.body.messages);
      assert.match(transcript, new RegExp(`created ${escapeRegExp(fileName)}`));
      assert.match(transcript, new RegExp(`post-processing finished for ${escapeRegExp(fileName)}`));
      assert.match(transcript, /CodexBridge tool result context/);
    }
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matrixTools() {
  return [
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
  ];
}
