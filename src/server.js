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
import {
  handleResponsesRequest,
  sendUpstreamError,
  upstreamErrorLogPreview,
} from "./upstream.js";
import { classifyUpstreamError, createRouteHealthStore } from "./route-health.js";

export function createRouterServer(config = loadConfig()) {
  const history = new ResponseHistory();
  const routeHealth = createRouteHealthStore();

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      logAccess(req, url);
      const activeConfig = currentConfig(config);

      if (req.method === "OPTIONS") {
        writeCors(res);
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
        const body = await readJsonRequest(req);
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
        const body = await readJsonRequest(req);
        const route = routeForModel(activeConfig, body.model);
        const clientAuth = authorizeClient(req, activeConfig, route);
        if (!clientAuth.ok) {
          jsonResponse(
            res,
            401,
            openAiError(
              "CodexBridge Router token mismatch. 请在 CodexBridge 点“更新 Codex 配置”，关闭并重新启动 Router，然后重试。",
              401,
              "invalid_router_token",
            ),
          );
          return;
        }
        const requestId = makeRequestId();
        const clientAbort = clientAbortContext(req, res);
        const compactKind = compactKindForRequest(url.pathname, body);
        console.log(
          `[${new Date().toISOString()}] ${requestId} <- /v1/responses ` +
            `model=${body.model || "(default)"} route=${route.id} ` +
            `api=${route.api} upstream_model=${route.model} stream=${Boolean(body.stream)} ` +
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
            sendUpstreamError(res, error);
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
  const abort = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(new Error("client connection closed"));
    }
  };
  req.once("aborted", abort);
  res.once("close", abort);
  return {
    signal: controller.signal,
    cleanup() {
      req.off("aborted", abort);
      res.off("close", abort);
    },
  };
}

function writeCors(res) {
  res.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  });
  res.end();
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
  startServer();
}
