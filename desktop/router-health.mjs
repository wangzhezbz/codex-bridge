import boundedResponseBody from "../shared/bounded-response-body.cjs";
import networkDeadline from "../shared/network-deadline.cjs";

const { readBoundedResponseText } = boundedResponseBody;
const { runWithNetworkDeadline } = networkDeadline;
const MAX_HEALTH_BODY_BYTES = 256 * 1_024;

export async function probeRouterHealth({
  origin = "http://127.0.0.1:15722",
  timeoutMs = 2500,
  fetchImpl = fetch,
} = {}) {
  const target = `${String(origin || "").replace(/\/+$/, "")}/health`;
  try {
    const { response, body } = await runWithNetworkDeadline(async (signal) => {
      const nextResponse = await fetchImpl(target, { signal });
      return {
        response: nextResponse,
        body: await readHealthBody(nextResponse, signal),
      };
    }, {
      timeoutMs,
      createTimeoutError: () => routerHealthError("router_health_timeout", "Router health check timed out"),
    });
    const models = Array.isArray(body?.models) ? body.models.map(String) : [];
    const routes = Array.isArray(body?.routes) ? body.routes : [];
    const unhealthyRoutes = Number.isFinite(Number(body?.unhealthyRoutes))
      ? Number(body.unhealthyRoutes)
      : routes.filter((route) =>
          route?.status === "degraded" || route?.status === "rate_limited"
        ).length;
    if (!response.ok || body?.ok === false) {
      return {
        ok: false,
        status: Number(response.status || 0),
        models,
        routes,
        unhealthyRoutes,
        message: `Router health returned HTTP ${response.status || 0}`,
        checkedAt: new Date().toISOString(),
      };
    }
    return {
      ok: true,
      status: Number(response.status || 200),
      models,
      routes,
      unhealthyRoutes,
      message: healthyMessage(models.length, unhealthyRoutes),
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      models: [],
      routes: [],
      unhealthyRoutes: 0,
      message: healthErrorMessage(error),
      checkedAt: new Date().toISOString(),
    };
  }
}

async function readHealthBody(response, signal) {
  if (response?.body || typeof response?.text === "function" || typeof response?.arrayBuffer === "function") {
    const text = await readBoundedResponseText(response, {
      maxBytes: MAX_HEALTH_BODY_BYTES,
      signal,
      createTooLargeError: () => routerHealthError(
        "router_health_response_too_large",
        "Router health response is too large",
      ),
    });
    try { return text ? JSON.parse(text) : {}; }
    catch { return {}; }
  }
  if (typeof response?.json === "function") {
    const body = await response.json().catch(() => ({}));
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized, "utf8") > MAX_HEALTH_BODY_BYTES) {
      throw routerHealthError("router_health_response_too_large", "Router health response is too large");
    }
    return body;
  }
  return {};
}

function routerHealthError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
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

function healthyMessage(modelCount, unhealthyRoutes) {
  if (unhealthyRoutes > 0) {
    return `Router 健康检查通过：已加载 ${modelCount} 个模型，${unhealthyRoutes} 条路由需要关注`;
  }
  return `Router 健康检查通过：已加载 ${modelCount} 个模型`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
