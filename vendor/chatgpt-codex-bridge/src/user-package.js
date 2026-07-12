import { looksLikeQuestionMarkEncodingLoss } from "./text-integrity.js";

export const DEFAULT_PACKAGE_NAME = "CodexBridge";

const COPY_ENTRIES = [
  "package.json",
  "package-lock.json",
  "README.md",
  "src",
  "public",
  "chrome-extension",
  "scripts",
  "docs",
  ".codex-plugin/plugin.json",
  ".mcp.json"
];

export function renderStartCommand() {
  return [
    "@echo off",
    "setlocal",
    "chcp 65001 >nul",
    "cd /d \"%~dp0\"",
    "where node >nul 2>nul",
    "if errorlevel 1 (",
    "  echo [CodexBridge] 需要先安装 Node.js 20 或更新版本。",
    "  echo [CodexBridge] 安装后请重新双击 Start-CodexBridge.cmd。",
    "  pause",
    "  exit /b 1",
    ")",
    "if not exist node_modules (",
    "  echo [CodexBridge] 第一次启动，正在安装依赖，请稍等...",
    "  npm install",
    "  if errorlevel 1 (",
    "    echo [CodexBridge] 依赖安装失败，请检查网络或 Node.js/npm 是否可用。",
    "    pause",
    "    exit /b 1",
    "  )",
    ")",
    "if \"%BRIDGE_PORT%\"==\"\" set \"BRIDGE_PORT=4317\"",
    "set \"BRIDGE_URL=http://127.0.0.1:%BRIDGE_PORT%/\"",
    "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$port = [int]$env:BRIDGE_PORT; $client = New-Object Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', $port); exit 0 } catch { exit 1 } finally { if ($client) { $client.Dispose() } }\" >nul 2>nul",
    "if not errorlevel 1 (",
    "  echo [CodexBridge] 端口 %BRIDGE_PORT% 已被占用，可能已有 Bridge 正在运行。",
    "  echo [CodexBridge] 正在打开现有页面：%BRIDGE_URL%",
    "  echo [CodexBridge] 如果打开的不是 Bridge，请先关闭占用 %BRIDGE_PORT% 的程序再重试。",
    "  start \"\" \"%BRIDGE_URL%\"",
    "  pause",
    "  exit /b 0",
    ")",
    "start \"\" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"Start-Sleep -Seconds 3; Start-Process $env:BRIDGE_URL\"",
    "npm start",
    "echo [CodexBridge] 服务已停止。",
    "pause"
  ].join("\r\n");
}

export function renderMcpStartCommand() {
  return [
    "@echo off",
    "setlocal",
    "chcp 65001 >nul",
    "cd /d \"%~dp0\"",
    "where node >nul 2>nul",
    "if errorlevel 1 (",
    "  echo [CodexBridge] 需要先安装 Node.js 20 或更新版本。",
    "  echo [CodexBridge] 安装后请重新双击 Start-CodexBridge-MCP.cmd。",
    "  pause",
    "  exit /b 1",
    ")",
    "if not exist node_modules (",
    "  echo [CodexBridge] 第一次启动，正在安装依赖，请稍等...",
    "  npm install",
    "  if errorlevel 1 (",
    "    echo [CodexBridge] 依赖安装失败，请检查网络或 Node.js/npm 是否可用。",
    "    pause",
    "    exit /b 1",
    "  )",
    ")",
    "npm run mcp",
    "echo [CodexBridge] MCP 服务已停止。",
    "pause"
  ].join("\r\n");
}

export function renderMcpConfig({ packageDir = "<CodexBridge 安装目录>" } = {}) {
  const normalized = String(packageDir).replaceAll("\\", "/").replace(/\/+$/, "");
  return [
    "[mcp_servers.chatgpt_codex_bridge]",
    "command = \"node\"",
    `args = ["${normalized}/src/mcp-server.js"]`
  ].join("\n");
}

export function renderAcceptanceChecklist() {
  return [
    "# CodexBridge 标准验收清单",
    "",
    "这份清单用于从零安装后确认 Bridge 是否真的稳定可用。验收时只控制绑定的那个 GPT 页面，不要影响其它 GPT 标签页。",
    "",
    "## 验收前准备",
    "",
    "1. 启动 `Start-CodexBridge.cmd`，打开 `http://127.0.0.1:4317/`。",
    "2. 在 Chrome 扩展页加载本包里的 `chrome-extension` 目录；更新服务或扩展后必须重新加载 Bridge 扩展。",
    "3. 打开并绑定一个真实 GPT 会话页面。",
    "4. 打开 Bridge 页面，确认顶部只显示关键状态：`GPT 已绑定`、`连接就绪`、`规则已写入`、`链路正常`。",
    "5. 确认 Bridge 只控制绑定的 GPT 页面，不会自动刷新其它 GPT 标签页；旧扩展不能继续领取新任务。",
    "",
    "## 必测 9 个真实场景",
    "",
    "| 序号 | 场景 | 合格标准 |",
    "| --- | --- | --- |",
    "| 1 | 发图片给 GPT 分析 | 图片进入 GPT，Bridge 只使用 GPT 返回的结论回复，不重复自己分析。 |",
    "| 2 | 发 zip 给 GPT 分析 | 优先静默捕获 GPT 文件资源，不能弹出系统下载确认框，GPT 能收到附件，Bridge 能展示压缩包清单。 |",
    "| 3 | 发 docx 给 GPT 分析 | GPT 返回内容摘要，Bridge 文件卡片只保留下载和放大/预览。 |",
    "| 4 | 让 GPT 生成 xlsx | Bridge 能捕获 xlsx，表格预览可读，下载按钮走正常浏览器下载。 |",
    "| 5 | 文件没捕获 | GPT 只说生成了文件但没有真实附件时，Bridge 必须判定失败并提示重新生成，不能当成功。 |",
    "| 6 | 让 GPT 生成多张图 | Bridge 展示同一次回复里的全部图片，不只显示第一张。 |",
    "| 7 | GPT 卡住 | Bridge 不疯狂刷新，只提示 GPT 卡住并允许重试。 |",
    "| 8 | 扩展重载 | 扩展过旧时提示刷新扩展；旧扩展不能继续领取新任务，提示语面向用户，不显示原始技术错误。 |",
    "| 9 | 旧任务重试 | 历史失败任务重试时自动使用 `/raw` 附件地址，不要求用户重新上传。 |",
    "",
    "## 文件格式覆盖",
    "",
    "至少逐个验证：`png`、`jpg`、`pdf`、`docx`、`xlsx`、`pptx`、`zip`、`txt`、`md`、`json`。",
    "",
    "## 自动路由覆盖",
    "",
    "- 图片、Office、PDF、长文案、设计稿默认交给 GPT。",
    "- 代码修改、运行、检查、本地磁盘操作默认由 Codex 自己做。",
    "- 用户明确说“不要交给 GPT”“你自己看”“本地执行”时，必须留给 Codex。",
    "- GPT 已分析过的文件，Codex 只复用 GPT 结果，不重新分析一遍。",
    "",
    "## 隐藏验收台",
    "",
    "在 Bridge 地址后加 `?qa=1` 可以打开隐藏验收台。它会展示当前房间的数据读取、格式覆盖、稳定性和路由覆盖情况。"
  ].join("\n");
}

export function renderProductReadinessPlan() {
  const rows = [
    ["1", "固化当前成功链路", "用本机文件发给 GPT，Bridge 拿回 GPT 结果；优先静默捕获 GPT 文件资源，不能弹出系统下载确认框。", "隐藏验收台数据读取、`npm test`、真实发文件测试。"],
    ["2", "补旧任务兼容", "历史失败任务重试时附件地址自动改成 `/raw`。", "`legacy-raw-retry` 验收项和旧任务重试测试。"],
    ["3", "测试常见文件上传给 GPT", "逐个覆盖 png、jpg、pdf、docx、xlsx、pptx、zip、txt、md、json。", "格式覆盖验收 10/10。"],
    ["4", "修正文件预览展示", "文件卡片只保留下载和放大/预览；不再显示保存、给 GPT、给 Codex 等无意义按钮。", "前端产品面测试和真实页面复查。"],
    ["5", "完善大文件处理", "大文件只展示摘要和截断提示，避免页面卡死。", "大文件预览测试。"],
    ["6", "优化 GPT 结果捕获", "忽略“正在读取文档”“正在生成”等中间态；GPT 提到文件但没有真实附件时判失败。", "内容脚本占位态过滤测试和 `missing-download` 验收项。"],
    ["7", "处理 GPT 页面卡住", "只在明确卡住时提示或轻量恢复，不疯狂刷新。", "卡住、超时、失败消息测试。"],
    ["8", "限制自动控制范围", "只控制绑定的 GPT 页面；不会自动刷新其它 GPT 标签页。", "绑定页匹配和非绑定页忽略测试。"],
    ["9", "修复多图捕获", "同一次 GPT 回复生成多图时全部捕获，不只取第一张。", "`multi-image` 验收项。"],
    ["10", "多图展示产品化", "主图加缩略图列表，支持切换、下载和放大。", "图片图库前端测试和真实截图复查。"],
    ["11", "文件下载体验统一", "下载按钮只做下载，不触发上传链路；扩展直取失败才走浏览器下载兜底，旧扩展不能继续领取新任务。", "下载捕获和直接导入测试。"],
    ["12", "本地文件给 GPT 的规则完善", "图片、Office、PDF、长文案、设计稿默认 GPT；代码修改、运行、检查默认 Codex。", "路由策略测试。"],
    ["13", "自动路由规则写入项目说明", "第一次启用 Bridge 时写入协作规则，让 Codex 明确何时交给 GPT。", "routing-rule bootstrap 测试。"],
    ["14", "用户 override 机制", "用户说不要交给 GPT、你自己看、本地执行时留给 Codex。", "override 路由测试。"],
    ["15", "结果复用规则", "GPT 已经分析过的同一文件不重复分析，Codex 复用结果。", "文件分析缓存复用测试。"],
    ["16", "状态栏精简", "顶部只显示绑定、连接、规则和链路状态；详细信息收进弹层。", "本地化/产品面测试和页面复查。"],
    ["17", "失败提示重写", "失败提示用用户能理解的话：没收到、卡住、上传失败、文件没捕获、扩展需重载。", "同步失败消息测试。"],
    ["18", "标准验收用例", "包含发图片、zip、docx、生成 xlsx、文件没捕获、多图、GPT 卡住、扩展重载、旧任务重试。", "`ACCEPTANCE-CHECKLIST.md` 和 `/api/acceptance/status`。"],
    ["19", "打包用户可安装版本", "包内包含服务、Chrome 扩展、MCP、插件元数据和安装说明。", "`npm run package:user` 与 `npm run smoke:product`。"],
    ["20", "真实产品体验测试", "从零安装、绑定、上传、GPT 分析、Codex 使用结果，记录半成品感。", "按本文件和验收清单逐项人工复查。"]
  ];

  return [
    "# CodexBridge 20 步产品就绪报告",
    "",
    "这份文件把当前产品目标拆成 20 个可验收点。自动测试能证明基础能力；真实产品体验仍要按最后一列逐项复查。",
    "",
    "| # | 目标 | 当前应达到的产品行为 | 验收证据 |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} |`),
    "",
    "## 使用方式",
    "",
    "1. 先跑 `npm test` 和 `npm run acceptance:contract`。",
    "2. 打包后跑 `npm run smoke:product -- <包目录>`。",
    "3. 再按 `ACCEPTANCE-CHECKLIST.md` 做一轮真实浏览器体验测试。",
    "4. 任何一项真实体验不符合，就不要把这个包当成稳定版本交付。"
  ].join("\n");
}

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function formatRecordDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return [
    `${date.getFullYear()}/${padDatePart(date.getMonth() + 1)}/${padDatePart(date.getDate())}`,
    `${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`
  ].join(" ");
}

function tableCell(value = "") {
  return String(value ?? "")
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}

function checkMap(acceptance = {}) {
  return new Map((acceptance.checks || []).map((check) => [check.id, check]));
}

function statusLabel(status = "") {
  if (status === "passed") return "通过";
  if (status === "failed") return "需处理";
  if (status === "missing") return "待测";
  return "";
}

function pickCheck(checks, ids = []) {
  const candidates = ids.map((id) => checks.get(id)).filter(Boolean);
  return (
    candidates.find((check) => check.status === "failed") ||
    candidates.find((check) => check.status === "passed") ||
    candidates[0] ||
    null
  );
}

function rowResult(checks, ids = []) {
  const check = pickCheck(checks, ids);
  return {
    result: statusLabel(check?.status),
    evidence: check?.evidence || ""
  };
}

function flowRow({ index, scene, action, standard, check }) {
  return `| ${index} | ${scene} | ${action} | ${standard} | ${tableCell(check.result)} | ${tableCell(check.evidence)} |`;
}

function formatRow({ format, standard, check }) {
  return `| ${format} | ${standard} | ${tableCell(check.result)} | ${tableCell(check.evidence)} |`;
}

function timestampValue(item = {}) {
  const value = item.completedAt || item.updatedAt || item.createdAt || item.sentAt || item.claimedAt || "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function latestItem(items = [], predicate = () => true) {
  return [...(items || [])]
    .filter(predicate)
    .sort((a, b) => timestampValue(b) - timestampValue(a))[0] || null;
}

function compactEvidenceText(value = "", limit = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function formatEvidenceDuration(syncJob = null) {
  const start = timestampValue({ createdAt: syncJob?.createdAt });
  const end = timestampValue({ completedAt: syncJob?.completedAt || syncJob?.failedAt || syncJob?.updatedAt });
  if (!start || !end || end < start) return "";
  const seconds = Math.max(1, Math.round((end - start) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function artifactEvidenceLabel(artifact = {}) {
  const filename = artifact.filename || artifact.name || artifact.originalName || artifact.id || "未命名文件";
  const kind = artifact.kind || artifact.contentType || artifact.mimeType || "file";
  const bytes = artifact.sizeBytes || artifact.bytes || artifact.size || 0;
  return bytes ? `${filename}（${kind}，${bytes} B）` : `${filename}（${kind}）`;
}

function actorEvidenceLabel(actor = "") {
  const normalized = String(actor || "").toLowerCase();
  if (normalized === "user") return "用户";
  if (normalized === "gpt") return "GPT";
  if (normalized === "codex") return "Codex";
  return actor || "Bridge";
}

function routeEvidenceLabel(message = null) {
  if (!message) return "";
  const targets = Array.isArray(message.to) ? message.to : [];
  if (!targets.length) return "";
  return `${actorEvidenceLabel(message.from)} -> ${targets.map(actorEvidenceLabel).join(" + ")}`;
}

function inputArtifactsEvidenceLabel(syncJob = null) {
  const artifacts = syncJob?.inputArtifacts || [];
  if (!artifacts.length) return "";
  return artifacts.map(artifactEvidenceLabel).join("；");
}

function renderRecentEvidenceSection({ syncJobs = [], artifacts = [], messages = [] } = {}) {
  const rows = [];
  const cleanEvidenceText = (value = "") => {
    const text = String(value || "");
    return looksLikeQuestionMarkEncodingLoss(text) ? "" : text;
  };
  const latestGptHandoffMessage = latestItem(
    messages,
    (message) =>
      Array.isArray(message.to) &&
      message.to.includes("gpt") &&
      ["user", "codex"].includes(String(message.from || "").toLowerCase()) &&
      cleanEvidenceText(message.text)
  );
  const latestGptMessage = latestItem(
    messages,
    (message) => String(message.from || "").toLowerCase() === "gpt" && cleanEvidenceText(message.text)
  );
  const recentArtifacts = [...(artifacts || [])]
    .sort((a, b) => timestampValue(b) - timestampValue(a))
    .slice(0, 5);
  const latestFailedJob = latestItem(syncJobs, (job) => job.status === "failed");
  const latestCompletedJob = latestItem(syncJobs, (job) => job.status === "succeeded" || job.status === "completed");
  const latestGptJob = latestCompletedJob || latestItem(syncJobs, (job) => job.payloadText || job.userText);

  const latestUserRequest =
    cleanEvidenceText(latestGptHandoffMessage?.text) ||
    cleanEvidenceText(latestGptJob?.userText) ||
    cleanEvidenceText(latestGptJob?.payloadText);
  if (latestUserRequest) {
    rows.push(`| 最近用户请求 | ${tableCell(compactEvidenceText(latestUserRequest, 180))} |`);
  }
  const route = routeEvidenceLabel(latestGptHandoffMessage);
  if (route) {
    rows.push(`| 最近链路 | ${tableCell(route)} |`);
  }
  const inputArtifacts = inputArtifactsEvidenceLabel(latestGptJob);
  if (inputArtifacts) {
    rows.push(`| GPT 输入附件 | ${tableCell(inputArtifacts)} |`);
  }
  const capturedResult = cleanEvidenceText(latestGptJob?.replyText) || cleanEvidenceText(latestGptJob?.result);
  if (capturedResult) {
    rows.push(`| GPT 捕获结果 | ${tableCell(compactEvidenceText(capturedResult, 180))} |`);
  }

  if (latestGptMessage) {
    rows.push(`| 最近 GPT 结果 | ${tableCell(compactEvidenceText(latestGptMessage.text, 180))} |`);
  }
  if (recentArtifacts.length) {
    rows.push(`| 最近附件 | ${tableCell(recentArtifacts.map(artifactEvidenceLabel).join("；"))} |`);
  }
  if (latestFailedJob) {
    const failure = latestFailedJob.failure?.friendly || latestFailedJob.failure?.message || latestFailedJob.error || latestFailedJob.reason || "有失败任务";
    rows.push(`| 最近失败 | ${tableCell(compactEvidenceText(failure, 160))} |`);
  }
  const duration = formatEvidenceDuration(latestCompletedJob);
  if (duration) {
    rows.push(`| 最近耗时 | ${tableCell(duration)} |`);
  }

  if (!rows.length) return [];
  return [
    "## 最近真实证据",
    "",
    "| 项目 | 证据 |",
    "| --- | --- |",
    ...rows,
    ""
  ];
}

export function renderRealBrowserAcceptanceRecord({
  acceptance = null,
  workspace = null,
  syncJobs = [],
  artifacts = [],
  messages = [],
  generatedAt = null,
  packageVersion = "",
  bridgeUrl = "http://127.0.0.1:4317/"
} = {}) {
  const checks = checkMap(acceptance || {});
  const summary = acceptance?.summary
    ? `当前自动覆盖：${acceptance.summary.passed || 0}/${acceptance.summary.total || 0} 已通过，${acceptance.summary.missing || 0} 项待测，${acceptance.summary.failed || 0} 项需处理。`
    : "";
  const generatedDate = formatRecordDate(generatedAt);
  const projectUrl = workspace?.chatgptProjectUrl || workspace?.projectUrl || "";
  const targetRepo = workspace?.targetRepo || "";
  const extensionState = checks.get("extension-reload")?.status === "failed"
    ? "需要重载"
    : checks.get("extension-reload")?.status === "passed"
      ? "已触发重载验收"
      : "连接就绪 / 需要重载 / 未连接";
  const flowRows = [
    flowRow({
      index: 1,
      scene: "图片给 GPT 分析",
      action: "在 Bridge 输入框粘贴或拖入图片，问“这是什么”。",
      standard: "GPT 页面收到图片并返回结论，Bridge 展示 GPT 结论。",
      check: rowResult(checks, ["local-file-to-gpt", "single-image"])
    }),
    flowRow({
      index: 2,
      scene: "ZIP 给 GPT 分析",
      action: "上传一个小 zip，问里面有什么。",
      standard: "上传过程不弹下载框，GPT 收到附件，Bridge 展示压缩包卡片和 GPT 结论。",
      check: rowResult(checks, ["zip", "format-zip"])
    }),
    flowRow({
      index: 3,
      scene: "DOCX 给 GPT 分析",
      action: "上传 Word 文档，让 GPT 总结内容。",
      standard: "Bridge 文件卡片只保留下载和放大/预览，GPT 结果完整回到 Bridge。",
      check: rowResult(checks, ["format-docx"])
    }),
    flowRow({
      index: 4,
      scene: "GPT 生成 XLSX",
      action: "让 GPT 生成 10 条中文笑话 xlsx。",
      standard: "Bridge 捕获 xlsx，表格预览可读，下载按钮正常下载。",
      check: rowResult(checks, ["spreadsheet", "format-xlsx"])
    }),
    flowRow({
      index: 5,
      scene: "文件没捕获",
      action: "让 GPT 声称生成了文件，但没有真实可下载附件。",
      standard: "Bridge 判定失败，提示文件没有捕获成功，不能当作成功结果。",
      check: rowResult(checks, ["missing-download"])
    }),
    flowRow({
      index: 6,
      scene: "GPT 生成多图",
      action: "让 GPT 一次生成 3 张不同风格图片。",
      standard: "Bridge 展示全部图片，主图和缩略图可切换，放大可用。",
      check: rowResult(checks, ["multi-image"])
    }),
    flowRow({
      index: 7,
      scene: "GPT 卡住恢复",
      action: "让一次任务停在读取/生成中，然后重试或刷新绑定页。",
      standard: "Bridge 不疯狂刷新，只提示 GPT 卡住或需要重试。",
      check: rowResult(checks, ["gpt-stuck"])
    }),
    flowRow({
      index: 8,
      scene: "扩展重载",
      action: "在 Chrome 扩展页重载 Bridge 扩展后再发消息。",
      standard: "Bridge 能重新连接；失败时只提示需要刷新扩展。",
      check: rowResult(checks, ["extension-reload"])
    }),
    flowRow({
      index: 9,
      scene: "旧任务重试",
      action: "对历史失败的附件任务点重试。",
      standard: "重试自动使用 raw 上传链路，不要求用户重新上传。",
      check: rowResult(checks, ["legacy-raw-retry", "failed-retry"])
    })
  ];
  const formatRows = [
    formatRow({
      format: "png / jpg",
      standard: "可上传给 GPT，可在 Bridge 预览或放大。",
      check: rowResult(checks, ["format-png", "format-jpg", "single-image"])
    }),
    formatRow({
      format: "pdf",
      standard: "可上传给 GPT，Bridge 不加载到卡死。",
      check: rowResult(checks, ["pdf", "format-pdf"])
    }),
    formatRow({
      format: "docx / xlsx / pptx",
      standard: "能展示摘要或预览，按钮只保留下载和放大。",
      check: rowResult(checks, ["format-docx", "format-xlsx", "format-pptx", "spreadsheet", "presentation"])
    }),
    formatRow({
      format: "zip",
      standard: "上传给 GPT 不触发下载弹窗，Bridge 展示条目。",
      check: rowResult(checks, ["zip", "format-zip"])
    }),
    formatRow({
      format: "txt / md / json",
      standard: "用代码/文本窗口展示，长文不过度撑爆页面。",
      check: rowResult(checks, ["format-txt", "format-md", "format-json", "long-text", "code-block"])
    })
  ];

  return [
    "# CodexBridge 真实浏览器体验记录",
    "",
    "这份记录只用于真实 Chrome + GPT 页面复查。自动 smoke 通过不等于真实体验通过；这里要记录用户实际看到的结果。",
    summary,
    "",
    "## 基本信息",
    "",
    "| 项目 | 记录 |",
    "| --- | --- |",
    `| 测试日期 | ${tableCell(generatedDate)} |`,
    "| 测试人 |  |",
    `| CodexBridge 包版本 | ${tableCell(packageVersion)} |`,
    `| Bridge 地址 | ${tableCell(bridgeUrl)} |`,
    `| 绑定 GPT 会话 | ${tableCell(projectUrl)} |`,
    `| 本地项目目录 | ${tableCell(targetRepo)} |`,
    `| Chrome 扩展状态 | ${tableCell(extensionState)} |`,
    "",
    ...renderRecentEvidenceSection({ syncJobs, artifacts, messages }),
    "## 通过前提",
    "",
    "- 只打开并控制绑定的那个 GPT 会话页面；只控制绑定的 GPT 页面，不会自动刷新其它 GPT 标签页。",
    "- 不切换账号，不退出登录，不处理真人验证。",
    "- 给 GPT 上传附件时不能弹出下载确认框；优先静默捕获 GPT 文件资源，不能弹出系统下载确认框；下载按钮只有用户点击时才下载。",
    "- 更新服务或扩展后必须重新加载 Bridge 扩展；旧扩展不能继续领取新任务。",
    "- GPT 已经分析过的文件，Codex 只复用 GPT 结果，不再自己重新分析一遍。",
    "",
    "## 必测流程",
    "",
    "| # | 场景 | 操作 | 通过标准 | 结果 | 证据/问题记录 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...flowRows,
    "",
    "## 文件格式抽查",
    "",
    "| 格式 | 通过标准 | 结果 | 问题记录 |",
    "| --- | --- | --- | --- |",
    ...formatRows,
    "",
    "## 失败分类",
    "",
    "| 用户看到的话 | 代表什么 | 下一步 |",
    "| --- | --- | --- |",
    "| GPT 页面没收到 | 绑定页不对、扩展未 claim、或 GPT 页面没就绪。 | 打开绑定会话页面，再重试。 |",
    "| GPT 卡住 | GPT 一直停在读取、生成或思考。 | 只刷新绑定页面，再点重试。 |",
    "| 附件上传失败 | raw 链路、服务或扩展上传出现问题。 | 确认服务运行和扩展连接，再重试。 |",
    "| 文件没有捕获成功 | GPT 提到了文件，但 Bridge 没拿到真实下载文件。 | 点重试，让 GPT 重新生成真实附件。 |",
    "| 需要刷新扩展 | 扩展版本旧或扩展上下文失效。 | 在 Chrome 扩展页重新加载 Bridge 扩展。 |",
    "",
    "## 最终结论",
    "",
    "- [ ] 可以作为可用版本交付。",
    "- [ ] 只能内部继续测试。",
    "- [ ] 暂停交付，必须先修复上面记录的问题。",
    "",
    "结论说明："
  ].join("\n");
}

export function renderInstallGuide({ packageDir = "<CodexBridge 安装目录>", version = "0.1.0" } = {}) {
  const displayPackageDir = String(packageDir).replaceAll("\\", "/").replace(/\/+$/, "");
  return [
    "# CodexBridge 安装说明",
    "",
    `版本：${version}`,
    "",
    "## 1. 启动本地服务",
    "",
    "双击 `Start-CodexBridge.cmd`。第一次启动会自动执行 `npm install` 安装依赖，然后启动本地服务。",
    "",
    "服务默认启动后会自动打开：`http://127.0.0.1:4317/`。如果浏览器没有自动弹出，再手动打开这个地址。",
    "",
    "普通用户不需要改端口；如果你要同时测试多个 Bridge，可以在命令行里先设置 `BRIDGE_PORT=4320` 这类端口，再运行 `Start-CodexBridge.cmd`。",
    "",
    "## 2. 安装 Chrome 扩展",
    "",
    "1. 打开 Chrome 的 `chrome://extensions/`。",
    "2. 开启开发者模式。",
    "3. 点击“加载已解压的扩展程序”。",
    `4. 选择你解压出来的 CodexBridge 文件夹里的 \`chrome-extension\` 目录，例如：\`${displayPackageDir}/chrome-extension\`。`,
    "5. 打开要绑定的 GPT 会话页面。",
    "",
    "Bridge 只控制绑定的 GPT 页面，不会切换账号，不会退出登录，也不会改动其他 GPT 标签页，不会自动刷新其它 GPT 标签页。",
    "",
    "更新服务或扩展后必须重新加载 Bridge 扩展；旧扩展不能继续领取新任务。",
    "",
    "## 3. 配置 MCP",
    "",
    "打开 `codex-mcp-config.toml`，先把里面的 `<CodexBridge 安装目录>` 替换成你实际解压后的完整路径，例如 `D:/Tools/CodexBridge`。",
    "",
    "然后把这段配置合并到 Codex 的 MCP 配置里。MCP 服务可用 `Start-CodexBridge-MCP.cmd` 单独启动，也可以由 Codex 按配置启动。",
    "",
    "## 4. 使用方式",
    "",
    "在 Bridge 页面绑定 GPT 会话和本地项目目录。之后图片、Office、PDF、长文案、设计稿默认交给 GPT；代码修改、运行、检查默认由 Codex 自己做。用户明确说“不要交给 GPT”时会保留给 Codex。",
    "",
    "## 5. 排错",
    "",
    "- 显示“绑定页断开”：打开或刷新绑定的 GPT 页面。",
    "- 显示“附件上传失败”：确认本地服务正在运行，然后重试。",
    "- 显示“GPT 卡住”：只刷新绑定的那个 GPT 页面，再点重试。",
    "- 显示“端口 4317 已被占用”：通常是已有 Bridge 在运行；如果打开的不是 Bridge，请关闭占用 4317 的程序后重试。设置了 `BRIDGE_PORT` 时，以提示里的端口为准。",
    "- 显示“扩展重载”：在 Chrome 扩展页面重新加载 CodexBridge 扩展；旧扩展不能继续领取新任务。",
    "",
    "## 6. 真实体验复查",
    "",
    "正式交付前，请按 `REAL-BROWSER-ACCEPTANCE.md` 走一轮真实 Chrome + GPT 体验测试。自动 smoke 通过只能证明本地包和接口链路正常，不能替代真实网页端复查。"
  ].join("\n");
}

export function buildUserPackagePlan({ version = "0.1.0", packageName = DEFAULT_PACKAGE_NAME, packageDir = "<CodexBridge 安装目录>" } = {}) {
  const copyEntries = COPY_ENTRIES.map((from) => ({ from, to: from }));
  const generatedEntries = [
    {
      generatedPath: "INSTALL-CodexBridge.md",
      to: "INSTALL-CodexBridge.md",
      content: renderInstallGuide({ packageDir, version })
    },
    {
      generatedPath: "Start-CodexBridge.cmd",
      to: "Start-CodexBridge.cmd",
      content: renderStartCommand()
    },
    {
      generatedPath: "Start-CodexBridge-MCP.cmd",
      to: "Start-CodexBridge-MCP.cmd",
      content: renderMcpStartCommand()
    },
    {
      generatedPath: "codex-mcp-config.toml",
      to: "codex-mcp-config.toml",
      content: renderMcpConfig({ packageDir })
    },
    {
      generatedPath: "ACCEPTANCE-CHECKLIST.md",
      to: "ACCEPTANCE-CHECKLIST.md",
      content: renderAcceptanceChecklist()
    },
    {
      generatedPath: "PRODUCT-READINESS-20-STEPS.md",
      to: "PRODUCT-READINESS-20-STEPS.md",
      content: renderProductReadinessPlan()
    },
    {
      generatedPath: "REAL-BROWSER-ACCEPTANCE.md",
      to: "REAL-BROWSER-ACCEPTANCE.md",
      content: renderRealBrowserAcceptanceRecord()
    }
  ];

  return {
    packageName,
    archiveName: `${packageName}.zip`,
    version,
    entries: [...copyEntries, ...generatedEntries]
  };
}
