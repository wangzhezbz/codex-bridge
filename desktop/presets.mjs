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
    description: "GPT-5.5 / GPT-5.4 走 Codex 订阅，不需要 API Key。",
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
    id: "deepseek",
    name: "DeepSeek",
    shortName: "DeepSeek",
    keyEnv: "DEEPSEEK_API_KEY",
    keyLabel: "DeepSeek API Key",
    keyUrl: "https://platform.deepseek.com/api_keys",
    docsUrl: "https://api-docs.deepseek.com/",
    baseUrl: "https://api.deepseek.com/v1",
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
    docsUrl: "https://www.kimi.com/code/docs/en/",
    baseUrl: "https://api.moonshot.cn/v1",
    authMode: "api_key",
    description: "Kimi / Moonshot Open Platform。",
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
    baseUrl: "https://api.baiduqianfan.ai/v1",
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
  route("codex-gpt-5-5", "codex", "GPT-5.5", "gpt-5.5", "responses", 258400, imageInput(codexFastMode())),
  route("codex-gpt-5-4", "codex", "GPT-5.4", "gpt-5.4", "responses", 258400, imageInput(codexFastMode())),
  route("codex-gpt-5-4-mini", "codex", "GPT-5.4-Mini", "gpt-5.4-mini", "responses", 258400, imageInput()),
  route("openai-gpt-4-1", "openai", "OpenAI GPT-4.1", "gpt-4.1", "responses", 1047576, imageInput()),
  route("openai-gpt-4-1-mini", "openai", "OpenAI GPT-4.1 Mini", "gpt-4.1-mini", "responses", 1047576, imageInput()),
  route("deepseek-v4-pro", "deepseek", "DeepSeek V4 Pro", "deepseek-v4-pro", "chat_completions", 1000000, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("deepseek-v4-flash", "deepseek", "DeepSeek V4 Flash", "deepseek-v4-flash", "chat_completions", 1000000, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("deepseek-r1", "deepseek", "DeepSeek R1", "deepseek-reasoner", "chat_completions", 64000, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("kimi-k2-7-code", "kimi", "Kimi K2.7 Code", "kimi-k2.7-code", "chat_completions", 258400, imageInput({
    rpm: 12,
    dropParams: ["response_format", "parallel_tool_calls"],
  })),
  route("kimi-k2-6", "kimi", "Kimi K2.6", "kimi-k2.6", "chat_completions", 258400, imageInput({
    rpm: 12,
    dropParams: ["response_format", "parallel_tool_calls"],
  })),
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
];

export function defaultSelectedModelIds(mode) {
  if (mode === "all_api") {
    return [
      "openai-gpt-4-1",
      "openai-gpt-4-1-mini",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "kimi-k2-7-code",
    ];
  }
  return [
    "codex-gpt-5-5",
    "codex-gpt-5-4",
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
