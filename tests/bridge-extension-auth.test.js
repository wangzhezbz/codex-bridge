import test from "node:test";
import assert from "node:assert/strict";
import { createBridgeApiClient } from "../vendor/chatgpt-codex-bridge/public/bridge-api-client.js";

function jsonResponse(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return value;
    },
  };
}

test("embedded browser client bootstraps the Bridge API token before mutation", async () => {
  const calls = [];
  const client = createBridgeApiClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return url === "/api/config"
        ? jsonResponse(200, { apiToken: "embedded-page-token" })
        : jsonResponse(201, { id: "task_secured" });
    },
  });

  const response = await client.fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  assert.equal(response.status, 201);
  assert.deepEqual(calls.map((call) => call.url), ["/api/config", "/api/tasks"]);
  assert.equal(calls[1].options.headers["X-Bridge-Token"], "embedded-page-token");
  assert.equal(calls[1].options.headers["Content-Type"], "application/json");
});

test("embedded browser client refreshes its token once after service restart", async () => {
  const calls = [];
  const client = createBridgeApiClient({
    apiToken: "expired-token",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (url === "/api/config") {
        return jsonResponse(200, { apiToken: "replacement-token" });
      }
      return options.headers["X-Bridge-Token"] === "expired-token"
        ? jsonResponse(401, { error: "Bridge API token is required" })
        : jsonResponse(200, { ok: true });
    },
  });

  const response = await client.fetch("/api/projects/current-session", {
    method: "POST",
    body: "{}",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.url), [
    "/api/projects/current-session",
    "/api/config",
    "/api/projects/current-session",
  ]);
  assert.equal(calls[2].options.headers["X-Bridge-Token"], "replacement-token");
});
