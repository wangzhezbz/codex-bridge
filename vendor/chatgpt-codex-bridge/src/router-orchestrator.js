import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const TRANSPORT_STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);
const ACTIVE_SUBMISSIONS = new Map();
const ACTIVE_SUBMISSION_TTL_MS = 5 * 60_000;
const RETRYABLE_UNLINK_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const TRANSPORT_RESULT_FIELDS = new Set([
  "transportId",
  "requestId",
  "status",
  "replyText",
  "artifacts",
  "error",
  "raw"
]);
const RUN_LOCKS = new Map();

function abortError(signal) {
  const reason = signal?.reason;
  const error = new Error(
    reason instanceof Error && reason.message
      ? reason.message
      : "Router continuation aborted"
  );
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  if (reason instanceof Error) {
    error.cause = reason;
  }
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function commitPointReached(option) {
  return typeof option === "function" ? option() === true : option === true;
}

async function awaitWithAbort(value, signal) {
  throwIfAborted(signal);
  if (!signal) {
    return value;
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function withRunLock(key, operation, options = {}) {
  const signal = options.signal;
  throwIfAborted(signal);
  const previous = RUN_LOCKS.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  RUN_LOCKS.set(key, current);
  try {
    await awaitWithAbort(previous.catch(() => {}), signal);
    throwIfAborted(signal);
    const result = await operation();
    if (!commitPointReached(options.commitOnOperationReturn)) {
      throwIfAborted(signal);
    }
    return result;
  } finally {
    release();
    if (RUN_LOCKS.get(key) === current) {
      RUN_LOCKS.delete(key);
    }
  }
}

function runLockKey(runId, scope = {}) {
  const canonicalPart = (value) => {
    const text = typeof value === "string" ? value.trim() : "";
    return text || "missing";
  };
  return JSON.stringify([
    canonicalPart(scope.projectId),
    canonicalPart(scope.conversationId),
    canonicalPart(scope.codexThreadId),
    canonicalPart(runId)
  ]);
}

function nowIso(clock) {
  const value = clock();
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "number") {
    return new Date(value).toISOString();
  }
  return String(value);
}

function errorText(value) {
  if (value == null) {
    return null;
  }
  return value instanceof Error ? value.message : String(value);
}

function assertWorkspaceScope(workspace = {}, scope = {}) {
  const mappings = [
    ["projectId", workspace.projectId],
    ["conversationId", workspace.conversationId],
    ["codexThreadId", workspace.currentCodexThreadId]
  ];
  for (const [field, workspaceValue] of mappings) {
    const scopeValue = typeof scope[field] === "string" ? scope[field].trim() : "";
    if (!scopeValue) {
      throw new Error(`Router run scope requires ${field}`);
    }
    if (!workspaceValue || workspaceValue !== scopeValue) {
      throw new Error(`Router workspace scope mismatch: ${field}`);
    }
  }
}

function stagesForRoute(route = {}, originalRequestText, inputArtifacts = []) {
  if (route.kind === "codex_only") {
    return [];
  }
  if (Array.isArray(route.sequentialPlan?.stages) && route.sequentialPlan.stages.length > 0) {
    return route.sequentialPlan.stages.map((stage, index) => ({
      id: stage.id,
      title: stage.title,
      payloadText: stage.payloadText || "",
      dependsOn: stage.dependsOn || null,
      instruction: stage.instruction || null,
      inputArtifacts: index === 0 ? inputArtifacts : []
    }));
  }
  if (inputArtifacts.length > 1) {
    return inputArtifacts.map((artifact, index) => ({
      id: `gpt-file-${index + 1}`,
      title: `GPT file ${index + 1}`,
      payloadText: index === 0 ? route.gptPayloadText || originalRequestText : "",
      dependsOn: index === 0 ? null : `gpt-file-${index}`,
      instruction: index === 0 ? null : "Analyze the next attached file using the prior result only as context.",
      inputArtifacts: [artifact]
    }));
  }
  return [
    {
      id: "gpt",
      title: "GPT",
      payloadText: route.gptPayloadText || originalRequestText,
      dependsOn: null,
      instruction: null,
      inputArtifacts
    }
  ];
}

function defaultTransportRequestIdFactory({ run, stage }) {
  const runPart = String(run.id).replace(/[^A-Za-z0-9._-]/g, "_");
  const stagePart = String(stage.id).replace(/[^A-Za-z0-9._-]/g, "_");
  return `sync_router_${runPart}_${stagePart}`;
}

function validateTransportResult(result, transportId, expectedRequestId) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Invalid transport result: expected an object envelope");
  }
  for (const field of ["transportId", "requestId", "status"]) {
    if (!Object.hasOwn(result, field)) {
      throw new Error(`Invalid transport envelope: missing ${field}`);
    }
  }
  if (result.transportId !== transportId) {
    throw new Error(
      `Invalid transport id: expected ${transportId}, received ${result.transportId || "missing"}`
    );
  }
  if (!result.requestId || result.requestId !== expectedRequestId) {
    throw new Error(
      `Invalid transport requestId: expected ${expectedRequestId}, received ${result.requestId || "missing"}`
    );
  }
  if (!TRANSPORT_STATUSES.has(result.status)) {
    throw new Error(`Invalid transport status: ${result.status || "missing"}`);
  }
  for (const field of ["replyText", "artifacts", "error", "raw"]) {
    if (!Object.hasOwn(result, field)) {
      throw new Error(`Invalid transport envelope: missing ${field}`);
    }
  }
  if (result.replyText != null && typeof result.replyText !== "string") {
    throw new Error("Invalid transport replyText: expected string or null");
  }
  if (!Array.isArray(result.artifacts)) {
    throw new Error("Invalid transport artifacts: expected an array");
  }
  if (result.error != null && typeof result.error !== "string") {
    throw new Error("Invalid transport error: expected string or null");
  }
  const unexpectedField = Object.keys(result).find(
    (field) => !TRANSPORT_RESULT_FIELDS.has(field)
  );
  if (unexpectedField) {
    throw new Error(
      `Invalid transport envelope: unexpected transport field ${unexpectedField}; nest private fields under raw`
    );
  }
  return {
    transportId: result.transportId,
    requestId: result.requestId,
    status: result.status,
    replyText: result.replyText ?? null,
    artifacts: result.artifacts,
    error: result.error ?? null,
    raw: result.raw ?? null
  };
}

function firstIncompleteStageIndex(run) {
  return run.stages.findIndex((stage) => stage.status !== "succeeded");
}

function canApplyStageSnapshot(current, expected, stageIndex) {
  if (TERMINAL_STATUSES.has(current.status)) {
    return false;
  }
  const currentStage = current.stages[stageIndex];
  const expectedStage = expected.stages[stageIndex];
  if (!currentStage || !expectedStage || currentStage.id !== expectedStage.id) {
    return false;
  }
  if (TERMINAL_STATUSES.has(currentStage.status)) {
    return false;
  }
  return (
    currentStage.status === expectedStage.status &&
    currentStage.submissionState === expectedStage.submissionState &&
    currentStage.transportRequestId === expectedStage.transportRequestId
  );
}

function priorStageContext(run, stageIndex) {
  const priorStages = run.stages
    .slice(0, stageIndex)
    .filter((stage) => stage.status === "succeeded" && stage.replyText);
  const currentStage = run.stages[stageIndex];
  if (!stageLooksLikeImageRequest(currentStage)) {
    return priorStages
      .map((stage) => `## ${stage.title}\n${stage.replyText}`)
      .join("\n\n");
  }

  const firstBudget = priorStages.length > 1 ? 2200 : 3200;
  const remainingBudget = Math.max(0, 3200 - firstBudget);
  const laterBudget =
    priorStages.length > 1 ? Math.floor(remainingBudget / (priorStages.length - 1)) : 0;
  return priorStages
    .map((stage, index) => {
      const budget = index === 0 ? firstBudget : laterBudget;
      const replyText = String(stage.replyText || "");
      const compactReply =
        replyText.length > budget
          ? `${replyText.slice(0, Math.max(0, budget - 16)).trimEnd()}\n[内容已截断]`
          : replyText;
      return `## ${stage.title}\n${compactReply}`;
    })
    .join("\n\n");
}

function payloadForStage(run, stageIndex, options = {}) {
  const stage = run.stages[stageIndex];
  if (stageIndex === 0 && stage.payloadText.trim()) {
    return stage.payloadText;
  }
  const preservesConversationContext = options.preservesConversationContext === true;
  const context = preservesConversationContext ? "" : priorStageContext(run, stageIndex);
  return [
    stage.instruction || `请完成“${stage.title}”。`,
    preservesConversationContext ? "" : null,
    preservesConversationContext
      ? "请严格承接本会话中已经完成的前序阶段结果，不要重复复述前序内容。"
      : null,
    context ? "" : null,
    context ? "以下是已经成功并保存的前序阶段结果：" : null,
    context || null,
    "",
    `请只完成当前阶段“${stage.title}”，不要继续任何后续阶段。`
  ]
    .filter((line) => line != null)
    .join("\n");
}

function workspaceFromRun(run) {
  return {
    projectId: run.projectId,
    conversationId: run.conversationId,
    currentCodexThreadId: run.codexThreadId,
    targetRepo: run.targetRepo,
    chatgptProjectUrl: run.chatgptProjectUrl,
    modePreference: run.modePreference,
    modelPreference: run.modelPreference
  };
}

function stageLooksLikeImageRequest(stage = {}) {
  const stageId = String(stage.id || "").trim().toLowerCase();
  const stageTitle = String(stage.title || "").trim();
  const isImagePlanningStage =
    /(?:^|[_-])(?:direction|plan|prompt|brief|concept)(?:$|[_-])/.test(stageId) ||
    /(?:海报|封面|图片|图像|插画).{0,16}(?:方案|方向|提示词|生成指令|创意简报|构图建议)|(?:方案|方向|提示词|生成指令|创意简报|构图建议).{0,16}(?:海报|封面|图片|图像|插画)/i.test(
      stageTitle
    ) ||
    /\b(?:poster|cover|image|illustration)\b.{0,24}\b(?:direction|plan|prompt|brief|concept)\b|\b(?:direction|plan|prompt|brief|concept)\b.{0,24}\b(?:poster|cover|image|illustration)\b/i.test(
      stageTitle
    );
  if (isImagePlanningStage) {
    return false;
  }

  const stageText = `${stage.title || ""} ${stage.instruction || ""} ${stage.payloadText || ""}`;
  const positiveStageText = [
    /(?:(?:不要|别|无需|不需要|禁止|避免)|不(?=(?:再|提前)?(?:生成|制作|创建|绘制|画|设计)))(?=[^，。！？!?；;\n]{0,64}(?:生图|生成|制作|创建|绘制|画|设计|配图|图片|图像|照片|海报|封面|图标|logo|插画|视觉))[^，。！？!?；;\n]*/gi,
    /\b(?:do not|don't|without|no need to|avoid)\b(?=[^,.!?;\n]{0,80}\b(?:generate|create|draw|image|images|picture|photo|poster|cover|icon|logo|illustration)\b)[^,.!?;\n]*/gi
  ].reduce((value, pattern) => value.replace(pattern, " "), stageText);
  const hasNegatedImageClause = positiveStageText !== stageText;
  const hasExplicitImageGeneration =
    /(?:生成|制作|创建|绘制|画).{0,40}(?:图片|图像|照片|海报|封面|配图|插画|图标|logo)|(?:生图|配图)/i.test(
      positiveStageText
    ) ||
    /\b(?:generate|create|make|draw)\b.{0,60}\b(?:image|picture|photo|poster|cover|icon|logo|illustration)\b/i.test(
      positiveStageText
    );
  const mentionsImageOutput =
    /(?:\b(?:posters?|covers?|images?|illustrations?)\b|\u6d77\u62a5|\u5c01\u9762|\u914d\u56fe|\u63d2\u753b)/i.test(
      positiveStageText
    );
  return (
    stage.id === "poster" ||
    hasExplicitImageGeneration ||
    (!hasNegatedImageClause && mentionsImageOutput)
  );
}

function transportKindForStage(run, stage) {
  return stageLooksLikeImageRequest(stage) ? "image_request" : run.syncKind || "chat_message";
}

function sanitizeFilename(value = "artifact") {
  const basename = path.basename(String(value)) || "artifact";
  const sanitized = basename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return sanitized || "artifact";
}

function filenameWithSuffix(filename, suffix) {
  const parsed = path.parse(filename);
  return `${parsed.name || "artifact"}-${suffix}${parsed.ext || ""}`;
}

function deterministicArtifactDestination(directory, filename, artifactId, reservedNames) {
  let candidate = filename;
  const stableSuffix = sanitizeFilename(artifactId || "artifact").replaceAll(".", "_");
  if (reservedNames.has(candidate.toLowerCase())) {
    candidate = filenameWithSuffix(filename, stableSuffix);
  }
  let collision = 1;
  while (reservedNames.has(candidate.toLowerCase())) {
    candidate = filenameWithSuffix(filename, `${stableSuffix}-${collision++}`);
  }
  reservedNames.add(candidate.toLowerCase());
  return path.join(directory, candidate);
}

function imageArtifactLike(artifact = {}) {
  const contentType = String(artifact.contentType || artifact.mimeType || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType && contentType !== "application/octet-stream") {
    return contentType.startsWith("image/");
  }
  return /\.(?:png|jpe?g|webp|gif|svg|bmp|tiff?|heic|psd)$/i.test(
    String(artifact.filename || artifact.filePath || "")
  );
}

function validateTargetRepo(targetRepo) {
  const projectRoot = path.resolve(targetRepo || "");
  if (!targetRepo || projectRoot === path.parse(projectRoot).root) {
    throw new Error("Router run requires a non-root target project directory");
  }
  return projectRoot;
}

function uniquePaths(paths) {
  return [...new Set(paths.map((item) => path.resolve(item)))];
}

function activeSubmissionKey(runId, requestId) {
  return `${String(runId)}\u0000${String(requestId)}`;
}

function reserveActiveSubmission(runId, requestId, ownerToken) {
  const key = activeSubmissionKey(runId, requestId);
  const entry = {
    key,
    ownerPid: process.pid,
    ownerToken,
    status: "reserved",
    value: null,
    error: null,
    promise: null,
    cleanupTimer: null
  };
  ACTIVE_SUBMISSIONS.set(key, entry);
  return entry;
}

function activateReservedSubmission(entry, submit, ttlMs = ACTIVE_SUBMISSION_TTL_MS) {
  if (!entry || ACTIVE_SUBMISSIONS.get(entry.key) !== entry || entry.status !== "reserved") {
    throw new Error("Router submission reservation is no longer active");
  }
  entry.status = "pending";
  entry.cleanupTimer = setTimeout(() => {
    if (ACTIVE_SUBMISSIONS.get(entry.key) === entry) {
      ACTIVE_SUBMISSIONS.delete(entry.key);
    }
  }, ttlMs);
  entry.cleanupTimer.unref?.();
  let rawPromise;
  try {
    rawPromise = submit();
  } catch (error) {
    rawPromise = Promise.reject(error);
  }
  entry.promise = Promise.resolve(rawPromise).then(
    (value) => {
      entry.status = "fulfilled";
      entry.value = value;
      return value;
    },
    (error) => {
      entry.status = "rejected";
      entry.error = error;
      throw error;
    }
  );
  void entry.promise.catch(() => {});
  return entry;
}

function getMatchingActiveSubmission(run, stage) {
  if (!stage?.submissionOwnerToken) {
    return null;
  }
  const entry = ACTIVE_SUBMISSIONS.get(activeSubmissionKey(run.id, stage.transportRequestId));
  return entry?.ownerToken === stage.submissionOwnerToken ? entry : null;
}

function forgetActiveSubmission(runId, requestId, ownerToken) {
  const key = activeSubmissionKey(runId, requestId);
  const entry = ACTIVE_SUBMISSIONS.get(key);
  if (!entry || (ownerToken && entry.ownerToken !== ownerToken)) {
    return;
  }
  clearTimeout(entry.cleanupTimer);
  ACTIVE_SUBMISSIONS.delete(key);
}

function materializationTemporaryPath(destination) {
  return `${destination}.bridge-tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
}

async function unlinkIfPresent(filePath, unlinkFile = unlink) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await unlinkFile(filePath);
      return;
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      if (!RETRYABLE_UNLINK_CODES.has(error.code) || attempt >= 2) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

async function cleanupKnownPaths(paths, unlinkFile) {
  const errors = [];
  for (const filePath of paths) {
    try {
      await unlinkIfPresent(filePath, unlinkFile);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function attachCleanupErrors(error, cleanupErrors) {
  if (cleanupErrors.length === 0) {
    return error;
  }
  error.cleanupErrors = cleanupErrors;
  if (!error.cause) {
    error.cause = cleanupErrors.length === 1
      ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, "Router materialization cleanup failed");
  }
  return error;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function createRouterOrchestrator(options = {}) {
  const runStore = options.runStore;
  const transportRegistry = options.transportRegistry;
  const artifactResolver = options.artifactResolver;
  const clock = options.clock || (() => new Date());
  const nowMs = options.nowMs || (() => Date.now());
  const transportRequestIdFactory =
    options.transportRequestIdFactory || defaultTransportRequestIdFactory;
  const submissionOwnerTokenFactory =
    options.submissionOwnerTokenFactory ||
    (() => `${process.pid}-${randomBytes(12).toString("hex")}`);
  const unlinkFile = options.unlinkFile || unlink;
  const isProcessAlive = options.isProcessAlive || processIsAlive;
  const activeSubmissionTtlMs = Number(
    options.activeSubmissionTtlMs ?? ACTIVE_SUBMISSION_TTL_MS
  );
  let transportRequestSequence = 0;
  if (
    !runStore ||
    typeof runStore.create !== "function" ||
    typeof runStore.update !== "function" ||
    typeof runStore.withRunLease !== "function" ||
    typeof runStore.withSubmissionLease !== "function" ||
    typeof runStore.withFinalizationLease !== "function"
  ) {
    throw new Error("Router orchestrator requires a runStore");
  }
  if (!transportRegistry || typeof transportRegistry.resolve !== "function") {
    throw new Error("Router orchestrator requires a transportRegistry");
  }
  if (!Number.isFinite(activeSubmissionTtlMs) || activeSubmissionTtlMs < 1) {
    throw new Error("Router active submission TTL must be a positive finite number");
  }

  async function resolveOutputArtifact(reference, signal) {
    throwIfAborted(signal);
    if (!reference?.id || typeof artifactResolver !== "function") {
      throw new Error("Router output artifact must resolve through artifact-store by id");
    }
    const artifact = await awaitWithAbort(artifactResolver(reference.id, { signal }), signal);
    throwIfAborted(signal);
    if (!artifact || String(artifact.id || "") !== String(reference.id)) {
      throw new Error(`Router output artifact id mismatch: ${reference.id}`);
    }
    if (!artifact.filePath) {
      throw new Error(`Router output artifact has no filePath: ${reference.id}`);
    }
    throwIfAborted(signal);
    const fileStats = await stat(path.resolve(artifact.filePath));
    throwIfAborted(signal);
    if (!fileStats.isFile() || fileStats.size <= 0) {
      throw new Error(`Router output artifact is not a non-empty file: ${reference.id}`);
    }
    return artifact;
  }

  async function materializeStageResult(run, stage, transportResult, signal) {
    throwIfAborted(signal);
    const projectRoot = validateTargetRepo(run.targetRepo);
    const runDirectory = path.join(projectRoot, ".bridge", "artifacts", run.id);
    const inputArtifactIds = new Set(
      (stage.inputArtifacts || []).map((artifact) => String(artifact?.id || "")).filter(Boolean)
    );
    const inputArtifactHashes = new Set(
      (stage.inputArtifacts || [])
        .map((artifact) => String(artifact?.contentHashSha256 || "").toLowerCase())
        .filter(Boolean)
    );
    const resolvedArtifacts = [];
    const seenOutputIds = new Set();
    for (const reference of transportResult.artifacts || []) {
      const referenceId = String(reference?.id || "");
      if (!referenceId || seenOutputIds.has(referenceId)) {
        continue;
      }
      seenOutputIds.add(referenceId);
      const artifact = await resolveOutputArtifact(reference, signal);
      throwIfAborted(signal);
      const artifactHash = String(artifact.contentHashSha256 || "").toLowerCase();
      if (
        inputArtifactIds.has(String(artifact.id)) ||
        (artifactHash && inputArtifactHashes.has(artifactHash))
      ) {
        continue;
      }
      resolvedArtifacts.push(artifact);
    }

    if (
      transportKindForStage(run, stage) === "image_request" &&
      !resolvedArtifacts.some(imageArtifactLike)
    ) {
      throw new Error("Router image stage did not return a new real image artifact");
    }

    throwIfAborted(signal);
    await mkdir(runDirectory, { recursive: true });
    throwIfAborted(signal);
    const textPath = path.join(runDirectory, `${sanitizeFilename(stage.id)}.md`);
    const reservedNames = new Set(
      run.stages.flatMap((candidate) => [
        `${sanitizeFilename(candidate.id)}.md`,
        ...(candidate.projectArtifactPaths || []).map((item) => path.basename(item))
      ]).map((item) => item.toLowerCase())
    );
    const projectArtifactPaths = [textPath];
    const artifactIds = [];
    const pendingOutputs = [
      {
        destination: textPath,
        temporaryPath: materializationTemporaryPath(textPath),
        kind: "text",
        content: `${transportResult.replyText || ""}\n`
      }
    ];

    for (const artifact of resolvedArtifacts) {
      throwIfAborted(signal);
      const filename = sanitizeFilename(
        artifact.filename || path.basename(artifact.filePath) || artifact.id || "artifact"
      );
      const destination = deterministicArtifactDestination(
        runDirectory,
        filename,
        artifact.id,
        reservedNames
      );
      pendingOutputs.push({
        destination,
        temporaryPath: materializationTemporaryPath(destination),
        kind: "artifact",
        sourcePath: artifact.filePath
      });
      projectArtifactPaths.push(destination);
      artifactIds.push(String(artifact.id));
    }

    try {
      for (const output of pendingOutputs) {
        throwIfAborted(signal);
        if (output.kind === "text") {
          await writeFile(output.temporaryPath, output.content, {
            encoding: "utf8",
            flag: "wx",
            signal
          });
        } else {
          await pipeline(
            createReadStream(output.sourcePath),
            createWriteStream(output.temporaryPath, { flags: "wx" }),
            { signal }
          );
        }
        throwIfAborted(signal);
      }
    } catch (error) {
      const cleanupErrors = await cleanupKnownPaths(
        pendingOutputs.map((output) => output.temporaryPath),
        unlinkFile
      );
      const primaryError = signal?.aborted ? abortError(signal) : error;
      throw attachCleanupErrors(primaryError, cleanupErrors);
    }

    throwIfAborted(signal);
    const newlyPublished = [];
    try {
      for (const output of pendingOutputs) {
        throwIfAborted(signal);
        const existing = await stat(output.destination).catch((error) => {
          if (error.code === "ENOENT") {
            return null;
          }
          throw error;
        });
        throwIfAborted(signal);
        if (existing) {
          await unlinkIfPresent(output.temporaryPath, unlinkFile);
          throwIfAborted(signal);
          continue;
        }
        throwIfAborted(signal);
        await rename(output.temporaryPath, output.destination);
        newlyPublished.push(output.destination);
        throwIfAborted(signal);
      }
      throwIfAborted(signal);
    } catch (error) {
      const cleanupErrors = await cleanupKnownPaths(
        [
          ...newlyPublished,
          ...pendingOutputs.map((output) => output.temporaryPath)
        ],
        unlinkFile
      );
      const primaryError = signal?.aborted ? abortError(signal) : error;
      throw attachCleanupErrors(primaryError, cleanupErrors);
    }

    let rolledBack = false;
    return {
      artifactIds,
      projectArtifactPaths: uniquePaths(projectArtifactPaths),
      published: true,
      async rollback() {
        if (rolledBack) {
          return [];
        }
        rolledBack = true;
        return cleanupKnownPaths(
          [
            ...newlyPublished,
            ...pendingOutputs.map((output) => output.temporaryPath)
          ],
          unlinkFile
        );
      }
    };
  }

  async function markStageFailed(run, scope, stageIndex, error, status = "failed", signal) {
    throwIfAborted(signal);
    const completedAt = nowIso(clock);
    const message = errorText(error) || (status === "cancelled" ? "Router run cancelled" : "GPT stage failed");
    return runStore.update(run.id, scope, (current) => {
      throwIfAborted(signal);
      if (!canApplyStageSnapshot(current, run, stageIndex)) {
        return current;
      }
      return {
        ...current,
        status,
        currentStageIndex: stageIndex,
        error: message,
        stages: current.stages.map((stage, index) =>
          index === stageIndex
            ? {
                ...stage,
                status,
                submissionState: stage.transportRequestId ? "submitted" : stage.submissionState,
                completedAt,
                error: message
              }
            : stage
        )
      };
    }, { signal });
  }

  async function markTransportRequestTerminal(
    runId,
    scope,
    stageId,
    requestId,
    error,
    status = "failed",
    options = {}
  ) {
    throwIfAborted(options.signal);
    const canonicalStageId = String(stageId || "").trim();
    const canonicalRequestId = String(requestId || "").trim();
    if (!canonicalStageId || !canonicalRequestId) {
      throw new Error("Router stage id and transport request id are required for a terminal update");
    }
    const completedAt = nowIso(clock);
    const message =
      errorText(error) || (status === "cancelled" ? "Router run cancelled" : "GPT stage failed");
    return runStore.update(runId, scope, (current) => {
      throwIfAborted(options.signal);
      if (TERMINAL_STATUSES.has(current.status)) {
        return current;
      }
      const stageIndex = current.stages.findIndex(
        (stage) =>
          stage.id === canonicalStageId && stage.transportRequestId === canonicalRequestId
      );
      if (stageIndex === -1 || TERMINAL_STATUSES.has(current.stages[stageIndex].status)) {
        return current;
      }
      if (
        options.expectedSubmissionOwnerToken &&
        current.stages[stageIndex].submissionOwnerToken !==
          options.expectedSubmissionOwnerToken
      ) {
        return current;
      }
      return {
        ...current,
        status,
        currentStageIndex: stageIndex,
        error: message,
        stages: current.stages.map((stage, index) =>
          index === stageIndex
            ? {
                ...stage,
                status,
                submissionState:
                  options.markSubmitted === false ? stage.submissionState : "submitted",
                completedAt,
                error: message
              }
            : stage
        )
      };
    }, { signal: options.signal });
  }

  async function cancelFirstIncompleteUnsubmittedStage(runId, scope, reason, signal) {
    const completedAt = nowIso(clock);
    const message = errorText(reason) || "Router run cancelled";
    return runStore.update(runId, scope, (current) => {
      throwIfAborted(signal);
      if (TERMINAL_STATUSES.has(current.status)) {
        return current;
      }
      const stageIndex = firstIncompleteStageIndex(current);
      if (stageIndex === -1) {
        return {
          ...current,
          status: "succeeded",
          currentStageIndex: current.stages.length - 1,
          error: null
        };
      }
      const stage = current.stages[stageIndex];
      if (stage.transportRequestId) {
        return current;
      }
      return {
        ...current,
        status: "cancelled",
        currentStageIndex: stageIndex,
        error: message,
        stages: current.stages.map((candidate, index) =>
          index === stageIndex
            ? {
                ...candidate,
                status: "cancelled",
                completedAt,
                error: message
              }
            : candidate
        )
      };
    }, { signal });
  }

  async function applySucceededTransportResultByRequestId(
    runId,
    scope,
    stageId,
    requestId,
    transportResult,
    options = {}
  ) {
    throwIfAborted(options.signal);
    const canonicalStageId = String(stageId || "").trim();
    const canonicalRequestId = String(requestId || "").trim();
    let resultCommitted = false;
    return runStore.withFinalizationLease(runId, scope, async (snapshot) => {
      throwIfAborted(options.signal);
      if (TERMINAL_STATUSES.has(snapshot.status)) {
        return snapshot;
      }
      const snapshotStageIndex = snapshot.stages.findIndex(
        (stage) =>
          stage.id === canonicalStageId && stage.transportRequestId === canonicalRequestId
      );
      if (
        snapshotStageIndex === -1 ||
        TERMINAL_STATUSES.has(snapshot.stages[snapshotStageIndex].status)
      ) {
        return snapshot;
      }

      try {
        const materialized = await materializeStageResult(
          snapshot,
          snapshot.stages[snapshotStageIndex],
          transportResult,
          options.signal
        );
        const completedAt = nowIso(clock);
        const resultWasApplied = (candidate) => {
          const candidateStage = candidate?.stages?.find(
            (stage) =>
              stage.id === canonicalStageId && stage.transportRequestId === canonicalRequestId
          );
          const candidatePaths = new Set(candidateStage?.projectArtifactPaths || []);
          return candidateStage?.status === "succeeded" &&
            materialized.projectArtifactPaths.every((item) => candidatePaths.has(item));
        };
        let updated;
        try {
          updated = await runStore.update(runId, scope, (current) => {
            throwIfAborted(options.signal);
            if (TERMINAL_STATUSES.has(current.status)) {
              return current;
            }
            const stageIndex = current.stages.findIndex(
              (stage) =>
                stage.id === canonicalStageId && stage.transportRequestId === canonicalRequestId
            );
            if (stageIndex === -1 || TERMINAL_STATUSES.has(current.stages[stageIndex].status)) {
              return current;
            }
            if (current.stages[stageIndex].cancelRequestedAt) {
              return current;
            }
            const stages = current.stages.map((stage, index) =>
              index === stageIndex
                ? {
                    ...stage,
                    status: "succeeded",
                    replyText: transportResult.replyText || "",
                    artifactIds: materialized.artifactIds,
                    submissionState: "submitted",
                    projectArtifactPaths: materialized.projectArtifactPaths,
                    completedAt,
                    error: null
                  }
                : stage
            );
            const nextStageIndex = stages.findIndex((stage) => stage.status !== "succeeded");
            return {
              ...current,
              status: nextStageIndex === -1 ? "succeeded" : "pending",
              currentStageIndex: nextStageIndex === -1 ? stageIndex : nextStageIndex,
              stages,
              projectArtifactPaths: uniquePaths(
                stages.flatMap((stage) => stage.projectArtifactPaths || [])
              ),
              error: null
            };
          }, { signal: options.signal });
        } catch (error) {
          const persisted = await runStore.get(runId, scope).catch(() => null);
          if (resultWasApplied(persisted)) {
            resultCommitted = true;
            options.onCommitted?.(persisted);
            return persisted;
          }
          const cleanupErrors = await materialized.rollback();
          const primaryError = options.signal?.aborted ? abortError(options.signal) : error;
          throw attachCleanupErrors(primaryError, cleanupErrors);
        }
        if (!resultWasApplied(updated)) {
          const cleanupErrors = await materialized.rollback();
          if (cleanupErrors.length === 1) {
            throw cleanupErrors[0];
          }
          if (cleanupErrors.length > 1) {
            throw new AggregateError(cleanupErrors, "Router materialization rollback failed");
          }
        }
        if (resultWasApplied(updated)) {
          resultCommitted = true;
          options.onCommitted?.(updated);
        }
        return updated;
      } catch (error) {
        if (options.signal?.aborted) {
          if (error?.code === "ABORT_ERR" || Array.isArray(error?.cleanupErrors)) {
            throw error;
          }
          throw abortError(options.signal);
        }
        return markTransportRequestTerminal(
          runId,
          scope,
          canonicalStageId,
          canonicalRequestId,
          error,
          "failed",
          options
        );
      }
    }, {
      signal: options.signal,
      commitOnOperationReturn: () => resultCommitted
    });
  }

  async function applyTransportResult(run, scope, stageIndex, transportResult, options = {}) {
    throwIfAborted(options.signal);
    const expectedStage = run.stages[stageIndex];
    if (["failed", "cancelled"].includes(transportResult.status)) {
      return markTransportRequestTerminal(
        run.id,
        scope,
        expectedStage.id,
        transportResult.requestId || expectedStage.transportRequestId,
        transportResult.error,
        transportResult.status,
        options
      );
    }
    if (transportResult.status !== "succeeded") {
      return runStore.update(run.id, scope, (current) => {
        throwIfAborted(options.signal);
        if (!canApplyStageSnapshot(current, run, stageIndex)) {
          return current;
        }
        const currentStage = current.stages[stageIndex];
        if (
          currentStage.transportRequestId &&
          currentStage.transportRequestId !== transportResult.requestId
        ) {
          return current;
        }
        return {
          ...current,
          status: transportResult.status,
          currentStageIndex: stageIndex,
          stages: current.stages.map((stage, index) =>
            index === stageIndex
              ? {
                  ...stage,
                  status: transportResult.status,
                  transportRequestId: transportResult.requestId || stage.transportRequestId,
                  submissionState: "submitted"
                }
              : stage
          )
        };
      }, { signal: options.signal });
    }

    return applySucceededTransportResultByRequestId(
      run.id,
      scope,
      expectedStage.id,
      transportResult.requestId || expectedStage.transportRequestId,
      transportResult,
      options
    );
  }

  function result(run, transportResult = null) {
    return {
      routerRun: run,
      transportResult,
      projectArtifactPaths: run.projectArtifactPaths || []
    };
  }

  async function driveRun(run, scope, driveOptions = {}) {
    const signal = driveOptions.signal;
    throwIfAborted(signal);
    if (TERMINAL_STATUSES.has(run.status)) {
      return result(run);
    }
    const transport = transportRegistry.resolve(run.transportId);
    const waitThrough = driveOptions.waitForGpt === true;
    const configuredObservationBudgetMs = Number(driveOptions.waitOptions?.timeoutMs);
    const observationDeadlineMs =
      waitThrough &&
      Number.isFinite(configuredObservationBudgetMs) &&
      configuredObservationBudgetMs > 0
        ? nowMs() + configuredObservationBudgetMs
        : null;
    let waitOneExisting = driveOptions.resume === true && !waitThrough;
    let latestTransportResult = null;

    function currentWaitOptions() {
      const waitOptions = { ...(driveOptions.waitOptions || {}), signal };
      if (observationDeadlineMs == null) {
        return waitOptions;
      }
      waitOptions.timeoutMs = Math.max(1, observationDeadlineMs - nowMs());
      waitOptions.timeoutGraceMs = 0;
      return waitOptions;
    }

    while (true) {
      throwIfAborted(signal);
      const stageIndex = firstIncompleteStageIndex(run);
      if (stageIndex === -1) {
        if (run.status !== "succeeded") {
          throwIfAborted(signal);
          run = await runStore.update(run.id, scope, (current) => {
            throwIfAborted(signal);
            return TERMINAL_STATUSES.has(current.status)
              ? current
              : {
                  ...current,
                  status: "succeeded",
                  currentStageIndex: current.stages.length - 1,
                  error: null
                };
          }, { signal });
        }
        return result(run, latestTransportResult);
      }

      const stage = run.stages[stageIndex];
      if (["failed", "cancelled"].includes(stage.status)) {
        if (run.status !== stage.status) {
          throwIfAborted(signal);
          run = await runStore.update(run.id, scope, (current) => {
            throwIfAborted(signal);
            if (TERMINAL_STATUSES.has(current.status)) {
              return current;
            }
            const currentStage = current.stages[stageIndex];
            if (
              !currentStage ||
              currentStage.id !== stage.id ||
              currentStage.status !== stage.status ||
              currentStage.submissionState !== stage.submissionState ||
              currentStage.transportRequestId !== stage.transportRequestId
            ) {
              return current;
            }
            return {
              ...current,
              status: currentStage.status,
              currentStageIndex: stageIndex,
              error: currentStage.error
            };
          }, { signal });
        }
        return result(run, latestTransportResult);
      }

      if (stage.transportRequestId && stage.submissionState !== "prepared") {
        if (stage.cancelRequestedAt) {
          const cancelledRun = await consumeSubmittingCancelIntent(
            run,
            scope,
            stage,
            transport,
            signal
          );
          if (cancelledRun) {
            return result(cancelledRun, latestTransportResult);
          }
        }
        if (!waitThrough && !waitOneExisting) {
          return result(run, latestTransportResult);
        }
        waitOneExisting = false;
        try {
          throwIfAborted(signal);
          const waitPromise = transport.wait(stage.transportRequestId, currentWaitOptions());
          latestTransportResult = validateTransportResult(
            await awaitWithAbort(waitPromise, signal),
            run.transportId,
            stage.transportRequestId
          );
        } catch (error) {
          if (signal?.aborted) {
            throw abortError(signal);
          }
          run = await markStageFailed(run, scope, stageIndex, error, "failed", signal);
          return result(run, latestTransportResult);
        }
        throwIfAborted(signal);
        const cancelledRun = await consumeSubmittingCancelIntent(
          run,
          scope,
          stage,
          transport,
          signal
        );
        if (cancelledRun) {
          return result(cancelledRun, latestTransportResult);
        }
        run = await applyTransportResult(run, scope, stageIndex, latestTransportResult, {
          signal,
          onCommitted: driveOptions.onCommitted
        });
        if (TERMINAL_STATUSES.has(run.status)) {
          return result(run, latestTransportResult);
        }
        if (latestTransportResult.status !== "succeeded") {
          return result(run, latestTransportResult);
        }
        if (driveOptions.settleOnlyExistingTransport === true) {
          return result(run, latestTransportResult);
        }
        continue;
      }

      const dependency = stage.dependsOn
        ? run.stages.find((candidate) => candidate.id === stage.dependsOn)
        : null;
      if (dependency && dependency.status !== "succeeded") {
        run = await markStageFailed(
          run,
          scope,
          stageIndex,
          `Router stage dependency is not succeeded: ${stage.dependsOn}`,
          "failed",
          signal
        );
        return result(run, latestTransportResult);
      }
      if (run.stages.slice(0, stageIndex).some((candidate) => candidate.status !== "succeeded")) {
        run = await markStageFailed(
          run,
          scope,
          stageIndex,
          "Router stages must execute strictly in order",
          "failed",
          signal
        );
        return result(run, latestTransportResult);
      }

      const recoveringPreparedRequest =
        Boolean(stage.transportRequestId) && stage.submissionState === "prepared";
      let payloadText = recoveringPreparedRequest
        ? stage.payloadText
        : payloadForStage(run, stageIndex, {
            preservesConversationContext: transport.preservesConversationContext === true
          });
      let startedAt = stage.startedAt || nowIso(clock);
      let transportRequestId =
        stage.transportRequestId ||
        String(
          transportRequestIdFactory({
            run,
            stage,
            sequence: ++transportRequestSequence
          })
        ).trim();
      if (!transportRequestId) {
        run = await markStageFailed(
          run,
          scope,
          stageIndex,
          "Router transport request id factory returned an empty id",
          "failed",
          signal
        );
        return result(run, latestTransportResult);
      }

      if (!recoveringPreparedRequest) {
        throwIfAborted(signal);
        run = await runStore.update(run.id, scope, (current) => {
          throwIfAborted(signal);
          if (!canApplyStageSnapshot(current, run, stageIndex)) {
            return current;
          }
          return {
            ...current,
            status: "running",
            currentStageIndex: stageIndex,
            stages: current.stages.map((candidate, index) =>
              index === stageIndex
                ? {
                    ...candidate,
                    status: "running",
                    payloadText,
                    transportRequestId,
                    submissionState: "prepared",
                    startedAt,
                    error: null
                  }
                : candidate
            )
          };
        }, { signal });
        if (TERMINAL_STATUSES.has(run.status)) {
          return result(run, latestTransportResult);
        }
        const persistedPreparedStage = run.stages[stageIndex];
        if (
          !persistedPreparedStage ||
          persistedPreparedStage.id !== stage.id ||
          persistedPreparedStage.transportRequestId !== transportRequestId ||
          persistedPreparedStage.submissionState !== "prepared"
        ) {
          continue;
        }
        payloadText = persistedPreparedStage.payloadText;
        startedAt = persistedPreparedStage.startedAt;
        transportRequestId = persistedPreparedStage.transportRequestId;
      }

      const preparedStage = run.stages[stageIndex];
      if (
        !preparedStage ||
        preparedStage.id !== stage.id ||
        preparedStage.transportRequestId !== transportRequestId ||
        preparedStage.submissionState !== "prepared"
      ) {
        continue;
      }

      const submissionInput = {
        requestId: transportRequestId,
        stageId: preparedStage.id,
        title: preparedStage.title,
        text: payloadText,
        payloadText,
        kind: transportKindForStage(run, preparedStage),
        routingKind: run.routeKind,
        workspace: workspaceFromRun(run),
        modePreference: run.modePreference,
        modelPreference: run.modelPreference,
        signal,
        metadata: {
          routerRunId: run.id,
          routerStageId: stage.id,
          projectId: run.projectId,
          conversationId: run.conversationId,
          currentCodexThreadId: run.codexThreadId
        }
      };
      const inputArtifacts = Array.isArray(preparedStage.inputArtifacts)
        ? preparedStage.inputArtifacts
        : [];
      if (inputArtifacts.length > 0) {
        submissionInput.artifacts = inputArtifacts;
      }

      let submissionOutcome;
      try {
        throwIfAborted(signal);
        submissionOutcome = await runStore.withSubmissionLease(
          run.id,
          scope,
          async (latestBeforeSubmission) => {
            throwIfAborted(signal);
            if (TERMINAL_STATUSES.has(latestBeforeSubmission.status)) {
              return {
                run: latestBeforeSubmission,
                transportResult: null,
                skipped: true,
                error: null
              };
            }
            const leasedStageIndex = latestBeforeSubmission.stages.findIndex(
              (candidate) =>
                candidate.id === preparedStage.id &&
                candidate.transportRequestId === transportRequestId
            );
            const leasedStage = latestBeforeSubmission.stages[leasedStageIndex];
            if (!leasedStage || leasedStage.submissionState !== "prepared") {
              return {
                run: latestBeforeSubmission,
                transportResult: null,
                skipped: true,
                error: null
              };
            }

            const submissionOwnerToken = submissionOwnerTokenFactory({
              runId: latestBeforeSubmission.id,
              stageId: leasedStage.id,
              requestId: transportRequestId
            });
            const reservedSubmission = reserveActiveSubmission(
              latestBeforeSubmission.id,
              transportRequestId,
              submissionOwnerToken
            );
            let submittingRun;
            try {
              submittingRun = await runStore.update(
                latestBeforeSubmission.id,
                scope,
                (current) => {
                  throwIfAborted(signal);
                  if (TERMINAL_STATUSES.has(current.status)) {
                    return current;
                  }
                  const currentStageIndex = current.stages.findIndex(
                    (candidate) =>
                      candidate.id === leasedStage.id &&
                      candidate.transportRequestId === transportRequestId
                  );
                  const currentStage = current.stages[currentStageIndex];
                  if (!currentStage || currentStage.submissionState !== "prepared") {
                    return current;
                  }
                  return {
                    ...current,
                    stages: current.stages.map((candidate, index) =>
                      index === currentStageIndex
                        ? {
                            ...candidate,
                            submissionState: "submitting",
                            submissionOwnerPid: process.pid,
                            submissionOwnerToken
                          }
                        : candidate
                    )
                  };
                },
                { signal }
              );
              throwIfAborted(signal);
            } catch (error) {
              const persisted = await runStore.get(latestBeforeSubmission.id, scope).catch(() => null);
              const persistedStage = persisted?.stages?.find(
                (candidate) =>
                  candidate.id === leasedStage.id &&
                  candidate.transportRequestId === transportRequestId
              );
              if (
                persistedStage?.submissionState !== "submitting" ||
                persistedStage?.submissionOwnerToken !== submissionOwnerToken
              ) {
                forgetActiveSubmission(
                  latestBeforeSubmission.id,
                  transportRequestId,
                  submissionOwnerToken
                );
              }
              throw error;
            }
            const submittingStageIndex = submittingRun.stages.findIndex(
              (candidate) =>
                candidate.id === leasedStage.id &&
                candidate.transportRequestId === transportRequestId
            );
            const submittingStage = submittingRun.stages[submittingStageIndex];
            if (
              !submittingStage ||
              submittingStage.submissionState !== "submitting" ||
              submittingStage.submissionOwnerToken !== submissionOwnerToken
            ) {
              forgetActiveSubmission(
                submittingRun.id,
                transportRequestId,
                submissionOwnerToken
              );
              return {
                run: submittingRun,
                transportResult: null,
                skipped: true,
                error: null
              };
            }

            let submittedResult;
            let activeSubmission;
            try {
              throwIfAborted(signal);
              activeSubmission = activateReservedSubmission(
                reservedSubmission,
                () =>
                  inputArtifacts.length > 0
                    ? transport.submitArtifacts(submissionInput)
                    : transport.submitText(submissionInput),
                activeSubmissionTtlMs
              );
              submittedResult = validateTransportResult(
                await awaitWithAbort(activeSubmission.promise, signal),
                latestBeforeSubmission.transportId,
                transportRequestId
              );
              throwIfAborted(signal);
            } catch (error) {
              if (signal?.aborted) {
                if (activeSubmission) {
                  observeAbortedSubmissionSettlement({
                    activeSubmission,
                    runId: submittingRun.id,
                    scope,
                    stageId: submittingStage.id,
                    requestId: transportRequestId,
                    ownerToken: submissionOwnerToken,
                    transport
                  });
                }
                throw abortError(signal);
              }
              const failedRun = await markTransportRequestTerminal(
                submittingRun.id,
                scope,
                submittingStage.id,
                transportRequestId,
                error,
                "failed",
                { signal }
              );
              forgetActiveSubmission(
                submittingRun.id,
                transportRequestId,
                submissionOwnerToken
              );
              return {
                run: failedRun,
                transportResult: null,
                skipped: false,
                error
              };
            }

            const cancelledRun = await consumeSubmittingCancelIntent(
              submittingRun,
              scope,
              submittingStage,
              transport,
              signal
            );
            if (cancelledRun) {
              forgetActiveSubmission(
                submittingRun.id,
                transportRequestId,
                submissionOwnerToken
              );
              return {
                run: cancelledRun,
                transportResult: submittedResult,
                skipped: false,
                error: null
              };
            }
            let updatedRun = await applyTransportResult(
              submittingRun,
              scope,
              submittingStageIndex,
              submittedResult,
              { signal, onCommitted: driveOptions.onCommitted }
            );
            const updatedStage = updatedRun.stages.find(
              (candidate) =>
                candidate.id === submittingStage.id &&
                candidate.transportRequestId === transportRequestId
            );
            if (!TERMINAL_STATUSES.has(updatedRun.status) && updatedStage?.cancelRequestedAt) {
              updatedRun = await consumeSubmittingCancelIntent(
                updatedRun,
                scope,
                updatedStage,
                transport,
                signal
              ) || updatedRun;
            }
            forgetActiveSubmission(
              submittingRun.id,
              transportRequestId,
              submissionOwnerToken
            );
            return {
              run: updatedRun,
              transportResult: submittedResult,
              skipped: false,
              error: null
            };
          },
          { signal }
        );
      } catch (error) {
        if (signal?.aborted) {
          throw abortError(signal);
        }
        run = await markTransportRequestTerminal(
          run.id,
          scope,
          preparedStage.id,
          transportRequestId,
          error,
          "failed",
          { signal }
        );
        return result(run, latestTransportResult);
      }

      run = submissionOutcome.run;
      if (submissionOutcome.transportResult) {
        latestTransportResult = submissionOutcome.transportResult;
      }
      if (submissionOutcome.error) {
        return result(run, latestTransportResult);
      }
      if (submissionOutcome.skipped) {
        if (TERMINAL_STATUSES.has(run.status)) {
          return result(run, latestTransportResult);
        }
        continue;
      }
      if (
        run.status === "cancelled" &&
        ["queued", "running"].includes(latestTransportResult.status)
      ) {
        try {
          await transport.cancel(transportRequestId, {
            reason: run.error || "Router run cancelled"
          });
        } catch {
          // The run is already terminal; this is a best-effort cleanup for a submit/cancel race.
        }
      }
      if (TERMINAL_STATUSES.has(run.status)) {
        return result(run, latestTransportResult);
      }
      if (latestTransportResult.status === "succeeded") {
        if (waitThrough) {
          continue;
        }
        return result(run, latestTransportResult);
      }
      if (!waitThrough) {
        return result(run, latestTransportResult);
      }
    }
  }

  async function startRouterRun(input = {}) {
    throwIfAborted(input.signal);
    const route = input.route || {};
    const originalRequestText = String(input.originalRequestText || "").trim();
    if (!originalRequestText) {
      throw new Error("Router run originalRequestText is required");
    }
    assertWorkspaceScope(input.workspace, input.scope);
    const transportId =
      route.kind === "codex_only"
        ? String(input.transportId || "web-sync")
        : transportRegistry.resolve(input.transportId).id;
    const stages = stagesForRoute(route, originalRequestText, input.artifacts || []);
    const run = await runStore.create({
      ...input.scope,
      routeKind: route.kind,
      syncKind: route.syncKind || null,
      transportId,
      autoAdvanceOnTransportTerminal: input.waitForGpt === true,
      originalRequestText,
      targetRepo: input.workspace.targetRepo,
      chatgptProjectUrl: input.workspace.chatgptProjectUrl,
      modePreference: input.workspace.modePreference,
      modelPreference: input.workspace.modelPreference,
      routingDecision: route.decisionSource
        ? {
            source: route.decisionSource,
            policyVersion: route.policyVersion || null,
            confidence: route.confidence ?? null,
            needsClarification: route.needsClarification === true,
            proposal: route.routingProposal || null
          }
        : null,
      status: route.kind === "codex_only" ? "succeeded" : "pending",
      currentStageIndex: stages.length > 0 ? 0 : -1,
      stages
    });
    if (route.kind === "codex_only") {
      return result(run);
    }
    let durableCommit = false;
    const onCommitted = () => {
      durableCommit = true;
    };
    const commitPoint = () => durableCommit;
    return withRunLock(runLockKey(run.id, input.scope), () =>
      runStore.withRunLease(run.id, input.scope, (leasedRun) =>
        driveRun(leasedRun, input.scope, {
          waitForGpt: input.waitForGpt,
          waitOptions: input.waitOptions,
          resume: false,
          signal: input.signal,
          onCommitted
        }),
        { signal: input.signal, commitOnOperationReturn: commitPoint }
      ),
      { signal: input.signal, commitOnOperationReturn: commitPoint }
    );
  }

  async function continueRouterRun(input = {}) {
    throwIfAborted(input.signal);
    let durableCommit = false;
    const onCommitted = () => {
      durableCommit = true;
    };
    const commitPoint = () => durableCommit;
    return withRunLock(runLockKey(input.runId, input.scope), () =>
      runStore.withRunLease(input.runId, input.scope, async (leasedRun) => {
        throwIfAborted(input.signal);
        let run = leasedRun;
        const expectedTransportRequestId = String(
          input.expectedTransportRequestId || ""
        ).trim();
        if (expectedTransportRequestId) {
          const expectedStageIndex = run.stages.findIndex(
            (stage) => stage.transportRequestId === expectedTransportRequestId
          );
          if (expectedStageIndex === -1) {
            return result(run);
          }
          const expectedStage = run.stages[expectedStageIndex];
          const firstIncompleteIndex = firstIncompleteStageIndex(run);
          const exactActiveStage =
            firstIncompleteIndex === expectedStageIndex ||
            (run.status === "failed" &&
              expectedStage.status === "failed" &&
              run.currentStageIndex === expectedStageIndex);
          const completedStageCanQueueNext =
            expectedStage.status === "succeeded" &&
            firstIncompleteIndex === expectedStageIndex + 1 &&
            !run.stages[firstIncompleteIndex]?.transportRequestId;
          const terminalStageCanBeFinalized =
            firstIncompleteIndex === -1 &&
            !TERMINAL_STATUSES.has(run.status) &&
            expectedStageIndex === run.stages.length - 1;
          if (
            !exactActiveStage &&
            !completedStageCanQueueNext &&
            !terminalStageCanBeFinalized
          ) {
            return result(run);
          }
        }
        if (run.status === "failed") {
          const stage = run.stages[run.currentStageIndex];
          if (
            !stage ||
            stage.status !== "failed" ||
            stage.submissionState !== "submitted" ||
            !stage.transportRequestId
          ) {
            return result(run);
          }
          const transport = transportRegistry.resolve(run.transportId);
          let lateTransportResult;
          try {
            throwIfAborted(input.signal);
            const waitPromise = transport.wait(stage.transportRequestId, {
              ...(input.waitOptions || {}),
              signal: input.signal
            });
            lateTransportResult = validateTransportResult(
              await awaitWithAbort(waitPromise, input.signal),
              run.transportId,
              stage.transportRequestId
            );
          } catch (error) {
            if (input.signal?.aborted) {
              throw abortError(input.signal);
            }
            return result(run);
          }
          if (lateTransportResult.status !== "succeeded") {
            return result(run, lateTransportResult);
          }
          throwIfAborted(input.signal);
          run = await runStore.reopenFailedStageForSucceededTransport(run.id, input.scope, {
            transportRequestId: stage.transportRequestId,
            signal: input.signal
          });
          throwIfAborted(input.signal);
          run = await applySucceededTransportResultByRequestId(
            run.id,
            input.scope,
            stage.id,
            stage.transportRequestId,
            lateTransportResult,
            { signal: input.signal, onCommitted }
          );
          if (input.waitForGpt !== true || TERMINAL_STATUSES.has(run.status)) {
            return result(run, lateTransportResult);
          }
        }
        return driveRun(run, input.scope, {
          waitForGpt: input.waitForGpt,
          waitOptions: input.waitOptions,
          resume: true,
          settleOnlyExistingTransport: input.settleOnlyExistingTransport === true,
          signal: input.signal,
          onCommitted
        });
      }, { signal: input.signal, commitOnOperationReturn: commitPoint }),
      { signal: input.signal, commitOnOperationReturn: commitPoint }
    );
  }

  async function cancelSubmittingStageLocally(run, scope, stage, reason, signal) {
    return runStore.withSubmissionLease(
      run.id,
      scope,
      async (latest) => {
        throwIfAborted(signal);
        if (TERMINAL_STATUSES.has(latest.status)) {
          return latest;
        }
        const latestStage = latest.stages.find(
          (candidate) =>
            candidate.id === stage.id &&
            candidate.transportRequestId === stage.transportRequestId
        );
        if (!latestStage || latestStage.submissionState !== "submitting") {
          return latest;
        }
        return markTransportRequestTerminal(
          latest.id,
          scope,
          latestStage.id,
          latestStage.transportRequestId,
          reason,
          "cancelled",
          { markSubmitted: false, signal }
        );
      },
      { signal }
    );
  }

  async function recordSubmittingStageCancelIntent(run, scope, stage, reason, signal) {
    const requestedAt = nowIso(clock);
    throwIfAborted(signal);
    return runStore.update(run.id, scope, (current) => {
      if (TERMINAL_STATUSES.has(current.status)) {
        return current;
      }
      return {
        ...current,
        stages: current.stages.map((candidate) =>
          candidate.id === stage.id &&
          candidate.transportRequestId === stage.transportRequestId &&
          candidate.submissionState === "submitting"
            ? {
                ...candidate,
                cancelRequestedAt: candidate.cancelRequestedAt || requestedAt,
                cancelReason: reason
              }
            : candidate
        )
      };
    }, { signal });
  }

  async function consumeSubmittingCancelIntent(run, scope, stage, transport, signal) {
    const latest = await runStore.get(run.id, scope);
    if (TERMINAL_STATUSES.has(latest.status)) {
      return latest;
    }
    const latestStage = latest.stages.find(
      (candidate) =>
        candidate.id === stage.id &&
        candidate.transportRequestId === stage.transportRequestId
    );
    if (!latestStage?.cancelRequestedAt) {
      return null;
    }
    try {
      await transport.cancel(latestStage.transportRequestId, {
        reason: latestStage.cancelReason || "Router run cancelled"
      });
    } catch {
      // The local terminal intent is authoritative once the submit owner observes it.
    }
    return markTransportRequestTerminal(
      latest.id,
      scope,
      latestStage.id,
      latestStage.transportRequestId,
      latestStage.cancelReason || "Router run cancelled",
      "cancelled",
      { signal }
    );
  }

  function observeAbortedSubmissionSettlement({
    activeSubmission,
    runId,
    scope,
    stageId,
    requestId,
    ownerToken,
    transport
  }) {
    const settle = async () => {
      try {
        await runStore.withSubmissionLease(runId, scope, async (latest) => {
          if (TERMINAL_STATUSES.has(latest.status)) {
            return latest;
          }
          const latestStage = latest.stages.find(
            (candidate) =>
              candidate.id === stageId &&
              candidate.transportRequestId === requestId &&
              candidate.submissionState === "submitting" &&
              candidate.submissionOwnerToken === ownerToken
          );
          if (!latestStage?.cancelRequestedAt) {
            return latest;
          }
          try {
            await transport.cancel(requestId, {
              reason: latestStage.cancelReason || "Router run cancelled"
            });
          } catch {
            // Once the exact submit owner observes persisted intent, local cancellation is final.
          }
          return markTransportRequestTerminal(
            runId,
            scope,
            stageId,
            requestId,
            latestStage.cancelReason || "Router run cancelled",
            "cancelled",
            { expectedSubmissionOwnerToken: ownerToken }
          );
        });
      } catch {
        // A future scoped resume/cancel can retry persisted intent after transient store failures.
      }
    };
    void activeSubmission.promise.then(settle, settle).catch(() => {});
  }

  async function cancelRouterRun(input = {}) {
    let transportResult = null;
    const reason = input.reason || "Router run cancelled";

    while (true) {
      let run = await runStore.get(input.runId, input.scope);
      if (TERMINAL_STATUSES.has(run.status)) {
        return result(run, transportResult);
      }

      const stageIndex = firstIncompleteStageIndex(run);
      if (stageIndex === -1) {
        run = await runStore.update(run.id, input.scope, (current) =>
          TERMINAL_STATUSES.has(current.status)
            ? current
            : {
                ...current,
                status: "succeeded",
                currentStageIndex: current.stages.length - 1,
                error: null
              }
        , { signal: input.signal });
        return result(run, transportResult);
      }

      const stage = run.stages[stageIndex];
      if (!stage.transportRequestId) {
        run = await cancelFirstIncompleteUnsubmittedStage(
          run.id,
          input.scope,
          reason,
          input.signal
        );
        if (TERMINAL_STATUSES.has(run.status)) {
          return result(run, transportResult);
        }
        continue;
      }

      const requestId = stage.transportRequestId;
      const transport = transportRegistry.resolve(run.transportId);
      const activeSubmission = stage.submissionState === "submitting"
        ? getMatchingActiveSubmission(run, stage)
        : null;
      if (activeSubmission?.status === "reserved") {
        run = await cancelSubmittingStageLocally(
          run,
          input.scope,
          stage,
          reason,
          input.signal
        );
        forgetActiveSubmission(run.id, requestId, activeSubmission.ownerToken);
        return result(run, transportResult);
      }
      if (activeSubmission?.status === "pending") {
        run = await recordSubmittingStageCancelIntent(
          run,
          input.scope,
          stage,
          reason,
          input.signal
        );
        return result(run, transportResult);
      }
      if (activeSubmission?.status === "rejected") {
        run = await cancelSubmittingStageLocally(
          run,
          input.scope,
          stage,
          reason,
          input.signal
        );
        forgetActiveSubmission(run.id, requestId, activeSubmission.ownerToken);
        return result(run, transportResult);
      }
      if (activeSubmission?.status === "fulfilled") {
        transportResult = validateTransportResult(
          activeSubmission.value,
          run.transportId,
          requestId
        );
        if (transportResult.status === "succeeded") {
          run = await applySucceededTransportResultByRequestId(
            run.id,
            input.scope,
            stage.id,
            requestId,
            transportResult,
            { signal: input.signal }
          );
          forgetActiveSubmission(run.id, requestId, activeSubmission.ownerToken);
          return result(run, transportResult);
        }
        if (["failed", "cancelled"].includes(transportResult.status)) {
          run = await markTransportRequestTerminal(
            run.id,
            input.scope,
            stage.id,
            requestId,
            transportResult.error || reason,
            transportResult.status,
            { signal: input.signal }
          );
          forgetActiveSubmission(run.id, requestId, activeSubmission.ownerToken);
          return result(run, transportResult);
        }
      }
      try {
        transportResult = validateTransportResult(
          await transport.cancel(requestId, { reason }),
          run.transportId,
          requestId
        );
      } catch (error) {
        const unconfirmedRequestWasMissing =
          ["prepared", "submitting"].includes(stage.submissionState) &&
          error?.code === "ENOENT";
        if (unconfirmedRequestWasMissing) {
          if (stage.submissionState === "submitting" && !activeSubmission) {
            const ownerPid = stage.submissionOwnerPid;
            const foreignOwnerIsDead =
              Number.isInteger(ownerPid) &&
              ownerPid !== process.pid &&
              !isProcessAlive(ownerPid);
            if (foreignOwnerIsDead) {
              run = await cancelSubmittingStageLocally(
                run,
                input.scope,
                stage,
                reason,
                input.signal
              );
            } else {
              run = await recordSubmittingStageCancelIntent(
                run,
                input.scope,
                stage,
                reason,
                input.signal
              );
            }
            return result(run, transportResult);
          }
          run = await runStore.withSubmissionLease(
            run.id,
            input.scope,
            async (latestAfterSubmission) => {
              if (TERMINAL_STATUSES.has(latestAfterSubmission.status)) {
                return latestAfterSubmission;
              }
              const latestStage = latestAfterSubmission.stages.find(
                (candidate) =>
                  candidate.id === stage.id && candidate.transportRequestId === requestId
              );
              if (!latestStage || latestStage.submissionState !== "prepared") {
                return latestAfterSubmission;
              }
              return markTransportRequestTerminal(
                latestAfterSubmission.id,
                input.scope,
                latestStage.id,
                requestId,
                reason,
                "cancelled",
                { markSubmitted: false, signal: input.signal }
              );
            },
            { signal: input.signal }
          );
          const latestStage = run.stages.find(
            (candidate) =>
              candidate.id === stage.id && candidate.transportRequestId === requestId
          );
          if (latestStage?.submissionState === "submitting") {
            return result(run, transportResult);
          }
        } else {
          run = await markTransportRequestTerminal(
            run.id,
            input.scope,
            stage.id,
            requestId,
            error,
            "failed",
            { signal: input.signal }
          );
        }
        if (TERMINAL_STATUSES.has(run.status)) {
          return result(run, transportResult);
        }
        continue;
      }

      if (transportResult.status === "succeeded") {
        run = await applySucceededTransportResultByRequestId(
          run.id,
          input.scope,
          stage.id,
          requestId,
          transportResult,
          { signal: input.signal }
        );
        if (TERMINAL_STATUSES.has(run.status)) {
          return result(run, transportResult);
        }
        continue;
      }

      if (["failed", "cancelled"].includes(transportResult.status)) {
        run = await markTransportRequestTerminal(
          run.id,
          input.scope,
          stage.id,
          requestId,
          transportResult.error || reason,
          transportResult.status,
          { signal: input.signal }
        );
      } else {
        run = await markTransportRequestTerminal(
          run.id,
          input.scope,
          stage.id,
          requestId,
          `Transport cancel did not reach a terminal status: ${transportResult.status}`,
          "failed",
          { signal: input.signal }
        );
      }
      forgetActiveSubmission(run.id, requestId, activeSubmission?.ownerToken);
      if (TERMINAL_STATUSES.has(run.status)) {
        return result(run, transportResult);
      }
    }
  }

  return {
    startRouterRun,
    continueRouterRun,
    cancelRouterRun
  };
}
