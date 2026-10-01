"use strict";

const FALLBACK = "thread_provider_compatibility_failed";
const MESSAGES = Object.freeze({
  [FALLBACK]: "部分旧任务尚未完成模式兼容，请再次通过本应用重启",
  compatibility_worker_failed: "后台兼容任务未正常完成，请稍后再次重启",
  compatibility_worker_timeout: "后台兼容任务超时，尚未完成的旧任务可稍后重试",
  compatibility_output_limit: "后台兼容结果超出读取上限，本次未能完整读取，请查看日志排查",
  compatibility_lock_failed: "本次旧任务兼容未完成，请稍后重试",
  compatibility_cleanup_unconfirmed: "后台兼容任务尚未确认退出",
  desktop_or_config_not_ready: "客户端或配置尚未准备好，本次未处理旧任务，请稍后重试",
  codex_cli_not_found: "未找到可用的 Codex 命令行程序，请检查 Codex 安装后重试",
  invalid_compatibility_paths: "本机兼容目录配置无效，请重新检查 Codex 安装位置",
  codex_configuration_too_large: "Codex 配置文件过大，旧任务兼容未完成，请检查本机配置",
  codex_configuration_mode_mismatch: "当前 Codex 配置与所选计费模式不一致，请重新确认模式后重启",
  codex_configuration_changed: "兼容期间 Codex 配置发生变化，部分任务未完成，请确认模式后重试",
  native_compatibility_timeout: "旧任务兼容超时，尚未完成的任务可稍后重试",
  native_request_timeout: "原生客户端响应超时，尚未完成的旧任务可稍后重试",
  native_response_invalid: "原生客户端返回了无效结果，本次没有将未确认的操作记为成功",
  native_start_failed: "原生兼容客户端启动失败，请检查 Codex 安装后重试",
  native_process_exited: "原生兼容客户端提前退出，尚未完成的旧任务可稍后重试",
  native_stdout_failed: "原生客户端输出连接异常，请稍后重试",
  native_stdin_failed: "原生客户端输入连接异常，请稍后重试",
  native_connection_closed: "原生客户端连接已关闭，尚未完成的旧任务可稍后重试",
  native_thread_list_invalid: "原生客户端返回的任务列表无效，本次未继续处理",
  native_thread_list_limit: "原生客户端任务列表未能完整读取，请稍后重试",
  thread_compatibility_scan_limit: "本机任务记录超过单次检测上限（10000 条），本次未处理旧任务，请查看日志排查",
  thread_settings_unsupported: "当前 Codex 版本不支持旧任务兼容，请更新 Codex 后再通过本应用重启",
  thread_not_in_active_catalog: "无法确认部分旧任务的当前状态，未改动这些任务，可重新检测后再试",
  thread_provider_rpc_failed: "原生客户端未能读取或处理部分旧任务，请稍后重试",
  thread_identity_changed: "任务身份发生变化，已跳过对应操作",
  thread_model_changed: "原生客户端返回的模型与原任务不一致，已跳过保存",
  thread_provider_not_applied: "原生客户端未确认计费模式变更，已跳过保存",
  thread_settings_save_failed: "原生客户端未确认旧任务设置已保存，请稍后重试",
  thread_provider_receipt_failed: "旧任务兼容确认记录未能保存，请稍后重试",
});

function knownCode(value) {
  return typeof value === "string" && Object.hasOwn(MESSAGES, value);
}

// Only exact local codes may cross the worker/log/UI boundary; never forward error text.
function compatibilityFailureCode(error, fallback = FALLBACK) {
  const code = typeof error === "string" ? error : error?.code;
  if (knownCode(code)) return code;
  if (knownCode(error?.message)) return error.message;
  return knownCode(fallback) ? fallback : FALLBACK;
}

function compatibilityFailureDetail(result) {
  if (knownCode(result?.code) && result.code !== FALLBACK) return MESSAGES[result.code];
  const reasons = [];
  for (const item of Array.isArray(result?.failed) ? result.failed.slice(0, 20) : []) {
    if (knownCode(item?.code) && !reasons.includes(MESSAGES[item.code])) reasons.push(MESSAGES[item.code]);
    if (reasons.length === 3) break;
  }
  return reasons.length ? reasons.join("；") : MESSAGES[FALLBACK];
}

module.exports = { compatibilityFailureCode, compatibilityFailureDetail };
