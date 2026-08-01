import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const extensionDir = path.join(
  process.cwd(),
  "vendor",
  "chatgpt-codex-bridge",
  "chrome-extension",
);

function loadBridgeAuth(config = {}) {
  const context = vm.createContext({ CODEX_BRIDGE_CONFIG: config });
  const source = fs.readFileSync(path.join(extensionDir, "bridge-auth.js"), "utf8");
  vm.runInContext(source, context, { filename: "bridge-auth.js" });
  return context.CODEX_BRIDGE_AUTH;
}

test("extension bridge auth adds the installed token without dropping caller headers", () => {
  const auth = loadBridgeAuth({ authToken: "a".repeat(64) });

  const headers = auth.authorizedHeaders({
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-CodexBridge-Token": "caller-must-not-override-installed-token",
  });

  assert.deepEqual({ ...headers }, {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-CodexBridge-Token": "a".repeat(64),
  });
});

test("extension bridge auth omits the token header when no token is configured", () => {
  const auth = loadBridgeAuth({});

  assert.deepEqual({ ...auth.authorizedHeaders({ Accept: "application/json" }) }, {
    Accept: "application/json",
  });
});

test("extension manifest loads bridge auth before the content script", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"),
  );

  assert.deepEqual(manifest.content_scripts[0].js, [
    "bridge-config.js",
    "bridge-auth.js",
    "content-script.js",
  ]);
});
