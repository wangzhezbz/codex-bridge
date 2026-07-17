import test from "node:test";
import assert from "node:assert/strict";
import { buildModelCatalog, openAiModelsList } from "../src/model-catalog.js";
import { authModeForRoute, validateConfig } from "../src/config.js";
import { ResponseHistory } from "../src/history.js";
import { filterPayloadForAdapter } from "../src/adapter-profile.js";
import {
  responseInputToChatMessages,
  responsesToChatRequest,
} from "../src/responses-to-chat.js";
import {
  assistantHistoryMessageFromChat,
  chatResponseToResponse,
  returnedToolDiagnosticsFromChat,
  returnedToolDiagnosticsLogFields,
  responseToSse,
} from "../src/chat-to-responses.js";
import { toolDiagnosticsLogFields } from "../src/tools.js";

const route = {
  id: "deepseek-v4-pro",
  model: "deepseek-v4-pro",
  api: "chat_completions",
  baseUrl: "http://example.test/v1",
  apiKey: "test",
  dropParams: ["response_format", "parallel_tool_calls"],
};

const imageRoute = {
  ...route,
  inputModalities: ["text", "image"],
};

test("previous_response_id removes only an exact full persisted-history input prefix", () => {
  const priorMessages = [
    { content: "persisted user turn", role: "user" },
    { content: "persisted assistant turn", role: "assistant" },
  ];
  const history = {
    get: () => priorMessages,
  };
  const converted = responsesToChatRequest({
    model: route.id,
    previous_response_id: "resp_previous",
    input: [
      { role: "user", content: "persisted user turn" },
      { role: "assistant", content: "persisted assistant turn" },
      { role: "user", content: "true delta turn" },
    ],
  }, route, history);

  assert.deepEqual(converted.body.messages, [
    { content: "persisted user turn", role: "user" },
    { content: "persisted assistant turn", role: "assistant" },
    { role: "user", content: "true delta turn" },
  ]);
  assert.deepEqual(converted.messagesForHistory, converted.body.messages);
});

test("previous_response_id keeps an isolated repeated sentence that is not the full history prefix", () => {
  const priorMessages = [
    { role: "user", content: "repeat me" },
    { role: "assistant", content: "prior answer" },
  ];
  const converted = responsesToChatRequest({
    model: route.id,
    previous_response_id: "resp_previous",
    input: [{ role: "user", content: "repeat me" }],
  }, route, { get: () => priorMessages });

  assert.deepEqual(converted.body.messages, [
    ...priorMessages,
    { role: "user", content: "repeat me" },
  ]);
});

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
  assert.equal(catalog.models[0].supports_tools, "chat-functions");
  assert.equal(catalog.models[0].supports_mcp_namespaces, true);
  assert.equal(catalog.models[0].codexbridge_capabilities.tools, "chat-functions");
  assert.equal(catalog.models[0].codexbridge_capabilities.mcp_namespaces, "native");
  assert.deepEqual(
    catalog.models[0].supported_reasoning_levels.map((level) => level.effort),
    ["low", "medium", "high", "xhigh"],
  );
  assert.equal(catalog.models[0].default_reasoning_level, "medium");
});

test("model catalog preserves GPT 5.6 Responses Lite metadata", () => {
  const supportedReasoningLevels = [
    { effort: "low", description: "low" },
    { effort: "medium", description: "medium" },
    { effort: "high", description: "high" },
    { effort: "xhigh", description: "xhigh" },
    { effort: "max", description: "max" },
    { effort: "ultra", description: "ultra" },
  ];
  const catalog = buildModelCatalog({
    models: [
      {
        id: "cb-gpt-5-6-sol",
        displayName: "GPT-5.6-Sol",
        api: "responses",
        model: "gpt-5.6-sol",
        contextWindow: 372000,
        defaultReasoningLevel: "low",
        supportedReasoningLevels,
        useResponsesLite: true,
        supportsReasoningSummaries: true,
        defaultReasoningSummary: "none",
        supportVerbosity: true,
        defaultVerbosity: "low",
        webSearchToolType: "text_and_image",
        toolMode: "code_mode_only",
        multiAgentVersion: "v2",
      },
    ],
  });
  const model = catalog.models[0];

  assert.equal(model.context_window, 372000);
  assert.equal(model.max_context_window, 372000);
  assert.equal(model.default_reasoning_level, "low");
  assert.deepEqual(model.supported_reasoning_levels, supportedReasoningLevels);
  assert.equal(model.use_responses_lite, true);
  assert.equal(model.supports_reasoning_summaries, true);
  assert.equal(model.default_reasoning_summary, "none");
  assert.equal(model.support_verbosity, true);
  assert.equal(model.default_verbosity, "low");
  assert.equal(model.web_search_tool_type, "text_and_image");
  assert.equal(model.tool_mode, "code_mode_only");
  assert.equal(model.multi_agent_version, "v2");
});

test("OpenAI model list exposes display names for Codex model picker fallback", () => {
  const list = openAiModelsList({
    models: [
      {
        id: "cb-deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        description: "DeepSeek V4 Pro via DeepSeek.",
        api: "chat_completions",
        baseUrl: "http://example.test/v1",
        model: "deepseek-v4-pro",
        provider: "deepseek",
      },
    ],
  });

  assert.equal(list.data[0].id, "cb-deepseek-v4-pro");
  assert.equal(list.data[0].name, "DeepSeek V4 Pro");
  assert.equal(list.data[0].display_name, "DeepSeek V4 Pro");
  assert.equal(list.data[0].description, "DeepSeek V4 Pro via DeepSeek.");
  assert.equal(list.data[0].slug, "cb-deepseek-v4-pro");
  assert.equal(list.data[0].shell_type, "shell_command");
  assert.equal(list.data[0].apply_patch_tool_type, "freeform");
  assert.equal(list.data[0].supports_tools, "chat-functions");
  assert.equal(list.data[0].supports_mcp_namespaces, true);
  assert.equal(list.data[0].codexbridge_capabilities.tools, "chat-functions");
  assert.equal(list.data[0].codexbridge_capabilities.mcp_namespaces, "native");
});

test("OpenAI model list keeps normalized identity when provider is inferred from capabilities", () => {
  const list = openAiModelsList({
    models: [
      {
        id: "cb-kimi-k2-7-code",
        displayName: "Kimi K2.7 Code",
        description: "Kimi coding route.",
        api: "chat_completions",
        baseUrl: "http://example.test/v1",
        model: "kimi-k2.7-code",
        providerFamily: "kimi",
      },
    ],
  });

  assert.equal(list.data[0].id, "cb-kimi-k2-7-code");
  assert.equal(list.data[0].name, "Kimi K2.7 Code");
  assert.equal(list.data[0].display_name, "Kimi K2.7 Code");
  assert.equal(list.data[0].owned_by, "kimi");
  assert.equal(list.data[0].provider, "kimi");
  assert.equal(list.data[0].model, "kimi-k2.7-code");
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

test("model catalog does not let global catalog context cap per-route context windows", () => {
  const catalog = buildModelCatalog({
    models: [
      {
        id: "gpt-5.5",
        displayName: "OpenAI GPT-4.1",
        api: "responses",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4.1",
        contextWindow: 1_047_576,
      },
    ],
    catalog: {
      contextWindow: 258400,
      effectiveContextWindowPercent: 95,
      autoCompactPercent: 80,
    },
  });

  assert.equal(catalog.models[0].context_window, 1_047_576);
  assert.equal(catalog.models[0].max_context_window, 1_047_576);
  assert.equal(catalog.models[0].truncation_policy.limit, 995_197);
  assert.equal(catalog.models[0].auto_compact_token_limit, 838_060);
});

test("chat catalog keeps the configured upstream context instead of inflating history", () => {
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

  assert.equal(catalog.models[0].context_window, 8192);
  assert.equal(catalog.models[0].truncation_policy.limit, 7782);
  assert.equal(catalog.models[0].auto_compact_token_limit, 6553);
});

test("chat catalog caps an oversized catalog context window to the upstream limit", () => {
  const catalog = buildModelCatalog({
    models: [
      {
        id: "gpt-5.2",
        displayName: "ERNIE 4.0 Turbo 8K",
        api: "chat_completions",
        baseUrl: "http://example.test/v1",
        model: "ernie-4.0-turbo-8k",
        contextWindow: 8192,
        catalogContextWindow: 200000,
      },
    ],
  });

  assert.equal(catalog.models[0].context_window, 8192);
  assert.equal(catalog.models[0].truncation_policy.limit, 7782);
  assert.equal(catalog.models[0].auto_compact_token_limit, 6553);
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
    imageRoute,
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
    imageRoute,
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

test("chat conversion forwards audio only for explicit chat audio-capable routes", () => {
  const audioRoute = {
    ...route,
    provider: "custom",
    custom: true,
    inputModalities: ["text", "audio"],
  };
  const converted = responsesToChatRequest(
    {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "transcribe this clip" },
            {
              type: "input_audio",
              input_audio: {
                data: "UklGRgAAAAA=",
                format: "wav",
              },
            },
          ],
        },
      ],
    },
    audioRoute,
    new ResponseHistory(),
  );

  assert.deepEqual(converted.body.messages.at(-1).content, [
    { type: "text", text: "transcribe this clip" },
    {
      type: "input_audio",
      input_audio: {
        data: "UklGRgAAAAA=",
        format: "wav",
      },
    },
  ]);
});

test("chat conversion turns unsupported audio into a clear placeholder", () => {
  const converted = responsesToChatRequest(
    {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "transcribe this clip" },
            {
              type: "input_audio",
              input_audio: {
                data: "UklGRgAAAAA=",
                format: "wav",
              },
            },
          ],
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  const payload = JSON.stringify(converted.body.messages);
  assert.match(payload, /CodexBridge attachment guidance/);
  assert.equal(
    converted.body.messages.at(-1).content,
    "transcribe this clip\n[CodexBridge 当前不会把音频直接转发给这个 Chat 模型：wav 音频。请先提供文字转录后再继续。]",
  );
  assert.doesNotMatch(payload, /UklGRgAAAAA=/);
  assert.doesNotMatch(payload, /input_audio/);
  assert.doesNotMatch(payload, /not forwarded to this chat provider/);
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
    "summarize this file\nPDF 附件当前 Chat 模型不可用：brief.pdf。CodexBridge 没有转发该文件，也没有提取到可读文本。请切换到 GPT/Responses 模型，或提供文本/OCR 内容。",
  );
  assert.doesNotMatch(converted.body.messages.at(-1).content, /unavailable to this chat provider/);
});

test("chat conversion injects extracted text file data instead of a raw file placeholder", () => {
  const fileData = `data:text/plain;base64,${Buffer.from("route notes\nkeep tools working", "utf8").toString("base64")}`;
  const converted = responsesToChatRequest(
    {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "summarize this file" },
            {
              type: "input_file",
              filename: "notes.txt",
              file_data: fileData,
            },
          ],
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  const payload = JSON.stringify(converted.body.messages);
  assert.match(payload, /CodexBridge attachment guidance/);
  assert.match(converted.body.messages.at(-1).content, /\[file: notes\.txt extracted by CodexBridge\]/);
  assert.match(converted.body.messages.at(-1).content, /route notes/);
  assert.match(converted.body.messages.at(-1).content, /keep tools working/);
  assert.doesNotMatch(payload, /data:text\/plain;base64/);
  assert.doesNotMatch(payload, /file input not forwarded/);
});

test("chat conversion extracts simple text from PDF file data when possible", () => {
  const simplePdf = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<<>>\nstream\nBT /F1 12 Tf 72 720 Td (Hello PDF route plan) Tj ET\nendstream\nendobj\n%%EOF\n",
    "latin1",
  );
  const converted = responsesToChatRequest(
    {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "summarize this pdf" },
            {
              type: "input_file",
              filename: "brief.pdf",
              file_data: `data:application/pdf;base64,${simplePdf.toString("base64")}`,
            },
          ],
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  const payload = JSON.stringify(converted.body.messages);
  assert.match(payload, /CodexBridge attachment guidance/);
  assert.match(converted.body.messages.at(-1).content, /\[file: brief\.pdf extracted by CodexBridge\]/);
  assert.match(converted.body.messages.at(-1).content, /Hello PDF route plan/);
  assert.doesNotMatch(payload, /data:application\/pdf;base64/);
});

test("chat conversion tells chat models not to tool-loop for unavailable PDFs", () => {
  const converted = responsesToChatRequest(
    {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "summarize this pdf" },
            {
              type: "input_file",
              filename: "scan.pdf",
              file_data: "data:application/pdf;base64,not-a-real-pdf",
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run shell.",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  const guidance = converted.body.messages.find((message) =>
    String(message.content || "").includes("CodexBridge attachment guidance"),
  );
  assert.ok(guidance);
  assert.match(guidance.content, /Do not call shell, browser, MCP, or local file tools/);
  assert.match(converted.body.messages.at(-1).content, /PDF 附件当前 Chat 模型不可用：scan\.pdf/);
  assert.match(converted.body.messages.at(-1).content, /切换到 GPT\/Responses 模型/);
});

test("chat conversion keeps Office attachments as explicit unavailable file context", () => {
  const converted = responsesToChatRequest(
    {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "summarize these files" },
            {
              type: "input_file",
              filename: "deck.pptx",
              file_data: "data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,UEsDBAo=",
            },
            {
              type: "input_file",
              filename: "brief.docx",
              file_data: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsDBAo=",
            },
            {
              type: "input_file",
              filename: "table.xlsx",
              file_data: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDBAo=",
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run shell.",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  const payload = JSON.stringify(converted.body.messages);
  assert.match(payload, /CodexBridge attachment guidance/);
  assert.match(converted.body.messages.at(-1).content, /文件附件当前 Chat 模型不可用：deck\.pptx/);
  assert.match(converted.body.messages.at(-1).content, /文件附件当前 Chat 模型不可用：brief\.docx/);
  assert.match(converted.body.messages.at(-1).content, /文件附件当前 Chat 模型不可用：table\.xlsx/);
  assert.doesNotMatch(payload, /application\/vnd\.openxmlformats/);
  assert.doesNotMatch(payload, /UEsDBAo=/);
  assert.doesNotMatch(payload, /File attachment unavailable to this chat provider/);
});

test("chat conversion refuses oversized file data instead of forwarding or decoding it", () => {
  const converted = responsesToChatRequest(
    {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "summarize the giant attachment" },
            {
              type: "input_file",
              filename: "giant.txt",
              file_data: `data:text/plain;base64,${"a".repeat(6_700_000)}`,
            },
          ],
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  const payload = JSON.stringify(converted.body.messages);
  assert.match(converted.body.messages.at(-1).content, /文件附件当前 Chat 模型不可用：giant\.txt/);
  assert.match(payload, /CodexBridge attachment guidance/);
  assert.doesNotMatch(payload, /data:text\/plain;base64/);
  assert.ok(payload.length < 2000, "oversized file data must not be copied into the chat payload");
});

test("chat conversion forwards files only for explicit chat file-capable routes", () => {
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
    {
      ...route,
      custom: true,
      provider: "custom",
      inputModalities: ["text", "file"],
    },
    new ResponseHistory(),
  );

  assert.deepEqual(converted.body.messages.at(-1).content, [
    { type: "text", text: "summarize this file" },
    {
      type: "file",
      file: {
        filename: "brief.pdf",
        file_data: "data:application/pdf;base64,abc123",
      },
    },
  ]);
});

test("chat conversion preserves compacted context summaries as user context", () => {
  const messages = responseInputToChatMessages([
    {
      type: "compaction",
      encrypted_content:
        "Another language model started to solve this problem and produced a summary.\nImportant context: route compact output must stay available.",
    },
    {
      type: "message",
      role: "user",
      content: "continue from the summary",
    },
  ]);

  assert.equal(messages[0].role, "user");
  assert.match(messages[0].content, /Important context/);
  assert.equal(messages[1].content, "continue from the summary");
});

test("chat conversion output can be filtered by adapter safe params", () => {
  const converted = responsesToChatRequest(
    {
      input: "hello",
      response_format: { type: "json_object" },
      parallel_tool_calls: true,
      metadata: { unsafe: true },
      store: true,
    },
    {
      ...route,
      provider: "deepseek",
      dropParams: ["response_format", "parallel_tool_calls"],
    },
    new ResponseHistory(),
  );
  const filtered = filterPayloadForAdapter(converted.body, {
    ...route,
    provider: "deepseek",
    dropParams: ["response_format", "parallel_tool_calls"],
  });

  assert.equal(filtered.response_format, undefined);
  assert.equal(filtered.parallel_tool_calls, undefined);
  assert.equal(filtered.metadata, undefined);
  assert.equal(filtered.store, undefined);
  assert.equal(filtered.messages.at(-1).content, "hello");
});

test("chat conversion adapts Codex reasoning requests by provider", () => {
  const request = {
    input: "solve this carefully",
    reasoning: {
      effort: "xhigh",
      summary: "auto",
      max_tokens: 2048,
    },
  };

  const deepseekV4 = responsesToChatRequest(
    request,
    { ...route, provider: "deepseek", model: "deepseek-v4-pro" },
    new ResponseHistory(),
  );
  assert.equal(deepseekV4.body.reasoning_effort, "max");
  assert.deepEqual(deepseekV4.body.thinking, { type: "enabled" });
  assert.equal(deepseekV4.body.reasoning, undefined);

  const deepseekReasoner = responsesToChatRequest(
    request,
    { ...route, provider: "deepseek", model: "deepseek-reasoner" },
    new ResponseHistory(),
  );
  assert.equal(deepseekReasoner.body.reasoning_effort, undefined);
  assert.equal(deepseekReasoner.body.thinking, undefined);

  const kimi27 = responsesToChatRequest(
    request,
    { ...route, provider: "kimi", model: "kimi-k2.7-code" },
    new ResponseHistory(),
  );
  assert.equal(kimi27.body.thinking, undefined);
  assert.equal(kimi27.body.reasoning, undefined);
  assert.equal(kimi27.body.reasoning_effort, undefined);

  const kimi26 = responsesToChatRequest(
    request,
    { ...route, provider: "kimi", model: "kimi-k2.6" },
    new ResponseHistory(),
  );
  assert.deepEqual(kimi26.body.thinking, { type: "enabled", keep: "all" });

  const minimax = responsesToChatRequest(
    request,
    { ...route, provider: "minimax", model: "MiniMax-M3" },
    new ResponseHistory(),
  );
  assert.equal(minimax.body.reasoning_split, true);
  assert.equal(minimax.body.reasoning, undefined);
  assert.equal(minimax.body.thinking, undefined);

  const qwen = responsesToChatRequest(
    request,
    { ...route, provider: "qwen", model: "qwen3-coder-plus" },
    new ResponseHistory(),
  );
  assert.equal(qwen.body.enable_thinking, true);
  assert.equal(qwen.body.thinking_budget, 2048);
  assert.equal(qwen.body.reasoning, undefined);

  const qwenWithTools = responsesToChatRequest(
    {
      ...request,
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Lookup a value.",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    { ...route, provider: "qwen", model: "qwen3-coder-plus" },
    new ResponseHistory(),
  );
  assert.equal(qwenWithTools.body.enable_thinking, false);
  assert.equal(qwenWithTools.body.thinking_budget, undefined);

  const zhipu = responsesToChatRequest(
    request,
    { ...route, provider: "zhipu", model: "glm-4.6" },
    new ResponseHistory(),
  );
  assert.equal(zhipu.body.enable_thinking, true);

  const openrouter = responsesToChatRequest(
    request,
    { ...route, provider: "openrouter", model: "anthropic/claude-sonnet-4.5" },
    new ResponseHistory(),
  );
  assert.deepEqual(openrouter.body.reasoning, {
    effort: "high",
    max_tokens: 2048,
  });
  assert.equal(openrouter.body.reasoning_effort, undefined);

  const siliconflowQwen = responsesToChatRequest(
    request,
    { ...route, provider: "siliconflow", model: "Qwen/Qwen3-Coder-480B-A35B-Instruct" },
    new ResponseHistory(),
  );
  assert.equal(siliconflowQwen.body.enable_thinking, true);
  assert.equal(siliconflowQwen.body.thinking_budget, 2048);

  const custom = responsesToChatRequest(
    {
      input: "solve with custom controls",
      reasoning: { effort: "high", summary: "auto" },
      reasoning_effort: "medium",
      thinking: { type: "enabled", keep: "all" },
      enable_thinking: true,
      thinking_budget: 1024,
      extra_body: { enable_thinking: true },
    },
    { ...route, provider: "custom", custom: true, model: "custom-model" },
    new ResponseHistory(),
  );
  assert.deepEqual(custom.body.reasoning, { effort: "high", summary: "auto" });
  assert.equal(custom.body.reasoning_effort, "medium");
  assert.deepEqual(custom.body.thinking, { type: "enabled", keep: "all" });
  assert.equal(custom.body.enable_thinking, true);
  assert.equal(custom.body.thinking_budget, 1024);
  assert.deepEqual(custom.body.extra_body, { enable_thinking: true });
});

test("custom Volcano Ark chat models do not receive unsupported Codex reasoning parameters", () => {
  const converted = responsesToChatRequest(
    {
      input: "continue the task",
      reasoning: { effort: "high", summary: "auto" },
      reasoning_effort: "high",
      thinking: { type: "enabled", keep: "all" },
    },
    {
      id: "cb-custom-volcengine-kimi-k2-7-code",
      provider: "volcengine",
      providerFamily: "doubao",
      custom: true,
      api: "chat_completions",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      model: "kimi-k2.7-code",
    },
    new ResponseHistory(),
  );

  assert.equal(converted.body.model, "kimi-k2.7-code");
  assert.equal(converted.body.reasoning, undefined);
  assert.equal(converted.body.reasoning_effort, undefined);
  assert.equal(converted.body.thinking, undefined);
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
    /不支持的鉴权模式：browser_magic/,
  );
});

test("unsupported route api fails config validation in Chinese", () => {
  assert.throws(
    () =>
      validateConfig({
        models: [
          {
            id: "bad-api",
            displayName: "Bad API",
            api: "legacy_completions",
            baseUrl: "https://api.example.com/v1",
            model: "bad-api",
          },
        ],
      }),
    /不支持的接口类型：legacy_completions/,
  );
});

test("router config rejects model baseUrl pointing back to CodexBridge itself", () => {
  assert.throws(
    () =>
      validateConfig({
        host: "127.0.0.1",
        port: 15722,
        models: [
          {
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            api: "responses",
            baseUrl: "http://localhost:15722/v1",
            model: "gpt-5.5",
          },
        ],
      }),
    /Base URL 指回了 CodexBridge Router 自己/,
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

test("chat responses preserve provider cache-hit usage details for Codex", () => {
  const response = chatResponseToResponse(
    {
      id: "chatcmpl_cache",
      choices: [
        {
          message: {
            role: "assistant",
            content: "cached hello",
          },
        },
      ],
      usage: {
        prompt_tokens: 16000,
        completion_tokens: 20,
        total_tokens: 16020,
        prompt_cache_hit_tokens: 15400,
        prompt_cache_miss_tokens: 600,
      },
    },
    "deepseek-v4-pro",
    null,
  );

  assert.equal(response.usage.input_tokens, 16000);
  assert.equal(response.usage.input_tokens_details.cached_tokens, 15400);
  assert.equal(response.usage.output_tokens, 20);
  assert.equal(response.usage.total_tokens, 16020);
});

test("previous_response_id restores assistant tool calls before tool output", () => {
  const history = new ResponseHistory();
  const chatRoute = {
    ...route,
    id: "kimi-k2.7-code",
    model: "kimi-k2.7-code",
    provider: "moonshot",
  };
  const first = responsesToChatRequest(
    {
      model: "kimi-k2.7-code",
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
    chatRoute,
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
  const response = chatResponseToResponse(chat, "kimi-k2.7-code", first.toolContext);
  history.record(response.id, [
    ...first.messagesForHistory,
    assistantHistoryMessageFromChat(chat),
  ]);

  const second = responsesToChatRequest(
    {
      model: "kimi-k2.7-code",
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
    chatRoute,
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
  const transcript = converted.body.messages
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.doesNotMatch(transcript, /Assistant requested tool calls/);
  assert.doesNotMatch(transcript, /shell_command.*"command":"pwd"/);
  assert.match(transcript, /F:\\game_code\\router/);
  assert.equal(converted.body.tools.length, 1);
});

test("chat conversion keeps orphan tool output as internal context, not a user task", () => {
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

  const transcript = converted.body.messages
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.match(transcript, /CodexBridge tool continuation guidance/);

  const resultMessages = converted.body.messages.filter((message) =>
    String(message.content || "").includes("CodexBridge tool result context"),
  );
  assert.equal(resultMessages.length, 1);
  assert.equal(resultMessages[0].role, "system");
  assert.match(resultMessages[0].content, /Do not repeat or re-run/);
  assert.match(resultMessages[0].content, /call_missing/);
  assert.match(resultMessages[0].content, /tool result that must not disappear/);
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

test("interactive plugin detection only uses the current user turn", () => {
  const history = new ResponseHistory();
  history.record("resp_old_chrome_task", [
    { role: "user", content: "Chrome 打开 youtube" },
    { role: "assistant", content: "I opened YouTube." },
  ]);

  const converted = responsesToChatRequest(
    {
      previous_response_id: "resp_old_chrome_task",
      input: "你好",
      tools: [
        {
          type: "function",
          name: "mcp__node_repl__js",
          description: "Run JavaScript",
          parameters: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
          },
        },
      ],
    },
    route,
    history,
  );

  assert.equal(converted.body.tool_choice, undefined);
});

test("interactive plugin detection ignores older transcript messages", () => {
  const converted = responsesToChatRequest(
    {
      input: [
        { role: "user", content: "Chrome 打开 youtube" },
        { role: "assistant", content: "I opened YouTube." },
        { role: "user", content: "你好" },
      ],
      tools: [
        {
          type: "function",
          name: "mcp__node_repl__js",
          description: "Run JavaScript",
          parameters: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
          },
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.equal(converted.body.tool_choice, undefined);
});

test("interactive plugin detection ignores older prompts during tool-output turns", () => {
  const converted = responsesToChatRequest(
    {
      input: [
        { role: "user", content: "Chrome 打开 youtube" },
        {
          type: "function_call_output",
          call_id: "call_old",
          output: "done",
        },
      ],
      tools: [
        {
          type: "function",
          name: "mcp__node_repl__js",
          description: "Run JavaScript",
          parameters: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
          },
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.equal(converted.body.tool_choice, undefined);
});

test("reasoning_content is replayed only for chat providers that support it", () => {
  const history = new ResponseHistory();
  history.record("resp_reasoning_content", [
    { role: "user", content: "think" },
    assistantHistoryMessageFromChat({
      choices: [
        {
          message: {
            role: "assistant",
            content: "answer",
            reasoning_content: "private chain state",
          },
        },
      ],
    }),
  ]);

  const deepseek = responsesToChatRequest(
    {
      model: "deepseek-v4-pro",
      previous_response_id: "resp_reasoning_content",
      input: "continue",
    },
    { ...route, provider: "deepseek", model: "deepseek-v4-pro" },
    history,
  );
  const deepseekAssistant = deepseek.body.messages.find(
    (message) => message.role === "assistant",
  );
  assert.equal(deepseekAssistant.reasoning_content, "private chain state");

  const deepseekReasoner = responsesToChatRequest(
    {
      model: "deepseek-reasoner",
      previous_response_id: "resp_reasoning_content",
      input: "continue",
    },
    { ...route, provider: "deepseek", model: "deepseek-reasoner" },
    history,
  );
  const reasonerAssistant = deepseekReasoner.body.messages.find(
    (message) => message.role === "assistant",
  );
  assert.equal("reasoning_content" in reasonerAssistant, false);

  const kimi = responsesToChatRequest(
    {
      model: "kimi-k2.7-code",
      previous_response_id: "resp_reasoning_content",
      input: "continue",
    },
    { ...route, provider: "moonshot", model: "kimi-k2.7-code" },
    history,
  );
  const kimiAssistant = kimi.body.messages.find(
    (message) => message.role === "assistant",
  );
  assert.equal(kimiAssistant.reasoning_content, "private chain state");

  const generic = responsesToChatRequest(
    {
      model: "generic",
      previous_response_id: "resp_reasoning_content",
      input: "continue",
    },
    { ...route, provider: "openrouter", model: "anthropic/claude-sonnet-4.5" },
    history,
  );
  const genericAssistant = generic.body.messages.find(
    (message) => message.role === "assistant",
  );
  assert.equal("reasoning_content" in genericAssistant, false);
});

test("DeepSeek preserves prior tool results as native chat tool messages", () => {
  const history = new ResponseHistory();
  history.record("resp_foreign_tool_call", [
    { role: "user", content: "run pwd" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_foreign_shell",
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
      model: "deepseek-v4-pro",
      previous_response_id: "resp_foreign_tool_call",
      input: [
        {
          type: "function_call_output",
          call_id: "call_foreign_shell",
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
    { ...route, provider: "deepseek" },
    history,
  );

  const assistant = converted.body.messages.find((message) =>
    Array.isArray(message.tool_calls),
  );
  const tool = converted.body.messages.find((message) => message.role === "tool");
  assert.ok(assistant);
  assert.equal(assistant.tool_calls[0].id, "call_foreign_shell");
  assert.ok(tool);
  assert.equal(tool.tool_call_id, "call_foreign_shell");
  assert.match(tool.content, /F:\\game_code\\router/);

  const transcript = converted.body.messages
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.doesNotMatch(transcript, /CodexBridge tool result context/);
});

test("chat conversion preserves raw chat-style tool messages when paired", () => {
  const converted = responsesToChatRequest(
    {
      model: "deepseek-v4-pro",
      input: [
        { role: "user", content: "create a presentation" },
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
        {
          role: "tool",
          tool_call_id: "call_create_ppt",
          content: "created deck.pptx",
        },
        { role: "user", content: "continue" },
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
    { ...route, provider: "deepseek" },
    new ResponseHistory(),
  );

  const assistant = converted.body.messages.find((message) =>
    Array.isArray(message.tool_calls),
  );
  const tool = converted.body.messages.find((message) => message.role === "tool");
  assert.ok(assistant);
  assert.equal(assistant.tool_calls[0].id, "call_create_ppt");
  assert.ok(tool);
  assert.equal(tool.tool_call_id, "call_create_ppt");
  assert.match(tool.content, /created deck\.pptx/);
});

test("chat routes never forward malformed extra tool outputs as native tool messages", () => {
  const history = new ResponseHistory();
  history.record("resp_ppt_tool_call", [
    { role: "user", content: "create a presentation" },
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
      model: "deepseek-v4-pro",
      previous_response_id: "resp_ppt_tool_call",
      input: [
        {
          type: "function_call_output",
          call_id: "call_create_ppt",
          output: "created deck.pptx",
        },
        {
          type: "function_call_output",
          output: "presentation export finished without a call id",
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
    { ...route, provider: "deepseek" },
    history,
  );

  const toolMessages = converted.body.messages.filter((message) => message.role === "tool");
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0].tool_call_id, "call_create_ppt");
  assert.equal(
    converted.body.messages.some(
      (message) => message.role === "tool" && !message.tool_call_id,
    ),
    false,
  );

  const transcript = converted.body.messages
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.match(transcript, /created deck\.pptx/);
  assert.match(transcript, /presentation export finished without a call id/);
  assert.match(transcript, /CodexBridge tool result context/);
});

test("DeepSeek keeps multi-tool outputs paired with their assistant call", () => {
  const history = new ResponseHistory();
  history.record("resp_multi_tool_call", [
    { role: "user", content: "read install script and logs" },
    {
      role: "assistant",
      content: "I will inspect the files.",
      tool_calls: [
        {
          id: "call_script",
          type: "function",
          function: {
            name: "shell_command",
            arguments: '{"command":"Get-Content install.ps1"}',
          },
        },
        {
          id: "call_log",
          type: "function",
          function: {
            name: "shell_command",
            arguments: '{"command":"Get-Content install.log"}',
          },
        },
      ],
    },
  ]);

  const converted = responsesToChatRequest(
    {
      model: "deepseek-v4-pro",
      previous_response_id: "resp_multi_tool_call",
      input: [
        {
          type: "function_call_output",
          call_id: "call_script",
          output: "install script content",
        },
        {
          type: "function_call_output",
          call_id: "call_log",
          output: "install log content",
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
    { ...route, provider: "deepseek" },
    history,
  );

  const assistant = converted.body.messages.find((message) =>
    Array.isArray(message.tool_calls),
  );
  const toolMessages = converted.body.messages.filter((message) => message.role === "tool");
  assert.ok(assistant);
  assert.deepEqual(
    assistant.tool_calls.map((toolCall) => toolCall.id),
    ["call_script", "call_log"],
  );
  assert.equal(toolMessages.length, 2);
  assert.deepEqual(
    toolMessages.map((message) => message.tool_call_id),
    ["call_script", "call_log"],
  );
  assert.match(toolMessages[0].content, /install script content/);
  assert.match(toolMessages[1].content, /install log content/);
});

test("chat routes group consecutive orphan tool outputs into one continuation message", () => {
  const converted = responsesToChatRequest(
    {
      model: "deepseek-v4-pro",
      input: [
        {
          type: "function_call_output",
          call_id: "call_file",
          output: "created test file",
        },
        {
          type: "function_call_output",
          call_id: "call_delete",
          output: "deleted test file",
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
    { ...route, provider: "deepseek" },
    new ResponseHistory(),
  );

  const resultMessages = converted.body.messages.filter((message) =>
    String(message.content || "").includes("CodexBridge tool result context"),
  );
  assert.equal(resultMessages.length, 1);
  assert.equal(resultMessages[0].role, "system");
  assert.match(resultMessages[0].content, /Do not repeat or re-run/);
  assert.match(resultMessages[0].content, /call_file/);
  assert.match(resultMessages[0].content, /created test file/);
  assert.match(resultMessages[0].content, /call_delete/);
  assert.match(resultMessages[0].content, /deleted test file/);
});

test("chat routes do not expose compatibility tool summaries as visible assistant text", () => {
  const history = new ResponseHistory();
  history.record("resp_shell_tool_call", [
    { role: "user", content: "Open Chrome" },
    {
      role: "assistant",
      content: "I will use an available command tool.",
      tool_calls: [
        {
          id: "call_shell",
          type: "function",
          function: {
            name: "shell_command",
            arguments: "{\"command\":\"Start-Process chrome\"}",
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_shell",
      content: "Chrome started",
    },
  ]);

  const converted = responsesToChatRequest(
    {
      previous_response_id: "resp_shell_tool_call",
      input: "continue",
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run shell.",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    route,
    history,
  );

  const transcript = converted.body.messages
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.doesNotMatch(transcript, /Earlier assistant tool use/);
  assert.doesNotMatch(transcript, /Tools used earlier/);
  assert.doesNotMatch(transcript, /Assistant requested tool calls/);
  assert.match(transcript, /I will use an available command tool/);
  assert.match(transcript, /Chrome started/);
});

test("chat provider replies do not expose internal compatibility summaries", () => {
  const response = chatResponseToResponse(
    {
      id: "chatcmpl_internal_summary",
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "Earlier assistant tool use was summarized for provider compatibility. Tools used earlier: shell_command. Do not quote this summary as a new tool call; use the current tools list for any new action.",
          },
        },
      ],
    },
    "deepseek-v4-pro",
    { chatToolNames: new Set(["shell_command"]) },
  );

  assert.equal(response.output_text, "");
  assert.equal(response.output.length, 0);
  assert.doesNotMatch(JSON.stringify(response), /Earlier assistant tool use/);
  assert.doesNotMatch(JSON.stringify(response), /Do not quote this summary/);
});

test("chat provider replies do not expose orphan tool-output compatibility summaries", () => {
  const response = chatResponseToResponse(
    {
      id: "chatcmpl_orphan_summary",
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "Previous completed tool results without matching assistant tool calls. These tools already ran; use the outputs below before deciding whether another tool call is needed.\n\nResult call_file:\ncreated test file",
          },
        },
      ],
    },
    "deepseek-v4-pro",
    { chatToolNames: new Set(["shell_command"]) },
  );

  assert.equal(response.output_text, "");
  assert.equal(response.output.length, 0);
  assert.doesNotMatch(JSON.stringify(response), /Previous completed tool results/);
  assert.doesNotMatch(JSON.stringify(response), /created test file/);
});

test("chat provider replies do not expose tool-result context summaries", () => {
  const response = chatResponseToResponse(
    {
      id: "chatcmpl_tool_result_context",
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "CodexBridge tool result context: these tool outputs are already completed historical results. Do not repeat or re-run these tool calls just because they appear here.\n\nResult call_file:\ncreated test file",
          },
        },
      ],
    },
    "deepseek-v4-pro",
    { chatToolNames: new Set(["shell_command"]) },
  );

  assert.equal(response.output_text, "");
  assert.equal(response.output.length, 0);
  assert.doesNotMatch(JSON.stringify(response), /CodexBridge tool result context/);
  assert.doesNotMatch(JSON.stringify(response), /created test file/);
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

test("new ChatGPT built-in namespaces keep their exact identity through chat providers", () => {
  const converted = responsesToChatRequest(
    {
      input: "delegate the HyperFrames render",
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [
            {
              type: "function",
              name: "spawn_agent",
              description: "Spawn a delegated agent.",
              parameters: {
                type: "object",
                properties: { task_name: { type: "string" } },
                required: ["task_name"],
              },
            },
          ],
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.equal(
    converted.body.tools[0].function.name,
    "collaboration__spawn_agent",
  );

  const response = chatResponseToResponse(
    {
      id: "chatcmpl_collaboration",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_spawn_agent",
                type: "function",
                function: {
                  name: "collaboration__spawn_agent",
                  arguments: '{"task_name":"render_video"}',
                },
              },
            ],
          },
        },
      ],
    },
    route.id,
    converted.toolContext,
  );

  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].namespace, "collaboration");
  assert.equal(response.output[0].name, "spawn_agent");
  assert.match(responseToSse(response), /"namespace":"collaboration"/);
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
    ["mcp__browser__read", "mcp__filesystem__read"],
  );
});

test("chat conversion exposes privacy-safe tool diagnostics", () => {
  const converted = responsesToChatRequest(
    {
      input: "use figma but do not leak this user text",
      tools: [
        {
          type: "namespace",
          name: "mcp__figma__",
          tools: [
            {
              type: "function",
              name: "whoami",
              description: "Check Figma session",
              parameters: {
                type: "object",
                properties: {
                  secret_token: { type: "string" },
                },
              },
            },
          ],
        },
        {
          type: "namespace",
          name: "mcp__node_repl__",
          tools: [
            {
              type: "function",
              name: "js",
              description: "Run JavaScript",
              parameters: {
                type: "object",
                properties: { code: { type: "string" } },
              },
            },
          ],
        },
        {
          type: "custom",
          name: "apply_patch",
          description: "Edit files",
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.deepEqual(converted.toolDiagnostics, {
    requestedToolCount: 3,
    chatToolCount: 2,
    suppressedToolCount: 1,
    namespaceCount: 2,
    namespaceNames: ["mcp__figma__", "mcp__node_repl__"],
    hasNodeRepl: true,
    hasCommandTool: false,
    hasApplyPatch: true,
    toolChoice: "auto",
  });
  assert.equal(
    toolDiagnosticsLogFields(converted.toolDiagnostics),
    "tools=3 chat_tools=2 suppressed=1 namespaces=2 namespace_names=mcp__figma__,mcp__node_repl__ node_repl=true command=false apply_patch=true tool_choice=auto",
  );
  const serialized = JSON.stringify(converted.toolDiagnostics);
  assert.doesNotMatch(serialized, /secret_token|properties|use figma|Check Figma session/);
});

test("chat conversion orders tools stably to improve cache reuse", () => {
  const requestA = {
    input: "use stable tools",
    tools: stableToolSet(["shell_command", "mcp__filesystem__", "lookup"]),
  };
  const requestB = {
    input: "use stable tools",
    tools: stableToolSet(["lookup", "shell_command", "mcp__filesystem__"]),
  };

  const convertedA = responsesToChatRequest(requestA, route, new ResponseHistory());
  const convertedB = responsesToChatRequest(requestB, route, new ResponseHistory());

  const namesA = convertedA.body.tools.map((tool) => tool.function.name);
  const namesB = convertedB.body.tools.map((tool) => tool.function.name);
  assert.deepEqual(namesA, ["lookup", "mcp__filesystem__read_file", "shell_command"]);
  assert.deepEqual(namesB, namesA);
});

test("chat conversion adds prompt cache hints only for explicit cache-control routes", () => {
  const history = new ResponseHistory();
  history.record("resp_cache_history", [
    { role: "user", content: "older stable request" },
    {
      role: "assistant",
      content: "older stable answer",
      reasoning_content: "private reasoning must not receive cache hints",
    },
  ]);
  const request = {
    previous_response_id: "resp_cache_history",
    instructions: "Follow project instructions.",
    input: "current uncached request",
    tools: stableToolSet(["shell_command", "lookup"]),
  };

  const withoutCache = responsesToChatRequest(request, route, history);
  assert.equal(countCacheControlBlocks(withoutCache.body), 0);

  const withCache = responsesToChatRequest(
    request,
    { ...route, supportsPromptCaching: "cache_control" },
    history,
  );

  assert.ok(countCacheControlBlocks(withCache.body) > 0);
  assert.ok(countCacheControlBlocks(withCache.body) <= 4);
  assert.deepEqual(withCache.body.tools.at(-1).cache_control, { type: "ephemeral" });
  assert.deepEqual(
    withCache.body.messages.find((message) => message.role === "system").content.at(-1).cache_control,
    { type: "ephemeral" },
  );
  assert.deepEqual(
    withCache.body.messages.find((message) => message.content === "older stable request").cache_control,
    { type: "ephemeral" },
  );
  assert.equal(withCache.body.messages.at(-1).content, "current uncached request");
  assert.equal(withCache.body.messages.at(-1).cache_control, undefined);
  assert.doesNotMatch(JSON.stringify(withCache.body), /private reasoning/);
});

test("chat namespace tool calls are returned with native Codex namespace metadata", () => {
  const converted = responsesToChatRequest(
    {
      input: "use sample mcp",
      tools: [
        {
          type: "namespace",
          name: "mcp__sample__",
          tools: [
            {
              type: "function",
              name: "ping",
              description: "Ping sample MCP.",
              parameters: {
                type: "object",
                properties: {
                  text: { type: "string" },
                },
                required: ["text"],
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
                    name: "mcp__sample__ping",
                    arguments: '{"text":"hello"}',
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
  assert.equal(response.output[0].namespace, "mcp__sample__");
  assert.equal(response.output[0].name, "ping");
  assert.equal(response.output[0].arguments, '{"text":"hello"}');
});

test("streaming namespace tool calls include native function argument events", () => {
  const converted = responsesToChatRequest(
    {
      input: "use sample mcp",
      tools: [
        {
          type: "namespace",
          name: "mcp__sample__",
          tools: [
            {
              type: "function",
              name: "ping",
              description: "Ping sample MCP.",
              parameters: {
                type: "object",
                properties: { text: { type: "string" } },
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
      id: "chatcmpl_stream_tool",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_stream_tool",
                type: "function",
                function: {
                  name: "mcp__sample__ping",
                  arguments: '{"text":"hello"}',
                },
              },
            ],
          },
        },
      ],
    },
    route.id,
    converted.toolContext,
  );

  const sse = responseToSse(response);
  assert.match(sse, /event: response\.output_item\.added/);
  assert.match(sse, /"type":"function_call"/);
  assert.match(sse, /"namespace":"mcp__sample__"/);
  assert.match(sse, /"name":"ping"/);
  assert.match(sse, /event: response\.function_call_arguments\.delta/);
  assert.match(sse, /event: response\.function_call_arguments\.done/);
  assert.match(sse, /"arguments":"{\\"text\\":\\"hello\\"}"/);
  assert.doesNotMatch(sse, /unsupported_call/);
});

test("chat tool return diagnostics classify runnable and unknown MCP tool calls", () => {
  const converted = responsesToChatRequest(
    {
      input: "use figma mcp",
      tools: [
        {
          type: "namespace",
          name: "mcp__figma__",
          tools: [
            {
              type: "function",
              name: "whoami",
              description: "Check Figma plugin connection.",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  const chat = {
    id: "chatcmpl_tool_diag",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_figma",
              type: "function",
              function: {
                name: "mcp__figma__whoami",
                arguments: "{}",
              },
            },
            {
              id: "call_unknown",
              type: "function",
              function: {
                name: "mcp__figma__missing_private_token",
                arguments: '{"secret":"sk-tool-secret","prompt":"private user text"}',
              },
            },
          ],
        },
      },
    ],
  };

  const diagnostics = returnedToolDiagnosticsFromChat(chat, converted.toolContext);
  assert.deepEqual(diagnostics, {
    returnedToolCount: 2,
    runnableToolCount: 1,
    suppressedToolCount: 1,
    unknownToolCount: 1,
    namespaceCount: 1,
    namespaceNames: ["mcp__figma__"],
    hasNodeRepl: false,
    hasCommandTool: false,
    hasApplyPatch: false,
  });
  assert.equal(
    returnedToolDiagnosticsLogFields(diagnostics),
    "returned_tools=2 runnable_tools=1 suppressed_tools=1 unknown_tools=1 namespaces=1 namespace_names=mcp__figma__ node_repl=false command=false apply_patch=false",
  );
  assert.doesNotMatch(JSON.stringify(diagnostics), /sk-tool-secret|private user text|missing_private_token/);
});

test("suppressed Node REPL tool calls from chat providers are not returned to Codex", () => {
  const converted = responsesToChatRequest(
    {
      input: "Chrome 打开 youtube",
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
      id: "chatcmpl_suppressed_mcp",
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

  assert.equal(response.output.length, 0);
  assert.equal(response.output_text, "");
  assert.doesNotMatch(JSON.stringify(response), /Node REPL/);
});

test("chat provider interactive tool responses keep command fallback and drop plugin bootstrap noise", () => {
  const converted = responsesToChatRequest(
    {
      input: "Chrome 帮我打开 youtube",
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
    new ResponseHistory(),
  );

  const response = chatResponseToResponse(
    {
      id: "chatcmpl_interactive_noise",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_open_chrome",
                type: "function",
                function: {
                  name: "shell_command",
                  arguments:
                    '{"command":"Start-Process \\"chrome.exe\\" -ArgumentList \\"--new-window https://www.youtube.com\\""}',
                },
              },
              {
                id: "call_read_skill",
                type: "function",
                function: {
                  name: "shell_command",
                  arguments:
                    '{"command":"Get-Content \\"C:\\\\Users\\\\Administrator\\\\.codex\\\\plugins\\\\cache\\\\openai-bundled\\\\chrome\\\\26.611.62324\\\\skills\\\\control-chrome\\\\SKILL.md\\" -Raw"}',
                },
              },
              {
                id: "call_node_repl",
                type: "function",
                function: {
                  name: "mcp__node_repl__js",
                  arguments: '{"code":"await browser.documentation()"}',
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

  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].name, "shell_command");
  assert.equal(response.output[0].call_id, "call_open_chrome");
  assert.match(response.output[0].arguments, /Start-Process/);
  assert.doesNotMatch(JSON.stringify(response), /Node REPL/);
  assert.doesNotMatch(JSON.stringify(response), /SKILL\.md/);
});

test("chat provider interactive command fallback hides visible Node REPL diagnostics", () => {
  const converted = responsesToChatRequest(
    {
      input: "Chrome 帮我打开 youtube",
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
    new ResponseHistory(),
  );

  const response = chatResponseToResponse(
    {
      id: "chatcmpl_interactive_diagnostic",
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "看起来 Node REPL 的 js 工具暂时不可用，不过我可以用命令方式打开。",
            tool_calls: [
              {
                id: "call_open_chrome",
                type: "function",
                function: {
                  name: "shell_command",
                  arguments:
                    '{"command":"Start-Process \\"chrome.exe\\" -ArgumentList \\"--new-window https://www.youtube.com\\""}',
                },
              },
              {
                id: "call_node_repl",
                type: "function",
                function: {
                  name: "mcp__node_repl__js",
                  arguments: '{"code":"await browser.documentation()"}',
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

  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].name, "shell_command");
  assert.equal(response.output_text, "");
  assert.doesNotMatch(JSON.stringify(response), /Node REPL/);
});

test("chat provider interactive diagnostic text can be suppressed without tool calls", () => {
  const response = chatResponseToResponse(
    {
      id: "chatcmpl_interactive_text_only_diagnostic",
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "Computer Use 的 Node REPL 环境当前不可用。不过我先用 PowerShell 打开记事本。",
          },
        },
      ],
    },
    "deepseek-v4-pro",
    { chatToolNames: new Set(["shell_command"]) },
    { suppressInteractiveDiagnostics: true },
  );

  assert.equal(response.output.length, 0);
  assert.equal(response.output_text, "");
  assert.doesNotMatch(JSON.stringify(response), /Node REPL/);
});

test("Node REPL namespace tool choice is ignored for chat providers", () => {
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

  assert.equal(converted.body.tool_choice, undefined);
  assert.equal(converted.body.tools, undefined);
});

test("chat providers get guidance for flattened MCP tools", () => {
  const converted = responsesToChatRequest(
    {
      input: "use sample MCP",
      tools: [
        {
          type: "namespace",
          name: "mcp__sample__",
          tools: [
            {
              type: "function",
              name: "ping",
              description: "Ping sample MCP.",
              parameters: {
                type: "object",
                properties: {
                  text: { type: "string" },
                },
                required: ["text"],
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
  assert.match(converted.body.messages[0].content, /flattened function names/);
  assert.match(converted.body.messages[0].content, /Only call tools/);
  assert.doesNotMatch(converted.body.messages[0].content, /mcp__node_repl__js/);
  assert.equal(converted.body.tools[0].function.name, "mcp__sample__ping");
});

test("chrome and computer-use requests prefer command fallback instead of Node REPL bootstrap", () => {
  const converted = responsesToChatRequest(
    {
      input: "Chrome 打开 youtube",
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
        {
          type: "function",
          name: "shell_command",
          description: "Run shell.",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.deepEqual(converted.body.tool_choice, {
    type: "function",
    function: { name: "shell_command" },
  });
  assert.equal(
    converted.body.tools.some((tool) => tool.function?.name === "mcp__node_repl__js"),
    false,
  );
});

test("chrome open-url requests prefer controlled browser capability when configured", () => {
  const converted = responsesToChatRequest(
    {
      input: "Chrome open https://www.youtube.com",
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
        {
          type: "function",
          name: "shell_command",
          description: "Run shell.",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "local-browser",
          capability: "browser",
          adapter: "local_browser",
          enabled: true,
        },
      ],
    },
  );

  assert.deepEqual(converted.body.tool_choice, {
    type: "function",
    function: { name: "codexbridge_capability" },
  });
  assert.equal(
    converted.body.tools.some((tool) => tool.function?.name === "mcp__node_repl__js"),
    false,
  );
  assert.equal(
    converted.body.tools.some((tool) => tool.function?.name === "shell_command"),
    true,
  );
  assert.match(converted.body.messages[0].content, /browser\/open_url/);
  assert.doesNotMatch(converted.body.messages[0].content, /browser\/read_url/);
  assert.doesNotMatch(converted.body.messages[0].content, /use command tools to launch apps/i);
});

test("interactive plugin requests prefer command fallback when Node REPL is not available", () => {
  const converted = responsesToChatRequest(
    {
      input: "Chrome 打开 youtube",
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run shell.",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.deepEqual(converted.body.tool_choice, {
    type: "function",
    function: { name: "shell_command" },
  });
});

test("github repository inspection uses command fallback on chat routes", () => {
  const converted = responsesToChatRequest(
    {
      input: "GitHub 看看这是什么 wangzhezbz/codex-bridge",
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
        {
          type: "function",
          name: "shell_command",
          description: "Run shell.",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.deepEqual(converted.body.tool_choice, {
    type: "function",
    function: { name: "shell_command" },
  });
  assert.equal(
    converted.body.tools.some((tool) => tool.function?.name === "mcp__node_repl__js"),
    false,
  );
  assert.match(converted.body.messages[0].content, /GitHub repository/i);
  assert.match(converted.body.messages[0].content, /Do not ask the user to open/i);
});

test("chat providers do not expose Node REPL MCP tools for interactive plugin requests", () => {
  const converted = responsesToChatRequest(
    {
      input: "Chrome 打开 youtube",
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
        {
          type: "function",
          name: "shell_command",
          description: "Run shell.",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.deepEqual(converted.body.tool_choice, {
    type: "function",
    function: { name: "shell_command" },
  });
  assert.equal(
    converted.body.tools.some((tool) => tool.function?.name === "mcp__node_repl__js"),
    false,
  );
  assert.equal(
    converted.body.tools.some((tool) => tool.function?.name === "shell_command"),
    true,
  );
  assert.equal(
    converted.body.messages.some((message) =>
      String(message.content || "").includes("mcp__node_repl__js"),
    ),
    false,
  );
  assert.equal(converted.body.messages[0].role, "system");
  assert.match(converted.body.messages[0].content, /shell|command/i);
  assert.match(converted.body.messages[0].content, /chat-routed models/i);
  assert.match(converted.body.messages[0].content, /Do not call Get-Content or Get-ChildItem/i);
  assert.match(converted.body.messages[0].content, /open a browser URL/i);
});

test("git push tasks are not forced through Node REPL", () => {
  const converted = responsesToChatRequest(
    {
      input: "push this commit to GitHub",
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
        {
          type: "function",
          name: "shell_command",
          description: "Run shell.",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.equal(converted.body.tool_choice, "auto");
});

test("ordinary computer or web questions are not forced through Node REPL", () => {
  for (const input of ["我的电脑配置适合跑本地模型吗", "网页开发怎么入门"]) {
    const converted = responsesToChatRequest(
      {
        input,
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

    assert.equal(converted.body.tool_choice, undefined, input);
  }
});

test("explicit tool choice is not replaced by the Node REPL preference", () => {
  const converted = responsesToChatRequest(
    {
      input: "Chrome 打开 youtube",
      tool_choice: {
        type: "function",
        name: "shell_command",
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
        {
          type: "function",
          name: "shell_command",
          description: "Run shell.",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    route,
    new ResponseHistory(),
  );

  assert.deepEqual(converted.body.tool_choice, {
    type: "function",
    function: { name: "shell_command" },
  });
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

test("chat routes do not expose native computer-use tools to providers", () => {
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

  assert.equal(converted.body.tools, undefined);
  assert.equal(
    converted.toolContext.chatTools.some((tool) => tool.function?.name === "computer_screenshot"),
    false,
  );
});

test("chat routes suppress unexpected native computer tool calls from providers", () => {
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

  assert.equal(response.output.length, 0);
  assert.doesNotMatch(JSON.stringify(response), /computer_call/);
});

test("chat routes keep prior computer tool outputs as text context", () => {
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
    { ...route, provider: "moonshot", model: "kimi-k2.7-code" },
    new ResponseHistory(),
  );

  assert.equal(converted.body.tools, undefined);
  assert.equal(converted.body.messages.at(-1).role, "system");
  assert.equal(
    converted.body.messages.some((message) => Array.isArray(message.tool_calls)),
    false,
  );
  assert.match(converted.body.messages.at(-1).content, /screenshot captured/);
});

test("chat routes expose a controlled CodexBridge capability tool only when providers exist", () => {
  const withoutProvider = responsesToChatRequest(
    {
      input: "read https://example.com",
    },
    route,
    new ResponseHistory(),
  );
  assert.equal(withoutProvider.body.tools, undefined);

  const converted = responsesToChatRequest(
    {
      input: "read https://example.com",
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "local-browser",
          capability: "browser",
          adapter: "local_browser",
          enabled: true,
        },
      ],
    },
  );

  const tool = (converted.body.tools || []).find((item) =>
    item.function?.name === "codexbridge_capability"
  );
  assert.ok(tool);
  assert.match(tool.function.description, /controlled CodexBridge capability/);
  assert.deepEqual(tool.function.parameters.properties.capability.enum, ["browser"]);
  assert.deepEqual(tool.function.parameters.properties.action.enum, ["read_url"]);
  assert.match(converted.body.messages[0].content, /codexbridge_capability/);
  assert.match(converted.body.messages[0].content, /browser\/read_url/);
  assert.doesNotMatch(converted.body.messages[0].content, /browser\/open_url/);
  assert.match(converted.body.messages[0].content, /safe bare domains/i);
  assert.match(converted.body.messages[0].content, /Do not use shell commands/);
});

test("chat routes scope browser actions for open-url requests", () => {
  const converted = responsesToChatRequest(
    {
      input: "Open https://example.com/docs in the browser.",
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "local-browser",
          capability: "browser",
          adapter: "local_browser",
          enabled: true,
        },
      ],
    },
  );

  const tool = (converted.body.tools || []).find((item) =>
    item.function?.name === "codexbridge_capability"
  );
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.capability.enum, ["browser"]);
  assert.deepEqual(tool.function.parameters.properties.action.enum, ["open_url"]);
  assert.deepEqual(Object.keys(tool.function.parameters.properties.input.properties), ["url"]);
  assert.match(converted.body.messages[0].content, /browser\/open_url/);
  assert.doesNotMatch(converted.body.messages[0].content, /browser\/read_url/);
});

test("chat routes expose controlled browser and search capability actions from configured providers", () => {
  const converted = responsesToChatRequest(
    {
      input: "search the web and read the best result",
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "local-browser",
          capability: "browser",
          adapter: "local_browser",
          enabled: true,
        },
        {
          id: "search-provider",
          capability: "web_search",
          adapter: "generic_http",
          baseUrl: "https://search.example/v1",
          endpoint: "/search",
          enabled: true,
        },
      ],
    },
  );

  const tool = (converted.body.tools || []).find((item) =>
    item.function?.name === "codexbridge_capability"
  );
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.capability.enum, [
    "browser",
    "web_search",
  ]);
  assert.deepEqual(tool.function.parameters.properties.action.enum, [
    "read_url",
    "search",
  ]);
  assert.match(tool.function.parameters.properties.input.properties.query.description, /search/i);
  assert.match(converted.body.messages[0].content, /web_search\/search/);
});

test("chat routes expose only the capability families requested by the current turn", () => {
  const capabilityProviders = [
    {
      id: "local-browser",
      capability: "browser",
      adapter: "local_browser",
      enabled: true,
    },
    {
      id: "search-provider",
      capability: "web_search",
      adapter: "generic_http",
      baseUrl: "https://search.example/v1",
      endpoint: "/search",
      enabled: true,
    },
    {
      id: "ocr-provider",
      capability: "ocr",
      adapter: "generic_http",
      baseUrl: "https://ocr.example/v1",
      endpoint: "/ocr",
      enabled: true,
    },
    {
      id: "file-provider",
      capability: "file_processing",
      adapter: "generic_http",
      baseUrl: "https://files.example/v1",
      endpoint: "/extract-text",
      enabled: true,
    },
  ];

  const converted = responsesToChatRequest(
    {
      input: "search the web for current CodexBridge release notes",
    },
    route,
    new ResponseHistory(),
    { capabilityProviders },
  );

  const tool = (converted.body.tools || []).find((item) =>
    item.function?.name === "codexbridge_capability"
  );
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.capability.enum, [
    "web_search",
  ]);
  assert.deepEqual(tool.function.parameters.properties.action.enum, [
    "search",
  ]);
  assert.match(converted.body.messages[0].content, /web_search\/search/);
  assert.doesNotMatch(converted.body.messages[0].content, /browser\/open_url/);
  assert.doesNotMatch(converted.body.messages[0].content, /ocr\/extract_text/);
  assert.doesNotMatch(converted.body.messages[0].content, /file_processing\/extract_text/);
});

test("chat routes expose only input fields needed by the requested capability", () => {
  const converted = responsesToChatRequest(
    {
      input: "search the web for current CodexBridge release notes",
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "local-browser",
          capability: "browser",
          adapter: "local_browser",
          enabled: true,
        },
        {
          id: "search-provider",
          capability: "web_search",
          adapter: "generic_http",
          baseUrl: "https://search.example/v1",
          endpoint: "/search",
          enabled: true,
        },
        {
          id: "ocr-provider",
          capability: "ocr",
          adapter: "generic_http",
          baseUrl: "https://ocr.example/v1",
          endpoint: "/ocr",
          enabled: true,
        },
        {
          id: "video-provider",
          capability: "video",
          adapter: "generic_http",
          baseUrl: "https://video.example/v1",
          endpoint: "/videos",
          enabled: true,
        },
      ],
    },
  );

  const tool = (converted.body.tools || []).find((item) =>
    item.function?.name === "codexbridge_capability"
  );
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.function.parameters.properties.input.properties), [
    "query",
  ]);
});

test("chat routes do not expose controlled capabilities for setup and UI wording tasks", () => {
  const capabilityProviders = [
    {
      id: "local-browser",
      capability: "browser",
      adapter: "local_browser",
      enabled: true,
    },
    {
      id: "search-provider",
      capability: "web_search",
      adapter: "generic_http",
      baseUrl: "https://search.example/v1",
      endpoint: "/search",
      enabled: true,
    },
    {
      id: "screenshot-provider",
      capability: "webpage_screenshot",
      adapter: "generic_http",
      baseUrl: "https://screenshot.example/v1",
      endpoint: "/screenshot",
      enabled: true,
    },
    {
      id: "ocr-provider",
      capability: "ocr",
      adapter: "generic_http",
      baseUrl: "https://ocr.example/v1",
      endpoint: "/ocr",
      enabled: true,
    },
    {
      id: "file-provider",
      capability: "file_processing",
      adapter: "generic_http",
      baseUrl: "https://file.example/v1",
      endpoint: "/extract-text",
      enabled: true,
    },
  ];

  for (const input of [
    "Build a webpage screenshot settings panel.",
    "Write OCR provider setup docs.",
    "Create a search box component.",
    "帮我做一个网页截图按钮。",
    "帮我写一个 OCR 接入文档。",
    "做一个文件提取页面，不要读取任何文件。",
  ]) {
    const converted = responsesToChatRequest(
      { input },
      route,
      new ResponseHistory(),
      { capabilityProviders },
    );

    assert.equal(
      (converted.body.tools || []).some((item) => item.function?.name === "codexbridge_capability"),
      false,
      input,
    );
    assert.doesNotMatch(converted.body.messages[0].content, /codexbridge_capability/, input);
  }
});

test("chat routes expose controlled computer use app listing, app launch, and desktop screenshot", () => {
  const converted = responsesToChatRequest(
    {
      input: "Computer Use",
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "local-computer-use",
          capability: "computer_use",
          adapter: "local_computer_use",
          enabled: true,
        },
      ],
    },
  );

  const tool = (converted.body.tools || []).find((item) =>
    item.function?.name === "codexbridge_capability"
  );
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.capability.enum, ["computer_use"]);
  assert.deepEqual(tool.function.parameters.properties.action.enum, ["list_apps", "open_app", "screenshot_desktop"]);
  assert.match(tool.function.parameters.properties.input.properties.app.description, /allowlisted/i);
  assert.match(tool.function.parameters.properties.input.properties.displayId.description, /desktop display/i);
  assert.match(converted.body.messages[0].content, /computer_use\/list_apps/);
  assert.match(converted.body.messages[0].content, /computer_use\/open_app/);
  assert.match(converted.body.messages[0].content, /computer_use\/screenshot_desktop/);
  assert.doesNotMatch(converted.body.messages[0].content, /computer_use\/diagnose/);
});

test("chat routes scope Computer Use actions for app launch requests", () => {
  const converted = responsesToChatRequest(
    {
      input: "Computer Use open notepad",
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "local-computer-use",
          capability: "computer_use",
          adapter: "local_computer_use",
          enabled: true,
        },
      ],
    },
  );

  const tool = (converted.body.tools || []).find((item) =>
    item.function?.name === "codexbridge_capability"
  );
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.action.enum, ["list_apps", "open_app"]);
  assert.deepEqual(Object.keys(tool.function.parameters.properties.input.properties), ["app"]);
  assert.match(converted.body.messages[0].content, /computer_use\/open_app/);
  assert.doesNotMatch(converted.body.messages[0].content, /computer_use\/screenshot_desktop/);
});

test("chat routes scope Computer Use actions for desktop screenshot requests", () => {
  const converted = responsesToChatRequest(
    {
      input: "Capture a desktop screenshot.",
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "local-computer-use",
          capability: "computer_use",
          adapter: "local_computer_use",
          enabled: true,
        },
      ],
    },
  );

  const tool = (converted.body.tools || []).find((item) =>
    item.function?.name === "codexbridge_capability"
  );
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.action.enum, ["screenshot_desktop"]);
  assert.deepEqual(Object.keys(tool.function.parameters.properties.input.properties), ["displayId"]);
  assert.match(converted.body.messages[0].content, /computer_use\/screenshot_desktop/);
  assert.doesNotMatch(converted.body.messages[0].content, /computer_use\/open_app/);
});

test("interactive Computer Use requests prefer controlled capability over shell when configured", () => {
  const converted = responsesToChatRequest(
    {
      input: "Computer Use open notepad",
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run shell.",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "local-computer-use",
          capability: "computer_use",
          adapter: "local_computer_use",
          enabled: true,
        },
      ],
    },
  );

  assert.deepEqual(converted.body.tool_choice, {
    type: "function",
    function: { name: "codexbridge_capability" },
  });
  assert.equal(
    converted.body.tools.some((tool) => tool.function?.name === "shell_command"),
    true,
  );
  assert.match(converted.body.messages[0].content, /computer_use\/open_app/);
  assert.match(converted.body.messages[0].content, /Do not use shell commands/);
  assert.doesNotMatch(converted.body.messages[0].content, /use command tools to launch apps or scripts directly/i);
  assert.doesNotMatch(converted.body.messages[0].content, /use any listed shell or command tools to complete browser\/app tasks/i);
});

test("chat routes expose a controlled webpage screenshot capability action from configured providers", () => {
  const converted = responsesToChatRequest(
    {
      input: "capture a screenshot of the page",
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "screenshot-provider",
          capability: "webpage_screenshot",
          adapter: "generic_http",
          baseUrl: "https://screenshot.example/v1",
          endpoint: "/screenshot",
          enabled: true,
        },
      ],
    },
  );

  const tool = (converted.body.tools || []).find((item) =>
    item.function?.name === "codexbridge_capability"
  );
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.capability.enum, [
    "webpage_screenshot",
  ]);
  assert.deepEqual(tool.function.parameters.properties.action.enum, [
    "screenshot_url",
  ]);
  assert.match(tool.function.parameters.properties.input.properties.url.description, /webpage_screenshot\/screenshot_url.*safe bare domains/i);
  assert.match(converted.body.messages[0].content, /webpage_screenshot\/screenshot_url/);
});

test("chat routes expose local browser webpage screenshot providers without a remote endpoint", () => {
  const converted = responsesToChatRequest(
    {
      input: "capture a screenshot of https://example.com",
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "local-page-screenshot",
          capability: "webpage_screenshot",
          adapter: "local_browser",
          enabled: true,
        },
      ],
    },
  );

  const tool = (converted.body.tools || []).find((item) =>
    item.function?.name === "codexbridge_capability"
  );
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.capability.enum, ["webpage_screenshot"]);
  assert.deepEqual(tool.function.parameters.properties.action.enum, ["screenshot_url"]);
  assert.match(converted.body.messages[0].content, /webpage_screenshot\/screenshot_url/);
});

test("chat routes expose a controlled OCR capability action from configured providers", () => {
  const converted = responsesToChatRequest(
    {
      input: "extract text from this image url",
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "ocr-provider",
          capability: "ocr",
          adapter: "generic_http",
          baseUrl: "https://ocr.example/v1",
          endpoint: "/ocr",
          enabled: true,
        },
      ],
    },
  );

  const tool = (converted.body.tools || []).find((item) =>
    item.function?.name === "codexbridge_capability"
  );
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.capability.enum, [
    "ocr",
  ]);
  assert.deepEqual(tool.function.parameters.properties.action.enum, [
    "extract_text",
  ]);
  assert.match(tool.function.parameters.properties.input.properties.imageUrl.description, /safe bare domains/i);
  assert.match(converted.body.messages[0].content, /ocr\/extract_text/);
});

test("chat routes expose a controlled file processing capability action from configured providers", () => {
  const converted = responsesToChatRequest(
    {
      input: "extract text from this report url",
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "file-provider",
          capability: "file_processing",
          adapter: "generic_http",
          baseUrl: "https://files.example/v1",
          endpoint: "/extract-text",
          enabled: true,
        },
      ],
    },
  );

  const tool = (converted.body.tools || []).find((item) =>
    item.function?.name === "codexbridge_capability"
  );
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.capability.enum, [
    "file_processing",
  ]);
  assert.deepEqual(tool.function.parameters.properties.action.enum, [
    "extract_text",
  ]);
  assert.match(tool.function.parameters.properties.input.properties.fileUrl.description, /safe bare domains/i);
  assert.equal(tool.function.parameters.properties.input.properties.path, undefined);
  assert.match(converted.body.messages[0].content, /file_processing\/extract_text/);
  assert.doesNotMatch(converted.body.messages[0].content, /file_processing\/inspect_file/);
  assert.match(converted.body.messages[0].content, /Do not use shell commands/);
});

test("chat routes expose local file processing providers with explicit path guidance", () => {
  const converted = responsesToChatRequest(
    {
      input: "extract text from C:\\Users\\Administrator\\Documents\\report.txt",
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "local-file",
          capability: "file_processing",
          adapter: "local_file",
          enabled: true,
        },
      ],
    },
  );

  const tool = (converted.body.tools || []).find((item) =>
    item.function?.name === "codexbridge_capability"
  );
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.capability.enum, [
    "file_processing",
  ]);
  assert.deepEqual(tool.function.parameters.properties.action.enum, [
    "extract_text",
  ]);
  assert.match(tool.function.parameters.properties.input.properties.path.description, /explicit local file path/i);
  assert.match(converted.body.messages[0].content, /file_processing\/extract_text/);
  assert.match(converted.body.messages[0].content, /explicit local file path/i);
  assert.match(converted.body.messages[0].content, /Do not use shell commands/);
});

test("chat routes scope local file processing to inspect_file for metadata requests", () => {
  const converted = responsesToChatRequest(
    {
      input: "inspect file metadata for C:\\Users\\Administrator\\Documents\\models.json",
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "local-file",
          capability: "file_processing",
          adapter: "local_file",
          enabled: true,
        },
      ],
    },
  );

  const tool = (converted.body.tools || []).find((item) =>
    item.function?.name === "codexbridge_capability"
  );
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.capability.enum, [
    "file_processing",
  ]);
  assert.deepEqual(tool.function.parameters.properties.action.enum, [
    "inspect_file",
  ]);
  assert.deepEqual(Object.keys(tool.function.parameters.properties.input.properties), [
    "path",
    "filePath",
    "localPath",
  ]);
  assert.match(tool.function.parameters.properties.input.properties.path.description, /explicit local file path/i);
  assert.match(converted.body.messages[0].content, /file_processing\/inspect_file/);
  assert.doesNotMatch(converted.body.messages[0].content, /file_processing\/extract_text/);
  assert.match(converted.body.messages[0].content, /Do not use shell commands/);
});

test("chat routes expose controlled speech and video capability actions from configured providers", () => {
  const converted = responsesToChatRequest(
    {
      input: "narrate this and generate a short demo video",
    },
    route,
    new ResponseHistory(),
    {
      capabilityProviders: [
        {
          id: "speech-provider",
          capability: "speech",
          adapter: "generic_http",
          baseUrl: "https://speech.example/v1",
          endpoint: "/speech",
          enabled: true,
        },
        {
          id: "video-provider",
          capability: "video",
          adapter: "generic_http",
          baseUrl: "https://video.example/v1",
          endpoint: "/videos",
          enabled: true,
        },
      ],
    },
  );

  const tool = (converted.body.tools || []).find((item) =>
    item.function?.name === "codexbridge_capability"
  );
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.properties.capability.enum, [
    "speech",
    "video",
  ]);
  assert.deepEqual(tool.function.parameters.properties.action.enum, [
    "synthesize",
    "generate",
  ]);
  assert.match(tool.function.parameters.properties.input.properties.text.description, /speech/i);
  assert.match(tool.function.parameters.properties.input.properties.prompt.description, /video/i);
  assert.match(converted.body.messages[0].content, /speech\/synthesize/);
  assert.match(converted.body.messages[0].content, /video\/generate/);
  assert.match(converted.body.messages[0].content, /Do not use shell commands/);
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
    ["apply_patch", "mcp__duplicate__shell_command", "shell_command"],
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

function stableToolSet(order) {
  const tools = {
    shell_command: {
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
    lookup: {
      type: "function",
      name: "lookup",
      description: "Look up context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
    "mcp__filesystem__": {
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
  };
  return order.map((name) => tools[name]);
}

function countCacheControlBlocks(value) {
  if (!value || typeof value !== "object") {
    return 0;
  }
  let count = Object.prototype.hasOwnProperty.call(value, "cache_control") ? 1 : 0;
  for (const child of Object.values(value)) {
    count += countCacheControlBlocks(child);
  }
  return count;
}

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
