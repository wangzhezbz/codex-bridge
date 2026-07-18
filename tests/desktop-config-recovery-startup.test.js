import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  recoverConfigTransactionsAtStartup,
  summarizeConfigRecoveryError,
} = require("../desktop/config-recovery-startup.cjs");

function recoveryError(pending) {
  const error = new Error("Configuration recovery requires attention");
  error.code = "config_recovery_incomplete";
  error.pending = pending;
  return error;
}

test("startup recovery retries transient Windows file locks and then succeeds", async () => {
  let calls = 0;
  const waits = [];
  const retries = [];
  const result = await recoverConfigTransactionsAtStartup({
    recover: async () => {
      calls += 1;
      if (calls < 3) {
        throw recoveryError([
          { recoveryId: "tx-1", stage: "cleanup_journal", entryIndex: -1, code: "EPERM" },
        ]);
      }
      return { recovered: 1, cleaned: 0, pending: [] };
    },
    retryDelaysMs: [10, 30, 50],
    wait: async (delayMs) => waits.push(delayMs),
    onRetry: (event) => retries.push(event),
  });

  assert.deepEqual(result, { recovered: 1, cleaned: 0, pending: [] });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 30]);
  assert.deepEqual(retries.map((event) => event.attempt), [1, 2]);
  assert.deepEqual(retries.map((event) => event.code), ["EPERM", "EPERM"]);
});

test("startup recovery does not retry damaged or conflicting journals", async () => {
  for (const pending of [
    [{ recoveryId: "tx-invalid", stage: "read_journal", entryIndex: -1, code: "operation_failed" }],
    [{ recoveryId: "tx-conflict", stage: "conflict", entryIndex: 0, code: "ECONFLICT" }],
    [
      { recoveryId: "tx-mixed", stage: "cleanup_journal", entryIndex: -1, code: "EPERM" },
      { recoveryId: "tx-mixed", stage: "conflict", entryIndex: 0, code: "ECONFLICT" },
    ],
  ]) {
    let calls = 0;
    await assert.rejects(
      recoverConfigTransactionsAtStartup({
        recover: async () => {
          calls += 1;
          throw recoveryError(pending);
        },
        retryDelaysMs: [1, 1],
        wait: async () => assert.fail("unsafe recovery failures must not wait or retry"),
      }),
      (error) => error?.code === "config_recovery_incomplete",
    );
    assert.equal(calls, 1);
  }
});

test("startup recovery stops after the bounded retry budget", async () => {
  let calls = 0;
  await assert.rejects(
    recoverConfigTransactionsAtStartup({
      recover: async () => {
        calls += 1;
        throw recoveryError([
          { recoveryId: "tx-busy", stage: "inspect", entryIndex: 0, code: "EBUSY" },
        ]);
      },
      retryDelaysMs: [1, 1, 1],
      wait: async () => {},
    }),
    (error) => error?.code === "config_recovery_incomplete",
  );
  assert.equal(calls, 4);
});

test("startup recovery produces a concise Chinese diagnostic without exposing paths", () => {
  assert.equal(
    summarizeConfigRecoveryError(recoveryError([
      { recoveryId: "12345678-1234", stage: "cleanup_journal", entryIndex: -1, code: "EPERM" },
    ])),
    "检测到上次配置保存未完成，恢复文件暂时被占用（阶段：cleanup_journal，诊断码：EPERM，恢复编号：12345678-1234）。请彻底退出其他 CodexBridge 进程后重试；原配置和 API Key 不会被自动删除。",
  );
  assert.equal(
    summarizeConfigRecoveryError(recoveryError([
      { recoveryId: "abcdef12-1234", stage: "conflict", entryIndex: 0, code: "ECONFLICT" },
    ])),
    "检测到上次配置保存未完整恢复（阶段：conflict，诊断码：ECONFLICT，恢复编号：abcdef12-1234）。为避免覆盖用户配置，CodexBridge 已停止写入；请复制诊断日志后处理。",
  );
});
