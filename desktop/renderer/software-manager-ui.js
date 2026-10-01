(function attachSoftwareManagerUi(global) {
  "use strict";

  const COMPONENT_ORDER = ["chatgpt"];
  const MAX_RENDERED_TASK_LOG_LINES = 120;
  const TAB_LABELS = Object.freeze({
    install: "下载安装",
    update: "检查更新",
    uninstall: "卸载软件",
    rollback: "回滚",
  });
  const STATUS_LABELS = Object.freeze({ succeeded: "成功", partial: "部分失败", failed: "失败", cancelled: "已取消", skipped: "已跳过" });
  const PHASE_LABELS = Object.freeze({
    starting: "正在启动",
    prepare: "准备文件", download: "下载安装包", "verify-download": "校验安装包", extract: "解压安装文件",
    inspect: "检查本机状态", commit: "应用更改",
    verify: "验证安装结果", uninstall: "卸载软件", rollback: "恢复上一版本", plugin: "处理完整插件", cancelling: "正在取消", finishing: "正在完成",
  });
  const LOG_LABELS = Object.freeze({
    software_manager_preparing: "正在准备安装文件",
    software_manager_downloading: "正在下载安装包",
    software_manager_verifying_download: "正在校验下载文件",
    software_manager_extracting: "正在解压安装文件",
    software_manager_extracting_skill: "正在解压 Skill 文件",
    software_manager_verifying_installation: "正在验证安装文件",
    software_manager_verifying_installer: "正在验证安装程序签名",
    software_manager_verifying_skill: "正在验证 Skill 文件",
    software_manager_preparing_skills: "正在准备 Skills",
    software_manager_inspecting: "正在检查本机安装状态",
    software_manager_critical_operation: "正在应用更改，此时不能取消",
    software_manager_cancelled: "软件管理任务已取消",
    software_manager_task_succeeded: "软件管理任务已完成",
    software_manager_task_partial: "软件管理任务部分失败",
    software_manager_task_failed: "软件管理任务失败",
    software_manager_task_cancelled: "软件管理任务已取消",
  });
  const RESULT_REASON_LABELS = Object.freeze({
    rollback_slot_missing: "上一版本备份目录缺失，无法回滚；当前安装不会被删除，请重新安装或更新",
    rollback_not_available: "没有可恢复的上一版本，请重新安装或更新",
    slot_rollback_ownership_mismatch: "上一版本备份与安装记录不一致，已停止回滚以保留当前安装",
    slot_ownership_mismatch: "当前程序与安装记录不一致，已停止回滚以保留文件",
    component_disk_space_insufficient: "安装磁盘空间不足，请更换安装位置或释放空间后重试",
    ENOSPC: "磁盘空间已用尽，请释放空间后重试",
    download_request_timeout: "连接下载服务器超时，请检查网络后重试",
    download_stalled: "下载长时间没有收到新数据，已安全停止并保留断点",
    download_timeout: "下载总时长超过安全上限，已停止本次任务",
    authenticode_query_failed: "安装程序签名校验超时或失败",
    process_list_failed: "读取本机进程状态失败",
    git_registry_query_failed: "读取 Git 安装信息失败",
    git_path_query_failed: "检查 Git 命令位置失败",
    software_manager_blocked_by_plugin_failure: "完整插件未能卸载，为保留清理入口，本次没有卸载 ChatGPT",
    curated_plugin_requires_chatgpt_install: "ChatGPT 安装失败，无法继续安装完整插件",
    curated_plugin_task_result_invalid: "完整插件返回了无效结果，已停止后续关联操作",
    software_manager_cancelled: "任务已取消",
  });

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function uniqueIds(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string"))];
  }



  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return "大小未知";
    const units = ["B", "KB", "MB", "GB"];
    let amount = bytes;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
    return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  function taskResultFeedback(result, state = {}) {
    const copyText = buildTaskReport({ ...state, lastResult: result, pendingResult: null });
    const failure = [...(result?.components ?? []), ...(result?.skills ?? [])].find(entry => entry?.status === "failed");
    if (["partial", "failed"].includes(result?.status)) return Object.freeze({
      message: failure ? `${componentName(failure.componentId, state.snapshot)} ${resultMessage(failure, result.kind)}`
        : result.status === "partial" ? "部分项目处理失败，请查看任务报告。" : "软件管理任务失败，请查看任务报告。",
      tone: "error", copyText,
    });
    if (result?.status === "cancelled") return Object.freeze({ message: "软件管理任务已取消。", tone: "info" });
    const entries = [...(result?.components ?? []), ...(result?.skills ?? []), ...(result?.plugins ?? [])];
    if (entries.some((entry) => /warning|警告/iu.test(String(entry?.message || "")))) {
      const shortcutWarning = entries.some(entry => /shortcut/iu.test(String(entry?.message || "")));
      return Object.freeze({ message: shortcutWarning ? "Codex 已安装，但桌面快捷方式处理失败；请复制报告查看原因。"
        : "主要安装已完成，但附加步骤存在警告，请查看任务报告。", tone: "error", copyText });
    }
    return Object.freeze({ message: "软件管理任务已完成。", tone: "success" });
  }

  function combineTaskResults(result, pluginResults = [], kind = "install") {
    const plugins = Array.isArray(pluginResults) ? pluginResults : [];
    const baseEntries = [...(result?.components ?? []), ...(result?.skills ?? [])];
    const entries = [...baseEntries, ...plugins];
    const hasSuccess = entries.some((entry) => ["succeeded", "skipped"].includes(entry?.status))
      || result?.status === "succeeded";
    const hasFailure = entries.some((entry) => entry?.status === "failed")
      || ["failed", "partial"].includes(result?.status);
    const hasCancellation = entries.some((entry) => entry?.status === "cancelled")
      || result?.status === "cancelled";
    const status = hasFailure
      ? (hasSuccess ? "partial" : "failed")
      : hasCancellation
        ? (hasSuccess ? "partial" : "cancelled")
        : "succeeded";
    return Object.freeze({
      ...(result ?? {}),
      taskId: result?.taskId || `plugins-${Date.now()}`,
      kind,
      status,
      components: result?.components ?? [],
      skills: result?.skills ?? [],
      plugins,
    });
  }

  function localizedLogLine(line) {
    const message = typeof line === "string" ? line : line?.message ?? JSON.stringify(line);
    return LOG_LABELS[message] ?? message;
  }

  function actionResultLabel(kind, status) {
    const action = ({ install: "安装", update: "更新", uninstall: "卸载", rollback: "回滚" })[kind] ?? "处理";
    if (status === "failed") return `${action}失败`;
    if (status === "partial") return `${action}部分失败`;
    if (status === "cancelled") return "已取消";
    if (status === "skipped") return "无需处理";
    return `${action}成功`;
  }

  function localizedResultReason(value) {
    const reason = String(value || "请复制任务报告后重试");
    const label = RESULT_REASON_LABELS[reason];
    return label ? `${label}（${reason}）` : reason;
  }

  function resultMessage(entry, kind) {
    if (entry?.status === "succeeded") {
      return /warning|警告/iu.test(String(entry?.message || ""))
        ? `${actionResultLabel(kind, "succeeded")}，但有警告：${String(entry.message)}`
        : actionResultLabel(kind, "succeeded");
    }
    if (entry?.status === "skipped") return "当前项目无需处理";
    if (entry?.status === "cancelled") return "任务已取消";
    return `${actionResultLabel(kind, "failed")}：${localizedResultReason(entry?.message)}`;
  }

  function transferText(task) {
    const downloaded = Number(task?.downloadedBytes);
    const total = Number(task?.totalBytes);
    const speed = Number(task?.bytesPerSecond);
    if (!Number.isFinite(downloaded) || !Number.isFinite(total) || total <= 0) return "";
    return `${formatBytes(downloaded)} / ${formatBytes(total)}${Number.isFinite(speed) && speed > 0 ? ` · ${formatBytes(speed)}/s` : ""}`;
  }

  function phaseActivityText(task) {
    if (Number.isFinite(task?.percent)) return "";
    if (task?.phase === "extract") return "正在持续解压文件，较大的安装包可能需要数分钟。";
    if (task?.phase === "verify") return "正在校验安装内容，完成前不会报告成功。";
    if (["commit", "uninstall", "rollback"].includes(task?.phase)) return "正在安全应用更改，完成前不会提前报告成功。";
    if (task?.phase === "plugin") return "正在处理完整插件和固定版本的 Marketplace。";
    if (task?.phase === "cancelling") return "正在等待当前子进程完成安全取消。";
    return task ? "任务仍在进行，请等待当前阶段完成。" : "";
  }

  function componentName(id, snapshot) {
    if (id === "chatgpt") return "Codex";
    return snapshot?.components?.find((entry) => entry.id === id)?.name
      || snapshot?.catalog?.components?.find((entry) => entry.id === id)?.name
      || snapshot?.curatedPlugins?.find((entry) => entry.id === id)?.name
      || ({ chatgpt: "ChatGPT", v2rayn: "V2RayN", git: "Git" }[id] ?? id);
  }

  function catalogStatus(snapshot) {
    const catalog = snapshot?.catalog ?? {};
    if (!catalog.available) return { label: "安装清单不可用", warning: true, detail: "" };
    const published = typeof catalog.publishedAt === "string" && catalog.publishedAt
      ? `；清单发布时间 ${catalog.publishedAt.replace("T", " ").replace(/\.\d+Z$/u, "Z")}`
      : "";
    if (catalog.refreshError) {
      return { label: "在线刷新失败", warning: true, summary: "当前使用已验证的本地清单。", detail: `当前继续使用已验证的本地清单${published}。` };
    }
    if (catalog.source === "remote") {
      return { label: "在线清单已更新", warning: false, detail: "" };
    }
    if (catalog.source === "cache") {
      return { label: "使用缓存清单", warning: true, summary: "当前使用本地缓存清单。", detail: `尚未取得新的在线清单${published}。` };
    }
    if (catalog.source === "bundled") {
      return { label: "使用内置清单", warning: true, summary: "已加载随软件附带的离线清单。", detail: `当前为随安装包提供的离线清单${published}。` };
    }
    return { label: "安装服务可用", warning: false, detail: "" };
  }

  function buildTaskReport(state) {
    const result = state?.lastResult;
    const snapshot = state?.snapshot;
    const lines = [
      "软件管理任务报告",
      `状态：${STATUS_LABELS[result?.status] ?? result?.status ?? (snapshot?.task ? "执行中" : "未知")}`,
    ];
    if (result?.taskId) lines.push(`任务编号：${result.taskId}`);
    if (result?.kind) lines.push(`操作：${TAB_LABELS[result.kind] ?? result.kind}`);
    const entries = [...(result?.components ?? []), ...(result?.skills ?? []), ...(result?.plugins ?? [])];
    if (entries.length > 0) {
      lines.push("", "处理结果：");
      for (const entry of entries) {
        const label = componentName(entry.componentId, snapshot);
        lines.push(`- ${label}：${STATUS_LABELS[entry.status] ?? entry.status ?? "未知"}${entry.message ? `（${localizedResultReason(entry.message)}）` : ""}`);
        if (entry.versionBefore) lines.push(`  处理前版本：${entry.versionBefore}`);
        if (entry.versionAfter) lines.push(`  处理后版本：${entry.versionAfter}`);
        if (entry.details?.installPath) lines.push(`  安装位置：${entry.details.installPath}`);
      }
    }
    const logs = (snapshot?.logs ?? []).slice(-500);
    if (logs.length > 0) lines.push("", "任务日志：", ...logs.map((line) => `- ${localizedLogLine(line)}`));
    return lines.join("\n");
  }

  function availableTabs(snapshot) {
    return (Array.isArray(snapshot?.tabs) ? snapshot.tabs : []).filter((tab) =>
      Object.hasOwn(TAB_LABELS, tab) && (tab !== "rollback"
        || (snapshot.rollback ?? []).some((entry) => COMPONENT_ORDER.includes(entry.id))));
  }

  function defaultSelection(snapshot, tab) {
    if (!snapshot || !snapshot.enabled || snapshot.readOnly) {
      return Object.freeze({ componentIds: Object.freeze([]), skillIds: Object.freeze([]), pluginIds: Object.freeze([]) });
    }
    if (tab === "install" || tab === "update") {
      const configured = snapshot.defaults?.[tab] ?? {};
      return Object.freeze({
        componentIds: Object.freeze(uniqueIds(configured.componentIds).filter((id) => COMPONENT_ORDER.includes(id))),
        skillIds: Object.freeze([]),
        pluginIds: Object.freeze([]),
      });
    }
    return Object.freeze({ componentIds: Object.freeze([]), skillIds: Object.freeze([]), pluginIds: Object.freeze([]) });
  }

  function retainedSelection(snapshot, tab, current) {
    if (!snapshot || snapshot.readOnly) return { componentIds: [], skillIds: [], pluginIds: [] };
    const rows = tab === "rollback" ? snapshot.rollback ?? [] : snapshot.components ?? [];
    const available = new Set(rows.filter((item) => item?.selectable !== false).map((item) => item?.id));
    return {
      componentIds: current.selectedComponentIds.filter((id) => COMPONENT_ORDER.includes(id) && available.has(id)),
      skillIds: [],
      pluginIds: [],
    };
  }


  function createInitialState() {
    return {
      snapshot: null,
      activeTab: "install",
      selectedComponentIds: [],
      selectedSkillIds: [],
      selectedPluginIds: [],
      skillQuery: "",
      skillsExpanded: false,
      installRootToken: null,
      customInstallRootSelected: false,
      confirmationPending: false,
      loading: false,
      error: null,
      lastResult: null,
      taskRevision: 0,
      awaitingTaskId: false,
      awaitingResultTaskId: null,
      submissionId: null,
      pendingResult: null,
      completedTaskIds: [],
    };
  }

  function toggle(values, id, checked) {
    const set = new Set(values);
    if (checked) set.add(id); else set.delete(id);
    return [...set];
  }

  function optionalFiniteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function completeTask(current, result, taskId) {
    return {
      ...current,
      snapshot: current.snapshot ? { ...current.snapshot, task: null } : current.snapshot,
      lastResult: result ?? null,
      confirmationPending: false,
      taskRevision: (current.taskRevision ?? 0) + 1,
      awaitingTaskId: false,
      awaitingResultTaskId: null,
      submissionId: null,
      pendingResult: null,
      completedTaskIds: uniqueIds([...(current.completedTaskIds ?? []), taskId]).slice(-128),
    };
  }

  function reduce(state, action) {
    const current = state ?? createInitialState();
    if (!action || typeof action !== "object") return current;
    if (action.expectedTaskRevision !== undefined && action.expectedTaskRevision !== (current.taskRevision ?? 0)) return current;
    if (action.type === "loading") return { ...current, loading: Boolean(action.loading), error: null };
    if (action.type === "error") return { ...current, loading: false, error: String(action.error || "软件管理暂不可用") };
    if (action.type === "snapshot") {
      // Local submissions belong to their IPC result. A fresh, revision-checked
      // read may reconcile an observed server task if its finish event was lost
      // while opening the page; unversioned broadcasts cannot do that.
      if (current.submissionId || current.awaitingTaskId) return current;
      const nextSnapshot = action.snapshot && typeof action.snapshot === "object" ? action.snapshot : null;
      const activeTask = current.snapshot?.task;
      if (nextSnapshot?.task && current.completedTaskIds?.includes(nextSnapshot.task.taskId)) return current;
      if (activeTask && (action.expectedTaskRevision === undefined || !nextSnapshot
        || nextSnapshot.task?.taskId === activeTask.taskId)) return current;
      const reconciledTaskId = activeTask?.taskId;
      const tabs = availableTabs(nextSnapshot);
      const activeTab = tabs.includes(current.activeTab) ? current.activeTab : (tabs[0] ?? "install");
      const defaults = defaultSelection(nextSnapshot, activeTab);
      const preserveCurrent = Boolean(current.snapshot) && activeTab === current.activeTab;
      const selection = preserveCurrent
        ? retainedSelection(nextSnapshot, activeTab, current)
        : defaults;
      return {
        ...current,
        snapshot: nextSnapshot,
        activeTab,
        selectedComponentIds: [...selection.componentIds],
        selectedSkillIds: [...selection.skillIds],
        selectedPluginIds: [...selection.pluginIds],
        skillsExpanded: false,
        confirmationPending: false,
        loading: false,
        error: null,
        awaitingTaskId: false,
        awaitingResultTaskId: reconciledTaskId || (nextSnapshot?.task ? null : current.awaitingResultTaskId ?? null),
        taskRevision: (current.taskRevision ?? 0) + (reconciledTaskId ? 1 : 0),
        completedTaskIds: reconciledTaskId
          ? uniqueIds([...(current.completedTaskIds ?? []), reconciledTaskId]).slice(-128)
          : current.completedTaskIds ?? [],
        lastResult: reconciledTaskId ? null : current.lastResult,
      };
    }
    if (action.type === "curated-plugins") {
      return {
        ...current,
        selectedSkillIds: [],
        selectedPluginIds: [],
        skillsExpanded: false,
        confirmationPending: current.confirmationPending && current.selectedSkillIds.length === 0 && current.selectedPluginIds.length === 0,
      };
    }
    if (action.type === "tab") {
      const tabs = availableTabs(current.snapshot);
      if (!tabs.includes(action.tab)) return current;
      const defaults = defaultSelection(current.snapshot, action.tab);
      return {
        ...current,
        activeTab: action.tab,
        selectedComponentIds: [...defaults.componentIds],
        selectedSkillIds: [...defaults.skillIds],
        selectedPluginIds: [...defaults.pluginIds],
        skillQuery: "",
        skillsExpanded: false,
        confirmationPending: false,
      };
    }
    if (action.type === "toggle-component") {
      if (!COMPONENT_ORDER.includes(action.componentId)) return current;
      const selectedComponentIds = toggle(current.selectedComponentIds.filter((id) => COMPONENT_ORDER.includes(id)), action.componentId, action.checked);
      return { ...current, selectedComponentIds, selectedSkillIds: [], selectedPluginIds: [], confirmationPending: false };
    }
    if (action.type === "toggle-skill") {
      return { ...current, selectedSkillIds: [], selectedPluginIds: [], confirmationPending: false };
    }
    if (action.type === "toggle-plugin") {
      return { ...current, selectedSkillIds: [], selectedPluginIds: [], confirmationPending: false };
    }
    if (action.type === "skill-query") return { ...current, skillQuery: "" };
    if (action.type === "toggle-skills") return { ...current, skillsExpanded: false };
    if (action.type === "install-root") {
      return { ...current, installRootToken: action.token, customInstallRootSelected: true, confirmationPending: false };
    }
    if (action.type === "confirm-open") {
      const canConfirm = current.snapshot && !current.snapshot.readOnly && !current.snapshot.task
        && current.selectedComponentIds.some((id) => COMPONENT_ORDER.includes(id));
      return { ...current, selectedComponentIds: current.selectedComponentIds.filter((id) => COMPONENT_ORDER.includes(id)), selectedSkillIds: [], selectedPluginIds: [], confirmationPending: Boolean(canConfirm) };
    }
    if (action.type === "confirm-close") return { ...current, confirmationPending: false };
    if (action.type === "task-starting") {
      if (!current.snapshot || current.snapshot.task || current.submissionId) return current;
      return {
        ...current,
        snapshot: {
          ...current.snapshot,
          task: {
            taskId: String(action.taskId || `software-starting-${Date.now()}`),
            kind: action.kind || current.activeTab,
            phase: "starting",
            componentId: action.componentId ?? null,
            percent: null,
            critical: false,
            cancellable: false,
            downloadedBytes: null,
            totalBytes: null,
            bytesPerSecond: null,
          },
        },
        confirmationPending: false,
        error: null,
        taskRevision: (current.taskRevision ?? 0) + 1,
        awaitingTaskId: true,
        awaitingResultTaskId: null,
        submissionId: typeof action.submissionId === "string" ? action.submissionId : null,
        pendingResult: null,
      };
    }
    if (action.type === "task-event") {
      const snapshot = current.snapshot;
      if (!snapshot) return current;
      const event = action.event ?? {};
      if (event.type === "snapshot" && event.snapshot && typeof event.snapshot === "object") {
        return reduce(current, {
          type: "snapshot",
          snapshot: {
            ...event.snapshot,
            curatedPlugins: snapshot.curatedPlugins ?? [],
          },
        });
      }
      if (event.type === "progress") {
        if (typeof event.taskId !== "string" || !event.taskId || current.completedTaskIds?.includes(event.taskId)
          || current.pendingResult
          || snapshot.task && !current.awaitingTaskId && snapshot.task.taskId !== event.taskId) return current;
        const task = {
          taskId: event.taskId,
          kind: snapshot.task?.kind ?? current.activeTab,
          phase: event.phase,
          componentId: event.componentId ?? null,
          percent: optionalFiniteNumber(event.percent),
          critical: event.critical === true,
          cancellable: event.cancellable === true,
          downloadedBytes: optionalFiniteNumber(event.downloadedBytes),
          totalBytes: optionalFiniteNumber(event.totalBytes),
          bytesPerSecond: optionalFiniteNumber(event.bytesPerSecond),
        };
        const priorLogs = snapshot.logs ?? [];
        const logs = event.message && priorLogs.at(-1) !== event.message
          ? [...priorLogs, event.message].slice(-500)
          : priorLogs;
        return { ...current, snapshot: { ...snapshot, task, logs }, confirmationPending: false,
          awaitingTaskId: false, awaitingResultTaskId: null, taskRevision: (current.taskRevision ?? 0) + 1 };
      }
      if (event.type === "finished") {
        const taskId = event.taskId ?? event.result?.taskId;
        const awaitingResult = current.awaitingResultTaskId === taskId && !snapshot.task && !current.submissionId;
        if (typeof taskId !== "string" || !taskId || (current.completedTaskIds?.includes(taskId) && !awaitingResult)
          || event.result?.taskId && event.result.taskId !== taskId
          || snapshot.task && (current.awaitingTaskId || snapshot.task.taskId !== taskId)) return current;
        if (awaitingResult && !event.result) return current;
        if (current.submissionId) {
          if (!event.result || current.pendingResult) return current;
          // Keep the local submission reserved until its own invocation settles.
          // Preserve the authoritative event if that invocation later rejects.
          return { ...current, pendingResult: event.result,
            snapshot: { ...snapshot, task: { ...snapshot.task, phase: "finishing", critical: false, cancellable: false, percent: null } },
            taskRevision: (current.taskRevision ?? 0) + 1 };
        }
        return completeTask(current, event.result, taskId);
      }
    }
    if (action.type === "task-result") {
      const taskId = action.result?.taskId;
      if (typeof taskId !== "string" || !taskId) return current;
      if (action.submissionId !== undefined) {
        if (action.submissionId !== current.submissionId) return current;
      } else if (current.submissionId || (current.completedTaskIds?.includes(taskId) && current.awaitingResultTaskId !== taskId)
        || current.snapshot?.task && (current.awaitingTaskId || current.snapshot.task.taskId !== taskId)) return current;
      return completeTask(current, action.result, taskId);
    }
    return current;
  }



  function componentStatus(entry, tab) {
    if (tab === "update") {
      if (entry.updateState === "update-available") return ["有新版本", "available"];
      if (entry.updateState === "current") return ["已是最新版", "current"];
      if (entry.updateState === "not-installed") return ["尚未安装", "missing"];
      return ["检测异常", "failed"];
    }
    if (tab === "uninstall") return entry.installedVersion ? ["已安装", "installed"] : ["未安装", "missing"];
    return [entry.installedVersion ? "已安装，可重新安装" : "可安装", entry.installedVersion ? "installed" : "available"];
  }

  function componentDetail(entry, tab) {
    if (!entry.version && !entry.installedVersion) return "等待环境检测";
    if (tab === "update" && entry.updateState === "update-available") {
      return `当前 ${escapeHtml(entry.installedVersion)} <b>→</b> 最新 ${escapeHtml(entry.version)}`;
    }
    if (tab === "update" && entry.updateState === "current") return `当前版本 ${escapeHtml(entry.installedVersion)}`;
    if (tab === "uninstall") return entry.installedVersion ? `版本 ${escapeHtml(entry.installedVersion)}` : "本机没有可卸载版本";
    return `版本 ${escapeHtml(entry.version)} · ${escapeHtml(formatBytes(entry.size))}`;
  }

  function componentNote(entry, tab) {
    let note = tab === "uninstall"
      ? "删除 Codex 程序和快捷方式，保留登录、配置和聊天历史"
      : tab === "update"
        ? entry.updateState === "update-available" ? "更新后保留当前版本用于一次回滚" : "Codex 登录与历史不会改变"
        : "创建 Codex 桌面图标；登录、配置和历史保存在官方 .codex 目录";
    if (entry.installedVersion && entry.installPath) {
      note += ` · <button type="button" class="software-link-button" data-software-open-folder="${escapeHtml(entry.installPath)}">打开安装目录</button>`;
    }
    return note;
  }

  function renderComponentCards(state) {
    const snapshot = state.snapshot;
    const selected = new Set(state.selectedComponentIds);
    const byId = new Map((snapshot?.components ?? []).map((entry) => [entry.id, entry]));
    const catalogById = new Map((snapshot?.catalog?.components ?? []).map((entry) => [entry.id, entry]));
    const entries = COMPONENT_ORDER.map((id) => byId.get(id) ?? catalogById.get(id) ?? {
      id,
      name: componentName(id, snapshot),
      version: null,
      size: 0,
      installedVersion: null,
      updateState: "error",
      unavailable: true,
    });
    const tab = state.activeTab;
    return entries.map((entry) => {
      const [status, statusClass] = componentStatus(entry, tab);
      const unavailable = entry.unavailable === true || tab === "update" && entry.updateState === "current"
        || tab === "uninstall" && !entry.installedVersion;
      return `
        <label class="software-component-card${selected.has(entry.id) ? " selected" : ""}${unavailable ? " disabled" : ""}">
          <div class="software-component-head">
            <span><input type="checkbox" data-software-component="${escapeHtml(entry.id)}"${selected.has(entry.id) ? " checked" : ""}${unavailable || snapshot.readOnly || snapshot.task ? " disabled" : ""}> <strong>${escapeHtml(componentName(entry.id, snapshot))}</strong></span>
            <span class="software-state ${statusClass}">${escapeHtml(status)}</span>
          </div>
          <div class="software-component-version">${componentDetail(entry, tab)}</div>
          <div class="software-component-note">${componentNote(entry, tab)}</div>
        </label>`;
    }).join("");
  }


  function renderRollbackCards(state) {
    const selected = new Set(state.selectedComponentIds);
    return (state.snapshot?.rollback ?? []).filter((entry) => COMPONENT_ORDER.includes(entry.id)).map((entry) => `
      <label class="software-component-card rollback${selected.has(entry.id) ? " selected" : ""}">
        <div class="software-component-head">
          <span><input type="checkbox" data-software-component="${escapeHtml(entry.id)}"${selected.has(entry.id) ? " checked" : ""}${state.snapshot.readOnly || state.snapshot.task ? " disabled" : ""}> <strong>${escapeHtml(componentName(entry.id, state.snapshot))}</strong></span>
          <span class="software-state rollback">可回滚</span>
        </div>
        <div class="software-component-version">当前 ${escapeHtml(entry.version || "-")}<br><b>恢复到 ${escapeHtml(entry.previousVersion || "上一版本")}</b></div>
        <div class="software-component-note">回滚成功后会删除当前新版本，并清除这一次回滚记录</div>
      </label>`).join("");
  }


  function actionLabel(tab) {
    return ({ install: "确认并开始", update: "开始更新", uninstall: "确认卸载", rollback: "确认回滚" })[tab] ?? "开始";
  }

  function selectionNames(state) {
    return state.selectedComponentIds.filter((id) => COMPONENT_ORDER.includes(id)).map((id) => componentName(id, state.snapshot));
  }

  function renderConfirmation(state) {
    if (!state.confirmationPending) return "";
    const names = selectionNames(state);
    return `
      <section class="software-confirmation" aria-label="操作确认">
        <div><strong>请确认本次操作</strong><p>已选择 ${names.length} 项 · ${escapeHtml(names.join("、") || "尚未选择内容")}</p>
          ${state.activeTab === "uninstall" ? "<p class=\"software-warning\">只删除 Codex 程序和已记录快捷方式；登录、配置、聊天历史与项目文件保留。</p>" : ""}
        </div>
        <div class="software-confirm-actions">
          <button type="button" class="plain-button" data-software-confirm-cancel>返回</button>
          <button type="button" class="primary-button" data-software-confirm>${actionLabel(state.activeTab)}</button>
        </div>
      </section>`;
  }

  function renderTask(state) {
    const task = state.snapshot?.task;
    const logs = (state.snapshot?.logs ?? []).slice(-MAX_RENDERED_TASK_LOG_LINES);
    if (!task && logs.length === 0 && !state.lastResult) return "";
    const hasPercent = Number.isFinite(task?.percent);
    const percent = hasPercent ? Math.max(0, Math.min(100, task.percent)) : null;
    const transfer = transferText(task);
    const activity = phaseActivityText(task);
    const result = state.lastResult;
    const resultEntries = [...(result?.components ?? []), ...(result?.skills ?? []), ...(result?.plugins ?? [])];
    const resultSummary = !task && result ? `
      <div class="software-result-summary ${escapeHtml(result.status ?? "failed")}" role="status">
        <strong>${escapeHtml(actionResultLabel(result.kind, result.status))}</strong>
        <span>${escapeHtml(resultCountsText(resultEntries))}</span>
      </div>
      ${resultEntries.length > 0 ? `<div class="software-result-list">${resultEntries.map((entry) => `
        <div class="software-result-row ${escapeHtml(entry.status ?? "failed")}">
          <strong>${escapeHtml(componentName(entry.componentId, state.snapshot))}</strong>
          <span>${escapeHtml(resultMessage(entry, result.kind))}${entry.versionAfter ? ` · ${escapeHtml(entry.versionAfter)}` : ""}</span>
          ${entry.details?.installPath ? `<code>${escapeHtml(entry.details.installPath)}</code>` : ""}
        </div>`).join("")}</div>` : ""}
    ` : "";
    return `
      <section class="software-task-panel" aria-live="polite">
        <div class="software-task-head">
          <div><strong>${task ? "任务正在执行" : result ? "最近一次任务" : "任务记录"}</strong><span>${escapeHtml(task ? PHASE_LABELS[task.phase] ?? task.phase : STATUS_LABELS[state.lastResult?.status] ?? "历史日志")}</span></div>
          ${task ? "" : '<div><button type="button" class="plain-button" data-software-copy-report>复制任务报告</button></div>'}
        </div>
        ${task ? `<div class="software-progress${hasPercent ? "" : " indeterminate"}"><progress max="100"${hasPercent ? ` value="${percent}"` : ""} aria-label="${hasPercent ? `任务进度 ${percent}%` : "任务正在进行"}"></progress></div>` : ""}
        ${transfer ? `<div class="software-transfer-status">${escapeHtml(transfer)}</div>` : ""}
        ${activity ? `<div class="software-phase-activity">${escapeHtml(activity)}</div>` : ""}
        ${resultSummary}
        ${logs.length ? `<details class="software-task-log"><summary>任务日志（最近 ${logs.length} 条）</summary><div class="software-log">${logs.map((line) => `<div class="software-log-line">${escapeHtml(localizedLogLine(line))}</div>`).join("")}</div></details>` : ""}
      </section>`;
  }

  function resultCountsText(entries) {
    const categories = [["succeeded", "成功"], ["failed", "失败"], ["cancelled", "已取消"], ["skipped", "无需处理"]];
    const parts = [];
    let knownCount = 0;
    for (const [status, label] of categories) {
      const count = entries.filter(entry => entry?.status === status).length;
      knownCount += count;
      if (count) parts.push(`${count} 项${label}`);
    }
    if (knownCount < entries.length) parts.push(`${entries.length - knownCount} 项结果待确认`);
    return parts.join(" · ") || "没有逐项结果";
  }

  function taskViewKey(state) {
    const task = state?.snapshot?.task;
    const result = state?.lastResult;
    return `${task ? "running" : result ? "finished" : "idle"}:${task?.taskId || task?.id || result?.taskId || ""}`;
  }

  function renderTaskFooter(task) {
    const percent = Number.isFinite(task.percent) ? Math.max(0, Math.min(100, task.percent)) : null;
    const phase = PHASE_LABELS[task.phase] ?? task.phase ?? "任务正在执行";
    const cancellable = Boolean(task.cancellable && !task.critical);
    const detail = task.critical ? "正在应用更改，当前步骤不可取消" : transferText(task) || (cancellable ? "可取消当前任务" : "当前阶段暂不可取消");
    return `<section class="software-action-bar software-task-dock">
      <div><strong>${escapeHtml(phase)}${percent === null ? "" : ` · ${percent}%`}</strong><p>${escapeHtml(detail)}</p></div>
      <div class="software-confirm-actions">
        <button type="button" class="plain-button" data-software-cancel${cancellable ? "" : " disabled"}>取消任务</button>
        <button type="button" class="plain-button" data-software-copy-report>复制任务报告</button>
      </div>
    </section>`;
  }

  function renderBody(state) {
    const snapshot = state.snapshot;
    if (state.loading && !snapshot) return '<div class="software-loading">正在读取本机环境和可用版本…</div>';
    if (state.error && !snapshot) return `<div class="software-unavailable"><strong>软件管理暂不可用</strong><p>${escapeHtml(state.error)}</p></div>`;
    if (!snapshot) return '<div class="software-loading">打开软件管理后才会开始检测。</div>';

    const blockingMessage = snapshot.unavailableReason === "software_manager_startup_failed"
      ? "软件管理运行环境未能启动，当前已安全停用；Router 和其他功能不受影响。"
      : !snapshot.catalog?.available ? "暂时无法取得可信软件清单，当前页面只读，不会执行安装或卸载。"
        : "";
    const healthMessage = blockingMessage;
    const catalogHealth = catalogStatus(snapshot);
    const tabs = availableTabs(snapshot).map((tab) => `
      <button type="button" class="software-tab${state.activeTab === tab ? " active" : ""}" data-software-tab="${tab}" aria-selected="${state.activeTab === tab}">${TAB_LABELS[tab]}</button>`).join("");
    const cards = state.activeTab === "rollback" ? renderRollbackCards(state) : renderComponentCards(state);
    const selectedCount = state.selectedComponentIds.filter((id) => COMPONENT_ORDER.includes(id)).length;
    const operationDisabled = snapshot.readOnly || Boolean(snapshot.task) || selectedCount === 0;
    const installRootLabel = snapshot.installRootPath || (state.customInstallRootSelected ? "已选择自定义位置" : "默认安全位置 · CBApps");
    return `
      <div class="software-scroll-area" data-software-scroll-tab="${escapeHtml(state.activeTab)}" data-software-task-view="${escapeHtml(taskViewKey(state))}">
      <div class="software-manager-heading">
        <div><h2>软件管理</h2><p>${state.activeTab === "install" ? "安装 Codex，并创建桌面快捷方式。" : state.activeTab === "update" ? "检查并更新 Codex；未安装时会进行首次安装。" : state.activeTab === "uninstall" ? "卸载 Codex 程序，保留登录、配置和聊天历史。" : "恢复上一次更新前的 Codex 版本。"}</p></div>
        <div class="software-heading-actions"><span class="software-health-badge ${healthMessage || catalogHealth.warning ? "warning" : ""}">${blockingMessage ? "安装清单不可用" : escapeHtml(catalogHealth.label)}</span><button type="button" class="ghost-button light" data-software-refresh${snapshot.task ? " disabled" : ""}>重新检测</button></div>
      </div>
      <div class="software-tabs" role="tablist">${tabs}</div>
      ${blockingMessage ? `<div class="software-unavailable"><strong>当前仅可查看</strong><p>${blockingMessage}</p></div>` : ""}
      ${!blockingMessage && catalogHealth.detail ? `<div class="software-catalog-notice"><span>${escapeHtml(catalogHealth.summary || catalogHealth.detail)}</span>${catalogHealth.summary ? `<details class="software-catalog-details"><summary>清单详情</summary><p>${escapeHtml(catalogHealth.detail)}</p></details>` : ""}</div>` : ""}
      ${renderTask(state)}
      ${state.activeTab === "install" || state.activeTab === "update" ? `
        <section class="software-install-root">
          <div class="software-install-root-copy"><strong>安装位置</strong><div class="software-install-root-value" title="${escapeHtml(installRootLabel)}">${escapeHtml(installRootLabel)}</div><p>${state.activeTab === "update" ? "未安装时使用此位置；已安装的 Codex 在原位置更新" : "Codex 使用短目录层级；登录、配置和历史仍保存在官方 .codex 目录"}</p></div>
          <button type="button" class="plain-button" data-software-choose-root${snapshot.readOnly || snapshot.task ? " disabled" : ""}>选择位置</button>
        </section>` : ""}
      ${state.activeTab === "uninstall" ? '<div class="software-warning-banner">仅删除 Codex 程序和已记录快捷方式；登录、配置、聊天历史及项目文件保留。</div>' : ""}
      ${state.activeTab === "rollback" ? '<div class="software-warning-banner">回滚只恢复上一次更新前的程序版本，成功后会删除当前新版本并消费这条回滚记录。</div>' : ""}
      <div class="software-manager-grid software-manager-codex-only">${cards}</div>
      </div>
      <div class="software-footer">
      ${snapshot.task ? renderTaskFooter(snapshot.task) : state.confirmationPending ? renderConfirmation(state) : `
      <section class="software-action-bar">
        <div><strong>${selectedCount > 0 ? `已选择 ${selectedCount} 项` : "尚未选择处理内容"}</strong><p>${escapeHtml(selectionNames(state).join("、") || "勾选后会在执行前再次确认")}</p></div>
        <button type="button" class="primary-button" data-software-start${operationDisabled ? " disabled" : ""}>${actionLabel(state.activeTab)}</button>
      </section>`}
      </div>`;
  }


  function render(root, state) {
    if (!root || typeof root !== "object") throw new TypeError("software_manager_root_required");
    const previousScroll = root.querySelector?.(".software-scroll-area");
    const sameTask = previousScroll?.dataset?.softwareTaskView === taskViewKey(state);
    const scrollTop = previousScroll?.dataset?.softwareScrollTab === state?.activeTab && sameTask ? previousScroll.scrollTop : 0;
    const detailsOpen = root.querySelector?.(".software-catalog-details")?.open === true;
    const logsOpen = sameTask && root.querySelector?.(".software-task-log")?.open === true;
    const html = renderBody(state ?? createInitialState());
    root.innerHTML = html;
    const nextScroll = root.querySelector?.(".software-scroll-area");
    const nextDetails = root.querySelector?.(".software-catalog-details");
    const nextLogs = root.querySelector?.(".software-task-log");
    if (nextDetails) nextDetails.open = detailsOpen;
    if (nextLogs) nextLogs.open = logsOpen;
    if (nextScroll) nextScroll.scrollTop = scrollTop;
    return root;
  }

  function readSelection(root) {
    const componentIds = [...(root?.querySelectorAll?.("[data-software-component]:checked") ?? [])]
      .map((element) => element?.dataset?.softwareComponent)
      .filter((id) => COMPONENT_ORDER.includes(id));
    return Object.freeze({
      componentIds: Object.freeze(uniqueIds(componentIds)),
      skillIds: Object.freeze([]),
      pluginIds: Object.freeze([]),
    });
  }

  global.CodexBridgeSoftwareManagerUI = Object.freeze({
    buildTaskReport,
    combineTaskResults,
    createInitialState,
    defaultSelection,
    readSelection,
    reduce,
    render,
    taskResultFeedback,
  });
}(window));
