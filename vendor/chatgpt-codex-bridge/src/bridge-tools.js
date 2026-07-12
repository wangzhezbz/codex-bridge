import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveBridgeDataDir } from "./runtime-config.js";

import {
  getArtifact,
  listArtifacts,
  readArtifactText as readStoredArtifactText,
  saveArtifactFromBase64,
  saveArtifactFromLocalFile
} from "./artifact-store.js";
import {
  ensureBridgeRoutingRules,
  ensureCodexDelegationInstructions
} from "./bridge-routing-rules.js";
import { getWorkspaceBinding, updateWorkspaceBinding } from "./conversation-store.js";
import { runTask } from "./codex-runner.js";
import { queueArtifactForGptAnalysis, waitForSyncJobResult } from "./gpt-file-analysis.js";
import { createMockGptTransport } from "./gpt-transports/mock-transport.js";
import { createGptTransportRegistry } from "./gpt-transports/transport-registry.js";
import { createWebSyncTransport } from "./gpt-transports/web-sync-transport.js";
import {
  claimNextInboxItem,
  completeInboxItem,
  createInboxItem,
  failInboxItem,
  listInboxItems
} from "./codex-inbox-store.js";
import {
  appendRoomMessage,
  claimNextCodexTask,
  failCodexTask,
  listRoomMessages
} from "./room-store.js";
import { completeRoomCodexTaskWithMessage } from "./room-codex-completion.js";
import { decideRoomRoute } from "./room-routing-policy.js";
import { createRouterOrchestrator } from "./router-orchestrator.js";
import { createRouterRunStore } from "./router-run-store.js";
import { bindCurrentSessionProject, getProject, listProjects } from "./project-store.js";
import {
  createTask,
  getTask,
  listTasks,
  readTaskEvents,
  readTaskResult
} from "./task-store.js";
import { createSyncJob, failSyncJob, getSyncJob, listSyncJobs } from "./sync-store.js";

const BRIDGE_SCOPE_REQUIRED_ERROR =
  "Bridge scope is required: pass conversationId or projectId. Bridge did not send this request to GPT.";
const ROUTER_SCOPE_REQUIRED_ERROR =
  "Router V2 scope is required: pass both projectId and conversationId. Bridge did not send this request to GPT.";
const BRIDGE_THREAD_SCOPE_ERROR =
  "Bridge conversation is bound to another Codex thread. Bridge did not send this request to GPT.";

async function withPromptText(task) {
  return {
    ...task,
    promptText: await readFile(task.promptPath, "utf8")
  };
}

async function listArtifactsWithProjectCopies(storeRoot, input = {}) {
  const artifacts = await listArtifacts(storeRoot, input);
  if (artifacts.length === 0) {
    return artifacts;
  }

  const projectCopyByArtifactId = new Map();
  for (const job of await listSyncJobs(storeRoot)) {
    for (const projectArtifact of job.projectArtifacts || []) {
      const artifactId = projectArtifact?.artifact?.id;
      if (artifactId && !projectCopyByArtifactId.has(artifactId)) {
        projectCopyByArtifactId.set(artifactId, projectArtifact);
      }
    }
  }

  return artifacts.map((artifact) => {
    const projectArtifact = projectCopyByArtifactId.get(artifact.id) || null;
    return {
      ...artifact,
      projectArtifact,
      projectSavedPath: projectArtifact?.savedPath || null,
      projectRelativePath: projectArtifact?.relativePath || null,
      projectRoot: projectArtifact?.projectRoot || null
    };
  });
}

function normalizeLocalFiles(input = {}) {
  const files = [];
  if (input.localPath) {
    files.push(input);
  }
  if (Array.isArray(input.localFiles)) {
    files.push(...input.localFiles);
  }

  return files
    .filter((file) => file && typeof file === "object")
    .map((file) => ({
      localPath: file.localPath,
      filename: file.filename,
      contentType: file.contentType,
      originalUrl: file.originalUrl,
      sourceMessageId: file.sourceMessageId,
      conversationId: file.conversationId
    }))
    .filter((file) => file.localPath);
}

function firstResult(value) {
  return Array.isArray(value) && value.length > 0 ? value[0] : null;
}

function actionForRoute(route) {
  return route.kind === "codex_only" ? "codex_only" : route.kind;
}

function shouldWaitForDelegatedGpt(input = {}, route = {}, localFiles = []) {
  if (input.waitForGpt === false || input.wait === false) {
    return false;
  }
  if (input.waitForGpt === true || input.wait === true) {
    return true;
  }
  return route.kind !== "codex_only";
}

function waitOptionsFromInput(input = {}, shouldWait = false) {
  return {
    timeoutMs: input.timeoutMs,
    pollMs: input.pollMs || input.pollIntervalMs,
    timeoutGraceMs: input.timeoutGraceMs ?? input.graceMs,
    failOnTimeout: input.failOnTimeout ?? shouldWait
  };
}

function normalizeOptionalText(value) {
  const text = value?.trim();
  return text || null;
}

function workspaceFromProject(project, fallback = {}) {
  return {
    ...fallback,
    projectId: project.id,
    chatgptProjectUrl: project.chatgptProjectUrl,
    targetRepo: project.targetRepo,
    conversationId: project.conversationId,
    currentCodexThreadId: project.currentCodexThreadId || fallback.currentCodexThreadId || null,
    modePreference: fallback.modePreference || null,
    modelPreference: fallback.modelPreference || null,
    preferenceUpdatedAt: fallback.preferenceUpdatedAt || null
  };
}

export function createBridgeTools(options = {}) {
  const storeRoot = resolveBridgeDataDir({
    storeRoot: options.storeRoot,
    env: options.env || process.env,
    cwd: options.cwd || process.cwd()
  });
  const runnerMode = options.runnerMode || process.env.BRIDGE_RUNNER || "manual";
  const currentCodexThreadId =
    options.currentCodexThreadId || process.env.BRIDGE_CURRENT_CODEX_THREAD_ID || null;
  const routerV2Enabled =
    options.routerV2Enabled ?? process.env.BRIDGE_ROUTER_V2 === "1";
  let routerOrchestrator = options.routerOrchestrator || null;

  async function attachRoutingRules(workspace = {}) {
    const updated = { ...workspace };
    if (!updated.targetRepo) {
      return updated;
    }

    const rules = await ensureBridgeRoutingRules({
      targetRepo: updated.targetRepo,
      chatgptProjectUrl: updated.chatgptProjectUrl,
      conversationId: updated.conversationId
    });
    const delegation = await ensureCodexDelegationInstructions({
      projectId: updated.projectId,
      targetRepo: updated.targetRepo,
      chatgptProjectUrl: updated.chatgptProjectUrl,
      conversationId: updated.conversationId
    });
    updated.bridgeRulesPath = rules.path;
    updated.codexDelegationPath = delegation.path;
    return updated;
  }

  async function getActiveWorkspaceWithRoutingRules() {
    return attachRoutingRules(await updateWorkspaceBinding(storeRoot, {}));
  }

  function assertWorkspaceThreadScope(workspace = {}) {
    const boundThreadId = normalizeOptionalText(workspace.currentCodexThreadId);
    if (!boundThreadId || !currentCodexThreadId) {
      return;
    }
    if (boundThreadId !== currentCodexThreadId) {
      throw new Error(BRIDGE_THREAD_SCOPE_ERROR);
    }
  }

  async function resolveWorkspaceForInput(input = {}) {
    const projectId = normalizeOptionalText(input.projectId);
    const conversationId = normalizeOptionalText(input.conversationId);
    let workspace;

    if (projectId) {
      workspace = workspaceFromProject(await getProject(storeRoot, projectId), await getWorkspaceBinding(storeRoot));
      assertWorkspaceThreadScope(workspace);
      return attachRoutingRules(workspace);
    }

    if (conversationId) {
      const activeWorkspace = await getWorkspaceBinding(storeRoot);
      if (activeWorkspace.conversationId === conversationId) {
        if (activeWorkspace.projectId) {
          workspace = workspaceFromProject(await getProject(storeRoot, activeWorkspace.projectId), activeWorkspace);
          assertWorkspaceThreadScope(workspace);
          return attachRoutingRules(workspace);
        }
        return attachRoutingRules(activeWorkspace);
      }

      const { projects } = await listProjects(storeRoot);
      const project = projects.find((item) => item.conversationId === conversationId);
      if (!project) {
        throw new Error(`Bridge conversation not found: ${conversationId}`);
      }
      workspace = workspaceFromProject(project, activeWorkspace);
      assertWorkspaceThreadScope(workspace);
      return attachRoutingRules(workspace);
    }

    const activeWorkspace = await getActiveWorkspaceWithRoutingRules();
    if (activeWorkspace.projectId) {
      return null;
    }
    return activeWorkspace;
  }

  async function requireWorkspaceForInput(input = {}) {
    const workspace = await resolveWorkspaceForInput(input);
    if (!workspace) {
      throw new Error(BRIDGE_SCOPE_REQUIRED_ERROR);
    }
    return workspace;
  }

  async function bindCurrentCodexSessionToProject(input = {}) {
    if (!currentCodexThreadId) {
      throw new Error("Current Codex thread id is required to bind a Bridge project");
    }
    const bound = await bindCurrentSessionProject(
      storeRoot,
      {
        ...input,
        currentCodexThreadId
      },
      {
        currentCodexThreadId
      }
    );
    const workspace = await attachRoutingRules({
      ...bound.workspace,
      currentCodexThreadId: bound.project.currentCodexThreadId
    });
    return {
      ...bound,
      workspace,
      routingRules: {
        bridgeRulesPath: workspace.bridgeRulesPath || null,
        codexDelegationPath: workspace.codexDelegationPath || null,
        bridgeRulesUpdatedAt: workspace.bridgeRulesUpdatedAt || null,
        codexDelegationUpdatedAt: workspace.codexDelegationUpdatedAt || null
      }
    };
  }

  function scopeRequiredResult(error = BRIDGE_SCOPE_REQUIRED_ERROR) {
    return {
      action: "scope_required",
      scopeRequired: true,
      route: null,
      codexPromptText: null,
      gptPayloadText: null,
      message: null,
      syncJob: null,
      queuedFiles: [],
      artifacts: [],
      finalJob: null,
      timedOut: false,
      replyText: null,
      routingRules: {
        bridgeRulesPath: null,
        codexDelegationPath: null,
        bridgeRulesUpdatedAt: null,
        codexDelegationUpdatedAt: null
      },
      error
    };
  }

  async function saveLocalFileArtifact(input, workspace) {
    const artifactInput = {
      filename: input.filename,
      contentType: input.contentType,
      originalUrl: input.originalUrl || "codex-current-thread-file",
      syncJobId: null,
      conversationId: workspace.conversationId || null,
      sourceMessageId: input.sourceMessageId || null
    };
    return input.base64Data
      ? await saveArtifactFromBase64(storeRoot, {
          ...artifactInput,
          base64Data: input.base64Data
        })
      : await saveArtifactFromLocalFile(storeRoot, {
          ...artifactInput,
          localPath: input.localPath
        });
  }

  async function findExistingRouterFileSubmission({
    requestId,
    workspace,
    files,
    note,
    kind = "codex_file_analysis"
  }) {
    const normalizedRequestId = normalizeOptionalText(requestId);
    if (!normalizedRequestId) {
      return null;
    }
    let syncJob;
    try {
      syncJob = await getSyncJob(storeRoot, normalizedRequestId);
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const inputArtifacts = Array.isArray(syncJob.inputArtifacts) ? syncJob.inputArtifacts : [];
    if (
      syncJob.kind !== kind ||
      syncJob.conversationId !== workspace.conversationId ||
      inputArtifacts.length !== files.length
    ) {
      throw new Error(
        `Router file request id was reused with a different payload: ${normalizedRequestId}`
      );
    }
    for (let index = 0; index < files.length; index += 1) {
      const expectedFilename =
        normalizeOptionalText(files[index].filename) ||
        (files[index].localPath ? path.basename(files[index].localPath) : null);
      if (expectedFilename && inputArtifacts[index]?.filename !== expectedFilename) {
        throw new Error(
          `Router file request id was reused with a different payload: ${normalizedRequestId}`
        );
      }
    }
    const normalizedNote = normalizeOptionalText(note);
    if (normalizedNote && !String(syncJob.payloadText || "").includes(normalizedNote)) {
      throw new Error(
        `Router file request id was reused with a different payload: ${normalizedRequestId}`
      );
    }
    const artifacts = [];
    for (const inputArtifact of inputArtifacts) {
      artifacts.push(await getArtifact(storeRoot, inputArtifact.id));
    }
    return { syncJob, artifacts };
  }

  async function sendLocalFileToChatGptProject(input, resolvedWorkspace = null) {
    const workspace = resolvedWorkspace || (await requireWorkspaceForInput(input));
    if (!workspace.chatgptProjectUrl) {
      throw new Error("GPT 会话未绑定");
    }

    const existing = await findExistingRouterFileSubmission({
      requestId: input.requestId,
      workspace,
      files: [input],
      note: input.note
    });
    if (existing) {
      return {
        artifact: existing.artifacts[0],
        message: null,
        syncJob: existing.syncJob,
        cached: false,
        reusedSyncJobId: null
      };
    }

    const artifact = await saveLocalFileArtifact(input, workspace);
    const queued = await queueArtifactForGptAnalysis(storeRoot, {
      requestId: input.requestId,
      workspace,
      artifact,
      note: input.note,
      modePreference: input.modePreference,
      modelPreference: input.modelPreference,
      from: "codex",
      source: "current_codex_file",
      metadata: {
        currentCodexThreadId,
        targetRepo: workspace.targetRepo,
        chatgptProjectUrl: workspace.chatgptProjectUrl,
        ...(input.metadata || {})
      }
    });

    return {
      artifact,
      ...queued
    };
  }

  async function askChatGptProject(input, resolvedWorkspace = null) {
    const workspace = resolvedWorkspace || (await requireWorkspaceForInput(input));
    if (!workspace.chatgptProjectUrl) {
      throw new Error("GPT 会话未绑定");
    }

    const gptPayloadText = input.payloadText || input.text;
    const requestId = normalizeOptionalText(input.requestId);
    if (requestId) {
      try {
        const existing = await getSyncJob(storeRoot, requestId);
        const syncJob = await createSyncJob(storeRoot, {
          id: requestId,
          kind: input.kind || "codex_consultation",
          projectUrl: workspace.chatgptProjectUrl,
          targetRepo: workspace.targetRepo,
          conversationId: workspace.conversationId,
          userText: input.text,
          payloadText: gptPayloadText,
          modePreference: input.modePreference,
          modelPreference: input.modelPreference,
          sourceMessageId: existing.sourceMessageId
        });
        return { message: null, syncJob };
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    const message = await appendRoomMessage(storeRoot, {
      conversationId: workspace.conversationId,
      from: "codex",
      to: ["gpt"],
      text: gptPayloadText,
      metadata: {
        reason: input.reason || null,
        source: "current_codex_thread",
        currentCodexThreadId,
        targetRepo: workspace.targetRepo,
        chatgptProjectUrl: workspace.chatgptProjectUrl,
        routingKind: input.routingKind || null,
        originalRequestText: gptPayloadText === input.text ? null : input.text,
        ...(input.metadata || {})
      }
    });

    const syncJob = await createSyncJob(storeRoot, {
      id: requestId,
      kind: input.kind || "codex_consultation",
      projectUrl: workspace.chatgptProjectUrl,
      targetRepo: workspace.targetRepo,
      conversationId: workspace.conversationId,
      userText: input.text,
      payloadText: gptPayloadText,
      modePreference: input.modePreference,
      modelPreference: input.modelPreference,
      sourceMessageId: message.id
    });

    return { message, syncJob };
  }

  async function delegateCurrentRequestLegacy(input = {}) {
    const workspace = await resolveWorkspaceForInput(input);
    if (!workspace) {
      return scopeRequiredResult();
    }
    const routingRules = {
      bridgeRulesPath: workspace.bridgeRulesPath || null,
      codexDelegationPath: workspace.codexDelegationPath || null,
      bridgeRulesUpdatedAt: workspace.bridgeRulesUpdatedAt || null,
      codexDelegationUpdatedAt: workspace.codexDelegationUpdatedAt || null
    };
    const localFiles = normalizeLocalFiles(input);
    const text = input.text?.trim() || input.note?.trim() || "Please analyze the attached file.";
    const route = decideRoomRoute({
      text,
      workspace,
      attachmentCount: input.attachmentCount ?? localFiles.length,
      hasAttachments: Boolean(input.hasAttachments || localFiles.length > 0)
    });

    if (route.kind === "codex_only") {
      return {
        action: "codex_only",
        route,
        codexPromptText: route.codexPromptText,
        gptPayloadText: null,
        message: null,
        syncJob: null,
        queuedFiles: [],
        artifacts: [],
        finalJob: null,
        timedOut: false,
        replyText: null,
        routingRules
      };
    }

    const modePreference = input.modePreference || workspace.modePreference;
    const modelPreference = input.modelPreference || workspace.modelPreference;
    const shouldWait = shouldWaitForDelegatedGpt(input, route, localFiles);

    if (localFiles.length > 0) {
      const queuedFiles = [];
      const waitResults = [];
      for (const file of localFiles) {
        const queued = await sendLocalFileToChatGptProject({
          ...file,
          projectId: input.projectId,
          conversationId: workspace.conversationId,
          note: route.gptPayloadText || text,
          modePreference,
          modelPreference,
          metadata: {
            routingKind: route.kind,
            routingReason: route.reason,
            routePolicyId: route.policy?.id || null
          }
        }, workspace);
        queuedFiles.push(queued);
        if (shouldWait) {
          waitResults.push(
            await waitForSyncJobResult(storeRoot, queued.syncJob.id, waitOptionsFromInput(input, shouldWait))
          );
        }
      }

      const firstQueued = firstResult(queuedFiles);
      const firstWaited = firstResult(waitResults);
      return {
        action: actionForRoute(route),
        route,
        codexPromptText: null,
        gptPayloadText: route.gptPayloadText || text,
        message: firstQueued?.message || null,
        syncJob: firstQueued?.syncJob || null,
        queuedFiles,
        artifacts: queuedFiles.map((queued) => queued.artifact),
        finalJob: firstWaited?.finalJob || null,
        timedOut: firstWaited?.timedOut ?? false,
        replyText: firstWaited?.replyText || null,
        routingRules
      };
    }

    const queued = await askChatGptProject({
      projectId: input.projectId,
      conversationId: workspace.conversationId,
      text,
      payloadText: route.gptPayloadText || text,
      kind: route.syncKind || "chat_message",
      reason: route.reason,
      modePreference,
      modelPreference,
      routingKind: route.kind,
      metadata: {
        routePolicyId: route.policy?.id || null
      }
    }, workspace);
    const waited = shouldWait
      ? await waitForSyncJobResult(storeRoot, queued.syncJob.id, waitOptionsFromInput(input, shouldWait))
      : null;

    return {
      action: actionForRoute(route),
      route,
      codexPromptText: null,
      gptPayloadText: route.gptPayloadText || text,
      message: queued.message,
      syncJob: queued.syncJob,
      queuedFiles: [],
      artifacts: [],
      finalJob: waited?.finalJob || null,
      timedOut: waited?.timedOut ?? false,
      replyText: waited?.replyText || null,
      routingRules
    };
  }

  function routingRulesFromWorkspace(workspace = {}) {
    return {
      bridgeRulesPath: workspace.bridgeRulesPath || null,
      codexDelegationPath: workspace.codexDelegationPath || null,
      bridgeRulesUpdatedAt: workspace.bridgeRulesUpdatedAt || null,
      codexDelegationUpdatedAt: workspace.codexDelegationUpdatedAt || null
    };
  }

  function routerScopeFromWorkspace(workspace = {}) {
    return {
      projectId: workspace.projectId,
      conversationId: workspace.conversationId,
      codexThreadId: currentCodexThreadId
    };
  }

  async function resolveRouterWorkspaceForInput(input = {}) {
    const projectId = normalizeOptionalText(input.projectId);
    const conversationId = normalizeOptionalText(input.conversationId);
    if (!projectId || !conversationId) {
      return null;
    }
    if (!currentCodexThreadId) {
      throw new Error("Router V2 requires the current Codex thread id");
    }
    if (projectId && conversationId) {
      const explicitProject = await getProject(storeRoot, projectId);
      if (explicitProject.conversationId !== conversationId) {
        throw new Error("Router V2 scope mismatch: projectId and conversationId belong to different projects");
      }
    }

    const workspace = await resolveWorkspaceForInput(input);
    if (!workspace) {
      return null;
    }
    if (!workspace.projectId) {
      throw new Error("Router V2 requires an explicitly bound Bridge project");
    }
    if (!workspace.conversationId) {
      throw new Error("Router V2 requires a bound GPT conversationId");
    }
    if (!workspace.currentCodexThreadId) {
      throw new Error("Router V2 project is not bound to a Codex thread");
    }
    if (workspace.currentCodexThreadId !== currentCodexThreadId) {
      throw new Error(BRIDGE_THREAD_SCOPE_ERROR);
    }
    if (!workspace.chatgptProjectUrl) {
      throw new Error("Router V2 requires a bound GPT conversation URL");
    }
    if (!workspace.targetRepo) {
      throw new Error("Router V2 requires a bound target project directory");
    }
    const targetRepo = path.resolve(workspace.targetRepo);
    if (targetRepo === path.parse(targetRepo).root) {
      throw new Error("Router V2 target project directory cannot be a filesystem root");
    }
    return {
      ...workspace,
      targetRepo
    };
  }

  function resolveRouterOrchestrator() {
    if (routerOrchestrator) {
      return routerOrchestrator;
    }

    let transportRegistry = options.gptTransportRegistry || null;
    if (!transportRegistry) {
      const webSyncTransport = createWebSyncTransport({
        storeRoot,
        enqueueText: async (transportInput = {}) =>
          askChatGptProject(
            {
              projectId: transportInput.workspace?.projectId,
              conversationId: transportInput.workspace?.conversationId,
              requestId: transportInput.requestId,
              text: transportInput.text || transportInput.payloadText,
              payloadText: transportInput.payloadText,
              kind: transportInput.kind || "chat_message",
              reason: "router_v2",
              modePreference: transportInput.modePreference,
              modelPreference: transportInput.modelPreference,
              routingKind: transportInput.routingKind,
              metadata: transportInput.metadata || {}
            },
            transportInput.workspace
          ),
        enqueueArtifacts: async (transportInput = {}) => {
          const files = Array.isArray(transportInput.artifacts) ? transportInput.artifacts : [];
          if (files.length === 0) {
            throw new Error("Router V2 web-sync artifact submission requires a local file");
          }
          const artifactSyncKind =
            transportInput.kind === "image_request" ? "image_request" : "codex_file_analysis";
          const existing = await findExistingRouterFileSubmission({
            requestId: transportInput.requestId,
            workspace: transportInput.workspace,
            files,
            note: transportInput.payloadText,
            kind: artifactSyncKind
          });
          const savedArtifacts = existing?.artifacts || [];
          if (!existing) {
            for (const file of files) {
              savedArtifacts.push(
                file.id
                  ? await getArtifact(storeRoot, file.id)
                  : await saveLocalFileArtifact(file, transportInput.workspace)
              );
            }
          }
          const queued = existing
            ? {
                message: null,
                syncJob: existing.syncJob,
                cached: false,
                reusedSyncJobId: null
              }
            : await queueArtifactForGptAnalysis(storeRoot, {
                requestId: transportInput.requestId,
                workspace: transportInput.workspace,
                artifacts: savedArtifacts,
                kind: artifactSyncKind,
                payloadText: transportInput.payloadText,
                note: transportInput.payloadText,
                modePreference: transportInput.modePreference,
                modelPreference: transportInput.modelPreference,
                from: "codex",
                source: "current_codex_file",
                metadata: {
                  currentCodexThreadId,
                  targetRepo: transportInput.workspace?.targetRepo,
                  chatgptProjectUrl: transportInput.workspace?.chatgptProjectUrl,
                  ...(transportInput.metadata || {})
                }
              });
          const queuedFiles = savedArtifacts.map((artifact) => ({
            artifact,
            ...queued
          }));
          return {
            ...queued,
            queuedFiles
          };
        },
        waitJob: (requestId, waitOptions = {}) =>
          waitForSyncJobResult(storeRoot, requestId, waitOptions),
        getJob: (requestId) => getSyncJob(storeRoot, requestId),
        cancelJob: (requestId, cancelOptions = {}) =>
          failSyncJob(storeRoot, requestId, {
            error: cancelOptions.reason || "Router run cancelled",
            errorCode: "manual_cancelled",
            recoveryAction: "manual_stop"
          }),
        resolveArtifacts: async (artifactIds) => {
          const artifacts = [];
          for (const artifactId of artifactIds) {
            artifacts.push(await getArtifact(storeRoot, artifactId));
          }
          return artifacts;
        }
      });
      const injectedTransports = Array.isArray(options.gptTransports)
        ? options.gptTransports
        : [];
      const transports = [...injectedTransports];
      if (!transports.some((transport) => transport?.id === "web-sync")) {
        transports.unshift(webSyncTransport);
      }
      if (!transports.some((transport) => transport?.id === "mock")) {
        transports.push(createMockGptTransport(options.mockGptTransportOptions));
      }
      transportRegistry = createGptTransportRegistry({
        transports,
        defaultTransportId: "web-sync",
        env: options.gptTransportEnv || process.env
      });
    }

    const runStore =
      options.routerRunStore ||
      createRouterRunStore({
        storeRoot,
        clock: options.routerClock,
        runIdFactory: options.routerRunIdFactory
      });
    routerOrchestrator = createRouterOrchestrator({
      runStore,
      transportRegistry,
      artifactResolver: (artifactId) => getArtifact(storeRoot, artifactId),
      clock: options.routerClock
    });
    return routerOrchestrator;
  }

  function routerCompatibilityResult({ route, text, workspace, orchestration }) {
    const transportResult = orchestration.transportResult || null;
    const raw = transportResult?.raw;
    const submitted = raw?.submitted || raw || null;
    const waited = raw?.waited || null;
    const queuedFiles = Array.isArray(submitted?.queuedFiles) ? submitted.queuedFiles : [];
    const message = submitted?.message || queuedFiles[0]?.message || null;
    const syncJob = submitted?.syncJob || queuedFiles[0]?.syncJob || null;
    const inputArtifacts = submitted?.artifact
      ? [submitted.artifact]
      : queuedFiles.map((item) => item.artifact).filter(Boolean);
    const finalJob = waited?.finalJob || submitted?.finalJob || null;
    const lastReplyStage = [...(orchestration.routerRun.stages || [])]
      .reverse()
      .find((stage) => stage.replyText != null);

    return {
      action: actionForRoute(route),
      route,
      codexPromptText: route.kind === "codex_only" ? route.codexPromptText : null,
      gptPayloadText: route.kind === "codex_only" ? null : route.gptPayloadText || text,
      message,
      syncJob,
      queuedFiles,
      artifacts: inputArtifacts.length > 0 ? inputArtifacts : transportResult?.artifacts || [],
      finalJob,
      timedOut: waited?.timedOut ?? submitted?.timedOut ?? false,
      replyText: transportResult?.replyText ?? lastReplyStage?.replyText ?? null,
      routingRules: routingRulesFromWorkspace(workspace),
      routerRun: orchestration.routerRun,
      transportResult,
      projectArtifactPaths: orchestration.projectArtifactPaths || []
    };
  }

  async function delegateCurrentRequestV2(input = {}) {
    const workspace = await resolveRouterWorkspaceForInput(input);
    if (!workspace) {
      return {
        ...scopeRequiredResult(ROUTER_SCOPE_REQUIRED_ERROR),
        routerRun: null,
        transportResult: null,
        projectArtifactPaths: []
      };
    }
    const localFiles = normalizeLocalFiles(input);
    const text = input.text?.trim() || input.note?.trim() || "Please analyze the attached file.";
    const route = decideRoomRoute({
      text,
      workspace,
      attachmentCount: input.attachmentCount ?? localFiles.length,
      hasAttachments: Boolean(input.hasAttachments || localFiles.length > 0)
    });
    const modePreference = input.modePreference || workspace.modePreference;
    const modelPreference = input.modelPreference || workspace.modelPreference;
    const shouldWait = shouldWaitForDelegatedGpt(input, route, localFiles);
    const scopedWorkspace = {
      ...workspace,
      modePreference,
      modelPreference
    };
    const inputArtifacts = [];
    for (const localFile of localFiles) {
      inputArtifacts.push(await saveLocalFileArtifact(localFile, scopedWorkspace));
    }
    const orchestration = await resolveRouterOrchestrator().startRouterRun({
      route,
      originalRequestText: text,
      workspace: scopedWorkspace,
      scope: routerScopeFromWorkspace(scopedWorkspace),
      transportId: options.gptTransportId,
      waitForGpt: shouldWait,
      waitOptions: waitOptionsFromInput(input, shouldWait),
      artifacts: inputArtifacts
    });
    return routerCompatibilityResult({ route, text, workspace: scopedWorkspace, orchestration });
  }

  async function delegateCurrentRequest(input = {}) {
    return routerV2Enabled
      ? delegateCurrentRequestV2(input)
      : delegateCurrentRequestLegacy(input);
  }

  function routerContinuationResult(orchestration) {
    const lastReplyStage = [...(orchestration.routerRun.stages || [])]
      .reverse()
      .find((stage) => stage.replyText != null);
    return {
      ...orchestration,
      replyText: orchestration.transportResult?.replyText ?? lastReplyStage?.replyText ?? null
    };
  }

  async function continueRouterRun(input = {}) {
    if (!routerV2Enabled) {
      throw new Error("Router V2 is disabled");
    }
    const workspace = await resolveRouterWorkspaceForInput(input);
    if (!workspace) {
      throw new Error(ROUTER_SCOPE_REQUIRED_ERROR);
    }
    const orchestration = await resolveRouterOrchestrator().continueRouterRun({
      runId: input.runId,
      scope: routerScopeFromWorkspace(workspace),
      waitForGpt: input.waitForGpt,
      waitOptions: waitOptionsFromInput(input, input.waitForGpt === true)
    });
    return routerContinuationResult(orchestration);
  }

  async function cancelRouterRun(input = {}) {
    if (!routerV2Enabled) {
      throw new Error("Router V2 is disabled");
    }
    const workspace = await resolveRouterWorkspaceForInput(input);
    if (!workspace) {
      throw new Error(ROUTER_SCOPE_REQUIRED_ERROR);
    }
    const orchestration = await resolveRouterOrchestrator().cancelRouterRun({
      runId: input.runId,
      scope: routerScopeFromWorkspace(workspace),
      reason: input.reason
    });
    return routerContinuationResult(orchestration);
  }

  return {
    async bindCurrentCodexSession(input) {
      return bindCurrentCodexSessionToProject(input);
    },

    async createTask(input) {
      const task = await createTask(storeRoot, {
        title: input.title,
        prompt: input.prompt,
        targetRepo: input.targetRepo,
        source: input.source || "mcp"
      });

      if (input.run) {
        await runTask(storeRoot, task.id, { runnerMode });
        return withPromptText(await getTask(storeRoot, task.id));
      }

      return withPromptText(task);
    },

    async listTasks() {
      return listTasks(storeRoot);
    },

    async getTaskStatus(input) {
      const task = await getTask(storeRoot, input.taskId);
      const events = await readTaskEvents(storeRoot, input.taskId);
      return {
        ...task,
        events
      };
    },

    async getTaskResult(input) {
      return {
        taskId: input.taskId,
        text: await readTaskResult(storeRoot, input.taskId)
      };
    },

    async requestRevision(input) {
      const original = await getTask(storeRoot, input.taskId);
      const revision = await createTask(storeRoot, {
        title: `Revision: ${original.title}`,
        prompt: [
          `Revise previous bridge task ${original.id}.`,
          "",
          input.prompt?.trim() || "Review the prior result and propose the next safe change."
        ].join("\n"),
        targetRepo: original.targetRepo,
        source: "revision"
      });

      return withPromptText(revision);
    },

    async createInboxItem(input) {
      return createInboxItem(storeRoot, input);
    },

    async listInboxItems() {
      return listInboxItems(storeRoot);
    },

    async claimNextInboxItem(input = {}) {
      return claimNextInboxItem(storeRoot, input);
    },

    async completeInboxItem(input) {
      return completeInboxItem(storeRoot, input.itemId, input);
    },

    async failInboxItem(input) {
      return failInboxItem(storeRoot, input.itemId, input);
    },

    async listRoomMessages(input = {}) {
      return listRoomMessages(storeRoot, input);
    },

    async askChatGptProject(input) {
      return askChatGptProject(input);
    },

    async readChatGptProjectAnswer(input) {
      return {
        job: await getSyncJob(storeRoot, input.syncJobId)
      };
    },

    async sendLocalFileToChatGptProject(input) {
      return sendLocalFileToChatGptProject(input);
    },

    async waitForChatGptProjectAnswer(input) {
      return waitForSyncJobResult(storeRoot, input.syncJobId, input);
    },

    async sendLocalFileToChatGptProjectAndWait(input) {
      const queued = await sendLocalFileToChatGptProject(input);
      const waited = await waitForSyncJobResult(storeRoot, queued.syncJob.id, input);
      return {
        ...queued,
        ...waited
      };
    },

    async delegateCurrentRequest(input) {
      return delegateCurrentRequest(input);
    },

    async continueRouterRun(input) {
      return continueRouterRun(input);
    },

    async cancelRouterRun(input) {
      return cancelRouterRun(input);
    },

    async listArtifacts(input = {}) {
      return listArtifactsWithProjectCopies(storeRoot, input);
    },

    async readArtifactText(input) {
      return readStoredArtifactText(storeRoot, input.artifactId, {
        maxChars: input.maxChars
      });
    },

    async claimNextRoomCodexTask(input = {}) {
      return claimNextCodexTask(storeRoot, {
        ...input,
        currentThreadId: input.currentThreadId || currentCodexThreadId
      });
    },

    async completeRoomCodexTask(input) {
      return completeRoomCodexTaskWithMessage(storeRoot, input.taskId, input);
    },

    async failRoomCodexTask(input) {
      return failCodexTask(storeRoot, input.taskId, input);
    }
  };
}
