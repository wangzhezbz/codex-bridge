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
import { handleResponsesRequest, sendUpstreamError } from "./upstream.js";

export function createRouterServer(config = loadConfig()) {
  const history = new ResponseHistory();

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const activeConfig = currentConfig(config);

      if (req.method === "OPTIONS") {
        writeCors(res);
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        jsonResponse(res, 200, {
          ok: true,
          config: activeConfig.__path || null,
          models: activeConfig.models.map((model) => model.id),
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

      if (
        req.method === "POST" &&
        ["/v1/responses", "/responses"].includes(url.pathname)
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
        console.log(
          `[${new Date().toISOString()}] ${requestId} <- /v1/responses ` +
            `model=${body.model || "(default)"} route=${route.id} ` +
            `api=${route.api} upstream_model=${route.model} stream=${Boolean(body.stream)} ` +
            `previous_response_id=${body.previous_response_id || "-"} ` +
            `client_auth=${clientAuth.kind} upstream_auth=${authModeForRoute(route)}`,
        );
        try {
          await handleResponsesRequest(body, route, history, res, {
            requestId,
            clientAuth,
            clientHeaders: req.headers,
          });
        } catch (error) {
          console.error(requestErrorLine(requestId, route, error));
          sendUpstreamError(res, error);
        }
        return;
      }

      jsonResponse(res, 404, openAiError(`No route for ${req.method} ${url.pathname}`, 404));
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] router error: ${error.stack || error.message}`,
      );
      sendUpstreamError(res, error);
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

function writeCors(res) {
  res.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  });
  res.end();
}

function makeRequestId() {
  return `req_${Math.random().toString(36).slice(2, 10)}`;
}

function requestErrorLine(requestId, route, error) {
  const status = error?.statusCode || 599;
  const cause = error?.cause?.code || error?.cause?.message || "";
  return (
    `[${new Date().toISOString()}] ${requestId} !! upstream ` +
    `route=${route.id} status=${status} error=${safeLogValue(error?.message || String(error))}` +
    (cause ? ` cause=${safeLogValue(cause)}` : "")
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
