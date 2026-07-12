import { appendRoomMessage } from "./room-store.js";
import { createSyncJob, failSyncJob, getSyncJob, listSyncJobs } from "./sync-store.js";

const DEFAULT_WAIT_TIMEOUT_MS = 180000;
const DEFAULT_WAIT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_GRACE_MS = 30000;

function normalizeMessageSender(value, fallback = "user") {
  const sender = String(value || fallback || "user").trim().toLowerCase();
  return ["user", "codex"].includes(sender) ? sender : fallback;
}

function attachmentGroundingInstruction() {
  return "请只根据附件本身判断；不要把问题或补充要求里的描述当成已经观察到的事实。看不清或不确定时请明确说明。";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function defaultTimeoutGraceMs(timeoutMs) {
  return timeoutMs >= 30000 ? DEFAULT_TIMEOUT_GRACE_MS : 0;
}

function normalizeCacheText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function stripChatGptReplyWrapper(text = "") {
  return String(text || "")
    .trim()
    .replace(/^\s*#{1,6}\s*ChatGPT\s*(?:说|說|says|璇达細|璇磡瑾獆says|鐠囪揪绱癨n)?\s*[:：]?\s*/i, "")
    .replace(/^\s*ChatGPT\s*(?:说|說|says|璇达細|璇磡瑾獆says|鐠囪揪绱癨n)?\s*[:：]?\s*/i, "")
    .trim();
}

function looksLikeInterruptedChatGptReply(text = "") {
  const concise = String(text || "").replace(/\s+/g, " ").trim();
  return concise.length <= 220 &&
    /连接.{0,8}(?:中断|断开)|(?:等待|正在等待).{0,12}(?:完整回复|完整答复|完整响应)|connection.{0,16}(?:interrupted|lost|disconnected)|waiting.{0,16}(?:complete|full).{0,12}(?:reply|response)/i.test(
      concise
    );
}

function looksLikeInterimChatGptReply(text = "") {
  const cleaned = stripChatGptReplyWrapper(text);
  if (/^(?:[\w.-]+\s*)?思考中$/i.test(cleaned) || looksLikeInterruptedChatGptReply(cleaned)) {
    return true;
  }
  if (/^continue\s+generating\b/i.test(cleaned)) {
    return false;
  }
  const concise = cleaned.replace(/\s+/g, " ").trim();
  return concise.length <= 220 &&
    /正在(?:思考|生成|处理|创建|读取|分析|解析|打开|检索|查看|检查)|(?:正在|开始).{0,16}(?:读取|分析|解析|处理|检查).{0,16}(?:文档|文件|附件|图片|表格|PPT|Word|Excel|PDF|CSV|ZIP|PSD|代码|压缩包|路径|信息)|(?:查看|读取|检索|搜索|调用|打开|检查).{0,36}(?:技能|说明|相关|文件|文档|附件|图片|表格|PPT|Word|Excel|PDF|CSV|ZIP|PSD|代码|压缩包|路径|信息)|(?:姝ｅ湪|寮€濮|妫€鏌|鏌ョ湅|璇诲彇|鎵撳紑|瑙ｆ瀽|鍒嗘瀽).{0,48}(?:璺緞|淇℃伅|鐩稿叧|浉鍏|鎶€鑳|妧鑳|璇存槑|璇鏄|鏂囦欢|鏂囨。|闄勪欢|鍥剧墖|ZIP|PDF|PPT|Word|Excel|CSV|PSD)|璇风◢鍊檤绋嶇瓑|请稍候|稍等|生成更细致的图片|创建图片|reading|analyzing|parsing|processing|thinking|generating|creating|please wait|hang tight/i.test(
      concise
    );
}

function sanitizeGptFileAnalysisReply(text = "") {
  const cleaned = stripChatGptReplyWrapper(text);
  if (!cleaned) {
    return null;
  }
  if (looksLikeInterimChatGptReply(cleaned)) {
    return "GPT 还在处理这次文件分析，Bridge 没有拿到最终可用回复。请稍后重试。";
  }
  return cleaned;
}

function artifactFingerprint(artifact = {}) {
  const hash = String(artifact.contentHashSha256 || "").trim();
  if (hash) {
    return `sha256:${hash}`;
  }

  const id = String(artifact.id || "").trim();
  return id ? `artifact:${id}` : "";
}

export function buildGptFileAnalysisCacheKey({ artifact, note }) {
  const fingerprint = artifactFingerprint(artifact);
  if (!fingerprint) {
    return null;
  }

  return ["codex_file_analysis", fingerprint, normalizeCacheText(note)].join("|");
}

function jobHasSameArtifact(job = {}, artifact = {}) {
  const fingerprint = artifactFingerprint(artifact);
  if (!fingerprint) {
    return false;
  }

  return (job.inputArtifacts || []).some((inputArtifact) => artifactFingerprint(inputArtifact) === fingerprint);
}

export async function findReusableGptFileAnalysis(storeRoot, { artifact, note }) {
  const cacheKey = buildGptFileAnalysisCacheKey({ artifact, note });
  const jobs = await listSyncJobs(storeRoot);

  return (
    jobs.find(
      (job) =>
        job.kind === "codex_file_analysis" &&
        job.status === "succeeded" &&
        job.replyText &&
        !looksLikeInterimChatGptReply(job.replyText) &&
        cacheKey &&
        job.resultCacheKey === cacheKey
    ) ||
    jobs.find(
      (job) =>
        job.kind === "codex_file_analysis" &&
        job.status === "succeeded" &&
        job.replyText &&
        !looksLikeInterimChatGptReply(job.replyText) &&
        !job.resultCacheKey &&
        jobHasSameArtifact(job, artifact) &&
        normalizeCacheText(job.payloadText).includes(normalizeCacheText(note))
    ) ||
    null
  );
}

export async function waitForSyncJobResult(storeRoot, syncJobId, options = {}) {
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS);
  const pollMs = positiveNumber(options.pollMs, DEFAULT_WAIT_POLL_MS);
  const timeoutGraceMs = nonNegativeNumber(options.timeoutGraceMs ?? options.graceMs, defaultTimeoutGraceMs(timeoutMs));
  const startedAt = Date.now();
  let latestJob = null;
  let latestReadError = null;

  async function pollUntil(deadlineMs) {
    while (Date.now() <= deadlineMs) {
      try {
        latestJob = await getSyncJob(storeRoot, syncJobId);
        latestReadError = null;
        if (latestJob.status === "succeeded" || latestJob.status === "failed") {
          return {
            finalJob: latestJob,
            timedOut: false,
            replyText: sanitizeGptFileAnalysisReply(latestJob.replyText)
          };
        }
      } catch (error) {
        latestReadError = error;
      }

      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await sleep(Math.min(pollMs, remainingMs));
    }
    return null;
  }

  const mainResult = await pollUntil(startedAt + timeoutMs);
  if (mainResult) {
    return mainResult;
  }

  if (timeoutGraceMs > 0 && latestJob && ["pending", "running"].includes(latestJob.status)) {
    const graceResult = await pollUntil(Date.now() + timeoutGraceMs);
    if (graceResult) {
      return graceResult;
    }
  }

  if (!latestJob && latestReadError) {
    throw latestReadError;
  }

  const finalJob = latestJob || (await getSyncJob(storeRoot, syncJobId));
  if (options.failOnTimeout) {
    const failedJob = await failSyncJob(storeRoot, syncJobId, {
      error: options.timeoutMessage || "Timed out waiting for GPT reply.",
      errorCode: "reply_timeout",
      recoveryAction: "retry_after_refresh"
    });
    return {
      finalJob: failedJob,
      timedOut: true,
      replyText: null
    };
  }

  return {
    finalJob,
    timedOut: true,
    replyText: null
  };
}

export async function queueArtifactForGptAnalysis(
  storeRoot,
  {
    requestId,
    workspace,
    artifact,
    artifacts,
    kind,
    payloadText,
    note,
    modePreference,
    modelPreference,
    from,
    source,
    metadata = {}
  }
) {
  const analysisArtifacts = (Array.isArray(artifacts) ? artifacts : [artifact]).filter(Boolean);
  if (analysisArtifacts.length === 0) {
    throw new Error("GPT file analysis requires at least one artifact");
  }
  const primaryArtifact = analysisArtifacts[0];
  const trimmedNote = note?.trim();
  const syncKind = typeof kind === "string" && kind.trim() ? kind.trim() : "codex_file_analysis";
  const explicitPayloadText =
    typeof payloadText === "string" && payloadText.trim() ? payloadText : null;
  const sender = normalizeMessageSender(from);
  const resultCacheKey =
    syncKind === "codex_file_analysis" && analysisArtifacts.length === 1
      ? buildGptFileAnalysisCacheKey({ artifact: primaryArtifact, note: trimmedNote })
      : null;
  const reusableJob = requestId || syncKind !== "codex_file_analysis" || analysisArtifacts.length !== 1
    ? null
    : await findReusableGptFileAnalysis(storeRoot, {
        artifact: primaryArtifact,
        note: trimmedNote
      });
  if (reusableJob) {
    const message = await appendRoomMessage(storeRoot, {
      conversationId: workspace.conversationId,
      from: "gpt",
      to: [sender],
      text: sanitizeGptFileAnalysisReply(reusableJob.replyText),
      metadata: {
        artifactId: primaryArtifact.id,
        inputArtifactIds: [primaryArtifact.id],
        source: "gpt_analysis_cache",
        cached: true,
        reusedSyncJobId: reusableJob.id,
        initiatedBy: sender,
        ...metadata
      }
    });

    return {
      message,
      syncJob: reusableJob,
      cached: true,
      reusedSyncJobId: reusableJob.id,
      finalJob: reusableJob,
      timedOut: false,
      replyText: sanitizeGptFileAnalysisReply(reusableJob.replyText)
    };
  }

  const fileRequestText =
    analysisArtifacts.length === 1
      ? `请 GPT 分析文件：${primaryArtifact.filename}`
      : [
          "请 GPT 分析以下文件：",
          ...analysisArtifacts.map((item) => `- ${item.filename}`)
        ].join("\n");
  const messageText = [
    fileRequestText,
    trimmedNote ? `补充要求：${trimmedNote}` : null
  ]
    .filter(Boolean)
    .join("\n");
  const inputArtifacts = analysisArtifacts.map((item) => ({
    id: item.id,
    filename: item.filename,
    contentType: item.contentType || "application/octet-stream",
    sizeBytes: item.sizeBytes || 0,
    contentHashSha256: item.contentHashSha256 || null,
    downloadUrl: `/api/artifacts/${encodeURIComponent(item.id)}/download`,
    uploadUrl: `/api/artifacts/${encodeURIComponent(item.id)}/raw`
  }));
  const fileDetails = analysisArtifacts.flatMap((item, index) => [
    ...(analysisArtifacts.length > 1 ? [`文件 ${index + 1}：`] : []),
    `文件名：${item.filename}`,
    `文件类型：${item.contentType || "application/octet-stream"}`,
    `文件大小：${item.sizeBytes || 0} bytes`
  ]);
  const syncJobInput = {
    kind: syncKind,
    projectUrl: workspace.chatgptProjectUrl,
    targetRepo: workspace.targetRepo,
    conversationId: workspace.conversationId,
    userText: explicitPayloadText || messageText,
    payloadText: explicitPayloadText || [
      "请分析我上传的文件。",
      ...fileDetails,
      attachmentGroundingInstruction(),
      "",
      trimmedNote || "请总结文件内容、判断质量，并给出下一步建议。"
    ].join("\n"),
    resultCacheKey,
    modePreference,
    modelPreference,
    inputArtifacts
  };
  if (requestId) {
    try {
      const existing = await getSyncJob(storeRoot, requestId);
      const syncJob = await createSyncJob(storeRoot, {
        ...syncJobInput,
        id: requestId,
        sourceMessageId: existing.sourceMessageId
      });
      return {
        message: null,
        syncJob,
        cached: false,
        reusedSyncJobId: null
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  const message = await appendRoomMessage(storeRoot, {
    conversationId: workspace.conversationId,
    from: sender,
    to: ["gpt"],
    text: messageText,
    metadata: {
      artifactId: primaryArtifact.id,
      inputArtifactIds: analysisArtifacts.map((item) => item.id),
      source: source || "local_file",
      initiatedBy: sender,
      ...metadata
    }
  });
  const syncJob = await createSyncJob(storeRoot, {
    ...syncJobInput,
    id: requestId,
    sourceMessageId: message.id
  });

  return {
    message,
    syncJob,
    cached: false,
    reusedSyncJobId: null
  };
}
