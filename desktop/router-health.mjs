export async function probeRouterHealth({
  origin = "http://127.0.0.1:15722",
  timeoutMs = 2500,
  fetchImpl = fetch,
} = {}) {
  const target = `${String(origin || "").replace(/\/+$/, "")}/health`;
  const controller = typeof AbortController !== "undefined"
    ? new AbortController()
    : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const response = await fetchImpl(target, controller ? { signal: controller.signal } : {});
    const body = await response.json().catch(() => ({}));
    const models = Array.isArray(body?.models) ? body.models.map(String) : [];
    if (!response.ok || body?.ok === false) {
      return {
        ok: false,
        status: Number(response.status || 0),
        models,
        message: `Router health returned HTTP ${response.status || 0}`,
        checkedAt: new Date().toISOString(),
      };
    }
    return {
      ok: true,
      status: Number(response.status || 200),
      models,
      message: `Router health OK: ${models.length} models loaded`,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      models: [],
      message: healthErrorMessage(error),
      checkedAt: new Date().toISOString(),
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function waitForRouterHealth({
  origin = "http://127.0.0.1:15722",
  timeoutMs = 2500,
  maxWaitMs = 20000,
  intervalMs = 500,
  fetchImpl = fetch,
  sleepImpl = delay,
  nowImpl = () => Date.now(),
  isStillStarting = () => true,
} = {}) {
  const startedAt = nowImpl();
  let attempts = 0;
  let result = null;

  while (true) {
    attempts += 1;
    result = await probeRouterHealth({ origin, timeoutMs, fetchImpl });
    result.attempts = attempts;
    if (result.ok) {
      return result;
    }
    if (!isStillStarting()) {
      return {
        ...result,
        message: `Router process exited before health check passed: ${result.message}`,
      };
    }
    const remainingMs = maxWaitMs - (nowImpl() - startedAt);
    if (remainingMs <= 0) {
      return result;
    }
    await sleepImpl(Math.min(intervalMs, remainingMs));
  }
}

function healthErrorMessage(error) {
  const cause = error?.cause?.code || error?.cause?.message || "";
  const message = error?.name === "AbortError"
    ? "Router health check timed out"
    : error?.message || String(error || "unknown error");
  return cause ? `${message} (${cause})` : message;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
