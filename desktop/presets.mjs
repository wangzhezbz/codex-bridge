export const PROVIDERS = [
  {
    id: "codex",
    name: "GPT 订阅",
    shortName: "GPT",
    keyEnv: null,
    keyLabel: "使用 Codex/OpenAI 登录态",
    keyUrl: "https://chatgpt.com/codex",
    docsUrl: "https://developers.openai.com/codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "codex_openai",
    description: "GPT-6 与现有 GPT 模型使用 Codex 订阅；可用性取决于账号，不需要 API Key。",
  },
  {
    id: "openai",
    name: "OpenAI API",
    shortName: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    keyLabel: "OpenAI API Key",
    keyUrl: "https://platform.openai.com/api-keys",
    docsUrl: "https://platform.openai.com/docs",
    baseUrl: "https://api.openai.com/v1",
    authMode: "api_key",
    description: "OpenAI 官方 API。",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    shortName: "Claude",
    keyEnv: "ANTHROPIC_API_KEY",
    keyLabel: "Anthropic API Key",
    keyUrl: "https://console.anthropic.com/settings/keys",
    docsUrl: "https://platform.claude.com/docs/en/api/messages",
    baseUrl: "https://api.anthropic.com/v1",
    api: "anthropic_messages",
    authMode: "anthropic_api_key",
    description: "Anthropic Claude native Messages API.",
  },
  {
    id: "xai",
    name: "xAI Grok",
    shortName: "Grok",
    keyEnv: "XAI_API_KEY",
    keyLabel: "xAI API Key",
    keyUrl: "https://console.x.ai/",
    docsUrl: "https://docs.x.ai/developers/",
    baseUrl: "https://api.x.ai/v1",
    api: "chat_completions",
    authMode: "api_key",
    description: "xAI Grok OpenAI-compatible API.",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    shortName: "Gemini",
    keyEnv: "GEMINI_API_KEY",
    keyLabel: "Gemini API Key",
    keyUrl: "https://aistudio.google.com/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    api: "chat_completions",
    authMode: "api_key",
    description: "Google Gemini OpenAI-compatible API.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    shortName: "DeepSeek",
    keyEnv: "DEEPSEEK_API_KEY",
    keyLabel: "DeepSeek API Key",
    keyUrl: "https://platform.deepseek.com/api_keys",
    docsUrl: "https://api-docs.deepseek.com/",
    baseUrl: "https://api.deepseek.com/v1",
    api: "chat_completions",
    authMode: "api_key",
    description: "DeepSeek 官方 OpenAI-compatible API。",
  },
  {
    id: "kimi",
    name: "Kimi / Moonshot",
    shortName: "Kimi",
    keyEnv: "MOONSHOT_API_KEY",
    keyLabel: "Kimi API Key",
    keyUrl: "https://platform.kimi.com/console/api-keys",
    docsUrl: "https://platform.kimi.com/docs/api/list-models",
    baseUrl: "https://api.moonshot.cn/v1",
    authMode: "api_key",
    description: "Kimi / Moonshot Open Platform API。",
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    shortName: "Kimi Code",
    keyEnv: "KIMI_CODE_API_KEY",
    keyLabel: "Kimi Code API Key",
    keyUrl: "https://platform.kimi.com/console/api-keys",
    docsUrl: "https://www.kimi.com/code/docs/en/",
    baseUrl: "https://api.kimi.com/coding/v1",
    authMode: "api_key",
    description: "Kimi Code 编程订阅 API，与 Kimi / Moonshot API 独立配置。",
  },
  {
    id: "xiaomi",
    name: "Xiaomi MiMo",
    shortName: "MiMo",
    keyEnv: "MIMO_API_KEY",
    keyLabel: "MiMo API Key",
    keyUrl: "https://platform.xiaomimimo.com/",
    docsUrl: "https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call",
    baseUrl: "https://api.xiaomimimo.com/v1",
    authMode: "api_key",
    description: "Xiaomi MiMo OpenAI-compatible API.",
  },
  {
    id: "minimax",
    name: "MiniMax",
    shortName: "MiniMax",
    keyEnv: "MINIMAX_API_KEY",
    keyLabel: "MiniMax API Key",
    keyUrl: "https://www.minimaxi.com/",
    docsUrl: "https://platform.minimaxi.com/docs/api-reference/text-openai-api",
    baseUrl: "https://api.minimaxi.com/v1",
    authMode: "api_key",
    description: "MiniMax OpenAI-compatible API.",
  },
  {
    id: "stepfun",
    name: "StepFun",
    shortName: "StepFun",
    keyEnv: "STEPFUN_API_KEY",
    keyLabel: "StepFun API Key",
    keyUrl: "https://platform.stepfun.ai/",
    docsUrl: "https://platform.stepfun.ai/docs/en/step-plan/quick-start",
    baseUrl: "https://api.stepfun.ai/step_plan/v1",
    authMode: "api_key",
    description: "StepFun Step Plan OpenAI-compatible API.",
  },
  {
    id: "qianfan",
    name: "Baidu Qianfan",
    shortName: "Qianfan",
    keyEnv: "QIANFAN_API_KEY",
    keyLabel: "Qianfan API Key",
    keyUrl: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole",
    docsUrl: "https://intl.cloud.baidu.com/en/doc/qianfan/s/qm8qxemze-intl-en",
    baseUrl: "https://qianfan.baidubce.com/v2",
    authMode: "api_key",
    description: "Baidu Qianfan OpenAI-compatible API.",
  },
  {
    id: "hunyuan",
    name: "Tencent Hunyuan",
    shortName: "Hunyuan",
    keyEnv: "HUNYUAN_API_KEY",
    keyLabel: "Hunyuan API Key",
    keyUrl: "https://console.cloud.tencent.com/hunyuan/api-key",
    docsUrl: "https://cloud.tencent.com/document/product/1729/111007",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    authMode: "api_key",
    description: "Tencent Hunyuan OpenAI-compatible API.",
  },
  {
    id: "volcengine",
    name: "Volcano Ark / Doubao",
    shortName: "Doubao",
    keyEnv: "ARK_API_KEY",
    keyLabel: "Volcano Ark API Key",
    keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    docsUrl: "https://www.volcengine.com/docs/82379/1330626",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    authMode: "api_key",
    description: "Volcano Ark / Doubao OpenAI-compatible API.",
  },
  {
    id: "hunyuan-tokenhub", name: "Tencent Hunyuan TokenHub", shortName: "混元 TokenHub",
    keyEnv: "TOKENHUB_API_KEY", keyLabel: "TokenHub API Key",
    keyUrl: "https://console.cloud.tencent.com/tokenhub",
    docsUrl: "https://cloud.tencent.com/document/product/1823/130051",
    baseUrl: "https://tokenhub.tencentmaas.com/v1", authMode: "api_key",
    description: "腾讯混元新平台；使用独立 TokenHub Key，旧混元配置保持不变。",
  },
  {
    id: "qwen",
    name: "Qwen / DashScope",
    shortName: "Qwen",
    keyEnv: "DASHSCOPE_API_KEY",
    keyLabel: "DashScope API Key",
    keyUrl: "https://dashscope.console.aliyun.com/apiKey",
    docsUrl: "https://www.alibabacloud.com/help/en/model-studio/get-api-key",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    authMode: "api_key",
    description: "阿里云百炼 / DashScope OpenAI-compatible API。",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    shortName: "GLM",
    keyEnv: "ZHIPUAI_API_KEY",
    keyLabel: "智谱 API Key",
    keyUrl: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
    docsUrl: "https://docs.bigmodel.cn/",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    authMode: "api_key",
    description: "智谱开放平台 OpenAI-compatible API。",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    shortName: "OpenRouter",
    keyEnv: "OPENROUTER_API_KEY",
    keyLabel: "OpenRouter API Key",
    keyUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    baseUrl: "https://openrouter.ai/api/v1",
    authMode: "api_key",
    description: "OpenRouter 多模型统一接口。",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    shortName: "SiliconFlow",
    keyEnv: "SILICONFLOW_API_KEY",
    keyLabel: "SiliconFlow API Key",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    docsUrl: "https://docs.siliconflow.cn/",
    baseUrl: "https://api.siliconflow.cn/v1",
    authMode: "api_key",
    description: "SiliconFlow 硅基流动 OpenAI-compatible API。",
  },
];

export const MODEL_PRESETS = [
  route("codex-gpt-6-astra", "codex", "6-Astra", "gpt-6-astra", "responses", 872000, imageInput(codexFastMode({
    ...codex56Metadata("medium", true, "v2"),
    // Codex's default window is smaller than its supported opt-in maximum.
    // Keep the subscription limits separate from the public API limits.
    catalogContextWindow: 272000,
    description: "通过 ChatGPT 订阅使用 Astra，支持图像、工具调用和多档推理。",
    serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }],
  }))),
  route("codex-gpt-6-1-sol", "codex", "6.1-Sol", "gpt-6.1-sol", "responses", 272000, imageInput({
    ...gpt6ReasoningMetadata(false, true),
    additionalSpeedTiers: ["fast"],
    serviceTiers: [{ id: "priority", name: "Fast", description: "账号和地区支持时可用" }],
    description: "通过 ChatGPT 订阅使用 GPT-6.1 Sol；可用性、Fast 与 Ultra 取决于账号和客户端。上下文暂用保守的 272K 回退值，并非官方上限。",
  })),
  // Native model metadata is not yet present in the verified Codex cache.
  // 272K is a conservative fallback, not a claim about the upstream maximum.
  // Do not infer Responses Lite, multi-agent protocol versions or Fast tiers.
  route("codex-gpt-6-sol", "codex", "6-Sol", "gpt-6-sol", "responses", 272000, imageInput({
    ...gpt6ReasoningMetadata(false, true),
    description: "通过 ChatGPT 订阅使用 GPT-6 Sol；可用性与 Ultra 取决于账号和客户端。上下文暂用保守的 272K 回退值，并非官方上限。",
  })),
  route("codex-gpt-6-luna", "codex", "6-Luna", "gpt-6-luna", "responses", 272000, imageInput({
    ...gpt6ReasoningMetadata(false, false),
    description: "通过 ChatGPT 订阅使用 GPT-6 Luna；可用性取决于账号和客户端，推理最高为 Max，不支持 Ultra。上下文暂用保守的 272K 回退值，并非官方上限。",
  })),
  route(
    "codex-gpt-5-6",
    "codex",
    "5.6（订阅兼容）",
    "gpt-5.6",
    "responses",
    372000,
    imageInput(codexFastMode({
      ...codex56Metadata("medium", true, "v2"),
      description: "ChatGPT 订阅兼容入口：当账号不支持显式 5.6-Sol 时使用。请求官方通用 gpt-5.6，由 Codex 按当前账号能力提供可用的 5.6 配置，不固定为 Sol、Terra 或 Luna。",
      userDescription: "供不支持 5.6-Sol 的 ChatGPT 订阅账号使用；这是通用 5.6，不固定为 Sol、Terra 或 Luna。",
    })),
  ),
  route("codex-gpt-5-6-sol", "codex", "5.6-Sol", "gpt-5.6-sol", "responses", 372000, imageInput(codexFastMode(codex56Metadata("low", true, "v2")))),
  route("codex-gpt-5-6-terra", "codex", "5.6-Terra", "gpt-5.6-terra", "responses", 372000, imageInput(codexFastMode(codex56Metadata("medium", true, "v2")))),
  route("codex-gpt-5-6-luna", "codex", "5.6-Luna", "gpt-5.6-luna", "responses", 372000, imageInput(codexFastMode(codex56Metadata("medium", false, "v1")))),
  route("codex-gpt-5-5", "codex", "5.5", "gpt-5.5", "responses", 258400, imageInput(codexFastMode())),
  route("codex-gpt-5-4", "codex", "5.4", "gpt-5.4", "responses", 258400, imageInput(codexFastMode())),
  route("codex-gpt-5-4-mini", "codex", "5.4-Mini", "gpt-5.4-mini", "responses", 258400, imageInput()),
  route("openai-gpt-6-astra", "openai", "OpenAI 6-Astra", "gpt-6-astra", "responses", 1050000, imageInput({
    ...codex56Metadata("medium", false, "v2"),
    truncationPolicy: { mode: "tokens", limit: 922000 },
    description: "通过 OpenAI API 使用 Astra，支持图像、工具调用和长上下文。",
  })),
  route("openai-gpt-6-1-sol", "openai", "OpenAI 6.1-Sol", "gpt-6.1-sol", "responses", 1050000, imageInput({
    ...gpt6ReasoningMetadata(false, false),
    truncationPolicy: { mode: "tokens", limit: 922000 },
    description: "通过 OpenAI Responses API 使用 GPT-6.1 Sol，支持图像、工具调用及 low 至 max 推理；不支持 none 或 minimal。",
  })),
  route("openai-gpt-6-sol", "openai", "OpenAI 6-Sol", "gpt-6-sol", "responses", 1050000, imageInput({
    ...gpt6ReasoningMetadata(true, false),
    truncationPolicy: { mode: "tokens", limit: 922000 },
    description: "通过 OpenAI Responses API 使用 GPT-6 Sol，支持图像、工具调用和 none 至 max 推理。",
  })),
  route("openai-gpt-6-luna", "openai", "OpenAI 6-Luna", "gpt-6-luna", "responses", 1050000, imageInput({
    ...gpt6ReasoningMetadata(true, false),
    truncationPolicy: { mode: "tokens", limit: 922000 },
    description: "通过 OpenAI Responses API 使用 GPT-6 Luna，支持图像、工具调用和 none 至 max 推理。",
  })),
  // Retain saved routes/history compatibility, but do not offer these in new selections.
  route("openai-gpt-4-1", "openai", "OpenAI 4.1", "gpt-4.1", "responses", 1047576, imageInput({ hiddenFromPicker: true })),
  route("openai-gpt-4-1-mini", "openai", "OpenAI 4.1 Mini", "gpt-4.1-mini", "responses", 1047576, imageInput({ hiddenFromPicker: true })),
  route("anthropic-claude-sonnet-4-6", "anthropic", "Claude Sonnet 4.6", "claude-sonnet-4-6", "anthropic_messages", 200000, imageInput({
    dropParams: ["response_format", "parallel_tool_calls"],
  })),
  route("anthropic-claude-opus-4-6", "anthropic", "Claude Opus 4.6", "claude-opus-4-6", "anthropic_messages", 200000, imageInput({
    dropParams: ["response_format", "parallel_tool_calls"],
  })),
  route("xai-grok-4-5", "xai", "Grok 4.5", "grok-4.5", "chat_completions", 500000, imageInput({
    dropParams: ["response_format", "parallel_tool_calls"],
  })),
  route("gemini-3-5-flash", "gemini", "Gemini 3.5 Flash", "gemini-3.5-flash", "chat_completions", 1048576, imageInput({
    dropParams: ["response_format", "parallel_tool_calls"],
  })),
  route("gemini-3-1-flash-lite", "gemini", "Gemini 3.1 Flash Lite", "gemini-3.1-flash-lite", "chat_completions", 1048576, imageInput({
    dropParams: ["response_format", "parallel_tool_calls"],
  })),
  route("deepseek-v4-pro", "deepseek", "DeepSeek V4 Pro", "deepseek-v4-pro", "responses", 1000000, {
    baseUrl: "https://api.deepseek.com", inputModalities: ["text"],
    supportsFiles: "text-placeholder", supportsResponsePreviousId: false,
    defaultReasoningLevel: "high", supportedReasoningLevels: [
      { effort: "none", description: "关闭思考" }, ...reasoningLevels(["low", "high", "max"]),
    ],
  }),
  route("deepseek-v4-flash", "deepseek", "DeepSeek V4 Flash", "deepseek-v4-flash", "responses", 1048576, {
    baseUrl: "https://api.deepseek.com",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
  }),
  route("deepseek-v4-1-flash", "deepseek", "DeepSeek V4.1 Flash", "deepseek-flash", "responses", 1048576, imageInput({
    baseUrl: "https://api.deepseek.com",
    supportsFiles: "text-placeholder",
    supportsResponsePreviousId: false,
    defaultReasoningLevel: "high",
    supportedReasoningLevels: [
      { effort: "none", description: "关闭思考，直接回答" },
      { effort: "low", description: "轻量推理，优先速度" },
      { effort: "high", description: "深入推理，适合复杂任务" },
      { effort: "max", description: "最高推理强度" },
    ],
    description: "通过 DeepSeek 原生 Responses API 使用 V4.1 Flash，支持图像、工具调用和 1M 上下文。",
  })),
  route("kimi-k2-7-code", "kimi", "Kimi K2.7 Code", "kimi-k2.7-code", "chat_completions", 258400, imageInput({
    dropParams: ["response_format", "parallel_tool_calls"],
  })),
  route("kimi-k2-6", "kimi", "Kimi K2.6", "kimi-k2.6", "chat_completions", 258400, imageInput({
    dropParams: ["response_format", "parallel_tool_calls"],
  })),
  route("kimi-code-k3", "kimi-code", "Kimi K3", "k3", "chat_completions", 258400, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("kimi-code-k3-256k", "kimi-code", "Kimi K3 256K", "k3-256k", "chat_completions", 258400, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("kimi-code-for-coding", "kimi-code", "Kimi For Coding", "kimi-for-coding", "chat_completions", 258400, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("kimi-code-for-coding-highspeed", "kimi-code", "Kimi For Coding Highspeed", "kimi-for-coding-highspeed", "chat_completions", 258400, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("xiaomi-mimo-v2-5-pro", "xiaomi", "MiMo V2.5 Pro", "mimo-v2.5-pro", "chat_completions", 258400, imageInput({
    dropParams: ["response_format", "parallel_tool_calls"],
  })),
  route("minimax-m3", "minimax", "MiniMax M3", "MiniMax-M3", "chat_completions", 204800, imageInput({
    dropParams: ["response_format", "parallel_tool_calls"],
  })),
  route("minimax-m2-7", "minimax", "MiniMax M2.7", "MiniMax-M2.7", "chat_completions", 204800, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("stepfun-step-3-7-flash", "stepfun", "Step 3.7 Flash", "step-3.7-flash", "chat_completions", 128000, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("stepfun-step-3-5-flash", "stepfun", "Step 3.5 Flash", "step-3.5-flash", "chat_completions", 128000, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("qianfan-ernie-4-0-turbo-8k", "qianfan", "ERNIE 4.0 Turbo 8K", "ernie-4.0-turbo-8k", "chat_completions", 8192, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("qianfan-ernie-3-5-8k", "qianfan", "ERNIE 3.5 8K", "ernie-3.5-8k", "chat_completions", 8192, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("hunyuan-turbos-latest", "hunyuan", "Hunyuan TurboS Latest", "hunyuan-turbos-latest", "chat_completions", 128000, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("doubao-seed-1-8", "volcengine", "Doubao Seed 1.8", "doubao-seed-1-8-251228", "chat_completions", 258400, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("doubao-seed-2-0-mini", "volcengine", "Doubao Seed 2.0 Mini", "doubao-seed-2-0-mini-260428", "chat_completions", 258400, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("qwen3-coder-plus", "qwen", "Qwen3 Coder Plus", "qwen3-coder-plus", "chat_completions", 258400, {
    dropParams: ["parallel_tool_calls"],
  }),
  route("qwen3-vl-plus", "qwen", "Qwen3 VL Plus", "qwen3-vl-plus", "chat_completions", 258400, imageInput({
    dropParams: ["parallel_tool_calls"],
  })),
  route("qwen3-vl-flash", "qwen", "Qwen3 VL Flash", "qwen3-vl-flash", "chat_completions", 258400, imageInput({
    dropParams: ["parallel_tool_calls"],
  })),
  route("qwen-plus", "qwen", "Qwen Plus", "qwen-plus", "chat_completions", 128000, {
    dropParams: ["parallel_tool_calls"],
  }),
  route("qwen-max", "qwen", "Qwen Max", "qwen-max", "chat_completions", 128000, {
    dropParams: ["parallel_tool_calls"],
  }),
  route("glm-4-6", "zhipu", "GLM-4.6", "glm-4.6", "chat_completions", 128000, {
    dropParams: ["parallel_tool_calls"],
  }),
  route("glm-4-6v", "zhipu", "GLM-4.6V", "glm-4.6v", "chat_completions", 128000, imageInput({
    dropParams: ["parallel_tool_calls"],
  })),
  route("openrouter-sonnet", "openrouter", "OpenRouter Claude Sonnet", "anthropic/claude-sonnet-4.5", "chat_completions", 200000, imageInput({
    dropParams: ["parallel_tool_calls"],
  })),
  route("siliconflow-qwen3-coder", "siliconflow", "SiliconFlow Qwen3 Coder", "Qwen/Qwen3-Coder-480B-A35B-Instruct", "chat_completions", 262144, {
    dropParams: ["parallel_tool_calls"],
  }),

  // Verified against the official provider directories on 2026-09-28.
  // Additive only: existing preset IDs, protocols and saved selections remain intact.
  route("openai-gpt-5-6-sol", "openai", "OpenAI 5.6-Sol", "gpt-5.6-sol", "responses", 1050000, imageInput({ ...gpt6ReasoningMetadata(true, false), truncationPolicy: { mode: "tokens", limit: 922000 } })),
  route("openai-gpt-5-6-terra", "openai", "OpenAI 5.6-Terra", "gpt-5.6-terra", "responses", 1050000, imageInput({ ...gpt6ReasoningMetadata(true, false), truncationPolicy: { mode: "tokens", limit: 922000 } })),
  route("openai-gpt-5-6-luna", "openai", "OpenAI 5.6-Luna", "gpt-5.6-luna", "responses", 1050000, imageInput({ ...gpt6ReasoningMetadata(true, false), truncationPolicy: { mode: "tokens", limit: 922000 } })),
  route("anthropic-claude-fable-5-1", "anthropic", "Claude Fable 5.1", "claude-fable-5-1", "anthropic_messages", 1000000, imageInput({ dropParams: ["response_format", "parallel_tool_calls"] })),
  route("anthropic-claude-opus-5-5", "anthropic", "Claude Opus 5.5", "claude-opus-5-5", "anthropic_messages", 1000000, imageInput({ dropParams: ["response_format", "parallel_tool_calls"] })),
  route("anthropic-claude-sonnet-5", "anthropic", "Claude Sonnet 5", "claude-sonnet-5", "anthropic_messages", 1000000, imageInput({ dropParams: ["response_format", "parallel_tool_calls"] })),
  route("anthropic-claude-haiku-4-5", "anthropic", "Claude Haiku 4.5", "claude-haiku-4-5-20251001", "anthropic_messages", 200000, imageInput({ dropParams: ["response_format", "parallel_tool_calls"] })),
  route("xai-grok-4-7", "xai", "Grok 4.7", "grok-4.7", "responses", 500000, imageInput({ defaultReasoningLevel: "high", supportedReasoningLevels: reasoningLevels(["low", "medium", "high", "xhigh"]) })),
  route("gemini-3-8-flash", "gemini", "Gemini 3.8 Flash", "gemini-3.8-flash", "chat_completions", 1048576, imageInput({ dropParams: ["response_format", "parallel_tool_calls"] })),
  route("gemini-3-7-flash", "gemini", "Gemini 3.7 Flash", "gemini-3.7-flash", "chat_completions", 1048576, imageInput({ dropParams: ["response_format", "parallel_tool_calls"] })),
  route("kimi-k3", "kimi", "Kimi K3", "kimi-k3", "chat_completions", 1048576, imageInput({ dropParams: ["response_format", "parallel_tool_calls"] })),
  route("xiaomi-mimo-v2-6-pro", "xiaomi", "MiMo V2.6 Pro", "mimo-v2.6-pro", "chat_completions", 1048576, imageInput({ dropParams: ["parallel_tool_calls"] })),
  route("xiaomi-mimo-v2-6-flash", "xiaomi", "MiMo V2.6 Flash", "mimo-v2.6-flash", "chat_completions", 1048576, imageInput({ dropParams: ["parallel_tool_calls"] })),
  route("minimax-m3-1-flash-preview", "minimax", "MiniMax M3.1 Flash Preview", "MiniMax-M3.1-Flash-Preview", "chat_completions", 204800, imageInput({
    defaultReasoningLevel: "max", supportedReasoningLevels: reasoningLevels(["low", "medium", "high", "xhigh", "max"]),
    dropParams: ["response_format", "parallel_tool_calls"],
    description: "MiniMax 最新 Flash 预览模型，始终思考；上下文暂用保守回退值，具体权限与限额以平台为准。",
  })),
  route("stepfun-step-5-preview", "stepfun", "Step 5 Preview", "step-5-preview", "chat_completions", 1048576, imageInput({ dropParams: ["parallel_tool_calls"] })),
  route("qianfan-ernie-5-0", "qianfan", "ERNIE 5.0", "ernie-5.0", "chat_completions", 128000, imageInput({ dropParams: ["parallel_tool_calls"] })),
  route("hunyuan-tokenhub-hy4-preview", "hunyuan-tokenhub", "Hunyuan Hy4 Preview", "hy4-preview", "chat_completions", 1000000, { dropParams: ["parallel_tool_calls"] }),
  route("hunyuan-tokenhub-hy3", "hunyuan-tokenhub", "Hunyuan Hy3", "hy3", "chat_completions", 256000, { dropParams: ["parallel_tool_calls"] }),
  route("doubao-seed-2-1-pro", "volcengine", "Doubao Seed 2.1 Pro", "doubao-seed-2-1-pro-260915", "chat_completions", 1048576, imageInput({ dropParams: ["parallel_tool_calls"] })),
  route("doubao-seed-2-1-lite", "volcengine", "Doubao Seed 2.1 Lite", "doubao-seed-2-1-lite-260915", "chat_completions", 1048576, imageInput({ dropParams: ["parallel_tool_calls"] })),
  route("qwen3-8-max", "qwen", "Qwen3.8 Max", "qwen3.8-max", "chat_completions", 1000000, imageInput({ dropParams: ["parallel_tool_calls"] })),
  route("qwen3-8-flash", "qwen", "Qwen3.8 Flash", "qwen3.8-flash", "chat_completions", 1000000, imageInput({ dropParams: ["parallel_tool_calls"] })),
  route("qwen3-7-plus", "qwen", "Qwen3.7 Plus", "qwen3.7-plus", "chat_completions", 1000000, imageInput({ dropParams: ["parallel_tool_calls"] })),
  route("glm-5-3", "zhipu", "GLM-5.3", "glm-5.3", "chat_completions", 1000000, {
    defaultReasoningLevel: "max", supportedReasoningLevels: reasoningLevels(["low", "high", "max"]), dropParams: ["parallel_tool_calls"],
  }),
  route("openrouter-deepseek-v4-1-flash", "openrouter", "OpenRouter DeepSeek V4.1 Flash", "deepseek/deepseek-v4.1-flash", "chat_completions", 1000000, imageInput({ dropParams: ["parallel_tool_calls"] })),
];

export function defaultSelectedModelIds(mode) {
  if (mode === "all_api") {
    return [
      "openai-gpt-5-6-sol",
      "openai-gpt-5-6-luna",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "kimi-k2-7-code",
    ];
  }
  return [
    "codex-gpt-5-6-sol",
    "codex-gpt-5-6-terra",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "kimi-k2-7-code",
  ];
}

export function providerById(id) {
  return PROVIDERS.find((provider) => provider.id === id);
}

function route(presetId, providerId, displayName, model, api, contextWindow, extra = {}) {
  const provider = providerById(providerId);
  return {
    presetId,
    providerId,
    displayName,
    description: `${displayName} via ${provider?.name || providerId}.`,
    api,
    baseUrl: provider?.baseUrl || "",
    model,
    authMode: provider?.authMode || "api_key",
    apiKeyEnv: provider?.keyEnv || undefined,
    contextWindow,
    ...extra,
  };
}

function imageInput(extra = {}) {
  return {
    inputModalities: ["text", "image"],
    ...extra,
  };
}

function reasoningLevels(efforts) {
  const descriptions = { low: "轻量推理", medium: "均衡推理", high: "深入推理", xhigh: "更高推理强度", max: "最高推理强度" };
  return efforts.map(effort => ({ effort, description: descriptions[effort] }));
}

function codexFastMode(extra = {}) {
  return {
    additionalSpeedTiers: ["fast"],
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    ...extra,
  };
}

function codex56Metadata(defaultReasoningLevel, includeUltra, multiAgentVersion) {
  const supportedReasoningLevels = [
    { effort: "low", description: "Fast responses with lighter reasoning" },
    { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
    { effort: "high", description: "Greater reasoning depth for complex problems" },
    { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
    { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
  ];
  if (includeUltra) {
    supportedReasoningLevels.push({
      effort: "ultra",
      description: "Maximum reasoning with automatic task delegation",
    });
  }
  return {
    defaultReasoningLevel,
    supportedReasoningLevels,
    useResponsesLite: true,
    supportsReasoningSummaries: true,
    // Keep long reasoning turns visibly active instead of hiding every
    // reasoning-summary delta until the first answer token arrives.
    defaultReasoningSummary: "auto",
    supportVerbosity: true,
    defaultVerbosity: "low",
    webSearchToolType: "text_and_image",
    toolMode: "code_mode_only",
    multiAgentVersion,
  };
}

function gpt6ReasoningMetadata(includeNone, includeUltra) {
  // Public API effort support and native Ultra eligibility are separate.
  // Do not reuse codex56Metadata: it also enables model-specific protocols.
  const supportedReasoningLevels = [
    ...(includeNone ? [{ effort: "none", description: "Respond without reasoning" }] : []),
    { effort: "low", description: "Fast responses with lighter reasoning" },
    { effort: "medium", description: "Balances speed and reasoning depth" },
    { effort: "high", description: "Greater reasoning depth for complex problems" },
    { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
    { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
    ...(includeUltra ? [{ effort: "ultra", description: "Automatic task delegation when eligible for your account and client" }] : []),
  ];
  return { defaultReasoningLevel: "medium", supportedReasoningLevels };
}
