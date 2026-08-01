import test from "node:test";
import assert from "node:assert/strict";
import {
  __resetRateLimiterForTests,
  __setRateLimitClockForTests,
  markRouteRateLimited,
} from "../src/rate-limit.js";
import {
  selectFailoverRoute,
  selectRouteForRequest,
} from "../src/smart-routing.js";

const baseConfig = {
  defaultModel: "cb-chat",
  models: [
    {
      id: "cb-chat",
      displayName: "Qwen Chat",
      provider: "qwen",
      api: "chat_completions",
      model: "qwen-plus",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "qwen-key",
      contextWindow: 128000,
    },
    {
      id: "cb-code",
      displayName: "GPT Code",
      provider: "openai",
      api: "responses",
      model: "gpt-5.5",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "gpt-key",
      contextWindow: 258400,
    },
    {
      id: "cb-long",
      displayName: "Kimi Long Context",
      provider: "kimi",
      api: "chat_completions",
      model: "kimi-k2.7-code",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "kimi-key",
      contextWindow: 1000000,
    },
  ],
};

test("selectRouteForRequest keeps manual routing when auto select is absent or disabled", () => {
  const result = selectRouteForRequest(baseConfig, {
    model: "cb-chat",
    input: "请写一个 Python 函数",
  });

  assert.equal(result.route.id, "cb-chat");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "manual_route");
});

test("selectRouteForRequest picks a code route only when auto select is explicitly enabled", () => {
  const result = selectRouteForRequest({
    ...baseConfig,
    smartRouting: { autoSelectModel: true, autoFailover: false },
  }, {
    model: "cb-chat",
    input: "请写一个 Python 函数，读取 JSON 文件并输出统计结果",
  });

  assert.equal(result.route.id, "cb-code");
  assert.equal(result.changed, true);
  assert.equal(result.reason, "code_task");
  assert.equal(result.originalRoute.id, "cb-chat");
});

test("selectRouteForRequest keeps the selected code route when it is already the best code candidate", () => {
  const result = selectRouteForRequest({
    ...baseConfig,
    smartRouting: { autoSelectModel: true, autoFailover: false },
  }, {
    model: "cb-code",
    input: "write a TypeScript function",
  });

  assert.equal(result.route.id, "cb-code");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "code_task");
});

test("selectRouteForRequest recognizes Chinese coding tasks without English keywords", () => {
  const result = selectRouteForRequest({
    ...baseConfig,
    smartRouting: { autoSelectModel: true },
  }, {
    model: "cb-chat",
    input: "帮我写一个函数，调试接口报错并重构组件",
  });

  assert.equal(result.route.id, "cb-code");
  assert.equal(result.changed, true);
  assert.equal(result.reason, "code_task");
});

test("selectRouteForRequest skips disabled smart route candidates", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = { autoSelectModel: true };
  config.models[1].enabled = false;
  config.models[2].enabled = false;

  const result = selectRouteForRequest(config, {
    model: "cb-chat",
    input: "write a TypeScript function",
  });

  assert.equal(result.route.id, "cb-chat");
  assert.equal(result.changed, false);
});

test("selectRouteForRequest skips unauthenticated automatic candidates", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = { autoSelectModel: true };
  delete config.models[1].apiKey;
  delete config.models[1].apiKeyEnv;
  delete config.models[2].apiKey;
  delete config.models[2].apiKeyEnv;

  const result = selectRouteForRequest(config, {
    model: "cb-chat",
    input: "write a TypeScript function",
  });

  assert.equal(result.route.id, "cb-chat");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "manual_route");
});

test("selectRouteForRequest skips unhealthy automatic candidates", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = { autoSelectModel: true };
  config.models = config.models.slice(0, 2);

  const result = selectRouteForRequest({
    ...config,
  }, {
    model: "cb-chat",
    input: "write a TypeScript function",
  }, {
    unhealthyRouteIds: ["cb-code"],
  });

  assert.equal(result.route.id, "cb-chat");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "manual_route");
});

test("selectRouteForRequest prefers the largest context route for very long prompts", () => {
  const result = selectRouteForRequest({
    ...baseConfig,
    smartRouting: { autoSelectModel: true },
  }, {
    model: "cb-chat",
    input: "总结下面的超长材料：\n" + "资料片段 ".repeat(12000),
  });

  assert.equal(result.route.id, "cb-long");
  assert.equal(result.changed, true);
  assert.equal(result.reason, "long_context_task");
});

test("selectRouteForRequest does not downgrade context on continuing requests", () => {
  const result = selectRouteForRequest({
    ...baseConfig,
    smartRouting: { autoSelectModel: true },
  }, {
    model: "cb-long",
    previous_response_id: "resp_long_context",
    input: "write a TypeScript function",
  });

  assert.equal(result.route.id, "cb-long");
  assert.equal(result.changed, false);
});

test("selectRouteForRequest keeps an unknown-window continuation on its original route", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = { autoSelectModel: true };
  delete config.models[2].contextWindow;

  const result = selectRouteForRequest(config, {
    model: "cb-long",
    previous_response_id: "resp_unknown_context",
    input: "write a TypeScript function",
  });

  assert.equal(result.route.id, "cb-long");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "manual_route");
});

test("selectRouteForRequest ranks long-context candidates by the shared context policy", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = { autoSelectModel: true };
  config.models[2].catalogContextWindow = 64_000;

  const result = selectRouteForRequest(config, {
    model: "cb-chat",
    input: "long material ".repeat(5_000),
  });

  assert.equal(result.route.id, "cb-code");
  assert.equal(result.reason, "long_context_task");
});

test("selectRouteForRequest keeps explicit long coding tasks on the code route", () => {
  const result = selectRouteForRequest({
    ...baseConfig,
    smartRouting: { autoSelectModel: true },
  }, {
    model: "cb-chat",
    input: "请写一个 TypeScript 调试脚本，分析下面这份超长日志并输出 JSON：\n" +
      "日志片段 ".repeat(12000),
  });

  assert.equal(result.route.id, "cb-code");
  assert.equal(result.changed, true);
  assert.equal(result.reason, "code_task");
});

test("selectRouteForRequest sends ordinary chat back to the default chat route when auto select is enabled", () => {
  const result = selectRouteForRequest({
    ...baseConfig,
    smartRouting: { autoSelectModel: true },
  }, {
    model: "cb-code",
    input: "你好，帮我简单解释一下今天的安排。",
  });

  assert.equal(result.route.id, "cb-chat");
  assert.equal(result.changed, true);
  assert.equal(result.reason, "ordinary_chat");
  assert.equal(result.originalRoute.id, "cb-code");
});

test("selectRouteForRequest picks the cheapest priced ordinary chat route when auto select is enabled", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = { autoSelectModel: true };
  config.models.push(
    {
      id: "cb-cheap-chat",
      displayName: "Budget Chat",
      provider: "deepseek",
      api: "chat_completions",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "deepseek-key",
    },
    {
      id: "cb-cheap-code",
      displayName: "Budget Coder",
      provider: "deepseek",
      api: "chat_completions",
      model: "deepseek-coder",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "deepseek-key",
    },
  );
  config.usageBudgets = {
    routes: {
      "cb-chat": { inputCostPerMillion: 2, outputCostPerMillion: 6 },
      "cb-cheap-chat": { inputCostPerMillion: 0.2, outputCostPerMillion: 0.8 },
      "cb-cheap-code": { inputCostPerMillion: 0.1, outputCostPerMillion: 0.2 },
    },
  };

  const result = selectRouteForRequest(config, {
    model: "cb-code",
    input: "你好，帮我把这句话说得更自然一点。",
  });

  assert.equal(result.route.id, "cb-cheap-chat");
  assert.equal(result.changed, true);
  assert.equal(result.reason, "ordinary_chat_low_cost");
  assert.equal(result.originalRoute.id, "cb-code");
});

test("selectRouteForRequest sends explicit image generation tasks to a model with image proxy", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = { autoSelectModel: true };
  config.models.push({
    id: "cb-image",
    displayName: "DeepSeek Image Proxy",
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "deepseek-key",
    imageGeneration: {
      mode: "custom",
      baseUrl: "https://images.example/v1",
      endpoint: "/images/generations",
      model: "image-model",
      apiKey: "image-key",
    },
  });

  const result = selectRouteForRequest(config, {
    model: "cb-chat",
    input: "帮我画一只小猫",
  });

  assert.equal(result.route.id, "cb-image");
  assert.equal(result.changed, true);
  assert.equal(result.reason, "image_generation_task");
  assert.equal(result.originalRoute.id, "cb-chat");
});

test("selectRouteForRequest lets explicit image generation outrank code keywords", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = { autoSelectModel: true };
  config.models.push({
    id: "cb-image",
    displayName: "DeepSeek Image Proxy",
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "deepseek-key",
    imageGeneration: {
      mode: "custom",
      baseUrl: "https://images.example/v1",
      endpoint: "/images/generations",
      model: "image-model",
      apiKey: "image-key",
    },
  });

  const result = selectRouteForRequest(config, {
    model: "cb-chat",
    input: "请生成一张 Python 代码雨风格的海报，赛博朋克配色",
  });

  assert.equal(result.route.id, "cb-image");
  assert.equal(result.changed, true);
  assert.equal(result.reason, "image_generation_task");
});

test("selectRouteForRequest honors a configured code task route", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = {
    autoSelectModel: true,
    autoSelectRules: {
      code: { mode: "route", routeId: "cb-long" },
    },
  };

  const result = selectRouteForRequest(config, {
    model: "cb-chat",
    input: "write a TypeScript refactor plan",
  });

  assert.equal(result.route.id, "cb-long");
  assert.equal(result.changed, true);
  assert.equal(result.reason, "code_task_configured");
});

test("selectRouteForRequest can disable one automatic task rule", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = {
    autoSelectModel: true,
    autoSelectRules: {
      code: { mode: "off" },
    },
  };

  const result = selectRouteForRequest(config, {
    model: "cb-chat",
    input: "write a TypeScript function",
  });

  assert.equal(result.route.id, "cb-chat");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "manual_route");
});

test("selectRouteForRequest falls back to automatic matching when a configured route is unusable", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = {
    autoSelectModel: true,
    autoSelectRules: {
      code: { mode: "route", routeId: "cb-long" },
    },
  };
  delete config.models[2].apiKey;
  delete config.models[2].apiKeyEnv;

  const result = selectRouteForRequest(config, {
    model: "cb-chat",
    input: "write a TypeScript function",
  });

  assert.equal(result.route.id, "cb-code");
  assert.equal(result.changed, true);
  assert.equal(result.reason, "code_task");
});

test("selectRouteForRequest honors configured routes for long context and ordinary chat", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = {
    autoSelectModel: true,
    autoSelectRules: {
      longContext: { mode: "route", routeId: "cb-code" },
      ordinaryChat: { mode: "route", routeId: "cb-long" },
    },
  };

  const longContext = selectRouteForRequest(config, {
    model: "cb-chat",
    input: "summarize this long material\n" + "data ".repeat(12000),
  });
  const chat = selectRouteForRequest(config, {
    model: "cb-code",
    input: "hello, help me rewrite this sentence",
  });

  assert.equal(longContext.route.id, "cb-code");
  assert.equal(longContext.reason, "long_context_task_configured");
  assert.equal(chat.route.id, "cb-long");
  assert.equal(chat.reason, "ordinary_chat_configured");
});

test("selectRouteForRequest honors configured image generation route and image task off switch", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = {
    autoSelectModel: true,
    autoSelectRules: {
      imageGeneration: { mode: "route", routeId: "cb-image" },
    },
  };
  config.models.push({
    id: "cb-image",
    displayName: "Image Proxy",
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "deepseek-key",
    imageGeneration: {
      mode: "custom",
      baseUrl: "https://images.example/v1",
      endpoint: "/images/generations",
      model: "image-model",
      apiKey: "image-key",
    },
  });

  const routed = selectRouteForRequest(config, {
    model: "cb-chat",
    input: "generate an image of a cat",
  });
  config.smartRouting.autoSelectRules.imageGeneration = { mode: "off" };
  const disabled = selectRouteForRequest(config, {
    model: "cb-chat",
    input: "generate an image of a cat",
  });

  assert.equal(routed.route.id, "cb-image");
  assert.equal(routed.reason, "image_generation_task_configured");
  assert.equal(disabled.route.id, "cb-chat");
  assert.equal(disabled.reason, "manual_route");
});

test("selectFailoverRoute stays empty when failover is disabled", () => {
  const result = selectFailoverRoute(baseConfig, baseConfig.models[0], {
    statusCode: 429,
    message: "rate limited",
  });

  assert.equal(result, null);
});

test("selectFailoverRoute chooses a compatible backup for retryable provider errors when enabled", () => {
  const result = selectFailoverRoute({
    ...baseConfig,
    smartRouting: { autoFailover: true },
  }, baseConfig.models[0], {
    statusCode: 429,
    message: "rate limited",
  });

  assert.equal(result.route.id, "cb-long");
  assert.equal(result.reason, "rate_limited");
  assert.equal(result.originalRoute.id, "cb-chat");
});

test("selectFailoverRoute distinguishes ChatGPT subscription exhaustion from request rate limiting", () => {
  const result = selectFailoverRoute({
    ...baseConfig,
    smartRouting: { autoFailover: true },
  }, baseConfig.models[0], {
    statusCode: 429,
    message: "Upstream returned HTTP 429",
    bodyText: JSON.stringify({ detail: "The usage limit has been reached" }),
  });

  assert.equal(result.route.id, "cb-long");
  assert.equal(result.reason, "quota_or_balance");
});

test("selectFailoverRoute does not downgrade long-context routes to smaller backups", () => {
  const result = selectFailoverRoute({
    ...baseConfig,
    smartRouting: { autoFailover: true },
  }, baseConfig.models[2], {
    statusCode: 502,
    message: "bad gateway",
  });

  assert.equal(result, null);
});

test("selectFailoverRoute rejects a backup whose context window is unknown", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = { autoFailover: true };
  config.models = [config.models[0], config.models[2]];
  delete config.models[1].contextWindow;

  const result = selectFailoverRoute(config, config.models[0], {
    statusCode: 502,
    message: "bad gateway",
  });

  assert.equal(result, null);
});

test("selectFailoverRoute keeps an unknown-window current route instead of guessing a floor", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = { autoFailover: true };
  config.models = [config.models[2], config.models[1]];
  delete config.models[0].contextWindow;

  const result = selectFailoverRoute(config, config.models[0], {
    statusCode: 502,
    message: "bad gateway",
  });

  assert.equal(result, null);
});

test("selectFailoverRoute applies catalog context caps before accepting a backup", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = { autoFailover: true };
  config.models = [config.models[0], config.models[2]];
  config.models[1].catalogContextWindow = 64_000;

  const result = selectFailoverRoute(config, config.models[0], {
    statusCode: 502,
    message: "bad gateway",
  });

  assert.equal(result, null);
});

test("selectFailoverRoute skips unauthenticated backup routes", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = { autoFailover: true };
  delete config.models[2].apiKey;
  delete config.models[2].apiKeyEnv;
  config.models.push({
    id: "cb-backup",
    displayName: "Backup Chat",
    provider: "deepseek",
    api: "chat_completions",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "deepseek-key",
    contextWindow: 128000,
  });

  const result = selectFailoverRoute(config, config.models[0], {
    statusCode: 429,
    message: "rate limited",
  });

  assert.equal(result.route.id, "cb-backup");
  assert.equal(result.reason, "rate_limited");
});

test("selectFailoverRoute prefers a different provider for provider-level limits", () => {
  const config = {
    smartRouting: { autoFailover: true },
    models: [
      {
        id: "kimi-main",
        displayName: "Kimi Main",
        provider: "kimi",
        api: "chat_completions",
        model: "kimi-k2.7-code",
        baseUrl: "https://api.moonshot.cn/v1",
        apiKey: "kimi-key",
        contextWindow: 258400,
      },
      {
        id: "kimi-backup",
        displayName: "Kimi Backup",
        provider: "kimi",
        api: "chat_completions",
        model: "kimi-latest",
        baseUrl: "https://api.moonshot.cn/v1",
        apiKey: "kimi-key",
        contextWindow: 258400,
      },
      {
        id: "deepseek-backup",
        displayName: "DeepSeek Backup",
        provider: "deepseek",
        api: "chat_completions",
        model: "deepseek-v4-pro",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "deepseek-key",
        contextWindow: 258400,
      },
    ],
  };

  const result = selectFailoverRoute(config, config.models[0], {
    statusCode: 429,
    message: "provider rate limited",
  });

  assert.equal(result.route.id, "deepseek-backup");
  assert.equal(result.reason, "rate_limited");
  assert.equal(result.originalRoute.id, "kimi-main");
});

test("selectFailoverRoute honors a configured backup order", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = {
    autoFailover: true,
    failover: {
      mode: "ordered",
      routeIds: ["cb-code", "cb-long"],
    },
  };

  const result = selectFailoverRoute(config, config.models[0], {
    statusCode: 502,
    message: "bad gateway",
  });

  assert.equal(result.route.id, "cb-code");
  assert.equal(result.reason, "upstream_unavailable");
});

test("selectFailoverRoute skips unusable configured backups and can be disabled independently", () => {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.smartRouting = {
    autoFailover: true,
    failover: {
      mode: "ordered",
      routeIds: ["cb-long", "cb-code"],
    },
  };
  delete config.models[2].apiKey;
  delete config.models[2].apiKeyEnv;

  const result = selectFailoverRoute(config, config.models[0], {
    statusCode: 502,
    message: "bad gateway",
  });
  config.smartRouting.failover = { mode: "off", routeIds: ["cb-code"] };
  const disabled = selectFailoverRoute(config, config.models[0], {
    statusCode: 502,
    message: "bad gateway",
  });

  assert.equal(result.route.id, "cb-code");
  assert.equal(disabled, null);
});

test("selectFailoverRoute chooses the cheaper priced compatible backup when several are available", () => {
  const config = {
    smartRouting: { autoFailover: true },
    usageBudgets: {
      routes: {
        "deepseek-expensive": { inputCostPerMillion: 2, outputCostPerMillion: 8 },
        "qwen-cheap": { inputCostPerMillion: 0.1, outputCostPerMillion: 0.4 },
      },
    },
    models: [
      {
        id: "kimi-main",
        displayName: "Kimi Main",
        provider: "kimi",
        api: "chat_completions",
        model: "kimi-k2.7-code",
        baseUrl: "https://api.moonshot.cn/v1",
        apiKey: "kimi-key",
        contextWindow: 258400,
      },
      {
        id: "deepseek-expensive",
        displayName: "DeepSeek Expensive Backup",
        provider: "deepseek",
        api: "chat_completions",
        model: "deepseek-v4-pro",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "deepseek-key",
        contextWindow: 258400,
      },
      {
        id: "qwen-cheap",
        displayName: "Qwen Cheap Backup",
        provider: "qwen",
        api: "chat_completions",
        model: "qwen-plus",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey: "qwen-key",
        contextWindow: 258400,
      },
    ],
  };

  const result = selectFailoverRoute(config, config.models[0], {
    statusCode: 429,
    message: "provider rate limited",
  });

  assert.equal(result.route.id, "qwen-cheap");
  assert.equal(result.reason, "rate_limited");
  assert.equal(result.originalRoute.id, "kimi-main");
});

test("selectFailoverRoute skips backup routes that are in local cooldown", () => {
  __resetRateLimiterForTests();
  __setRateLimitClockForTests({
    now: () => 1_000,
    sleep: async () => {},
  });
  try {
    const config = {
      smartRouting: { autoFailover: true },
      models: [
        {
          id: "qwen-main",
          provider: "qwen",
          api: "chat_completions",
          model: "qwen-plus",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          apiKey: "qwen-key",
          contextWindow: 258400,
        },
        {
          id: "deepseek-cooling",
          provider: "deepseek",
          api: "chat_completions",
          model: "deepseek-v4-pro",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "deepseek-key",
          localRateLimitEnabled: true,
          contextWindow: 258400,
        },
        {
          id: "kimi-ready",
          provider: "kimi",
          api: "chat_completions",
          model: "kimi-k2.7-code",
          baseUrl: "https://api.moonshot.cn/v1",
          apiKey: "kimi-key",
          contextWindow: 258400,
        },
      ],
    };
    markRouteRateLimited(config.models[1], { "retry-after": "60" });

    const result = selectFailoverRoute(config, config.models[0], {
      statusCode: 502,
      message: "bad gateway",
    });

    assert.equal(result.route.id, "kimi-ready");
    assert.equal(result.reason, "upstream_unavailable");
  } finally {
    __resetRateLimiterForTests();
  }
});
