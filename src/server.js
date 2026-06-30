import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authModeForRoute, loadConfig, routeForModel } from "./config.js";
import { ResponseHistory } from "./history.js";
import {
  jsonResponse,
  openAiError,
  readJsonRequest,
} from "./json.js";
import { buildModelCatalog, openAiModelsList } from "./model-catalog.js";
import { isResponsesCompactPath, requestHasCompactionTrigger } from "./compact.js";
import { responseToSse } from "./chat-to-responses.js";
import {
  handleResponsesRequest,
  sendUpstreamError,
  upstreamErrorLogPreview,
} from "./upstream.js";
import { classifyUpstreamError, createRouteHealthStore } from "./route-health.js";
import { normalizeAdapterProfile } from "./adapter-profile.js";

const DEFAULT_JSON_BODY_LIMIT_BYTES = 25 * 1024 * 1024;
const DEFAULT_RESPONSES_BODY_LIMIT_BYTES = 100 * 1024 * 1024;
const BENIGN_ROUTER_PROCESS_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "ETIMEDOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
]);
let routerProcessGuardsInstalled = false;

export function isBenignRouterProcessError(error) {
  const candidates = [
    error?.code,
    error?.errno,
    error?.cause?.code,
    error?.cause?.errno,
  ]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value));
  if (candidates.some((code) => BENIGN_ROUTER_PROCESS_ERROR_CODES.has(code))) {
    return true;
  }
  const message = String(error?.message || error || "");
  return [...BENIGN_ROUTER_PROCESS_ERROR_CODES].some((code) => message.includes(code));
}

export function installRouterProcessGuards(processLike = process) {
  if (routerProcessGuardsInstalled || !processLike?.on) {
    return;
  }
  routerProcessGuardsInstalled = true;
  const handleProcessError = (label, error) => {
    if (isBenignRouterProcessError(error)) {
      console.warn(
        `[${new Date().toISOString()}] router ${label}: ignored benign network/socket error: ` +
          safeLogValue(error?.stack || error?.message || error),
      );
      return;
    }
    console.error(
      `[${new Date().toISOString()}] router ${label}: fatal error: ` +
        (error?.stack || error?.message || error),
    );
    processLike.exitCode = 1;
    if (typeof processLike.exit === "function") {
      processLike.exit(1);
    }
  };
  processLike.on("uncaughtException", (error) => {
    handleProcessError("uncaughtException", error);
  });
  processLike.on("unhandledRejection", (reason) => {
    handleProcessError("unhandledRejection", reason);
  });
}

export function createRouterServer(config = loadConfig()) {
  const history = new ResponseHistory();
  const routeHealth = createRouteHealthStore();
  const socketsWithErrorHandler = new WeakSet();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      logAccess(req, url);
      const activeConfig = currentConfig(config);

      if (req.method === "OPTIONS") {
        writeCors(res);
        return;
      }

      if (isUpgradeRequest(req) && isResponsesCollection(url.pathname)) {
        jsonResponse(
          res,
          426,
          openAiError(
            `CodexBridge Router does not support WebSocket on ${url.pathname}. Use HTTP streaming for Responses requests.`,
            426,
            "websocket_not_supported",
          ),
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        const health = routeHealth.snapshot(activeConfig);
        jsonResponse(res, 200, {
          ok: true,
          config: activeConfig.__path || null,
          models: activeConfig.models.map((model) => model.id),
          routes: health.routes,
          unhealthyRoutes: health.unhealthyRoutes,
        });
        return;
      }

      if (
        req.method === "GET" &&
        ["/v1/models", "/models"].includes(url.pathname)
      ) {
        jsonResponse(res, 200, openAiModelsList(activeConfig));
        return;
      }

      if (
        req.method === "GET" &&
        ["/model-catalog.json", "/v1/model-catalog.json"].includes(url.pathname)
      ) {
        jsonResponse(res, 200, buildModelCatalog(activeConfig));
        return;
      }

      if (req.method === "GET" && isResponsesCollection(url.pathname)) {
        jsonResponse(res, 200, {
          object: "list",
          data: [],
          has_more: false,
        });
        return;
      }

      const responseItemId = responseIdFromItemPath(url.pathname);
      if (req.method === "GET" && responseItemId) {
        jsonResponse(
          res,
          200,
          history.getResponse(responseItemId) ||
            placeholderResponse(responseItemId, activeConfig.defaultModel),
        );
        return;
      }

      const responseCancelId = responseIdFromCancelPath(url.pathname);
      if (req.method === "POST" && responseCancelId) {
        jsonResponse(
          res,
          200,
          placeholderResponse(responseCancelId, activeConfig.defaultModel, "cancelled"),
        );
        return;
      }

      if (
        ["PATCH", "PUT"].includes(req.method || "") &&
        isModelSettingsPath(url.pathname)
      ) {
        const body = await readJsonRequest(req, requestBodyLimitBytes(activeConfig, url.pathname));
        jsonResponse(res, 200, {
          ok: true,
          object: "codexbridge.model_settings",
          model: body.model || activeConfig.defaultModel || null,
          model_reasoning_effort:
            body.model_reasoning_effort || body.reasoning_effort || null,
        });
        return;
      }

      if (
        req.method === "POST" &&
        isResponsesPostPath(url.pathname)
      ) {
        const body = await readJsonRequest(req, requestBodyLimitBytes(activeConfig, url.pathname));
        const requestId = makeRequestId();
        const isCodexClient = isCodexClientRequest(req);
        const compactKind = compactKindForRequest(url.pathname, body);
        let route;
        try {
          route = routeForModel(activeConfig, body.model, {
            exactModelIdOnly: isCodexClient,
          });
        } catch (error) {
          if (isCodexClient && error?.code === "model_not_configured") {
            console.warn(
              `[${new Date().toISOString()}] ${requestId} !! local-model-guard ` +
                `model=${body.model || "(default)"} reason=model_not_configured`,
            );
            sendLocalCompletedResponse(res, body, modelNotConfiguredLocalResponse(body.model, error));
            return;
          }
          throw error;
        }
        const clientAuth = authorizeClient(req, activeConfig, route);
        if (!clientAuth.ok) {
          jsonResponse(
            res,
            401,
            openAiError(
              "CodexBridge Router token mismatch. 请在 CodexBridge 关闭并重新开启 Router，配置会自动刷新，然后重试。",
              401,
              "invalid_router_token",
            ),
          );
          return;
        }
        const clientAbort = clientAbortContext(req, res);
        console.log(
          `[${new Date().toISOString()}] ${requestId} <- /v1/responses ` +
            `model=${body.model || "(default)"} route=${route.id} ` +
            `api=${route.api} upstream_model=${route.model} stream=${Boolean(body.stream)} ` +
            `provider=${providerLogLabel(route)} ` +
            `compact=${compactKind || "-"} ` +
            `previous_response_id=${body.previous_response_id || "-"} ` +
            `client_auth=${clientAuth.kind} upstream_auth=${authModeForRoute(route)}`,
        );
        try {
          await handleResponsesRequest(body, route, history, res, {
            requestId,
            clientAuth,
            clientHeaders: req.headers,
            clientSignal: clientAbort.signal,
            compactKind,
          });
          routeHealth.recordSuccess(route);
        } catch (error) {
          if (error?.code === "client_closed_request") {
            console.warn(
              `[${new Date().toISOString()}] ${requestId} !! client closed request before upstream completed`,
            );
            return;
          }
          routeHealth.recordError(route, error, { compactKind });
          console.error(requestErrorLine(requestId, route, error, { compactKind }));
          if (!res.destroyed && !res.writableEnded) {
            sendUpstreamError(res, error, {
              asResponsesStream: Boolean(body.stream),
              model: body.model || route.id || route.model || null,
            });
          }
        } finally {
          clientAbort.cleanup();
        }
        return;
      }

      jsonResponse(res, 404, openAiError(`No route for ${req.method} ${url.pathname}`, 404));
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] router error: ${error.stack || error.message}`,
      );
      if (!res.destroyed && !res.writableEnded) {
        sendUpstreamError(res, error);
      }
    }
  });
  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (isResponsesCollection(url.pathname)) {
      writeUpgradeRejected(socket, url.pathname);
      return;
    }
    socket.destroy();
  });
  server.on("connection", (socket) => {
    attachClientSocketErrorHandler(socket, socketsWithErrorHandler);
  });
  server.on("clientError", (error, socket) => {
    handleClientSocketError(error, socket);
  });
  return server;
}

function sendLocalCompletedResponse(res, requestBody = {}, response) {
  if (requestBody.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.end(responseToSse(response));
    return;
  }
  jsonResponse(res, 200, response);
}

function modelNotConfiguredLocalResponse(requestedModel, error) {
  const id = `resp_model_not_configured_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const requested = requestedModel || "(default)";
  const detail = error?.message ? `\n\n技术细节：${error.message}` : "";
  const outputText =
    `CodexBridge 已在本地拦截旧模型槽位请求：${requested}。\n` +
    "这通常来自旧对话或旧 Codex 模型槽位重放。CodexBridge 没有请求任何上游 provider，也没有消耗上游模型 token。\n" +
    "请在当前对话的模型下拉里重新选择 CodexBridge 的 cb-* 模型，或点击 CodexBridge「初始化 Codex 配置」后新开会话再继续。" +
    detail;
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel || null,
    output: [
      {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: outputText,
            annotations: [],
          },
        ],
      },
    ],
    output_text: outputText,
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    usage: null,
  };
}

function attachClientSocketErrorHandler(socket, socketsWithErrorHandler) {
  if (!socket || socketsWithErrorHandler.has(socket)) {
    return;
  }
  socketsWithErrorHandler.add(socket);
  socket.on?.("error", (error) => {
    handleClientSocketError(error, socket);
  });
}

function requestBodyLimitBytes(config = {}, pathname = "") {
  const configured = isResponsesPostPath(pathname)
    ? Number(
        config.responsesRequestBodyLimitBytes ??
          config.responses_request_body_limit_bytes ??
          config.requestBodyLimitBytes ??
          config.request_body_limit_bytes,
      )
    : Number(config.requestBodyLimitBytes ?? config.request_body_limit_bytes);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  if (isResponsesPostPath(pathname)) {
    return DEFAULT_RESPONSES_BODY_LIMIT_BYTES;
  }
  return DEFAULT_JSON_BODY_LIMIT_BYTES;
}

export function startServer(config = loadConfig()) {
  const server = createRouterServer(config);
  const host = config.host || "127.0.0.1";
  const port = Number(config.port || 15722);
  server.listen(port, host, () => {
    console.log(`codex-multi-router listening on http://${host}:${port}`);
    console.log(`loaded config: ${config.__path || "(inline)"}`);
    console.log(`models: ${config.models.map((model) => model.id).join(", ")}`);
  });
  return server;
}

function logAccess(req, url) {
  console.log(
    `[${new Date().toISOString()}] access ${req.method || "GET"} ${url.pathname} ` +
      `host=${safeLogValue(req.headers.host || "-")} ` +
      `ua=${safeLogValue(req.headers["user-agent"] || "-")}`,
  );
}

function authorizeClient(req, config, route) {
  const bearerToken = bearerTokenFromHeader(req.headers.authorization);
  if (!config.authToken) {
    if (bearerToken) {
      return { ok: true, kind: "codex_openai", bearerToken };
    }
    return { ok: true, kind: "none" };
  }
  if (bearerToken && bearerToken === config.authToken) {
    return { ok: true, kind: "local", bearerToken };
  }
  if (
    bearerToken &&
    (config.clientAuth?.allowOpenAiBearer || authModeForRoute(route) === "codex_openai")
  ) {
    return { ok: true, kind: "codex_openai", bearerToken };
  }
  return { ok: false, kind: "invalid" };
}

function currentConfig(config) {
  if (!config.__path) {
    return config;
  }
  return loadConfig(config.__path);
}

function bearerTokenFromHeader(value) {
  if (!value || typeof value !== "string") {
    return "";
  }
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function clientAbortContext(req, res) {
  const controller = new AbortController();
  const abort = (reason) => {
    if (!res.writableEnded && !controller.signal.aborted) {
      const message = reason?.message || "client connection closed";
      controller.abort(new Error(message));
    }
  };
  const socketError = (error) => {
    abort(error);
  };
  req.once("aborted", abort);
  res.once("close", abort);
  req.socket?.once?.("close", abort);
  req.socket?.once?.("error", socketError);
  return {
    signal: controller.signal,
    cleanup() {
      req.off("aborted", abort);
      res.off("close", abort);
      req.socket?.off?.("close", abort);
      req.socket?.off?.("error", socketError);
    },
  };
}

function handleClientSocketError(error, socket) {
  const code = String(error?.code || "");
  const message = safeLogValue(error?.message || error || "unknown client socket error");
  console.warn(`[${new Date().toISOString()}] client socket error${code ? ` code=${code}` : ""}: ${message}`);
  if (!socket || socket.destroyed) {
    return;
  }
  if (code === "ECONNRESET" || code === "EPIPE") {
    socket.destroy();
    return;
  }
  try {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
  } catch {
    // Fall through to destroy; socket cleanup must not crash the router.
  }
  socket.destroy();
}

function writeCors(res) {
  res.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  });
  res.end();
}

function isUpgradeRequest(req) {
  const connectionTokens = String(req.headers.connection || "")
    .toLowerCase()
    .split(",")
    .map((item) => item.trim());
  return (
    String(req.headers.upgrade || "").toLowerCase() === "websocket" ||
    connectionTokens.includes("upgrade")
  );
}

function writeUpgradeRejected(socket, pathname) {
  const body = JSON.stringify(
    openAiError(
      `CodexBridge Router does not support WebSocket on ${pathname}. Use HTTP streaming for Responses requests.`,
      426,
      "websocket_not_supported",
    ),
  );
  socket.write(
    [
      "HTTP/1.1 426 Upgrade Required",
      "Connection: close",
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n"),
  );
  socket.end();
}

function isResponsesCollection(pathname) {
  return ["/v1/responses", "/responses"].includes(pathname);
}

function isResponsesPostPath(pathname) {
  return isResponsesCollection(pathname) || isResponsesCompactPath(pathname);
}

function compactKindForPath(pathname) {
  return isResponsesCompactPath(pathname) ? "v1" : "";
}

function compactKindForRequest(pathname, body) {
  return compactKindForPath(pathname) || (requestHasCompactionTrigger(body) ? "v2" : "");
}

function isModelSettingsPath(pathname) {
  if (isResponsesCollection(pathname)) {
    return true;
  }
  return /^\/(?:v1\/)?responses\/[^/]+(?:\/model_settings)?$/.test(pathname);
}

function responseIdFromItemPath(pathname) {
  const match = pathname.match(/^\/(?:v1\/)?responses\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function responseIdFromCancelPath(pathname) {
  const match = pathname.match(/^\/(?:v1\/)?responses\/([^/]+)\/cancel$/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function placeholderResponse(id, model, status = "completed") {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: model || null,
    output: [],
    output_text: "",
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null,
    usage: null,
  };
}

function makeRequestId() {
  return `req_${Math.random().toString(36).slice(2, 10)}`;
}

function requestErrorLine(requestId, route, error, context = {}) {
  const status = error?.statusCode || 599;
  const cause = error?.cause?.code || error?.cause?.message || "";
  const classification = classifyUpstreamError(error, { route, ...context });
  return (
    `[${new Date().toISOString()}] ${requestId} !! upstream ` +
    `route=${route.id} status=${status} error=${safeLogValue(error?.message || String(error))}` +
    ` error_type=${classification.type}` +
    (cause ? ` cause=${safeLogValue(cause)}` : "") +
    upstreamErrorLogPreview(error)
  );
}

function providerLogLabel(route = {}) {
  const explicitProvider = route.provider || route.providerFamily || route.providerId;
  if (explicitProvider) {
    return explicitProvider;
  }
  try {
    const profile = normalizeAdapterProfile({
      ...route,
      baseUrl: "",
      provider: route.model || route.sourcePresetId || route.id || route.baseUrl,
    });
    return profile.providerFamily || "-";
  } catch {
    return "-";
  }
}

function isCodexClientRequest(req = {}) {
  const headers = req.headers || {};
  const userAgent = String(headers["user-agent"] || "").toLowerCase();
  return (
    userAgent.includes("codex") ||
    Boolean(headers["x-codex-thread-id"]) ||
    Boolean(headers["x-codex-window-id"]) ||
    Boolean(headers["x-codex-installation-id"])
  );
}

function safeLogValue(value) {
  return String(value || "")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (path.resolve(thisFile) === invokedFile) {
  installRouterProcessGuards();
  startServer();
}
