function normalizeModeSelectionResult(result) {
  const wrapped = result && typeof result === "object" && result.state && typeof result.state === "object";
  return {
    state: wrapped ? result.state : result,
    transaction: wrapped && result.transaction && typeof result.transaction === "object"
      ? result.transaction
      : null,
  };
}

function modeSwitchToastMessage(transaction) {
  if (!transaction?.restartRequired) {
    return "计费模式已切换，模型列表已按该模式更新。";
  }
  const prefix = transaction.routerVerified
    ? "模式已切换且Router已确认；"
    : "模式已切换，配置已原子写入（Router当前未运行）；";
  return transaction.restartAvailable
    ? `${prefix}请点击“重启 ChatGPT / Codex”使鉴权生效。`
    : `${prefix}未定位到 ChatGPT / Codex 启动项，请完全退出 ChatGPT / Codex 后重新打开，使鉴权生效。`;
}

function resourceReadStatusAvailable(readStatus) {
  if (!readStatus || typeof readStatus !== "object") {
    return true;
  }
  const readState = String(readStatus.state || "").trim().toLowerCase();
  return readStatus.ok !== false && (!readState || readState === "ok");
}

function resourceSummaryReadStatus(resources = {}, key = "") {
  const readStatus = resources?.readStatus?.[key];
  const value = resources?.summary?.[key];
  const count = Number(value);
  if (
    !resourceReadStatusAvailable(readStatus) ||
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.trim()) ||
    !Number.isFinite(count) ||
    count < 0
  ) {
    return readStatus && !resourceReadStatusAvailable(readStatus)
      ? readStatus
      : { ok: false, state: "unavailable", code: "summary_unavailable" };
  }
  return readStatus || null;
}

function resourceSummaryCount(resources = {}, key = "") {
  const value = resources?.summary?.[key];
  if (!resourceReadStatusAvailable(resourceSummaryReadStatus(resources, key))) {
    return null;
  }
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

function resourceSummaryDisplay(resources = {}, key = "") {
  const count = resourceSummaryCount(resources, key);
  return count === null ? "无法读取" : formatNumber(count);
}

function codexResourceReadStatusFrom(source = {}) {
  const keys = ["plugins", "mcpServers", "skills", "marketplaces"];
  const candidates = [
    source?.codexResourceReadStatus,
    source?.codexResourcesReadStatus,
    source?.resourceReadStatus,
    source?.codexResources?.readStatus,
    source?.readStatus,
  ];
  return candidates.find((candidate) => (
    candidate &&
    typeof candidate === "object" &&
    keys.some((key) => Object.prototype.hasOwnProperty.call(candidate, key))
  )) || null;
}

function codexResourceCountLabel(source = {}, suffix = "") {
  const readStatus = codexResourceReadStatusFrom(source);
  if (
    readStatus &&
    ["plugins", "mcpServers", "skills", "marketplaces"]
      .some((key) => readStatus[key] && !resourceReadStatusAvailable(readStatus[key]))
  ) {
    return "无法读取";
  }
  const value = source?.codexResourceCount;
  if (value === null || value === undefined || value === "") {
    return "未知";
  }
  const count = Number(value);
  return Number.isFinite(count) && count >= 0
    ? `${formatNumber(count)}${suffix}`
    : "未知";
}

let state = null;
let refreshRequestSequence = 0;
let historyRecoveryActionSequence = 0;
const STATE_UNAVAILABLE_WRITE_MESSAGE = "状态暂不可用：当前显示的是上次快照，写入操作已锁定。请刷新恢复后再试。";
const STATE_UNAVAILABLE_READ_ONLY_API_METHODS = new Set([
  "getState",
  "getDoubleQuotaState",
  "runStartupCheck",
  "copyDiagnostics",
  "saveDiagnostics",
  "saveAcceptanceReport",
  "saveReleaseGateReport",
  "previewHistoryRecovery",
  "historyRecoveryStatus",
  "copyText",
  "openFolder",
  "revealFile",
  "openExternal",
  "openGitHub",
  "onLogs",
  "onState",
  "onUsage",
  "onUpdateProgress",
  "onUpdateFinished",
  "onNavigate",
]);
const STATE_UNAVAILABLE_READ_ONLY_CONTROL_SELECTOR = [
  ".nav-item",
  "#refreshResources",
  "#runStartupCheck",
  "#copyPreflightDiagnostics",
  "#savePreflightDiagnostics",
  "#copyResourceDiagnostics",
  "#copyDiagnostics",
  "#openConfigFolder",
  "#openUpdateFolder",
  "#openGitHub",
  "#resourceSearch",
  "#resourceStatusFilter",
  "#resourceSourceFilter",
  "#sessionSearch",
  "#clearSessionSearch",
  "#capabilityHistorySearch",
  "#capabilityHistoryFilter",
  "#imageHistorySearch",
  "#imageHistoryFilter",
  "#closeRequestDetail",
  "#closeResourceDetail",
  "#closeVvipDialog",
  "#cancelUpdate",
  "#cancelCustomEdit",
  "#resetCapabilityProviderForm",
  "#resetImageProviderForm",
  "[data-state-unavailable-readonly]",
  "[data-usage-range]",
  "[data-usage-col]",
  "[data-request-detail]",
  "[data-resource-detail]",
  "[data-resource-expand]",
  "[data-resource-copy]",
  "[data-resource-copy-diagnostic]",
  "[data-resource-open]",
  "[data-open-project-folder]",
  "[data-open-session-folder]",
  "[data-open-url]",
  "[data-image-history-open]",
  "[data-image-history-reveal]",
  "[data-capability-history-open]",
  "[data-capability-history-reveal]",
  "[data-capability-run-open]",
  "[data-capability-run-reveal]",
  "[data-image-provider-test-open]",
  "[data-image-provider-test-reveal]",
  "[data-confirm-cancel]",
  "[data-back-model-catalog]",
  "[data-session-project]",
  "[data-vvip-feature]",
].join(", ");
const STATE_UNAVAILABLE_INTERACTIVE_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "form",
  "[draggable='true']",
  "[data-slot-index]",
].join(", ");

function stateUnavailableWritesLocked(currentState = state) {
  return Boolean(currentState?.stateUnavailable);
}

function stateUnavailableWriteError() {
  const error = new Error(STATE_UNAVAILABLE_WRITE_MESSAGE);
  error.code = "state_unavailable_write_locked";
  return error;
}

function createStateUnavailableGuardedApi(bridge, getCurrentState) {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      const value = Reflect.get(bridge, property, bridge);
      if (typeof value !== "function") {
        return value;
      }
      return (...args) => {
        const unavailable = stateUnavailableWritesLocked(getCurrentState?.());
        if (unavailable && !STATE_UNAVAILABLE_READ_ONLY_API_METHODS.has(String(property))) {
          throw stateUnavailableWriteError();
        }
        return Reflect.apply(value, bridge, args);
      };
    },
  });
}

function stateUnavailableControlIsReadOnly(control) {
  try {
    return Boolean(control?.matches?.(STATE_UNAVAILABLE_READ_ONLY_CONTROL_SELECTOR));
  } catch {
    return false;
  }
}

function applyStateUnavailableWriteGuard(root = document, locked = stateUnavailableWritesLocked()) {
  const controls = root?.querySelectorAll?.(
    "button, input, select, textarea, [draggable='true'], [data-state-unavailable-locked], [data-state-unavailable-draggable]",
  ) || [];
  for (const control of controls) {
    if (!locked) {
      const guardedDisabled = control.dataset?.stateUnavailableLocked === "true";
      const guardedDraggable = control.dataset?.stateUnavailableDraggable === "true";
      if (guardedDisabled) {
        control.disabled = false;
        delete control.dataset.stateUnavailableLocked;
      }
      if (guardedDraggable) {
        control.draggable = true;
        control.setAttribute?.("draggable", "true");
        delete control.dataset.stateUnavailableDraggable;
      }
      if (guardedDisabled || guardedDraggable) {
        control.classList?.remove("state-unavailable-locked");
        control.removeAttribute?.("aria-disabled");
      }
      continue;
    }
    if (stateUnavailableControlIsReadOnly(control)) {
      continue;
    }
    let changed = false;
    if ("disabled" in control && !control.disabled) {
      control.disabled = true;
      control.dataset.stateUnavailableLocked = "true";
      changed = true;
    }
    if (control.draggable === true) {
      control.draggable = false;
      control.setAttribute?.("draggable", "false");
      control.dataset.stateUnavailableDraggable = "true";
      changed = true;
    }
    if (changed) {
      control.classList?.add("state-unavailable-locked");
      control.setAttribute?.("aria-disabled", "true");
    }
  }
}

function stateUnavailableControlEventGuard(event, currentState = state) {
  if (!stateUnavailableWritesLocked(currentState)) {
    return false;
  }
  const control = event?.target?.closest?.(STATE_UNAVAILABLE_INTERACTIVE_SELECTOR);
  if (!control || stateUnavailableControlIsReadOnly(control)) {
    return false;
  }
  event.preventDefault?.();
  event.stopImmediatePropagation?.();
  return true;
}

const api = createStateUnavailableGuardedApi(window.codexBridge, () => state);
let draftSelection = [];
let dragSlotIndex = null;
let editingCustomPresetId = null;
let activeProviderId = null;
let usageRangeDays = 7;
let modelPageView = "catalog";
let editingProviderId = null;
let customReturnView = "catalog";
let scopedCustomProviderId = null;
let usageResizeState = null;
let usageColumnCssRules = null;
let resourceFilterText = "";
let resourceStatusFilter = "all";
let resourceSourceFilter = "all";
let imageHistorySearchText = "";
let imageHistoryFilter = "all";
let capabilityHistorySearchText = "";
let capabilityHistoryFilter = "all";
let lastProjectRecoveryResult = null;
let historyRecoveryStatus = null;
let doubleQuotaState = null;
let sessionSearchText = "";
let stateDetailLoaded = false;
let stateDetailLoading = false;
let settingsDetailLoaded = false;
let settingsDetailLoading = false;
const resourceExpandedKeys = new Set();
const resourceDetailItems = new Map();
const DETAIL_STATE_SECTIONS = new Set(["preflight", "capabilities", "resources", "sessions"]);
const SETTINGS_DETAIL_SECTIONS = new Set(["settings"]);
const LOCAL_CAPABILITY_ADAPTERS = new Set(["local_browser", "local_computer_use", "local_file"]);
const LOCAL_CAPABILITY_HINT = "本地能力不需要 Base URL、Endpoint、模型名或 API Key；保存后由 CodexBridge 桌面端受控执行。";
const usageColumnWidths = [168, 190, 128, 84, 112, 112, 112, 112, 176, 168];
const SMART_ROUTING_RULE_CONTROLS = [
  { key: "code", mode: "smartCodeMode", route: "smartCodeRoute" },
  { key: "longContext", mode: "smartLongContextMode", route: "smartLongContextRoute" },
  { key: "imageGeneration", mode: "smartImageGenerationMode", route: "smartImageGenerationRoute" },
  { key: "ordinaryChat", mode: "smartOrdinaryChatMode", route: "smartOrdinaryChatRoute" },
];
const SMART_ROUTING_ROUTE_CONTROLS = [
  "smartFailoverRoute1",
  "smartFailoverRoute2",
  "smartFailoverRoute3",
];
const CAPABILITY_RUN_PRESETS = [
  {
    id: "browser-open-url",
    label: "打开网页",
    adapters: ["local_browser"],
    input: { action: "open_url", url: "https://example.com" },
  },
  {
    id: "browser-read-url",
    label: "读取网页",
    adapters: ["local_browser"],
    input: { action: "read_url", url: "https://example.com" },
  },
  {
    id: "browser-screenshot-url",
    label: "网页截图",
    adapters: ["local_browser"],
    capabilities: ["webpage_screenshot"],
    input: { action: "screenshot_url", url: "https://example.com", viewport: "desktop", fullPage: true },
  },
  {
    id: "computer-list-apps",
    label: "查看白名单",
    adapters: ["local_computer_use"],
    input: { action: "list_apps" },
  },
  {
    id: "computer-open-notepad",
    label: "打开记事本",
    adapters: ["local_computer_use"],
    input: { action: "open_app", app: "notepad" },
  },
  {
    id: "computer-screenshot-desktop",
    label: "桌面截图",
    adapters: ["local_computer_use"],
    input: { action: "screenshot_desktop" },
  },
  {
    id: "computer-diagnose",
    label: "诊断桥接",
    adapters: ["local_computer_use"],
    input: { action: "diagnose" },
  },
  {
    id: "file-inspect",
    label: "检查文件",
    adapters: ["local_file"],
    input: { action: "inspect_file", path: "C:\\path\\to\\models.json", maxCharacters: 2000 },
  },
  {
    id: "file-extract-text",
    label: "读取文本文件",
    adapters: ["local_file"],
    input: { action: "extract_text", path: "C:\\path\\to\\file.txt", maxCharacters: 6000 },
  },
];
const VVIP_PRANK_MESSAGES = new Map([
  ["收购OPEN AI", ["预算暂缺 7 万亿，法务已经先把 PPT 标题建好了。", "任务排期：3000年，敬请期待。。。"]],
  ["免费洗脚", ["水温默认 42 度，足浴大模型正在学习“轻点”和“再重点”。", "任务排期：3000年，敬请期待。。。"]],
  ["送房送车", ["车钥匙和房本已经画在白板上，等宇宙交付中心开门。", "任务排期：3000年，敬请期待。。。"]],
  ["接入Claude", ["Claude 正在门口换鞋，进屋前还要先签一份很厚的路由协议。", "任务排期：3000年，敬请期待。。。"]],
  ["免费GPT", ["价格已经砍到 0，账单系统听完当场选择重启。", "任务排期：3000年，敬请期待。。。"]],
  ["长生不老", ["已提交给生命科学组，回复说先把熬夜修好。", "任务排期：3000年，敬请期待。。。"]],
  ["送媳妇", ["姻缘服务拒绝被 API 化，建议先提升个人魅力版本号。", "任务排期：3000年，敬请期待。。。"]],
  ["Computer Use", ["电脑已经同意上班，但鼠标说它要双休。", "任务排期：3000年，敬请期待。。。"]],
  ["免费生图", ["显卡正在排队领免费奶茶，画布先在原地热身。", "任务排期：3000年，敬请期待。。。"]],
  ["一键起飞", ["塔台批准了一半，另一半卡在“别真的飞走”评审。", "任务排期：3000年，敬请期待。。。"]],
  ["牛了个逼", ["已触发夸夸保护机制，再夸就要收性能税了。", "任务排期：3000年，敬请期待。。。"]],
  ["无限额度", ["无限已到账，额度正在从有限宇宙慢慢搬家。", "任务排期：3000年，敬请期待。。。"]],
]);
const VVIP_FALLBACK_PRANK = ["产品经理已经认真点头，工程师也已经郑重收藏到“梦里开发”清单。", "任务排期：3000年，敬请期待。。。"];

const IMAGE_PROVIDER_TEMPLATES = {
  siliconflow: {
    id: "siliconflow-kolors",
    name: "硅基流动 Kolors",
    adapter: "siliconflow_images",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpoint: "/images/generations",
    model: "Kwai-Kolors/Kolors",
    size: "1024x1024",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    defaults: {
      batch_size: 1,
      num_inference_steps: 20,
      guidance_scale: 7.5,
    },
    response: {
      imageUrlPath: "images[0].url",
      imageBase64Path: "data[0].b64_json",
    },
    help: "适合优先测试的国产生图接口。填 API Key 后即可测试，默认会把远程图片下载到本地。",
    required: ["Base URL", "Endpoint", "图片模型名", "API Key"],
    returns: ["优先读取 images[0].url", "如果返回 Base64，则读取 data[0].b64_json"],
  },
  zai: {
    id: "zai-glm-image",
    name: "智谱 / Z.ai GLM Image",
    adapter: "zai_images",
    baseUrl: "https://api.z.ai/api/paas/v4",
    endpoint: "/images/generations",
    model: "glm-image",
    size: "1280x1280",
    apiKeyEnv: "ZAI_API_KEY",
    response: {
      imageUrlPath: "data[0].url",
      imageBase64Path: "data[0].b64_json",
    },
    help: "适合测试 GLM Image。不同账号可用模型名可能不同，测试失败时先确认控制台里的模型权限。",
    required: ["Base URL", "Endpoint", "glm-image 或账号可用模型名", "API Key"],
    returns: ["优先读取 data[0].url", "如果返回 Base64，则读取 data[0].b64_json"],
  },
  openai: {
    id: "openai-gpt-image",
    name: "OpenAI GPT Image",
    adapter: "openai_images",
    baseUrl: "https://api.openai.com/v1",
    endpoint: "/images/generations",
    model: "gpt-image-1",
    size: "1024x1024",
    apiKeyEnv: "OPENAI_API_KEY",
    response: {
      imageUrlPath: "data[0].url",
      imageBase64Path: "data[0].b64_json",
    },
    help: "适合 OpenAI Images API 或兼容它的网关。非 GPT 文本模型也可以把生图请求转到这里。",
    required: ["Base URL", "Endpoint", "gpt-image-1 或兼容模型名", "API Key"],
    returns: ["通常读取 data[0].url", "Base64 返回读取 data[0].b64_json"],
  },
  ark: {
    id: "volcengine-ark-seedream",
    name: "火山方舟 Seedream",
    adapter: "openai_images",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    endpoint: "/images/generations",
    model: "doubao-seedream-5-0-260128",
    size: "",
    apiKeyEnv: "ARK_API_KEY",
    response: {
      imageUrlPath: "data[0].url",
      imageBase64Path: "data[0].b64_json",
    },
    help: "火山方舟图片生成走 OpenAI 兼容图片接口。模型名以方舟控制台实际开通为准；尺寸可留空，让模型使用服务端默认值。",
    required: ["Base URL", "Endpoint", "火山方舟图片模型名", "API Key"],
    returns: ["通常读取 data[0].url", "如果返回 Base64，则读取 data[0].b64_json"],
  },
  generic: {
    id: "generic-image-api",
    name: "通用图片接口",
    adapter: "generic_template",
    baseUrl: "https://api.example.com/v1",
    endpoint: "/images/generations",
    model: "image-model",
    size: "",
    apiKeyEnv: "IMAGE_GENERATION_API_KEY",
    response: {
      imageUrlPath: "data[0].url",
      imageBase64Path: "data[0].b64_json",
    },
    request: {
      template: {
        model: "{{model}}",
        prompt: "{{prompt}}",
        size: "{{size}}",
        n: 1,
      },
    },
    headers: {
      Authorization: "Bearer {{apiKey}}",
    },
    help: "给其他 OpenAI 风格或自建生图接口使用。保存前需要把返回图片 URL 或 Base64 的字段路径写对。",
    required: ["Base URL", "Endpoint", "模型名", "API Key", "返回字段路径"],
    returns: ["按你填写的 URL 路径读取远程图片", "或按 Base64 路径保存图片"],
  },
};

function imageProviderTemplates() {
  return IMAGE_PROVIDER_TEMPLATES;
}

const CAPABILITY_PROVIDER_TEMPLATES = {
  ocr: {
    name: "OCR 接口示例",
    capability: "ocr",
    adapter: "generic_http",
    baseUrl: "https://api.example.com/v1",
    endpoint: "/ocr",
    model: "ocr-v1",
    apiKeyEnv: "OCR_API_KEY",
    runInput: {
      imageUrl: "https://example.com/image.png",
    },
  },
  search: {
    name: "搜索接口示例",
    capability: "web_search",
    adapter: "generic_http",
    baseUrl: "https://api.example.com/v1",
    endpoint: "/web-search",
    model: "web-search-v1",
    apiKeyEnv: "SEARCH_API_KEY",
    runInput: {
      query: "CodexBridge 最新消息",
      limit: 5,
    },
  },
  browser: {
    name: "本地 Chrome/浏览器",
    capability: "browser",
    capabilities: ["browser", "webpage_screenshot"],
    adapter: "local_browser",
    baseUrl: "",
    endpoint: "",
    model: "",
    apiKeyEnv: "",
    runInput: {
      action: "open_url",
      url: "https://example.com",
    },
  },
  computerUse: {
    name: "本地 Computer Use（安全动作）",
    capability: "computer_use",
    adapter: "local_computer_use",
    baseUrl: "",
    endpoint: "",
    model: "",
    apiKeyEnv: "",
    runInput: {
      action: "open_app",
      app: "notepad",
      supportedActions: ["list_apps", "open_app", "screenshot_desktop"],
    },
  },
  screenshot: {
    name: "网页截图接口示例",
    capability: "webpage_screenshot",
    adapter: "generic_http",
    baseUrl: "https://api.example.com/v1",
    endpoint: "/screenshots",
    model: "screenshot-v1",
    apiKeyEnv: "SCREENSHOT_API_KEY",
    runInput: {
      url: "https://example.com",
      viewport: "desktop",
      fullPage: true,
    },
  },
  localScreenshot: {
    name: "本地网页截图",
    capability: "webpage_screenshot",
    capabilities: ["webpage_screenshot", "browser"],
    adapter: "local_browser",
    baseUrl: "",
    endpoint: "",
    model: "",
    apiKeyEnv: "",
    runInput: {
      action: "screenshot_url",
      url: "https://example.com",
      viewport: "desktop",
      fullPage: true,
    },
  },
  localFile: {
    name: "本地文件处理",
    capability: "file_processing",
    adapter: "local_file",
    baseUrl: "",
    endpoint: "",
    model: "",
    apiKeyEnv: "",
    runInput: {
      action: "inspect_file",
      path: "C:\\path\\to\\models.json",
      maxCharacters: 2000,
    },
  },
  speech: {
    name: "语音接口示例",
    capability: "speech",
    adapter: "generic_http",
    baseUrl: "https://api.example.com/v1",
    endpoint: "/speech",
    model: "speech-v1",
    apiKeyEnv: "SPEECH_API_KEY",
    defaults: {
      voice: "warm",
      format: "mp3",
    },
    runInput: {
      text: "你好，欢迎使用 CodexBridge。",
      voice: "default",
    },
  },
  video: {
    name: "视频接口示例",
    capability: "video",
    adapter: "generic_http",
    baseUrl: "https://api.example.com/v1",
    endpoint: "/videos",
    model: "video-v1",
    apiKeyEnv: "VIDEO_API_KEY",
    defaults: {
      duration: 5,
      ratio: "16:9",
    },
    runInput: {
      prompt: "生成一段 5 秒产品演示视频",
      duration: 5,
    },
  },
};

prepareRendererLayout();

const els = {
  routerStatus: document.querySelector("#routerStatus"),
  modeStatus: document.querySelector("#modeStatus"),
  appVersion: document.querySelector("#appVersion"),
  rootDir: document.querySelector("#rootDir"),
  selectedCount: document.querySelector("#selectedCount"),
  keySummary: document.querySelector("#keySummary"),
  keySummaryDetail: document.querySelector("#keySummaryDetail"),
  healthStatus: document.querySelector("#healthStatus"),
  startupCheckSummary: document.querySelector("#startupCheckSummary"),
  startupCheckList: document.querySelector("#startupCheckList"),
  runStartupCheck: document.querySelector("#runStartupCheck"),
  copyPreflightDiagnostics: document.querySelector("#copyPreflightDiagnostics"),
  selectAcceptanceReleaseDir: document.querySelector("#selectAcceptanceReleaseDir"),
  acceptanceReleaseDir: document.querySelector("#acceptanceReleaseDir"),
  bypassSystemProxy: document.querySelector("#bypassSystemProxy"),
  localRateLimitEnabled: document.querySelector("#localRateLimitEnabled"),
  duplicateRequestProtection: document.querySelector("#duplicateRequestProtection"),
  interceptCodexAuxiliaryTasks: document.querySelector("#interceptCodexAuxiliaryTasks"),
  codexAuxiliaryModelId: document.querySelector("#codexAuxiliaryModelId"),
  routerPort: document.querySelector("#routerPort"),
  autoSelectModel: document.querySelector("#autoSelectModel"),
  autoFailover: document.querySelector("#autoFailover"),
  smartCodeMode: document.querySelector("#smartCodeMode"),
  smartCodeRoute: document.querySelector("#smartCodeRoute"),
  smartLongContextMode: document.querySelector("#smartLongContextMode"),
  smartLongContextRoute: document.querySelector("#smartLongContextRoute"),
  smartImageGenerationMode: document.querySelector("#smartImageGenerationMode"),
  smartImageGenerationRoute: document.querySelector("#smartImageGenerationRoute"),
  smartOrdinaryChatMode: document.querySelector("#smartOrdinaryChatMode"),
  smartOrdinaryChatRoute: document.querySelector("#smartOrdinaryChatRoute"),
  smartFailoverMode: document.querySelector("#smartFailoverMode"),
  smartFailoverRoute1: document.querySelector("#smartFailoverRoute1"),
  smartFailoverRoute2: document.querySelector("#smartFailoverRoute2"),
  smartFailoverRoute3: document.querySelector("#smartFailoverRoute3"),
  saveDesktopOptions: document.querySelector("#saveDesktopOptions"),
  repairModelReferences: document.querySelector("#repairModelReferences"),
  modelReferenceStatus: document.querySelector("#modelReferenceStatus"),
  cleanUnavailableModels: document.querySelector("#cleanUnavailableModels"),
  restoreDefaultModels: document.querySelector("#restoreDefaultModels"),
  profileList: document.querySelector("#profileList"),
  saveConfigProfile: document.querySelector("#saveConfigProfile"),
  exportConfigPackage: document.querySelector("#exportConfigPackage"),
  exportConfigPackageToSyncDir: document.querySelector("#exportConfigPackageToSyncDir"),
  importConfigPackage: document.querySelector("#importConfigPackage"),
  configPackageSyncStatus: document.querySelector("#configPackageSyncStatus"),
  configPackageImportBackupStatus: document.querySelector("#configPackageImportBackupStatus"),
  backupList: document.querySelector("#backupList"),
  imageProviderList: document.querySelector("#imageProviderList"),
  imageProviderTemplateHint: document.querySelector("#imageProviderTemplateHint"),
  imageProviderForm: document.querySelector("#imageProviderForm"),
  fillSiliconFlowImageProvider: document.querySelector("#fillSiliconFlowImageProvider"),
  imageProviderTestPrompt: document.querySelector("#imageProviderTestPrompt"),
  imageProviderTestResult: document.querySelector("#imageProviderTestResult"),
  imageGenerationHistory: document.querySelector("#imageGenerationHistory"),
  imageHistorySearch: document.querySelector("#imageHistorySearch"),
  imageHistoryFilter: document.querySelector("#imageHistoryFilter"),
  imageHistorySummary: document.querySelector("#imageHistorySummary"),
  testImageProvider: document.querySelector("#testImageProvider"),
  clearImageGenerationHistory: document.querySelector("#clearImageGenerationHistory"),
  resetImageProviderForm: document.querySelector("#resetImageProviderForm"),
  saveImageProvider: document.querySelector("#saveImageProvider"),
  capabilityProviderList: document.querySelector("#capabilityProviderList"),
  capabilityProviderForm: document.querySelector("#capabilityProviderForm"),
  saveCapabilityProvider: document.querySelector("#saveCapabilityProvider"),
  resetCapabilityProviderForm: document.querySelector("#resetCapabilityProviderForm"),
  testCapabilityProvider: document.querySelector("#testCapabilityProvider"),
  capabilityProviderTestResult: document.querySelector("#capabilityProviderTestResult"),
  executeCapabilityProvider: document.querySelector("#executeCapabilityProvider"),
  capabilityProviderRunPresets: document.querySelector("#capabilityProviderRunPresets"),
  capabilityProviderRunInput: document.querySelector("#capabilityProviderRunInput"),
  capabilityProviderRunResult: document.querySelector("#capabilityProviderRunResult"),
  capabilityExecutionHistory: document.querySelector("#capabilityExecutionHistory"),
  capabilityHistorySearch: document.querySelector("#capabilityHistorySearch"),
  capabilityHistoryFilter: document.querySelector("#capabilityHistoryFilter"),
  capabilityHistorySummary: document.querySelector("#capabilityHistorySummary"),
  clearCapabilityExecutionHistory: document.querySelector("#clearCapabilityExecutionHistory"),
  resourceSummary: document.querySelector("#resourceSummary"),
  resourceRefreshStatus: document.querySelector("#resourceRefreshStatus"),
  resourceList: document.querySelector("#resourceList"),
  resourceSearch: document.querySelector("#resourceSearch"),
  searchPluginMarketplaces: document.querySelector("#searchPluginMarketplaces"),
  resourceStatusFilter: document.querySelector("#resourceStatusFilter"),
  resourceSourceFilter: document.querySelector("#resourceSourceFilter"),
  refreshResources: document.querySelector("#refreshResources"),
  refreshPluginMarketplaces: document.querySelector("#refreshPluginMarketplaces"),
  copyResourceDiagnostics: document.querySelector("#copyResourceDiagnostics"),
  sessionSearch: document.querySelector("#sessionSearch"),
  clearSessionSearch: document.querySelector("#clearSessionSearch"),
  sessionList: document.querySelector("#sessionList"),
  recoverCodexProjects: document.querySelector("#recoverCodexProjects"),
  recoverHistoryAccessSessions: document.querySelector("#recoverHistoryAccessSessions"),
  historyRecoveryStatusPanel: document.querySelector("#historyRecoveryStatusPanel"),
  historyRecoveryPhase: document.querySelector("#historyRecoveryPhase"),
  historyRecoveryMessage: document.querySelector("#historyRecoveryMessage"),
  historyRecoveryPlanned: document.querySelector("#historyRecoveryPlanned"),
  historyRecoveryInserted: document.querySelector("#historyRecoveryInserted"),
  historyRecoveryCommit: document.querySelector("#historyRecoveryCommit"),
  historyRecoveryBackup: document.querySelector("#historyRecoveryBackup"),
  historyRecoveryCatalog: document.querySelector("#historyRecoveryCatalog"),
  historyRecoverySidebar: document.querySelector("#historyRecoverySidebar"),
  historyRecoveryFailure: document.querySelector("#historyRecoveryFailure"),
  retryHistoryRecovery: document.querySelector("#retryHistoryRecovery"),
  copyDiagnostics: document.querySelector("#copyDiagnostics"),
  savePreflightDiagnostics: document.querySelector("#savePreflightDiagnostics"),
  saveAcceptanceReport: document.querySelector("#saveAcceptanceReport"),
  saveReleaseGateReport: document.querySelector("#saveReleaseGateReport"),
  latestUsage: document.querySelector("#latestUsage"),
  providerGrid: document.querySelector("#providerGrid"),
  providerPreview: document.querySelector("#providerPreview"),
  selectedModels: document.querySelector("#selectedModels"),
  modelPool: document.querySelector("#modelPool"),
  modelConfigPool: document.querySelector("#modelConfigPool"),
  capabilitySummary: document.querySelector("#capabilitySummary"),
  capabilityDiagnostics: document.querySelector("#capabilityDiagnostics"),
  statCalls: document.querySelector("#statCalls"),
  statTokens: document.querySelector("#statTokens"),
  statPrompt: document.querySelector("#statPrompt"),
  statCache: document.querySelector("#statCache"),
  statCompletion: document.querySelector("#statCompletion"),
  statCost: document.querySelector("#statCost"),
  usageBudgetScope: document.querySelector("#usageBudgetScope"),
  usageBudgetTarget: document.querySelector("#usageBudgetTarget"),
  usageDailyTokenLimit: document.querySelector("#usageDailyTokenLimit"),
  usageDailyCallLimit: document.querySelector("#usageDailyCallLimit"),
  usageDailyCostLimit: document.querySelector("#usageDailyCostLimit"),
  usageInputCostPerMillion: document.querySelector("#usageInputCostPerMillion"),
  usageCacheCostPerMillion: document.querySelector("#usageCacheCostPerMillion"),
  usageOutputCostPerMillion: document.querySelector("#usageOutputCostPerMillion"),
  saveUsageBudgets: document.querySelector("#saveUsageBudgets"),
  usageBudgetAlerts: document.querySelector("#usageBudgetAlerts"),
  usageCostEstimate: document.querySelector("#usageCostEstimate"),
  usageChart: document.querySelector("#usageChart"),
  usageRange: document.querySelector("#usageRange"),
  usageTable: document.querySelector("#usageTable"),
  logOutput: document.querySelector("#logOutput"),
  doubleQuotaStatus: document.querySelector("#doubleQuotaStatus"),
  doubleQuotaServiceBanner: document.querySelector("#doubleQuotaServiceBanner"),
  doubleQuotaServiceTitle: document.querySelector("#doubleQuotaServiceTitle"),
  doubleQuotaServiceDetail: document.querySelector("#doubleQuotaServiceDetail"),
  doubleQuotaUrl: document.querySelector("#doubleQuotaUrl"),
  doubleQuotaVersion: document.querySelector("#doubleQuotaVersion"),
  doubleQuotaMcpStatus: document.querySelector("#doubleQuotaMcpStatus"),
  doubleQuotaPort: document.querySelector("#doubleQuotaPort"),
  doubleQuotaMessage: document.querySelector("#doubleQuotaMessage"),
  doubleQuotaExtensionPath: document.querySelector("#doubleQuotaExtensionPath"),
  doubleQuotaExtensionStatus: document.querySelector("#doubleQuotaExtensionStatus"),
  doubleQuotaExtensionState: document.querySelector("#doubleQuotaExtensionState"),
  saveDoubleQuotaPort: document.querySelector("#saveDoubleQuotaPort"),
  startDoubleQuota: document.querySelector("#startDoubleQuota"),
  stopDoubleQuota: document.querySelector("#stopDoubleQuota"),
  openDoubleQuota: document.querySelector("#openDoubleQuota"),
  manageDoubleQuotaExtension: document.querySelector("#manageDoubleQuotaExtension"),
  openDoubleQuotaExtensionManager: document.querySelector("#openDoubleQuotaExtensionManager"),
  refreshDoubleQuotaExtension: document.querySelector("#refreshDoubleQuotaExtension"),
  repairDoubleQuotaMcp: document.querySelector("#repairDoubleQuotaMcp"),
  toast: document.querySelector("#toast"),
  requestDetailDialog: document.querySelector("#requestDetailDialog"),
  requestDetailBody: document.querySelector("#requestDetailBody"),
  closeRequestDetail: document.querySelector("#closeRequestDetail"),
  resourceDetailDialog: document.querySelector("#resourceDetailDialog"),
  resourceDetailBody: document.querySelector("#resourceDetailBody"),
  closeResourceDetail: document.querySelector("#closeResourceDetail"),
  customModelForm: document.querySelector("#customModelForm"),
  customFormTitle: document.querySelector("#customFormTitle"),
  customFormDescription: document.querySelector("#customFormDescription"),
  customSubmitButton: document.querySelector("#customSubmitButton"),
  customImageInput: document.querySelector("#customImageInput"),
  cancelCustomEdit: document.querySelector("#cancelCustomEdit"),
  routerToggle: document.querySelector("#routerToggle"),
  restartCodex: document.querySelector("#restartCodex"),
  selectCodexDesktopExe: document.querySelector("#selectCodexDesktopExe"),
  codexDesktopPath: document.querySelector("#codexDesktopPath"),
  checkUpdates: document.querySelector("#checkUpdates"),
  updateDialog: document.querySelector("#updateDialog"),
  updateDialogVersion: document.querySelector("#updateDialogVersion"),
  updateDialogMessage: document.querySelector("#updateDialogMessage"),
  updateDialogAsset: document.querySelector("#updateDialogAsset"),
  updateProgress: document.querySelector("#updateProgress"),
  updateProgressText: document.querySelector("#updateProgressText"),
  updateProgressPercent: document.querySelector("#updateProgressPercent"),
  updateProgressTrack: document.querySelector("#updateProgressTrack"),
  updateProgressBar: document.querySelector("#updateProgressBar"),
  confirmUpdate: document.querySelector("#confirmUpdate"),
  cancelUpdate: document.querySelector("#cancelUpdate"),
  vvipDialog: document.querySelector("#vvipDialog"),
  vvipFeatureName: document.querySelector("#vvipFeatureName"),
  vvipDialogMessage: document.querySelector("#vvipDialogMessage"),
  vvipDialogNote: document.querySelector("#vvipDialogNote"),
  closeVvipDialog: document.querySelector("#closeVvipDialog"),
};

function prepareRendererLayout() {
  document.querySelector('[data-section="modelConfig"]')?.remove();
  document.querySelector("#rootDir")?.closest(".metric")?.remove();
  document.querySelector(".metric-row")?.classList.add("three-metrics");

  const modelsSection = document.querySelector("#models");
  modelsSection?.firstElementChild?.classList.add("model-catalog-panel");
  const modelConfigSection = document.querySelector("#modelConfig");
  if (modelsSection && modelConfigSection && !document.querySelector(".merged-model-config")) {
    const wrapper = document.createElement("div");
    wrapper.className = "merged-model-config";
    while (modelConfigSection.firstElementChild) {
      wrapper.appendChild(modelConfigSection.firstElementChild);
    }
    wrapper.children[0]?.classList.add("provider-editor-panel", "hidden");
    wrapper.children[1]?.classList.add("model-advanced-panel", "hidden");
    wrapper.children[2]?.classList.add("custom-editor-panel", "hidden");
    modelsSection.appendChild(wrapper);
    modelConfigSection.remove();
  }

  const modelPool = document.querySelector("#modelPool");
  if (modelPool && !document.querySelector("#providerPreview")) {
    const preview = document.createElement("div");
    preview.id = "providerPreview";
    preview.className = "provider-preview";
    modelPool.before(preview);
  }

  const usageChart = document.querySelector("#usageChart");
  if (usageChart && !document.querySelector("#usageRange")) {
    const controls = document.createElement("div");
    controls.id = "usageRange";
    controls.className = "segmented usage-range";
    controls.innerHTML = [1, 3, 7, 14, 30]
      .map((days) => `<button type="button" data-usage-range="${days}">${days}天</button>`)
      .join("");
    usageChart.before(controls);
  }
}

for (const eventName of ["click", "change", "input", "submit", "dragstart", "drop"]) {
  document.addEventListener(eventName, (event) => {
    if (stateUnavailableControlEventGuard(event)) {
      showToast(STATE_UNAVAILABLE_WRITE_MESSAGE, "error");
    }
  }, true);
}

const stateUnavailableControlObserver = new MutationObserver(() => {
  if (stateUnavailableWritesLocked()) {
    applyStateUnavailableWriteGuard(document, true);
  }
});
stateUnavailableControlObserver.observe(document.body, { childList: true, subtree: true });

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    activateSection(button.dataset.section);
  });
});

function activateSection(sectionId) {
  const section = document.querySelector(`#${sectionId}`);
  const button = document.querySelector(`.nav-item[data-section="${sectionId}"]`);
  if (!section || !button) {
    return;
  }
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  document.querySelectorAll(".section-panel").forEach((item) => item.classList.add("hidden"));
  button.classList.add("active");
  section.classList.remove("hidden");
  renderActiveSection(sectionId);
  void ensureSettingsDetailForSection(sectionId);
  void ensureDetailedStateForSection(sectionId);
  if (sectionId === "sessions") {
    void refreshHistoryRecoveryStatus();
  }
  if (sectionId === "doubleQuota") {
    void refreshDoubleQuotaState();
  }
}

async function refreshDoubleQuotaState() {
  try {
    doubleQuotaState = await api.getDoubleQuotaState();
    renderDoubleQuota();
  } catch (error) {
    doubleQuotaState = { status: "error", error: error.message || String(error) };
    renderDoubleQuota();
  }
}

els.saveDoubleQuotaPort?.addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    doubleQuotaState = await api.saveDoubleQuotaPort(Number(els.doubleQuotaPort.value));
    renderDoubleQuota();
    showToast("双倍额度端口已保存；请重新加载 Chrome 扩展。");
  }),
);

els.startDoubleQuota?.addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    doubleQuotaState = await api.startDoubleQuota();
    renderDoubleQuota();
    showToast(doubleQuotaState.ownedProcess ? "双倍额度服务已启动。" : "已连接现有双倍额度服务。");
  }),
);

els.stopDoubleQuota?.addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    doubleQuotaState = await api.stopDoubleQuota();
    renderDoubleQuota();
    showToast(doubleQuotaState.externalProcess
      ? "当前服务由外部程序管理，未强制关闭。"
      : "双倍额度服务已停止。");
  }),
);

els.openDoubleQuota?.addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    doubleQuotaState = await api.openDoubleQuota();
    renderDoubleQuota();
  }),
);

els.manageDoubleQuotaExtension?.addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    const requestedAction = doubleQuotaState?.extensionAction?.id || "install";
    doubleQuotaState = await api.manageDoubleQuotaExtension();
    renderDoubleQuota();
    if (doubleQuotaState.extensionUpdate?.manualReloadRequired) {
      if (requestedAction === "reinstall") {
        await api.copyText(doubleQuotaState.extensionDir);
        await api.openDoubleQuotaExtensionManager();
      } else if (requestedAction === "install") {
        await api.openFolder(doubleQuotaState.extensionDir);
      }
      showToast(requestedAction === "reinstall"
        ? "Chrome 未提供旧扩展目录。请移除旧扩展，再加载刚打开的固定安装目录。"
        : requestedAction === "install"
          ? "新版扩展已复制，请在 Chrome 中加载上面的稳定目录。"
          : "新版文件已覆盖到 Chrome 实际加载目录；请点击旁边的“打开扩展管理”后手动重新加载。",
      );
    } else {
      showToast("扩展已更新并重新连接。无需手动操作。");
    }
    await refreshDoubleQuotaState();
  }),
);

els.openDoubleQuotaExtensionManager?.addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    doubleQuotaState = await api.openDoubleQuotaExtensionManager();
    renderDoubleQuota();
    showToast("扩展管理地址已复制。如果打开空白页，请粘贴到 Chrome 地址栏并回车。");
  }),
);

els.refreshDoubleQuotaExtension?.addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    await refreshDoubleQuotaState();
    showToast("扩展状态已重新检测。");
  }),
);

els.repairDoubleQuotaMcp?.addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    doubleQuotaState = await api.repairDoubleQuotaMcp();
    renderDoubleQuota();
    showToast(doubleQuotaState.backupPath
      ? "双倍额度 MCP 已修复，原配置已备份。"
      : "双倍额度 MCP 已安装。");
  }),
);

async function refreshHistoryRecoveryStatus() {
  try {
    const status = await api.historyRecoveryStatus();
    if (status?.phase && status.phase !== "idle") {
      historyRecoveryStatus = status;
      renderHistoryRecoveryStatus();
    }
  } catch (error) {
    console.error(error);
  }
}

document.querySelectorAll("[data-usage-range]").forEach((button) => {
  button.addEventListener("click", () => {
    usageRangeDays = Number(button.dataset.usageRange || 7);
    renderUsage();
  });
});

document.querySelectorAll(".mode-card").forEach((button) => {
  button.addEventListener("click", () =>
    runAction(button, async () => {
      const result = normalizeModeSelectionResult(await api.selectMode(button.dataset.mode));
      state = result.state;
      draftSelection = [...state.selectedModelIds];
      render();
      showToast(modeSwitchToastMessage(result.transaction));
    }),
  );
});

document.querySelector("#recoverHistoryAccess")?.addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    const result = await api.recoverHistoryAccess();
    await refresh();
    showToast(result?.message || "已开启历史对话显示；当前 CodexBridge 配置保持不变。");
  }),
);

els.routerToggle.addEventListener("click", () =>
  runAction(els.routerToggle, async () => {
    if (state?.routerRunning) {
      const response = await api.stopRouter();
      if (response?.warning?.code === "managed_config_cleanup_failed") {
        showToast(
          `Router 已关闭，但 ChatGPT / Codex 原配置恢复失败（诊断码：${response.warning.causeCode || "operation_failed"}）。请先不要重启 ChatGPT / Codex，并复制诊断信息。`,
        );
      } else {
        showToast("Router 已关闭。");
      }
    } else {
      const response = await api.startRouter();
      if (response.ok === false) {
        throw new Error(response.error.message);
      }
      if (response.ok === true) {
        showToast("Router 已启动。");
      }
    }
    await refresh({ lite: true });
  }),
);

els.restartCodex.addEventListener("click", () =>
  runAction(els.restartCodex, async () => {
    const result = await api.restartCodex();
    await refresh();
    showToast(result?.message || "ChatGPT / Codex 已重启。");
  }),
);

els.selectCodexDesktopExe.addEventListener("click", () =>
  runAction(els.selectCodexDesktopExe, async () => {
    const result = await api.selectCodexDesktopExe();
    if (result?.canceled) {
      return;
    }
    state = result?.state || await api.getState();
    render();
    showToast(`已保存 ChatGPT / Codex 启动项：${result?.path || codexDesktopLaunchPath() || "自动查找"}`);
  }),
);

els.saveDesktopOptions.addEventListener("click", () =>
  runAction(els.saveDesktopOptions, async () => {
    state = await api.saveOptions({
      bypassSystemProxy: els.bypassSystemProxy.checked,
      localRateLimitEnabled: els.localRateLimitEnabled.checked,
      duplicateRequestProtection: els.duplicateRequestProtection.checked,
      interceptCodexAuxiliaryTasks: els.interceptCodexAuxiliaryTasks?.checked || false,
      codexAuxiliaryModelId: String(els.codexAuxiliaryModelId?.value || "").trim(),
      routerPort: Number(els.routerPort.value || 15722),
      autoSelectModel: els.autoSelectModel.checked,
      autoFailover: els.autoFailover.checked,
      smartRouting: smartRoutingOptionsFromInputs(),
    });
    render();
    showToast(
      "基础设置已保存；端口或代理变更会在重新启动 Router 后生效。",
    );
  }),
);

els.repairModelReferences?.addEventListener("click", () =>
  runAction(els.repairModelReferences, () => repairStaleModelReferences(els.repairModelReferences)),
);

els.cleanUnavailableModels?.addEventListener("click", () =>
  cleanUnavailableSelectedModels(),
);

els.restoreDefaultModels?.addEventListener("click", () =>
  restoreDefaultModelSelection(els.restoreDefaultModels),
);

els.interceptCodexAuxiliaryTasks?.addEventListener("change", () => {
  renderCodexAuxiliaryTaskSettings();
});

els.saveUsageBudgets?.addEventListener("click", () =>
  runAction(els.saveUsageBudgets, async () => {
    state = await api.saveOptions({
      usageBudgets: usageBudgetOptionsFromInputs(),
    });
    render();
    showToast("用量预算已保存；达到每日上限后，Router 会在本地停止后续请求。");
  }),
);

SMART_ROUTING_RULE_CONTROLS.forEach((control) => {
  els[control.mode]?.addEventListener("change", syncSmartRoutingControlStates);
});
els.smartFailoverMode?.addEventListener("change", syncSmartRoutingControlStates);

els.usageBudgetScope?.addEventListener("change", () => renderUsageBudgetInputs({ keepTarget: false }));
els.usageBudgetTarget?.addEventListener("change", () => renderUsageBudgetInputs({ keepTarget: true }));

els.imageProviderForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  saveImageProviderSettings(els.saveImageProvider || event.submitter || els.imageProviderForm);
});

els.capabilityProviderForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  saveCapabilityProviderSettings(els.saveCapabilityProvider || event.submitter || els.capabilityProviderForm);
});

document.querySelectorAll("[data-image-provider-template]").forEach((button) => {
  button.addEventListener("click", () => {
    fillImageProviderTemplate(button.dataset.imageProviderTemplate);
  });
});

document.querySelectorAll("[data-capability-provider-template]").forEach((button) => {
  button.addEventListener("click", () => {
    fillCapabilityProviderTemplate(button.dataset.capabilityProviderTemplate);
  });
});

els.testImageProvider?.addEventListener("click", () => {
  testImageProviderFromForm(els.testImageProvider);
});

els.testCapabilityProvider?.addEventListener("click", () => {
  testCapabilityProviderFromForm(els.testCapabilityProvider);
});

els.executeCapabilityProvider?.addEventListener("click", () => {
  executeCapabilityProviderFromForm(els.executeCapabilityProvider);
});

els.clearCapabilityExecutionHistory?.addEventListener("click", () => {
  clearCapabilityExecutionHistory(els.clearCapabilityExecutionHistory);
});

els.capabilityHistorySearch?.addEventListener("input", (event) => {
  capabilityHistorySearchText = String(event.currentTarget?.value || "");
  renderCapabilityExecutionHistory();
});

els.capabilityHistoryFilter?.addEventListener("change", (event) => {
  capabilityHistoryFilter = String(event.currentTarget?.value || "all");
  renderCapabilityExecutionHistory();
});

els.clearImageGenerationHistory?.addEventListener("click", () => {
  clearImageGenerationHistory(els.clearImageGenerationHistory);
});

els.imageHistorySearch?.addEventListener("input", (event) => {
  imageHistorySearchText = String(event.currentTarget?.value || "");
  renderImageGenerationHistory();
});

els.imageHistoryFilter?.addEventListener("change", (event) => {
  imageHistoryFilter = String(event.currentTarget?.value || "all");
  renderImageGenerationHistory();
});

els.sessionSearch?.addEventListener("input", (event) => {
  sessionSearchText = String(event.currentTarget?.value || "");
  renderSessions();
});

els.clearSessionSearch?.addEventListener("click", () => {
  sessionSearchText = "";
  if (els.sessionSearch) {
    els.sessionSearch.value = "";
  }
  renderSessions();
});

els.resetImageProviderForm?.addEventListener("click", () => {
  resetImageProviderForm();
});

els.resetCapabilityProviderForm?.addEventListener("click", () => {
  resetCapabilityProviderForm();
});

document.querySelector("#imageProviderAdapter")?.addEventListener("change", (event) => {
  const adapter = event.currentTarget.value;
  const keyInput = document.querySelector("#imageProviderKeyEnv");
  const sizeInput = document.querySelector("#imageProviderSize");
  if (keyInput && !keyInput.value.trim()) {
    keyInput.value = imageProviderDefaultKeyEnv(adapter);
  }
  if (sizeInput && !sizeInput.value.trim()) {
    sizeInput.value = imageProviderDefaultSize(adapter);
  }
  const response = imageProviderDefaultResponse(adapter);
  const imageUrlPath = document.querySelector("#imageProviderImageUrlPath");
  const imageBase64Path = document.querySelector("#imageProviderImageBase64Path");
  if (imageUrlPath && !imageUrlPath.value.trim()) {
    imageUrlPath.value = response.imageUrlPath;
  }
  if (imageBase64Path && !imageBase64Path.value.trim()) {
    imageBase64Path.value = response.imageBase64Path;
  }
  renderImageProviderTemplateHint(imageProviderTemplateForAdapter(adapter));
});

document.querySelector("#capabilityProviderCapability")?.addEventListener("change", (event) => {
  const capability = event.currentTarget.value;
  const capabilities = selectedCapabilityProviderValues(capability);
  const keyInput = document.querySelector("#capabilityProviderKeyEnv");
  const endpointInput = document.querySelector("#capabilityProviderEndpoint");
  if (keyInput && !keyInput.value.trim()) {
    keyInput.value = defaultCapabilityProviderKeyEnv(capability);
  }
  if (endpointInput && !endpointInput.value.trim()) {
    endpointInput.value = defaultCapabilityProviderEndpoint(capability);
  }
  if (els.capabilityProviderRunInput) {
    els.capabilityProviderRunInput.value = defaultCapabilityProviderRunInput(capability);
  }
  setCapabilityProviderExtraCapabilities(capabilities);
  renderCapabilityProviderRunPresets();
  renderCapabilityProviderRunResult(null);
});

document.querySelector("#capabilityProviderAdapter")?.addEventListener("change", () => {
  syncCapabilityProviderAdapterFields();
  renderCapabilityProviderRunPresets();
  renderCapabilityProviderTestResult(null);
  renderCapabilityProviderRunResult(null);
});

if (els.capabilityProviderRunInput && !els.capabilityProviderRunInput.value.trim()) {
  els.capabilityProviderRunInput.value = defaultCapabilityProviderRunInput("ocr");
}

els.runStartupCheck?.addEventListener("click", () =>
  runAction(els.runStartupCheck, async () => {
    state = {
      ...state,
      startupCheck: await api.runStartupCheck(),
    };
    renderStartupCheck();
    showToast("启动体检已刷新。");
  }),
);

els.copyPreflightDiagnostics?.addEventListener("click", () =>
  runAction(els.copyPreflightDiagnostics, async () => {
    await api.copyDiagnostics();
    showToast("发布检查已复制。");
  }),
);

els.savePreflightDiagnostics?.addEventListener("click", () =>
  runAction(els.savePreflightDiagnostics, async () => {
    const result = await api.saveDiagnostics();
    if (result?.canceled) {
      return;
    }
    showToast(`体检报告已保存：${result?.filePath || "已保存"}`);
  }),
);

els.saveAcceptanceReport?.addEventListener("click", () =>
  runAction(els.saveAcceptanceReport, async () => {
    const result = await api.saveAcceptanceReport();
    if (result?.canceled) {
      return;
    }
    const status = result?.ok ? "已通过" : "证据不足";
    showToast(`检查报告已保存（${status}）：${result?.filePath || "已保存"}`);
  }),
);

els.saveReleaseGateReport?.addEventListener("click", () =>
  runAction(els.saveReleaseGateReport, async () => {
    const result = await api.saveReleaseGateReport();
    if (result?.canceled) {
      return;
    }
    const status = result?.ok ? "已通过" : "有阻断或提醒";
    showToast(`门禁报告已保存（${status}）：${result?.filePath || "已保存"}`);
  }),
);

els.selectAcceptanceReleaseDir?.addEventListener("click", () =>
  runAction(els.selectAcceptanceReleaseDir, async () => {
    const result = await api.selectAcceptanceReleaseDir();
    if (result?.canceled) {
      return;
    }
    state = result?.state || await api.getState();
    render();
    showToast(`发布目录已保存：${state?.desktopOptions?.acceptanceReleaseDir || result?.path || "未选择"}`);
  }),
);

els.saveConfigProfile?.addEventListener("click", () =>
  runAction(els.saveConfigProfile, async () => {
    const name = `配置档 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
    const response = await api.saveConfigProfile({
      name,
      selectedModelIds: draftSelection,
    });
    state = response?.state || await api.getState();
    draftSelection = [...state.selectedModelIds];
    render();
    showToast(`已保存配置档：${response?.saved?.name || name}`);
  }),
);

els.exportConfigPackage?.addEventListener("click", () =>
  runAction(els.exportConfigPackage, async () => {
    const result = await api.exportConfigPackage();
    if (result?.canceled) {
      return;
    }
    showToast(configPackageExportSummary(result));
  }),
);

els.exportConfigPackageToSyncDir?.addEventListener("click", () =>
  runAction(els.exportConfigPackageToSyncDir, async () => {
    const result = await api.exportConfigPackageToSyncDir();
    if (result?.canceled) {
      return;
    }
    state = await api.getState();
    render();
    showToast(`同步目录配置包已导出：${result?.fileName || "已保存"}。API Key 不会导出。`);
  }),
);

els.importConfigPackage?.addEventListener("click", () =>
  runAction(els.importConfigPackage, async () => {
    const result = await api.importConfigPackage();
    if (result?.canceled) {
      return;
    }
    state = result?.state || await api.getState();
    draftSelection = [...state.selectedModelIds];
    render();
    showToast(result?.message || "配置包已导入，API Key 需要在本机重新填写。");
  }),
);

function configPackageExportSummary(result = {}) {
  const parts = [
    `模型 ${formatNumber(result?.selectedModelCount || 0)}`,
    `供应商设置 ${formatNumber(result?.providerCount || 0)}`,
    `图片供应商 ${formatNumber(result?.imageProviderCount || 0)}`,
    `能力供应商 ${formatNumber(result?.capabilityProviderCount || 0)}`,
    `Codex 资源清单 ${codexResourceCountLabel(result, " 项")}`,
    `上传图标 ${formatNumber(result?.embeddedLogoCount || 0)} 个`,
    `需重填 Key ${formatNumber(result?.requiredSecretKeyCount || 0)} 个`,
  ];
  return `配置包已导出：${result?.filePath || "已保存"}；${parts.join("，")}。API Key 不会导出。`;
}

els.copyResourceDiagnostics?.addEventListener("click", () =>
  runAction(els.copyResourceDiagnostics, async () => {
    const summary = await api.copyDiagnostics();
    showToast(`资源诊断已复制，最近错误 ${summary?.errorCount || 0} 条。`);
  }),
);

els.refreshResources?.addEventListener("click", () =>
  runAction(els.refreshResources, async () => {
    await refresh({ lite: false, forceResourceRefresh: true });
    showToast("资源列表已刷新。");
  }),
);

els.refreshPluginMarketplaces?.addEventListener("click", () =>
  runAction(els.refreshPluginMarketplaces, async () => {
    const accepted = await showConfirmDialog({
      title: "刷新插件市场",
      message: "CodexBridge 会调用 Codex CLI 刷新已配置的插件市场快照。这个操作不会安装、卸载或删除插件，只会更新可安装插件列表。",
      confirmText: "刷新插件市场",
    });
    if (!accepted) {
      return;
    }
    const response = await api.refreshCodexPluginMarketplaces();
    state = response?.state || await api.getState();
    render();
    showToast(response?.message || "插件市场已刷新。");
  }),
);

els.resourceSearch?.addEventListener("input", (event) => {
  resourceFilterText = String(event.target?.value || "");
  renderResources();
});

els.searchPluginMarketplaces?.addEventListener("click", () =>
  runAction(els.searchPluginMarketplaces, async () => {
    const query = String(els.resourceSearch?.value || resourceFilterText || "").trim();
    if (!query) {
      showToast("先输入要搜索的插件关键词。");
      els.resourceSearch?.focus();
      return;
    }
    resourceFilterText = query;
    resourceStatusFilter = "all";
    resourceSourceFilter = "marketplace";
    if (els.resourceSearch) {
      els.resourceSearch.value = query;
    }
    if (els.resourceStatusFilter) {
      els.resourceStatusFilter.value = "all";
    }
    if (els.resourceSourceFilter) {
      els.resourceSourceFilter.value = "marketplace";
    }
    const response = await api.refreshCodexPluginMarketplaces();
    state = response?.state || await api.getState();
    render();
    showToast(`已刷新插件市场并搜索“${query}”。`);
  }),
);

els.resourceStatusFilter?.addEventListener("change", (event) => {
  resourceStatusFilter = String(event.target?.value || "all");
  renderResources();
});

els.resourceSourceFilter?.addEventListener("change", (event) => {
  resourceSourceFilter = String(event.target?.value || "all");
  renderResources();
});

els.recoverCodexProjects?.addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    const accepted = await showConfirmDialog({
      title: "恢复项目列表",
      message: "CodexBridge 会让 ChatGPT / Codex Desktop 逐个打开当前识别到的真实项目目录，用桌面应用自己的方式刷新项目列表；不会修改模型、路由或会话内容。",
      confirmText: "恢复项目列表",
    });
    if (!accepted) {
      return;
    }
    const result = await api.recoverCodexProjects();
    lastProjectRecoveryResult = result;
    await refresh();
    showToast(result?.message || "已请求 Codex 恢复项目列表。");
  }),
);

els.recoverHistoryAccessSessions?.addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    const actionSequence = ++historyRecoveryActionSequence;
    const preview = await api.previewHistoryRecovery();
    if (actionSequence !== historyRecoveryActionSequence) {
      return;
    }
    historyRecoveryStatus = preview;
    renderHistoryRecoveryStatus();
    const summary = preview?.summary || {};
    const accepted = await showConfirmDialog({
      title: "恢复全部历史会话",
      message: [
        `原始线程 ${formatNumber(summary.rawThreads || 0)} 个，普通用户会话 ${formatNumber(summary.activeUserThreads || 0)} 个。`,
        `当前新版目录 ${formatNumber(summary.catalogThreads || 0)} 个，当前侧栏索引 ${formatNumber(summary.sidebarThreads || 0)} 个。`,
        `仅可恢复 ${formatNumber(summary.recoverableThreads || 0)} 个：计划新增 ${formatNumber(summary.plannedInserts || 0)} 个、更新 ${formatNumber(summary.plannedUpdates || 0)} 个；无法恢复 ${formatNumber(summary.unrecoverableThreads || 0)} 个。`,
        `子代理/内部线程 ${formatNumber((summary.subagentThreads || 0) + (summary.internalThreads || 0))} 个，已归档 ${formatNumber(summary.archivedThreads || 0)} 个，不会加入普通侧栏。`,
        "确认后会安全退出 ChatGPT / Codex，完整备份新版目录数据库和桌面状态，使用事务迁移并回读验证；不会删除原始会话。",
      ].join("\n"),
      confirmText: "退出 ChatGPT 并恢复",
    });
    if (!accepted) {
      return;
    }
    const result = await api.recoverHistoryAccess({ manualExit: false });
    if (actionSequence !== historyRecoveryActionSequence) {
      return;
    }
    historyRecoveryStatus = result;
    lastProjectRecoveryResult = result?.projectRecovery || null;
    applyVerifiedHistoryRecoverySummary(result);
    renderHistoryRecoveryStatus();
    renderSessions();
    await refreshAfterHistoryRecovery(result);
    if (historyRecoveryStatus?.phase !== result?.phase) {
      return;
    }
    const latestStatus = await api.historyRecoveryStatus();
    if (latestStatus?.phase !== result?.phase) {
      return;
    }
    if (result?.ok) {
      showToast(result?.message || "历史会话迁移完成。");
    } else {
      showToast(result?.message || "历史会话迁移失败。", "error");
    }
  }),
);

els.retryHistoryRecovery?.addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    const actionSequence = ++historyRecoveryActionSequence;
    const result = await api.recoverHistoryAccess({ manualExit: true });
    if (actionSequence !== historyRecoveryActionSequence) {
      return;
    }
    historyRecoveryStatus = result;
    lastProjectRecoveryResult = result?.projectRecovery || null;
    applyVerifiedHistoryRecoverySummary(result);
    renderHistoryRecoveryStatus();
    renderSessions();
    await refreshAfterHistoryRecovery(result);
    if (historyRecoveryStatus?.phase !== result?.phase) {
      return;
    }
    const latestStatus = await api.historyRecoveryStatus();
    if (latestStatus?.phase !== result?.phase) {
      return;
    }
    if (result?.ok) {
      els.toast?.classList.add("hidden");
      showToast(result?.message || "历史会话迁移完成。");
    } else {
      showToast(result?.message || "重新检测后仍不能迁移。", "error");
    }
  }),
);

els.closeRequestDetail?.addEventListener("click", hideRequestDetail);
els.requestDetailDialog?.addEventListener("click", (event) => {
  if (event.target === els.requestDetailDialog) {
    hideRequestDetail();
  }
});
els.closeResourceDetail?.addEventListener("click", hideResourceDetail);
els.resourceDetailDialog?.addEventListener("click", (event) => {
  if (event.target === els.resourceDetailDialog) {
    hideResourceDetail();
  }
});

els.copyDiagnostics.addEventListener("click", () =>
  runAction(els.copyDiagnostics, async () => {
    const summary = await api.copyDiagnostics();
    await refresh();
    showToast(`诊断信息已复制。最近错误 ${summary?.errorCount || 0} 条，发给我就能排查。`);
  }),
);

document.querySelector("#saveModelSelectionPanel").addEventListener("click", (event) =>
  saveModelSelection(event.currentTarget),
);

els.customModelForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runAction(els.customSubmitButton, async () => {
    const editingModel = editingCustomPresetId ? modelMap().get(editingCustomPresetId) : null;
    const wasEditing = Boolean(editingCustomPresetId);
    const model = customModelFormPayload(editingModel);
    const returnView = customReturnView;
    const returnProviderId = scopedCustomProviderId || editingProviderId;
    await api.saveCustomModel(model);
    resetCustomModelForm({ preserveView: true });
    if (returnView === "provider" && returnProviderId) {
      modelPageView = "provider";
      editingProviderId = returnProviderId;
      activeProviderId = returnProviderId;
    } else {
      modelPageView = "catalog";
    }
    scopedCustomProviderId = null;
    customReturnView = "catalog";
    await refresh();
    showToast(
      wasEditing
        ? "自定义模型已更新。API Key 为空时会保留本机已保存的 Key。"
        : "自定义模型已添加。API Key 会保存在本机，同一服务商可以继续添加多个模型。",
    );
  });
});

document.querySelector("#testCustomConnection").addEventListener("click", (event) => {
  runAction(event.currentTarget, async () => {
    const result = await api.testProviderConnection(customProviderPayload(true));
    showToast(
      result.ok
        ? `连接测试通过：HTTP ${result.status || 200}`
        : `连接测试失败：${result.error || result.message || "unknown error"}`,
      result.ok ? "success" : "error",
    );
  });
});

document.querySelector("#customLogoUpload")?.addEventListener("click", (event) => {
  runAction(event.currentTarget, async () => {
    const ownerId = scopedCustomProviderId || editingCustomPresetId || `custom-${slugifyProviderId(value("#customProviderName") || "provider")}`;
    const result = await api.selectLocalLogo({ ownerId, applyToProvider: false });
    if (result?.canceled) {
      return;
    }
    setValue("#customLogoUrl", result.logoUrl || "");
    renderCustomLogoUploadState();
    showToast("本地图标已选择，保存模型后生效。");
  });
});

els.cancelCustomEdit.addEventListener("click", () => {
  resetCustomModelForm({ preserveView: true });
  returnFromCustomEditor();
});

bindFolderButton("#openConfigFolder", "config");
bindFolderButton("#openUpdateFolder", "updates");
document.querySelector("#openGitHub").addEventListener("click", () => api.openGitHub());
els.checkUpdates.addEventListener("click", () => runUpdateCheck(els.checkUpdates));

function runUpdateCheck(button = els.checkUpdates) {
  return runAction(button, async () => {
    const updatePlan = await api.checkForUpdates();
    if (!updatePlan.ok) {
      throw new Error(updatePlan.message || "检查更新失败。");
    }
    if (!updatePlan.updateAvailable) {
      showToast(updatePlan.message || "当前已经是最新版。");
      return;
    }
    const accepted = await showUpdateDialog(updatePlan);
    if (!accepted) {
      showToast("已取消更新。");
      return;
    }
    const installerUpdate = updatePlan.asset?.kind === "installer";
    setUpdateDialogBusy(true);
    renderUpdateProgress({
      phase: "checking",
      downloadedBytes: 0,
      totalBytes: updatePlan.asset?.size || 0,
      percent: 0,
    });
    showToast(
      installerUpdate
        ? "正在下载安装器，完成后会自动打开安装窗口。"
        : "正在下载新版，完成后会自动重启到新版。",
    );
    try {
      const result = await api.installUpdate();
      renderUpdateProgress({
        phase: result.relaunching ? "restarting" : result.installerPath ? "launching" : "ready",
        downloadedBytes: updatePlan.asset?.size || 0,
        totalBytes: updatePlan.asset?.size || 0,
        percent: 100,
        message: result.nextStep || result.message,
      });
      setUpdateDialogBusy(false);
      showToast(result.nextStep || result.message || "下载完成，正在继续安装或重启到新版。");
    } catch (error) {
      setUpdateDialogBusy(false);
      renderUpdateProgress({
        phase: "error",
        message: error?.message || String(error),
      });
      throw error;
    }
  });
}

document.querySelectorAll("[data-vvip-feature]").forEach((button) => {
  button.addEventListener("click", () => showVvipDialog(button.dataset.vvipFeature || button.textContent.trim()));
});

els.closeVvipDialog?.addEventListener("click", hideVvipDialog);
els.vvipDialog?.addEventListener("click", (event) => {
  if (event.target === els.vvipDialog) {
    hideVvipDialog();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.requestDetailDialog?.classList.contains("hidden")) {
    hideRequestDetail();
    return;
  }
  if (event.key === "Escape" && !els.resourceDetailDialog?.classList.contains("hidden")) {
    hideResourceDetail();
    return;
  }
  if (event.key === "Escape" && !els.vvipDialog?.classList.contains("hidden")) {
    hideVvipDialog();
  }
});

api.onLogs((logs) => {
  state = {
    ...state,
    logs: [...logs],
  };
  renderLogs(logs);
});
api.onUpdateProgress?.((progress) => renderUpdateProgress(progress));
api.onUpdateFinished?.((result) => {
  showToast(result?.message || "CodexBridge 已更新完成。");
});
api.onNavigate?.((payload) => {
  activateSection(payload?.section || "dashboard");
});
api.onUsage((usage) => {
  if (!state) {
    return;
  }
  state = {
    ...state,
    usageEvents: usage.usageEvents || [],
    usageSummary: usage.usageSummary || emptyUsageSummary(),
    usageBudgetAlerts: usage.usageBudgetAlerts || [],
    usageCostEstimate: usage.usageCostEstimate || emptyUsageCostEstimate(),
  };
  renderUsage();
  renderUsageBudgetAlerts();
  renderUsageCostEstimate();
  renderOverviewUsage();
});
api.onState((nextState) => {
  refreshRequestSequence += 1;
  state = mergeStateWithRetainedDetailSlices(state, nextState);
  if (nextState?.codexResources?.pluginPage) {
    console.info("[resource-flow] stage=renderer-state-assignment", {
      apps: nextState.codexResources.pluginPage.summary?.apps,
      appIds: (nextState.codexResources.pluginPage.apps || []).map((item) => item.id),
      snapshot: nextState.codexResources.pluginPage.snapshot?.state,
    });
  }
  stateDetailLoaded = Boolean(state?.stateDetailLoaded || stateDetailLoaded);
  settingsDetailLoaded = Boolean(state?.settingsDetailLoaded || settingsDetailLoaded);
  draftSelection = [...(state.selectedModelIds || [])];
  render();
});

refresh({ lite: true });

async function refresh(options = {}) {
  const requestSequence = ++refreshRequestSequence;
  const nextState = await api.getState(options);
  if (requestSequence !== refreshRequestSequence) {
    return false;
  }
  state = mergeStateWithRetainedDetailSlices(state, nextState);
  stateDetailLoaded = Boolean(state?.stateDetailLoaded);
  settingsDetailLoaded = Boolean(state?.settingsDetailLoaded || settingsDetailLoaded);
  draftSelection = [...(state.selectedModelIds || [])];
  render();
  return true;
}

async function ensureDetailedStateForSection(sectionId) {
  if (!DETAIL_STATE_SECTIONS.has(sectionId) || stateDetailLoading) {
    return;
  }
  if (sectionId !== "resources" && stateDetailLoaded) {
    return;
  }
  stateDetailLoading = true;
  renderDetailLoading(sectionId);
  try {
    state = await api.getState(sectionId === "resources"
      ? { lite: false, forceResourceRefresh: true }
      : { lite: false });
    stateDetailLoaded = Boolean(state?.stateDetailLoaded);
    draftSelection = [...(state.selectedModelIds || [])];
    render();
  } catch (error) {
    showToast(error?.message || String(error), "error");
    console.error(error);
  } finally {
    stateDetailLoading = false;
  }
}

async function ensureSettingsDetailForSection(sectionId) {
  if (!SETTINGS_DETAIL_SECTIONS.has(sectionId) || settingsDetailLoaded || settingsDetailLoading) {
    return;
  }
  settingsDetailLoading = true;
  renderSettingsDetailLoading(sectionId);
  try {
    const nextState = await api.getState({ lite: true, settingsDetail: true });
    state = mergeStateWithRetainedDetailSlices(state, nextState);
    settingsDetailLoaded = Boolean(state?.settingsDetailLoaded);
    draftSelection = [...(state.selectedModelIds || [])];
    renderActiveSection(sectionId);
  } catch (error) {
    showToast(error?.message || String(error), "error");
    console.error(error);
  } finally {
    settingsDetailLoading = false;
  }
}

function renderDetailLoading(sectionId) {
  if (sectionId === "preflight" && els.startupCheckSummary && els.startupCheckList) {
    els.startupCheckSummary.innerHTML = `<div class="empty-state">正在读取体检结果...</div>`;
    els.startupCheckList.innerHTML = "";
  }
  if (sectionId === "resources" && els.resourceSummary && els.resourceList) {
    els.resourceSummary.innerHTML = "";
    els.resourceList.innerHTML = `<div class="empty-state">正在读取 Codex 资源...</div>`;
  }
  if (sectionId === "sessions" && els.sessionList) {
    els.sessionList.innerHTML = `<div class="empty-state">正在读取 Codex 会话...</div>`;
  }
}

function renderSettingsDetailLoading(sectionId) {
  if (sectionId === "settings" && els.backupList && !settingsDetailLoaded) {
    els.backupList.innerHTML = `<div class="empty-state">正在读取配置备份...</div>`;
  }
}

const RETAINED_DETAIL_SLICE_KEYS = [
  "startupCheck",
  "codexBackups",
  "codexResources",
  "codexSessions",
  "codexSessionTree",
  "codexProjectRecoveryPlan",
  "capabilityExecutionHistory",
  "imageGenerationHistory",
];

function mergeStateWithRetainedDetailSlices(previousState, nextState) {
  if (!previousState || !nextState || nextState.stateDetailLoaded) {
    return nextState;
  }
  const shouldRetainDetail = Boolean(previousState.stateDetailLoaded || stateDetailLoaded);
  const shouldRetainSettingsDetail = Boolean(previousState.settingsDetailLoaded || settingsDetailLoaded);
  if (!shouldRetainDetail && !shouldRetainSettingsDetail) {
    return nextState;
  }
  const merged = {
    ...nextState,
    stateDetailLoaded: Boolean(nextState.stateDetailLoaded || shouldRetainDetail),
    settingsDetailLoaded: Boolean(nextState.settingsDetailLoaded || shouldRetainSettingsDetail),
  };
  if (shouldRetainDetail) {
    for (const key of RETAINED_DETAIL_SLICE_KEYS) {
      if (previousState[key] !== undefined && previousState[key] !== null) {
        merged[key] = previousState[key];
      }
    }
  }
  if (shouldRetainSettingsDetail && previousState.codexBackups !== undefined && !nextState.settingsDetailLoaded) {
    merged.codexBackups = previousState.codexBackups;
  }
  return merged;
}

function render() {
  if (!state) {
    return;
  }

  const stateUnavailable = Boolean(state.stateUnavailable);
  if (stateUnavailable) {
    els.routerStatus.textContent = state.routerRunning
      ? "状态暂不可用 · Router 上次快照为运行中"
      : "状态暂不可用 · 显示上次快照";
    els.routerStatus.classList.toggle("muted", true);
    const cachedMode = state.mode === "hybrid"
      ? "混合模式"
      : state.mode === "all_api" ? "全部 API" : "";
    els.modeStatus.textContent = cachedMode
      ? `${cachedMode}（上次快照）`
      : "配置状态暂不可用";
    els.modeStatus.classList.toggle("muted", true);
  } else {
    els.routerStatus.textContent = state.routerRunning ? "Router 运行中" : "Router 未启动";
    els.routerStatus.classList.toggle("muted", !state.routerRunning);
    els.modeStatus.textContent = state.mode === "hybrid" ? "混合模式" : "全部 API";
    els.modeStatus.classList.toggle("muted", false);
  }
  els.appVersion.textContent = `v${state.appVersion || "-"}`;
  if (els.rootDir) {
    els.rootDir.textContent = state.rootDir;
  }
  els.selectedCount.textContent = String(draftSelection.length);
  const keySummary = keySummaryInfo();
  els.keySummary.textContent = keySummary.text;
  els.keySummaryDetail.textContent = keySummary.detail;
  els.bypassSystemProxy.checked = Boolean(state.desktopOptions?.bypassSystemProxy);
  els.localRateLimitEnabled.checked = Boolean(state.desktopOptions?.localRateLimitEnabled);
  els.duplicateRequestProtection.checked = state.desktopOptions?.duplicateRequestProtection === true;
  if (els.interceptCodexAuxiliaryTasks) {
    els.interceptCodexAuxiliaryTasks.checked = Boolean(state.desktopOptions?.interceptCodexAuxiliaryTasks);
  }
  els.autoSelectModel.checked = Boolean(state.desktopOptions?.autoSelectModel);
  els.autoFailover.checked = Boolean(state.desktopOptions?.autoFailover);
  if (document.activeElement !== els.routerPort) {
    els.routerPort.value = String(state.desktopOptions?.routerPort || 15722);
  }
  renderCodexAuxiliaryTaskSettings();
  renderSmartRoutingSettings();
  renderModelReferenceStatus();
  if (els.acceptanceReleaseDir) {
    els.acceptanceReleaseDir.textContent = state.desktopOptions?.acceptanceReleaseDir || "未选择";
  }
  renderUsageBudgetInputs();
  renderCodexDesktopPath();

  document.querySelectorAll(".mode-card").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  });

  renderActiveSection(currentSectionId());
  applyStateUnavailableWriteGuard(document, stateUnavailable);
}

function currentSectionId() {
  const active = document.querySelector(".nav-item.active")?.dataset?.section;
  if (active) {
    return active;
  }
  return document.querySelector(".section-panel:not(.hidden)")?.id || "dashboard";
}

function renderActiveSection(sectionId = currentSectionId()) {
  if (!state) {
    return;
  }
  if (sectionId === "dashboard") {
    renderRouterToggle();
    renderHealthStatus();
    renderOverviewUsage();
    return;
  }
  if (sectionId === "preflight") {
    renderStartupCheck();
    return;
  }
  if (sectionId === "models") {
    renderSelectedModels();
    renderModelPageView();
    renderProviderPreview();
    renderModelPool();
    renderProviderEditor();
    renderCustomEditor();
    renderCustomFormState();
    return;
  }
  if (sectionId === "capabilities") {
    renderCapabilityDiagnostics();
    renderCapabilityProviderList();
    renderCapabilityExecutionHistory();
    renderCapabilityProviderRunPresets();
    renderImageProviderSettings();
    renderImageGenerationHistory();
    return;
  }
  if (sectionId === "stats") {
    renderUsage();
    renderUsageBudgetInputs();
    renderUsageBudgetAlerts();
    renderUsageCostEstimate();
    return;
  }
  if (sectionId === "settings") {
    renderCodexAuxiliaryTaskSettings();
    renderSmartRoutingSettings();
    renderModelReferenceStatus();
    renderCodexDesktopPath();
    renderConfigPackageSyncStatus();
    renderConfigPackageImportBackupStatus();
    renderProfiles();
    renderBackups();
    return;
  }
  if (sectionId === "resources") {
    renderResources();
    return;
  }
  if (sectionId === "sessions") {
    renderSessions();
    return;
  }
  if (sectionId === "logs") {
    renderLogs(state.logs || []);
    return;
  }
  if (sectionId === "doubleQuota") {
    renderDoubleQuota();
  }
}

function renderDoubleQuota() {
  if (!els.doubleQuotaStatus) {
    return;
  }
  const current = doubleQuotaState;
  if (!current) {
    els.doubleQuotaStatus.textContent = "正在读取";
    els.doubleQuotaStatus.classList.add("muted");
    return;
  }
  const statusText = {
    running: "运行中",
    attached: "外部服务已连接",
    starting: "启动中",
    stopped: "已停止",
    error: "启动失败",
  }[current.status] || "状态未知";
  els.doubleQuotaStatus.textContent = statusText;
  els.doubleQuotaStatus.classList.toggle("muted", !current.running);
  els.doubleQuotaStatus.classList.toggle("failed", current.status === "error");
  const serviceRunning = Boolean(current.running);
  els.doubleQuotaServiceBanner.classList.toggle("running", serviceRunning);
  els.doubleQuotaServiceBanner.classList.toggle("stopped", !serviceRunning && current.status !== "starting");
  els.doubleQuotaServiceBanner.classList.toggle("starting", current.status === "starting");
  els.doubleQuotaServiceTitle.textContent = serviceRunning
    ? "双倍额度服务正在运行"
    : current.status === "starting"
      ? "双倍额度服务正在启动"
      : "双倍额度服务已关闭";
  els.doubleQuotaServiceDetail.textContent = serviceRunning
    ? `已监听 ${current.url || "http://127.0.0.1:4317/"}`
    : "当前不会接收 ChatGPT 网页请求";
  els.doubleQuotaUrl.textContent = current.url || "http://127.0.0.1:4317/";
  const extensionProtocol = current.extensionProtocolVersion
    ? ` · 扩展 ${current.extensionProtocolVersion}`
    : "";
  els.doubleQuotaVersion.textContent = current.serviceVersion || current.version
    ? `v${current.serviceVersion || current.version} · 协议 ${current.protocolVersion}${extensionProtocol}`
    : "-";
  els.doubleQuotaMcpStatus.textContent = current.mcpInstalled ? "已安装" : "尚未安装";
  if (document.activeElement !== els.doubleQuotaPort && current.port) {
    els.doubleQuotaPort.value = String(current.port);
  }
  const loadedExtensionDir = current.extensionLoadedDirs?.[0] || "";
  const extensionDisplayVersion = String(current.extensionDisplayVersion || current.extensionManifestVersion || "").trim();
  els.doubleQuotaExtensionPath.textContent = loadedExtensionDir || (current.extensionReady
    ? current.extensionDir
    : current.extensionDir || "尚未准备稳定扩展目录");
  const extensionAction = current.extensionAction || {};
  const extensionDiagnostics = current.extensionDiagnostics || {};
  if (els.doubleQuotaExtensionState) {
    const extensionCurrent = extensionAction.id === "current";
    const extensionOld = Boolean(extensionDiagnostics.version) && !extensionCurrent;
    els.doubleQuotaExtensionState.textContent = extensionCurrent
      ? "新版已连接"
      : extensionOld
        ? "旧版未生效"
        : "尚未安装";
    els.doubleQuotaExtensionState.classList.toggle("muted", !extensionCurrent && !extensionOld);
    els.doubleQuotaExtensionState.classList.toggle("failed", extensionOld);
  }
  if (els.manageDoubleQuotaExtension) {
    els.manageDoubleQuotaExtension.textContent = extensionAction.label || "安装扩展";
    els.manageDoubleQuotaExtension.disabled = extensionAction.complete === true;
  }
  if (els.doubleQuotaExtensionStatus) {
    const deploymentVerified = current.extensionDeployment?.verified === true;
    const statusMessage = extensionAction.id === "current"
      ? "扩展已连接，可以正常使用。"
      : extensionAction.id === "reinstall"
        ? "Chrome 仍在使用旧版扩展。点击“安装新版扩展”，然后按页面提示重新加载一次。"
        : extensionAction.id === "update"
          ? "新版扩展文件已准备好，请在 Chrome 扩展页点击“重新加载”。"
          : extensionAction.id === "repair"
            ? "扩展没有连接，请确认扩展已启用，然后重新检测。"
            : deploymentVerified
              ? "扩展文件已准备好，请在 Chrome 中完成安装。"
              : "正在准备扩展文件。";
    els.doubleQuotaExtensionStatus.textContent = extensionDisplayVersion
      ? `内置扩展 ${extensionDisplayVersion}。${statusMessage}`
      : statusMessage;
    els.doubleQuotaExtensionStatus.classList.toggle("failed", extensionAction.complete !== true);
  }
  els.doubleQuotaMessage.textContent = current.error || current.message ||
    (current.externalProcess
      ? "当前端口上的兼容服务由外部程序启动，CodexBridge 只附着使用，不会强制关闭。"
      : "服务独立运行，不会改变 15722 模型 Router。");
  els.startDoubleQuota.disabled = Boolean(current.running);
  els.stopDoubleQuota.disabled = !current.running;
  els.startDoubleQuota.textContent = current.running ? "服务已启动" : "启动服务";
  els.stopDoubleQuota.textContent = current.running ? "停止服务" : "服务已停止";
  els.openDoubleQuota.disabled = !current.running;
  els.saveDoubleQuotaPort.disabled = Boolean(current.running);
}

function renderCodexAuxiliaryTaskSettings() {
  if (!els.codexAuxiliaryModelId) {
    return;
  }
  const routeOptions = codexAuxiliaryRouteOptions();
  const savedRouteId = String(state.desktopOptions?.codexAuxiliaryModelId || "").trim();
  const selectedRouteId = savedRouteId || routeOptions[0]?.id || "";
  if (document.activeElement !== els.codexAuxiliaryModelId) {
    populateCodexAuxiliaryRouteSelect(els.codexAuxiliaryModelId, selectedRouteId, routeOptions);
  }
  els.codexAuxiliaryModelId.disabled = Boolean(els.interceptCodexAuxiliaryTasks?.checked);
}

function codexAuxiliaryRouteOptions() {
  const models = Array.isArray(state?.models) ? state.models : [];
  return models
    .map((model) => ({
      id: String(model.id || "").trim(),
      label: model.displayName || model.id || model.model,
      detail: model.model || routeProviderName(model.id) || "",
    }))
    .filter((model) => model.id);
}

function populateCodexAuxiliaryRouteSelect(select, selectedRouteId = "", routeOptions = codexAuxiliaryRouteOptions()) {
  const selected = String(selectedRouteId || "").trim();
  const hasSelected = selected && routeOptions.some((option) => option.id === selected);
  const selectedOnly = selected && !hasSelected
    ? [{ id: selected, label: selected, detail: "失效引用" }]
    : [];
  select.innerHTML = [
    ...selectedOnly.map((option) => smartRoutingRouteOptionHtml(option)),
    ...routeOptions.map((option) => smartRoutingRouteOptionHtml(option)),
  ].join("");
  select.value = hasSelected || selectedOnly.length ? selected : routeOptions[0]?.id || "";
}

function renderSmartRoutingSettings() {
  const smartRouting = state.desktopOptions?.smartRouting || {};
  const rules = smartRouting.autoSelectRules || {};
  SMART_ROUTING_RULE_CONTROLS.forEach((control) => {
    const modeEl = els[control.mode];
    const routeEl = els[control.route];
    if (!modeEl || !routeEl) {
      return;
    }
    const rule = normalizeSmartRoutingRuleForUi(rules[control.key]);
    if (document.activeElement !== modeEl) {
      modeEl.value = rule.mode;
    }
    populateSmartRoutingRouteSelect(routeEl, rule.routeId);
  });

  const failover = normalizeSmartRoutingFailoverForUi(smartRouting.failover);
  if (els.smartFailoverMode && document.activeElement !== els.smartFailoverMode) {
    els.smartFailoverMode.value = failover.mode;
  }
  SMART_ROUTING_ROUTE_CONTROLS.forEach((controlId, index) => {
    const select = els[controlId];
    if (select) {
      populateSmartRoutingRouteSelect(select, failover.routeIds[index] || "", { emptyLabel: `备用位 ${index + 1}` });
    }
  });
  syncSmartRoutingControlStates();
}

function syncSmartRoutingControlStates() {
  SMART_ROUTING_RULE_CONTROLS.forEach((control) => {
    const modeEl = els[control.mode];
    const routeEl = els[control.route];
    if (modeEl && routeEl) {
      routeEl.disabled = modeEl.value !== "route";
    }
  });
  const orderedFailover = els.smartFailoverMode?.value === "ordered";
  SMART_ROUTING_ROUTE_CONTROLS.forEach((controlId) => {
    const select = els[controlId];
    if (select) {
      select.disabled = !orderedFailover;
    }
  });
}

function smartRoutingOptionsFromInputs() {
  return {
    autoSelectRules: Object.fromEntries(
      SMART_ROUTING_RULE_CONTROLS.map((control) => [
        control.key,
        smartRoutingRuleFromInputs(els[control.mode], els[control.route]),
      ]),
    ),
    failover: {
      mode: smartRoutingModeValue(els.smartFailoverMode?.value, ["auto", "ordered", "off"]),
      routeIds: [...new Set(SMART_ROUTING_ROUTE_CONTROLS
        .map((controlId) => String(els[controlId]?.value || "").trim())
        .filter(Boolean))],
    },
  };
}

function smartRoutingRuleFromInputs(modeEl, routeEl) {
  return {
    mode: smartRoutingModeValue(modeEl?.value, ["auto", "route", "off"]),
    routeId: String(routeEl?.value || "").trim(),
  };
}

function smartRoutingModeValue(value, allowed) {
  return allowed.includes(value) ? value : "auto";
}

function normalizeSmartRoutingRuleForUi(rule = {}) {
  const source = rule && typeof rule === "object" ? rule : {};
  return {
    mode: smartRoutingModeValue(source.mode, ["auto", "route", "off"]),
    routeId: String(source.routeId || "").trim(),
  };
}

function normalizeSmartRoutingFailoverForUi(failover = {}) {
  const source = failover && typeof failover === "object" ? failover : {};
  const routeIds = Array.isArray(source.routeIds)
    ? source.routeIds
    : typeof source.routeIds === "string"
      ? source.routeIds.split(",")
      : [];
  return {
    mode: smartRoutingModeValue(source.mode, ["auto", "ordered", "off"]),
    routeIds: [...new Set(routeIds.map((routeId) => String(routeId || "").trim()).filter(Boolean))],
  };
}

function smartRoutingRouteOptions() {
  const models = Array.isArray(state?.modelPresets) ? state.modelPresets : [];
  const selected = new Set([...(draftSelection || []), ...(state?.selectedModelIds || [])]);
  return models
    .map((model) => ({
      id: String(model.presetId || "").trim(),
      label: model.displayName || model.model || model.presetId,
      detail: model.model || providerName(model.providerId) || "",
      selected: selected.has(model.presetId),
    }))
    .filter((model) => model.id)
    .sort((left, right) => Number(right.selected) - Number(left.selected) || left.label.localeCompare(right.label));
}

function populateSmartRoutingRouteSelect(select, selectedRouteId = "", { emptyLabel = "自动选择模型" } = {}) {
  const selected = String(selectedRouteId || "").trim();
  const options = smartRoutingRouteOptions();
  const hasSelected = selected && options.some((option) => option.id === selected);
  const selectedOnly = selected && !hasSelected
    ? [{ id: selected, label: selected, detail: "失效引用" }]
    : [];
  select.innerHTML = [
    `<option value="">${escapeHtml(emptyLabel)}</option>`,
    ...selectedOnly.map((option) => smartRoutingRouteOptionHtml(option)),
    ...options.map((option) => smartRoutingRouteOptionHtml(option)),
  ].join("");
  select.value = selected;
}

function smartRoutingRouteOptionHtml(option) {
  const detail = option.detail ? ` · ${option.detail}` : "";
  return `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}${escapeHtml(detail)}</option>`;
}

function renderModelReferenceStatus() {
  if (!els.modelReferenceStatus) {
    return;
  }
  const status = state.modelReferenceStatus || {};
  const issues = Array.isArray(status.issues) ? status.issues : [];
  if (els.repairModelReferences) {
    els.repairModelReferences.disabled = issues.length === 0;
  }
  if (!issues.length) {
    els.modelReferenceStatus.innerHTML = `
      <div class="model-reference-ok">
        <strong>模型引用正常</strong>
        <span>模型选择、辅助任务、智能切换和备用顺序都指向当前可用模型。</span>
      </div>
    `;
    return;
  }
  const visibleIssues = issues.slice(0, 4);
  const restCount = issues.length - visibleIssues.length;
  els.modelReferenceStatus.innerHTML = `
    <div class="model-reference-warning">
      <div>
        <strong>${formatNumber(issues.length)} 项模型引用失效</strong>
        <span>可以自动修复为当前可用模型；模型栏里的失效项也可以直接移除并保存。</span>
      </div>
      <ul>
        ${visibleIssues.map((issue) => modelReferenceIssueItem(issue)).join("")}
        ${restCount > 0 ? `<li>还有 ${formatNumber(restCount)} 项...</li>` : ""}
      </ul>
    </div>
  `;
  bindModelReferenceIssueActions(els.modelReferenceStatus);
}

function modelReferenceIssueText(issue = {}) {
  const current = String(issue.value || "").trim() || "空";
  const repaired = String(issue.repairedValue || "").trim();
  const repairText = repaired
    ? `可修复为 ${repaired}`
    : "可改为自动选择";
  return `${issue.label || "模型引用"}：${current}，${repairText}`;
}

function modelReferenceIssueItem(issue = {}) {
  const value = String(issue.value || "").trim();
  const removeAction = issue.kind === "selection" && value
    ? `<button class="mini-link danger" type="button" data-remove-stale-model-reference="${escapeHtml(value)}">移除</button>`
    : "";
  return `
    <li>
      <span>${escapeHtml(modelReferenceIssueText(issue))}</span>
      <span class="model-reference-actions">
        <button class="mini-link" type="button" data-repair-stale-model-reference="${escapeHtml(value)}">修复</button>
        ${removeAction}
      </span>
    </li>
  `;
}

function bindModelReferenceIssueActions(root = document) {
  root.querySelectorAll("[data-repair-stale-model-reference]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runAction(button, () => repairStaleModelReferences(button));
    });
  });
  root.querySelectorAll("[data-remove-stale-model-reference]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeStaleModelReference(button.dataset.removeStaleModelReference, button);
    });
  });
}

async function repairStaleModelReferences() {
  const response = await api.repairModelReferences();
  const message = modelReferenceRepairToast(response?.result);
  state = response?.state || await api.getState();
  draftSelection = [...(state.selectedModelIds || [])];
  render();
  showToast(message);
}

function removeStaleModelReference(value, button) {
  return runAction(button, async () => {
    const target = String(value || "").trim();
    if (!target) {
      throw new Error("没有找到要移除的失效模型。");
    }
    const rawSelection = Array.isArray(state?.modelReferenceStatus?.rawSelectedModelIds)
      ? state.modelReferenceStatus.rawSelectedModelIds
      : [...draftSelection];
    const nextSelection = rawSelection.filter((id) => String(id || "").trim() !== target);
    state = await api.saveModelSelection(nextSelection);
    draftSelection = [...(state.selectedModelIds || [])];
    render();
    showToast(`已移除失效模型引用：${target}`);
  });
}

function modelReferenceRepairToast(result = {}) {
  const issues = Array.isArray(result?.beforeStatus?.issues) ? result.beforeStatus.issues : [];
  if (!issues.length) {
    return "模型引用已检查，当前没有失效项。";
  }
  if (issues.length === 1) {
    const issue = issues[0];
    const value = String(issue.value || "").trim() || "失效模型";
    const repaired = String(issue.repairedValue || "").trim();
    return repaired
      ? `已修复失效模型引用：${value} -> ${repaired}`
      : `已修复失效模型引用：${value}`;
  }
  return `已修复 ${formatNumber(issues.length)} 项失效模型引用，模型栏已更新为当前可用模型。`;
}

function providerSaveRepairToast(sync = {}) {
  const result = sync?.repair || sync;
  const issues = Array.isArray(result?.beforeStatus?.issues) ? result.beforeStatus.issues : [];
  if (!issues.length && !sync?.needsRepair) {
    return "供应商设置已保存，相关模型会使用新的 Base URL 和接口类型。";
  }
  return `供应商设置已保存，并已修复 ${formatNumber(Math.max(issues.length, 1))} 项失效模型引用。`;
}

function renderCodexDesktopPath() {
  if (!els.codexDesktopPath) {
    return;
  }
  const launchPath = codexDesktopLaunchPath();
  els.codexDesktopPath.textContent = launchPath || "自动查找";
  els.codexDesktopPath.title = launchPath || "自动查找常见安装路径、开始菜单快捷方式和 CHATGPT_DESKTOP_EXE / CODEX_DESKTOP_EXE";
}

function codexDesktopLaunchPath() {
  return state.desktopOptions?.codexDesktopLaunchTarget || state.desktopOptions?.codexDesktopExe || "";
}

function imageProviderConfig() {
  return state?.imageProviderConfig || { providers: [], defaultProviderId: "" };
}

function imageProviders() {
  return Array.isArray(imageProviderConfig().providers) ? imageProviderConfig().providers : [];
}

function providerHasCapability(provider = {}, capability = "") {
  const target = String(capability || "").trim();
  if (!target) {
    return false;
  }
  const capabilities = Array.isArray(provider.capabilities) ? provider.capabilities : [];
  return capabilities.includes(target) || String(provider.capability || "").trim() === target;
}

function customCapabilityProviders() {
  return Array.isArray(state?.capabilityProviders)
    ? state.capabilityProviders.filter((provider) =>
        provider.source === "capabilityProviders" &&
        !providerHasCapability(provider, "image_generation")
      )
    : [];
}

function capabilityProviderLastTestText(provider = {}) {
  const lastTest = provider.lastTest && typeof provider.lastTest === "object" ? provider.lastTest : null;
  if (!lastTest) {
    return "最近体检：尚未测试";
  }
  const duration = Number.isFinite(Number(lastTest.durationMs))
    ? ` · ${formatDuration(lastTest.durationMs)}`
    : "";
  const checkedAt = lastTest.checkedAt ? ` · ${formatTime(lastTest.checkedAt)}` : "";
  if (lastTest.ok) {
    return `最近体检：通过${duration}${checkedAt}`;
  }
  const message = String(lastTest.message || lastTest.error?.message || "请重新测试").trim();
  return `最近体检：失败${duration}${checkedAt} · ${message}`;
}

function capabilityProviderLastTestClass(provider = {}) {
  const lastTest = provider.lastTest && typeof provider.lastTest === "object" ? provider.lastTest : null;
  if (!lastTest) {
    return "untested";
  }
  return lastTest.ok ? "passed" : "failed";
}

function renderCapabilityProviderList() {
  if (!els.capabilityProviderList) {
    return;
  }
  const providers = customCapabilityProviders();
  if (!providers.length) {
    els.capabilityProviderList.innerHTML = `
      <div class="empty-state">
        暂未配置扩展能力供应商。可以先添加供应商，再进行试运行。
      </div>
    `;
    return;
  }
  els.capabilityProviderList.innerHTML = providers.map((provider) => {
    const defaultText = capabilityProviderDefaultCapabilitiesText(provider);
    const testState = capabilityProviderLastTestClass(provider);
    return `
    <div class="capability-provider-manage-item ${defaultText ? "default" : ""} ${provider.enabled === false ? "disabled" : ""}">
      <div>
        <strong>${escapeHtml(provider.displayName || provider.name || provider.id)}</strong>
        <span>${escapeHtml((provider.capabilities || []).map(capabilityProviderCapabilityLabel).join("、") || "未知能力")} · ${escapeHtml(capabilityProviderAdapterLabel(provider.adapter))}</span>
        <small>${escapeHtml(provider.model || provider.endpoint || provider.baseUrl || "本地能力")}</small>
        <small>状态：可体检/试运行 · 优先级 ${Number(provider.priority || 0)}</small>
        ${provider.apiKeyEnv ? `<small>Key：${escapeHtml(provider.apiKeyEnv)}</small>` : ""}
        <small class="capability-provider-test-state ${testState}">${escapeHtml(capabilityProviderLastTestText(provider))}</small>
      </div>
      <div class="image-provider-item-actions">
        ${defaultText ? `<span class="status-pill">默认试运行：${escapeHtml(defaultText)}</span>` : `<button class="ghost-button light small" type="button" data-capability-provider-default="${escapeHtml(provider.id)}">设为默认试运行</button>`}
        <button class="ghost-button light small" type="button" data-capability-provider-edit="${escapeHtml(provider.id)}">编辑</button>
        <button class="plain-button small" type="button" data-capability-provider-remove="${escapeHtml(provider.id)}">移除</button>
      </div>
    </div>
    `;
  }).join("");

  els.capabilityProviderList.querySelectorAll("[data-capability-provider-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const provider = customCapabilityProviders().find((item) => item.id === button.dataset.capabilityProviderEdit);
      if (provider) {
        fillCapabilityProviderForm(provider, { makeDefault: Boolean(provider.default) });
      }
    });
  });
  els.capabilityProviderList.querySelectorAll("[data-capability-provider-default]").forEach((button) => {
    button.addEventListener("click", () => {
      const provider = customCapabilityProviders().find((item) => item.id === button.dataset.capabilityProviderDefault);
      if (provider) {
        fillCapabilityProviderForm(provider, { makeDefault: true });
        saveCapabilityProviderSettings(button);
      }
    });
  });
  els.capabilityProviderList.querySelectorAll("[data-capability-provider-remove]").forEach((button) => {
    button.addEventListener("click", () => removeCapabilityProvider(button));
  });
}

function fillCapabilityProviderForm(provider = {}, options = {}) {
  const capability = provider.capability || provider.capabilities?.[0] || "ocr";
  setValue("#capabilityProviderId", provider.id || "");
  setValue("#capabilityProviderName", provider.displayName || provider.name || "");
  setValue("#capabilityProviderCapability", capability);
  setCapabilityProviderExtraCapabilities(provider.capabilities || [capability]);
  setValue("#capabilityProviderAdapter", provider.adapter || "generic_http");
  setValue("#capabilityProviderBaseUrl", provider.baseUrl || "");
  setValue(
    "#capabilityProviderEndpoint",
    Object.hasOwn(provider, "endpoint") ? provider.endpoint : defaultCapabilityProviderEndpoint(capability),
  );
  setValue("#capabilityProviderModel", provider.model || "");
  setValue(
    "#capabilityProviderKeyEnv",
    Object.hasOwn(provider, "apiKeyEnv") ? provider.apiKeyEnv : defaultCapabilityProviderKeyEnv(capability),
  );
  setValue("#capabilityProviderApiKey", "");
  setValue(
    "#capabilityProviderDefaults",
    provider.defaults && Object.keys(provider.defaults).length
      ? JSON.stringify(provider.defaults, null, 2)
      : "",
  );
  setValue("#capabilityProviderPriority", String(Number(provider.priority || 0)));
  const enabled = document.querySelector("#capabilityProviderEnabled");
  if (enabled) {
    enabled.checked = provider.enabled !== false;
  }
  const makeDefault = document.querySelector("#capabilityProviderMakeDefault");
  if (makeDefault) {
    makeDefault.checked = Boolean(options.makeDefault);
  }
  syncCapabilityProviderAdapterFields();
  renderCapabilityProviderRunPresets();
  renderCapabilityProviderTestResult(null);
  if (els.capabilityProviderRunInput) {
    els.capabilityProviderRunInput.value = defaultCapabilityProviderRunInput(capability);
  }
  renderCapabilityProviderRunResult(null);
}

function fillCapabilityProviderTemplate(templateId) {
  const template = CAPABILITY_PROVIDER_TEMPLATES[templateId];
  if (!template) {
    return;
  }
  fillCapabilityProviderForm(
    {
      displayName: template.name,
      capability: template.capability,
      capabilities: template.capabilities || [template.capability],
      adapter: template.adapter,
      baseUrl: template.baseUrl,
      endpoint: template.endpoint,
      model: template.model,
      apiKeyEnv: template.apiKeyEnv,
      defaults: template.defaults,
      priority: template.priority || 0,
      enabled: true,
    },
    { makeDefault: Boolean(template.makeDefault) },
  );
  if (els.capabilityProviderRunInput) {
    els.capabilityProviderRunInput.value = JSON.stringify(template.runInput || {}, null, 2);
  }
  renderCapabilityProviderRunPresets();
  renderCapabilityProviderTestResult(null);
  renderCapabilityProviderRunResult(null);
  const localAdapter = capabilityProviderIsLocalAdapter(template.adapter);
  showToast(
    localAdapter
      ? `已填入 ${template.name}；本地桥接不需要 Key，直接保存后可体检或试运行。`
      : `已填入 ${template.name}，保存前请按供应商文档替换地址和 Key。`,
  );
}

function resetCapabilityProviderForm() {
  els.capabilityProviderForm?.reset();
  setValue("#capabilityProviderId", "");
  setValue("#capabilityProviderCapability", "ocr");
  setCapabilityProviderExtraCapabilities(["ocr"]);
  setValue("#capabilityProviderAdapter", "generic_http");
  setValue("#capabilityProviderEndpoint", "/ocr");
  setValue("#capabilityProviderKeyEnv", "OCR_API_KEY");
  setValue("#capabilityProviderDefaults", "");
  setValue("#capabilityProviderPriority", "0");
  const enabled = document.querySelector("#capabilityProviderEnabled");
  if (enabled) {
    enabled.checked = true;
  }
  const makeDefault = document.querySelector("#capabilityProviderMakeDefault");
  if (makeDefault) {
    makeDefault.checked = false;
  }
  syncCapabilityProviderAdapterFields();
  renderCapabilityProviderRunPresets();
  renderCapabilityProviderTestResult(null);
  if (els.capabilityProviderRunInput) {
    els.capabilityProviderRunInput.value = defaultCapabilityProviderRunInput("ocr");
  }
  renderCapabilityProviderRunResult(null);
}

function selectedCapabilityProviderValues(primary = valueOf("#capabilityProviderCapability") || "ocr") {
  const values = [String(primary || "").trim()];
  document.querySelectorAll("[data-capability-provider-extra]:checked").forEach((input) => {
    values.push(String(input.value || "").trim());
  });
  return Array.from(new Set(values.filter(Boolean)));
}

function setCapabilityProviderExtraCapabilities(values = []) {
  const primary = valueOf("#capabilityProviderCapability") || "ocr";
  const selected = new Set([primary, ...(Array.isArray(values) ? values : [])].filter(Boolean));
  document.querySelectorAll("[data-capability-provider-extra]").forEach((input) => {
    const value = String(input.value || "").trim();
    input.checked = selected.has(value);
    input.disabled = value === primary;
  });
}

function capabilityProviderIsLocalAdapter(adapter) {
  return LOCAL_CAPABILITY_ADAPTERS.has(String(adapter || "").trim());
}

function syncCapabilityProviderAdapterFields() {
  const adapter = valueOf("#capabilityProviderAdapter") || "generic_http";
  const localAdapter = capabilityProviderIsLocalAdapter(adapter);
  const hint = document.querySelector("#capabilityProviderLocalHint");
  els.capabilityProviderForm?.classList.toggle("local-capability", localAdapter);
  if (hint) {
    hint.hidden = !localAdapter;
    const hintText = hint.querySelector("span");
    if (hintText) {
      hintText.textContent = LOCAL_CAPABILITY_HINT;
    }
  }
  document.querySelectorAll("[data-remote-capability-field]").forEach((field) => {
    field.classList.toggle("disabled-field", localAdapter);
    field.querySelectorAll("input, select, textarea").forEach((input) => {
      input.dataset.defaultPlaceholder = input.dataset.defaultPlaceholder || input.placeholder;
      input.disabled = localAdapter;
      input.placeholder = localAdapter ? "本地桥接无需填写" : input.dataset.defaultPlaceholder || input.placeholder;
    });
  });
}

function renderCapabilityProviderRunPresets() {
  if (!els.capabilityProviderRunPresets) {
    return;
  }
  const adapter = valueOf("#capabilityProviderAdapter") || "generic_http";
  const capability = valueOf("#capabilityProviderCapability") || "ocr";
  const capabilities = new Set(selectedCapabilityProviderValues(capability));
  const presets = CAPABILITY_RUN_PRESETS.filter((preset) => {
    const adapters = Array.isArray(preset.adapters) ? preset.adapters : [];
    const requiredCapabilities = Array.isArray(preset.capabilities) ? preset.capabilities : [];
    return adapters.includes(adapter) && requiredCapabilities.every((item) => capabilities.has(item));
  });
  if (!presets.length) {
    els.capabilityProviderRunPresets.innerHTML = "";
    return;
  }
  els.capabilityProviderRunPresets.innerHTML = `
    <span>常用动作</span>
    ${presets.map((preset) => `
      <button class="ghost-button light small" type="button" data-capability-run-preset="${escapeHtml(preset.id)}">
        ${escapeHtml(preset.label)}
      </button>
    `).join("")}
  `;
  els.capabilityProviderRunPresets.querySelectorAll("[data-capability-run-preset]").forEach((button) => {
    button.addEventListener("click", () => fillCapabilityProviderRunPreset(button.dataset.capabilityRunPreset));
  });
}

function fillCapabilityProviderRunPreset(presetId) {
  const preset = CAPABILITY_RUN_PRESETS.find((item) => item.id === presetId);
  if (!preset || !els.capabilityProviderRunInput) {
    return;
  }
  els.capabilityProviderRunInput.value = JSON.stringify(preset.input, null, 2);
  renderCapabilityProviderRunResult(null);
  showToast(`已填入试运行动作：${preset.label}`);
}

function capabilityProviderPayloadFromForm() {
  const capability = valueOf("#capabilityProviderCapability") || "ocr";
  const adapter = valueOf("#capabilityProviderAdapter") || "generic_http";
  const localAdapter = capabilityProviderIsLocalAdapter(adapter);
  const defaultsText = valueOf("#capabilityProviderDefaults");
  let defaults = {};
  if (defaultsText) {
    defaults = JSON.parse(defaultsText);
    if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
      throw new Error("默认请求参数 JSON 必须是一个对象。");
    }
  }
  return {
    id: valueOf("#capabilityProviderId"),
    name: valueOf("#capabilityProviderName"),
    capability,
    capabilities: selectedCapabilityProviderValues(capability),
    adapter,
    baseUrl: localAdapter ? "" : valueOf("#capabilityProviderBaseUrl"),
    endpoint: localAdapter ? "" : valueOf("#capabilityProviderEndpoint") || defaultCapabilityProviderEndpoint(capability),
    model: localAdapter ? "" : valueOf("#capabilityProviderModel"),
    apiKeyEnv: localAdapter ? "" : valueOf("#capabilityProviderKeyEnv") || defaultCapabilityProviderKeyEnv(capability),
    apiKey: localAdapter ? "" : valueOf("#capabilityProviderApiKey"),
    defaults,
    enabled: document.querySelector("#capabilityProviderEnabled")?.checked !== false,
    priority: Number(valueOf("#capabilityProviderPriority") || 0),
    makeDefault: Boolean(document.querySelector("#capabilityProviderMakeDefault")?.checked),
  };
}

function testCapabilityProviderFromForm(button) {
  return runAction(button, async () => {
    renderCapabilityProviderTestResult({ pending: true });
    const response = await api.testCapabilityProvider({
      provider: capabilityProviderPayloadFromForm(),
    });
    state = response?.state || await api.getState();
    renderCapabilityProviderList();
    renderCapabilityProviderTestResult(response);
    showToast(
      response?.ok ? "能力供应商体检通过。" : response?.message || response?.error || "能力供应商体检失败。",
      response?.ok ? "success" : "error",
    );
  });
}

function executeCapabilityProviderFromForm(button) {
  return runAction(button, async () => {
    const parsed = parseCapabilityProviderRunInput();
    if (!parsed.ok) {
      renderCapabilityProviderRunResult({
        ok: false,
        response: { output_text: parsed.message },
      });
      showToast(parsed.message, "error");
      return;
    }
    const provider = capabilityProviderPayloadFromForm();
    renderCapabilityProviderRunResult({ pending: true });
    const response = await api.executeCapabilityProvider({
      provider,
      providerId: provider.id,
      capability: provider.capability,
      input: parsed.value,
      sourceModel: "desktop-manual-run",
      requestId: `manual_${Date.now()}`,
    });
    state = response?.state || state;
    renderCapabilityProviderRunResult(response);
    renderCapabilityExecutionHistory();
    showToast(
      response?.ok ? "能力试运行已完成。" : response?.response?.output_text || response?.error?.message || "能力试运行失败。",
      response?.ok ? "success" : "error",
    );
  });
}

function parseCapabilityProviderRunInput() {
  const text = (els.capabilityProviderRunInput?.value || "").trim();
  if (!text) {
    return { ok: true, value: "" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      message: `请求输入不是有效 JSON：${error.message || String(error)}`,
    };
  }
}

function renderCapabilityProviderTestResult(result) {
  if (!els.capabilityProviderTestResult) {
    return;
  }
  if (!result) {
    els.capabilityProviderTestResult.innerHTML = "";
    return;
  }
  if (result.pending) {
    els.capabilityProviderTestResult.innerHTML = `<div class="test-result-card pending">正在测试能力供应商...</div>`;
    return;
  }
  const detail = [
    result.endpoint ? `Endpoint：${result.endpoint}` : "",
    Number.isFinite(Number(result.durationMs)) ? `耗时 ${formatDuration(result.durationMs)}` : "",
  ].filter(Boolean).join(" · ");
  if (!result.ok) {
    els.capabilityProviderTestResult.innerHTML = `
      <div class="test-result-card error">
        <strong>能力体检失败</strong>
        <p>${escapeHtml(result.message || result.error || "能力供应商没有返回可用结果。")}</p>
        ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
        ${imageProviderHealthChecksList(result.checks)}
      </div>
    `;
    return;
  }
  els.capabilityProviderTestResult.innerHTML = `
    <div class="test-result-card success compact">
      <div>
        <strong>${escapeHtml(result.message || "能力体检通过")}</strong>
        ${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
        ${imageProviderHealthChecksList(result.checks)}
      </div>
    </div>
  `;
}

function renderCapabilityProviderRunResult(result) {
  if (!els.capabilityProviderRunResult) {
    return;
  }
  if (!result) {
    els.capabilityProviderRunResult.innerHTML = "";
    return;
  }
  if (result.pending) {
    els.capabilityProviderRunResult.innerHTML = `<div class="test-result-card pending">正在试运行能力供应商...</div>`;
    return;
  }
  const outputText = result.response?.output_text || result.error?.message || "";
  const detail = [
    result.providerId ? `供应商：${result.providerId}` : "",
    result.endpoint ? `Endpoint：${result.endpoint}` : "",
    Number.isFinite(Number(result.durationMs)) ? `耗时 ${formatDuration(result.durationMs)}` : "",
  ].filter(Boolean).join(" · ");
  const raw = capabilityProviderRunRawResult(result);
  const assetPreview = capabilityProviderRunAssetPreview(result);
  els.capabilityProviderRunResult.innerHTML = `
    <div class="test-result-card ${result.ok ? "success" : "error"} capability-run-card">
      <div>
        <strong>${escapeHtml(result.ok ? "试运行完成" : "试运行失败")}</strong>
        ${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
        ${outputText ? `<p>${escapeHtml(outputText)}</p>` : ""}
      </div>
      ${assetPreview}
      ${raw ? `<pre>${escapeHtml(raw)}</pre>` : ""}
    </div>
  `;
  els.capabilityProviderRunResult.querySelectorAll("[data-capability-run-open]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const target = button.dataset.capabilityRunOpen;
        if (!target) {
          return;
        }
        const response = await api.openFolder(target);
        if (!response?.ok) {
          throw new Error(response?.message || "打开能力结果目录失败。");
        }
      }),
    );
  });
  els.capabilityProviderRunResult.querySelectorAll("[data-capability-run-reveal]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const target = button.dataset.capabilityRunReveal;
        if (!target) {
          return;
        }
        const response = await api.revealFile(target);
        if (!response?.ok) {
          throw new Error(response?.message || "定位能力结果文件失败。");
        }
      }),
    );
  });
}

function capabilityProviderRunAssetPreview(result = {}) {
  const localPath = String(
    result.response?.localPath ||
      result.savedResult?.localPath ||
      result.output?.localPath ||
      "",
  ).trim();
  if (!localPath) {
    return "";
  }
  const mimeType = String(
    result.response?.mimeType ||
      result.savedResult?.mimeType ||
      result.output?.mimeType ||
      "",
  ).trim();
  const inlineSrc = capabilityProviderRunInlineAssetSource(result, mimeType);
  const folder = folderFromPath(localPath);
  const media = inlineSrc
    ? `<img src="${escapeHtml(inlineSrc)}" alt="能力试运行结果" />`
    : mimeType.startsWith("audio/")
      ? `<audio controls src="${escapeHtml(localFileUrl(localPath))}"></audio>`
      : mimeType.startsWith("video/")
        ? `<video controls src="${escapeHtml(localFileUrl(localPath))}"></video>`
        : `<div class="capability-run-file ${mimeType.startsWith("image/") ? "capability-run-saved-only" : ""}">${mimeType.startsWith("image/") ? "大文件已保存" : "FILE"}</div>`;
  return `
    <div class="capability-run-asset">
      ${media}
      <div>
        <strong>本地结果</strong>
        <small title="${escapeHtml(localPath)}">${escapeHtml(localPath)}</small>
        <div class="capability-run-asset-actions">
          <button class="ghost-button light small" type="button" data-capability-run-reveal="${escapeHtml(localPath)}">定位文件</button>
          <button class="ghost-button light small" type="button" data-capability-run-open="${escapeHtml(folder)}" ${folder ? "" : "disabled"}>打开文件夹</button>
        </div>
      </div>
    </div>
  `;
}

function capabilityProviderRunInlineAssetSource(result = {}, mimeType = "") {
  const base64 = String(
    result.response?.base64 ||
      result.savedResult?.base64 ||
      result.output?.base64 ||
      "",
  ).trim();
  if (!base64 || !String(mimeType || "").toLowerCase().startsWith("image/")) {
    return "";
  }
  return base64.startsWith("data:")
    ? base64
    : `data:${mimeType || "image/png"};base64,${base64}`;
}

function localFileUrl(target = "") {
  const normalized = String(target || "").trim().replace(/\\/g, "/");
  if (!normalized) {
    return "";
  }
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }
  if (normalized.startsWith("//")) {
    return `file:${encodeURI(normalized)}`;
  }
  return encodeURI(normalized);
}

function capabilityProviderRunRawResult(result = {}) {
  const raw = result.upstream || result.response?.data || result.response?.error || result.error || null;
  if (!raw) {
    return "";
  }
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

function defaultCapabilityProviderKeyEnv(capability) {
  if (capability === "web_search") {
    return "SEARCH_API_KEY";
  }
  if (capability === "browser") {
    return "BROWSER_API_KEY";
  }
  if (capability === "computer_use") {
    return "COMPUTER_USE_API_KEY";
  }
  if (capability === "file_processing") {
    return "FILE_PROCESSING_API_KEY";
  }
  if (capability === "webpage_screenshot") {
    return "SCREENSHOT_API_KEY";
  }
  if (capability === "speech") {
    return "SPEECH_API_KEY";
  }
  if (capability === "video") {
    return "VIDEO_API_KEY";
  }
  return "OCR_API_KEY";
}

function defaultCapabilityProviderRunInput(capability) {
  const example = capability === "web_search"
    ? { query: "CodexBridge 最新消息", limit: 5 }
    : capability === "browser"
      ? { action: "read_url", url: "https://example.com" }
      : capability === "computer_use"
        ? { action: "open_app", app: "notepad" }
      : capability === "file_processing"
        ? { path: "C:/path/to/file.pdf", task: "提取正文摘要" }
        : capability === "webpage_screenshot"
          ? { action: "screenshot_url", url: "https://example.com", viewport: "desktop", fullPage: true }
          : capability === "speech"
            ? { text: "你好，欢迎使用 CodexBridge。", voice: "default" }
            : capability === "video"
              ? { prompt: "生成一段 5 秒产品演示视频", duration: 5 }
              : { imageUrl: "https://example.com/image.png" };
  return JSON.stringify(example, null, 2);
}

function defaultCapabilityProviderEndpoint(capability) {
  if (capability === "web_search") {
    return "/web-search";
  }
  if (capability === "browser") {
    return "/browser";
  }
  if (capability === "computer_use") {
    return "/computer-use";
  }
  if (capability === "file_processing") {
    return "/files";
  }
  if (capability === "webpage_screenshot") {
    return "/screenshots";
  }
  if (capability === "speech") {
    return "/speech";
  }
  if (capability === "video") {
    return "/videos";
  }
  return "/ocr";
}

function capabilityProviderAdapterLabel(adapter) {
  if (adapter === "local_browser") {
    return "本地浏览器能力";
  }
  if (adapter === "local_file") {
    return "本地文件处理";
  }
  if (adapter === "local_computer_use") {
    return "本地 Computer Use";
  }
  return "通用 HTTP 接口";
}

function renderImageProviderSettings() {
  if (!els.imageProviderList) {
    return;
  }
  const config = imageProviderConfig();
  const providers = imageProviders();
  if (!providers.length) {
    els.imageProviderList.innerHTML = `
      <div class="empty-state">
        还没有图片供应商。可以点“填入硅基流动示例”，再填写 API Key 保存为默认图片代理。
      </div>
    `;
    return;
  }
  els.imageProviderList.innerHTML = providers
    .map((provider) => {
      const isDefault = provider.id === config.defaultProviderId;
      return `
        <div class="image-provider-item ${isDefault ? "default" : ""} ${provider.enabled === false ? "disabled" : ""}">
          <div>
            <strong>${escapeHtml(provider.name)}</strong>
            <span>${escapeHtml(imageProviderAdapterLabel(provider.adapter))} · ${escapeHtml(provider.model)} · ${escapeHtml(provider.size || "自动/模型默认")}</span>
            <small>${escapeHtml(imageProviderMarketMeta(provider, isDefault))}</small>
            <small>${escapeHtml(imageProviderLastTestMeta(provider))}</small>
            <small>Key：${escapeHtml(provider.apiKeyEnv || "-")}${isDefault ? " · 默认" : ""}</small>
          </div>
          <div class="image-provider-item-actions">
            ${isDefault ? `<span class="status-pill">默认</span>` : `<button class="ghost-button light small" type="button" data-image-provider-default="${escapeHtml(provider.id)}">设为默认</button>`}
            <button class="ghost-button light small" type="button" data-image-provider-test="${escapeHtml(provider.id)}">测试生图</button>
            <button class="ghost-button light small" type="button" data-image-provider-edit="${escapeHtml(provider.id)}">编辑</button>
            <button class="plain-button small" type="button" data-image-provider-remove="${escapeHtml(provider.id)}">移除</button>
          </div>
        </div>
      `;
    })
    .join("");

  els.imageProviderList.querySelectorAll("[data-image-provider-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const provider = imageProviders().find((item) => item.id === button.dataset.imageProviderEdit);
      if (provider) {
        fillImageProviderForm(provider, { makeDefault: provider.id === config.defaultProviderId });
      }
    });
  });
  els.imageProviderList.querySelectorAll("[data-image-provider-default]").forEach((button) => {
    button.addEventListener("click", () => {
      const provider = imageProviders().find((item) => item.id === button.dataset.imageProviderDefault);
      if (provider) {
        fillImageProviderForm(provider, { makeDefault: true });
        saveImageProviderSettings(button);
      }
    });
  });
  els.imageProviderList.querySelectorAll("[data-image-provider-test]").forEach((button) => {
    button.addEventListener("click", () => testSavedImageProvider(button));
  });
  els.imageProviderList.querySelectorAll("[data-image-provider-remove]").forEach((button) => {
    button.addEventListener("click", () => removeImageProvider(button));
  });
}

function imageProviderMarketMeta(provider = {}, isDefault = false) {
  const parts = [];
  if (provider.enabled === false) {
    parts.push("停用");
  } else if (isDefault) {
    parts.push("默认");
  } else {
    parts.push("备用");
  }
  parts.push(`优先级 ${Number(provider.priority || 0)}`);
  return parts.join(" · ");
}

function imageProviderLastTestMeta(provider = {}) {
  const test = provider.lastTest && typeof provider.lastTest === "object" ? provider.lastTest : null;
  if (!test) {
    return "尚未测试";
  }
  const duration = Number.isFinite(Number(test.durationMs)) ? ` · ${formatDuration(test.durationMs)}` : "";
  if (test.ok) {
    return `最近测试通过${duration}`;
  }
  const message = String(test.message || test.error?.message || "").trim();
  return `最近测试失败${duration}${message ? ` · ${message}` : ""}`;
}

function filteredImageGenerationHistory(items = []) {
  return items.filter((item) => imageHistoryMatchesFilter(item));
}

function imageHistoryMatchesFilter(item = {}) {
  const localPath = imageHistoryLocalPath(item);
  if (imageHistoryFilter === "asset" && !localPath) {
    return false;
  }
  if (imageHistoryFilter === "thumbnail" && !item.thumbnailDataUrl) {
    return false;
  }
  if (imageHistoryFilter === "failed" && item.ok !== false) {
    return false;
  }
  const needle = imageHistorySearchText.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return imageHistorySearchTextForItem(item, localPath).includes(needle);
}

function imageHistoryLocalPath(item = {}) {
  return String(item.localPath || item.asset?.localPath || item.output?.localPath || "").trim();
}

function imageHistorySearchTextForItem(item = {}, localPath = "") {
  return [
    item.providerName,
    item.providerId,
    item.sourceModel,
    item.prompt,
    item.size,
    item.mimeType,
    item.ok === false ? "生成失败 测试失败" : "已保存",
    item.errorCode,
    item.errorMessage,
    item.errorPhase,
    localPath,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function imageHistorySummaryText(visibleCount, totalCount) {
  if (visibleCount === totalCount) {
    return `${formatNumber(totalCount)} 条记录`;
  }
  return `${formatNumber(visibleCount)} / ${formatNumber(totalCount)} 条`;
}

function imageHistoryStatusClass(item = {}) {
  return item.ok === false ? "failed" : "saved";
}

function imageHistoryStatusText(item = {}) {
  return item.ok === false ? "生成失败" : "已保存";
}

function imageHistoryPlaceholderText(item = {}) {
  if (item.ok === false) {
    return "失败";
  }
  if (item.thumbnailStatus === "too_large") {
    return "大图";
  }
  if (item.thumbnailStatus === "outside_output_dir") {
    return "外部";
  }
  return "IMG";
}

function imageHistoryPlaceholderClass(item = {}) {
  if (item.ok === false) {
    return "failed";
  }
  if (item.thumbnailStatus === "outside_output_dir") {
    return "outside";
  }
  return "";
}

function renderImageGenerationHistory() {
  if (!els.imageGenerationHistory) {
    return;
  }
  const allItems = Array.isArray(state?.imageGenerationHistory) ? state.imageGenerationHistory : [];
  const items = filteredImageGenerationHistory(allItems);
  if (els.imageHistorySummary) {
    els.imageHistorySummary.textContent = imageHistorySummaryText(items.length, allItems.length);
  }
  if (!allItems.length) {
    els.imageGenerationHistory.innerHTML = `
      <div class="empty-state">
        暂无生成图片记录。保存图片供应商后，可以先用“测试生图”跑一次。
      </div>
    `;
    return;
  }
  if (!items.length) {
    els.imageGenerationHistory.innerHTML = `
      <div class="empty-state">
        没有匹配的图片记录。换个关键词或筛选条件再看。
      </div>
    `;
    return;
  }
  els.imageGenerationHistory.innerHTML = items
    .map((item) => {
      const localPath = imageHistoryLocalPath(item);
      const folder = folderFromPath(localPath);
      const statusClass = imageHistoryStatusClass(item);
      const failed = item.ok === false;
      const errorMessage = String(item.errorMessage || "").trim();
      const placeholderText = imageHistoryPlaceholderText(item);
      const placeholderClass = imageHistoryPlaceholderClass(item);
      const thumbnail = item.thumbnailDataUrl
        ? `<img src="${escapeHtml(item.thumbnailDataUrl)}" alt="生成图片缩略图" />`
        : `<div class="image-history-placeholder ${escapeHtml(placeholderClass)}">${escapeHtml(placeholderText)}</div>`;
      return `
        <article class="image-history-item ${escapeHtml(statusClass)}">
          <div class="image-history-thumb">${thumbnail}</div>
          <div class="image-history-body">
            <strong>
              ${escapeHtml(item.providerName || "图片供应商")}
              <em class="image-history-status ${escapeHtml(statusClass)}">${escapeHtml(imageHistoryStatusText(item))}</em>
            </strong>
            <span>${escapeHtml(item.sourceModel || "未知模型")} · ${formatTime(item.createdAt)} · ${formatDuration(item.durationMs)}</span>
            ${failed && errorMessage
              ? `<p class="image-history-error">${escapeHtml(errorMessage)}</p>`
              : `<p>${escapeHtml(item.prompt || "无提示词记录")}</p>`}
            <small title="${escapeHtml(localPath)}">${escapeHtml(localPath || "未记录本地路径")}</small>
          </div>
          <div class="image-history-actions">
            <button class="ghost-button light small" type="button" data-image-history-reveal="${escapeHtml(localPath)}" ${localPath ? "" : "disabled"}>定位图片</button>
            <button class="ghost-button light small" type="button" data-image-history-open="${escapeHtml(folder)}" ${folder ? "" : "disabled"}>打开文件夹</button>
          </div>
        </article>
      `;
    })
    .join("");
  els.imageGenerationHistory.querySelectorAll("[data-image-history-reveal]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const target = button.dataset.imageHistoryReveal;
        if (!target) {
          return;
        }
        const result = await api.revealFile(target);
        if (!result?.ok) {
          throw new Error(result?.message || "定位图片失败。");
        }
      }),
    );
  });
  els.imageGenerationHistory.querySelectorAll("[data-image-history-open]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const target = button.dataset.imageHistoryOpen;
        if (!target) {
          return;
        }
        const result = await api.openFolder(target);
        if (!result?.ok) {
          throw new Error(result?.message || "打开图片目录失败。");
        }
      }),
    );
  });
}

function filteredCapabilityExecutionHistory(items = []) {
  return items.filter((item) => capabilityHistoryMatchesFilter(item));
}

function capabilityHistoryMatchesFilter(item = {}) {
  const localPath = capabilityHistoryLocalPath(item);
  if (capabilityHistoryFilter === "success" && !item.ok) {
    return false;
  }
  if (capabilityHistoryFilter === "failed" && item.ok) {
    return false;
  }
  if (capabilityHistoryFilter === "asset" && !localPath) {
    return false;
  }
  const needle = capabilityHistorySearchText.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return capabilityHistorySearchTextForItem(item, localPath).includes(needle);
}

function capabilityHistoryLocalPath(item = {}) {
  return [
    item.localPath,
    item.asset?.localPath,
    item.output?.localPath,
    item.response?.localPath,
    item.savedResult?.localPath,
  ]
    .map((value) => String(value || "").trim())
    .find(Boolean) || "";
}

function capabilityHistorySearchTextForItem(item = {}, localPath = "") {
  return [
    item.providerName,
    item.providerId,
    item.capability,
    capabilityProviderCapabilityLabel(item.capability || ""),
    item.sourceModel,
    item.outputText,
    item.inputSummary,
    item.fileName,
    item.mimeType,
    item.lineCount,
    item.preview,
    item.errorCode,
    item.errorPhase,
    capabilityTracePhaseLabel(item.errorPhase || ""),
    localPath,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function capabilityHistoryFileMetadata(item = {}, localPath = "") {
  const parts = [];
  const fileName = String(item.fileName || fileNameFromPath(localPath) || "").trim();
  const mimeType = String(item.mimeType || "").trim();
  const lineCount = Number(item.lineCount || 0);
  if (fileName) {
    parts.push(fileName);
  }
  if (mimeType) {
    parts.push(mimeType);
  }
  if (Number.isFinite(lineCount) && lineCount > 0) {
    parts.push(`${formatNumber(lineCount)} 行`);
  }
  if (!parts.length) {
    return "";
  }
  return `<small class="capability-history-file-meta">${parts.map((part) => escapeHtml(part)).join(" · ")}</small>`;
}

function capabilityHistoryTextPreview(item = {}) {
  const preview = String(item.preview || "").trim();
  if (!preview) {
    return "";
  }
  return `<pre class="capability-history-text-preview">${escapeHtml(preview)}</pre>`;
}

function capabilityHistorySummaryText(visibleCount, totalCount) {
  if (visibleCount === totalCount) {
    return `${formatNumber(totalCount)} 条记录`;
  }
  return `${formatNumber(visibleCount)} / ${formatNumber(totalCount)} 条`;
}

function renderCapabilityExecutionHistory() {
  if (!els.capabilityExecutionHistory) {
    return;
  }
  const allItems = Array.isArray(state?.capabilityExecutionHistory) ? state.capabilityExecutionHistory : [];
  const items = filteredCapabilityExecutionHistory(allItems);
  if (els.capabilityHistorySummary) {
    els.capabilityHistorySummary.textContent = capabilityHistorySummaryText(items.length, allItems.length);
  }
  if (!allItems.length) {
    els.capabilityExecutionHistory.innerHTML = `
      <div class="empty-state">
        暂无能力试运行记录。配置能力供应商后，可以用“试运行能力”跑一次。
      </div>
    `;
    return;
  }
  if (!items.length) {
    els.capabilityExecutionHistory.innerHTML = `
      <div class="empty-state">
        没有匹配的能力记录。换个关键词或筛选条件再看。
      </div>
    `;
    return;
  }
  els.capabilityExecutionHistory.innerHTML = items.map((item) => {
    const localPath = capabilityHistoryLocalPath(item);
    const folder = folderFromPath(localPath);
    const fileMetadata = capabilityHistoryFileMetadata(item, localPath);
    const textPreview = capabilityHistoryTextPreview(item);
    const previewLabel = item.thumbnailStatus === "too_large"
      ? "大文件"
      : capabilityProviderCapabilityLabel(item.capability || "");
    const preview = item.thumbnailDataUrl
      ? `<img src="${escapeHtml(item.thumbnailDataUrl)}" alt="能力结果缩略图" />`
      : `<div class="capability-history-badge">${escapeHtml(previewLabel)}</div>`;
    return `
      <article class="capability-history-item ${item.ok ? "ok" : "failed"}">
        <div class="capability-history-preview">${preview}</div>
        <div class="capability-history-body">
          <div>
            <strong>${escapeHtml(item.providerName || item.providerId || "能力供应商")}</strong>
            <span class="status-pill ${item.ok ? "" : "danger"}">${item.ok ? "成功" : "失败"}</span>
          </div>
          <span>${escapeHtml(capabilityProviderCapabilityLabel(item.capability || ""))} · ${escapeHtml(item.sourceModel || "手动试运行")} · ${formatTime(item.createdAt)} · ${formatDuration(item.durationMs)}</span>
          ${fileMetadata}
          <p>${escapeHtml(item.outputText || item.inputSummary || "没有输出摘要")}</p>
          ${textPreview}
          ${item.errorCode ? `<small>错误：${escapeHtml(item.errorCode)}${item.errorPhase ? ` · ${escapeHtml(capabilityTracePhaseLabel(item.errorPhase))}` : ""}</small>` : ""}
          ${localPath ? `<small title="${escapeHtml(localPath)}">${escapeHtml(localPath)}</small>` : ""}
        </div>
        <div class="capability-history-actions">
          <button class="ghost-button light small" type="button" data-capability-history-reveal="${escapeHtml(localPath)}" ${localPath ? "" : "disabled"}>定位文件</button>
          <button class="ghost-button light small" type="button" data-capability-history-open="${escapeHtml(folder)}" ${folder ? "" : "disabled"}>打开文件夹</button>
        </div>
      </article>
    `;
  }).join("");
  els.capabilityExecutionHistory.querySelectorAll("[data-capability-history-reveal]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const target = button.dataset.capabilityHistoryReveal;
        if (!target) {
          return;
        }
        const result = await api.revealFile(target);
        if (!result?.ok) {
          throw new Error(result?.message || "定位能力结果文件失败。");
        }
      }),
    );
  });
  els.capabilityExecutionHistory.querySelectorAll("[data-capability-history-open]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const target = button.dataset.capabilityHistoryOpen;
        if (!target) {
          return;
        }
        const result = await api.openFolder(target);
        if (!result?.ok) {
          throw new Error(result?.message || "打开能力结果目录失败。");
        }
      }),
    );
  });
}

function imageProviderAdapterLabel(adapter) {
  return {
    siliconflow_images: "SiliconFlow",
    zai_images: "智谱 / Z.ai",
    openai_images: "OpenAI",
    generic_template: "通用接口",
  }[adapter] || adapter || "通用接口";
}

function fillImageProviderTemplate(templateId) {
  const templates = imageProviderTemplates();
  const template = templates[templateId] || templates.siliconflow;
  const shouldMakeDefault = templateId === "siliconflow" || !imageProviderConfig().defaultProviderId;
  fillImageProviderForm(template, { makeDefault: shouldMakeDefault });
  renderImageProviderTemplateHint(template);
  renderImageProviderTestResult(null);
  showToast(`已填入${template.name}模板，检查模型名和 API Key 后可保存或测试。`);
}

function imageProviderTemplateForAdapter(adapter) {
  return Object.values(imageProviderTemplates()).find((template) => template.adapter === adapter) || null;
}

function renderImageProviderTemplateHint(template = null) {
  if (!els.imageProviderTemplateHint) {
    return;
  }
  if (!template) {
    els.imageProviderTemplateHint.innerHTML = `
      <strong>先选一个模板</strong>
      <span>模板会自动填好 Base URL、Endpoint、模型名和返回字段路径；你只需要确认模型权限并填写 API Key。</span>
    `;
    return;
  }
  const required = Array.isArray(template.required) ? template.required : [];
  const returns = Array.isArray(template.returns) ? template.returns : [];
  const requiredText = required.length ? required.join("、") : "Base URL、Endpoint、模型名、API Key";
  const returnsText = returns.length ? returns.join("；") : "按返回字段路径读取图片 URL 或 Base64。";
  els.imageProviderTemplateHint.innerHTML = `
    <strong>${escapeHtml(template.name || "图片供应商模板")}</strong>
    <span>${escapeHtml(template.help || "检查接口地址、模型权限、API Key 和返回字段路径后再测试。")}</span>
    <ul>
      <li><b>需要填写</b><span>${escapeHtml(requiredText)}</span></li>
      <li><b>返回格式</b><span>${escapeHtml(returnsText)}</span></li>
    </ul>
  `;
}

function fillImageProviderForm(provider = {}, options = {}) {
  setValue("#imageProviderId", provider.id || "");
  setValue("#imageProviderName", provider.name || provider.displayName || "");
  setValue("#imageProviderAdapter", provider.adapter || "siliconflow_images");
  setValue("#imageProviderBaseUrl", provider.baseUrl || "");
  setValue("#imageProviderEndpoint", provider.endpoint || "/images/generations");
  setValue("#imageProviderModel", provider.model || "");
  setValue(
    "#imageProviderSize",
    Object.prototype.hasOwnProperty.call(provider, "size")
      ? provider.size
      : imageProviderDefaultSize(provider.adapter),
  );
  setValue("#imageProviderKeyEnv", provider.apiKeyEnv || imageProviderDefaultKeyEnv(provider.adapter));
  setValue("#imageProviderApiKey", "");
  const response = {
    ...imageProviderDefaultResponse(provider.adapter),
    ...(provider.response && typeof provider.response === "object" ? provider.response : {}),
  };
  setValue("#imageProviderImageUrlPath", response.imageUrlPath || "");
  setValue("#imageProviderImageBase64Path", response.imageBase64Path || "");
  setValue(
    "#imageProviderDefaults",
    provider.defaults && Object.keys(provider.defaults).length
      ? JSON.stringify(provider.defaults, null, 2)
      : "",
  );
  setValue(
    "#imageProviderRequestTemplate",
    provider.request?.template && Object.keys(provider.request.template).length
      ? JSON.stringify(provider.request.template, null, 2)
      : "",
  );
  setValue(
    "#imageProviderHeaders",
    provider.headers && Object.keys(provider.headers).length
      ? JSON.stringify(provider.headers, null, 2)
      : "",
  );
  const makeDefault = document.querySelector("#imageProviderMakeDefault");
  if (makeDefault) {
    makeDefault.checked = Boolean(options.makeDefault);
  }
  const enabled = document.querySelector("#imageProviderEnabled");
  if (enabled) {
    enabled.checked = provider.enabled !== false;
  }
  setValue(
    "#imageProviderPriority",
    Number.isFinite(Number(provider.priority)) ? String(Math.round(Number(provider.priority))) : "0",
  );
  renderImageProviderTemplateHint(provider.help ? provider : imageProviderTemplateForAdapter(provider.adapter));
}

function resetImageProviderForm() {
  els.imageProviderForm?.reset();
  setValue("#imageProviderId", "");
  setValue("#imageProviderAdapter", "siliconflow_images");
  setValue("#imageProviderEndpoint", "/images/generations");
  setValue("#imageProviderSize", "");
  setValue("#imageProviderKeyEnv", "SILICONFLOW_API_KEY");
  setValue("#imageProviderImageUrlPath", "images[0].url");
  setValue("#imageProviderImageBase64Path", "data[0].b64_json");
  setValue("#imageProviderRequestTemplate", "");
  setValue("#imageProviderHeaders", "");
  setValue("#imageProviderPriority", "0");
  const enabled = document.querySelector("#imageProviderEnabled");
  if (enabled) {
    enabled.checked = true;
  }
  const makeDefault = document.querySelector("#imageProviderMakeDefault");
  if (makeDefault) {
    makeDefault.checked = false;
  }
  renderImageProviderTemplateHint(null);
}

function imageProviderDefaultSize(adapter) {
  return "";
}

function imageProviderDefaultKeyEnv(adapter) {
  if (adapter === "zai_images") {
    return "ZAI_API_KEY";
  }
  if (adapter === "generic_template") {
    return "IMAGE_GENERATION_API_KEY";
  }
  if (adapter === "openai_images") {
    return "OPENAI_API_KEY";
  }
  return "SILICONFLOW_API_KEY";
}

function imageProviderDefaultResponse(adapter) {
  if (adapter === "siliconflow_images") {
    return {
      imageUrlPath: "images[0].url",
      imageBase64Path: "data[0].b64_json",
    };
  }
  return {
    imageUrlPath: "data[0].url",
    imageBase64Path: "data[0].b64_json",
  };
}

function imageProviderPayloadFromForm() {
  const adapter = valueOf("#imageProviderAdapter") || "siliconflow_images";
  const defaults = imageProviderJsonObjectFromField("#imageProviderDefaults", "附加参数 JSON");
  const requestTemplate = imageProviderJsonObjectFromField("#imageProviderRequestTemplate", "请求体模板 JSON");
  const headers = imageProviderJsonObjectFromField("#imageProviderHeaders", "Header JSON");
  return {
    id: valueOf("#imageProviderId"),
    name: valueOf("#imageProviderName"),
    adapter,
    baseUrl: valueOf("#imageProviderBaseUrl"),
    endpoint: valueOf("#imageProviderEndpoint") || "/images/generations",
    model: valueOf("#imageProviderModel"),
    size: valueOf("#imageProviderSize"),
    apiKeyEnv: valueOf("#imageProviderKeyEnv") || imageProviderDefaultKeyEnv(adapter),
    apiKey: valueOf("#imageProviderApiKey"),
    response: {
      imageUrlPath: valueOf("#imageProviderImageUrlPath") || imageProviderDefaultResponse(adapter).imageUrlPath,
      imageBase64Path: valueOf("#imageProviderImageBase64Path") || imageProviderDefaultResponse(adapter).imageBase64Path,
    },
    defaults,
    request: imageProviderRequestFromForm(requestTemplate),
    headers: imageProviderHeadersFromForm(headers),
    enabled: document.querySelector("#imageProviderEnabled")?.checked !== false,
    priority: Number(valueOf("#imageProviderPriority") || 0),
    makeDefault: Boolean(document.querySelector("#imageProviderMakeDefault")?.checked),
  };
}

function imageProviderJsonObjectFromField(selector, label) {
  const text = valueOf(selector);
  if (!text) {
    return {};
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是一个 JSON 对象。`);
  }
  return parsed;
}

function imageProviderRequestFromForm(template = {}) {
  return Object.keys(template).length ? { template } : {};
}

function imageProviderHeadersFromForm(headers = {}) {
  return headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {};
}

function testImageProviderFromForm(button) {
  return runAction(button, async () => {
    renderImageProviderTestResult({ pending: true });
    const response = await api.testImageProvider({
      provider: imageProviderPayloadFromForm(),
      prompt: els.imageProviderTestPrompt?.value?.trim() || "",
    });
    state = response?.state || await api.getState();
    renderImageProviderSettings();
    renderImageProviderTestResult(response);
    renderImageGenerationHistory();
    renderCapabilityDiagnostics();
    showToast(response?.ok ? "测试生图成功，图片已保存到本地。" : response?.error?.message || "测试生图失败。", response?.ok ? "success" : "error");
  });
}

function testSavedImageProvider(button) {
  return runAction(button, async () => {
    const providerId = String(button?.dataset?.imageProviderTest || "").trim();
    const provider = imageProviders().find((item) => item.id === providerId);
    if (!provider) {
      throw new Error("没有找到这个图片供应商，请刷新后重试。");
    }
    renderImageProviderTestResult({ pending: true });
    const response = await api.testImageProvider({
      providerId: provider.id,
      provider,
      prompt: els.imageProviderTestPrompt?.value?.trim() || "",
    });
    state = response?.state || await api.getState();
    renderImageProviderSettings();
    renderImageProviderTestResult(response);
    renderImageGenerationHistory();
    renderCapabilityDiagnostics();
    showToast(
      response?.ok ? "测试生图成功，图片已保存到本地。" : response?.error?.message || response?.message || "测试生图失败。",
      response?.ok ? "success" : "error",
    );
  });
}

function renderImageProviderTestResult(result) {
  if (!els.imageProviderTestResult) {
    return;
  }
  if (!result) {
    els.imageProviderTestResult.innerHTML = "";
    return;
  }
  if (result.pending) {
    els.imageProviderTestResult.innerHTML = `<div class="test-result-card pending">正在请求图片供应商...</div>`;
    return;
  }
  if (!result.ok) {
    const error = result.error || {};
    els.imageProviderTestResult.innerHTML = `
      <div class="test-result-card error">
        <strong>测试失败</strong>
        <span>耗时 ${formatDuration(result.durationMs)}</span>
        <p>${escapeHtml(error.message || "图片供应商没有返回可用结果。")}</p>
        ${error.detail ? `<small>${escapeHtml(error.detail)}</small>` : ""}
        ${imageProviderHealthChecksList(result.checks)}
        ${imageProviderCapabilityTrace(result.capabilityTrace)}
      </div>
    `;
    return;
  }
  const localPath = String(result.localPath || "");
  const folder = folderFromPath(localPath);
  const preview = imageProviderTestPreview(result);
  els.imageProviderTestResult.innerHTML = `
    <div class="test-result-card success">
      ${preview}
      <div>
        <strong>${escapeHtml(result.message || "测试成功")}</strong>
        <p>耗时 ${formatDuration(result.durationMs)}，已保存到本地。</p>
        <div class="test-result-path">
          <small title="${escapeHtml(localPath)}">${escapeHtml(localPath || "未返回本地路径")}</small>
          <button class="ghost-button light small" type="button" data-image-provider-test-reveal="${escapeHtml(localPath)}" ${localPath ? "" : "disabled"}>定位图片</button>
          <button class="ghost-button light small" type="button" data-image-provider-test-open="${escapeHtml(folder)}" ${folder ? "" : "disabled"}>打开文件夹</button>
        </div>
        ${imageProviderHealthChecksList(result.checks)}
        ${imageProviderCapabilityTrace(result.capabilityTrace)}
      </div>
    </div>
  `;
  els.imageProviderTestResult.querySelectorAll("[data-image-provider-test-reveal]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const target = button.dataset.imageProviderTestReveal;
        if (!target) {
          return;
        }
        const result = await api.revealFile(target);
        if (!result?.ok) {
          throw new Error(result?.message || "定位图片失败。");
        }
      }),
    );
  });
  els.imageProviderTestResult.querySelectorAll("[data-image-provider-test-open]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const target = button.dataset.imageProviderTestOpen;
        if (!target) {
          return;
        }
        const result = await api.openFolder(target);
        if (!result?.ok) {
          throw new Error(result?.message || "打开图片目录失败。");
        }
      }),
    );
  });
}

function imageProviderTestPreview(result = {}) {
  const imageDataUrl = String(result.imageDataUrl || "").trim();
  if (imageDataUrl) {
    return `<img src="${escapeHtml(imageDataUrl)}" alt="测试生成图片" />`;
  }
  const localPath = String(result.localPath || "").trim();
  if (!localPath) {
    return "";
  }
  const fileName = fileNameFromPath(localPath);
  return `
    <div class="image-provider-test-saved-only" title="${escapeHtml(localPath)}">
      <strong>本地图片已保存</strong>
      <small>${escapeHtml(fileName || "未内联预览")}</small>
      <em>未内联预览</em>
    </div>
  `;
}

function imageProviderHealthChecksList(checks) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return "";
  }
  const statusLabel = {
    pass: "通过",
    fail: "失败",
    warn: "提醒",
    unknown: "待确认",
  };
  const rows = checks.map((item) => {
    const status = String(item?.status || "unknown").toLowerCase();
    const safeStatus = ["pass", "fail", "warn", "unknown"].includes(status) ? status : "unknown";
    return `
      <li class="test-check-item ${safeStatus}">
        <span>${escapeHtml(item?.label || "检查项")}</span>
        <strong>${escapeHtml(statusLabel[safeStatus] || "待确认")}</strong>
        <small>${escapeHtml(item?.detail || "")}</small>
      </li>
    `;
  }).join("");
  return `
    <div class="test-check-list" aria-label="检查项">
      <b>检查项</b>
      <ul>${rows}</ul>
    </div>
  `;
}

function imageProviderCapabilityTrace(trace) {
  if (!Array.isArray(trace) || trace.length === 0) {
    return "";
  }
  const rows = trace.map((item) => {
    const status = String(item?.status || "unknown").toLowerCase();
    const safeStatus = ["ok", "failed", "skipped"].includes(status) ? status : "unknown";
    const detail = item?.error?.message || item?.reason || "";
    return `
      <li class="capability-trace-item ${safeStatus}">
        <span>${escapeHtml(capabilityTracePhaseLabel(item?.phase))}</span>
        <strong>${escapeHtml(capabilityTraceStatusLabel(safeStatus))}</strong>
        <small>${escapeHtml(formatDuration(item?.durationMs || 0))}${detail ? ` · ${escapeHtml(detail)}` : ""}</small>
      </li>
    `;
  }).join("");
  return `
    <div class="capability-trace" aria-label="能力代理阶段">
      <b>能力代理阶段</b>
      <ul>${rows}</ul>
    </div>
  `;
}

function capabilityTracePhaseLabel(phase) {
  return {
    detectRequest: "识别请求",
    selectProvider: "选择供应商",
    execute: "请求供应商",
    saveResult: "保存图片",
    buildResponse: "生成回复",
    buildErrorResponse: "生成错误提示",
    recordHistory: "记录历史",
  }[phase] || phase || "未知阶段";
}

function capabilityTraceStatusLabel(status) {
  return {
    ok: "通过",
    failed: "失败",
    skipped: "跳过",
    unknown: "待确认",
  }[status] || "待确认";
}

function clearCapabilityExecutionHistory(button) {
  return runAction(button, async () => {
    if (button.dataset.confirmClear !== "true") {
      button.dataset.confirmClear = "true";
      button.textContent = "再次点击确认清理";
      showToast("再次点击会清理 30 天前记录，并逐个删除 CodexBridge 能力输出目录里的旧文件。");
      setTimeout(() => {
        if (button.dataset.confirmClear === "true") {
          button.dataset.confirmClear = "false";
          button.textContent = "清理旧记录";
        }
      }, 3000);
      return;
    }
    const response = await api.clearCapabilityExecutionHistory({
      deleteFiles: true,
      olderThanDays: 30,
      keepLatest: 50,
    });
    state = response?.state || await api.getState();
    button.dataset.confirmClear = "false";
    button.textContent = "清理旧记录";
    renderCapabilityExecutionHistory();
    showToast(`已清理 ${formatNumber(response?.removedRecords || 0)} 条能力记录，删除 ${formatNumber(response?.removedFiles || 0)} 个本地文件，保留 ${formatNumber(response?.keptRecords || 0)} 条。`);
  });
}

function clearImageGenerationHistory(button) {
  return runAction(button, async () => {
    if (button.dataset.confirmClear !== "true") {
      button.dataset.confirmClear = "true";
      button.textContent = "再次点击确认清理";
      showToast("再次点击会清理 30 天前记录，并逐个删除 generated-images 里对应的旧图片文件。");
      setTimeout(() => {
        if (button.dataset.confirmClear === "true") {
          button.dataset.confirmClear = "false";
          button.textContent = "清理 30 天前图片";
        }
      }, 3000);
      return;
    }
    const response = await api.clearImageGenerationHistory({
      deleteFiles: true,
      olderThanDays: 30,
      keepLatest: 120,
    });
    state = response?.state || await api.getState();
    button.dataset.confirmClear = "false";
    button.textContent = "清理 30 天前图片";
    renderImageGenerationHistory();
    showToast(`已清理 ${formatNumber(response?.removedRecords || 0)} 条旧记录，删除 ${formatNumber(response?.removedFiles || 0)} 张本地图片，保留 ${formatNumber(response?.keptRecords || 0)} 条。`);
  });
}

function folderFromPath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  const index = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function fileNameFromPath(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const normalized = text.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || text;
}

function saveImageProviderSettings(button) {
  return runAction(button, async () => {
    const response = await api.saveImageProvider(imageProviderPayloadFromForm());
    state = response?.state || await api.getState();
    draftSelection = [...state.selectedModelIds];
    render();
    showToast("图片供应商已保存。非 GPT 模型可继承默认图片代理。");
  });
}

function saveCapabilityProviderSettings(button) {
  return runAction(button, async () => {
    const response = await api.saveCapabilityProvider(capabilityProviderPayloadFromForm());
    state = response?.state || await api.getState();
    draftSelection = [...state.selectedModelIds];
    render();
    showToast("实验能力供应商已保存；除图片生成外，仅用于手动体检和试运行。");
  });
}

function removeCapabilityProvider(button) {
  return runAction(button, async () => {
    const providerId = button.dataset.capabilityProviderRemove;
    if (button.dataset.confirmRemove !== "true") {
      button.dataset.confirmRemove = "true";
      button.textContent = "再次点击移除";
      showToast("再次点击这个按钮才会移除能力供应商。");
      setTimeout(() => {
        if (button.dataset.confirmRemove === "true") {
          button.dataset.confirmRemove = "false";
          button.textContent = "移除";
        }
      }, 2600);
      return;
    }
    const response = await api.removeCapabilityProvider(providerId);
    state = response?.state || await api.getState();
    draftSelection = [...state.selectedModelIds];
    resetCapabilityProviderForm();
    render();
    showToast("能力供应商已移除。");
  });
}

function removeImageProvider(button) {
  return runAction(button, async () => {
    const providerId = button.dataset.imageProviderRemove;
    if (button.dataset.confirmRemove !== "true") {
      button.dataset.confirmRemove = "true";
      button.textContent = "再次点击移除";
      showToast("再次点击这个按钮才会移除图片供应商。");
      setTimeout(() => {
        if (button.dataset.confirmRemove === "true") {
          button.dataset.confirmRemove = "false";
          button.textContent = "移除";
        }
      }, 2600);
      return;
    }
    const response = await api.removeImageProvider(providerId);
    state = response?.state || await api.getState();
    draftSelection = [...state.selectedModelIds];
    resetImageProviderForm();
    render();
    showToast("图片供应商已移除。");
  });
}

function valueOf(selector) {
  return document.querySelector(selector)?.value.trim() || "";
}

function renderHealthStatus() {
  const health = state.lastHealth;
  const isStarting = Boolean(health?.starting);
  els.healthStatus.classList.toggle("ok", Boolean(health?.ok));
  els.healthStatus.classList.toggle("bad", Boolean(health && !health.ok && !isStarting));
  els.healthStatus.classList.toggle("starting", isStarting);
  if (!health) {
    els.healthStatus.textContent = "Router 健康检查：尚未检查";
    return;
  }
  const checkedAt = health.checkedAt ? ` · ${formatTime(health.checkedAt)}` : "";
  if (isStarting) {
    els.healthStatus.textContent = `Router 正在启动，等待健康检查${checkedAt}`;
    return;
  }
  const unhealthyRoutes = Number(health.unhealthyRoutes || 0);
  const routeAttention = unhealthyRoutes > 0 ? `，${unhealthyRoutes} 条上游需关注` : "";
  els.healthStatus.textContent = health.ok
    ? `Router 健康检查通过：${health.models?.length || 0} 个模型已加载${routeAttention}${checkedAt}`
    : `Router 健康检查失败：${health.message || "未知错误"}${checkedAt}`;
}

function renderStartupCheck() {
  if (!(els.startupCheckSummary && els.startupCheckList)) {
    return;
  }
  const check = state.startupCheck;
  if (!check) {
    els.startupCheckSummary.innerHTML = `<div class="empty-state">${stateDetailLoaded ? "暂无体检结果。" : "进入体检页后会读取结果。"}</div>`;
    els.startupCheckList.innerHTML = "";
    return;
  }
  const summary = check.summary || {};
  const items = visibleStartupCheckItems(check.items);
  const visibleSummary = startupCheckSummaryFromItems(items, summary);
  els.startupCheckSummary.innerHTML = `
    <article class="check-summary-card ${visibleSummary.ok ? "pass" : "fail"}">
      <span>总状态</span>
      <strong>${visibleSummary.ok ? "可启动" : "需要处理"}</strong>
    </article>
    <article class="check-summary-card pass">
      <span>通过</span>
      <strong>${formatNumber(visibleSummary.pass)}</strong>
    </article>
    <article class="check-summary-card warn">
      <span>提醒</span>
      <strong>${formatNumber(visibleSummary.warn)}</strong>
    </article>
    <article class="check-summary-card fail">
      <span>失败</span>
      <strong>${formatNumber(visibleSummary.fail)}</strong>
    </article>
  `;
  if (!items.length) {
    els.startupCheckList.innerHTML = `<div class="empty-state">暂无体检项目。</div>`;
    return;
  }
  const attentionItems = items.filter((item) => item.status !== "pass");
  const passedItems = items.filter((item) => item.status === "pass");
  els.startupCheckList.innerHTML = `
    ${attentionItems.length
      ? attentionItems.map(startupCheckItem).join("")
      : `<div class="check-ok-message">当前没有需要处理的问题。</div>`}
    ${passedItems.length ? `
      <details class="check-passed-details">
        <summary>已通过 ${formatNumber(passedItems.length)} 项</summary>
        <div class="check-passed-grid">
          ${passedItems.map(startupCheckItem).join("")}
        </div>
      </details>
    ` : ""}
  `;
}

function startupCheckItem(item = {}) {
  return `
    <article class="check-item ${escapeHtml(item.status || "warn")}">
      <div>
        <strong>${escapeHtml(item.label || item.id || "-")}</strong>
        <p>${escapeHtml(item.status === "pass" ? compactStartupDetail(item.detail) : item.detail || "-")}</p>
        ${item.status !== "pass" && item.action ? `<small>${escapeHtml(item.action)}</small>` : ""}
      </div>
      <span>${checkStatusLabel(item.status)}</span>
    </article>
  `;
}

const USER_VISIBLE_STARTUP_CHECK_IDS = new Set([
  "api_keys",
  "model_references",
  "router",
  "route_health",
  "backups",
]);

function visibleStartupCheckItems(items = []) {
  return (Array.isArray(items) ? items : []).filter((item) => (
    USER_VISIBLE_STARTUP_CHECK_IDS.has(String(item?.id || ""))
  ));
}

function startupCheckSummaryFromItems(items = [], fallback = {}) {
  if (!Array.isArray(items)) {
    return {
      ok: fallback?.ok !== false,
      pass: Number(fallback?.pass || 0),
      warn: Number(fallback?.warn || 0),
      fail: Number(fallback?.fail || 0),
    };
  }
  const pass = items.filter((item) => item?.status === "pass").length;
  const warn = items.filter((item) => item?.status === "warn").length;
  const fail = items.filter((item) => item?.status === "fail").length;
  return {
    ok: fail === 0,
    pass,
    warn,
    fail,
  };
}

function compactStartupDetail(detail = "") {
  const text = String(detail || "").trim();
  if (!text) {
    return "已通过";
  }
  return text.length > 72 ? `${text.slice(0, 72)}...` : text;
}

function renderConfigPackageSyncStatus() {
  if (!els.configPackageSyncStatus) {
    return;
  }
  const status = state?.configPackageSyncStatus;
  if (!status?.ok) {
    els.configPackageSyncStatus.className = "config-sync-status empty";
    els.configPackageSyncStatus.innerHTML = `
      <div>
        <strong>同步目录备份</strong>
        <span>还没有导出到同步目录。可选 OneDrive、坚果云或网盘同步盘，配置包不含 API Key。</span>
      </div>
    `;
    return;
  }
  const fileState = status.fileExists ? "文件可用" : "记录存在，文件已不在原目录";
  const counts = [
    `模型 ${formatNumber(status.selectedModelCount || 0)}`,
    `供应商 ${formatNumber((status.providerCount || 0) + (status.imageProviderCount || 0) + (status.capabilityProviderCount || 0))}`,
    `Codex 资源 ${codexResourceCountLabel(status)}`,
    `需重填 Key ${formatNumber(status.requiredSecretKeyCount || 0)}`,
  ];
  els.configPackageSyncStatus.className = `config-sync-status ${status.fileExists ? "ok" : "warn"}`;
  els.configPackageSyncStatus.innerHTML = `
    <div>
      <strong>同步目录备份</strong>
      <span>${escapeHtml(status.fileName || "未知配置包")}</span>
      <small>${escapeHtml(status.directoryName ? `目录：${status.directoryName}` : "目录：未记录")} · ${escapeHtml(status.exportedAt ? formatTime(status.exportedAt) : "时间未知")} · ${escapeHtml(fileState)}</small>
    </div>
    <div class="config-sync-meta">
      ${counts.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
      ${status.fileExists ? `<button class="primary-button small" type="button" data-import-config-sync>从同步目录导入</button>` : ""}
      <button class="ghost-button light small" type="button" data-open-config-sync>打开同步目录</button>
    </div>
  `;
  els.configPackageSyncStatus.querySelector("[data-import-config-sync]")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    runAction(button, async () => {
      const result = await api.importLatestConfigPackageFromSyncDir();
      if (result?.canceled) {
        return;
      }
      state = result?.state || await api.getState();
      draftSelection = [...state.selectedModelIds];
      render();
      showToast(`已从同步目录导入配置包：${result?.sourceFileName || status.fileName || "最近配置包"}。`);
    });
  });
  els.configPackageSyncStatus.querySelector("[data-open-config-sync]")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    runAction(button, async () => {
      await api.openFolder("config-sync");
      showToast(`已打开同步目录：${status.directoryName || "同步目录"}`);
    });
  });
}

function renderConfigPackageImportBackupStatus() {
  if (!els.configPackageImportBackupStatus) {
    return;
  }
  const status = state?.configPackageImportBackupStatus;
  if (!status?.ok) {
    els.configPackageImportBackupStatus.className = "config-sync-status empty";
    els.configPackageImportBackupStatus.innerHTML = `
      <div>
        <strong>导入回滚备份</strong>
        <span>还没有导入前备份。导入配置包确认后，会先自动保存当前本机配置，API Key 不会写入备份包。</span>
      </div>
    `;
    return;
  }
  const details = [
    `备份 ${formatNumber(status.backupCount || 0)} 份`,
    status.latestBytes ? `大小 ${formatBytes(status.latestBytes)}` : "",
  ].filter(Boolean);
  els.configPackageImportBackupStatus.className = "config-sync-status ok";
  els.configPackageImportBackupStatus.innerHTML = `
    <div>
      <strong>导入回滚备份</strong>
      <span>${escapeHtml(status.latestFileName || "未知备份包")}</span>
      <small>${escapeHtml(status.directoryName ? `目录：${status.directoryName}` : "目录：本机备份目录")} · ${escapeHtml(status.latestUpdatedAt ? formatTime(status.latestUpdatedAt) : "时间未知")}</small>
    </div>
    <div class="config-sync-meta">
      ${details.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
      <button class="primary-button small" type="button" data-restore-config-import-backup>恢复最近备份</button>
      <button class="ghost-button light small" type="button" data-open-config-import-backups>打开备份目录</button>
    </div>
  `;
  els.configPackageImportBackupStatus
    .querySelector("[data-restore-config-import-backup]")
    ?.addEventListener("click", (event) => {
      const button = event.currentTarget;
      runAction(button, async () => {
        const result = await api.restoreLatestConfigPackageBackup();
        if (result?.canceled) {
          return;
        }
        state = result?.state || await api.getState();
        draftSelection = [...state.selectedModelIds];
        render();
        showToast(`已恢复导入前备份：${result?.restoredBackupFileName || status.latestFileName || "最近备份"}。`);
      });
    });
  els.configPackageImportBackupStatus
    .querySelector("[data-open-config-import-backups]")
    ?.addEventListener("click", (event) => {
      const button = event.currentTarget;
      runAction(button, async () => {
        await api.openFolder("config-import-backups");
        showToast(`已打开导入备份目录：${status.directoryName || "本机备份目录"}`);
      });
    });
}

function renderProfiles() {
  if (!els.profileList) {
    return;
  }
  const profiles = Array.isArray(state.configProfiles) ? state.configProfiles : [];
  if (!profiles.length) {
    els.profileList.innerHTML = `<div class="empty-state">还没有保存配置档。保存后可以在这里改名和快速切换。</div>`;
    return;
  }
  els.profileList.innerHTML = profiles
    .map(
      (profile) => `
        <article class="profile-item">
          <div class="profile-main">
            <input class="profile-name-input" value="${escapeHtml(profile.name)}" data-profile-name="${escapeHtml(profile.id)}" aria-label="配置档名称" />
            <p>
              <span title="${escapeHtml(profileModeHelp(profile.mode))}">${escapeHtml(profileModeLabel(profile.mode))}</span>
              · ${formatNumber(profile.selectedModelIds?.length || 0)} 个模型
              · ${formatTime(profile.updatedAt)}
            </p>
          </div>
          <div class="profile-actions">
            <button class="ghost-button light small" type="button" data-rename-profile="${escapeHtml(profile.id)}">保存名称</button>
            <button class="primary-button small" type="button" data-apply-profile="${escapeHtml(profile.id)}">应用</button>
          </div>
        </article>
      `,
    )
    .join("");
  els.profileList.querySelectorAll("[data-rename-profile]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const profile = profiles.find((item) => item.id === button.dataset.renameProfile);
        const input = els.profileList.querySelector(`[data-profile-name="${cssEscape(button.dataset.renameProfile)}"]`);
        const nextName = input?.value?.trim();
        if (!profile || !nextName) {
          showToast("配置档名称不能为空。", "error");
          return;
        }
        const response = await api.saveConfigProfile({ ...profile, name: nextName });
        state = response?.state || await api.getState();
        render();
        showToast("配置档名称已保存。");
      }),
    );
  });
  els.profileList.querySelectorAll("[data-apply-profile]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        state = await api.applyConfigProfile(button.dataset.applyProfile);
        draftSelection = [...(state.selectedModelIds || [])];
        render();
        showToast("配置档已应用。");
      }),
    );
  });
}

function profileModeLabel(mode) {
  if (mode === "hybrid") {
    return "混合模式";
  }
  if (mode === "all_api" || mode === "all-api") {
    return "全部 API 模式";
  }
  return "未知模式";
}

function profileModeHelp(mode) {
  if (mode === "hybrid") {
    return "混合模式：保留 Codex 原生 GPT 能力，同时把 API 模型加入同一个模型栏。";
  }
  if (mode === "all_api" || mode === "all-api") {
    return "全部 API 模式：模型栏完全由 CodexBridge API 路由接管。";
  }
  return "当前配置档保存时的运行模式。";
}

function renderBackups() {
  if (!els.backupList) {
    return;
  }
  if (!settingsDetailLoaded && !state?.settingsDetailLoaded) {
    els.backupList.innerHTML = `<div class="empty-state">进入设置页后会读取配置备份。</div>`;
    return;
  }
  const backups = Array.isArray(state.codexBackups) ? state.codexBackups : [];
  if (!backups.length) {
    els.backupList.innerHTML = `<div class="empty-state">暂未发现 CodexBridge 配置备份。</div>`;
    return;
  }
  els.backupList.innerHTML = `
    <div class="backup-list-head">
      <span>共 ${formatNumber(backups.length)} 个备份，按时间倒序显示</span>
    </div>
    ${backups
    .slice(0, 16)
    .map(
      (backup) => `
        <article class="compact-list-item">
          <div>
            <strong>${escapeHtml(backup.name)}</strong>
            <p>${escapeHtml(backupKindLabel(backup.kind))} · ${formatBytes(backup.size)} · ${formatTime(backup.updatedAt)}</p>
          </div>
          <button class="ghost-button light small" type="button" data-restore-backup="${escapeHtml(backup.fullPath)}">恢复</button>
        </article>
      `,
    )
    .join("")}
    ${backups.length > 16 ? `<div class="backup-list-foot">仅显示最近 16 个，完整备份仍保存在 Codex 配置目录。</div>` : ""}
  `;
  els.backupList.querySelectorAll("[data-restore-backup]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const accepted = await showConfirmDialog({
          title: "恢复 Codex 配置备份",
          message: "将用选中的备份覆盖当前 config.toml。当前配置会先自动备份，方便回退。",
          confirmText: "恢复备份",
        });
        if (!accepted) {
          return;
        }
        const response = await api.restoreCodexBackup(button.dataset.restoreBackup);
        state = response?.state || await api.getState();
        render();
        showToast("Codex 配置备份已恢复。");
      }),
    );
  });
}

function backupKindLabel(kind) {
  if (kind === "codexbridge") {
    return "写入前备份";
  }
  if (kind === "before_restore") {
    return "恢复前备份";
  }
  if (kind === "history_access") {
    return "历史修复备份";
  }
  return "配置备份";
}

function showConfirmDialog({ title, message, confirmText = "确认", cancelText = "取消" } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop runtime-confirm-backdrop";
    backdrop.innerHTML = `
      <div class="request-detail-dialog runtime-confirm-dialog" role="dialog" aria-modal="true">
        <header>
          <h2>${escapeHtml(title || "确认操作")}</h2>
        </header>
        <p>${escapeHtml(message || "")}</p>
        <div class="runtime-confirm-actions">
          <button class="ghost-button light" type="button" data-confirm-cancel>${escapeHtml(cancelText)}</button>
          <button class="primary-button" type="button" data-confirm-ok>${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;
    const close = (accepted) => {
      backdrop.remove();
      resolve(accepted);
    };
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        close(false);
      }
    });
    backdrop.querySelector("[data-confirm-cancel]")?.addEventListener("click", () => close(false));
    backdrop.querySelector("[data-confirm-ok]")?.addEventListener("click", () => close(true));
    document.body.appendChild(backdrop);
    backdrop.querySelector("[data-confirm-ok]")?.focus();
  });
}

function renderResources() {
  if (!(els.resourceSummary && els.resourceList)) {
    return;
  }
  resourceDetailItems.clear();
  const rawResources = state.codexResources || {};
  const pluginPage = rawResources.pluginPage || null;
  const resources = pluginPage
    ? {
        ...rawResources,
        authority: { ...(rawResources.authority || {}), ...(pluginPage.authority || {}) },
        readStatus: { ...(rawResources.readStatus || {}), ...(pluginPage.readStatus || {}) },
        summary: { ...(rawResources.summary || {}), ...(pluginPage.summary || {}) },
        diagnostics: { ...(rawResources.diagnostics || {}), ...(pluginPage.diagnostics || {}) },
        snapshot: { ...(rawResources.snapshot || {}), ...(pluginPage.snapshot || {}) },
        plugins: pluginPage.plugins || [],
        apps: pluginPage.apps || [],
        mcpServers: pluginPage.mcpServers || [],
        skills: pluginPage.skills || [],
      }
    : rawResources;
  if (pluginPage) {
    console.info("[resource-flow] stage=renderResources", {
      apps: resources.summary?.apps,
      appIds: (resources.apps || []).map((item) => item.id),
      snapshot: resources.snapshot?.state,
    });
  }
  if (!stateDetailLoaded && !state.codexResources) {
    els.resourceSummary.innerHTML = "";
    els.resourceList.innerHTML = `<div class="empty-state">进入资源页后会读取 Codex 当前资源。</div>`;
    return;
  }
  const summary = resources.summary || {};
  if (els.resourceRefreshStatus) {
    const snapshot = resources.snapshot || {};
    const refreshedAt = snapshot.refreshedAt ? formatTime(snapshot.refreshedAt) : "未知";
    const statusLabel = snapshot.state === "authoritative"
      ? "权威读取成功"
      : snapshot.state === "cached"
        ? "App Server 暂不可用，使用最近有效缓存"
        : "尚未取得权威结果";
    const appIds = Array.isArray(snapshot.appIds) && snapshot.appIds.length
      ? `；应用：${snapshot.appIds.join(", ")}`
      : "";
    els.resourceRefreshStatus.textContent = `资源状态：${statusLabel}；最后有效读取：${refreshedAt}${appIds}`;
  }
  const discoveredSummary = resources.discoveredSummary || {};
  const discovered = resources.discovered || {};
  const filteredResources = {
    mcpServers: filteredResourceItems(resources.mcpServers, "mcpServers"),
    plugins: filteredResourceItems(resources.plugins, "plugins"),
    apps: filteredResourceItems(resources.apps, "apps"),
    skills: filteredResourceItems(resources.skills, "skills"),
    marketplaces: filteredResourceItems(resources.marketplaces, "marketplaces"),
    prompts: filteredResourceItems(resources.prompts, "prompts"),
    agentFiles: filteredResourceItems(resources.agentFiles, "agentFiles"),
  };
  const filteredDiscovered = {
    mcpServers: filteredResourceItems(discovered.mcpServers, "discoveredMcpServers"),
    plugins: filteredResourceItems(discovered.plugins, "discoveredPlugins"),
    skills: filteredResourceItems(discovered.skills, "discoveredSkills"),
  };
  const filterSummary = resourceFilterSummary(resources);
  const discoveredTotal = Object.values(filteredDiscovered).reduce((total, value) => total + Number(value?.length || 0), 0);
  const emptyFilter = resourceFilterActive() && filterSummary.total > 0 && filterSummary.visible === 0;
  const skillLabel = resourceSkillLabel(resources);
  els.resourceSummary.innerHTML = `
    <article><span>已安装插件</span><strong>${resourceSummaryDisplay(resources, "plugins")}</strong></article>
    <article><span>应用</span><strong>${resourceSummaryDisplay(resources, "apps")}</strong></article>
    <article><span>插件 MCP</span><strong>${resourceSummaryDisplay(resources, "mcpServers")}</strong></article>
    <article><span>${escapeHtml(skillLabel)}</span><strong>${resourceSummaryDisplay(resources, "skills")}</strong></article>
    <article><span>市场</span><strong>${resourceSummaryDisplay(resources, "marketplaces")}</strong></article>
    <article><span>提示词</span><strong>${resourceSummaryDisplay(resources, "prompts")}</strong></article>
    <article><span>规则文件</span><strong>${resourceSummaryDisplay(resources, "agentFiles")}</strong></article>
  `;
  const availableBlocks = [
    resourceBlock("插件 MCP", filteredResources.mcpServers, resourceShortLabel, "mcpServers", resourceSummaryReadStatus(resources, "mcpServers")),
    resourceBlock("已安装插件", filteredResources.plugins, resourceShortLabel, "plugins", resourceSummaryReadStatus(resources, "plugins")),
    resourceBlock("应用", filteredResources.apps, resourceShortLabel, "apps", resourceSummaryReadStatus(resources, "apps")),
    resourceBlock(skillLabel, filteredResources.skills, resourceShortLabel, "skills", resourceSummaryReadStatus(resources, "skills")),
    resourceBlock("插件市场", filteredResources.marketplaces, resourceShortLabel, "marketplaces", resourceSummaryReadStatus(resources, "marketplaces")),
    resourceBlock("提示词", filteredResources.prompts, resourceShortLabel, "prompts", resourceSummaryReadStatus(resources, "prompts")),
    resourceBlock("规则文件", filteredResources.agentFiles, resourceShortLabel, "agentFiles", resourceSummaryReadStatus(resources, "agentFiles")),
  ];
  const discoveredBlocks = [
    resourceBlock("未启用 MCP", filteredDiscovered.mcpServers, resourceShortLabel, "discoveredMcpServers"),
    resourceBlock("未计入当前可用的插件", filteredDiscovered.plugins, resourceShortLabel, "discoveredPlugins"),
    resourceBlock("未计入当前可用的技能", filteredDiscovered.skills, resourceShortLabel, "discoveredSkills"),
  ].filter((block) => block);
  const diagnosticsBlocks = [
    resourcePluginPageDiagnostics(resources.diagnostics),
    resourceAuthoritySummary(resources.authority),
    resourceBreakdownSummary(resources.breakdown),
    ...discoveredBlocks,
  ].filter(Boolean).join("");
  els.resourceList.innerHTML = `
    <div class="resource-section-title">当前可用</div>
    ${availableBlocks.join("")}
    ${emptyFilter ? `
      <div class="resource-filter-empty">
        没有匹配的资源。可以清空搜索词，或者把筛选状态切回“全部资源”。
      </div>
    ` : ""}
    ${diagnosticsBlocks ? `
      <details class="resource-diagnostics">
        <summary>
          <strong>高级诊断</strong>
          <span>${discoveredTotal ? `${formatNumber(discoveredTotal)} 项未计入当前可用` : "查看来源说明"}</span>
        </summary>
        <div class="resource-diagnostics-grid">
          ${diagnosticsBlocks}
        </div>
      </details>
    ` : ""}
  `;
  els.resourceList.querySelectorAll("[data-resource-expand]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.resourceExpand;
      if (!key) {
        return;
      }
      if (resourceExpandedKeys.has(key)) {
        resourceExpandedKeys.delete(key);
      } else {
        resourceExpandedKeys.add(key);
      }
      renderResources();
    });
  });
  bindResourceActionButtons();
}

function renderHistoryRecoveryStatus() {
  if (!(els.historyRecoveryStatusPanel && historyRecoveryStatus)) {
    return;
  }
  const status = historyRecoveryStatus;
  const phase = String(status.phase || "idle");
  const awaitingManualExit = phase === "awaiting_manual_exit";
  const failed = status.ok === false && (phase === "failed" || awaitingManualExit);
  const succeeded = status.ok === true && phase === "restarted";
  const phaseLabels = {
    idle: "尚未生成恢复计划",
    planned: "只完成扫描，尚未迁移",
    waiting_for_exit: "正在等待 ChatGPT / Codex 退出",
    awaiting_manual_exit: "自动退出失败，尚未迁移",
    migrating: "正在迁移",
    verified: "迁移已提交并回读验证",
    restarted: "迁移成功并已重新启动",
    failed: "迁移失败",
  };
  els.historyRecoveryStatusPanel.classList.remove("hidden", "is-error", "is-success", "is-working");
  els.historyRecoveryStatusPanel.classList.add(failed ? "is-error" : succeeded ? "is-success" : "is-working");
  els.historyRecoveryPhase.textContent = phaseLabels[phase] || phase;
  els.historyRecoveryMessage.textContent = status.message || "";
  els.historyRecoveryPlanned.textContent = formatNumber(status.plannedInserts || status.summary?.plannedInserts || 0);
  els.historyRecoveryInserted.textContent = formatNumber(status.actualInserted || 0);
  els.historyRecoveryCommit.textContent = {
    not_started: "未开始",
    verified: "已提交并验证",
  }[status.commitStatus] || String(status.commitStatus || "未开始");
  els.historyRecoveryBackup.textContent = status.backupDir || "尚未创建";
  els.historyRecoveryCatalog.textContent = formatNumber(status.rereadCatalogThreads || status.catalogThreadsBefore || 0);
  els.historyRecoverySidebar.textContent = formatNumber(status.rereadSidebarThreads || status.sidebarThreadsBefore || 0);
  els.historyRecoveryFailure.textContent = status.failureReason || "";
  els.historyRecoveryFailure.classList.toggle("hidden", !status.failureReason);
  els.retryHistoryRecovery.classList.toggle("hidden", !awaitingManualExit);
}

function applyVerifiedHistoryRecoverySummary(result = {}) {
  if (!(result?.ok && result?.phase === "restarted" && state?.codexSessionTree?.summary)) {
    return;
  }
  const previousSummary = state.codexSessionTree.summary;
  state = {
    ...state,
    codexSessionTree: {
      ...state.codexSessionTree,
      summary: {
        ...previousSummary,
        rawThreads: Number(result.rawThreads || result.summary?.rawThreads || previousSummary.rawThreads || 0),
        activeUserThreads: Number(result.activeUserThreads || result.summary?.activeUserThreads || previousSummary.activeUserThreads || 0),
        catalogThreads: Number(result.rereadCatalogThreads || previousSummary.catalogThreads || 0),
        sidebarThreads: Number(result.rereadSidebarThreads || previousSummary.sidebarThreads || 0),
        recoverableThreads: 0,
      },
    },
  };
}

async function refreshAfterHistoryRecovery(result = {}) {
  const expectedCatalog = Number(result?.rereadCatalogThreads || 0);
  const expectedSidebar = Number(result?.rereadSidebarThreads || 0);
  const attempts = result?.ok && expectedCatalog > 0 ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await refresh({ lite: false });
    const summary = state?.codexSessionTree?.summary || {};
    if (
      !result?.ok ||
      (Number(summary.catalogThreads || 0) === expectedCatalog &&
        Number(summary.sidebarThreads || 0) === expectedSidebar)
    ) {
      return true;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 120));
  }
  return false;
}

function renderSessions() {
  if (!els.sessionList) {
    return;
  }
  renderHistoryRecoveryStatus();
  if (!stateDetailLoaded && !state.codexSessionTree) {
    els.sessionList.innerHTML = `<div class="empty-state">进入会话页后会读取本机 Codex 会话。</div>`;
    return;
  }
  const sessions = Array.isArray(state.codexSessions) ? state.codexSessions : [];
  const tree = sessionTreeFromState(state.codexSessionTree, sessions);
  const searchTerm = normalizeSessionSearchTerm(sessionSearchText);
  const filteredTree = filterSessionTree(tree, sessionSearchText);
  const displayTree = searchTerm ? filteredTree : tree;
  const totalSessions = Number(tree.summary?.sessions || 0);
  const totalProjects = Number(tree.summary?.projects || 0);
  const activeProjects = Number(tree.summary?.activeProjects || 0);
  const historyProjects = Number(tree.summary?.historyProjects || Math.max(0, totalProjects - activeProjects));
  const visibleProjects = displayTree.projects.length;
  const visibleLooseSessions = displayTree.looseSessions.length;
  const visibleProjectSessions = displayTree.projects.reduce((sum, project) => sum + project.sessions.length, 0);
  const visibleSessions = visibleProjectSessions + visibleLooseSessions;
  const sessionLimit = Number(tree.summary?.limit || 0);
  const sessionMayHaveMore = Boolean(tree.summary?.mayHaveMore);
  const filterNote = searchTerm
    ? `<div class="session-filter-note">当前筛选：${formatNumber(visibleProjects)} 个项目、${formatNumber(visibleSessions)} 个会话。原始索引仍是 ${formatNumber(totalProjects)} 个项目、${formatNumber(totalSessions)} 个会话。筛选只影响当前页面显示；可导出当前筛选 Markdown，其它导出按钮仍按原始范围导出。</div>`
    : "";
  const projectFolderCount = searchTerm
    ? `${formatNumber(visibleProjects)} / ${formatNumber(totalProjects)} 个项目`
    : `${formatNumber(totalProjects)} 个项目`;
  const looseSessionCount = searchTerm
    ? `${formatNumber(visibleLooseSessions)} / ${formatNumber(tree.summary?.looseSessions || 0)} 个会话`
    : `${formatNumber(tree.summary?.looseSessions || 0)} 个会话`;
  const sessionLimitNote = sessionMayHaveMore
    ? `<div class="session-limit-note">当前已加载本机 Codex 会话索引前 ${formatNumber(sessionLimit || totalSessions)} 个最近会话；如果本地库数量更多，请复制诊断信息继续对齐。</div>`
    : "";
  const classificationNote = sessionClassificationNote(tree);
  const recoveryResult = projectRecoveryResultPanel(lastProjectRecoveryResult);
  const verifiedRecovery = historyRecoveryStatus?.ok === true && historyRecoveryStatus?.phase === "restarted"
    ? historyRecoveryStatus
    : null;
  const sessionSummary = verifiedRecovery
    ? {
        ...tree.summary,
        rawThreads: Number(verifiedRecovery.rawThreads || verifiedRecovery.summary?.rawThreads || tree.summary?.rawThreads || totalSessions),
        activeUserThreads: Number(verifiedRecovery.activeUserThreads || verifiedRecovery.summary?.activeUserThreads || tree.summary?.activeUserThreads || totalSessions),
        catalogThreads: Number(verifiedRecovery.rereadCatalogThreads || 0),
        sidebarThreads: Number(verifiedRecovery.rereadSidebarThreads || 0),
        recoverableThreads: 0,
      }
    : tree.summary;
  if (!totalSessions && !totalProjects) {
    els.sessionList.innerHTML = `<div class="empty-state">未读取到本机 Codex 会话索引或项目，可能是当前 Codex 版本未暴露本地会话库。</div>`;
    return;
  }
  els.sessionList.innerHTML = `
    <div class="session-overview">
      <span>原始线程总数 ${formatNumber(sessionSummary?.rawThreads || totalSessions)} 个</span>
      <span>普通用户会话 ${formatNumber(sessionSummary?.activeUserThreads || totalSessions)} 个</span>
      <span>Codex 当前目录 ${formatNumber(sessionSummary?.catalogThreads || 0)} 个</span>
      <span>Codex 当前侧栏索引 ${formatNumber(sessionSummary?.sidebarThreads || 0)} 个</span>
      <span>仅可恢复 ${formatNumber(sessionSummary?.recoverableThreads || 0)} 个</span>
      <span>子代理/内部线程 ${formatNumber((sessionSummary?.subagentThreads || 0) + (sessionSummary?.internalThreads || 0))} 个</span>
      <span>已归档会话 ${formatNumber(sessionSummary?.archivedThreads || 0)} 个</span>
    </div>
    <div class="session-limit-note">“Codex 当前目录”是新版 local_thread_catalog 的实际数量；“仅可恢复”表示原始会话仍在，但尚未进入新版目录。恢复前会预览、退出 ChatGPT、完整备份并在事务后回读验证。</div>
    <div class="session-project-actions">
      <button
        class="ghost-button light small"
        type="button"
        data-export-all-sessions
        ${totalSessions ? "" : "disabled"}
      >导出全部 Markdown</button>
      ${searchTerm ? `<button
        class="ghost-button light small"
        type="button"
        data-export-filtered-sessions
        ${visibleSessions ? "" : "disabled"}
      >导出当前筛选 Markdown</button>` : ""}
    </div>
    ${filterNote}
    ${recoveryResult}
    ${classificationNote || sessionLimitNote ? `
      <details class="session-diagnostics">
        <summary>查看归类依据</summary>
        ${sessionLimitNote}
        ${classificationNote}
      </details>
    ` : ""}
    <details class="session-folder" open>
      <summary>
        <strong>项目文件夹</strong>
        <span>${projectFolderCount}</span>
      </summary>
      <div class="session-projects">
        ${displayTree.projects.length
          ? displayTree.projects.map(sessionProjectBlock).join("")
          : `<div class="empty-state">${searchTerm ? "没有匹配的项目文件夹。" : "没有识别到项目文件夹。"}</div>`}
      </div>
    </details>
    <details class="session-folder" open>
      <summary>
        <strong>无项目会话</strong>
        <span>${looseSessionCount}</span>
      </summary>
      <div class="session-project-actions">
        <button
          class="ghost-button light small"
          type="button"
          data-export-loose-sessions
          ${tree.looseSessions.length ? "" : "disabled"}
        >导出无项目 Markdown</button>
      </div>
      <div class="session-project-list">
        ${displayTree.looseSessions.length
          ? displayTree.looseSessions.map(sessionItem).join("")
          : `<div class="empty-state">${searchTerm ? "没有匹配的无项目会话。" : "没有无项目会话。"}</div>`}
      </div>
    </details>
  `;
  bindAllSessionsExportButton();
  bindFilteredSessionsExportButton();
  bindLooseSessionsExportButton();
  bindProjectExportButtons();
  bindSessionExportButtons();
  bindSessionFolderButtons();
}

function projectRecoverySummaryFromState(plan, tree) {
  const summary = plan?.summary || {};
  const launchableProjects = finiteCount(summary.launchableProjects, 0);
  const missingProjects = finiteCount(summary.missingProjects, 0);
  const looseSessions = finiteCount(summary.looseSessions, tree?.summary?.looseSessions || 0);
  const launchRoots = Array.isArray(plan?.launchRoots) ? plan.launchRoots : [];
  const missingRoots = Array.isArray(plan?.missingRoots) ? plan.missingRoots : [];
  const launchPreview = launchRoots
    .slice(0, 3)
    .map((item) => item.name || item.path)
    .filter(Boolean)
    .join("、");
  const missingPreview = missingRoots
    .slice(0, 2)
    .map((item) => item.name || item.path)
    .filter(Boolean)
    .join("、");
  const detail = [
    launchPreview ? `可打开：${launchPreview}` : "",
    missingPreview ? `缺失：${missingPreview}` : "",
  ].filter(Boolean).join("；");
  return `
    <div class="session-recovery-summary">
      <span><strong>可恢复项目</strong>${formatNumber(launchableProjects)} 个</span>
      <span><strong>缺失项目</strong>${formatNumber(missingProjects)} 个</span>
      <span><strong>无项目会话</strong>${formatNumber(looseSessions)} 个</span>
      ${detail ? `<em>${escapeHtml(detail)}</em>` : ""}
    </div>
  `;
}

function projectRecoveryResultPanel(result) {
  if (!result) {
    return "";
  }
  const launchedRoots = Array.isArray(result.launchedRoots) ? result.launchedRoots : [];
  const missingRoots = Array.isArray(result.missingRoots) ? result.missingRoots : [];
  const launchedList = launchedRoots
    .map((item) => item.name || item.path)
    .filter(Boolean)
    .slice(0, 8);
  const missingList = missingRoots
    .map((item) => item.name || item.path)
    .filter(Boolean)
    .slice(0, 8);
  return `
    <div class="session-recovery-result ${result.ok ? "pass" : "warn"}">
      <div>
        <strong>${result.ok ? "项目恢复已请求" : "项目恢复未执行"}</strong>
        <span>${escapeHtml(result.message || "恢复项目列表操作已返回。")}</span>
      </div>
      <div class="session-recovery-result-grid">
        <span><strong>已请求打开</strong>${formatNumber(result.launched || launchedRoots.length)} 个</span>
        <span><strong>路径缺失</strong>${formatNumber(missingRoots.length)} 个</span>
      </div>
      ${launchedList.length ? `<p>已请求打开：${escapeHtml(launchedList.join("、"))}</p>` : ""}
      ${missingList.length ? `<p>路径缺失：${escapeHtml(missingList.join("、"))}</p>` : ""}
    </div>
  `;
}

function bindAllSessionsExportButton() {
  els.sessionList.querySelectorAll("[data-export-all-sessions]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const response = await api.exportAllSessionsMarkdown();
        if (response?.canceled) {
          showToast("已取消导出全部会话。");
          return;
        }
        const sessionCount = response?.tree?.summary?.sessions || 0;
        const projectCount = response?.tree?.summary?.projects || 0;
        showToast(`全部会话 Markdown 已保存：${response?.filePath || "未知位置"}，包含 ${formatNumber(projectCount)} 个项目、${formatNumber(sessionCount)} 个会话。`);
      }),
    );
  });
}

function bindFilteredSessionsExportButton() {
  els.sessionList.querySelectorAll("[data-export-filtered-sessions]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const sessions = Array.isArray(state.codexSessions) ? state.codexSessions : [];
        const tree = sessionTreeFromState(state.codexSessionTree, sessions);
        const displayTree = filterSessionTree(tree, sessionSearchText);
        const sessionIds = filteredSessionIds(displayTree);
        const response = await api.exportFilteredSessionsMarkdown({
          sessionIds: filteredSessionIds(displayTree),
          filterText: sessionSearchText,
        });
        if (response?.canceled) {
          showToast("已取消导出当前筛选。");
          return;
        }
        const sessionCount = response?.tree?.summary?.sessions || sessionIds.length || 0;
        showToast(`当前筛选 Markdown 已保存：${response?.filePath || "未知位置"}，共 ${formatNumber(sessionCount)} 个会话，已复制到剪贴板。`);
      }),
    );
  });
}

function bindLooseSessionsExportButton() {
  els.sessionList.querySelectorAll("[data-export-loose-sessions]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const response = await api.exportLooseSessionsMarkdown();
        if (response?.canceled) {
          showToast("已取消导出无项目会话。");
          return;
        }
        const sessionCount = response?.group?.sessions?.length || 0;
        showToast(`无项目会话 Markdown 已保存：${response?.filePath || "未知位置"}，共 ${formatNumber(sessionCount)} 个会话，已复制到剪贴板。`);
      }),
    );
  });
}

function bindProjectExportButtons() {
  els.sessionList.querySelectorAll("[data-export-project]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      runAction(button, async () => {
        const response = await api.exportProjectMarkdown(button.dataset.exportProject);
        if (response?.canceled) {
          showToast("已取消导出项目。");
          return;
        }
        showToast(`项目 Markdown 已保存：${response?.filePath || "未知位置"}，并已复制到剪贴板：${formatNumber(response?.markdownLength || 0)} 字符。`);
      });
    });
  });
}

function bindSessionExportButtons() {
  els.sessionList.querySelectorAll("[data-export-session]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const response = await api.exportSessionMarkdown(button.dataset.exportSession);
        if (response?.canceled) {
          showToast("已取消导出会话。");
          return;
        }
        showToast(`会话 Markdown 已保存：${response?.filePath || "未知位置"}，并已复制到剪贴板：${formatNumber(response?.markdownLength || 0)} 字符。`);
      }),
    );
  });
}

function bindSessionFolderButtons() {
  els.sessionList.querySelectorAll("[data-open-project-folder], [data-open-session-folder]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      runAction(button, async () => {
        const target = button.dataset.openProjectFolder || button.dataset.openSessionFolder || "";
        if (!target) {
          return;
        }
        const result = await api.openFolder(target);
        if (!result?.ok) {
          throw new Error(result?.message || "打开目录失败。");
        }
        showToast("目录已打开。");
      });
    });
  });
}

function resourceSkillLabel(resources = {}) {
  return "用户技能";
}

function resourceFilterSummary(resources = {}) {
  const discovered = resources.discovered || {};
  const groups = [
    ["mcpServers", resources.mcpServers],
    ["plugins", resources.plugins],
    ["apps", resources.apps],
    ["skills", resources.skills],
    ["marketplaces", resources.marketplaces],
    ["prompts", resources.prompts],
    ["agentFiles", resources.agentFiles],
    ["discoveredMcpServers", discovered.mcpServers],
    ["discoveredPlugins", discovered.plugins],
    ["discoveredSkills", discovered.skills],
  ];
  return groups.reduce(
    (summary, [key, items]) => {
      const list = Array.isArray(items) ? items : [];
      summary.total += list.length;
      summary.visible += filteredResourceItems(list, key).length;
      return summary;
    },
    { total: 0, visible: 0 },
  );
}

function resourceBreakdownSummary(breakdown = {}) {
  const current = resourceBreakdownText(breakdown.current, "当前可用来源");
  const discovered = resourceBreakdownText(breakdown.discovered, "诊断区来源");
  if (!current && !discovered) {
    return "";
  }
  return `
    <details class="resource-breakdown">
      <summary>查看统计来源</summary>
      ${current ? `<span>${escapeHtml(current)}</span>` : ""}
      ${discovered ? `<span>${escapeHtml(discovered)}</span>` : ""}
    </details>
  `;
}

function resourcePluginPageDiagnostics(diagnostics = {}) {
  const manifestApps = Number(diagnostics?.manifestAppDeclarations || 0);
  const skillFiles = Number(diagnostics?.discoveredSkillFiles || 0);
  if (!manifestApps && !skillFiles) {
    return "";
  }
  const parts = [
    manifestApps ? `发现的 App manifest 声明：${formatNumber(manifestApps)}` : "",
    skillFiles ? `发现的插件技能文件：${formatNumber(skillFiles)}` : "",
  ].filter(Boolean);
  return `<div class="resource-count-note">${escapeHtml(parts.join("；"))}。这些是磁盘诊断数量，不计入 Codex 插件页当前数量。</div>`;
}

function resourceAuthoritySummary(authority = {}) {
  const plugins = authority.plugins || {};
  const mcpServers = authority.mcpServers || {};
  const skills = authority.skills || {};
  const cards = [
    {
      title: "插件 / MCP",
      detail: [plugins.detail, mcpServers.detail].filter(Boolean).join(" "),
    },
    {
      title: "技能",
      detail: skills.detail || "技能数量来自本地 .codex/skills；插件内置技能和缓存技能只放诊断区。",
    },
    {
      title: "管理边界",
      detail: "插件和 MCP 的开关写入 Codex config.toml；本地用户技能只改名单个 SKILL.md；插件内置技能跟随插件开关。",
    },
  ].filter((item) => item.detail);
  if (!cards.length) {
    return "";
  }
  const details = cards.map((item) => `${item.title}：${item.detail}`).join(" ");
  return `
    <div class="resource-count-note">${escapeHtml(details)}</div>
  `;
}

function resourceBreakdownText(groups = {}, label = "") {
  const parts = Object.entries(groups || {})
    .flatMap(([kind, counts]) => resourceBreakdownParts(kind, counts))
    .filter(Boolean);
  return parts.length ? `${label}：${parts.join("、")}` : "";
}

function resourceBreakdownParts(kind = "", counts = {}) {
  return Object.entries(counts || {})
    .filter(([, count]) => Number(count || 0) > 0)
    .sort((left, right) => resourceBreakdownLabel(left[0]).localeCompare(resourceBreakdownLabel(right[0])))
    .map(([source, count]) => `${resourceKindLabelForBreakdown(kind)} ${resourceBreakdownLabel(source)} ${formatNumber(count)}`);
}

function resourceKindLabelForBreakdown(kind = "") {
  if (kind === "mcpServers") {
    return "MCP";
  }
  if (kind === "agentFiles") {
    return "规则";
  }
  const labels = {
    plugins: "插件",
    skills: "技能",
    marketplaces: "市场",
    prompts: "提示词",
  };
  return labels[kind] || "资源";
}

function resourceBreakdownLabel(value = "") {
  const labels = {
    agents: "Agents 目录",
    cached: "缓存",
    codex: "Codex 用户目录",
    "codex-cli": "Codex 官方列表",
    config: "Codex 配置",
    config_only: "配置未确认",
    disabled: "未启用配置",
    external: "外部插件诊断",
    internal: "Codex 内置",
    "claude-plugins-official": "Claude 插件源",
    local: "本地目录",
    marketplace: "插件市场候选",
    "openai-bundled": "Codex 内置插件",
    "openai-curated": "OpenAI 插件市场",
    "openai-curated-remote": "OpenAI 远程插件市场",
    personal: "个人本地插件",
    plugin: "已安装插件",
    project: "当前项目",
    unknown: "未知来源",
  };
  return labels[value] || String(value || "未知来源");
}

function filteredResourceItems(items = [], key = "") {
  return (Array.isArray(items) ? items : []).filter((item) => resourceMatchesFilter(item, key));
}

function resourceFilterActive() {
  return Boolean(resourceFilterText.trim()) || resourceStatusFilter !== "all" || resourceSourceFilter !== "all";
}

function resourceIsCurrentResource(item = {}, status = "info", key = "") {
  if (key.startsWith("discovered")) {
    return false;
  }
  if (status === "pass") {
    return true;
  }
  return status === "info" && item.enabled !== false && !["cached", "disabled"].includes(item.availability);
}

function resourceNeedsAttention(item = {}, status = "info", key = "") {
  return key.startsWith("discovered")
    || ["warn", "fail"].includes(status)
    || item.enabled === false
    || ["cached", "disabled"].includes(item.availability);
}

function resourceMatchesFilter(item = {}, key = "") {
  const diagnostic = resourceDiagnostic(item);
  const status = diagnostic?.status || "info";
  const filter = ["all", "issues", "current", "not-current"].includes(resourceStatusFilter)
    ? resourceStatusFilter
    : "all";
  if (!resourceMatchesSourceFilter(item, key)) {
    return false;
  }
  if (filter === "issues" && !["warn", "fail"].includes(status)) {
    return false;
  }
  if (filter === "current" && !resourceIsCurrentResource(item, status, key)) {
    return false;
  }
  if (filter === "not-current" && !resourceNeedsAttention(item, status, key)) {
    return false;
  }
  const query = resourceFilterText.trim().toLowerCase();
  if (!query) {
    return true;
  }
  const update = resourceUpdateNote(item);
  const fields = [
    key,
    resourceLabel(item),
    resourcePurpose(item),
    resourceDescription(item),
    resourceManagementNote(item),
    diagnostic?.status,
    diagnostic?.label,
    diagnostic?.detail,
    update?.label,
    update?.detail,
    item.name,
    item.id,
    item.path,
    item.command,
    item.description,
    item.source,
    item.pluginSource,
    item.pluginId,
    item.tableName,
    item.availability,
    item.version,
    ...resourceDetails(item).flatMap((detail) => [detail.label, detail.value]),
  ];
  return fields.some((value) => String(value || "").toLowerCase().includes(query));
}

function resourceMatchesSourceFilter(item = {}, key = "") {
  const filter = String(resourceSourceFilter || "all");
  if (filter === "all") {
    return true;
  }
  const availability = String(item.availability || "");
  const source = String(item.source || "");
  const pluginSource = String(item.pluginSource || "");
  const normalizedKey = String(key || "").toLowerCase();
  const isPluginLike = Boolean(item.id || item.pluginId || item.pluginSource || normalizedKey.includes("plugin"));
  if (filter === "marketplace") {
    return availability === "marketplace" || availability === "marketplace_source" || normalizedKey.includes("marketplace");
  }
  if (filter === "cached") {
    return availability === "cached" || source === "cache";
  }
  if (filter === "installed") {
    return isPluginLike && item.installed !== false && availability !== "marketplace" && availability !== "cached";
  }
  return pluginSource === filter || source === filter;
}

function resourceBlock(title, items = [], labelFn = resourceShortLabel, key = title, readStatus = null) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length && key.startsWith("discovered")) {
    return "";
  }
  const readable = resourceReadStatusAvailable(readStatus);
  const expanded = resourceExpandedKeys.has(key);
  const visible = expanded ? list : list.slice(0, 6);
  const rows = !readable
    ? `<li class="muted">无法读取</li>`
    : list.length
    ? visible
        .map((item, index) => resourceItem(item, labelFn, key, index))
        .join("")
    : `<li class="muted">暂无</li>`;
  return `
    <article class="resource-block ${expanded ? "expanded" : ""}">
      <header>
        <strong>${escapeHtml(title)}</strong>
        <span>${readable ? formatNumber(list.length) : "无法读取"}</span>
      </header>
      <ul>${rows}</ul>
      ${readable && list.length > 6 ? `
        <button class="resource-more-button" type="button" data-resource-expand="${escapeHtml(key)}">
          ${expanded ? "收起" : `展开全部（还有 ${formatNumber(list.length - visible.length)} 项）`}
        </button>
      ` : ""}
    </article>
  `;
}

function resourceItem(item = {}, labelFn = resourceLabel, key = "resource", index = 0) {
  const label = labelFn(item);
  const detailKey = resourceDetailKey(item, key, index);
  resourceDetailItems.set(detailKey, { item, label, key });
  const openTarget = resourceOpenTarget(item);
  const management = resourceManagementAction(item, key);
  const updateAction = resourceUpdateAction(item);
  const removeAction = resourceRemoveAction(item);
  const diagnostic = resourceDiagnostic(item);
  const showInlineDiagnostic = diagnostic && ["warn", "fail"].includes(diagnostic.status);
  return `
    <li class="resource-item">
      <div class="resource-item-main">
        <strong>${escapeHtml(label)}</strong>
        ${resourcePrimaryMeta(item, diagnostic, key)}
        ${showInlineDiagnostic ? `
          <div class="resource-diagnostic ${escapeHtml(diagnostic.status)}">
            <strong>${escapeHtml(diagnostic.label)}</strong>
            <span>${escapeHtml(diagnostic.detail)}</span>
          </div>
        ` : ""}
      </div>
      <div class="resource-actions">
        <button class="ghost-button light small" type="button" data-resource-detail="${escapeHtml(detailKey)}">详情</button>
        <button class="ghost-button light small" type="button" data-resource-open="${escapeHtml(openTarget)}" ${openTarget ? "" : "disabled"}>打开目录</button>
        ${management ? `
          <button
            class="ghost-button light small"
            type="button"
            data-resource-toggle-kind="${escapeHtml(management.kind)}"
            data-resource-toggle-id="${escapeHtml(management.id)}"
            data-resource-toggle-enabled="${management.nextEnabled ? "true" : "false"}"
          >${escapeHtml(management.label)}</button>
        ` : ""}
        ${updateAction ? `
          <button
            class="ghost-button light small"
            type="button"
            data-resource-update-action="${escapeHtml(updateAction.action)}"
            data-resource-update-kind="${escapeHtml(updateAction.kind)}"
            data-resource-update-id="${escapeHtml(updateAction.id)}"
          >${escapeHtml(updateAction.label)}</button>
        ` : ""}
        ${removeAction ? `
          <button
            class="plain-button small"
            type="button"
            data-resource-remove-action="${escapeHtml(removeAction.action)}"
            data-resource-remove-kind="${escapeHtml(removeAction.kind)}"
            data-resource-remove-id="${escapeHtml(removeAction.id)}"
          >${escapeHtml(removeAction.label)}</button>
        ` : ""}
      </div>
    </li>
  `;
}

function resourceDetailKey(item = {}, key = "resource", index = 0) {
  return [
    key,
    index,
    item.id || item.name || item.pluginId || item.path || item.command || "resource",
  ].map((part) => String(part || "").replace(/\s+/g, "_")).join(":");
}

function resourceDiagnostic(item = {}) {
  const diagnostic = item.diagnostic || {};
  const label = String(diagnostic.label || "").trim();
  const detail = String(diagnostic.detail || "").trim();
  if (!label && !detail) {
    return null;
  }
  const status = ["pass", "warn", "fail", "info"].includes(diagnostic.status)
    ? diagnostic.status
    : "info";
  return {
    status,
    label: label || "诊断",
    detail,
  };
}

function resourceManagementAction(item = {}, key = "") {
  const management = item.management || {};
  if (management.toggleable) {
    return {
      kind: management.toggleKind || "",
      id: management.id || "",
      nextEnabled: Boolean(management.nextEnabled),
      label: management.actionLabel || (management.nextEnabled ? "启用" : "停用"),
    };
  }
  const keyText = String(key || "").toLowerCase();
  const kind = keyText.includes("plugin")
    ? "plugin"
    : keyText.includes("mcp")
      ? "mcp"
      : keyText.includes("skill") && item.source === "codex"
        ? "skill"
        : "";
  if ((kind === "plugin" || kind === "mcp") && !item.tableName) {
    return null;
  }
  if (kind === "skill" && item.pluginId) {
    return null;
  }
  const id = kind === "plugin" ? item.id : item.name;
  if (!kind || !id) {
    return null;
  }
  const nextEnabled = item.enabled === false || item.availability === "disabled";
  return {
    kind,
    id,
    nextEnabled,
    label: nextEnabled ? "启用" : "停用",
  };
}

function resourceManagementNote(item = {}) {
  const management = item.management || {};
  return String(management.note || "").trim();
}

function resourceUpdateNote(item = {}) {
  const management = item.management || {};
  const label = String(management.updateLabel || "").trim();
  const detail = String(management.updateNote || "").trim();
  if (!label && !detail) {
    return null;
  }
  return {
    label: label || "更新方式",
    detail,
  };
}

function resourceUpdateAction(item = {}) {
  const management = item.management || {};
  if (!management.updateable) {
    return null;
  }
  const action = String(management.updateAction || "check_updates").trim();
  if (!action) {
    return null;
  }
  if (action !== "check_updates" && action !== "update_plugin") {
    return null;
  }
  return {
    action,
    kind: action === "update_plugin" ? "plugin" : "",
    id: action === "update_plugin" ? String(management.id || item.id || "").trim() : "",
    label: String(management.updateLabel || "").trim() || "检查更新",
  };
}

function resourceRemoveAction(item = {}) {
  const management = item.management || {};
  if (!management.removeable) {
    return null;
  }
  const action = String(management.removeAction || "remove_plugin").trim();
  if (action !== "remove_plugin") {
    return null;
  }
  const id = String(management.removeId || management.id || item.id || "").trim();
  if (!id) {
    return null;
  }
  return {
    action,
    kind: "plugin",
    id,
    label: String(management.removeLabel || "").trim() || "卸载插件",
  };
}

function resourceDiagnosticCopyText(item = {}, labelFn = resourceLabel, key = "resource") {
  const diagnostic = resourceDiagnostic(item);
  const update = resourceUpdateNote(item);
  const purpose = resourcePurpose(item);
  const description = resourceDescription(item);
  const details = resourceDetails(item);
  const managementNote = resourceManagementNote(item);
  const management = item.management || {};
  const counted = resourceIsCurrentResource(item, diagnostic?.status || "info", key);
  const lines = [
    "CodexBridge 资源诊断",
    `资源：${labelFn(item)}`,
    `分组：${String(key || "resource")}`,
    `计入当前可用：${counted ? "是" : "否"}`,
    purpose ? `用途说明：${purpose}` : "",
    description ? `用途：${description}` : "",
    `来源：${resourceSourceLabel(item.source || item.pluginSource || "") || "-"}`,
    item.availability ? `可用性：${resourceAvailabilityLabel(item.availability) || item.availability}` : "",
    item.enabled === false ? "启用状态：未启用" : item.enabled === true ? "启用状态：已启用" : "",
    item.version ? `版本：${item.version}` : "",
    diagnostic ? `诊断：${diagnostic.label}${diagnostic.detail ? ` - ${diagnostic.detail}` : ""}` : "",
    managementNote ? `管理提示：${managementNote}` : "",
    update ? `更新方式：${update.label}${update.detail ? ` - ${update.detail}` : ""}` : "",
    management.toggleable ? `可切换：是，当前按钮会${management.nextEnabled ? "启用" : "停用"}该资源` : "可切换：否",
    item.path ? `路径：${item.path}` : "",
    item.command ? `命令：${item.command}` : "",
    item.tableName ? `配置表：${item.tableName}` : "",
    item.pluginId ? `插件：${item.pluginId}` : "",
    ...details.map((detail) => `${detail.label}：${detail.value}`),
  ].filter(Boolean);
  return lines.join("\n");
}

function resourceKindLabel(kind) {
  if (kind === "plugin") {
    return "插件";
  }
  if (kind === "skill") {
    return "技能";
  }
  return "MCP";
}

function resourceGroupLabel(key = "") {
  const labels = {
    mcpServers: "当前 MCP",
    plugins: "已安装插件",
    skills: "当前技能",
    marketplaces: "插件市场",
    prompts: "提示词",
    agentFiles: "规则文件",
    discoveredMcpServers: "未启用 MCP",
    discoveredPlugins: "未启用/缓存/市场插件",
    discoveredSkills: "未启用/缓存技能",
  };
  return labels[key] || String(key || "资源");
}

function resourceToggleToastMessage({ label = "资源", id = "", enabled = false, backup = "" } = {}) {
  const backupText = backup ? `，已自动备份：${backup}` : "";
  return `${label} ${id} 已${enabled ? "启用" : "停用"}${backupText}。`;
}

function resourceLabel(item = {}) {
  const name = item.name || item.id || item.path || item.command || "-";
  const source = item.source || item.pluginSource || "";
  const version = item.version ? ` · v${item.version}` : "";
  const plugin = item.pluginId ? ` · ${item.pluginId}` : "";
  const availability = resourceAvailabilityLabel(item.availability);
  const suffix = `${plugin}${version}${availability ? ` · ${availability}` : ""}`;
  return source ? `${name} · ${resourceSourceLabel(source)}${suffix}` : `${name}${suffix}`;
}

function resourceShortLabel(item = {}) {
  return String(item.name || item.id || item.pluginId || item.path || item.command || "-").trim() || "-";
}

function resourcePrimaryMeta(item = {}, diagnostic = null, key = "") {
  const parts = [
    resourceSourceLabel(item.source || item.pluginSource || ""),
    resourceAvailabilityLabel(item.availability),
    item.version ? `v${item.version}` : "",
    key.startsWith("discovered") ? "不计入当前可用" : "",
  ].filter(Boolean);
  if (!parts.length && !diagnostic?.label) {
    return "";
  }
  return `
    <div class="resource-primary-meta">
      ${diagnostic?.label ? `<span>${escapeHtml(diagnostic.label)}</span>` : ""}
      ${parts.map((part) => `<span>${escapeHtml(part)}</span>`).join("")}
    </div>
  `;
}

function resourceDescription(item = {}) {
  const description = String(item.description || "").trim();
  if (description) {
    return description;
  }
  if (item.command) {
    return "通过命令启动的 MCP 服务。";
  }
  if (item.pluginId) {
    return `来自 ${item.pluginId} 插件。`;
  }
  if (item.path) {
    return "本地文件资源。";
  }
  return "";
}

function resourcePurpose(item = {}) {
  const purpose = String(item.purpose || "").trim();
  if (purpose) {
    return purpose;
  }
  return resourceDescription(item);
}

function resourceDetails(item = {}) {
  return (Array.isArray(item.details) ? item.details : [])
    .map((detail) => ({
      label: String(detail?.label || "").trim(),
      value: String(detail?.value || "").trim(),
    }))
    .filter((detail) => detail.label && detail.value);
}

function resourceBadges(item = {}) {
  return [
    item.enabled === false ? "未启用" : "",
    item.enabled === true ? "已启用" : "",
    resourceAvailabilityLabel(item.availability),
    item.version ? `v${item.version}` : "",
    item.path ? shortText(item.path, 72) : "",
    item.command ? shortText(item.command, 72) : "",
  ].filter(Boolean);
}

function resourceCopyText(item = {}) {
  return String(item.path || item.command || item.tableName || item.id || item.name || "").replace(/\r?\n/g, " ");
}

function resourceOpenTarget(item = {}) {
  const value = String(item.path || "").trim();
  if (!value) {
    return "";
  }
  return looksLikeFilePath(value) ? folderFromPath(value) : value;
}

function looksLikeFilePath(value) {
  return /\.(md|txt|prompt|json|toml|yaml|yml|js|mjs|cjs|ts|tsx)$/i.test(String(value || ""));
}

function bindResourceActionButtons() {
  els.resourceList.querySelectorAll("[data-resource-copy]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const text = button.dataset.resourceCopy || "";
        if (!text) {
          return;
        }
        await api.copyText(text);
        showToast("资源位置已复制。");
      }),
    );
  });
  els.resourceList.querySelectorAll("[data-resource-copy-diagnostic]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const text = button.dataset.resourceCopyDiagnostic || "";
        if (!text) {
          return;
        }
        await api.copyText(text);
        showToast("资源诊断已复制。");
      }),
    );
  });
  els.resourceList.querySelectorAll("[data-resource-detail]").forEach((button) => {
    button.addEventListener("click", () => {
      showResourceDetail(resourceDetailItems.get(button.dataset.resourceDetail || ""));
    });
  });
  els.resourceList.querySelectorAll("[data-resource-open]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const target = button.dataset.resourceOpen || "";
        if (!target) {
          return;
        }
        const result = await api.openFolder(target);
        if (!result?.ok) {
          throw new Error(result?.message || "打开资源目录失败。");
        }
      }),
    );
  });
  els.resourceList.querySelectorAll("[data-resource-update-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.resourceUpdateAction || "";
      if (action === "check_updates") {
        return runUpdateCheck(button);
      }
      if (action === "update_plugin") {
        return runAction(button, async () => {
          const kind = button.dataset.resourceUpdateKind || "plugin";
          const id = button.dataset.resourceUpdateId || "";
          const actionLabel = button.textContent.trim() || "更新插件";
          const accepted = await showConfirmDialog({
            title: actionLabel,
            message: `CodexBridge 会调用 Codex CLI 刷新插件市场并${actionLabel.includes("安装") ? "安装" : "重新安装"}：${id}。这个操作不会删除插件目录，完成后请重启 ChatGPT / Codex 最稳。`,
            confirmText: actionLabel,
          });
          if (!accepted) {
            return;
          }
          const response = await api.updateCodexResource({ kind, id });
          state = response?.state || await api.getState();
          render();
          showToast(response?.message || `插件 ${id} 已刷新/更新。`);
        });
      }
      return runAction(button, async () => {
        showToast("这个资源没有可执行的更新动作；请复制诊断确认来源。");
      });
    });
  });
  els.resourceList.querySelectorAll("[data-resource-remove-action]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const action = button.dataset.resourceRemoveAction || "";
        const isRemovePlugin = action === "remove_plugin";
        if (!isRemovePlugin) {
          showToast("这个资源没有可执行的卸载动作；请复制诊断确认来源。");
          return;
        }
        const kind = button.dataset.resourceRemoveKind || "plugin";
        const id = button.dataset.resourceRemoveId || "";
        const accepted = await showConfirmDialog({
          title: "卸载插件",
          message: `CodexBridge 会调用 Codex CLI 卸载插件：${id}。卸载后如果 ChatGPT / Codex 已经打开，建议重启桌面应用，让插件列表重新加载。`,
          confirmText: "卸载插件",
        });
        if (!accepted) {
          return;
        }
        const response = await api.removeCodexResource({ kind, id });
        state = response?.state || await api.getState();
        render();
        showToast(response?.message || `插件 ${id} 已卸载。`);
      }),
    );
  });
  els.resourceList.querySelectorAll("[data-resource-toggle-kind]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const kind = button.dataset.resourceToggleKind || "";
        const id = button.dataset.resourceToggleId || "";
        const enabled = button.dataset.resourceToggleEnabled === "true";
        const label = resourceKindLabel(kind);
        const accepted = await showConfirmDialog({
          title: enabled ? "启用资源" : "停用资源",
          message: `${enabled ? "启用" : "停用"}${label}：${id}？${kind === "skill" ? "这会移动单个本地技能文件，重启 ChatGPT / Codex 后最稳。" : "修改会写入 Codex config.toml，重启 ChatGPT / Codex 后最稳。"}`,
          confirmText: enabled ? "启用" : "停用",
        });
        if (!accepted) {
          return;
        }
        const response = await api.setCodexResourceEnabled({ kind, id, enabled });
        state = response?.state || await api.getState();
        render();
        showToast(resourceToggleToastMessage({ label, id, enabled, backup: response?.backup }));
      }),
    );
  });
}

function resourceSourceLabel(source) {
  if (source === "config") {
    return "Codex 配置";
  }
  if (source === "codex") {
    return "Codex 用户目录";
  }
  if (source === "codex-cli") {
    return "Codex 官方列表";
  }
  if (source === "codex-prompt") {
    return "Codex 当前提示";
  }
  if (source === "agents") {
    return "Agents 配置目录";
  }
  if (source === "plugin") {
    return "插件内置";
  }
  if (source === "project") {
    return "当前项目目录";
  }
  if (source === "cache") {
    return "本地缓存";
  }
  return source;
}

function resourceAvailabilityLabel(availability) {
  if (availability === "prompt") {
    return "当前提示可见";
  }
  if (availability === "not_prompt") {
    return "未进入当前提示";
  }
  if (availability === "disabled") {
    return "未启用";
  }
  if (availability === "internal") {
    return "内置运行能力";
  }
  if (availability === "local") {
    return "用户目录";
  }
  if (availability === "plugin") {
    return "插件内置";
  }
  if (availability === "cached") {
    return "本地缓存（当前不可用）";
  }
  if (availability === "marketplace") {
    return "可从插件市场安装";
  }
  if (availability === "config_only") {
    return "配置未确认";
  }
  return "";
}

function sessionTreeFromState(tree, sessions = []) {
  const fallbackSessions = Array.isArray(sessions) ? sessions : [];
  if (tree && Array.isArray(tree.projects) && Array.isArray(tree.looseSessions)) {
    const projects = tree.projects.map(normalizeSessionProject);
    const looseSessions = tree.looseSessions.filter(Boolean);
    const projectSessions = projects.reduce((sum, project) => sum + project.sessions.length, 0);
    const treeSessions = Array.isArray(tree.sessions) ? tree.sessions : fallbackSessions;
    return {
      summary: {
        sessions: finiteCount(tree.summary?.sessions, treeSessions.length || projectSessions + looseSessions.length),
        projects: finiteCount(tree.summary?.projects, projects.length),
        activeProjects: finiteCount(tree.summary?.activeProjects, projects.filter((project) => project.active).length),
        historyProjects: finiteCount(
          tree.summary?.historyProjects,
          projects.filter((project) => !project.active).length,
        ),
        projectSessions: finiteCount(tree.summary?.projectSessions, projectSessions),
        looseSessions: finiteCount(tree.summary?.looseSessions, looseSessions.length),
        loadedSessions: finiteCount(tree.summary?.loadedSessions, treeSessions.length),
        limit: finiteCount(tree.summary?.limit, treeSessions.length),
        mayHaveMore: Boolean(tree.summary?.mayHaveMore),
      },
      classification: tree.classification || {},
      sessions: treeSessions,
      projects,
      looseSessions,
    };
  }
  const grouped = groupSessionsByProject(fallbackSessions);
  const projectSessions = grouped.projects.reduce((sum, project) => sum + project.sessions.length, 0);
  return {
    summary: {
      sessions: fallbackSessions.length,
      projects: grouped.projects.length,
      activeProjects: 0,
      historyProjects: grouped.projects.length,
      projectSessions,
      looseSessions: grouped.looseSessions.length,
      loadedSessions: fallbackSessions.length,
      limit: fallbackSessions.length,
      mayHaveMore: false,
    },
    classification: sessionTreeClassificationFromSessions(fallbackSessions, grouped.projects),
    sessions: fallbackSessions,
    projects: grouped.projects,
    looseSessions: grouped.looseSessions,
  };
}

function sessionTreeClassificationFromSessions(sessions = [], projects = []) {
  const countByValue = (items, keyFn) =>
    (Array.isArray(items) ? items : []).reduce((counts, item) => {
      const key = String(keyFn(item) || "unknown");
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
  return {
    projectReasons: countByValue(sessions, (session) => session.projectReason || "unknown"),
    projectSources: countByValue(projects, (project) => project.source || "unknown"),
    workspaceRoots: projects.length,
    sidebarProjectThreadAssignments: 0,
    projectlessThreadMarkers: sessions.filter((session) => session.projectReason === "projectless_marker").length,
  };
}

function filterSessionTree(tree, query = "") {
  const term = normalizeSessionSearchTerm(query);
  if (!term) {
    return tree;
  }
  const projects = (Array.isArray(tree.projects) ? tree.projects : [])
    .map((project) => {
      const projectMatches = sessionSearchBlob(project).includes(term);
      const sessions = (Array.isArray(project.sessions) ? project.sessions : []).filter((session) =>
        projectMatches || sessionSearchBlob(session).includes(term),
      );
      if (!projectMatches && !sessions.length) {
        return null;
      }
      return {
        ...project,
        sessions,
      };
    })
    .filter(Boolean);
  const looseSessions = (Array.isArray(tree.looseSessions) ? tree.looseSessions : []).filter((session) =>
    sessionSearchBlob(session).includes(term),
  );
  const filteredProjectSessions = projects.reduce((sum, project) => sum + project.sessions.length, 0);
  const filteredSessions = filteredProjectSessions + looseSessions.length;
  return {
    ...tree,
    filtered: true,
    filterText: String(query || "").trim(),
    projects,
    looseSessions,
    summary: {
      ...(tree.summary || {}),
      filteredProjects: projects.length,
      filteredProjectSessions,
      filteredLooseSessions: looseSessions.length,
      filteredSessions,
    },
  };
}

function filteredSessionIds(tree = {}) {
  const projectIds = (Array.isArray(tree.projects) ? tree.projects : [])
    .flatMap((project) => Array.isArray(project.sessions) ? project.sessions : [])
    .map((session) => String(session?.id || "").trim())
    .filter(Boolean);
  const looseIds = (Array.isArray(tree.looseSessions) ? tree.looseSessions : [])
    .map((session) => String(session?.id || "").trim())
    .filter(Boolean);
  return [...projectIds, ...looseIds];
}

function normalizeSessionSearchTerm(value = "") {
  return String(value || "").trim().toLowerCase();
}

function sessionSearchBlob(item = {}) {
  const values = [
    item.id,
    item.key,
    item.name,
    item.title,
    item.firstUserMessage,
    item.summary,
    item.model,
    item.modelProvider,
    item.source,
    item.threadSource,
    item.projectReason,
    sessionProjectReasonLabel(item.projectReason, item),
    item.project,
    item.projectPath,
    item.workspacePath,
    item.path,
  ];
  return values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).toLowerCase())
    .join(" ");
}

function normalizeSessionProject(project = {}) {
  const path = cleanProjectPath(project.path || project.projectPath || "");
  const sessions = Array.isArray(project.sessions) ? project.sessions.filter(Boolean) : [];
  return {
    key: project.key || (path ? `path:${canonicalProjectPathKey(path)}` : project.name || "project"),
    name: project.name || (path ? path.split(/[\\/]/).filter(Boolean).pop() : "未命名项目") || "未命名项目",
    path,
    active: Boolean(project.active),
    source: project.source || "workspace",
    sessions,
  };
}

function finiteCount(value, fallback = 0) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : fallback;
}

function groupSessionsByProject(sessions = []) {
  const projects = new Map();
  const looseSessions = [];
  for (const session of sessions) {
    const key = sessionProjectKey(session);
    if (!key) {
      looseSessions.push(session);
      continue;
    }
    if (!projects.has(key)) {
      projects.set(key, {
        key,
        name: sessionProjectLabel(session),
        path: cleanProjectPath(session.projectPath || ""),
        active: Boolean(session.projectActive),
        source: session.projectSource || "session",
        sessions: [],
      });
    }
    projects.get(key).sessions.push(session);
  }
  return {
    projects: [...projects.values()].sort((left, right) => left.name.localeCompare(right.name)),
    looseSessions,
  };
}

function sessionClassificationNote(tree = {}) {
  const classification = tree?.classification || {};
  const parts = [
    sessionReasonBreakdown(classification.projectReasons || {}),
    sessionProjectSourceBreakdown(classification.projectSources || {}),
    Number(classification.sidebarProjectThreadAssignments || 0) > 0
      ? `侧边栏线程 ${formatNumber(classification.sidebarProjectThreadAssignments)} 条`
      : "",
    Number(classification.projectlessThreadMarkers || 0) > 0
      ? `无项目标记 ${formatNumber(classification.projectlessThreadMarkers)} 条`
      : "",
    Number(classification.workspaceRoots || 0) > 0
      ? `项目根目录 ${formatNumber(classification.workspaceRoots)} 个`
      : "",
  ].filter(Boolean);
  if (!parts.length) {
    return "";
  }
  return `
    <div class="session-classification-note">
      ${parts.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
    </div>
  `;
}

function sessionReasonBreakdown(reasons = {}) {
  const items = Object.entries(reasons)
    .filter(([, count]) => Number(count || 0) > 0)
    .map(([reason, count]) => `${sessionProjectReasonLabel(reason)} ${formatNumber(count)}`);
  return items.length ? `归类依据：${items.join("、")}` : "";
}

function sessionProjectSourceBreakdown(sources = {}) {
  const items = Object.entries(sources)
    .filter(([, count]) => Number(count || 0) > 0)
    .map(([source, count]) => `${sessionProjectSourceLabel(source)} ${formatNumber(count)}`);
  return items.length ? `项目来源：${items.join("、")}` : "";
}

function sessionProjectBlock(project) {
  const projectStatus = project.active ? "当前活动" : "历史项目";
  const projectSource = sessionProjectSourceLabel(project.source);
  return `
    <details class="session-project" data-session-project="${escapeHtml(project.key)}">
      <summary class="session-project-toggle">
        <div>
          <strong>${escapeHtml(project.name)}</strong>
          <span class="session-project-meta">
            <em class="${project.active ? "active" : ""}">${escapeHtml(projectStatus)}</em>
            <em>${escapeHtml(projectSource)}</em>
          </span>
          ${project.path ? `<small>${escapeHtml(project.path)}</small>` : ""}
        </div>
        <span>${formatNumber(project.sessions.length)} 个本地历史会话</span>
      </summary>
      <div class="session-project-actions">
        ${project.path ? `<button class="ghost-button light small" type="button" data-open-project-folder="${escapeHtml(project.path)}">打开项目目录</button>` : ""}
        <button class="ghost-button light small" type="button" data-export-project="${escapeHtml(project.key)}">导出项目 Markdown</button>
      </div>
      <div class="session-project-list">
        ${project.sessions.length
          ? project.sessions.map(sessionItem).join("")
          : `<div class="empty-state">这个项目还没有会话。</div>`}
      </div>
    </details>
  `;
}

function sessionProjectSourceLabel(source = "") {
  if (source === "pinned") {
    return "固定项目";
  }
  if (source === "local") {
    return "本地项目";
  }
  if (source === "project_order") {
    return "Codex 项目顺序";
  }
  if (source === "saved") {
    return "保存过的项目";
  }
  if (source === "active") {
    return "当前工作区";
  }
  return "会话归属";
}

function sessionProjectReasonLabel(reason = "", session = {}) {
  if (reason === "sidebar_project_thread_order") {
    return "侧边栏项目顺序";
  }
  if (reason === "thread_assignment") {
    return "Codex 线程指派到项目";
  }
  if (reason === "workspace_root") {
    return "项目根目录匹配";
  }
  if (reason === "projectless_marker") {
    return "Codex 已标记为无项目";
  }
  if (reason === "codex_generated_workspace") {
    return "Codex 临时或插件输出目录";
  }
  if (reason === "outside_current_projects") {
    return "不在当前 Codex 项目列表";
  }
  if (reason === "workspace_hint_outside_projects") {
    return "Codex 工作区提示不在当前项目";
  }
  if (reason === "outside_sidebar_project_threads") {
    return "同工作区但不在侧边栏项目里";
  }
  if (reason === "missing_workspace") {
    return "Codex 未提供工作目录";
  }
  return session?.projectPath ? "项目归属" : "无项目归类";
}

function sessionItem(session) {
  const folderPath = cleanProjectPath(session.workspacePath || session.projectPath || "");
  return `
    <article class="session-item">
      <div>
        <strong>${escapeHtml(session.title || session.firstUserMessage || session.id)}</strong>
        <p>
          ${escapeHtml(session.model || session.modelProvider || "-")}
          · ${escapeHtml(session.source || session.threadSource || "-")}
        </p>
        ${session.projectPath
          ? `<small>${escapeHtml(cleanProjectPath(session.projectPath))}</small>`
          : session.workspacePath
            ? `<small>${escapeHtml(cleanProjectPath(session.workspacePath))}</small>`
            : ""}
        <small>${escapeHtml(shortText(session.firstUserMessage || session.id, 140))}</small>
      </div>
      <div class="session-item-actions">
        ${folderPath ? `<button class="ghost-button light small" type="button" data-open-session-folder="${escapeHtml(folderPath)}">打开所在目录</button>` : ""}
        <button class="ghost-button light small" type="button" data-export-session="${escapeHtml(session.id)}">导出 Markdown</button>
      </div>
    </article>
  `;
}

function sessionProjectKey(session = {}) {
  const projectPath = cleanProjectPath(session.projectPath || "");
  const project = String(session.project || "").trim();
  if (projectPath) {
    return `path:${canonicalProjectPathKey(projectPath)}`;
  }
  if (project) {
    return `name:${project.toLowerCase()}`;
  }
  return "";
}

function sessionProjectLabel(session = {}) {
  if (session.project) {
    return session.project;
  }
  if (session.projectPath) {
    const clean = cleanProjectPath(session.projectPath);
    return clean.split(/[\\/]/).filter(Boolean).pop() || clean;
  }
  return "未识别项目";
}

function cleanProjectPath(projectPath = "") {
  return String(projectPath || "").replace(/^\\\\\?\\/, "").trim();
}

function canonicalProjectPathKey(projectPath = "") {
  return cleanProjectPath(projectPath)
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function checkStatusLabel(status) {
  if (status === "pass") {
    return "通过";
  }
  if (status === "fail") {
    return "失败";
  }
  return "提醒";
}

function renderRouterToggle() {
  els.routerToggle.classList.toggle("running", Boolean(state.routerRunning));
  els.routerToggle.setAttribute("aria-pressed", state.routerRunning ? "true" : "false");
  els.routerToggle.querySelector("strong").textContent = state.routerRunning ? "Router 运行中" : "Router 已关闭";
  els.routerToggle.querySelector("small").textContent = state.routerRunning ? "点击关闭本地网关" : "点击启动本地网关";
}

function renderModelPageView() {
  const catalog = document.querySelector(".model-catalog-panel");
  const providerPanel = document.querySelector(".provider-editor-panel");
  const customPanel = document.querySelector(".custom-editor-panel");
  catalog?.classList.toggle("hidden", modelPageView !== "catalog");
  providerPanel?.classList.toggle("hidden", modelPageView !== "provider");
  customPanel?.classList.toggle("hidden", modelPageView !== "custom");
}

function openProviderEditor(providerId) {
  editingProviderId = providerId;
  modelPageView = "provider";
  render();
  document.querySelector(".provider-editor-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function openProviderCustomModelEditor(providerId) {
  const provider = providerFor(providerId);
  if (!provider) {
    showToast("没有找到这个供应商。", "error");
    return;
  }
  editingProviderId = provider.id;
  activeProviderId = provider.id;
  openCustomEditor(null, { returnView: "provider", providerId: provider.id });
}

function openCustomEditor(presetId = null, options = {}) {
  modelPageView = "custom";
  customReturnView = options.returnView || (modelPageView === "provider" ? "provider" : "catalog");
  scopedCustomProviderId = options.providerId || null;
  if (!scopedCustomProviderId && options.returnView !== "provider") {
    editingProviderId = null;
  }
  if (presetId) {
    startCustomModelEdit(presetId, { preserveView: true, scroll: false });
  } else {
    resetCustomModelForm({ preserveView: true });
  }
  render();
  document.querySelector(".custom-editor-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function openModelCatalog() {
  modelPageView = "catalog";
  editingProviderId = null;
  customReturnView = "catalog";
  scopedCustomProviderId = null;
  render();
  document.querySelector(".model-catalog-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function returnFromCustomEditor() {
  if (customReturnView === "provider" && editingProviderId) {
    modelPageView = "provider";
    scopedCustomProviderId = null;
    render();
    document.querySelector(".provider-editor-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  openModelCatalog();
}

function providerSecretKey(provider = {}) {
  return provider?.keyEnv || provider?.apiKeyEnv || "";
}

function providerRequiresApiKey(provider = {}) {
  return (provider?.authMode || "api_key") === "api_key" && Boolean(providerSecretKey(provider));
}

function providerHasSavedApiKey(provider = {}) {
  if (!providerRequiresApiKey(provider)) {
    return true;
  }
  const keyEnv = providerSecretKey(provider);
  return Boolean(keyEnv && state.secretStatus?.[keyEnv]);
}

function providerCanRefreshModels(provider = {}) {
  return Boolean(provider?.baseUrl) && provider?.authMode !== "codex_openai" && providerHasSavedApiKey(provider);
}

function renderProviders() {
  const cards = state.providers.map((provider) => {
    const saved = provider.keyEnv ? Boolean(state.secretStatus?.[provider.keyEnv]) : true;
    const status = provider.keyEnv ? (saved ? "已保存" : "未保存") : "无需 Key";
    const directoryInfo = providerModelDirectoryInfo(provider.id);
    const keyControl = provider.keyEnv
      ? `
        <label>
          <span>${escapeHtml(provider.keyLabel || "API Key")}</span>
          <div class="secret-row">
            <input type="password" data-key-env="${escapeHtml(provider.keyEnv)}" placeholder="${saved ? "已保存，点查看可查看或修改" : "sk-..."}" />
            <button class="ghost-button light small" type="button" data-toggle-secret data-saved="${saved ? "true" : "false"}">${saved ? "查看" : "显示"}</button>
          </div>
        </label>
      `
      : `<div class="no-key">使用 Codex/OpenAI 登录态，无需在这里填写 API Key。</div>`;
    const saveButton = provider.keyEnv
      ? `<button class="primary-button small" data-save-provider="${escapeHtml(provider.id)}">保存这个 Key</button>`
      : "";
    const keyButton = provider.keyUrl
      ? `<button class="plain-button small" data-open-url="${escapeHtml(provider.keyUrl)}">获取 API Key</button>`
      : "";
    const refreshButton = providerCanRefreshModels(provider)
      ? `<button class="ghost-button light small" data-refresh-provider-models="${escapeHtml(provider.id)}">刷新模型</button>`
      : "";
    return `
      <article class="provider-card" data-provider-id="${escapeHtml(provider.id)}">
        <div class="provider-head">
          <div>
            <h3>${escapeHtml(provider.name)}</h3>
            <p>${escapeHtml(provider.description || "")}</p>
          </div>
          <span class="tag ${saved ? "ok" : ""}">${status}</span>
        </div>
        <p class="provider-model-directory">${escapeHtml(directoryInfo)}</p>
        ${keyControl}
        <div class="provider-actions">
          ${saveButton}
          ${keyButton}
          ${refreshButton}
          ${provider.docsUrl ? `<button class="ghost-button light small" data-open-url="${escapeHtml(provider.docsUrl)}">文档</button>` : ""}
        </div>
      </article>
    `;
  });
  els.providerGrid.innerHTML = cards.join("");

  els.providerGrid.querySelectorAll("[data-open-url]").forEach((button) => {
    button.addEventListener("click", () => api.openExternal(button.dataset.openUrl));
  });
  els.providerGrid.querySelectorAll("[data-toggle-secret]").forEach((button) => {
    button.addEventListener("click", () => runAction(button, async () => {
      const input = button.closest(".secret-row").querySelector("input");
      const showing = input.type === "text";
      if (showing) {
        input.type = "password";
        button.textContent = button.dataset.saved === "true" && !input.value ? "查看" : "显示";
        return;
      }
      if (button.dataset.saved === "true" && !input.value) {
        input.value = await api.getSecret(input.dataset.keyEnv);
      }
      input.type = "text";
      button.textContent = "隐藏";
    }));
  });
  els.providerGrid.querySelectorAll("[data-save-provider]").forEach((button) => {
    button.addEventListener("click", () => saveProviderSecret(button));
  });
  bindProviderRefreshButtons(els.providerGrid);
}

function bindProviderRefreshButtons(root) {
  if (!root) {
    return;
  }
  root.querySelectorAll("[data-refresh-provider-models]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      runAction(button, async () => {
        await saveProviderSettingsBeforeRemoteAction(button);
        const response = await api.refreshProviderModels(button.dataset.refreshProviderModels);
        state = response?.state || await api.getState();
        draftSelection = [...state.selectedModelIds];
        render();
        const result = response?.result || {};
        showToast(
          result.ok
            ? `模型列表已刷新：${result.count || 0} 个`
            : `模型列表刷新失败：${result.error || "unknown error"}`,
          result.ok ? "success" : "error",
        );
      });
    });
  });
}

async function saveProviderSettingsBeforeRemoteAction(button) {
  const card = button.closest(".provider-editor-card");
  const apiKey = card?.querySelector("[data-key-env]")?.value.trim();
  if (!card || !apiKey) {
    return null;
  }
  return saveProviderSettingsFromCard(card);
}

function renderProviderEditor() {
  const panel = document.querySelector(".provider-editor-panel");
  if (!panel || !els.providerGrid) {
    return;
  }
  if (modelPageView !== "provider") {
    els.providerGrid.innerHTML = "";
    return;
  }
  const provider = providerFor(editingProviderId || activeProviderId) || state.providers?.[0];
  if (!provider) {
    els.providerGrid.innerHTML = `<div class="empty-state">没有可编辑的供应商。</div>`;
    return;
  }
  const models = (state.modelPresets || []).filter((model) => model.providerId === provider.id);
  const apiValue = providerApiValue(provider, models);
  const keyEnv = providerSecretKey(provider);
  const saved = keyEnv ? Boolean(state.secretStatus?.[keyEnv]) : true;
  const status = keyEnv ? (saved ? "已保存" : "未保存") : "无需 Key";
  const needsKey = providerRequiresApiKey(provider);
  const remoteDisabledAttrs = needsKey && !saved
    ? `disabled data-provider-refresh-disabled="true" title="先填写并保存 API Key 后再使用"`
    : `data-provider-refresh-disabled="false"`;
  const keyControl = keyEnv
    ? `
      <label class="provider-secret-field">
        <span>${escapeHtml(provider.keyLabel || "API Key")}</span>
        <div class="secret-row">
          <input type="password" data-key-env="${escapeHtml(keyEnv)}" placeholder="${saved ? "已保存，点击查看可查看或修改" : "sk-..."}" />
          <button class="ghost-button light small" type="button" data-toggle-secret data-saved="${saved ? "true" : "false"}">${saved ? "查看" : "显示"}</button>
        </div>
      </label>
    `
    : `<div class="no-key">使用 Codex/OpenAI 登录态，不需要在这里填写 API Key。</div>`;
  const saveButton = provider.keyEnv
    ? `<button class="primary-button small" type="button" data-save-provider-settings="${escapeHtml(provider.id)}">保存设置</button>`
    : `<button class="primary-button small" type="button" data-save-provider-settings="${escapeHtml(provider.id)}">保存设置</button>`;
  const testButton = provider.baseUrl && provider.authMode !== "codex_openai"
    ? `<button class="ghost-button light small" type="button" data-test-provider-connection="${escapeHtml(provider.id)}" ${remoteDisabledAttrs}>测试连接</button>`
    : "";
  const keyButton = provider.keyUrl
    ? `<button class="plain-button small" type="button" data-open-url="${escapeHtml(provider.keyUrl)}">获取 Key</button>`
    : "";
  const refreshButton = provider.baseUrl && provider.authMode !== "codex_openai"
    ? `<button class="ghost-button light small" type="button" data-refresh-provider-models="${escapeHtml(provider.id)}" ${remoteDisabledAttrs}>同步模型列表</button>`
    : "";

  els.providerGrid.innerHTML = `
    <div class="editor-page-head">
      <button class="ghost-button light small" type="button" data-back-model-catalog>返回模型列表</button>
    </div>
    <article class="provider-card provider-editor-card" data-provider-id="${escapeHtml(provider.id)}">
      <div class="provider-head">
        <div class="provider-title">
          <button class="provider-logo-button" type="button" data-provider-logo-upload="${escapeHtml(provider.id)}" title="点击上传本地图标">
            ${providerLogo(provider)}
          </button>
          <div>
            <h3>${escapeHtml(provider.name)}</h3>
            <p>${escapeHtml(provider.description || "")}</p>
          </div>
        </div>
        <span class="tag ${saved ? "ok" : ""}">${status}</span>
      </div>
      <div class="provider-settings-grid" data-provider-settings data-provider-id="${escapeHtml(provider.id)}" data-provider-key-env="${escapeHtml(provider.keyEnv || "")}" data-provider-auth-mode="${escapeHtml(provider.authMode || "api_key")}" data-provider-custom="${provider.custom ? "true" : "false"}">
        <label>
          <span>供应商名称</span>
          <input data-provider-name value="${escapeHtml(provider.name || "")}" placeholder="例如 DeepSeek" />
        </label>
        <label>
          <span>显示短名</span>
          <input data-provider-short-name value="${escapeHtml(provider.shortName || provider.name || provider.id)}" placeholder="例如 DeepSeek" />
        </label>
        <label class="wide-field">
          <span>Base URL</span>
          <input data-provider-base-url value="${escapeHtml(provider.baseUrl || "")}" placeholder="https://api.example.com/v1" />
        </label>
        <label>
          <span>接口类型</span>
          <select data-provider-api>
            <option value="chat_completions" ${apiValue === "chat_completions" ? "selected" : ""}>Chat Completions</option>
            <option value="responses" ${apiValue === "responses" ? "selected" : ""}>Responses</option>
          </select>
        </label>
        <label>
          <span>获取 Key 链接</span>
          <input data-provider-key-url value="${escapeHtml(provider.keyUrl || "")}" placeholder="https://example.com/keys" />
        </label>
        <label>
          <span>官网 / 文档</span>
          <input data-provider-docs-url value="${escapeHtml(provider.docsUrl || "")}" placeholder="https://example.com/docs" />
        </label>
      </div>
      ${keyControl}
      <div class="provider-actions">
        ${saveButton}
        <button class="ghost-button light small" type="button" data-reset-provider-settings="${escapeHtml(provider.id)}">恢复默认配置</button>
        ${testButton}
        ${keyButton}
        ${provider.docsUrl ? `<button class="ghost-button light small" type="button" data-open-url="${escapeHtml(provider.docsUrl)}">文档</button>` : ""}
      </div>
      <div class="provider-connection-result" data-provider-connection-result aria-live="polite"></div>
      <div class="provider-model-list">
        <div class="provider-model-list-head">
          <div>
            <strong>模型列表</strong>
            <span>${models.length} 个模型</span>
          </div>
          <div class="provider-model-list-actions">
            ${refreshButton}
            <button class="ghost-button light small" type="button" data-open-provider-custom-model="${escapeHtml(provider.id)}">添加自定义模型</button>
          </div>
        </div>
        ${providerModelEditorRows(models)}
      </div>
    </article>
  `;
  bindProviderEditorActions(els.providerGrid);
}

function providerDetailValue(label, value) {
  return `
    <div class="provider-detail-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "-")}</strong>
    </div>
  `;
}

function providerApiValue(provider, models = []) {
  if (provider?.api === "responses" || provider?.api === "chat_completions") {
    return provider.api;
  }
  const firstModel = models.find((model) => model.api === "responses" || model.api === "chat_completions");
  return firstModel?.api || "chat_completions";
}

function providerModelEditorRows(models) {
  if (!models.length) {
    return `<div class="empty-state">这个供应商还没有模型。可以同步模型列表，或从自定义页面手动添加。</div>`;
  }
  return models.map((model) => providerModelEditorRow(model)).join("");
}

function providerModelEditorRow(model) {
  return `
    <div class="provider-model-row">
      <div class="provider-model-main">
        <strong>${escapeHtml(model.displayName)}</strong>
        <span>${escapeHtml(model.model)} · ${escapeHtml(model.api || "-")} · ${escapeHtml(modelFriendlySummary(model))}</span>
      </div>
      <div class="provider-model-controls">
        ${modelConfigControls(model, modelSupportsImage(model))}
      </div>
    </div>
  `;
}

function bindProviderEditorActions(root) {
  root.querySelectorAll("[data-back-model-catalog]").forEach((button) => {
    button.addEventListener("click", openModelCatalog);
  });
  root.querySelectorAll("[data-open-custom-editor]").forEach((button) => {
    button.addEventListener("click", () => openCustomEditor());
  });
  root.querySelectorAll("[data-open-provider-custom-model]").forEach((button) => {
    button.addEventListener("click", () => openProviderCustomModelEditor(button.dataset.openProviderCustomModel));
  });
  root.querySelectorAll("[data-provider-logo-upload]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      runAction(button, async () => {
        const providerId = button.dataset.providerLogoUpload;
        const response = await api.selectLocalLogo({ providerId, ownerId: providerId, applyToProvider: true });
        if (response?.canceled) {
          return;
        }
        state = response?.state || await api.getState();
        draftSelection = [...state.selectedModelIds];
        render();
        showToast("供应商图标已更新。");
      });
    });
  });
  root.querySelectorAll("[data-open-url]").forEach((button) => {
    button.addEventListener("click", () => api.openExternal(button.dataset.openUrl));
  });
  root.querySelectorAll("[data-toggle-secret]").forEach((button) => {
    button.addEventListener("click", () => runAction(button, async () => {
      const input = button.closest(".secret-row").querySelector("input");
      const showing = input.type === "text";
      if (showing) {
        input.type = "password";
        button.textContent = button.dataset.saved === "true" && !input.value ? "查看" : "显示";
        return;
      }
      if (button.dataset.saved === "true" && !input.value) {
        input.value = await api.getSecret(input.dataset.keyEnv);
      }
      input.type = "text";
      button.textContent = "隐藏";
    }));
  });
  root.querySelectorAll("[data-save-provider]").forEach((button) => {
    button.addEventListener("click", () => saveProviderSecret(button));
  });
  root.querySelectorAll("[data-save-provider-settings]").forEach((button) => {
    button.addEventListener("click", () => saveProviderSettings(button));
  });
  root.querySelectorAll("[data-reset-provider-settings]").forEach((button) => {
    button.addEventListener("click", () => resetProviderSettings(button));
  });
  root.querySelectorAll("[data-key-env]").forEach((input) => {
    input.addEventListener("input", () => updateProviderRemoteActionState(input.closest(".provider-editor-card")));
  });
  root.querySelectorAll("[data-test-provider-connection]").forEach((button) => {
    button.addEventListener("click", () => testProviderConnection(button));
  });
  root.querySelectorAll(".provider-editor-card").forEach((card) => updateProviderRemoteActionState(card));
  bindProviderRefreshButtons(root);
  bindModelConfigControls(root);
}

function updateProviderRemoteActionState(card) {
  if (!card) {
    return;
  }
  const provider = providerFor(card.dataset.providerId);
  const typedKey = card.querySelector("[data-key-env]")?.value.trim() || "";
  const disabled = providerRequiresApiKey(provider) && !providerHasSavedApiKey(provider) && !typedKey;
  const hint = "先填写并保存 API Key 后再使用";
  card.querySelectorAll("[data-test-provider-connection], [data-refresh-provider-models]").forEach((button) => {
    button.disabled = disabled;
    button.dataset.providerRefreshDisabled = disabled ? "true" : "false";
    if (disabled) {
      button.title = hint;
    } else if (button.title === hint) {
      button.removeAttribute("title");
    }
  });
}

function providerSettingsPayload(card) {
  const settings = card?.querySelector("[data-provider-settings]");
  const provider = providerFor(settings?.dataset.providerId || card?.dataset.providerId);
  const apiKey = card?.querySelector("[data-key-env]")?.value.trim() || "";
  return {
    providerId: provider?.id || settings?.dataset.providerId || "",
    id: provider?.id || settings?.dataset.providerId || "",
    name: settings?.querySelector("[data-provider-name]")?.value.trim() || provider?.name || "",
    shortName: settings?.querySelector("[data-provider-short-name]")?.value.trim() || provider?.shortName || "",
    baseUrl: settings?.querySelector("[data-provider-base-url]")?.value.trim() || "",
    api: settings?.querySelector("[data-provider-api]")?.value || providerApiValue(provider),
    keyUrl: settings?.querySelector("[data-provider-key-url]")?.value.trim() || "",
    docsUrl: settings?.querySelector("[data-provider-docs-url]")?.value.trim() || "",
    keyEnv: settings?.dataset.providerKeyEnv || provider?.keyEnv || "",
    authMode: settings?.dataset.providerAuthMode || provider?.authMode || "api_key",
    custom: settings?.dataset.providerCustom === "true",
    apiKey,
  };
}

function saveProviderSettings(button) {
  return runAction(button, async () => {
    const card = button.closest(".provider-editor-card");
    const response = await saveProviderSettingsFromCard(card);
    render();
    showToast(providerSaveRepairToast(response?.sync));
  });
}

async function saveProviderSettingsFromCard(card) {
  const response = await api.saveProvider(providerSettingsPayload(card));
  state = response?.state || await api.getState();
  draftSelection = [...state.selectedModelIds];
  return response;
}

function resetProviderSettings(button) {
  return runAction(button, async () => {
    const providerId = button.dataset.resetProviderSettings || button.closest(".provider-editor-card")?.dataset.providerId || "";
    const response = await api.resetProvider(providerId);
    state = response?.state || await api.getState();
    draftSelection = [...state.selectedModelIds];
    render();
    showToast("供应商默认配置已恢复，失效模型引用也已同步修复。");
  });
}

function testProviderConnection(button) {
  return runAction(button, async () => {
    const card = button.closest(".provider-editor-card");
    const resultBox = card?.querySelector("[data-provider-connection-result]");
    if (resultBox) {
      resultBox.innerHTML = `<div class="provider-health-card pending">正在体检供应商...</div>`;
    }
    const result = await api.testProviderConnection(providerSettingsPayload(card));
    if (resultBox) {
      resultBox.innerHTML = providerConnectionResultHtml(result);
    }
    showToast(
      result.ok
        ? result.message || `连接测试通过：HTTP ${result.status || 200}`
        : result.error || result.message || "连接测试失败。",
      result.ok ? "success" : "error",
    );
  });
}

function providerConnectionResultHtml(result = {}) {
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const summary = result.summary || {};
  const statusClass = result.ok ? "ok" : "bad";
  const headline = result.ok ? "供应商体检通过" : "供应商体检未通过";
  const detail = result.message || result.error || "没有返回体检详情。";
  const summaryText = [
    `${Number(summary.passed || 0)} 项通过`,
    `${Number(summary.warned || 0)} 项提醒`,
    `${Number(summary.failed || 0)} 项失败`,
  ].join(" · ");
  const modelText = Number.isFinite(Number(summary.modelCount))
    ? `远程模型 ${Number(summary.modelCount || 0)} 个，匹配 ${Number(summary.matchedModelCount || 0)} 个`
    : "";
  const items = checks.length
    ? checks.map((check) => providerConnectionCheckHtml(check)).join("")
    : `<div class="provider-health-check warn"><strong>暂无检查项</strong><span>${escapeHtml(detail)}</span></div>`;
  return `
    <div class="provider-health-card ${statusClass}">
      <div class="provider-health-head">
        <div>
          <strong>${headline}</strong>
          <span>${escapeHtml(detail)}</span>
        </div>
        <small>${escapeHtml(summaryText)}</small>
      </div>
      ${modelText ? `<div class="provider-health-meta">${escapeHtml(modelText)}</div>` : ""}
      <div class="provider-health-checks">
        ${items}
      </div>
    </div>
  `;
}

function providerConnectionCheckHtml(check = {}) {
  const status = ["pass", "warn", "fail"].includes(check.status) ? check.status : "warn";
  const label = check.label || check.id || "检查项";
  const marker = status === "pass" ? "通过" : status === "fail" ? "失败" : "提醒";
  return `
    <div class="provider-health-check ${status}">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(check.message || "-")}</span>
      <em>${marker}</em>
    </div>
  `;
}

function renderCustomEditor() {
  const panel = document.querySelector(".custom-editor-panel");
  if (!panel) {
    return;
  }
  if (!panel.querySelector(".custom-editor-toolbar")) {
    panel.insertAdjacentHTML(
      "afterbegin",
      `
        <div class="custom-editor-toolbar">
          <button class="ghost-button light small" type="button" data-back-model-catalog>返回模型列表</button>
        </div>
      `,
    );
  }
  panel.querySelectorAll("[data-back-model-catalog]").forEach((button) => {
    button.onclick = returnFromCustomEditor;
  });
}

function saveProviderSecret(button) {
  return runAction(button, async () => {
    const card = button.closest(".provider-card");
    const input = card?.querySelector("[data-key-env]");
    if (!input) {
      throw new Error("没有找到这个供应商的 API Key 输入框。");
    }
    if (!input?.value.trim()) {
      throw new Error("请输入新的 API Key。空输入不会覆盖旧密钥。");
    }
    await api.saveSecrets({ [input.dataset.keyEnv]: input.value.trim() });
    input.value = "";
    await refresh();
    showToast("这个 API Key 已保存到本机，可随时点查看后修改。");
  });
}

function renderSelectedModels() {
  const modelsById = modelMap();
  const unavailableIds = unavailableDraftSelectionIds(modelsById);
  if (els.cleanUnavailableModels) {
    els.cleanUnavailableModels.disabled = unavailableIds.length === 0;
  }
  if (els.restoreDefaultModels) {
    els.restoreDefaultModels.disabled = !state?.mode;
  }
  if (!draftSelection.length) {
    els.selectedModels.innerHTML = `
      <div class="slot-card empty">
        <span>未选择模型</span>
        <strong>至少选择一个模型</strong>
        <small>从下方模型卡片加入，保存后写入 CodexBridge 模型目录。</small>
      </div>
    `;
    return;
  }

  els.selectedModels.innerHTML = draftSelection
    .map((presetId, index) => {
      const model = modelsById.get(presetId);
      const unavailableAttr = model ? "" : ` data-unavailable-model-id="${escapeHtml(presetId)}"`;
      return `
        <div class="slot-card ${model ? "filled" : "missing"}" draggable="true" data-slot-index="${index}"${unavailableAttr}>
          <button class="slot-remove" type="button" data-remove-selected-slot="${index}" title="移除这个模型" aria-label="移除这个模型">移除</button>
          <span>第 ${index + 1} 个模型</span>
          <strong>${model ? escapeHtml(model.displayName) : "模型不可用"}</strong>
          <small>${model ? `${escapeHtml(model.model)} · ${escapeHtml(providerName(model.providerId))}` : escapeHtml(presetId)}</small>
          ${model ? "" : `
            <div class="slot-actions">
              <button class="mini-link" type="button" data-repair-stale-model-reference="${escapeHtml(presetId)}">自动修复</button>
              <button class="mini-link danger" type="button" data-remove-stale-model-reference="${escapeHtml(presetId)}">移除并保存</button>
            </div>
          `}
        </div>
      `;
    })
    .join("");

  bindModelReferenceIssueActions(els.selectedModels);

  els.selectedModels.querySelectorAll("[data-remove-selected-slot]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeDraftSelectionAt(Number(button.dataset.removeSelectedSlot));
    });
  });

  els.selectedModels.querySelectorAll(".slot-card").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      dragSlotIndex = Number(card.dataset.slotIndex);
      event.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => {
      dragSlotIndex = null;
      card.classList.remove("dragging");
      els.selectedModels.querySelectorAll(".slot-card").forEach((item) => item.classList.remove("drop-target"));
    });
    card.addEventListener("dragover", (event) => {
      if (dragSlotIndex === null) {
        return;
      }
      event.preventDefault();
      card.classList.add("drop-target");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      const targetIndex = Number(card.dataset.slotIndex);
      reorderDraftSelection(dragSlotIndex, targetIndex);
      dragSlotIndex = null;
      render();
      showToast("顺序已调整，点“保存选择”后写入 CodexBridge 模型目录。");
    });
  });
}

function unavailableDraftSelectionIds(modelsById = modelMap()) {
  return draftSelection.filter((presetId) => !modelsById.has(presetId));
}

function cleanUnavailableSelectedModels() {
  const modelsById = modelMap();
  const unavailableIds = unavailableDraftSelectionIds(modelsById);
  if (!unavailableIds.length) {
    showToast("当前模型栏没有不可用模型。");
    return;
  }
  draftSelection = draftSelection.filter((presetId) => modelsById.has(presetId));
  render();
  showToast(`已清理 ${unavailableIds.length} 个不可用模型，点击“保存选择”后生效。`);
}

function restoreDefaultModelSelection(button) {
  return runAction(button, async () => {
    const result = normalizeModeSelectionResult(await api.selectMode(state.mode || "hybrid"));
    state = result.state;
    draftSelection = [...state.selectedModelIds];
    render();
    showToast(modeSwitchToastMessage(result.transaction));
  });
}

function removeDraftSelectionAt(index) {
  if (!Number.isInteger(index) || index < 0 || index >= draftSelection.length) {
    return;
  }
  draftSelection = draftSelection.filter((_, itemIndex) => itemIndex !== index);
  render();
  showToast("已从模型栏移除，点击“保存选择”后生效。");
}

function reorderDraftSelection(fromIndex, targetSlotIndex) {
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= draftSelection.length) {
    return;
  }
  const next = [...draftSelection];
  const [moved] = next.splice(fromIndex, 1);
  const insertIndex = Math.max(0, Math.min(targetSlotIndex, next.length));
  next.splice(insertIndex, 0, moved);
  draftSelection = next;
}

function renderProviderPreview() {
  if (!els.providerPreview || !state) {
    return;
  }
  const grouped = groupByProvider(state.modelPresets || []);
  const providerIds = grouped.map(([providerId]) => providerId);
  if (!activeProviderId || (!providerIds.includes(activeProviderId) && activeProviderId !== "__custom__")) {
    activeProviderId = providerIds[0] || "__custom__";
  }
  const customCount = (state.modelPresets || []).filter((model) => model.custom).length;
  const tiles = [
    `
      <button class="provider-preview-card ${activeProviderId === "__custom__" ? "active" : ""}" type="button" data-provider-preview="__custom__" data-open-custom-editor>
        ${providerLogo({ id: "__custom__", name: "Custom" })}
        <strong>自定义</strong>
        <small>${customCount ? `${customCount} 个模型` : "添加模型"}</small>
      </button>
    `,
    ...grouped.map(([providerId, models]) => {
      const provider = providerFor(providerId);
      return `
        <button class="provider-preview-card ${activeProviderId === providerId ? "active" : ""}" type="button" data-provider-preview="${escapeHtml(providerId)}">
          ${providerLogo(provider)}
          <strong>${escapeHtml(provider?.shortName || provider?.name || providerId)}</strong>
          <small>${models.length} 个模型</small>
        </button>
      `;
    }),
  ];
  els.providerPreview.innerHTML = tiles.join("");
  els.providerPreview.querySelectorAll("[data-provider-preview]").forEach((button) => {
    button.addEventListener("click", () => {
      activeProviderId = button.dataset.providerPreview;
      if (activeProviderId === "__custom__") {
        openCustomEditor();
        return;
      }
      renderProviderPreview();
      renderModelPool();
    });
  });
}

function providerLogo(provider = {}) {
  if (provider?.id === "__custom__") {
    return `<span class="provider-logo provider-logo-add" title="添加自定义模型" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M15 7h2v8h8v2h-8v8h-2v-8H7v-2h8z"/></svg></span>`;
  }
  const customLogo = String(provider?.logoUrl || "").trim();
  if (customLogo) {
    const label = provider?.shortName || provider?.name || provider?.id || "Provider";
    return `<span class="provider-logo provider-logo-custom-url" title="${escapeHtml(label)}"><img src="${escapeHtml(customLogo)}" alt="${escapeHtml(label)} logo" loading="lazy"></span>`;
  }
  const key = providerLogoKey(provider);
  const label = provider?.shortName || provider?.name || provider?.id || "Provider";
  const file = PROVIDER_LOGO_FILES[key] || PROVIDER_LOGO_FILES.default;
  if (file) {
    return `<span class="provider-logo provider-logo-${escapeHtml(key)}" title="${escapeHtml(label)}"><img src="./assets/providers/${escapeHtml(file)}" alt="${escapeHtml(label)} logo" loading="lazy"></span>`;
  }
  return `<span class="provider-logo provider-logo-custom" title="${escapeHtml(label)}" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M15 7h2v8h8v2h-8v8h-2v-8H7v-2h8z"/></svg></span>`;
}

function providerLogoKey(provider = {}) {
  const text = [provider.id, provider.shortName, provider.name].filter(Boolean).join(" ").toLowerCase() || "default";
  if (text === "__custom__" || text.includes("custom")) return "custom";
  if (text.includes("codex") || text === "gpt") return "codex";
  if (text.includes("openai")) return "openai";
  if (text.includes("deepseek")) return "deepseek";
  if (text.includes("kimi") || text.includes("moonshot")) return "kimi";
  if (text.includes("xiaomi") || text.includes("mimo")) return "mimo";
  if (text.includes("minimax")) return "minimax";
  if (text.includes("step")) return "stepfun";
  if (text.includes("qianfan") || text.includes("baidu")) return "qianfan";
  if (text.includes("hunyuan") || text.includes("tencent")) return "hunyuan";
  if (text.includes("doubao") || text.includes("volc")) return "doubao";
  if (text.includes("qwen") || text.includes("dashscope") || text.includes("aliyun")) return "qwen";
  if (text.includes("glm") || text.includes("zhipu")) return "glm";
  if (text.includes("openrouter")) return "openrouter";
  if (text.includes("silicon")) return "siliconflow";
  return "default";
}

const PROVIDER_LOGO_FILES = {
  codex: "openai.svg",
  openai: "openai.svg",
  deepseek: "deepseek.svg",
  kimi: "kimi.svg",
  mimo: "mimo.svg",
  minimax: "minimax.svg",
  stepfun: "stepfun.svg",
  qianfan: "qianfan.svg",
  hunyuan: "hunyuan.svg",
  doubao: "doubao.svg",
  qwen: "qwen.svg",
  glm: "glm.svg",
  openrouter: "openrouter.svg",
  siliconflow: "siliconflow.svg",
  custom: "default.svg",
  default: "default.svg",
};

function renderModelPool() {
  const selected = new Set(draftSelection);
  renderModelCardGroups(els.modelPool, selected, false);
  bindModelSelection(els.modelPool);
}

function renderModelConfigPool() {
  if (els.modelConfigPool) {
    els.modelConfigPool.innerHTML = "";
  }
}

function renderModelCardGroups(target, selected, includeControls) {
  if (!target) {
    return;
  }
  const visibleModels = activeProviderId === "__custom__"
    ? (state.modelPresets || []).filter((model) => model.custom)
    : activeProviderId
      ? (state.modelPresets || []).filter((model) => model.providerId === activeProviderId)
      : (state.modelPresets || []);
  const grouped = groupByProvider(visibleModels);
  target.innerHTML = grouped
    .map(([providerId, models]) => {
      const provider = providerFor(providerId);
      const refreshButton = providerCanRefreshModels(provider)
        ? `<button class="ghost-button light small" type="button" data-refresh-provider-models="${escapeHtml(provider.id)}">刷新模型列表</button>`
        : "";
      return `
        <section class="model-group">
          <div class="model-group-title">
            <div>
              <h3>${escapeHtml(provider?.name || providerId)}</h3>
              <span>${models.length} 个模型</span>
            </div>
            <div class="model-group-actions">
              ${refreshButton}
              <button class="ghost-button light small" type="button" data-provider-edit="${escapeHtml(providerId)}">编辑</button>
            </div>
          </div>
          <div class="model-card-grid">
            ${models.map((model) => modelCard(model, selected, includeControls)).join("")}
          </div>
        </section>
      `;
    })
    .join("");
  if (!grouped.length) {
    target.innerHTML = `<div class="empty-state">请选择一个供应商，或进入自定义模型页面添加模型。</div>`;
  }
  bindProviderRefreshButtons(target);
  target.querySelectorAll("[data-provider-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      activeProviderId = button.dataset.providerEdit;
      openProviderEditor(button.dataset.providerEdit);
    });
  });
}

function bindModelSelection(target) {
  target.querySelectorAll("[data-model-id]").forEach((button) => {
    button.addEventListener("click", () => toggleModel(button.dataset.modelId));
  });
}

function bindModelConfigControls(target) {
  if (!target) {
    return;
  }
  target.querySelectorAll("[data-image-input-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      runAction(button, async () => {
        const model = modelMap().get(button.dataset.imageInputToggle);
        const next = !modelSupportsImage(model);
        state = await api.saveModelImageInput({
          presetId: button.dataset.imageInputToggle,
          imageInput: next,
        });
        draftSelection = [...state.selectedModelIds];
        render();
        showToast(next ? "图片上传已开启。" : "图片上传已关闭。");
      });
    });
  });
  target.querySelectorAll("[data-image-provider-select]").forEach((select) => {
    select.addEventListener("click", (event) => event.stopPropagation());
    select.addEventListener("change", (event) => {
      event.stopPropagation();
      runAction(select, async () => {
        const presetId = select.dataset.imageProviderSelect;
        const model = modelMap().get(presetId);
        state = await api.saveModelImageGeneration({
          presetId,
          imageGeneration: imageGenerationOverrideFromSelectValue(select.value, model),
        });
        draftSelection = [...state.selectedModelIds];
        render();
        showToast("这个模型的生图代理已更新。");
      });
    });
  });
  target.querySelectorAll("[data-image-gen-mode]").forEach((select) => {
    select.addEventListener("click", (event) => event.stopPropagation());
    select.addEventListener("change", () => {
      renderImageGenerationPanelMode(select.closest("[data-image-gen-config]"));
    });
  });
  target.querySelectorAll("[data-image-gen-save]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      saveImageGenerationSettings(button);
    });
  });
  target.querySelectorAll("[data-image-gen-toggle-secret]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      runAction(button, async () => {
        const panel = button.closest("[data-image-gen-config]");
        const input = panel.querySelector("[data-image-gen-api-key]");
        const keyEnv = panel.querySelector("[data-image-gen-key-env]")?.value.trim();
        if (input.type === "text") {
          input.type = "password";
          button.textContent = "查看";
          return;
        }
        if (keyEnv && !input.value) {
          input.value = await api.getSecret(keyEnv);
        }
        input.type = "text";
        button.textContent = "隐藏";
      });
    });
  });
  target.querySelectorAll("[data-capability-save]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      saveModelCapabilitySettings(button);
    });
  });
  target.querySelectorAll("[data-reset-model-capabilities]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      runAction(button, async () => {
        const response = await api.resetModelCapabilities(button.dataset.resetModelCapabilities);
        state = response?.state || await api.getState();
        draftSelection = [...state.selectedModelIds];
        render();
        showToast("模型能力已恢复默认；上下文如需修改可重新保存。");
      });
    });
  });
  target.querySelectorAll("[data-model-context-save]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      saveInlineModelContext(button);
    });
  });
  target.querySelectorAll("[data-edit-custom]").forEach((button) => {
    button.addEventListener("click", () => openCustomEditor(button.dataset.editCustom));
  });
  target.querySelectorAll("[data-remove-custom]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        if (editingCustomPresetId === button.dataset.removeCustom) {
          resetCustomModelForm();
        }
        state = await api.removeCustomModel(button.dataset.removeCustom);
        draftSelection = [...state.selectedModelIds];
        render();
        showToast("自定义模型已删除。");
      }),
    );
  });
}

function modelCard(model, selected, includeControls = true) {
  const isSelected = selected.has(model.presetId);
  const supportsImage = modelSupportsImage(model);
  const isNativeDisabled = state.mode === "all_api" && model.authMode === "codex_openai";
  const disabled = isNativeDisabled;
  const reason = isNativeDisabled
    ? "全部 API 模式不能选择订阅模型"
    : providerName(model.providerId);
  return `
    <div class="model-card-shell">
      <button class="model-card ${isSelected ? "selected" : ""}" data-model-id="${escapeHtml(model.presetId)}" ${disabled ? "disabled" : ""}>
        <span class="model-title">${escapeHtml(model.displayName)}</span>
        <span class="model-meta">${escapeHtml(model.model)} · ${escapeHtml(providerName(model.providerId))}</span>
        <span class="model-capability-summary">${escapeHtml(includeControls ? modelFriendlySummary(model) : modelCatalogSummary(model))}</span>
        ${includeControls ? modelCapabilityBadges(model) : ""}
        ${includeControls ? modelCapabilityHints(model) : ""}
        ${includeControls ? `<span class="model-foot">${escapeHtml(reason)}</span>` : ""}
      </button>
      ${includeControls ? modelConfigControls(model, supportsImage) : ""}
    </div>
  `;
}

function modelFriendlySummary(model) {
  const modalities = new Set(inputModalitiesForModel(model));
  const parts = [
    model.api === "responses" ? "Responses" : "Chat",
    `上下文 ${formatCompactContext(model.contextWindow || 258400)}`,
    modalities.has("image") ? "图片可用" : "纯文本",
  ];
  if (modalities.has("file")) {
    parts.push("文件可用");
  }
  if (modalities.has("audio")) {
    parts.push("音频可用");
  }
  return parts.join(" · ");
}

function modelCatalogSummary(model) {
  const modalities = new Set(inputModalitiesForModel(model));
  const parts = [model.api === "responses" ? "Responses" : "Chat"];
  if (modalities.has("image")) {
    parts.push("图片");
  }
  if (modalities.has("file")) {
    parts.push("文件");
  }
  return parts.join(" · ");
}

function modelConfigControls(model, supportsImage) {
  return `
    <button
      class="capability-toggle ${supportsImage ? "enabled" : ""}"
      type="button"
      data-image-input-toggle="${escapeHtml(model.presetId)}"
      aria-pressed="${supportsImage ? "true" : "false"}"
      title="${supportsImage ? "点击关闭图片上传" : "点击开启图片上传"}"
    >
      <span>图片上传</span>
      <strong>${supportsImage ? "开" : "关"}</strong>
    </button>
    ${inlineModelContextControl(model)}
    ${modelExtraSettingsControl(model)}
    ${
      model.custom
        ? `<div class="model-card-actions">
            <button class="text-button edit-model" data-edit-custom="${escapeHtml(model.presetId)}">编辑</button>
            <button class="text-button remove-model" data-remove-custom="${escapeHtml(model.presetId)}">删除</button>
          </div>`
        : ""
    }
  `;
}

function modelExtraSettingsControl(model) {
  return `
    <details class="model-extra-settings">
      <summary>
        <span>高级设置</span>
        <small>生图代理、能力恢复</small>
      </summary>
      <div class="model-extra-settings-body">
        ${imageProviderSelectControl(model)}
        ${modelCapabilityResetControl(model)}
      </div>
    </details>
  `;
}

function imageProviderSelectControl(model) {
  const providers = imageProviders();
  const override = state.imageGenerationOverrides?.[model.presetId] || {};
  const officialAllowed = modelAllowsOfficialImageGeneration(model);
  const defaultProviderId = imageProviderConfig().defaultProviderId;
  const current = imageProviderSelectValue(model, override, officialAllowed, defaultProviderId);
  const providerOptions = providers
    .map((provider) => {
      const value = `provider:${provider.id}`;
      return `<option value="${escapeHtml(value)}" ${current === value ? "selected" : ""}>${escapeHtml(provider.name)}</option>`;
    })
    .join("");
  const inheritedName = providers.find((provider) => provider.id === defaultProviderId)?.name || "未设置默认";
  return `
    <label class="image-provider-inline" data-image-provider-inline="${escapeHtml(model.presetId)}">
      <span>生图代理</span>
      <select data-image-provider-select="${escapeHtml(model.presetId)}">
        ${officialAllowed ? `<option value="official" ${current === "official" ? "selected" : ""}>官方 OpenAI</option>` : ""}
        <option value="inherit" ${current === "inherit" ? "selected" : ""}>继承默认：${escapeHtml(inheritedName)}</option>
        ${providerOptions}
        <option value="off" ${current === "off" ? "selected" : ""}>关闭</option>
      </select>
    </label>
  `;
}

function imageProviderSelectValue(model, override, officialAllowed, defaultProviderId) {
  if (override?.mode === "provider" && override.providerId) {
    return `provider:${override.providerId}`;
  }
  if (override?.mode === "off") {
    return "off";
  }
  if (override?.mode === "official" && officialAllowed) {
    return "official";
  }
  if (override?.mode === "inherit") {
    return "inherit";
  }
  if (officialAllowed) {
    return "official";
  }
  return defaultProviderId ? "inherit" : "off";
}

function imageGenerationOverrideFromSelectValue(value, model) {
  if (value === "off") {
    return { mode: "off" };
  }
  if (value === "official") {
    return modelAllowsOfficialImageGeneration(model) ? { mode: "official" } : { mode: "off" };
  }
  if (value === "inherit") {
    return { mode: "inherit" };
  }
  if (value.startsWith("provider:")) {
    return {
      mode: "provider",
      providerId: value.slice("provider:".length),
    };
  }
  return { mode: "inherit" };
}

function modelCapabilityResetControl(model) {
  if (model.capabilityOverrideSource !== "manual") {
    return "";
  }
  return `
    <div class="capability-reset-panel">
      <div>
        <strong>已修改模型能力</strong>
        <span>可恢复默认能力声明，避免旧覆盖影响路由判断。</span>
      </div>
      <button class="ghost-button light small" type="button" data-reset-model-capabilities="${escapeHtml(model.presetId)}">恢复默认</button>
    </div>
  `;
}

function inlineModelContextControl(model) {
  return `
    <div class="model-context-inline" data-model-context="${escapeHtml(model.presetId)}">
      <label>
        <span>上下文</span>
        <input type="number" min="1" step="1" data-inline-context value="${escapeHtml(String(model.contextWindow || 258400))}" />
      </label>
      <button class="ghost-button light small" type="button" data-model-context-save="${escapeHtml(model.presetId)}">保存上下文</button>
    </div>
  `;
}

function imageGenerationControl(model) {
  const settings = imageGenerationSettingsForModel(model);
  const mode = settings.mode || "official";
  const custom = mode === "custom";
  const saved = Boolean(settings.apiKeyEnv && state.secretStatus?.[settings.apiKeyEnv]);
  return `
    <div class="image-generation-panel ${custom ? "custom" : ""}" data-image-gen-config data-preset-id="${escapeHtml(model.presetId)}">
      <div class="image-generation-head">
        <label>
          <span>图片生成</span>
          <select data-image-gen-mode>
            <option value="official" ${mode === "official" ? "selected" : ""}>官方 OpenAI</option>
            <option value="custom" ${mode === "custom" ? "selected" : ""}>自定义生图</option>
            <option value="off" ${mode === "off" ? "selected" : ""}>关闭</option>
          </select>
        </label>
        <button class="ghost-button light small" type="button" data-image-gen-save>保存生图设置</button>
      </div>
      <div class="image-generation-note" data-image-gen-note>
        ${mode === "official"
          ? "默认走 OpenAI 官方图片生成。订阅和 OpenAI API 模型建议保持这一项。"
          : mode === "off"
            ? "关闭后，这个模型遇到生图请求会按普通文本请求发给当前模型。"
            : "这个模型的生图请求会转发到下面填写的图片生成接口。"}
      </div>
      <div class="image-generation-fields ${custom ? "" : "hidden"}">
        <label>
          <span>服务名</span>
          <input data-image-gen-display-name value="${escapeHtml(settings.displayName || "Custom Image Generation")}" placeholder="例如 My Image API" />
        </label>
        <label>
          <span>Base URL</span>
          <input data-image-gen-base-url value="${escapeHtml(settings.baseUrl || "")}" placeholder="例如 https://api.example.com/v1" />
        </label>
        <label>
          <span>Endpoint</span>
          <input data-image-gen-endpoint value="${escapeHtml(settings.endpoint || "/images/generations")}" placeholder="/images/generations" />
        </label>
        <label>
          <span>模型名</span>
          <input data-image-gen-model value="${escapeHtml(settings.model || "")}" placeholder="例如 image-model-v1" />
        </label>
        <label>
          <span>尺寸</span>
          <input data-image-gen-size value="${escapeHtml(settings.size || "")}" placeholder="留空使用模型默认，例如 1024x1024" />
        </label>
        <label>
          <span>Key 名</span>
          <input data-image-gen-key-env value="${escapeHtml(settings.apiKeyEnv || "IMAGE_GENERATION_API_KEY")}" placeholder="IMAGE_GENERATION_API_KEY" />
        </label>
        <label class="wide-field">
          <span>API Key ${saved ? "（已保存）" : ""}</span>
          <div class="secret-row">
            <input type="password" data-image-gen-api-key placeholder="${saved ? "已保存，留空不修改" : "sk-..."}" />
            ${saved ? `<button class="ghost-button light small" type="button" data-image-gen-toggle-secret>查看</button>` : ""}
          </div>
        </label>
      </div>
    </div>
  `;
}

function imageGenerationSettingsForModel(model) {
  const override = state.imageGenerationOverrides?.[model.presetId];
  if (override?.mode === "custom" || override?.mode === "off") {
    return override;
  }
  if (override?.mode === "official" && modelAllowsOfficialImageGeneration(model)) {
    return override;
  }
  if (!modelAllowsOfficialImageGeneration(model)) {
    return { mode: "off" };
  }
  return {
    enabled: true,
    mode: "official",
    displayName: "OpenAI Image Generation",
    baseUrl: "https://api.openai.com/v1",
    endpoint: "/images/generations",
    model: "gpt-image-1",
    size: "",
    apiKeyEnv: "OPENAI_API_KEY",
  };
}

function modelAllowsOfficialImageGeneration(model = {}) {
  const providerId = String(model.providerId || model.provider || "").toLowerCase();
  const authMode = String(model.authMode || "").toLowerCase();
  return providerId === "codex" || providerId === "openai" || authMode === "codex_openai";
}

function renderImageGenerationPanelMode(panel) {
  if (!panel) {
    return;
  }
  const mode = panel.querySelector("[data-image-gen-mode]")?.value || "official";
  panel.classList.toggle("custom", mode === "custom");
  panel.querySelector(".image-generation-fields")?.classList.toggle("hidden", mode !== "custom");
  const note = panel.querySelector("[data-image-gen-note]");
  if (note) {
    note.textContent = mode === "official"
      ? "默认走 OpenAI 官方图片生成。订阅和 OpenAI API 模型建议保持这一项。"
      : mode === "off"
        ? "关闭后，这个模型遇到生图请求会按普通文本请求发给当前模型。"
        : "这个模型的生图请求会转发到下面填写的图片生成接口。";
  }
}

function saveImageGenerationSettings(button) {
  return runAction(button, async () => {
    const panel = button.closest("[data-image-gen-config]");
    const imageGeneration = imageGenerationPayload(panel);
    if (imageGeneration.mode === "custom") {
      const apiKey = panel.querySelector("[data-image-gen-api-key]")?.value.trim();
      if (apiKey) {
        imageGeneration.apiKey = apiKey;
      }
    }
    state = await api.saveModelImageGeneration({
      presetId: panel.dataset.presetId,
      imageGeneration,
    });
    draftSelection = [...state.selectedModelIds];
    render();
    showToast("图片生成设置已保存，只影响这一张模型卡。");
  });
}

function imageGenerationPayload(panel) {
  const mode = panel.querySelector("[data-image-gen-mode]")?.value || "official";
  const model = modelMap().get(panel.dataset.presetId);
  if (mode === "off") {
    return { mode: "off" };
  }
  if (mode !== "custom") {
    if (!modelAllowsOfficialImageGeneration(model)) {
      return { mode: "off" };
    }
    return { mode: "official" };
  }
  return {
    mode: "custom",
    displayName: panel.querySelector("[data-image-gen-display-name]")?.value.trim(),
    baseUrl: panel.querySelector("[data-image-gen-base-url]")?.value.trim(),
    endpoint: panel.querySelector("[data-image-gen-endpoint]")?.value.trim(),
    model: panel.querySelector("[data-image-gen-model]")?.value.trim(),
    size: panel.querySelector("[data-image-gen-size]")?.value.trim(),
    apiKeyEnv: panel.querySelector("[data-image-gen-key-env]")?.value.trim(),
  };
}

function capabilityOverrideControl(model) {
  const modalities = new Set(inputModalitiesForModel(model));
  const manual = model.capabilityOverrideSource === "manual";
  const reasoningMode = model.reasoningCapabilityOverride?.mode || "";
  return `
    <details class="capability-override" data-capability-config data-preset-id="${escapeHtml(model.presetId)}">
      <summary>
        <span>能力覆盖</span>
        <strong>${manual ? "手动" : "默认"}</strong>
      </summary>
      <div class="capability-fields">
        <label>
          <span>Context</span>
          <input type="number" min="1" step="1" data-cap-context value="${escapeHtml(String(model.contextWindow || 258400))}" />
        </label>
        <label class="checkbox-field compact">
          <input type="checkbox" data-cap-file ${modalities.has("file") ? "checked" : ""} />
          <span>文件</span>
        </label>
        <label class="checkbox-field compact">
          <input type="checkbox" data-cap-audio ${modalities.has("audio") ? "checked" : ""} />
          <span>音频</span>
        </label>
        <label>
          <span>Reasoning</span>
          <select data-cap-reasoning>
            ${capabilityReasoningOption("", "自动", reasoningMode)}
            ${capabilityReasoningOption("unknown", "未知", reasoningMode)}
            ${capabilityReasoningOption("supported", "支持", reasoningMode)}
            ${capabilityReasoningOption("unsupported", "不支持", reasoningMode)}
          </select>
        </label>
        <button class="ghost-button light small" type="button" data-capability-save>保存能力</button>
      </div>
      <p class="capability-note">只影响这个模型的能力声明和目录，不改 API Key、tools 或 MCP。</p>
    </details>
  `;
}

function capabilityReasoningOption(value, label, selected) {
  return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function saveModelCapabilitySettings(button) {
  return runAction(button, async () => {
    const panel = button.closest("[data-capability-config]");
    const presetId = panel.dataset.presetId;
    const model = modelMap().get(presetId);
    const inputModalities = ["text"];
    if (modelSupportsImage(model)) {
      inputModalities.push("image");
    }
    if (panel.querySelector("[data-cap-file]")?.checked) {
      inputModalities.push("file");
    }
    if (panel.querySelector("[data-cap-audio]")?.checked) {
      inputModalities.push("audio");
    }
    const contextWindow = Number(panel.querySelector("[data-cap-context]")?.value || 0);
    const reasoningMode = panel.querySelector("[data-cap-reasoning]")?.value || "";
    const response = await api.saveModelCapabilities({
      presetId,
      capabilities: {
        inputModalities,
        contextWindow,
        reasoning: reasoningMode ? { mode: reasoningMode } : undefined,
      },
    });
    state = response?.state || await api.getState();
    draftSelection = [...state.selectedModelIds];
    render();
    showToast("模型能力覆盖已保存。");
  });
}

function saveInlineModelContext(button) {
  return runAction(button, async () => {
    const container = button.closest("[data-model-context]");
    const presetId = container?.dataset.modelContext || button.dataset.modelContextSave;
    const model = modelMap().get(presetId);
    const contextWindow = Number(container?.querySelector("[data-inline-context]")?.value || 0);
    if (!model || !Number.isFinite(contextWindow) || contextWindow <= 0) {
      throw new Error("请输入有效的上下文大小。");
    }
    const response = await api.saveModelCapabilities({
      presetId,
      capabilities: {
        contextWindow,
      },
    });
    state = response?.state || await api.getState();
    draftSelection = [...state.selectedModelIds];
    render();
    showToast("这个模型的上下文大小已保存。");
  });
}

function modelCapabilitySummary(model) {
  const status = modelCapabilityStatus(model);
  const modalities = new Set(inputModalitiesForModel(model));
  const parts = [
    `上游 ${status.provider || providerName(model.providerId)} / ${status.api || model.api}`,
    `Context ${formatNumber(model.contextWindow || 258400)}`,
    `图片${modalities.has("image") ? "开" : "关"}`,
    `文件${modalities.has("file") ? "开" : "默认"}`,
  ];
  if (modalities.has("audio")) {
    parts.push("音频开");
  }
  if (model.reasoningCapabilityOverride?.mode) {
    parts.push(`Reasoning ${model.reasoningCapabilityOverride.mode}`);
  }
  if (model.capabilityOverrideSource === "manual") {
    parts.push("手动");
  }
  return parts.join(" · ");
}

function modelCapabilityStatus(model) {
  if (model?.capabilityStatus) {
    return model.capabilityStatus;
  }
  const modalities = new Set(inputModalitiesForModel(model));
  const api = model?.api === "responses" ? "responses" : "chat_completions";
  return {
    provider: model?.providerFamily || model?.providerId || model?.provider || "unknown",
    api,
    upstreamModel: model?.model || "",
    tools: api === "responses" ? "native" : "chat-functions",
    mcpNamespaces: "native",
    images: modalities.has("image") ? (api === "responses" ? "native" : "chat-image-url") : "none",
    files: api === "responses" ? "native" : (model?.custom ? "none" : "text-placeholder"),
    audio: modalities.has("audio") ? (api === "responses" ? "native" : "chat-input-audio") : "none",
    compact: api === "responses" ? "responses-native" : "chat-summary",
    compactStrategy: api === "responses" ? "responses-json" : "chat-json",
    contextWindow: model?.contextWindow || 258400,
  };
}

function modelCapabilityBadges(model) {
  const status = modelCapabilityStatus(model);
  const badges = [
    ["上游", status.provider || providerName(model.providerId)],
    ["API", status.api || model.api || "-"],
    ["Tools", status.tools || "unknown"],
    ["MCP", status.mcpNamespaces || "unknown"],
    ["Image", status.images || "unknown"],
    ["File", status.files || "unknown"],
    ["Compact", status.compact || "unknown"],
  ];
  return `
    <span class="model-capability-badges" data-capability-badges>
      ${badges
        .map(([label, value]) => `<span class="capability-badge"><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</span>`)
        .join("")}
    </span>
  `;
}

function modelCapabilityHints(model) {
  const status = modelCapabilityStatus(model);
  const hints = [];
  if (status.images === "none") {
    hints.push("图片不直传");
  }
  if (status.files === "none") {
    hints.push("文件不直传");
  }
  if (status.compact === "unknown" || status.compact === "none") {
    hints.push("压缩需回退");
  }
  if (!hints.length) {
    return "";
  }
  return `<span class="model-capability-hints">${hints.map(escapeHtml).join(" · ")}</span>`;
}

function renderCapabilityDiagnostics() {
  if (!els.capabilitySummary || !els.capabilityDiagnostics) {
    return;
  }
  const rows = capabilityDiagnosticRows();
  if (!rows.length) {
    els.capabilitySummary.innerHTML = "";
    els.capabilityDiagnostics.innerHTML = `<div class="empty-state">还没有可诊断的模型。先到模型页选择并保存模型。</div>`;
    return;
  }

  const imageCount = rows.filter((row) => row.capabilities.image.enabled).length;
  const toolsCount = rows.filter((row) => row.capabilities.tools.enabled).length;
  const fileCount = rows.filter((row) => row.capabilities.files.state === "ok").length;
  const longContextCount = rows.filter((row) => Number(row.contextWindow || 0) >= 128000).length;
  const imageProxyCount = rows.filter((row) => row.imageProxy.enabled).length;
  els.capabilitySummary.innerHTML = [
    ["当前模型", `${rows.length} 个`, "已选择并可使用的模型"],
    ["图片上传", `${imageCount} 个`, "可直接识别你上传的截图、照片和图片链接"],
    ["工具协作", `${toolsCount} 个`, "可配合已启用的工具完成更多操作"],
    ["文件处理", `${fileCount} 个`, "可直接读取你上传的文件"],
    ["长内容处理", `${longContextCount} 个`, "适合处理很长的对话和文档"],
    ["图片生成", `${imageProxyCount} 个`, "配置图片服务后可直接生成并保存图片"],
  ].map(([label, value, detail]) => `
    <article class="capability-summary-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </article>
  `).join("");

  els.capabilityDiagnostics.innerHTML = `
    <div class="capability-route-note">
      <strong>模型能力</strong>
      <span>实验能力供应商仅用于手动试运行，不会改变模型路由。</span>
    </div>
    <div class="capability-matrix" aria-label="模型能力诊断">
      ${rows.map(capabilityDiagnosticRowHtml).join("")}
    </div>
  `;
  bindCapabilityDiagnosticActions();
}

function capabilityProviderMarketHtml() {
  const groups = capabilityProviderGroups().filter((group) =>
    Array.isArray(group.providers) && group.providers.length
  );
  if (!groups.length) {
    return "";
  }
  return `
    <section class="capability-provider-market" aria-label="能力供应商">
      <div class="capability-provider-market-head">
        <strong>已配置的实验供应商</strong>
        <span>只显示已配置项；除图片生成外，这些供应商不会自动改变模型路由。</span>
      </div>
      <div class="capability-provider-groups">
        ${groups.map(capabilityProviderGroupHtml).join("")}
      </div>
    </section>
  `;
}

function capabilityProviderGroups() {
  if (Array.isArray(state.capabilityProviderGroups)) {
    return state.capabilityProviderGroups.filter((group) => group.capability !== "image_generation");
  }
  const providers = customCapabilityProviders();
  const knownCapabilities = [
    "ocr",
    "web_search",
    "browser",
    "computer_use",
    "file_processing",
    "webpage_screenshot",
    "speech",
    "video",
  ];
  return knownCapabilities.map((capability) => {
    const capabilityProviders = providers.filter((provider) =>
      Array.isArray(provider.capabilities) && provider.capabilities.includes(capability),
    );
    const enabledProviders = capabilityProviders.filter((provider) => provider.enabled !== false);
    const defaultProvider = enabledProviders.find((provider) =>
      capabilityProviderIsDefaultForCapability(provider, capability)
    ) || null;
    return {
      capability,
      providers: capabilityProviders,
      enabledCount: enabledProviders.length,
      disabledCount: capabilityProviders.length - enabledProviders.length,
      defaultProviderId: defaultProvider?.id || "",
      backupCount: Math.max(0, enabledProviders.length - (defaultProvider ? 1 : 0)),
    };
  });
}

function capabilityProviderGroupHtml(group = {}) {
  const providers = Array.isArray(group.providers) ? group.providers : [];
  const enabledCount = Number(group.enabledCount || 0);
  const backupCount = Number(group.backupCount || 0);
  const disabledCount = Number(group.disabledCount || 0);
  const status = providers.length
    ? `${enabledCount} 启用 · ${backupCount} 备用 · ${disabledCount} 停用 · ${capabilityProviderAutomationLabel(group.capability)}`
    : "暂未配置";
  return `
    <section class="capability-provider-group ${providers.length ? "" : "empty"}">
      <header class="capability-provider-group-head">
        <strong>${escapeHtml(capabilityProviderCapabilityLabel(group.capability))}</strong>
        <span>${escapeHtml(status)}</span>
      </header>
      ${providers.length
        ? `<div class="capability-provider-list">${providers.map((provider) => capabilityProviderItemHtml(provider, group.capability)).join("")}</div>`
        : `<div class="capability-provider-empty">暂未配置</div>`}
    </section>
  `;
}

function capabilityProviderItemHtml(provider = {}, capability = "") {
  const capabilities = Array.isArray(provider.capabilities) ? provider.capabilities : [];
  const capabilityLabels = capabilities.map(capabilityProviderCapabilityLabel).join("、") || "未知能力";
  const isDefault = capabilityProviderIsDefaultForCapability(provider, capability);
  const role = capabilityProviderRoleLabel(provider, capability);
  const priority = Number(provider.priority || 0);
  const canRetest = !provider.source || provider.source === "capabilityProviders";
  const test = capabilityProviderLastTestText(provider).replace(/^最近体检：/, "");
  const automation = capabilityProviderAutomationLabel(capability);
  return `
    <article class="capability-provider-item ${isDefault ? "default" : ""} ${provider.enabled === false ? "disabled" : ""}">
      <div>
        <strong>${escapeHtml(provider.displayName || provider.name || provider.id || "能力供应商")}</strong>
        <span>${escapeHtml(capabilityLabels)} · ${escapeHtml(provider.model || provider.adapter || "")}</span>
        <span>${escapeHtml(automation)} · 优先级 ${priority}</span>
      </div>
      <small>${escapeHtml(`${role} · ${test}`)}</small>
      ${canRetest ? `
        <div class="capability-provider-item-actions">
          <button class="ghost-button light small" type="button" data-capability-provider-test="${escapeHtml(provider.id || "")}">重新体检</button>
        </div>
      ` : ""}
      ${capabilityProviderBridgeHtml(provider)}
    </article>
  `;
}

function capabilityProviderAutomationLabel(capability = "") {
  if (capability === "image_generation") {
    return "已接入自动代理";
  }
  if (["browser", "computer_use", "file_processing", "webpage_screenshot"].includes(capability)) {
    return "本地/手动试运行";
  }
  return "仅可体检/试运行";
}

function bindCapabilityDiagnosticActions() {
  if (!els.capabilityDiagnostics) {
    return;
  }
  els.capabilityDiagnostics.querySelectorAll("[data-capability-provider-test]").forEach((button) => {
    button.addEventListener("click", () => testSavedCapabilityProvider(button));
  });
}

function testSavedCapabilityProvider(button) {
  return runAction(button, async () => {
    const providerId = String(button?.dataset?.capabilityProviderTest || "").trim();
    const provider = (Array.isArray(state?.capabilityProviders) ? state.capabilityProviders : [])
      .find((item) => item.id === providerId && (!item.source || item.source === "capabilityProviders"));
    if (!provider) {
      throw new Error("没有找到这个能力供应商，请刷新后重试。");
    }
    const response = await api.testCapabilityProvider({
      providerId: provider.id,
      provider,
    });
    state = response?.state || await api.getState();
    renderCapabilityProviderList();
    renderCapabilityProviderTestResult(response);
    renderCapabilityDiagnostics();
    showToast(
      response?.ok ? "能力供应商体检通过。" : response?.message || response?.error || "能力供应商体检失败。",
      response?.ok ? "success" : "error",
    );
  });
}

function capabilityProviderBridgeHtml(provider = {}) {
  const bridge = provider.bridge && typeof provider.bridge === "object" ? provider.bridge : null;
  if (!bridge) {
    return "";
  }
  const supportedActions = Array.isArray(bridge.supportedActions) ? bridge.supportedActions : [];
  const tags = [
    bridge.requiresGptResponses ? "完整能力需 GPT / OpenAI Responses" : "",
    bridge.requiresDesktopExecutor ? "需要桌面执行器" : "",
    bridge.canControlDesktop === false ? "不控制鼠标键盘" : "",
  ].filter(Boolean);
  const limitation = bridge.limitation || (bridge.nativeTool === false ? "不是 GPT 原生工具；由 CodexBridge 受控桥接执行。" : "");
  return `
    <div class="capability-provider-bridge">
      <b>${escapeHtml(bridge.label || "本地桥接")}</b>
      ${supportedActions.length ? `<span>动作：${escapeHtml(supportedActions.join("、"))}</span>` : ""}
      ${tags.length ? `<span>${escapeHtml(tags.join(" · "))}</span>` : ""}
      ${limitation ? `<small>${escapeHtml(limitation)}</small>` : ""}
    </div>
  `;
}

function capabilityProviderIsDefaultForCapability(provider = {}, capability = "") {
  const defaultCapabilities = Array.isArray(provider.defaultCapabilities) ? provider.defaultCapabilities : [];
  if (defaultCapabilities.length) {
    return defaultCapabilities.includes(capability);
  }
  if (!provider.default) {
    return false;
  }
  const capabilities = Array.isArray(provider.capabilities) ? provider.capabilities : [];
  if (!capabilities.length || capabilities.length === 1) {
    return true;
  }
  return String(provider.capability || "").trim() === String(capability || "").trim();
}

function capabilityProviderDefaultCapabilitiesText(provider = {}) {
  const capabilities = Array.isArray(provider.defaultCapabilities) && provider.defaultCapabilities.length
    ? provider.defaultCapabilities
    : provider.default
      ? (Array.isArray(provider.capabilities) ? provider.capabilities : [])
      : [];
  return capabilities
    .map(capabilityProviderCapabilityLabel)
    .filter(Boolean)
    .join("、");
}

function capabilityProviderRoleLabel(provider = {}, capability = "") {
  if (provider.enabled === false) {
    return "停用";
  }
  if (capabilityProviderIsDefaultForCapability(provider, capability)) {
    return "默认";
  }
  return "备用";
}

function capabilityProviderCapabilityLabel(capability) {
  if (capability === "image_generation") {
    return "图片生成";
  }
  if (capability === "ocr") {
    return "OCR";
  }
  if (capability === "web_search") {
    return "搜索";
  }
  if (capability === "browser") {
    return "浏览器";
  }
  if (capability === "computer_use") {
    return "Computer Use";
  }
  if (capability === "file_processing") {
    return "文件处理";
  }
  if (capability === "webpage_screenshot") {
    return "网页截图";
  }
  if (capability === "speech") {
    return "语音";
  }
  if (capability === "video") {
    return "视频";
  }
  return String(capability || "未知能力");
}

function capabilityDiagnosticRows() {
  const presets = modelMap();
  const routes = Array.isArray(state.models) ? state.models : [];
  if (routes.length) {
    return routes.map((route, index) => {
      const preset = presets.get(route.sourcePresetId) || presets.get(route.id) || null;
      return capabilityDiagnosticRow(route, preset, index, "router");
    });
  }
  const selected = draftSelection.length ? draftSelection : (state.selectedModelIds || []);
  return selected
    .map((presetId, index) => {
      const preset = presets.get(presetId);
      return preset ? capabilityDiagnosticRow(null, preset, index, "selection") : null;
    })
    .filter(Boolean);
}

function capabilityDiagnosticRow(route, preset, index, source) {
  const model = route || preset || {};
  const status = modelCapabilityStatus(model);
  const imageProxy = imageProxyInfoForDiagnostic(route, preset);
  return {
    id: route?.id || preset?.presetId || `model-${index}`,
    displayName: route?.displayName || preset?.displayName || route?.id || preset?.presetId || "-",
    provider: providerName(route?.provider || preset?.providerId || status.provider),
    api: status.api || model.api || "-",
    upstreamModel: route?.model || preset?.model || status.upstreamModel || "-",
    source,
    evidence: capabilityEvidenceSummary(source),
    contextWindow: Number(status.contextWindow || model.contextWindow || 0),
    imageProxy,
    capabilities: {
      image: capabilityInfo("image", status.images),
      tools: capabilityInfo("tools", status.tools),
      mcp: capabilityInfo("mcp", status.mcpNamespaces),
      files: capabilityInfo("files", status.files),
      context: contextCapabilityInfo(status.contextWindow || model.contextWindow || 0),
    },
  };
}

function capabilityDiagnosticRowHtml(row) {
  const coreCells = [
    capabilityPill("图片上传", row.capabilities.image),
    capabilityPill("工具调用", row.capabilities.tools),
    capabilityPill("MCP", row.capabilities.mcp),
    capabilityPill("文件", row.capabilities.files),
    capabilityPill("长上下文", row.capabilities.context),
    capabilityPill("生图代理", row.imageProxy),
  ].join("");
  return `
    <details class="capability-matrix-row capability-model-details">
      <summary>
        <div class="capability-model-cell">
          <strong>${escapeHtml(row.displayName)}</strong>
          <span>${escapeHtml(row.upstreamModel)} · ${escapeHtml(row.provider)} · ${escapeHtml(apiLabel(row.api))}</span>
        </div>
        <div class="capability-compact-result">
          <strong>${escapeHtml(capabilityCompactSummary(row))}</strong>
          <span>${escapeHtml(capabilityMainReason(row))}</span>
        </div>
        <em>查看详情</em>
      </summary>
      <div class="capability-row-body">
        <div class="capability-pill-grid">
          ${coreCells}
        </div>
        <div class="capability-reason">
          <b class="capability-main-reason">${escapeHtml(capabilityMainReason(row))}</b>
          <span>${escapeHtml(capabilityReasonSummary(row))}</span>
        </div>
      </div>
    </details>
  `;
}

function capabilityCompactSummary(row) {
  const checks = [
    row.capabilities.image,
    row.capabilities.tools,
    row.capabilities.mcp,
    row.capabilities.files,
    row.capabilities.context,
    row.imageProxy,
  ];
  const ok = checks.filter((item) => item?.state === "ok").length;
  const warn = checks.filter((item) => item?.state === "warn").length;
  const bad = checks.filter((item) => item?.state === "bad").length;
  const parts = [
    ok ? `${ok} 项正常` : "",
    warn ? `${warn} 项降级/需确认` : "",
    bad ? `${bad} 项不可用` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("，") : "能力状态未知";
}

function capabilityEvidenceSummary(source) {
  return source === "router" ? "当前 Router 配置" : "模型栏选择";
}

function capabilityPill(label, info) {
  return `
    <span class="capability-pill ${escapeHtml(info.state || "warn")}">
      <strong>${escapeHtml(label)}</strong>
      <em>${escapeHtml(info.label || "-")}</em>
      <small>${escapeHtml(info.detail || "")}</small>
    </span>
  `;
}

function capabilityMainReason(row) {
  const checks = [
    ["图片上传", row.capabilities.image],
    ["工具调用", row.capabilities.tools],
    ["MCP", row.capabilities.mcp],
    ["文件", row.capabilities.files],
    ["长上下文", row.capabilities.context],
    ["生图代理", row.imageProxy],
  ];
  const blocked = checks.find(([, info]) => info && info.enabled === false && info.state === "bad");
  if (blocked) {
    return `主要限制：${blocked[0]} - ${blocked[1].detail}`;
  }
  const warning = checks.find(([, info]) => info && (info.enabled === false || info.state === "warn"));
  if (warning) {
    return `需要留意：${warning[0]} - ${warning[1].detail}`;
  }
  return "主要能力正常：原生能力和已接入代理都已确认。";
}

function capabilityReasonSummary(row) {
  return [
    `图片上传：${row.capabilities.image.detail}`,
    `工具调用：${row.capabilities.tools.detail}`,
    `MCP：${row.capabilities.mcp.detail}`,
    `文件：${row.capabilities.files.detail}`,
    `长上下文：${row.capabilities.context.detail}`,
    `生图代理：${row.imageProxy.detail}`,
  ].join("；");
}

function contextCapabilityInfo(value) {
  const contextWindow = Number(value || 0);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return {
      label: "未知",
      detail: "没有拿到上下文窗口配置，长会话前建议先手动设置。",
      enabled: false,
      state: "warn",
    };
  }
  if (contextWindow >= 128000) {
    return {
      label: `${formatCompactContext(contextWindow)} 长`,
      detail: `上下文 ${formatNumber(contextWindow)}，适合长代码库、长日志和长会话。`,
      enabled: true,
      state: "ok",
    };
  }
  return {
    label: `${formatCompactContext(contextWindow)} 普通`,
    detail: `上下文 ${formatNumber(contextWindow)}，普通对话可用，长代码库或长日志可能需要压缩。`,
    enabled: false,
    state: "warn",
  };
}

function capabilityInfo(kind, value) {
  const normalized = String(value || "unknown");
  if (kind === "image") {
    if (normalized === "native") {
      return { label: "原生", detail: "Responses 模型可直接接收图片输入。", enabled: true, state: "ok" };
    }
    if (normalized === "chat-image-url") {
      return { label: "兼容", detail: "Chat 模型通过 image_url 兼容格式接收图片。", enabled: true, state: "ok" };
    }
    return { label: "不可用", detail: "这个模型当前只按纯文本处理图片。", enabled: false, state: "bad" };
  }
  if (kind === "tools") {
    if (normalized === "native") {
      return { label: "原生", detail: "Responses 路由保留 Codex 原生工具结构。", enabled: true, state: "ok" };
    }
    if (normalized === "chat-functions") {
      return { label: "兼容", detail: "Chat 路由会把工具转换成函数调用格式。", enabled: true, state: "ok" };
    }
    return { label: statusLabel(normalized), detail: "没有确认可用的工具调用能力。", enabled: false, state: "warn" };
  }
  if (kind === "mcp") {
    if (normalized === "native" || normalized === "true") {
      return { label: "可用", detail: "MCP 命名空间会保留给 Codex 使用。", enabled: true, state: "ok" };
    }
    return { label: statusLabel(normalized), detail: "MCP 不能直接传给这个模型。", enabled: false, state: "warn" };
  }
  if (kind === "files") {
    if (normalized === "native") {
      return { label: "原生文件", detail: "模型可直接接收文件输入。", enabled: true, state: "ok" };
    }
    if (normalized === "text-placeholder") {
      return { label: "转文本", detail: "不支持原生附件；只会把可读内容转成文字给模型。", enabled: false, state: "warn" };
    }
    return { label: "不支持", detail: "这个模型不会直接接收文件内容。", enabled: false, state: "bad" };
  }
  return { label: statusLabel(normalized), detail: normalized, enabled: false, state: "warn" };
}

function imageProxyInfoForDiagnostic(route, preset) {
  const source = imageProxySourceForDiagnostic(route, preset);
  const settings = source.settings;
  const mode = String(settings?.mode || "").toLowerCase();
  if (!settings || settings.enabled === false || mode === "off" || mode === "disabled") {
    return {
      label: source.label || "关闭",
      detail: source.detail || "生图请求会按普通文本发给当前模型。",
      enabled: false,
      state: source.state || "bad",
    };
  }
  if (mode === "official") {
    return {
      label: "OpenAI",
      detail: source.detail || "GPT/OpenAI 路由可使用官方图片生成接口。",
      enabled: true,
      state: "ok",
    };
  }
  const testSummary = imageProxyTestSummary(settings.lastTest);
  return {
    label: settings.displayName || settings.providerId || "图片供应商",
    detail: `${source.detail || "生图请求会转给独立图片供应商"}，结果保存本地后返回给 Codex。${testSummary}`,
    enabled: true,
    state: settings.lastTest?.ok ? "ok" : "warn",
  };
}

function imageProxySourceForDiagnostic(route, preset) {
  if (route?.imageGeneration) {
    const settings = imageGenerationSettingsWithProviderTest(route.imageGeneration);
    const provider = settings?.providerId ? imageProviderForDiagnostic(settings.providerId) : null;
    const providerName = provider?.name || settings?.displayName || settings?.providerId || "图片供应商";
    return {
      settings,
      label: settings?.displayName || providerName,
      detail: settings?.providerId
        ? `当前 Router 路由单独配置图片供应商 ${providerName}`
        : "当前 Router 路由使用自定义图片接口",
    };
  }
  if (!preset) {
    return {
      settings: null,
      label: "未配置",
      detail: "没有拿到模型预设，无法判断生图代理来源。",
      state: "bad",
    };
  }
  const override = state.imageGenerationOverrides?.[preset.presetId];
  if (override?.mode === "provider") {
    return imageProviderSourceForDiagnostic(override.providerId, "模型单独绑定图片供应商");
  }
  if (override?.mode === "off") {
    return {
      settings: { enabled: false, mode: "off" },
      label: "关闭",
      detail: "这个模型已手动关闭生图代理，生图请求会按普通文本发给当前模型。",
      state: "bad",
    };
  }
  if (override?.mode === "inherit" || (!override && !modelAllowsOfficialImageGeneration(preset))) {
    const inherited = imageProviderGenerationSettings(defaultImageProviderForDiagnostic()?.id);
    if (inherited) {
      return {
        settings: inherited,
        label: inherited.displayName || inherited.providerId || "图片供应商",
        detail: `继承默认图片供应商 ${inherited.displayName || inherited.providerId || "图片供应商"}`,
      };
    }
    return defaultImageProviderFailureForDiagnostic();
  }
  return {
    settings: imageGenerationSettingsForModel(preset),
    label: "OpenAI",
    detail: "GPT/OpenAI 路由可使用官方图片生成接口。",
  };
}

function imageProviderSourceForDiagnostic(providerId, prefix) {
  const provider = imageProviderForDiagnostic(providerId);
  const displayName = provider?.name || providerId || "图片供应商";
  if (!provider) {
    return {
      settings: null,
      label: "缺失",
      detail: `图片供应商不存在：${prefix} ${displayName}，请重新选择或先保存这个图片供应商。`,
      state: "bad",
    };
  }
  if (provider.enabled === false) {
    return {
      settings: null,
      label: "停用",
      detail: `图片供应商已停用：${prefix} ${displayName}，启用后这个模型才能继续代理生图。`,
      state: "bad",
    };
  }
  return {
    settings: imageProviderGenerationSettings(provider.id),
    label: provider.name || provider.id,
    detail: `${prefix} ${provider.name || provider.id}`,
  };
}

function defaultImageProviderFailureForDiagnostic() {
  const config = imageProviderConfig();
  const defaultProviderId = String(config.defaultProviderId || "").trim();
  const provider = defaultProviderId ? imageProviderForDiagnostic(defaultProviderId) : null;
  if (defaultProviderId && !provider) {
    return {
      settings: null,
      label: "缺失",
      detail: `图片供应商不存在：默认图片供应商 ${defaultProviderId} 已不存在，请重新设置默认图片供应商。`,
      state: "bad",
    };
  }
  if (provider?.enabled === false) {
    return {
      settings: null,
      label: "停用",
      detail: `图片供应商已停用：默认图片供应商 ${provider.name || provider.id} 已停用，请启用或换一个默认供应商。`,
      state: "bad",
    };
  }
  return {
    settings: null,
    label: "未配置",
    detail: "没有默认图片供应商，也没有给这个模型单独绑定图片供应商；非 OpenAI 模型遇到生图请求会按普通文本处理。",
    state: "bad",
  };
}

function imageProviderForDiagnostic(providerId) {
  const id = String(providerId || "").trim();
  if (!id) {
    return null;
  }
  return imageProviders().find((item) => item.id === id) || null;
}

function imageGenerationSettingsForDiagnostic(route, preset) {
  if (route?.imageGeneration) {
    return imageGenerationSettingsWithProviderTest(route.imageGeneration);
  }
  if (!preset) {
    return null;
  }
  const override = state.imageGenerationOverrides?.[preset.presetId];
  if (override?.mode === "provider") {
    return imageProviderGenerationSettings(override.providerId);
  }
  if (override?.mode === "inherit" || (!override && !modelAllowsOfficialImageGeneration(preset))) {
    const inherited = imageProviderGenerationSettings(defaultImageProviderForDiagnostic()?.id);
    if (inherited) {
      return inherited;
    }
  }
  return imageGenerationSettingsForModel(preset);
}

function imageGenerationSettingsWithProviderTest(settings) {
  if (!settings || settings.lastTest) {
    return settings;
  }
  const providerId = String(settings.providerId || "").trim();
  if (!providerId) {
    return settings;
  }
  const provider = imageProviders().find((item) => item.id === providerId);
  return provider?.lastTest
    ? {
        ...settings,
        lastTest: provider.lastTest,
      }
    : settings;
}

function defaultImageProviderForDiagnostic() {
  const config = imageProviderConfig();
  const providers = imageProviders();
  const enabledProviders = providers.filter((provider) => provider?.enabled !== false);
  const defaultProvider = enabledProviders.find((provider) => provider.id === config.defaultProviderId);
  if (defaultProvider) {
    return defaultProvider;
  }
  return enabledProviders.sort(compareImageProviderPriorityForDiagnostic)[0] || null;
}

function compareImageProviderPriorityForDiagnostic(left = {}, right = {}) {
  const priorityDiff = Number(right.priority || 0) - Number(left.priority || 0);
  if (priorityDiff) {
    return priorityDiff;
  }
  return String(left.id || "").localeCompare(String(right.id || ""));
}

function imageProviderGenerationSettings(providerId) {
  const provider = imageProviders().find((item) => item.id === providerId);
  if (!provider || provider.enabled === false) {
    return null;
  }
  return {
    enabled: true,
    mode: "custom",
    providerId: provider.id,
    displayName: provider.name,
    model: provider.model,
    lastTest: provider.lastTest,
  };
}

function imageProxyTestSummary(lastTest) {
  if (!lastTest) {
    return "尚未测试；建议先到设置页点“测试生图”。";
  }
  if (lastTest.ok) {
    const duration = Number.isFinite(Number(lastTest.durationMs))
      ? `，耗时 ${formatDuration(lastTest.durationMs)}`
      : "";
    const checkedAt = lastTest.checkedAt ? `，${formatTime(lastTest.checkedAt)}` : "";
    return `最近测试通过${duration}${checkedAt}。`;
  }
  return `最近测试失败：${lastTest.message || "请重新测试生图查看错误原因。"}`;
}

function statusLabel(value) {
  const normalized = String(value || "unknown");
  if (normalized === "unknown") {
    return "未知";
  }
  if (normalized === "none") {
    return "不可用";
  }
  return normalized;
}

function apiLabel(value) {
  return value === "responses" ? "Responses" : "Chat Completions";
}

function modelSupportsImage(model) {
  return Array.isArray(model?.inputModalities) && model.inputModalities.includes("image");
}

function inputModalitiesForModel(model) {
  if (Array.isArray(model?.inputModalities) && model.inputModalities.length) {
    return model.inputModalities;
  }
  return model?.api === "responses" ? ["text", "image"] : ["text"];
}

function toggleModel(presetId) {
  if (draftSelection.includes(presetId)) {
    draftSelection = draftSelection.filter((id) => id !== presetId);
  } else {
    draftSelection = [...draftSelection, presetId];
  }
  render();
}

function saveModelSelection(button) {
  return runAction(button, async () => {
    state = await api.saveModelSelection(draftSelection);
    draftSelection = [...state.selectedModelIds];
    render();
    showToast("模型选择已保存，并已更新 Router 配置。");
  });
}

function startCustomModelEdit(presetId, options = {}) {
  const model = modelMap().get(presetId);
  if (!model?.custom) {
    showToast("没有找到这个自定义模型。", "error");
    return;
  }
  if (!options.preserveView) {
    modelPageView = "custom";
  }
  editingCustomPresetId = presetId;
  setValue("#customProviderName", model.providerName || providerName(model.providerId));
  setValue("#customDisplayName", model.displayName || "");
  setValue("#customModelName", model.model || "");
  setValue("#customBaseUrl", model.baseUrl || "");
  setValue("#customKeyUrl", model.keyUrl || "");
  setValue("#customDocsUrl", model.docsUrl || "");
  setValue("#customLogoUrl", model.logoUrl || "");
  setValue("#customApiType", model.api === "responses" ? "responses" : "chat_completions");
  setValue("#customContextWindow", String(model.contextWindow || 258400));
  setValue("#customApiKey", "");
  document.querySelector("#customApiKey").placeholder = state.secretStatus?.[model.keyEnv || model.apiKeyEnv]
    ? "已保存，留空不修改"
    : "sk-...";
  els.customImageInput.checked = modelSupportsImage(model);
  renderCustomFormState();
  if (options.scroll !== false) {
    els.customModelForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function resetCustomModelForm(options = {}) {
  editingCustomPresetId = null;
  els.customModelForm.reset();
  setValue("#customLogoUrl", "");
  setValue("#customContextWindow", "258400");
  document.querySelector("#customApiKey").placeholder = "新服务商请填写；已有 Key 可留空";
  if (!options.preserveView && modelPageView === "custom") {
    modelPageView = "catalog";
  }
  renderCustomFormState();
}

function customModelFormPayload(editingModel = null) {
  if (scopedCustomProviderId && !editingModel) {
    return customModelFromProvider(providerFor(scopedCustomProviderId));
  }
  return {
    presetId: editingCustomPresetId || undefined,
    providerId: editingModel?.providerId,
    providerName: value("#customProviderName"),
    displayName: value("#customDisplayName"),
    model: value("#customModelName"),
    baseUrl: value("#customBaseUrl"),
    keyUrl: value("#customKeyUrl"),
    docsUrl: value("#customDocsUrl"),
    logoUrl: value("#customLogoUrl") || editingModel?.logoUrl || "",
    api: value("#customApiType"),
    keyEnv: editingModel?.keyEnv || editingModel?.apiKeyEnv,
    apiKey: value("#customApiKey"),
    inputModalities: els.customImageInput.checked ? ["text", "image"] : ["text"],
    contextWindow: Number(value("#customContextWindow") || 258400),
  };
}

function customModelFromProvider(provider) {
  if (!provider) {
    throw new Error("没有找到要继承的供应商。");
  }
  const modelName = value("#customModelName");
  return {
    providerId: provider.id,
    providerName: provider.name || provider.id,
    displayName: modelName,
    model: modelName,
    baseUrl: provider.baseUrl || "",
    keyUrl: provider.keyUrl || "",
    docsUrl: provider.docsUrl || "",
    logoUrl: provider.logoUrl || "",
    api: value("#customApiType") || providerApiValue(provider),
    keyEnv: provider.keyEnv || provider.apiKeyEnv || "",
    apiKey: "",
    inputModalities: els.customImageInput.checked ? ["text", "image"] : ["text"],
    contextWindow: Number(value("#customContextWindow") || 258400),
  };
}

function customProviderPayload(includeApiKey = false) {
  const editingModel = editingCustomPresetId ? modelMap().get(editingCustomPresetId) : null;
  if (scopedCustomProviderId && !editingModel) {
    const provider = providerFor(scopedCustomProviderId);
    return {
      providerId: provider?.id || "",
      id: provider?.id || "",
      name: provider?.name || "",
      shortName: provider?.shortName || provider?.name || "",
      baseUrl: provider?.baseUrl || "",
      api: value("#customApiType") || providerApiValue(provider),
      keyEnv: provider?.keyEnv || provider?.apiKeyEnv || "",
      keyUrl: provider?.keyUrl || "",
      docsUrl: provider?.docsUrl || "",
      logoUrl: provider?.logoUrl || "",
      authMode: provider?.authMode || "api_key",
      custom: true,
      apiKey: "",
    };
  }
  const providerName = value("#customProviderName") || editingModel?.providerName || "Custom";
  const providerId = editingModel?.providerId || `custom-${slugifyProviderId(providerName)}`;
  const keyEnv = editingModel?.keyEnv || editingModel?.apiKeyEnv || `${slugifyEnvName(providerName)}_API_KEY`;
  return {
    providerId,
    id: providerId,
    name: providerName,
    shortName: providerName,
    baseUrl: value("#customBaseUrl") || editingModel?.baseUrl || "",
    api: value("#customApiType") || editingModel?.api || "chat_completions",
    keyEnv,
    keyUrl: value("#customKeyUrl") || editingModel?.keyUrl || "",
    docsUrl: value("#customDocsUrl") || editingModel?.docsUrl || "",
    logoUrl: value("#customLogoUrl") || editingModel?.logoUrl || "",
    authMode: "api_key",
    custom: true,
    apiKey: includeApiKey ? value("#customApiKey") : "",
  };
}

function slugifyProviderId(value) {
  return String(value || "custom")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "custom";
}

function slugifyEnvName(value) {
  return String(value || "CUSTOM")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "CUSTOM";
}

function renderCustomFormState() {
  const editing = Boolean(editingCustomPresetId);
  const scoped = Boolean(scopedCustomProviderId) && !editing;
  const provider = scoped ? providerFor(scopedCustomProviderId) : null;
  els.customModelForm.classList.toggle("provider-scoped", scoped);
  document.querySelector("#customModelNameLabel").textContent = scoped ? "模型名称" : "真实模型名";
  els.customFormTitle.textContent = editing
    ? "编辑自定义模型"
    : scoped
      ? `添加 ${provider?.shortName || provider?.name || "供应商"} 自定义模型`
      : "添加自定义模型";
  els.customFormDescription.textContent = editing
    ? "修改后会覆盖当前自定义模型，并保留原来的 API Key 名称。"
    : scoped
      ? `沿用 ${provider?.name || "当前供应商"} 的 Base URL、API Key、文档和图标，只填写要新增的模型。`
      : "用于接入任何 OpenAI-compatible 服务商。显示名给 Codex 看，真实模型名发给服务商。";
  els.customSubmitButton.textContent = editing ? "保存修改" : "添加模型";
  els.cancelCustomEdit.classList.toggle("hidden", !editing && !scoped);
  if (scoped && provider) {
    setValue("#customProviderName", provider.name || provider.id);
    setValue("#customDisplayName", value("#customModelName"));
    setValue("#customBaseUrl", provider.baseUrl || "");
    setValue("#customKeyUrl", provider.keyUrl || "");
    setValue("#customDocsUrl", provider.docsUrl || "");
    setValue("#customLogoUrl", provider.logoUrl || "");
    setValue("#customApiType", providerApiValue(provider));
  }
  renderCustomLogoUploadState();
}

function renderCustomLogoUploadState() {
  const logoUrl = value("#customLogoUrl");
  const preview = document.querySelector("#customLogoPreview");
  const status = document.querySelector("#customLogoStatus");
  if (preview) {
    preview.innerHTML = logoUrl
      ? `<img src="${escapeHtml(logoUrl)}" alt="" loading="lazy" />`
      : `<img src="./assets/providers/default.svg" alt="" loading="lazy" />`;
  }
  if (status) {
    status.textContent = logoUrl ? "已选择本地图标" : "未选择时使用默认 AI 图标";
  }
}

function renderUsage() {
  const summary = state.usageSummary || emptyUsageSummary();
  const current = summary.current || summary;
  const history = summary.history || emptyUsageSummary();
  const events = filterUsageEvents(current.events || state.usageEvents || [], usageRangeDays);
  const ranged = summarizeUsageEvents(events, current);
  updateUsageRangeButtons();
  els.statCalls.textContent = formatNumber(ranged.totalCalls || 0);
  els.statTokens.textContent = formatNumber(ranged.totalTokens || 0);
  els.statPrompt.textContent = formatInputTokens(ranged);
  els.statCache.textContent = formatCacheTokens(ranged);
  els.statCompletion.textContent = formatNumber(ranged.completionTokens || 0);
  if (els.statCost) {
    els.statCost.textContent = usageCostEstimateLabel(state.usageCostEstimate);
  }
  renderUsageChart(ranged.byModel || []);
  renderUsageTableStable(ranged.byModel || [], events, history);
}

function renderUsageBudgetInputs({ keepTarget = true } = {}) {
  if (!els.usageBudgetScope || !els.usageBudgetTarget) {
    return;
  }
  const previousTarget = keepTarget ? els.usageBudgetTarget.value : "";
  const scope = els.usageBudgetScope.value || "global";
  const targets = usageBudgetTargetOptions(scope);
  els.usageBudgetTarget.innerHTML = targets
    .map((target) => `<option value="${escapeHtml(target.value)}">${escapeHtml(target.label)}</option>`)
    .join("");
  const selectedTarget = targets.some((target) => target.value === previousTarget)
    ? previousTarget
    : targets[0]?.value || "";
  els.usageBudgetTarget.value = selectedTarget;
  els.usageBudgetTarget.disabled = scope === "global";
  const budget = usageBudgetForSelection(scope, selectedTarget);
  if (els.usageDailyTokenLimit && document.activeElement !== els.usageDailyTokenLimit) {
    els.usageDailyTokenLimit.value = budget.dailyTokenLimit ? String(budget.dailyTokenLimit) : "";
  }
  if (els.usageDailyCallLimit && document.activeElement !== els.usageDailyCallLimit) {
    els.usageDailyCallLimit.value = budget.dailyCallLimit ? String(budget.dailyCallLimit) : "";
  }
  if (els.usageDailyCostLimit && document.activeElement !== els.usageDailyCostLimit) {
    els.usageDailyCostLimit.value = budget.dailyCostLimit ? String(budget.dailyCostLimit) : "";
  }
  if (els.usageInputCostPerMillion && document.activeElement !== els.usageInputCostPerMillion) {
    els.usageInputCostPerMillion.value = budget.inputCostPerMillion ? String(budget.inputCostPerMillion) : "";
  }
  if (els.usageCacheCostPerMillion && document.activeElement !== els.usageCacheCostPerMillion) {
    els.usageCacheCostPerMillion.value = budget.cacheCostPerMillion ? String(budget.cacheCostPerMillion) : "";
  }
  if (els.usageOutputCostPerMillion && document.activeElement !== els.usageOutputCostPerMillion) {
    els.usageOutputCostPerMillion.value = budget.outputCostPerMillion ? String(budget.outputCostPerMillion) : "";
  }
}

function usageBudgetOptionsFromInputs() {
  const current = cloneUsageBudgets(state?.desktopOptions?.usageBudgets || {});
  const scope = els.usageBudgetScope?.value || "global";
  const target = els.usageBudgetTarget?.value || "";
  const nextBudget = {};
  const dailyTokenLimit = Number(els.usageDailyTokenLimit?.value || 0);
  const dailyCallLimit = Number(els.usageDailyCallLimit?.value || 0);
  const dailyCostLimit = Number(els.usageDailyCostLimit?.value || 0);
  const inputCostPerMillion = Number(els.usageInputCostPerMillion?.value || 0);
  const cacheCostPerMillion = Number(els.usageCacheCostPerMillion?.value || 0);
  const outputCostPerMillion = Number(els.usageOutputCostPerMillion?.value || 0);
  if (Number.isFinite(dailyTokenLimit) && dailyTokenLimit > 0) {
    nextBudget.dailyTokenLimit = Math.floor(dailyTokenLimit);
  }
  if (Number.isFinite(dailyCallLimit) && dailyCallLimit > 0) {
    nextBudget.dailyCallLimit = Math.floor(dailyCallLimit);
  }
  if (Number.isFinite(dailyCostLimit) && dailyCostLimit > 0) {
    nextBudget.dailyCostLimit = dailyCostLimit;
  }
  if (Number.isFinite(inputCostPerMillion) && inputCostPerMillion > 0) {
    nextBudget.inputCostPerMillion = inputCostPerMillion;
  }
  if (Number.isFinite(cacheCostPerMillion) && cacheCostPerMillion > 0) {
    nextBudget.cacheCostPerMillion = cacheCostPerMillion;
  }
  if (Number.isFinite(outputCostPerMillion) && outputCostPerMillion > 0) {
    nextBudget.outputCostPerMillion = outputCostPerMillion;
  }
  applyUsageBudgetSelection(current, scope, target, nextBudget);
  return current;
}

function usageBudgetTargetOptions(scope) {
  if (scope === "route") {
    return (state?.models || []).map((model) => ({
      value: model.id || model.presetId || model.model,
      label: `${model.name || model.id || model.model} · ${model.id || model.model || "-"}`,
    })).filter((item) => item.value);
  }
  if (scope === "provider") {
    const providers = new Map();
    for (const model of state?.models || []) {
      const provider = model.provider || model.providerId || model.provider_id || "";
      if (provider) {
        providers.set(provider, providerName(provider));
      }
    }
    return [...providers.entries()].map(([value, label]) => ({ value, label }));
  }
  return [{ value: "global", label: "全部模型" }];
}

function usageBudgetForSelection(scope, target) {
  const budgets = state?.desktopOptions?.usageBudgets || {};
  if (scope === "route") {
    return budgets.routes?.[target] || {};
  }
  if (scope === "provider") {
    return budgets.providers?.[target] || {};
  }
  return budgets.global || {};
}

function cloneUsageBudgets(input = {}) {
  return {
    ...(input || {}),
    global: { ...(input.global || {}) },
    routes: { ...(input.routes || {}) },
    providers: { ...(input.providers || {}) },
  };
}

function applyUsageBudgetSelection(budgets, scope, target, nextBudget) {
  const hasBudget = Object.keys(nextBudget).length > 0;
  if (scope === "route" && target) {
    budgets.routes = { ...(budgets.routes || {}) };
    if (hasBudget) {
      budgets.routes[target] = nextBudget;
    } else {
      delete budgets.routes[target];
    }
  } else if (scope === "provider" && target) {
    budgets.providers = { ...(budgets.providers || {}) };
    if (hasBudget) {
      budgets.providers[target] = nextBudget;
    } else {
      delete budgets.providers[target];
    }
  } else if (scope === "global" && hasBudget) {
    budgets.global = nextBudget;
  } else if (scope === "global") {
    delete budgets.global;
  }
  if (!Object.keys(budgets.routes || {}).length) {
    delete budgets.routes;
  }
  if (!Object.keys(budgets.providers || {}).length) {
    delete budgets.providers;
  }
  if (budgets.global && !Object.keys(budgets.global).length) {
    delete budgets.global;
  }
}

function renderUsageBudgetAlerts() {
  if (!els.usageBudgetAlerts) {
    return;
  }
  const alerts = Array.isArray(state?.usageBudgetAlerts) ? state.usageBudgetAlerts : [];
  els.usageBudgetAlerts.classList.toggle("hidden", !alerts.length);
  if (!alerts.length) {
    els.usageBudgetAlerts.innerHTML = "";
    return;
  }
  els.usageBudgetAlerts.innerHTML = alerts
    .slice(0, 5)
    .map((alert) => `
      <div class="usage-budget-alert ${escapeHtml(alert.status || "warning")}">
        <strong>${escapeHtml(usageBudgetScopeLabel(alert))}</strong>
        <span>${escapeHtml(alert.message || "")}</span>
      </div>
    `)
    .join("");
}

function renderUsageCostEstimate() {
  if (!els.usageCostEstimate) {
    return;
  }
  const estimate = state?.usageCostEstimate || emptyUsageCostEstimate();
  els.usageCostEstimate.classList.toggle("hidden", !estimate.hasRates);
  if (!estimate.hasRates) {
    els.usageCostEstimate.innerHTML = "";
    return;
  }
  const breakdown = [
    `输入 ${formatCostValue(estimate.inputCost)}`,
    `缓存 ${formatCostValue(estimate.cacheCost)}`,
    `输出 ${formatCostValue(estimate.outputCost)}`,
  ];
  const topScopes = [
    ...(Array.isArray(estimate.routes) ? estimate.routes : []).slice(0, 3),
    ...(Array.isArray(estimate.providers) ? estimate.providers : []).slice(0, 3),
  ].slice(0, 4);
  els.usageCostEstimate.innerHTML = `
    <strong>今日预估费用：${escapeHtml(formatCostValue(estimate.totalCost))}</strong>
    <span>按你在上面填写的单价估算；设置每日上限后，Router 会在达到上限时本地停止后续请求。</span>
    <div class="usage-cost-breakdown">
      ${breakdown.map((item) => `<em>${escapeHtml(item)}</em>`).join("")}
      ${topScopes.map((item) => `<em>${escapeHtml(usageCostScopeLabel(item))} ${escapeHtml(formatCostValue(item.totalCost))}</em>`).join("")}
    </div>
  `;
}

function usageBudgetScopeLabel(alert = {}) {
  if (alert.scope === "route") {
    return `模型预算：${alert.label || "-"}`;
  }
  if (alert.scope === "provider") {
    return `供应商预算：${alert.label || "-"}`;
  }
  return "全局预算";
}

function usageCostScopeLabel(item = {}) {
  if (item.scope === "route") {
    return `模型 ${displayRoute(item.label)}`;
  }
  if (item.scope === "provider") {
    return `供应商 ${providerName(item.label)}`;
  }
  return item.label || "全部模型";
}

function updateUsageRangeButtons() {
  document.querySelectorAll("[data-usage-range]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.usageRange) === Number(usageRangeDays));
  });
}

function filterUsageEvents(events, days) {
  const list = Array.isArray(events) ? events : [];
  const rangeDays = Number(days || 0);
  if (!rangeDays || rangeDays <= 0) {
    return list;
  }
  const cutoff = Date.now() - rangeDays * 24 * 60 * 60 * 1000;
  return list.filter((event) => {
    const value = event?.finishedAt || event?.startedAt || event?.timestamp || event?.time;
    const time = value ? new Date(value).getTime() : 0;
    return Number.isFinite(time) && time >= cutoff;
  });
}

function summarizeUsageEvents(events, fallback = emptyUsageSummary()) {
  if (!Array.isArray(events) || !events.length) {
    return {
      ...fallback,
      byModel: fallback.byModel || [],
      events: [],
    };
  }
  const byModel = new Map();
  const total = {
    totalCalls: 0,
    totalTokens: 0,
    promptTokens: 0,
    freshPromptTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    completionTokens: 0,
    statusCounts: {},
    byModel: [],
    events,
    latest: events[0] || null,
  };
  for (const event of events) {
    const promptTokens = Number(event.promptTokens || 0);
    const freshPromptTokens = Number(event.freshPromptTokens ?? promptTokens);
    const cacheReadTokens = Number(event.cacheReadTokens || 0);
    const cacheCreationTokens = Number(event.cacheCreationTokens || 0);
    const completionTokens = Number(event.completionTokens || 0);
    const totalTokens = Number(event.totalTokens || promptTokens + completionTokens);
    const status = event.status || "-";
    total.totalCalls += 1;
    total.promptTokens += promptTokens;
    total.freshPromptTokens += freshPromptTokens;
    total.cacheReadTokens += cacheReadTokens;
    total.cacheCreationTokens += cacheCreationTokens;
    total.completionTokens += completionTokens;
    total.totalTokens += totalTokens;
    total.statusCounts[status] = (total.statusCounts[status] || 0) + 1;

    const key = [
      event.route || "",
      event.upstreamModel || "",
      event.api || "",
      event.isCurrentRoute === false ? "history" : "current",
    ].join("\u0000");
    if (!byModel.has(key)) {
      byModel.set(key, {
        route: event.route,
        upstreamModel: event.upstreamModel,
        api: event.api,
        calls: 0,
        promptTokens: 0,
        freshPromptTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        statusCounts: {},
        errors: 0,
        fastZeroTokenErrors: 0,
        lastStatus: "-",
        lastError: "",
        lastAt: null,
        isCurrentRoute: event.isCurrentRoute,
      });
    }
    const row = byModel.get(key);
    row.calls += 1;
    row.promptTokens += promptTokens;
    row.freshPromptTokens += freshPromptTokens;
    row.cacheReadTokens += cacheReadTokens;
    row.cacheCreationTokens += cacheCreationTokens;
    row.completionTokens += completionTokens;
    row.totalTokens += totalTokens;
    row.statusCounts[status] = (row.statusCounts[status] || 0) + 1;
    row.lastStatus = status;
    row.lastError = event.error || row.lastError;
    row.lastAt = event.finishedAt || event.startedAt || row.lastAt;
    if (Number(status) >= 400) {
      row.errors += 1;
      if (totalTokens === 0 && Number(event.durationMs || 0) < 1000) {
        row.fastZeroTokenErrors += 1;
      }
    }
  }
  total.byModel = [...byModel.values()].sort((left, right) => {
    const leftTime = new Date(left.lastAt || 0).getTime();
    const rightTime = new Date(right.lastAt || 0).getTime();
    return rightTime - leftTime;
  });
  return total;
}

function renderOverviewUsage() {
  const latest = state.usageSummary?.current?.latest || state.usageSummary?.latest;
  if (!latest) {
    els.latestUsage.textContent = "暂无";
    return;
  }
  const route = latest.route || latest.codexModel;
  const upstream = latest.upstreamModel ? ` -> ${latest.upstreamModel}` : "";
  const provider = routeProviderName(route);
  const api = latest.api ? ` · ${latest.api}` : "";
  els.latestUsage.textContent = `${displayRoute(route)}${upstream} · 上游 ${provider}${api} · ${latest.status || "unknown"} · ${formatNumber(latest.totalTokens || 0)} token`;
}

function renderUsageChart(rows) {
  if (!rows.length) {
    els.usageChart.innerHTML = `<div class="empty-state">还没有调用记录。启动 Router 后，在 Codex 里对话一次，这里会显示每个模型的调用量。</div>`;
    return;
  }
  const maxTokens = Math.max(...rows.map((row) => row.totalTokens || 0));
  const maxCalls = Math.max(...rows.map((row) => row.calls || 0), 1);
  els.usageChart.innerHTML = rows
    .map((row) => {
      const value = maxTokens > 0 ? row.totalTokens : row.calls;
      const max = maxTokens > 0 ? maxTokens : maxCalls;
      const width = Math.max(5, Math.ceil(((value / max) * 100) / 5) * 5);
      const label = maxTokens > 0 ? `${formatNumber(row.totalTokens)} token` : `${formatNumber(row.calls)} 次`;
      const stateLabel = usageRouteState(row);
      return `
        <div class="usage-bar">
          <div class="usage-bar-head">
            <strong>${escapeHtml(displayRoute(row.route))}</strong>
            <span>${escapeHtml(row.upstreamModel || "-")}${stateLabel ? ` · ${stateLabel}` : ""} · ${label}</span>
          </div>
          <div class="bar-track"><span class="w-${width}"></span></div>
        </div>
      `;
    })
    .join("");
}

function usageRouteState(row) {
  if (row?.isCurrentRoute === true) {
    return "当前配置";
    return "当前";
  }
  if (row?.isCurrentRoute === false) {
    return "历史";
  }
  return "";
}

function usageStatusText(row) {
  const stateLabel = usageRouteState(row);
  const status = usageErrorStatusText(row);
  return stateLabel ? `${stateLabel} · ${status}` : String(status);
}

function usageErrorStatusText(row) {
  if (!row?.errors) {
    return row?.lastStatus || "-";
  }
  const fastZero = Number(row.fastZeroTokenErrors || 0);
  const errorDetail = row.lastError || row.lastStatus || "";
  if (fastZero > 0 && fastZero === Number(row.errors || 0)) {
    return `${row.errors} 次 0 token 快速失败：${errorDetail}`;
  }
  if (fastZero > 0) {
    return `${row.errors} 错误（${fastZero} 次 0 token 快速失败）：${errorDetail}`;
  }
  return `${row.errors} 错误：${errorDetail}`;
}

function usageEventStatusText(event) {
  if (!(event?.status && event.status >= 400)) {
    return event?.status || "-";
  }
  const fastZero =
    Number(event.totalTokens || 0) === 0 &&
    Number.isFinite(Number(event.durationMs)) &&
    Number(event.durationMs) < 1000;
  const prefix = fastZero ? `${event.status} 0 token 快速失败` : String(event.status);
  return `${prefix}${event.error ? `：${event.error}` : ""}`;
}

function usageRequestSourceLabel(event = {}) {
  const requested = String(event.requestedModel || event.codexModel || "").trim();
  if (event.routeSource === "auxiliary" || event.requestKind === "codex_auxiliary") {
    return `ChatGPT 辅助任务${requested ? `（入口 ${requested}）` : ""}`;
  }
  if (event.routeSource === "automatic") {
    return `自动路由${event.routeReason ? `（${event.routeReason}）` : ""}`;
  }
  return `会话直接选择${requested ? `（入口 ${requested}）` : ""}`;
}

function renderUsageTable(rows, events) {
  const modelRows = rows.length
    ? rows
        .map(
          (row) => `
            <div class="usage-row">
              <span>${escapeHtml(displayRoute(row.route))}</span>
              <span>${escapeHtml(row.upstreamModel || "-")}</span>
              <span>${escapeHtml(row.api || "-")}</span>
              <span>${formatNumber(row.calls)}</span>
              <span>${formatInputTokens(row)}</span>
              <span>${formatCacheTokens(row)}</span>
              <span>${formatNumber(row.completionTokens)}</span>
              <span>${formatNumber(row.totalTokens)}</span>
              <span>${escapeHtml(usageStatusText(row))}</span>
              <span>${formatTime(row.lastAt)}</span>
            </div>
          `,
        )
        .join("")
    : `<div class="empty-state">暂无模型汇总。</div>`;
  const eventRows = events.length
    ? events
        .slice(0, 40)
        .map(
          (event) => `
            <div class="usage-row recent">
              <span>${escapeHtml(displayRoute(event.route))}</span>
              <span>${escapeHtml(event.upstreamModel || "-")}</span>
              <span>${escapeHtml(event.api || "-")}</span>
              <span>${escapeHtml(usageEventStatusText(event))}</span>
              <span>${formatInputTokens(event)}</span>
              <span>${formatCacheTokens(event)}</span>
              <span>${formatNumber(event.completionTokens)}</span>
              <span>${formatNumber(event.totalTokens)}</span>
              <span>${formatDuration(event.durationMs)}</span>
              <span>${formatTime(event.finishedAt || event.startedAt)}</span>
            </div>
          `,
        )
        .join("")
    : `<div class="empty-state">暂无明细记录。</div>`;
  els.usageTable.innerHTML = `
    <h3>按模型汇总</h3>
    <div class="usage-grid header">
      <span>当前显示名</span><span>实际上游模型</span><span>接口</span><span>次数</span><span>输入</span><span>缓存</span><span>输出</span><span>总量</span><span>状态</span><span>最近时间</span>
    </div>
    <div class="usage-grid">${modelRows}</div>
    <h3>最近请求</h3>
    <div class="usage-grid header">
      <span>当前显示名</span><span>实际上游模型</span><span>接口</span><span>状态</span><span>输入</span><span>缓存</span><span>输出</span><span>总量</span><span>耗时</span><span>时间</span>
    </div>
    <div class="usage-grid">${eventRows}</div>
  `;
}

function usageGridTemplate() {
  return usageColumnWidths.map((width) => `${width}px`).join(" ");
}

function usageGridMinWidth() {
  return usageColumnWidths.reduce((sum, width) => sum + Number(width || 0), 0);
}

function usageHeaderCell(label, index) {
  return `
    <span class="usage-header-cell">
      ${escapeHtml(label)}
      <button class="usage-resizer" type="button" data-usage-col="${index}" aria-label="调整列宽"></button>
    </span>
  `;
}

function bindUsageColumnResizers() {
  els.usageTable.querySelectorAll(".usage-resizer").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      usageResizeState = {
        column: Number(button.dataset.usageCol),
        startX: event.clientX,
        startWidth: usageColumnWidths[Number(button.dataset.usageCol)] || 112,
      };
      document.body.classList.add("resizing-usage-column");
      window.addEventListener("pointermove", resizeUsageColumn);
      window.addEventListener("pointerup", stopUsageColumnResize, { once: true });
    });
  });
}

function resizeUsageColumn(event) {
  if (!usageResizeState) {
    return;
  }
  const next = Math.max(72, usageResizeState.startWidth + event.clientX - usageResizeState.startX);
  usageColumnWidths[usageResizeState.column] = next;
  applyUsageColumnWidths();
}

function stopUsageColumnResize() {
  usageResizeState = null;
  document.body.classList.remove("resizing-usage-column");
  window.removeEventListener("pointermove", resizeUsageColumn);
}

function applyUsageColumnWidths() {
  const rules = ensureUsageColumnCssRules();
  if (!rules) {
    return;
  }
  rules.grid.style.minWidth = `${usageGridMinWidth()}px`;
  rules.row.style.gridTemplateColumns = usageGridTemplate();
}

function ensureUsageColumnCssRules() {
  if (usageColumnCssRules?.grid && usageColumnCssRules?.row) {
    return usageColumnCssRules;
  }
  const styles = Array.from(document.styleSheets);
  const sheet = styles.find((item) => {
    try {
      return String(item.href || "").endsWith("/styles.css") || String(item.href || "").endsWith("\\styles.css");
    } catch {
      return false;
    }
  });
  if (!sheet) {
    return null;
  }
  try {
    const gridIndex = sheet.cssRules.length;
    sheet.insertRule(".usage-table-block .usage-grid.usage-grid-resizable {}", gridIndex);
    const rowIndex = sheet.cssRules.length;
    sheet.insertRule(".usage-table-block .usage-row.usage-grid-resizable {}", rowIndex);
    usageColumnCssRules = {
      grid: sheet.cssRules[gridIndex],
      row: sheet.cssRules[rowIndex],
    };
  } catch (error) {
    console.warn("Unable to install usage column CSS rules", error);
    return null;
  }
  return usageColumnCssRules;
}

function renderUsageTableStable(rows, events, history = {}) {
  const historyNotice = "这里展示的是历史请求，不代表模型正在后台运行。辅助任务模型只处理 ChatGPT 内部辅助请求；普通会话仍按会话实际选择的模型记录。";
  const modelRows = rows.length
    ? rows
        .map(
          (row) => `
            <div class="usage-row usage-grid-resizable">
              <span>${escapeHtml(displayRoute(row.route))}</span>
              <span>${escapeHtml(row.upstreamModel || "-")}</span>
              <span>${escapeHtml(row.api || "-")}</span>
              <span>${formatNumber(row.calls)}</span>
              <span>${formatInputTokens(row)}</span>
              <span>${formatCacheTokens(row)}</span>
              <span>${formatNumber(row.completionTokens)}</span>
              <span>${formatNumber(row.totalTokens)}</span>
              <span>${escapeHtml(usageStatusText(row))}</span>
              <span>${formatTime(row.lastAt)}</span>
            </div>
          `,
        )
        .join("")
    : `<div class="empty-state">暂无模型汇总。</div>`;
  const eventRows = events.length
    ? events
        .slice(0, 40)
        .map(
          (event, index) => `
            <div class="usage-row usage-grid-resizable recent">
              <span>${escapeHtml(displayRoute(event.route))}</span>
              <span>${escapeHtml(event.upstreamModel || "-")}</span>
              <span>${escapeHtml(event.api || "-")}</span>
              <span class="usage-status-cell">
                <button class="mini-link" type="button" data-request-detail="${escapeHtml(event.requestId || event.id || index)}">详情</button>
                ${escapeHtml(usageEventStatusText(event))} · ${escapeHtml(usageRequestSourceLabel(event))}
              </span>
              <span>${formatInputTokens(event)}</span>
              <span>${formatCacheTokens(event)}</span>
              <span>${formatNumber(event.completionTokens)}</span>
              <span>${formatNumber(event.totalTokens)}</span>
              <span>${formatDuration(event.durationMs)}</span>
              <span>${formatTime(event.finishedAt || event.startedAt)}</span>
            </div>
          `,
        )
        .join("")
    : `<div class="empty-state">暂无明细记录。</div>`;
  const modelHeaders = ["当前显示名", "实际上游模型", "接口", "次数", "输入", "缓存", "输出", "总量", "状态", "最近时间"];
  const eventHeaders = ["当前显示名", "实际上游模型", "接口", "状态", "输入", "缓存", "输出", "总量", "耗时", "时间"];
  els.usageTable.innerHTML = `
    <p class="section-note">${escapeHtml(historyNotice)}</p>
    <h3>按模型汇总</h3>
    <div class="usage-table-block">
      <div class="usage-grid usage-grid-resizable">
        <div class="usage-row usage-grid-resizable header">
          ${modelHeaders.map((label, index) => usageHeaderCell(label, index)).join("")}
        </div>
        ${modelRows}
      </div>
    </div>
    <h3>最近请求</h3>
    <div class="usage-table-block">
      <div class="usage-grid usage-grid-resizable">
        <div class="usage-row usage-grid-resizable header">
          ${eventHeaders.map((label, index) => usageHeaderCell(label, index)).join("")}
        </div>
        ${eventRows}
      </div>
    </div>
  `;
  applyUsageColumnWidths();
  bindUsageColumnResizers();
  bindRequestDetailButtons(events);
}

function bindRequestDetailButtons(events = []) {
  const eventMap = new Map(
    (Array.isArray(events) ? events : []).map((event, index) => [
      String(event.requestId || event.id || index),
      event,
    ]),
  );
  els.usageTable.querySelectorAll("[data-request-detail]").forEach((button) => {
    button.addEventListener("click", () => showRequestDetail(eventMap.get(button.dataset.requestDetail)));
  });
}

function showRequestDetail(event) {
  if (!(els.requestDetailDialog && els.requestDetailBody)) {
    return;
  }
  if (!event) {
    showToast("没有找到这条请求详情。", "error");
    return;
  }
  const upstreamUrl = event.upstreamUrl || event.baseUrl || event.url || "";
  const smartExclusionText = smartRouteExclusionText(event);
  const rows = [
    ["请求来源", usageRequestSourceLabel(event)],
    ["当前显示名", displayRoute(event.route)],
    ["真实模型", event.upstreamModel || event.model || "-"],
    ["接口", event.api || "-"],
    ["上游 URL", upstreamUrl || "-"],
    ["状态", usageEventStatusText(event)],
    ["耗时", formatDuration(event.durationMs)],
    ["Token", `${formatNumber(event.totalTokens)} 总 / ${formatNumber(event.promptTokens || 0)} 输入 / ${formatNumber(event.completionTokens || 0)} 输出`],
    ["开始时间", formatTime(event.startedAt)],
    ["结束时间", formatTime(event.finishedAt)],
    ["错误", event.error || event.errorType || "-"],
    ...(smartExclusionText ? [["智能路由跳过", smartExclusionText]] : []),
  ];
  els.requestDetailBody.innerHTML = `
    <div class="request-detail-grid">
      ${rows.map(([label, value]) => requestDetailItem(label, redactDetail(value))).join("")}
    </div>
  `;
  els.requestDetailDialog.classList.remove("hidden");
  els.requestDetailDialog.setAttribute("aria-hidden", "false");
}

function smartRouteExclusionText(event = {}) {
  const exclusions = Array.isArray(event.smartRouteExclusions)
    ? event.smartRouteExclusions
    : [];
  if (!exclusions.length) {
    return "";
  }
  return exclusions
    .map((item) => {
      const phase = smartRouteExclusionPhaseLabel(item.phase);
      const reasons = Array.isArray(item.reasons)
        ? item.reasons.map(smartRouteExclusionReasonLabel).filter(Boolean).join("、")
        : "";
      return `${phase}${item.route || "-"}${reasons ? `（${reasons}）` : ""}`;
    })
    .join("；");
}

function smartRouteExclusionPhaseLabel(phase) {
  if (phase === "auto-select") {
    return "自动选模型：";
  }
  if (phase === "failover") {
    return "失败自动切换：";
  }
  return "智能路由：";
}

function smartRouteExclusionReasonLabel(reason) {
  if (reason === "budget") {
    return "预算已达上限";
  }
  if (reason === "health") {
    return "限流或降级";
  }
  return reason || "";
}

function showResourceDetail(entry = {}) {
  if (!(els.resourceDetailDialog && els.resourceDetailBody)) {
    return;
  }
  const item = entry?.item || null;
  if (!item) {
    showToast("没有找到这条资源详情。", "error");
    return;
  }
  const diagnostic = resourceDiagnostic(item);
  const update = resourceUpdateNote(item);
  const managementNote = resourceManagementNote(item);
  const counted = resourceIsCurrentResource(item, diagnostic?.status || "info", entry.key || "resource");
  const rows = [
    ["资源", entry.label || resourceLabel(item)],
    ["分组", resourceGroupLabel(entry.key)],
    ["计入当前可用", counted ? "是" : "否"],
    ["用途说明", resourcePurpose(item)],
    ["用途", resourceDescription(item)],
    ...resourceDetails(item).map((detail) => [detail.label, detail.value]),
    ["来源", resourceSourceLabel(item.source || item.pluginSource || "") || "-"],
    ["可用性", resourceAvailabilityLabel(item.availability) || item.availability || "-"],
    ["启用状态", item.enabled === false ? "未启用" : item.enabled === true ? "已启用" : "-"],
    ["版本", item.version || "-"],
    ["诊断", diagnostic ? `${diagnostic.label}${diagnostic.detail ? ` - ${diagnostic.detail}` : ""}` : "-"],
    ["管理边界", managementNote || "-"],
    ["更新方式", update ? `${update.label}${update.detail ? ` - ${update.detail}` : ""}` : "-"],
    ["路径", item.path || "-"],
    ["命令", item.command || "-"],
    ["配置表", item.tableName || "-"],
    ["插件", item.pluginId || item.id || "-"],
  ].filter(([, value]) => String(value || "").trim() && String(value || "").trim() !== "-");
  els.resourceDetailBody.innerHTML = `
    <div class="request-detail-grid">
      ${rows.map(([label, value]) => requestDetailItem(label, redactDetail(value))).join("")}
    </div>
  `;
  els.resourceDetailDialog.classList.remove("hidden");
  els.resourceDetailDialog.setAttribute("aria-hidden", "false");
}

function hideResourceDetail() {
  els.resourceDetailDialog?.classList.add("hidden");
  els.resourceDetailDialog?.setAttribute("aria-hidden", "true");
}

function hideRequestDetail() {
  els.requestDetailDialog?.classList.add("hidden");
  els.requestDetailDialog?.setAttribute("aria-hidden", "true");
}

function requestDetailItem(label, value) {
  return `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "-")}</strong>
    </article>
  `;
}

function redactDetail(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak)-[A-Za-z0-9._-]{6,}\b/gi, (match) => {
      const prefix = match.slice(0, 2).toLowerCase();
      return `${prefix}-[REDACTED]`;
    })
    .replace(/<\s*(ak)-[A-Za-z0-9._-]{6,}\s*>/gi, "<ak-[REDACTED]>")
    .replace(/\b(?:org|proj)-[A-Za-z0-9._-]{8,}\b/gi, (match) => {
      const prefix = match.split("-")[0].toLowerCase();
      return `${prefix}-[REDACTED]`;
    })
    .replace(/([?&](?:api[_-]?key|key|token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/:\/\/([^:/\s]+):([^@\s]+)@/g, "://$1:[REDACTED]@");
}
async function runAction(button, fn) {
  if (stateUnavailableWritesLocked() && !stateUnavailableControlIsReadOnly(button)) {
    showToast(STATE_UNAVAILABLE_WRITE_MESSAGE, "error");
    return;
  }
  try {
    if (button) {
      button.disabled = true;
      button.classList.add("loading");
    }
    await fn();
  } catch (error) {
    const message = error?.message || String(error);
    showToast(message, "error");
    console.error(error);
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove("loading");
    }
  }
}

function bindFolderButton(selector, target) {
  const button = document.querySelector(selector);
  if (!button) {
    return;
  }
  button.addEventListener("click", () =>
    runAction(button, async () => {
      const result = await api.openFolder(target);
      if (!result?.ok) {
        throw new Error(result?.message || "打开目录失败。");
      }
    }),
  );
}

function keySummaryInfo() {
  const diagnostics = state.diagnostics;
  if (diagnostics) {
    const invalidBaseUrls = diagnostics.invalidBaseUrls || [];
    const missingApiKeys = diagnostics.missingApiKeys || [];
    if (invalidBaseUrls.length) {
      return {
        needed: diagnostics.apiKeyRoutes || 0,
        saved: diagnostics.savedApiKeyRoutes || 0,
        text: `发现 ${invalidBaseUrls.length} 个地址错误`,
        detail: invalidBaseUrls
          .map((item) => `${item.displayName || item.id}: ${item.baseUrl || "Base URL 为空"}`)
          .join("；"),
      };
    }
    if (missingApiKeys.length) {
      return {
        needed: diagnostics.apiKeyRoutes || 0,
        saved: diagnostics.savedApiKeyRoutes || 0,
        text: `还缺 ${missingApiKeys.length} 个 API Key`,
        detail: missingApiKeys
          .map((item) => `${item.displayName || item.id}: ${item.apiKeyEnv || "API Key"}`)
          .join("；"),
      };
    }
    if (!diagnostics.apiKeyRoutes) {
      return {
        needed: 0,
        saved: 0,
        text: "当前选择无需 API Key",
        detail: "GPT 订阅模型会使用 Codex/OpenAI 登录态。",
      };
    }
    return {
      needed: diagnostics.apiKeyRoutes,
      saved: diagnostics.savedApiKeyRoutes,
      text: "所需 API Key 已全部保存",
      detail: `已选 ${diagnostics.apiKeyRoutes} 个 API 模型，密钥已准备好。`,
    };
  }

  const needed = new Set();
  const modelsById = modelMap();
  for (const id of draftSelection) {
    const model = modelsById.get(id);
    const provider = providerFor(model?.providerId);
    if (model?.authMode === "api_key" && (model.apiKeyEnv || model.keyEnv || provider?.keyEnv)) {
      needed.add(model.apiKeyEnv || model.keyEnv || provider.keyEnv);
    }
  }
  const saved = [...needed].filter((key) => state.secretStatus?.[key]).length;
  const missing = needed.size - saved;
  const text = needed.size === 0
    ? "当前选择无需 API Key"
    : missing === 0
      ? "所需 API Key 已全部保存"
      : `还缺 ${missing} 个 API Key`;
  return {
    needed: needed.size,
    saved,
    text,
    detail:
      needed.size === 0
        ? "GPT 订阅模型会使用 Codex/OpenAI 登录态。"
        : "只看当前模型栏里 DeepSeek、Kimi 等 API 模型需要的密钥。",
  };
}

function renderLogs(logs) {
  els.logOutput.textContent = logs.length
    ? logs.join("\n")
    : "暂无日志。启动 Router 或点击操作按钮后，这里会显示执行结果。";
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

function showVvipDialog(featureName) {
  const feature = String(featureName || "神秘功能").trim() || "神秘功能";
  const prank = vvipPrankFor(feature);
  els.vvipFeatureName.textContent = feature;
  els.vvipDialogMessage.textContent = prank.message;
  els.vvipDialogNote.textContent = prank.note;
  els.vvipDialog.classList.remove("hidden");
  els.vvipDialog.setAttribute("aria-hidden", "false");
  els.closeVvipDialog?.focus();
}

function vvipPrankFor(featureName) {
  const [note, message] = VVIP_PRANK_MESSAGES.get(featureName) || VVIP_FALLBACK_PRANK;
  return { message, note };
}

function hideVvipDialog() {
  els.vvipDialog?.classList.add("hidden");
  els.vvipDialog?.setAttribute("aria-hidden", "true");
}

function showUpdateDialog(updatePlan) {
  return new Promise((resolve) => {
    const installerUpdate = updatePlan.asset?.kind === "installer";
    els.updateDialogVersion.textContent = `v${updatePlan.latestVersion || ""}`;
    els.updateDialogMessage.textContent =
      "下载完成后会自动启动安装或替换流程。";
    if (!installerUpdate) {
      els.updateDialogMessage.textContent =
        "下载完成后会自动关闭旧版、替换文件并打开新版。";
    }
    if (installerUpdate) {
      els.updateDialogMessage.textContent =
        "下载完成后会打开安装器；安装窗口可选择安装目录，默认创建桌面图标。当前窗口会退出，安装完成后会启动新版，并清理旧版和安装包。";
    }
    els.updateDialogAsset.textContent = updatePlan.asset
      ? `${updatePlan.asset.name} · ${formatBytes(updatePlan.asset.size)}`
      : "未读取到更新包信息";
    setUpdateDialogBusy(false);
    resetUpdateProgress();
    els.updateDialog.classList.remove("hidden");
    els.updateDialog.setAttribute("aria-hidden", "false");
    els.confirmUpdate.focus();

    const finish = (accepted) => {
      els.confirmUpdate.removeEventListener("click", accept);
      els.cancelUpdate.removeEventListener("click", cancel);
      els.updateDialog.removeEventListener("click", backdropCancel);
      document.removeEventListener("keydown", escapeCancel);
      if (!accepted) {
        hideUpdateDialog();
      }
      resolve(accepted);
    };
    const accept = () => finish(true);
    const cancel = () => finish(false);
    const backdropCancel = (event) => {
      if (event.target === els.updateDialog) {
        finish(false);
      }
    };
    const escapeCancel = (event) => {
      if (event.key === "Escape") {
        finish(false);
      }
    };

    els.confirmUpdate.addEventListener("click", accept);
    els.cancelUpdate.addEventListener("click", cancel);
    els.updateDialog.addEventListener("click", backdropCancel);
    document.addEventListener("keydown", escapeCancel);
  });
}

function hideUpdateDialog() {
  els.updateDialog.classList.add("hidden");
  els.updateDialog.setAttribute("aria-hidden", "true");
}

function setUpdateDialogBusy(isBusy) {
  els.updateDialog.classList.toggle("is-busy", Boolean(isBusy));
  els.confirmUpdate.disabled = Boolean(isBusy);
  els.cancelUpdate.disabled = Boolean(isBusy);
  els.confirmUpdate.textContent = isBusy ? "下载中..." : "下载并安装";
}

function resetUpdateProgress() {
  els.updateProgress.classList.add("hidden");
  els.updateProgressTrack.classList.remove("indeterminate");
  els.updateProgressText.textContent = "等待下载";
  els.updateProgressPercent.textContent = "0%";
  els.updateProgressBar.style.width = "0%";
}

function renderUpdateProgress(progress = {}) {
  els.updateProgress.classList.remove("hidden");
  const downloadedBytes = Number(progress.downloadedBytes || 0);
  const totalBytes = Number(progress.totalBytes || 0);
  const percent = Number.isFinite(Number(progress.percent))
    ? Math.max(0, Math.min(100, Math.floor(Number(progress.percent))))
    : totalBytes > 0
      ? Math.max(0, Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100)))
      : 0;
  const hasKnownSize = totalBytes > 0;
  const bytesPerSecond = Number(progress.bytesPerSecond || 0);
  const isIndeterminate = !hasKnownSize && progress.phase !== "error" && progress.phase !== "ready";
  els.updateProgressTrack.classList.toggle("indeterminate", isIndeterminate);
  els.updateProgressBar.style.width = isIndeterminate ? "45%" : `${percent}%`;
  els.updateProgressPercent.textContent = isIndeterminate ? "计算中" : `${percent}%`;
  els.updateProgressText.textContent = progress.message || updateProgressText(progress.phase, {
    downloadedBytes,
    totalBytes,
    percent,
    bytesPerSecond,
  });
}

function updateProgressText(phase, details) {
  if (phase === "checking") {
    return "正在确认最新版本...";
  }
  if (phase === "downloading") {
    const speedText = details.bytesPerSecond > 0 ? ` · ${formatBytes(details.bytesPerSecond)}/s` : "";
    return details.totalBytes > 0
      ? `正在下载 ${formatBytes(details.downloadedBytes)} / ${formatBytes(details.totalBytes)}${speedText}`
      : `正在下载新版...${speedText}`;
  }
  if (phase === "ready") {
    return "下载完成，正在继续更新流程。";
  }
  if (phase === "launching") {
    return "下载完成，正在启动安装器...";
  }
  if (phase === "restarting") {
    return "下载完成，正在关闭旧版并打开新版...";
  }
  if (phase === "error") {
    return "更新失败，请稍后重试。";
  }
  return "准备更新...";
}

function showToast(message, type = "success") {
  els.toast.textContent = message;
  els.toast.className = `toast ${type}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.classList.add("hidden");
  }, 3600);
}

function emptyUsageSummary() {
  return {
    totalCalls: 0,
    totalTokens: 0,
    promptTokens: 0,
    freshPromptTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    completionTokens: 0,
    statusCounts: {},
    byModel: [],
    latest: null,
    current: {
      totalCalls: 0,
      totalTokens: 0,
      promptTokens: 0,
      freshPromptTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      completionTokens: 0,
      statusCounts: {},
      byModel: [],
      events: [],
      latest: null,
    },
    history: {
      totalCalls: 0,
      totalTokens: 0,
      promptTokens: 0,
      freshPromptTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      completionTokens: 0,
      statusCounts: {},
      byModel: [],
      events: [],
      latest: null,
    },
  };
}

function emptyUsageCostEstimate() {
  return {
    hasRates: false,
    calls: 0,
    tokens: 0,
    inputCost: 0,
    cacheCost: 0,
    outputCost: 0,
    totalCost: 0,
    global: null,
    routes: [],
    providers: [],
  };
}

function groupByProvider(models) {
  const groups = new Map();
  for (const model of models) {
    if (!groups.has(model.providerId)) {
      groups.set(model.providerId, []);
    }
    groups.get(model.providerId).push(model);
  }
  return [...groups.entries()];
}

function providerModelDirectoryInfo(providerId) {
  const entry = state.modelDirectory?.providers?.[providerId];
  if (!entry) {
    return "模型目录：离线 preset，可手动刷新";
  }
  const age = modelDirectoryAgeLabel(entry.fetchedAt);
  const stale = modelDirectoryIsStale(entry.fetchedAt);
  return `模型目录：${entry.models?.length || 0} 个 · ${age}${stale ? " · 可能过期" : ""}`;
}

function modelDirectoryAgeLabel(value) {
  if (!value) {
    return "未知时间";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return formatTime(value);
}

function modelDirectoryIsStale(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return true;
  }
  return Date.now() - date.getTime() > 7 * 24 * 60 * 60 * 1000;
}

function providerFor(providerId) {
  return (state.providers || []).find((provider) => provider.id === providerId);
}

function providerName(providerId) {
  return providerFor(providerId)?.shortName || providerFor(providerId)?.name || providerId || "-";
}

function routeProviderName(routeId) {
  const configured = (state.models || []).find(
    (item) => item.id === routeId || item.sourcePresetId === routeId,
  );
  if (configured) {
    return providerName(configured.provider || configured.providerFamily || configured.providerId);
  }
  const preset = modelMap().get(routeId);
  if (preset) {
    return providerName(preset.providerId || preset.provider || preset.providerFamily);
  }
  return "-";
}

function modelMap() {
  return new Map((state.modelPresets || []).map((model) => [model.presetId, model]));
}

function displayRoute(route) {
  const configured = (state.models || []).find((item) => item.id === route);
  if (configured?.displayName) {
    return configured.displayName;
  }
  const preset = modelMap().get(route);
  return preset?.displayName || route || "-";
}

function shortText(value, maxLength = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function cssEscape(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(String(value || ""));
  }
  return String(value || "").replace(/["\\]/g, "\\$&");
}

function value(selector) {
  return document.querySelector(selector).value.trim();
}

function setValue(selector, value) {
  document.querySelector(selector).value = value || "";
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function usageCostEstimateLabel(estimate = {}) {
  return estimate?.hasRates ? formatCostValue(estimate.totalCost) : "未设置";
}

function formatCostValue(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) {
    return "0";
  }
  if (number < 0.01) {
    return number.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  }
  return number.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function formatCompactContext(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) {
    return "-";
  }
  if (number >= 1000000) {
    return `${Math.round(number / 100000) / 10}M`;
  }
  if (number >= 1000) {
    return `${Math.round(number / 1000)}K`;
  }
  return formatNumber(number);
}

function formatInputTokens(item) {
  const fresh = Number(item?.freshPromptTokens ?? item?.promptTokens ?? 0);
  return formatNumber(fresh);
}

function formatCacheTokens(item) {
  const cacheRead = Number(item?.cacheReadTokens || 0);
  const cacheCreation = Number(item?.cacheCreationTokens || 0);
  const total = cacheRead + cacheCreation;
  if (total <= 0) {
    return "0";
  }
  if (cacheCreation > 0) {
    return `${formatNumber(total)}（读 ${formatNumber(cacheRead)} / 写 ${formatNumber(cacheCreation)}）`;
  }
  return formatNumber(cacheRead);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "大小未知";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (value < 1000) {
    return `${value} ms`;
  }
  return `${(value / 1000).toFixed(1)} s`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
