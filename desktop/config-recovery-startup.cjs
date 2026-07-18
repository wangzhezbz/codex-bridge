"use strict";

const TRANSIENT_RECOVERY_CODES = new Set([
  "EACCES",
  "EAGAIN",
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "EPERM",
  "ETXTBSY",
]);
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([120, 350, 800, 1500]);

function pendingDiagnostics(error) {
  return Array.isArray(error?.pending)
    ? error.pending.filter((item) => item && typeof item === "object")
    : [];
}

function isTransientConfigRecoveryError(error) {
  const pending = pendingDiagnostics(error);
  return error?.code === "config_recovery_incomplete" &&
    pending.length > 0 &&
    pending.every((item) => TRANSIENT_RECOVERY_CODES.has(String(item.code || "")));
}

function defaultWait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function recoverConfigTransactionsAtStartup({
  recover,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  wait = defaultWait,
  onRetry = () => {},
} = {}) {
  if (typeof recover !== "function") {
    throw new TypeError("recover must be a function");
  }
  const delays = Array.isArray(retryDelaysMs)
    ? retryDelaysMs.filter((value) => Number.isFinite(value) && value >= 0)
    : [];
  let attempt = 0;
  while (true) {
    try {
      return await recover();
    } catch (error) {
      if (!isTransientConfigRecoveryError(error) || attempt >= delays.length) {
        throw error;
      }
      const delayMs = delays[attempt];
      attempt += 1;
      const pending = pendingDiagnostics(error);
      onRetry({
        attempt,
        delayMs,
        code: String(pending[0]?.code || "operation_failed"),
        pending,
      });
      await wait(delayMs);
    }
  }
}

function safeLabel(value, fallback) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_.:-]{1,96}$/.test(text) ? text : fallback;
}

function summarizeConfigRecoveryError(error) {
  const pending = pendingDiagnostics(error);
  const first = pending[0] || {};
  const stage = safeLabel(first.stage, "unknown");
  const code = safeLabel(first.code, safeLabel(error?.code, "unknown"));
  const recoveryId = safeLabel(first.recoveryId, "unknown");
  const details = `阶段：${stage}，诊断码：${code}，恢复编号：${recoveryId}`;
  if (isTransientConfigRecoveryError(error)) {
    return `检测到上次配置保存未完成，恢复文件暂时被占用（${details}）。请彻底退出其他 CodexBridge 进程后重试；原配置和 API Key 不会被自动删除。`;
  }
  return `检测到上次配置保存未完整恢复（${details}）。为避免覆盖用户配置，CodexBridge 已停止写入；请复制诊断日志后处理。`;
}

module.exports = {
  DEFAULT_RETRY_DELAYS_MS,
  isTransientConfigRecoveryError,
  recoverConfigTransactionsAtStartup,
  summarizeConfigRecoveryError,
};
