import { decideRoomRoute } from "./room-routing-policy.js";

export const ACCEPTANCE_CHECKS = [
  {
    id: "text-reply",
    label: "普通文字",
    prompt: "请只回复一句普通中文问候，用于测试 Bridge 是否能读取 GPT 文本回复。"
  },
  {
    id: "long-text",
    label: "长文",
    prompt: "请写一段 800 字左右的中文长文，主题是 AI 工作流产品如何协同 GPT 和 Codex，不生成文件。"
  },
  {
    id: "code-block",
    label: "代码块",
    prompt: "请只返回一个 Markdown JavaScript 代码块，必须用 ```js 开头、``` 结尾，代码内容是 console.log(\"bridge acceptance ok\"); 不要生成文件。"
  },
  {
    id: "single-image",
    label: "单张图片",
    prompt: "请用 GPT 自带图片生成功能生成 1 张图片，主题是清爽现代的 AI 工作台。"
  },
  {
    id: "multi-image",
    label: "多张图片",
    prompt: "请用 GPT 自带图片生成功能生成 3 张不同风格的 AI 工作台图片，每张单独生成。"
  },
  {
    id: "spreadsheet",
    label: "Excel",
    prompt: "请生成一个可下载的 xlsx 文件，里面写 10 条中文笑话，两列：序号、笑话内容。"
  },
  {
    id: "presentation",
    label: "PPT",
    prompt: "请生成一个可下载的 pptx 文件，主题是你喜欢的几种美食，3 页即可。"
  },
  {
    id: "pdf",
    label: "PDF",
    prompt: "请生成一个可下载的 PDF 文件，内容是 1 页 Bridge 验收说明。"
  },
  {
    id: "zip",
    label: "ZIP",
    prompt: "请生成一个很小的可下载 zip 文件，里面只放一个 ok.txt，内容是 bridge acceptance ok。"
  },
  {
    id: "local-file-to-gpt",
    label: "本机文件给 GPT",
    prompt: "在输入框左下角添加一个本机文件并发送给 GPT，验证 GPT 能收到并分析附件。"
  },
  {
    id: "failed-retry",
    label: "失败重试",
    prompt: "让一次 GPT 同步失败后，在失败消息下点击重试，验证它能重新排队。"
  }
];

export const ROUTE_ACCEPTANCE_CHECKS = [
  {
    id: "route-gpt-attachment",
    label: "附件分析 -> GPT",
    expectedRoute: "gpt_only",
    text: "分析一下这张图片，告诉我它是什么",
    attachmentCount: 1
  },
  {
    id: "route-gpt-generation",
    label: "生成产物 -> GPT",
    expectedRoute: "gpt_only",
    text: "请生成一个可下载的 xlsx 文件，里面写 10 条中文笑话。"
  },
  {
    id: "route-codex-local",
    label: "本地执行 -> Codex",
    expectedRoute: "codex_only",
    text: "帮我看看 C 盘有什么可以删的，先告诉我。"
  },
  {
    id: "route-gpt-then-codex",
    label: "分析后落地 -> GPT -> Codex",
    expectedRoute: "gpt_then_codex",
    text: "分析这个截图，然后按它把登录页改到项目里",
    attachmentCount: 1
  },
  {
    id: "route-simple-file",
    label: "简单本地文件 -> Codex",
    expectedRoute: "codex_only",
    text: "创建一个 b.txt 文件，里面写一句我想对你说的话。"
  }
];

export const FILE_FORMAT_CHECKS = [
  { extension: "png", label: "PNG", prompt: "上传或生成一个 PNG 图片，验证 Bridge 能捕获和展示。" },
  {
    extension: "jpg",
    aliases: ["jpeg"],
    label: "JPG",
    prompt: "上传或生成一个 JPG 图片，验证 Bridge 能捕获和展示。"
  },
  { extension: "pdf", label: "PDF", prompt: "上传或生成一个 PDF 文件，验证 Bridge 能捕获、预览和下载。" },
  { extension: "docx", label: "DOCX", prompt: "上传或生成一个 Word DOCX 文件，验证 Bridge 能捕获摘要。" },
  { extension: "xlsx", label: "XLSX", prompt: "上传或生成一个 Excel XLSX 文件，验证 Bridge 能捕获表格预览。" },
  {
    extension: "pptx",
    label: "PPTX",
    prompt: "上传或生成一个 PowerPoint PPTX 文件，验证 Bridge 能捕获幻灯片预览。"
  },
  { extension: "zip", label: "ZIP", prompt: "上传或生成一个 ZIP 文件，验证 Bridge 能捕获压缩包清单。" },
  { extension: "txt", label: "TXT", prompt: "上传或生成一个 TXT 文件，验证 Bridge 能捕获文本预览。" },
  { extension: "md", label: "MD", prompt: "上传或生成一个 Markdown 文件，验证 Bridge 能捕获文本预览。" },
  { extension: "json", label: "JSON", prompt: "上传或生成一个 JSON 文件，验证 Bridge 能捕获代码/文本预览。" }
];

export const RELIABILITY_CHECKS = [
  {
    id: "gpt-stuck",
    label: "GPT 卡住",
    prompt: "让一次 GPT 同步进入超时或卡住状态，验证 Bridge 会明确提示 GPT 卡住并允许重试。"
  },
  {
    id: "extension-reload",
    label: "扩展重载",
    prompt: "用旧版本 Bridge 扩展连接一次，验证 Bridge 会提示需要刷新扩展。"
  },
  {
    id: "attachment-upload-failure",
    label: "附件上传失败",
    prompt: "让一次本机文件上传给 GPT 失败，验证 Bridge 会显示附件上传失败，而不是原始技术错误。"
  },
  {
    id: "missing-download",
    label: "文件没捕获",
    prompt: "让 GPT 提到已经生成可下载文件但没有真实附件，验证 Bridge 会判定失败并提示重新生成。"
  },
  {
    id: "legacy-raw-retry",
    label: "旧任务 /raw 重试",
    prompt: "重试一个历史失败的本机文件任务，验证附件会自动使用 /raw 上传地址，不需要用户重新上传。"
  }
];

function normalizeContentType(contentType = "") {
  return contentType.toLowerCase().split(";")[0].trim();
}

function artifactExtension(artifact = {}) {
  const filename = artifact.filename || "";
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex + 1).toLowerCase() : "";
}

const GENERIC_CONTENT_TYPES = new Set(["application/octet-stream", "binary/octet-stream"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);

function contentTypeMatchesExtension(contentType = "", extension = "") {
  if (!contentType || !extension || GENERIC_CONTENT_TYPES.has(contentType)) {
    return true;
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return contentType.startsWith("image/") || (extension === "svg" && contentType.includes("svg"));
  }
  if (["xlsx", "xls"].includes(extension)) {
    return contentType.includes("spreadsheet") || contentType === "application/vnd.ms-excel";
  }
  if (extension === "csv") {
    return contentType.includes("csv") || contentType === "text/plain";
  }
  if (["pptx", "ppt"].includes(extension)) {
    return contentType.includes("presentation") || contentType === "application/vnd.ms-powerpoint";
  }
  if (["docx", "doc"].includes(extension)) {
    return contentType.includes("wordprocessingml") || contentType === "application/msword";
  }
  if (extension === "pdf") {
    return contentType === "application/pdf";
  }
  if (extension === "zip") {
    return contentType.includes("zip") || contentType === "application/x-compressed";
  }
  if (extension === "txt") {
    return contentType.startsWith("text/");
  }
  if (extension === "md") {
    return contentType.startsWith("text/") || contentType.includes("markdown");
  }
  if (extension === "json") {
    return contentType.includes("json") || contentType === "text/plain";
  }

  return true;
}

function artifactContentLooksValid(artifact = {}) {
  return contentTypeMatchesExtension(normalizeContentType(artifact.contentType), artifactExtension(artifact));
}

function isImageArtifact(artifact = {}) {
  const contentType = normalizeContentType(artifact.contentType);
  const extension = artifactExtension(artifact);
  return artifactContentLooksValid(artifact) && (contentType.startsWith("image/") || IMAGE_EXTENSIONS.has(extension));
}

function isSpreadsheetArtifact(artifact = {}) {
  const contentType = normalizeContentType(artifact.contentType);
  const extension = artifactExtension(artifact);
  return (
    artifactContentLooksValid(artifact) &&
    (["xlsx", "xls", "csv"].includes(extension) || contentType.includes("spreadsheet") || contentType === "text/csv")
  );
}

function isPresentationArtifact(artifact = {}) {
  const contentType = normalizeContentType(artifact.contentType);
  const extension = artifactExtension(artifact);
  return artifactContentLooksValid(artifact) && (["pptx", "ppt"].includes(extension) || contentType.includes("presentation"));
}

function isPdfArtifact(artifact = {}) {
  return (
    artifactContentLooksValid(artifact) &&
    (artifactExtension(artifact) === "pdf" || normalizeContentType(artifact.contentType) === "application/pdf")
  );
}

function isZipArtifact(artifact = {}) {
  const contentType = normalizeContentType(artifact.contentType);
  return artifactContentLooksValid(artifact) && (artifactExtension(artifact) === "zip" || contentType.includes("zip"));
}

function isFormatArtifact(artifact = {}, format = {}) {
  const acceptedExtensions = [format.extension, ...(format.aliases || [])].filter(Boolean);
  return artifactContentLooksValid(artifact) && acceptedExtensions.includes(artifactExtension(artifact));
}

function isCodeMessageText(text = "") {
  const value = text.trim();
  if (!value) return false;
  if (/```[\s\S]+?```/.test(value)) return true;

  return [
    /^console\.(?:log|info|warn|error)\s*\([\s\S]*\);?$/,
    /^(?:const|let|var)\s+[$A-Z_a-z][$\w]*\s*=/,
    /^function\s+[$A-Z_a-z][$\w]*\s*\(/,
    /^class\s+[$A-Z_a-z][$\w]*/,
    /^import\s+[\s\S]+from\s+["'][\s\S]+["'];?$/,
    /^export\s+/,
    /^(?:from\s+\S+\s+import|import\s+\S+)/,
    /^def\s+[$A-Z_a-z][$\w]*\s*\(/
  ].some((pattern) => pattern.test(value));
}

function passed(evidence) {
  return {
    status: "passed",
    evidence
  };
}

function missing(evidence = "还没有捕获到这一类真实数据") {
  return {
    status: "missing",
    evidence
  };
}

function failed(evidence) {
  return {
    status: "failed",
    evidence
  };
}

function latestMessageEvidence(message) {
  if (!message) return null;
  return `${message.from || "message"} / ${new Date(message.createdAt).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })}`;
}

function latestArtifactEvidence(artifact) {
  if (!artifact) return null;
  return `${artifact.filename} / ${artifact.contentType || "unknown"}`;
}

function latestByCreatedAt(items = []) {
  return [...items].sort((a, b) => {
    const aTime = Date.parse(a.createdAt || "");
    const bTime = Date.parse(b.createdAt || "");
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);
    if (aValid && bValid) return bTime - aTime;
    if (bValid) return 1;
    if (aValid) return -1;
    return 0;
  })[0] || null;
}

function artifactMapById(artifacts = []) {
  return new Map(artifacts.map((artifact) => [artifact.id, artifact]));
}

function imagesBySyncJob(artifacts = []) {
  const groups = new Map();
  for (const artifact of artifacts.filter(isImageArtifact)) {
    const key = artifact.syncJobId || artifact.sourceMessageId || artifact.id;
    const group = groups.get(key) || [];
    group.push(artifact);
    groups.set(key, group);
  }
  return groups;
}

function summarizeChecks({ workspace, syncJobs = [], messages = [], artifacts = [] }) {
  const conversationId = workspace?.conversationId || null;
  const scopedMessages = conversationId
    ? messages.filter((message) => message.conversationId === conversationId)
    : messages;
  const scopedArtifacts = conversationId
    ? artifacts.filter((artifact) => artifact.conversationId === conversationId)
    : artifacts;
  const scopedJobs = conversationId
    ? syncJobs.filter((job) => job.conversationId === conversationId)
    : syncJobs;
  const artifactById = artifactMapById(scopedArtifacts);
  const gptMessages = scopedMessages.filter((message) => message.from === "gpt" || message.role === "chatgpt");
  const latestTextMessage = gptMessages.find((message) => (message.text || "").trim().length > 0);
  const longTextMessage = gptMessages.find((message) => (message.text || "").trim().length >= 700);
  const codeMessage = gptMessages.find((message) => isCodeMessageText(message.text || ""));
  const images = scopedArtifacts.filter(isImageArtifact);
  const latestImage = latestByCreatedAt(images);
  const multiImageGroup = [...imagesBySyncJob(scopedArtifacts).values()].find((group) => group.length >= 3);
  const spreadsheet = scopedArtifacts.find(isSpreadsheetArtifact);
  const presentation = scopedArtifacts.find(isPresentationArtifact);
  const pdf = scopedArtifacts.find(isPdfArtifact);
  const zip = scopedArtifacts.find(isZipArtifact);
  const localFileJob = scopedJobs.find((job) => Array.isArray(job.inputArtifacts) && job.inputArtifacts.length > 0);
  const retryMessage = scopedMessages.find((message) => message.metadata?.retryOfSyncJobId);

  const results = new Map([
    [
      "text-reply",
      latestTextMessage ? passed(latestMessageEvidence(latestTextMessage)) : missing("还没有捕获到 GPT 文本回复")
    ],
    [
      "long-text",
      longTextMessage ? passed(`${(longTextMessage.text || "").length} 字符`) : missing("还没有捕获到 700 字符以上长文")
    ],
    ["code-block", codeMessage ? passed(latestMessageEvidence(codeMessage)) : missing("还没有捕获到 Markdown 代码块")],
    ["single-image", latestImage ? passed(latestArtifactEvidence(latestImage)) : missing("还没有捕获到 GPT 图片")],
    [
      "multi-image",
      multiImageGroup ? passed(`${multiImageGroup.length} 张图片来自同一次同步`) : missing("还没有捕获到同一次回复里的多张图片")
    ],
    ["spreadsheet", spreadsheet ? passed(latestArtifactEvidence(spreadsheet)) : missing("还没有捕获到表格文件")],
    ["presentation", presentation ? passed(latestArtifactEvidence(presentation)) : missing("还没有捕获到 PPT 文件")],
    ["pdf", pdf ? passed(latestArtifactEvidence(pdf)) : missing("还没有捕获到 PDF 文件")],
    ["zip", zip ? passed(latestArtifactEvidence(zip)) : missing("还没有捕获到 ZIP 文件")],
    [
      "local-file-to-gpt",
      localFileJob
        ? passed(`${localFileJob.inputArtifacts.length} 个输入附件 / ${localFileJob.status}`)
        : missing("还没有通过输入框把本机文件发送给 GPT")
    ],
    [
      "failed-retry",
      retryMessage ? passed(`重试自 ${retryMessage.metadata.retryOfSyncJobId}`) : missing("还没有记录到失败消息的重试动作")
    ]
  ]);

  return ACCEPTANCE_CHECKS.map((check) => ({
    ...check,
    ...(results.get(check.id) || missing())
  }));
}

function summarizeRouteChecks({ workspace = {} }) {
  return ROUTE_ACCEPTANCE_CHECKS.map((check) => {
    const route = decideRoomRoute({
      text: check.text,
      workspace,
      attachmentCount: check.attachmentCount || 0
    });
    const expectedRouteLabel = routeKindLabel(check.expectedRoute);
    const actualRouteLabel = routeKindLabel(route.kind);
    const status =
      route.kind === check.expectedRoute
        ? passed(`${actualRouteLabel} / ${route.reason}`)
        : failed(`期望 ${expectedRouteLabel}，实际 ${actualRouteLabel} / ${route.reason}`);

    return {
      ...check,
      prompt: check.text,
      action: "route_probe",
      actualRoute: route.kind,
      actualRouteLabel,
      expectedRouteLabel,
      actualTargets: route.targets,
      syncKind: route.syncKind,
      ...status
    };
  });
}

function summarizeFormatChecks({ workspace, artifacts = [] }) {
  const conversationId = workspace?.conversationId || null;
  const scopedArtifacts = conversationId
    ? artifacts.filter((artifact) => artifact.conversationId === conversationId)
    : artifacts;

  return FILE_FORMAT_CHECKS.map((format) => {
    const artifact = scopedArtifacts.find((candidate) => isFormatArtifact(candidate, format));
    return {
      id: `format-${format.extension}`,
      label: format.label,
      prompt: format.prompt,
      ...(artifact ? passed(latestArtifactEvidence(artifact)) : missing(`还没有捕获到 .${format.extension} 文件`))
    };
  });
}

function shortEvidenceUrl(value = "") {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return value || "";
  }
}

function extensionReloadRecoveryEvidence(extension = null) {
  if (!extension) {
    return null;
  }
  if (extension.needsReload) {
    return `${extension.version || "未知版本"} -> ${extension.expectedVersion || "当前服务版本"}`;
  }

  const currentVersion = extension.currentVersion || extension.version || null;
  const recoveredVersion = extension.recoveredVersion || null;
  const expectedVersion = extension.expectedVersion || null;
  const pageState = extension.currentPageStatus?.state || null;
  const versionMatches = Boolean(currentVersion && expectedVersion && currentVersion === expectedVersion);
  const pageCanReceive = !pageState || pageState === "ready" || pageState === "warning";

  if (extension.currentConnected && versionMatches && pageCanReceive) {
    const page = shortEvidenceUrl(extension.currentHref || "");
    return page ? `${currentVersion} 已重新连接 / ${page}` : `${currentVersion} 已重新连接`;
  }

  const recoveredPageState = extension.recoveredPageStatus?.state || null;
  const recoveredMatches = Boolean(recoveredVersion && expectedVersion && recoveredVersion === expectedVersion);
  const recoveredCanReceive = !recoveredPageState || recoveredPageState === "ready" || recoveredPageState === "warning";
  if (!recoveredMatches || !recoveredCanReceive) {
    return null;
  }

  const recoveredPage = shortEvidenceUrl(extension.recoveredHref || "");
  const recoveredAt = extension.recoveredAt ? ` / ${extension.recoveredAt}` : "";
  return recoveredPage
    ? `${recoveredVersion} 已恢复连接 / ${recoveredPage}${recoveredAt}`
    : `${recoveredVersion} 已恢复连接${recoveredAt}`;
}

function summarizeReliabilityChecks({ workspace, syncJobs = [], messages = [], extension = null }) {
  const conversationId = workspace?.conversationId || null;
  const scopedJobs = conversationId
    ? syncJobs.filter((job) => job.conversationId === conversationId)
    : syncJobs;
  const scopedMessages = conversationId
    ? messages.filter((message) => message.conversationId === conversationId)
    : messages;
  const stuckJob = scopedJobs.find(
    (job) =>
      job.errorCode === "reply_timeout" ||
      /timed out waiting for chatgpt reply|chatgpt 长时间没有返回|gpt 卡住/i.test(job.error || "")
  );
  const uploadFailureJob = scopedJobs.find(
    (job) =>
      job.errorCode === "attachment_upload_failed" ||
      /failed to fetch|upload failed|附件.*失败|上传.*失败/i.test(job.error || "")
  );
  const missingDownloadJob = scopedJobs.find(
    (job) =>
      job.errorCode === "missing_download" ||
      /没有捕获到真实文件|missing_download|没有拿到真实可下载文件/i.test(job.error || "")
  );
  const extensionEvidence = extensionReloadRecoveryEvidence(extension);
  const retryMessageIds = new Set(
    scopedMessages
      .filter((message) => message.metadata?.retryOfSyncJobId)
      .map((message) => message.id)
      .filter(Boolean)
  );
  const legacyRawRetryJob = scopedJobs.find((job) => {
    const inputArtifacts = Array.isArray(job.inputArtifacts) ? job.inputArtifacts : [];
    return (
      retryMessageIds.has(job.sourceMessageId) &&
      inputArtifacts.length > 0 &&
      inputArtifacts.every((artifact) => /\/raw(?=$|\?)/.test(String(artifact.uploadUrl || "")))
    );
  });
  const legacyRawRetryEvidence = legacyRawRetryJob
    ? `${legacyRawRetryJob.id} / ${legacyRawRetryJob.inputArtifacts.length} 个附件使用 /raw`
    : null;
  const results = new Map([
    ["gpt-stuck", stuckJob ? passed(`${stuckJob.id} / GPT 卡住`) : missing("还没有记录到 GPT 卡住或回复超时")],
    [
      "extension-reload",
      extensionEvidence ? passed(extensionEvidence) : missing("还没有记录到扩展版本过旧或需要重载")
    ],
    [
      "attachment-upload-failure",
      uploadFailureJob ? passed(`${uploadFailureJob.id} / 附件上传失败`) : missing("还没有记录到附件上传失败")
    ],
    [
      "missing-download",
      missingDownloadJob ? passed(`${missingDownloadJob.id} / 文件没捕获`) : missing("还没有记录到 GPT 提到文件但没有真实附件")
    ],
    [
      "legacy-raw-retry",
      legacyRawRetryEvidence ? passed(legacyRawRetryEvidence) : missing("还没有记录到旧任务使用 /raw 重新上传")
    ]
  ]);

  return RELIABILITY_CHECKS.map((check) => ({
    ...check,
    ...(results.get(check.id) || missing())
  }));
}

function routeKindLabel(kind = "") {
  if (kind === "gpt_only") return "GPT";
  if (kind === "codex_only") return "Codex";
  if (kind === "gpt_then_codex") return "GPT -> Codex";
  if (kind === "image") return "GPT 图片";
  return kind || "未知";
}

function summarize(checks = []) {
  return checks.reduce(
    (acc, check) => ({
      ...acc,
      total: acc.total + 1,
      passed: acc.passed + (check.status === "passed" ? 1 : 0),
      missing: acc.missing + (check.status === "missing" ? 1 : 0),
      failed: acc.failed + (check.status === "failed" ? 1 : 0)
    }),
    {
      total: 0,
      passed: 0,
      missing: 0,
      failed: 0
    }
  );
}

export function buildAcceptanceStatus(input = {}) {
  const dataChecks = summarizeChecks(input);
  const formatChecks = summarizeFormatChecks(input);
  const reliabilityChecks = summarizeReliabilityChecks(input);
  const routeChecks = summarizeRouteChecks(input);
  const groups = [
    {
      id: "data",
      label: "GPT 数据读取",
      summary: summarize(dataChecks),
      checks: dataChecks
    },
    {
      id: "formats",
      label: "文件格式",
      summary: summarize(formatChecks),
      checks: formatChecks
    },
    {
      id: "reliability",
      label: "稳定性",
      summary: summarize(reliabilityChecks),
      checks: reliabilityChecks
    },
    {
      id: "routing",
      label: "自动路由",
      summary: summarize(routeChecks),
      checks: routeChecks
    }
  ];
  const checks = groups.flatMap((group) => group.checks);
  const summary = summarize(checks);

  return {
    workspace: input.workspace || null,
    summary,
    groupSummaries: Object.fromEntries(groups.map((group) => [group.id, group.summary])),
    groups,
    checks
  };
}

function reportMark(status) {
  if (status === "passed") return "x";
  if (status === "failed") return "!";
  return " ";
}

function reportSummary(summary = {}) {
  return `${summary.passed || 0}/${summary.total || 0} 已通过，${summary.missing || 0} 项待测，${summary.failed || 0} 项需处理`;
}

export function buildAcceptanceReport(acceptance = {}) {
  const lines = [
    "# Bridge 标准验收报告",
    "",
    `总体：${reportSummary(acceptance.summary)}`,
    ""
  ];

  for (const group of acceptance.groups || []) {
    lines.push(`## ${group.label || "验收项"}`);
    lines.push("");
    lines.push(`小计：${reportSummary(group.summary)}`);
    lines.push("");
    for (const check of group.checks || []) {
      const mark = reportMark(check.status);
      const evidence = check.evidence ? ` - ${check.evidence}` : "";
      lines.push(`- [${mark}] ${check.label || check.id}${evidence}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}
