import { getArtifact } from "../artifact-store.js";
import { queueArtifactForGptAnalysis, waitForSyncJobResult } from "../gpt-file-analysis.js";
import { createSyncJob, failSyncJob, getSyncJob } from "../sync-store.js";

const TRANSPORT_ID = "web-sync";

function errorText(value) {
  if (value == null) {
    return null;
  }
  return value instanceof Error ? value.message : String(value);
}

function syncJobFrom(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value.syncJob || value.finalJob || value.job || (value.id ? value : null);
}

function publicStatus(job = {}) {
  if (job.status === "cancelled" || /cancel/i.test(job.errorCode || "")) {
    return "cancelled";
  }
  if (job.status === "pending") {
    return "queued";
  }
  if (["running", "succeeded", "failed"].includes(job.status)) {
    return job.status;
  }
  return "queued";
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new Error(`web-sync transport requires ${name}()`);
  }
  return value;
}

export function createWebSyncTransport(options = {}) {
  const storeRoot = options.storeRoot;
  const enqueueText = requireFunction(
    options.enqueueText ||
      (async (input = {}) => {
        const workspace = input.workspace || {};
        const syncJob = await createSyncJob(storeRoot, {
          id: input.requestId,
          kind: input.kind || input.syncKind || "chat_message",
          projectUrl: workspace.chatgptProjectUrl,
          targetRepo: workspace.targetRepo,
          conversationId: workspace.conversationId,
          userText: input.text || input.payloadText,
          payloadText: input.payloadText || input.text,
          modePreference: input.modePreference,
          modelPreference: input.modelPreference,
          sourceMessageId: input.sourceMessageId
        });
        return { syncJob };
      }),
    "enqueueText"
  );
  const enqueueArtifacts = requireFunction(
    options.enqueueArtifacts ||
      (async (input = {}) => {
        const artifacts = Array.isArray(input.artifacts)
          ? input.artifacts.filter(Boolean)
          : input.artifact
            ? [input.artifact]
            : [];
        if (artifacts.length === 0) {
          throw new Error("web-sync artifact submission requires an artifact");
        }
        return queueArtifactForGptAnalysis(storeRoot, {
          requestId: input.requestId,
          workspace: input.workspace,
          artifacts,
          kind: (input.kind || input.syncKind) === "image_request" ? "image_request" : undefined,
          payloadText: input.payloadText,
          note: input.payloadText || input.note,
          modePreference: input.modePreference,
          modelPreference: input.modelPreference,
          from: input.from || "codex",
          source: input.source || "router_v2",
          metadata: input.metadata || {}
        });
      }),
    "enqueueArtifacts"
  );
  const waitJob = requireFunction(
    options.waitJob || ((requestId, waitOptions) => waitForSyncJobResult(storeRoot, requestId, waitOptions)),
    "waitJob"
  );
  const getJob = requireFunction(
    options.getJob || ((requestId) => getSyncJob(storeRoot, requestId)),
    "getJob"
  );
  const cancelJob = requireFunction(
    options.cancelJob ||
      ((requestId, cancelOptions = {}) =>
        failSyncJob(storeRoot, requestId, {
          error: cancelOptions.reason || "Router run cancelled",
          errorCode: "manual_cancelled",
          recoveryAction: "manual_stop"
        })),
    "cancelJob"
  );
  const resolveArtifacts =
    options.resolveArtifacts ||
    (async (artifactIds) => {
      const artifacts = [];
      for (const artifactId of artifactIds) {
        artifacts.push(await getArtifact(storeRoot, artifactId));
      }
      return artifacts;
    });
  const submittedRaw = new Map();

  async function artifactsFrom(job = {}, raw = {}) {
    if (Array.isArray(raw.artifacts)) {
      return raw.artifacts;
    }
    if (Array.isArray(job.projectArtifacts) && job.projectArtifacts.length > 0) {
      return job.projectArtifacts.map((item) => item?.artifact || item).filter(Boolean);
    }
    const artifactIds = Array.isArray(job.artifactIds) ? job.artifactIds.filter(Boolean) : [];
    return artifactIds.length > 0 ? resolveArtifacts(artifactIds, { job, raw }) : [];
  }

  async function toEnvelope(requestId, job, raw, overrides = {}) {
    return {
      transportId: TRANSPORT_ID,
      requestId,
      status: overrides.status || publicStatus(job),
      replyText:
        overrides.replyText !== undefined
          ? overrides.replyText
          : raw?.replyText ?? job?.replyText ?? null,
      artifacts:
        overrides.artifacts !== undefined ? overrides.artifacts : await artifactsFrom(job, raw),
      error:
        overrides.error !== undefined
          ? errorText(overrides.error)
          : errorText(job?.error || raw?.error),
      raw: overrides.raw !== undefined ? overrides.raw : raw ?? null
    };
  }

  async function submit(enqueue, input) {
    const raw = await enqueue(input);
    const job = syncJobFrom(raw);
    if (!job?.id) {
      throw new Error("web-sync transport enqueue did not return a sync job id");
    }
    if (input?.requestId && job.id !== input.requestId) {
      throw new Error(
        `web-sync transport request id mismatch: expected ${input.requestId}, received ${job.id}`
      );
    }
    submittedRaw.set(job.id, raw);
    return toEnvelope(job.id, job, raw);
  }

  return {
    id: TRANSPORT_ID,
    async submitText(input = {}) {
      return submit(enqueueText, input);
    },
    async submitArtifacts(input = {}) {
      return submit(enqueueArtifacts, input);
    },
    async wait(requestId, waitOptions = {}) {
      const waited = await waitJob(requestId, waitOptions);
      const job = syncJobFrom(waited) || (await getJob(requestId));
      return toEnvelope(requestId, job, waited, {
        raw: {
          submitted: submittedRaw.get(requestId) || null,
          waited
        }
      });
    },
    async cancel(requestId, cancelOptions = {}) {
      const submitted = submittedRaw.get(requestId);
      let existing;
      try {
        existing = await getJob(requestId);
      } catch (error) {
        existing = syncJobFrom(submitted);
        if (!existing) {
          throw error;
        }
      }
      const existingStatus = publicStatus(existing);
      if (["succeeded", "failed", "cancelled"].includes(existingStatus)) {
        return toEnvelope(requestId, existing, existing, {
          status: existingStatus,
          raw: existing
        });
      }
      const cancelled = await cancelJob(requestId, cancelOptions);
      const cancelledJob = syncJobFrom(cancelled) || cancelled;
      let latestJob = null;
      try {
        latestJob = await getJob(requestId);
      } catch {
        latestJob = null;
      }
      const latestStatus = latestJob ? publicStatus(latestJob) : null;
      const job = latestJob && ["succeeded", "failed", "cancelled"].includes(latestStatus)
        ? latestJob
        : cancelledJob;
      const finalStatus = publicStatus(job);
      return toEnvelope(requestId, job, job, {
        status: finalStatus,
        error:
          finalStatus === "cancelled"
            ? cancelOptions.reason || job?.error || "Router run cancelled"
            : undefined,
        raw: job
      });
    }
  };
}
