import test from "node:test";
import assert from "node:assert/strict";
import {
  createCapabilityProviderRegistry,
  groupCapabilityProviders,
  runCapabilityProxy,
} from "../src/capability-proxy.js";

test("capability proxy runner executes provider, saves result, builds response, and records history", async () => {
  const events = [];
  const ticks = [1000, 1042];

  const result = await runCapabilityProxy({
    capability: "image_generation",
    provider: {
      id: "siliconflow-kolors",
      displayName: "SiliconFlow Kolors",
    },
    request: {
      prompt: "draw a small bridge icon",
      sourceModel: "deepseek-v4-pro",
    },
    context: {
      requestId: "req_capability_proxy",
    },
    clock: () => ticks.shift(),
    execute: async ({ provider, request, context }) => {
      events.push(`execute:${provider.id}:${request.sourceModel}:${context.requestId}`);
      return { imageUrl: "https://images.example/bridge.png" };
    },
    saveResult: async ({ upstream }) => {
      events.push(`save:${upstream.imageUrl}`);
      return { localPath: "C:\\images\\bridge.png", mimeType: "image/png" };
    },
    buildResponse: ({ provider, request, upstream, savedResult, durationMs }) => {
      events.push(`response:${provider.displayName}:${durationMs}`);
      return {
        output_text: `${request.prompt} -> ${savedResult.localPath}`,
        upstream,
      };
    },
    recordHistory: async ({ savedResult, durationMs }) => {
      events.push(`history:${durationMs}`);
      return { id: "img_history_1", localPath: savedResult.localPath };
    },
  });

  assert.equal(result.capability, "image_generation");
  assert.equal(result.providerId, "siliconflow-kolors");
  assert.equal(result.providerName, "SiliconFlow Kolors");
  assert.equal(result.durationMs, 42);
  assert.deepEqual(result.upstream, { imageUrl: "https://images.example/bridge.png" });
  assert.deepEqual(result.savedResult, {
    localPath: "C:\\images\\bridge.png",
    mimeType: "image/png",
  });
  assert.equal(result.response.output_text, "draw a small bridge icon -> C:\\images\\bridge.png");
  assert.deepEqual(result.historyItem, {
    id: "img_history_1",
    localPath: "C:\\images\\bridge.png",
  });
  assert.deepEqual(events, [
    "execute:siliconflow-kolors:deepseek-v4-pro:req_capability_proxy",
    "save:https://images.example/bridge.png",
    "response:SiliconFlow Kolors:42",
    "history:42",
  ]);
});

test("capability proxy runner returns an execution trace for each handled phase", async () => {
  const ticks = [1000, 1001, 1010, 1011, 1020, 1021, 1030, 1031, 1040, 1041, 1050, 1051, 1060];

  const result = await runCapabilityProxy({
    capability: "image_generation",
    providers: [
      { id: "siliconflow-kolors", displayName: "SiliconFlow Kolors" },
    ],
    request: {
      input: "draw a bridge",
      providerId: "siliconflow-kolors",
    },
    clock: () => ticks.shift() ?? 1060,
    detectRequest: ({ request }) => ({ prompt: request.input, providerId: request.providerId }),
    selectProvider: ({ providers, request }) => providers.find((provider) => provider.id === request.providerId),
    execute: async () => ({ imageUrl: "https://images.example/bridge.png" }),
    saveResult: async () => ({ localPath: "C:\\images\\bridge.png" }),
    buildResponse: () => ({ output_text: "saved" }),
    recordHistory: async () => ({ id: "history_1" }),
  });

  assert.deepEqual(
    result.trace.map((item) => `${item.phase}:${item.status}`),
    [
      "detectRequest:ok",
      "selectProvider:ok",
      "execute:ok",
      "saveResult:ok",
      "buildResponse:ok",
      "recordHistory:ok",
    ],
  );
  assert.ok(result.trace.every((item) => Number.isFinite(item.startedAt)));
  assert.ok(result.trace.every((item) => Number.isFinite(item.durationMs)));
  assert.ok(result.trace.every((item) => item.durationMs >= 0));
});

test("capability proxy runner can detect requests and select a provider before execution", async () => {
  const events = [];

  const result = await runCapabilityProxy({
    capability: "image_generation",
    providers: [
      { id: "siliconflow-kolors", displayName: "SiliconFlow Kolors" },
      { id: "zai-glm-image", displayName: "Z.ai GLM Image" },
    ],
    request: {
      input: "画一张桥的图",
      preferredProviderId: "zai-glm-image",
    },
    context: {
      requestId: "req_detect_select",
    },
    detectRequest: async ({ request, context }) => {
      events.push(`detect:${context.requestId}`);
      return {
        prompt: request.input,
        providerId: request.preferredProviderId,
        sourceModel: "kimi-k2-7-code",
      };
    },
    selectProvider: async ({ providers, request }) => {
      events.push(`select:${request.providerId}`);
      return providers.find((provider) => provider.id === request.providerId);
    },
    execute: async ({ provider, request }) => {
      events.push(`execute:${provider.id}:${request.sourceModel}`);
      return { imageUrl: "https://images.example/bridge.png" };
    },
    buildResponse: ({ provider, request }) => {
      events.push(`response:${provider.displayName}:${request.prompt}`);
      return { output_text: provider.displayName };
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.providerId, "zai-glm-image");
  assert.equal(result.providerName, "Z.ai GLM Image");
  assert.equal(result.request.prompt, "画一张桥的图");
  assert.deepEqual(events, [
    "detect:req_detect_select",
    "select:zai-glm-image",
    "execute:zai-glm-image:kimi-k2-7-code",
    "response:Z.ai GLM Image:画一张桥的图",
  ]);
});

test("capability proxy runner can skip requests that are not detected", async () => {
  const result = await runCapabilityProxy({
    capability: "image_generation",
    request: { input: "只是聊一下图片，不要生成" },
    detectRequest: () => ({ handled: false, reason: "not_image_generation" }),
    execute: async () => {
      throw new Error("execute should not run");
    },
    buildResponse: () => {
      throw new Error("response should not be built");
    },
  });

  assert.equal(result.handled, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "not_image_generation");
  assert.equal(result.upstream, null);
  assert.equal(result.response, null);
});

test("capability proxy runner can turn capability failures into structured responses", async () => {
  const events = [];
  const quotaError = new Error("insufficient balance");
  quotaError.statusCode = 402;
  quotaError.code = "insufficient_quota";

  const result = await runCapabilityProxy({
    capability: "image_generation",
    provider: {
      id: "siliconflow-kolors",
      displayName: "SiliconFlow Kolors",
    },
    request: {
      prompt: "draw a bridge",
      sourceModel: "deepseek-v4-pro",
    },
    clock: (() => {
      const ticks = [2000, 2035];
      return () => ticks.shift();
    })(),
    execute: async () => {
      events.push("execute");
      throw quotaError;
    },
    buildResponse: () => {
      throw new Error("success response should not be built");
    },
    buildErrorResponse: ({ provider, error, phase, durationMs }) => {
      events.push(`error-response:${phase}:${durationMs}`);
      return {
        output_text: `${provider.displayName} failed: ${error.message}`,
      };
    },
    recordHistory: async ({ error, response, durationMs }) => {
      events.push(`history:${error.code}:${durationMs}`);
      return {
        id: "failed_capability_1",
        message: response.output_text,
      };
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.failed, true);
  assert.equal(result.errorPhase, "execute");
  assert.equal(result.providerId, "siliconflow-kolors");
  assert.equal(result.error.message, "insufficient balance");
  assert.equal(result.error.statusCode, 402);
  assert.equal(result.error.code, "insufficient_quota");
  assert.equal(result.durationMs, 35);
  assert.equal(result.upstream, null);
  assert.equal(result.savedResult, null);
  assert.equal(result.response.output_text, "SiliconFlow Kolors failed: insufficient balance");
  assert.deepEqual(result.historyItem, {
    id: "failed_capability_1",
    message: "SiliconFlow Kolors failed: insufficient balance",
  });
  assert.deepEqual(events, [
    "execute",
    "error-response:execute:35",
    "history:insufficient_quota:35",
  ]);
});

test("capability proxy runner reports provider selection failures with the failing phase", async () => {
  const result = await runCapabilityProxy({
    capability: "ocr",
    providers: [
      { id: "primary-ocr", displayName: "Primary OCR" },
    ],
    request: {
      providerId: "missing-ocr",
      filePath: "C:\\images\\receipt.png",
    },
    selectProvider: async ({ providers, request }) => providers.find((provider) => provider.id === request.providerId),
    execute: async () => {
      throw new Error("execute should not run");
    },
    buildResponse: () => {
      throw new Error("success response should not be built");
    },
    buildErrorResponse: ({ capability, phase, error }) => ({
      output_text: `${capability} failed at ${phase}: ${error.message}`,
    }),
  });

  assert.equal(result.handled, true);
  assert.equal(result.failed, true);
  assert.equal(result.capability, "ocr");
  assert.equal(result.errorPhase, "selectProvider");
  assert.equal(result.providerId, "");
  assert.equal(result.error.code, "missing_capability_provider");
  assert.match(result.error.message, /没有可用的 OCR 能力供应商/);
  assert.match(result.response.output_text, /ocr failed at selectProvider: 没有可用的 OCR 能力供应商/);
  assert.doesNotMatch(result.response.output_text, /capability provider is not configured/i);
});

test("capability proxy runner requires an executor and response builder", async () => {
  await assert.rejects(
    runCapabilityProxy({
      capability: "image_generation",
      provider: { id: "image-provider" },
      request: { prompt: "draw" },
      buildResponse: () => ({}),
    }),
    /图片生成 能力代理缺少执行器配置/,
  );

  await assert.rejects(
    runCapabilityProxy({
      capability: "image_generation",
      provider: { id: "image-provider" },
      request: { prompt: "draw" },
      execute: async () => ({}),
    }),
    /图片生成 能力代理缺少响应构造器配置/,
  );
});

test("capability provider registry selects explicit, default, and priority providers per capability", () => {
  const registry = createCapabilityProviderRegistry([
    {
      id: "image-default",
      displayName: "Image Default",
      capability: "image_generation",
      default: true,
      priority: 10,
    },
    {
      id: "image-backup",
      displayName: "Image Backup",
      capabilities: ["image_generation", "ocr"],
      priority: 50,
    },
    {
      id: "search-default",
      displayName: "Search Default",
      capability: "web_search",
      priority: 99,
    },
    {
      id: "disabled-image",
      displayName: "Disabled Image",
      capability: "image_generation",
      enabled: false,
      priority: 999,
    },
  ]);

  assert.equal(registry.select("image_generation", { providerId: "image-backup" }).id, "image-backup");
  assert.equal(registry.select("image_generation").id, "image-default");
  assert.equal(registry.select("ocr").id, "image-backup");
  assert.equal(registry.select("web_search").id, "search-default");
  assert.deepEqual(registry.list("image_generation").map((provider) => provider.id), [
    "image-default",
    "image-backup",
  ]);
  assert.equal(registry.byId("disabled-image"), null);
  assert.deepEqual(registry.summary().capabilities, {
    image_generation: 2,
    ocr: 1,
    web_search: 1,
  });
});

test("capability provider registry honors defaults scoped to each capability", () => {
  const registry = createCapabilityProviderRegistry([
    {
      id: "multi-ocr-default",
      displayName: "Multi OCR Default",
      capabilities: ["ocr", "web_search"],
      defaultCapabilities: ["ocr"],
      priority: 5,
    },
    {
      id: "search-default",
      displayName: "Search Default",
      capability: "web_search",
      defaultCapabilities: ["web_search"],
      priority: 1,
    },
    {
      id: "search-backup",
      displayName: "Search Backup",
      capability: "web_search",
      priority: 99,
    },
  ]);

  assert.equal(registry.select("ocr").id, "multi-ocr-default");
  assert.equal(registry.select("web_search").id, "search-default");
  assert.deepEqual(registry.list("web_search").map((provider) => provider.id), [
    "search-default",
    "search-backup",
    "multi-ocr-default",
  ]);

  const groups = registry.groups({
    knownCapabilities: ["ocr", "web_search"],
    includeEmpty: true,
  });
  const byCapability = new Map(groups.map((group) => [group.capability, group]));
  assert.equal(byCapability.get("ocr").defaultProviderId, "multi-ocr-default");
  assert.equal(byCapability.get("web_search").defaultProviderId, "search-default");
});

test("capability provider registry reports missing providers without falling across capabilities", () => {
  const registry = createCapabilityProviderRegistry([
    {
      id: "image-provider",
      displayName: "Image Provider",
      capability: "image_generation",
    },
    {
      id: "ocr-provider",
      displayName: "OCR Provider",
      capability: "ocr",
      enabled: false,
    },
  ]);

  assert.equal(registry.select("ocr"), null);
  assert.equal(registry.select("web_search"), null);
  assert.equal(registry.select("ocr", { providerId: "image-provider" }), null);
  assert.equal(registry.select("image_generation", { providerId: "missing-provider" }), null);
});

test("capability providers are grouped per capability with default backup and disabled counts", () => {
  const groups = groupCapabilityProviders([
    {
      id: "image-default",
      displayName: "Image Default",
      capability: "image_generation",
      default: true,
      priority: 10,
    },
    {
      id: "image-ocr-backup",
      displayName: "Image OCR Backup",
      capabilities: ["image_generation", "ocr"],
      priority: 50,
    },
    {
      id: "browser-provider",
      displayName: "Browser Provider",
      capability: "browser",
      priority: 5,
    },
    {
      id: "disabled-search",
      displayName: "Disabled Search",
      capability: "web_search",
      enabled: false,
    },
  ], {
    knownCapabilities: ["image_generation", "ocr", "web_search", "browser"],
    includeEmpty: true,
    includeDisabled: true,
  });

  const byCapability = new Map(groups.map((group) => [group.capability, group]));

  assert.deepEqual(groups.map((group) => group.capability), [
    "image_generation",
    "ocr",
    "web_search",
    "browser",
  ]);
  assert.equal(byCapability.get("image_generation").defaultProviderId, "image-default");
  assert.deepEqual(byCapability.get("image_generation").providers.map((provider) => provider.id), [
    "image-default",
    "image-ocr-backup",
  ]);
  assert.equal(byCapability.get("image_generation").enabledCount, 2);
  assert.equal(byCapability.get("image_generation").backupCount, 1);
  assert.equal(byCapability.get("ocr").enabledCount, 1);
  assert.equal(byCapability.get("web_search").enabledCount, 0);
  assert.equal(byCapability.get("web_search").disabledCount, 1);
  assert.equal(byCapability.get("browser").providers[0].id, "browser-provider");
});
