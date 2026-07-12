import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  resolveResponseHistoryPath,
  resolveRouterDataRoot,
} from "../src/router-data-dir.js";

test("Router history path prefers CODEXBRIDGE_DATA_DIR", () => {
  const dataRoot = path.resolve("D:\\CodexBridge-Test-Data");
  const env = {
    CODEXBRIDGE_DATA_DIR: dataRoot,
    ROUTER_CONFIG: path.resolve("ignored", "config", "router.config.json"),
  };

  assert.equal(resolveRouterDataRoot({ env, cwd: path.resolve("ignored-cwd") }), dataRoot);
  assert.equal(
    resolveResponseHistoryPath({ env, cwd: path.resolve("ignored-cwd") }),
    path.join(dataRoot, "state", "response-history.sqlite3"),
  );
});

test("Router history path derives the Bridge root from ROUTER_CONFIG then cwd", () => {
  const bridgeRoot = path.resolve("F:\\portable-codexbridge");
  const configPath = path.join(bridgeRoot, "config", "router.config.json");

  assert.equal(
    resolveRouterDataRoot({ env: { ROUTER_CONFIG: configPath }, cwd: path.resolve("ignored") }),
    bridgeRoot,
  );
  assert.equal(
    resolveResponseHistoryPath({ env: {}, cwd: bridgeRoot }),
    path.join(bridgeRoot, "state", "response-history.sqlite3"),
  );
});
