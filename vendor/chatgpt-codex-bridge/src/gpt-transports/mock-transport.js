const TRANSPORT_ID = "mock";
const VALID_STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);

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

function clonePayload(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function errorText(value) {
  if (value == null) {
    return null;
  }
  return value instanceof Error ? value.message : String(value);
}

function envelope(requestId, input = {}) {
  const status = input.status || "succeeded";
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid mock GPT transport status: ${status}`);
  }
  return {
    transportId: TRANSPORT_ID,
    requestId,
    status,
    replyText: input.replyText == null ? null : String(input.replyText),
    artifacts: Array.isArray(input.artifacts) ? clonePayload(input.artifacts) : [],
    error: errorText(input.error),
    raw: input.raw ?? null
  };
}

function configuredResponse(responses, submission) {
  if (Array.isArray(responses)) {
    return responses[submission.sequence - 1] || {};
  }
  if (responses && typeof responses === "object") {
    return responses[submission.stageId] ?? responses.default ?? {};
  }
  return {};
}

export function createMockGptTransport(options = {}) {
  const responses = options.responses || {};
  const clock = options.clock || (() => new Date());
  const requestIdFactory =
    options.requestIdFactory || (({ sequence }) => `mock-request-${sequence}-${Date.now()}`);
  const requests = new Map();
  const submissions = [];

  async function submit(kind, input = {}) {
    const sequence = submissions.length + 1;
    const stageId = String(input.stageId || `stage-${sequence}`);
    const payload = clonePayload(input);
    const requestId = String(
      input.requestId || requestIdFactory({ sequence, kind, stageId, payload })
    ).trim();
    if (!requestId) {
      throw new Error("Mock GPT transport requestId is required");
    }
    const existing = requests.get(requestId);
    if (existing) {
      if (
        existing.submission.kind !== kind ||
        existing.submission.stageId !== stageId ||
        JSON.stringify(existing.submission.payload) !== JSON.stringify(payload)
      ) {
        throw new Error(`Mock GPT transport request id was reused with a different payload: ${requestId}`);
      }
      return existing.result
        ? clonePayload(existing.result)
        : envelope(requestId, { status: "queued" });
    }
    const submission = {
      sequence,
      kind,
      requestId,
      stageId,
      payload,
      submittedAt: nowIso(clock)
    };
    submissions.push(submission);
    requests.set(requestId, {
      submission,
      configured: configuredResponse(responses, submission),
      result: null
    });
    return envelope(requestId, { status: "queued" });
  }

  function requestRecord(requestId) {
    const record = requests.get(requestId);
    if (!record) {
      throw new Error(`Mock GPT transport request not found: ${requestId}`);
    }
    return record;
  }

  return {
    id: TRANSPORT_ID,
    submissions,
    async submitText(input = {}) {
      return submit("text", input);
    },
    async submitArtifacts(input = {}) {
      return submit("artifacts", input);
    },
    async wait(requestId) {
      const record = requestRecord(requestId);
      if (record.result) {
        return clonePayload(record.result);
      }
      const configured =
        typeof record.configured === "function"
          ? await record.configured(clonePayload(record.submission))
          : record.configured;
      record.result = envelope(requestId, configured || {});
      return clonePayload(record.result);
    },
    async cancel(requestId, cancelOptions = {}) {
      const record = requestRecord(requestId);
      if (record.result && ["succeeded", "failed", "cancelled"].includes(record.result.status)) {
        return clonePayload(record.result);
      }
      record.result = envelope(requestId, {
        status: "cancelled",
        error: cancelOptions.reason || "Mock GPT transport request cancelled"
      });
      return clonePayload(record.result);
    }
  };
}
