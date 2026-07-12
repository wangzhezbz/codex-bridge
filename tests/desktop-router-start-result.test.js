import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createConfigWriteCoordinator,
} from "../desktop/config-write-coordinator.mjs";

const require = createRequire(import.meta.url);
const { runRouterStartForIpc } = require("../desktop/router-start-result.cjs");

test("safe Router start result preserves a successful payload", async () => {
  const started = { pid: 1234, ready: true };

  const result = await runRouterStartForIpc(async () => started);

  assert.deepEqual(result, { ok: true, result: started });
});

test("safe Router start result maps ACL failures without reflecting the rejected error", async () => {
  const reports = [];
  const result = await runRouterStartForIpc(async () => {
    const error = new Error("must not be reflected");
    error.code = "config_transaction_failed";
    error.failurePhase = "private_staging";
    error.causeCode = "windows_private_acl_command_failed";
    throw error;
  }, (diagnostic) => reports.push(diagnostic));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "config_transaction_failed");
  assert.equal(result.error.failurePhase, "private_staging");
  assert.equal(result.error.causeCode, "windows_private_acl_command_failed");
  assert.match(result.error.message, /无法安全更新配置文件/);
  assert.match(result.error.message, /CodexBridge 数据目录/);
  assert.match(result.error.message, /ChatGPT \/ Codex 配置目录/);
  assert.match(result.error.message, /\.codex/);
  assert.match(result.error.message, /不可写链接/);
  assert.doesNotMatch(JSON.stringify(result), /must not be reflected/);
  assert.doesNotMatch(result.error.message, /Error invoking remote method/i);
  assert.deepEqual(reports, [{
    failurePhase: "private_staging",
    causeCode: "windows_private_acl_command_failed",
  }]);
});

test("safe Router start result maps unsafe path and link causes to a fixed directory action", async () => {
  const result = await runRouterStartForIpc(async () => {
    const error = new Error("C:\\secret\\candidate.toml is a junction");
    error.code = "config_transaction_failed";
    error.failurePhase = "validation";
    error.causeCode = "config_write_unsafe_path";
    throw error;
  });

  assert.equal(result.ok, false);
  assert.match(result.error.message, /配置目录/);
  assert.doesNotMatch(JSON.stringify(result), /candidate\.toml|C:\\secret/i);
});

test("safe Router start result maps Windows file permission failures to an actionable message", async () => {
  const result = await runRouterStartForIpc(async () => {
    const error = new Error("C:\\secret\\config.toml permission denied");
    error.code = "config_transaction_failed";
    error.failurePhase = "commit";
    error.causeCode = "EACCES";
    throw error;
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.causeCode, "eacces");
  assert.match(result.error.message, /Windows 账户/);
  assert.match(result.error.message, /诊断码：eacces/);
  assert.doesNotMatch(JSON.stringify(result), /secret|config\.toml|permission denied/i);
});

test("safe Router start result explains a classified port conflict", async () => {
  const result = await runRouterStartForIpc(async () => {
    const error = new Error("must not be reflected");
    error.code = "ROUTER_PROCESS_EXITED_DURING_START";
    error.causeCode = "router_port_in_use";
    throw error;
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.causeCode, "router_port_in_use");
  assert.match(result.error.message, /端口已被占用/);
  assert.match(result.error.message, /设置/);
  assert.match(result.error.message, /诊断码：router_port_in_use/);
});

test("safe Router start result exposes a bounded lifecycle diagnostic instead of a generic unknown", async () => {
  const result = await runRouterStartForIpc(async () => {
    const error = new Error("must not be reflected");
    error.code = "ROUTER_PROCESS_EXITED_DURING_START";
    throw error;
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.causeCode, "router_process_exited_during_start");
  assert.match(result.error.message, /启动后立即退出/);
  assert.match(result.error.message, /诊断码：router_process_exited_during_start/);
  assert.doesNotMatch(JSON.stringify(result), /must not be reflected/);
});

test("real coordinator unsafe-path failures reach the Router directory action", async () => {
  const allowedRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-router-start-allowed-"),
  );
  const outsideRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-router-start-outside-"),
  );
  const outsideTarget = path.join(outsideRoot, "must-not-write.json");
  const coordinator = createConfigWriteCoordinator({
    allowedRoots: [allowedRoot],
    journalDir: path.join(allowedRoot, ".transactions"),
  });

  const result = await runRouterStartForIpc(() => coordinator.runTransaction({
    operation: "router:start",
    prepare: async () => ({
      entries: [{
        id: "outside",
        target: outsideTarget,
        content: "must-not-write",
        validate: async () => {},
      }],
    }),
  }));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "config_transaction_failed");
  assert.equal(result.error.failurePhase, "planning");
  assert.equal(result.error.causeCode, "config_write_unsafe_path");
  assert.match(result.error.message, /配置目录/);
  assert.equal(fs.existsSync(outsideTarget), false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(outsideRoot.replaceAll("\\", "\\\\"), "i"));
});

test("safe Router start result bounds unknown metadata and returns a fixed generic action", async () => {
  const reports = [];
  const result = await runRouterStartForIpc(async () => {
    const error = new Error("must not be reflected");
    error.code = "SECRET-CODE";
    error.failurePhase = "C:\\secret\\phase";
    error.causeCode = {
      toString() {
        throw new Error("must not coerce hostile metadata");
      },
    };
    throw error;
  }, (diagnostic) => reports.push(diagnostic));

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "router_start_failed",
      message: "Router 启动失败。请重试；如果仍然失败，请复制诊断信息后检查配置。",
      failurePhase: "unknown",
      causeCode: "operation_failed",
    },
  });
  assert.deepEqual(reports, [{
    failurePhase: "unknown",
    causeCode: "operation_failed",
  }]);
});
