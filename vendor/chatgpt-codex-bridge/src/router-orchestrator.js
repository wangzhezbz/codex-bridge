import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const TRANSPORT_STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);
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

async function withRunLock(key, operation) {
  const previous = RUN_LOCKS.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  RUN_LOCKS.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
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
  return run.stages
    .slice(0, stageIndex)
    .filter((stage) => stage.status === "succeeded" && stage.replyText)
    .map((stage) => `## ${stage.title}\n${stage.replyText}`)
    .join("\n\n");
}

function payloadForStage(run, stageIndex) {
  const stage = run.stages[stageIndex];
  if (stageIndex === 0 && stage.payloadText.trim()) {
    return stage.payloadText;
  }
  const context = priorStageContext(run, stageIndex);
  return [
    stage.instruction || `请完成“${stage.title}”。`,
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

function transportKindForStage(run, stage) {
  return stage.id === "poster" ? "image_request" : run.syncKind || "chat_message";
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

export function createRouterOrchestrator(options = {}) {
  const runStore = options.runStore;
  const transportRegistry = options.transportRegistry;
  const artifactResolver = options.artifactResolver;
  const clock = options.clock || (() => new Date());
  const transportRequestIdFactory =
    options.transportRequestIdFactory || defaultTransportRequestIdFactory;
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

  async function resolveOutputArtifact(reference) {
    if (!reference?.id || typeof artifactResolver !== "function") {
      throw new Error("Router output artifact must resolve through artifact-store by id");
    }
    const artifact = await artifactResolver(reference.id);
    if (!artifact || String(artifact.id || "") !== String(reference.id)) {
      throw new Error(`Router output artifact id mismatch: ${reference.id}`);
    }
    if (!artifact.filePath) {
      throw new Error(`Router output artifact has no filePath: ${reference.id}`);
    }
    const fileStats = await stat(path.resolve(artifact.filePath));
    if (!fileStats.isFile() || fileStats.size <= 0) {
      throw new Error(`Router output artifact is not a non-empty file: ${reference.id}`);
    }
    return artifact;
  }

  async function materializeStageResult(run, stage, transportResult) {
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
      const artifact = await resolveOutputArtifact(reference);
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

    await mkdir(runDirectory, { recursive: true });
    const textPath = path.join(runDirectory, `${sanitizeFilename(stage.id)}.md`);
    const reservedNames = new Set(
      run.stages.flatMap((candidate) => [
        `${sanitizeFilename(candidate.id)}.md`,
        ...(candidate.projectArtifactPaths || []).map((item) => path.basename(item))
      ]).map((item) => item.toLowerCase())
    );
    await writeFile(textPath, `${transportResult.replyText || ""}\n`, "utf8");
    const projectArtifactPaths = [textPath];
    const artifactIds = [];

    for (const artifact of resolvedArtifacts) {
      const filename = sanitizeFilename(
        artifact.filename || path.basename(artifact.filePath) || artifact.id || "artifact"
      );
      const destination = deterministicArtifactDestination(
        runDirectory,
        filename,
        artifact.id,
        reservedNames
      );
      await copyFile(artifact.filePath, destination);
      projectArtifactPaths.push(destination);
      artifactIds.push(String(artifact.id));
    }

    return {
      artifactIds,
      projectArtifactPaths: uniquePaths(projectArtifactPaths)
    };
  }

  async function markStageFailed(run, scope, stageIndex, error, status = "failed") {
    const completedAt = nowIso(clock);
    const message = errorText(error) || (status === "cancelled" ? "Router run cancelled" : "GPT stage failed");
    return runStore.update(run.id, scope, (current) => {
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
    });
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
    const canonicalStageId = String(stageId || "").trim();
    const canonicalRequestId = String(requestId || "").trim();
    if (!canonicalStageId || !canonicalRequestId) {
      throw new Error("Router stage id and transport request id are required for a terminal update");
    }
    const completedAt = nowIso(clock);
    const message =
      errorText(error) || (status === "cancelled" ? "Router run cancelled" : "GPT stage failed");
    return runStore.update(runId, scope, (current) => {
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
    });
  }

  async function cancelFirstIncompleteUnsubmittedStage(runId, scope, reason) {
    const completedAt = nowIso(clock);
    const message = errorText(reason) || "Router run cancelled";
    return runStore.update(runId, scope, (current) => {
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
    });
  }

  async function applySucceededTransportResultByRequestId(
    runId,
    scope,
    stageId,
    requestId,
    transportResult
  ) {
    const canonicalStageId = String(stageId || "").trim();
    const canonicalRequestId = String(requestId || "").trim();
    return runStore.withFinalizationLease(runId, scope, async (snapshot) => {
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
          transportResult
        );
        const completedAt = nowIso(clock);
        return runStore.update(runId, scope, (current) => {
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
        });
      } catch (error) {
        return markTransportRequestTerminal(
          runId,
          scope,
          canonicalStageId,
          canonicalRequestId,
          error,
          "failed"
        );
      }
    });
  }

  async function applyTransportResult(run, scope, stageIndex, transportResult) {
    const expectedStage = run.stages[stageIndex];
    if (["failed", "cancelled"].includes(transportResult.status)) {
      return markTransportRequestTerminal(
        run.id,
        scope,
        expectedStage.id,
        transportResult.requestId || expectedStage.transportRequestId,
        transportResult.error,
        transportResult.status
      );
    }
    if (transportResult.status !== "succeeded") {
      return runStore.update(run.id, scope, (current) => {
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
      });
    }

    return applySucceededTransportResultByRequestId(
      run.id,
      scope,
      expectedStage.id,
      transportResult.requestId || expectedStage.transportRequestId,
      transportResult
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
    if (TERMINAL_STATUSES.has(run.status)) {
      return result(run);
    }
    const transport = transportRegistry.resolve(run.transportId);
    const waitThrough = driveOptions.waitForGpt === true;
    let waitOneExisting = driveOptions.resume === true && !waitThrough;
    let latestTransportResult = null;

    while (true) {
      const stageIndex = firstIncompleteStageIndex(run);
      if (stageIndex === -1) {
        if (run.status !== "succeeded") {
          run = await runStore.update(run.id, scope, (current) =>
            TERMINAL_STATUSES.has(current.status)
              ? current
              : {
                  ...current,
                  status: "succeeded",
                  currentStageIndex: current.stages.length - 1,
                  error: null
                }
          );
        }
        return result(run, latestTransportResult);
      }

      const stage = run.stages[stageIndex];
      if (["failed", "cancelled"].includes(stage.status)) {
        if (run.status !== stage.status) {
          run = await runStore.update(run.id, scope, (current) => {
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
          });
        }
        return result(run, latestTransportResult);
      }

      if (stage.transportRequestId && stage.submissionState !== "prepared") {
        if (!waitThrough && !waitOneExisting) {
          return result(run, latestTransportResult);
        }
        waitOneExisting = false;
        try {
          latestTransportResult = validateTransportResult(
            await transport.wait(stage.transportRequestId, driveOptions.waitOptions || {}),
            run.transportId,
            stage.transportRequestId
          );
        } catch (error) {
          run = await markStageFailed(run, scope, stageIndex, error, "failed");
          return result(run, latestTransportResult);
        }
        run = await applyTransportResult(run, scope, stageIndex, latestTransportResult);
        if (TERMINAL_STATUSES.has(run.status)) {
          return result(run, latestTransportResult);
        }
        if (latestTransportResult.status !== "succeeded") {
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
          "failed"
        );
        return result(run, latestTransportResult);
      }
      if (run.stages.slice(0, stageIndex).some((candidate) => candidate.status !== "succeeded")) {
        run = await markStageFailed(
          run,
          scope,
          stageIndex,
          "Router stages must execute strictly in order",
          "failed"
        );
        return result(run, latestTransportResult);
      }

      const recoveringPreparedRequest =
        Boolean(stage.transportRequestId) && stage.submissionState === "prepared";
      let payloadText = recoveringPreparedRequest
        ? stage.payloadText
        : payloadForStage(run, stageIndex);
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
          "failed"
        );
        return result(run, latestTransportResult);
      }

      if (!recoveringPreparedRequest) {
        run = await runStore.update(run.id, scope, (current) => {
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
        });
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
        submissionOutcome = await runStore.withSubmissionLease(
          run.id,
          scope,
          async (latestBeforeSubmission) => {
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

            let submittedResult;
            try {
              submittedResult = validateTransportResult(
                inputArtifacts.length > 0
                  ? await transport.submitArtifacts(submissionInput)
                  : await transport.submitText(submissionInput),
                latestBeforeSubmission.transportId,
                transportRequestId
              );
            } catch (error) {
              const failedRun = await markTransportRequestTerminal(
                latestBeforeSubmission.id,
                scope,
                leasedStage.id,
                transportRequestId,
                error,
                "failed"
              );
              return {
                run: failedRun,
                transportResult: null,
                skipped: false,
                error
              };
            }

            const updatedRun = await applyTransportResult(
              latestBeforeSubmission,
              scope,
              leasedStageIndex,
              submittedResult
            );
            return {
              run: updatedRun,
              transportResult: submittedResult,
              skipped: false,
              error: null
            };
          }
        );
      } catch (error) {
        run = await markTransportRequestTerminal(
          run.id,
          scope,
          preparedStage.id,
          transportRequestId,
          error,
          "failed"
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
      originalRequestText,
      targetRepo: input.workspace.targetRepo,
      chatgptProjectUrl: input.workspace.chatgptProjectUrl,
      modePreference: input.workspace.modePreference,
      modelPreference: input.workspace.modelPreference,
      status: route.kind === "codex_only" ? "succeeded" : "pending",
      currentStageIndex: stages.length > 0 ? 0 : -1,
      stages
    });
    if (route.kind === "codex_only") {
      return result(run);
    }
    return withRunLock(runLockKey(run.id, input.scope), () =>
      runStore.withRunLease(run.id, input.scope, (leasedRun) =>
        driveRun(leasedRun, input.scope, {
          waitForGpt: input.waitForGpt,
          waitOptions: input.waitOptions,
          resume: false
        })
      )
    );
  }

  async function continueRouterRun(input = {}) {
    return withRunLock(runLockKey(input.runId, input.scope), () =>
      runStore.withRunLease(input.runId, input.scope, (run) =>
        driveRun(run, input.scope, {
          waitForGpt: input.waitForGpt,
          waitOptions: input.waitOptions,
          resume: true
        })
      )
    );
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
        );
        return result(run, transportResult);
      }

      const stage = run.stages[stageIndex];
      if (!stage.transportRequestId) {
        run = await cancelFirstIncompleteUnsubmittedStage(run.id, input.scope, reason);
        if (TERMINAL_STATUSES.has(run.status)) {
          return result(run, transportResult);
        }
        continue;
      }

      const requestId = stage.transportRequestId;
      const transport = transportRegistry.resolve(run.transportId);
      try {
        transportResult = validateTransportResult(
          await transport.cancel(requestId, { reason }),
          run.transportId,
          requestId
        );
      } catch (error) {
        const preparedRequestWasMissing =
          stage.submissionState === "prepared" &&
          (error?.code === "ENOENT" ||
            /request not found|job not found/i.test(errorText(error) || ""));
        if (preparedRequestWasMissing) {
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
                { markSubmitted: false }
              );
            }
          );
        } else {
          run = await markTransportRequestTerminal(
            run.id,
            input.scope,
            stage.id,
            requestId,
            error,
            "failed"
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
          transportResult
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
          transportResult.status
        );
      } else {
        run = await markTransportRequestTerminal(
          run.id,
          input.scope,
          stage.id,
          requestId,
          `Transport cancel did not reach a terminal status: ${transportResult.status}`,
          "failed"
        );
      }
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
