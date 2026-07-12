"use strict";

const SAFE_METADATA_CODE_PATTERN = /^[a-z0-9_]{1,96}$/;
const FAILURE_PHASES = new Set([
  "planning",
  "private_staging",
  "candidate_staging",
  "validation",
  "commit",
  "verify",
  "rollback",
  "cleanup",
]);
const UNSAFE_PATH_CAUSE_PATTERN = /(?:^|_)(?:unsafe_path|unsafe_link|symlink|symbolic_link|junction|reparse(?:_point)?|path_changed)(?:_|$)/;

const ACL_FAILURE_MESSAGE =
  "无法安全更新配置文件。请确认当前 Windows 账户可写 CodexBridge 数据目录和 ChatGPT / Codex 配置目录，并确认 .codex 不是不可写链接，然后重试。";
const UNSAFE_PATH_FAILURE_MESSAGE =
  "配置目录不安全或已发生变化。请确认配置目录是本地真实目录且不包含链接，然后重试。";
const GENERIC_FAILURE_MESSAGE =
  "Router 启动失败。请重试；如果仍然失败，请复制诊断信息后检查配置。";

function safeFailurePhase(value) {
  return FAILURE_PHASES.has(value) ? value : "unknown";
}

function safeCauseCode(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SAFE_METADATA_CODE_PATTERN.test(normalized)
    ? normalized
    : "operation_failed";
}

function failureCauseCode(error) {
  const direct = safeCauseCode(error?.causeCode);
  if (direct !== "operation_failed") {
    return direct;
  }
  const lifecycle = safeCauseCode(error?.code);
  if (lifecycle !== "operation_failed" && lifecycle !== "config_transaction_failed") {
    return lifecycle;
  }
  return direct;
}

function safePublicCode(value) {
  return value === "config_transaction_failed"
    ? "config_transaction_failed"
    : "router_start_failed";
}

function failureMessageForCause(causeCode) {
  let message = GENERIC_FAILURE_MESSAGE;
  if (
    causeCode === "eacces" ||
    causeCode === "eperm" ||
    causeCode.startsWith("windows_private_acl_")
  ) {
    message = ACL_FAILURE_MESSAGE;
  } else if (causeCode === "router_port_in_use") {
    message = "Router 端口已被占用。请关闭占用该端口的程序，或在设置中更换 Router 端口后重试。";
  } else if (causeCode === "router_port_permission_denied") {
    message = "当前 Windows 账户无权监听这个 Router 端口。请在设置中更换端口后重试。";
  } else if (
    causeCode === "router_config_invalid" ||
    causeCode === "config_draft_derivation_failed" ||
    causeCode === "managed_toml_invalid"
  ) {
    message = "Router 配置无效。请检查模型配置并重新保存，然后重试。";
  } else if (causeCode === "router_process_exited_during_start") {
    message = "Router 启动后立即退出。请复制诊断信息，根据诊断码检查端口和配置。";
  } else if (causeCode === "router_start_health_failed") {
    message = "Router 进程已启动，但健康检查未通过。请检查端口、本机代理和安全软件后重试。";
  } else if (causeCode === "enoent" || causeCode === "router_runtime_missing") {
    message = "Router 运行文件缺失。请重新解压完整安装包后重试。";
  } else if (UNSAFE_PATH_CAUSE_PATTERN.test(causeCode)) {
    message = UNSAFE_PATH_FAILURE_MESSAGE;
  }
  return causeCode === "operation_failed"
    ? message
    : `${message}（诊断码：${causeCode}）`;
}

async function runRouterStartForIpc(start, report) {
  try {
    const result = await start();
    return { ok: true, result };
  } catch (error) {
    const failurePhase = safeFailurePhase(error?.failurePhase);
    const causeCode = failureCauseCode(error);
    if (typeof report === "function") {
      try {
        report({ failurePhase, causeCode });
      } catch {
        // Diagnostics are best effort and must not reopen rejected Electron IPC.
      }
    }
    return {
      ok: false,
      error: {
        code: safePublicCode(error?.code),
        message: failureMessageForCause(causeCode),
        failurePhase,
        causeCode,
      },
    };
  }
}

module.exports = { runRouterStartForIpc };
