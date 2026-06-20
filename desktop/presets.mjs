export const CODEX_MODEL_SLOTS = [
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
  { id: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
  { id: "gpt-5.2", label: "GPT-5.2" },
];

export const PROVIDERS = [
  {
    id: "codex",
    name: "GPT 订阅",
    shortName: "GPT",
    keyEnv: null,
    keyLabel: "使用 Codex/OpenAI 登录态",
    keyUrl: "https://chatgpt.com/codex",
    docsUrl: "https://developers.openai.com/codex",
    baseUrl: "https://api.openai.com/v1",
    authMode: "codex_openai",
    description: "GPT-5.5 / GPT-5.4 走 Codex 订阅，不需要 API Key。",
  },
  {
    id: "fenno",
    name: "GPT API",
    shortName: "GPT API",
    keyEnv: "FENNO_API_KEY",
    keyLabel: "GPT API Key",
    keyUrl: "https://api.fenno.ai",
    docsUrl: "https://api.fenno.ai",
    baseUrl: "https://api.fenno.ai/v1",
    authMode: "api_key",
    description: "OpenAI-compatible GPT 中转或统一接口。",
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
  route("codex-gpt-5-5", "codex", "GPT-5.5", "gpt-5.5", "responses", 1000000),
  route("codex-gpt-5-4", "codex", "GPT-5.4", "gpt-5.4", "responses", 1000000),
  route("codex-gpt-5-4-mini", "codex", "GPT-5.4-Mini", "gpt-5.4-mini", "responses", 1000000),
  route("fenno-gpt-5-5", "fenno", "GPT-5.5 API", "gpt-5.5", "responses", 1000000),
  route("fenno-gpt-5-4", "fenno", "GPT-5.4 API", "gpt-5.4", "responses", 1000000),
  route("fenno-gpt-5-4-mini", "fenno", "GPT-5.4-Mini API", "gpt-5.4-mini", "responses", 1000000),
  route("openai-gpt-4-1", "openai", "OpenAI GPT-4.1", "gpt-4.1", "responses", 1047576),
  route("openai-gpt-4-1-mini", "openai", "OpenAI GPT-4.1 Mini", "gpt-4.1-mini", "responses", 1047576),
  route("deepseek-v4-pro", "deepseek", "DeepSeek V4 Pro", "deepseek-v4-pro", "chat_completions", 1000000, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("deepseek-v4-flash", "deepseek", "DeepSeek V4 Flash", "deepseek-v4-flash", "chat_completions", 1000000, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("deepseek-r1", "deepseek", "DeepSeek R1", "deepseek-reasoner", "chat_completions", 64000, {
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("kimi-k2-7-code", "kimi", "Kimi K2.7 Code", "kimi-k2.7-code", "chat_completions", 258400, {
    rpm: 6,
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("kimi-k2-6", "kimi", "Kimi K2.6", "kimi-k2.6", "chat_completions", 258400, {
    rpm: 6,
    dropParams: ["response_format", "parallel_tool_calls"],
  }),
  route("qwen3-coder-plus", "qwen", "Qwen3 Coder Plus", "qwen3-coder-plus", "chat_completions", 258400, {
    dropParams: ["parallel_tool_calls"],
  }),
  route("qwen-plus", "qwen", "Qwen Plus", "qwen-plus", "chat_completions", 128000, {
    dropParams: ["parallel_tool_calls"],
  }),
  route("qwen-max", "qwen", "Qwen Max", "qwen-max", "chat_completions", 128000, {
    dropParams: ["parallel_tool_calls"],
  }),
  route("glm-4-6", "zhipu", "GLM-4.6", "glm-4.6", "chat_completions", 128000, {
    dropParams: ["parallel_tool_calls"],
  }),
  route("openrouter-sonnet", "openrouter", "OpenRouter Claude Sonnet", "anthropic/claude-sonnet-4.5", "chat_completions", 200000, {
    dropParams: ["parallel_tool_calls"],
  }),
  route("siliconflow-qwen3-coder", "siliconflow", "SiliconFlow Qwen3 Coder", "Qwen/Qwen3-Coder-480B-A35B-Instruct", "chat_completions", 262144, {
    dropParams: ["parallel_tool_calls"],
  }),
];

export function defaultSelectedModelIds(mode) {
  if (mode === "all_api") {
    return [
      "fenno-gpt-5-5",
      "fenno-gpt-5-4",
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
