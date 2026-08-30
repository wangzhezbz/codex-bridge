(function attachSoftwareManagerUi(global) {
  "use strict";

  const COMPONENT_ORDER = ["chatgpt", "v2rayn", "git"];
  const TAB_LABELS = Object.freeze({
    install: "下载安装",
    update: "检查更新",
    uninstall: "卸载软件",
    rollback: "回滚",
  });
  const REGISTER_URL = "https://w1.soxo.top/auth/register?code=2aEq";
  const HIDDEN_LEGACY_SKILL_IDS = new Set([
    "brainstorming", "executing-plans", "finishing-a-development-branch", "hyperframes", "pdf",
    "playwright", "playwright-interactive", "ppt-master", "receiving-code-review", "remotion",
    "requesting-code-review", "systematic-debugging", "test-driven-development", "using-git-worktrees",
    "using-superpowers", "verification-before-completion", "writing-plans",
  ]);
  const CURATED_SKILL_DESCRIPTIONS = Object.freeze({
    pua: "帮助推进任务、减少拖延。",
    "frontend-design": "帮助设计和优化前端界面。",
    "taste-skill": "帮助提升网页的视觉品质。",
    "humanizer-zh": "帮助减少中文内容的 AI 写作痕迹。",
    "agent-reach": "帮助跨网页、社交和视频平台检索信息。",
    "video-use": "帮助完成视频检索、转写、剪辑和渲染。",
    "seedance-prompt-zh": "帮助编写 Seedance 2.0 中文视频提示词。",
    "claude-mem": "为 Codex 增加跨会话记忆能力。",
    cowart: "为 Codex 增加图像生成和画布创作能力。",
  });
  const STATUS_LABELS = Object.freeze({ succeeded: "成功", partial: "部分失败", failed: "失败", cancelled: "已取消", skipped: "已跳过" });
  const PHASE_LABELS = Object.freeze({
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

  function conciseSkillDescription(item) {
    return CURATED_SKILL_DESCRIPTIONS[item?.id] || String(item?.description || "").trim();
  }

  function catalogSkills(snapshot) {
    return (Array.isArray(snapshot?.catalog?.skills) ? snapshot.catalog.skills : [])
      .filter((item) => !HIDDEN_LEGACY_SKILL_IDS.has(item?.id))
      .map((item) => ({ ...item, description: conciseSkillDescription(item) }));
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

  function taskResultFeedback(result) {
    if (result?.status === "partial") return Object.freeze({ message: "部分项目处理失败，请查看任务报告。", tone: "error" });
    if (result?.status === "failed") return Object.freeze({ message: "软件管理任务失败，请查看任务报告。", tone: "error" });
    if (result?.status === "cancelled") return Object.freeze({ message: "软件管理任务已取消。", tone: "info" });
    const entries = [...(result?.components ?? []), ...(result?.skills ?? []), ...(result?.plugins ?? [])];
    if (entries.some((entry) => /warning|警告/iu.test(String(entry?.message || "")))) {
      return Object.freeze({ message: "主要安装已完成，但附加步骤存在警告，请查看任务报告。", tone: "error" });
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

  function resultMessage(entry, kind) {
    if (entry?.status === "succeeded") {
      return /warning|警告/iu.test(String(entry?.message || ""))
        ? `${actionResultLabel(kind, "succeeded")}，但有警告：${String(entry.message)}`
        : actionResultLabel(kind, "succeeded");
    }
    if (entry?.status === "skipped") return "当前项目无需处理";
    if (entry?.status === "cancelled") return "任务已取消";
    return `${actionResultLabel(kind, "failed")}：${String(entry?.message || "请复制任务报告后重试")}`;
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
    if (task?.phase === "plugin") return "正在处理完整插件和固定版本的 Marketplace。";
    if (task?.phase === "cancelling") return "正在等待当前子进程完成安全取消。";
    return task ? "任务仍在进行，请等待当前阶段完成。" : "";
  }

  function componentName(id, snapshot) {
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
      return { label: "在线刷新失败", warning: true, detail: `当前继续使用已验证的本地清单${published}。` };
    }
    if (catalog.source === "remote") {
      return { label: "在线清单已更新", warning: false, detail: "" };
    }
    if (catalog.source === "cache") {
      return { label: "使用缓存清单", warning: true, detail: `尚未取得新的在线清单${published}。` };
    }
    if (catalog.source === "bundled") {
      return { label: "使用内置清单", warning: true, detail: `当前为随安装包提供的离线清单${published}。` };
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
        lines.push(`- ${label}：${STATUS_LABELS[entry.status] ?? entry.status ?? "未知"}${entry.message ? `（${entry.message}）` : ""}`);
      }
    }
    const logs = (snapshot?.logs ?? []).slice(-500);
    if (logs.length > 0) lines.push("", "任务日志：", ...logs.map((line) => `- ${localizedLogLine(line)}`));
    return lines.join("\n");
  }

  function defaultSelection(snapshot, tab) {
    if (!snapshot || !snapshot.enabled || snapshot.readOnly) {
      return Object.freeze({ componentIds: Object.freeze([]), skillIds: Object.freeze([]), pluginIds: Object.freeze([]) });
    }
    if (tab === "install" || tab === "update") {
      const configured = snapshot.defaults?.[tab] ?? {};
      return Object.freeze({
        componentIds: Object.freeze(uniqueIds(configured.componentIds)),
        skillIds: Object.freeze(uniqueIds(configured.skillIds)),
        pluginIds: Object.freeze([]),
      });
    }
    return Object.freeze({ componentIds: Object.freeze([]), skillIds: Object.freeze([]), pluginIds: Object.freeze([]) });
  }

  function hasInstalledChatGpt(snapshot) {
    const entry = (snapshot?.components ?? []).find((item) => item?.id === "chatgpt");
    return typeof entry?.installedVersion === "string" && entry.installedVersion.length > 0;
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
    };
  }

  function toggle(values, id, checked) {
    const set = new Set(values);
    if (checked) set.add(id); else set.delete(id);
    return [...set];
  }

  function reduce(state, action) {
    const current = state ?? createInitialState();
    if (!action || typeof action !== "object") return current;
    if (action.type === "loading") return { ...current, loading: Boolean(action.loading), error: null };
    if (action.type === "error") return { ...current, loading: false, error: String(action.error || "软件管理暂不可用") };
    if (action.type === "snapshot") {
      const nextSnapshot = action.snapshot && typeof action.snapshot === "object" ? action.snapshot : null;
      const tabs = Array.isArray(nextSnapshot?.tabs) ? nextSnapshot.tabs : [];
      const activeTab = tabs.includes(current.activeTab) ? current.activeTab : (tabs[0] ?? "install");
      const defaults = defaultSelection(nextSnapshot, activeTab);
      return {
        ...current,
        snapshot: nextSnapshot,
        activeTab,
        selectedComponentIds: [...defaults.componentIds],
        selectedSkillIds: [...defaults.skillIds],
        selectedPluginIds: [...defaults.pluginIds],
        skillsExpanded: false,
        confirmationPending: false,
        loading: false,
        error: null,
      };
    }
    if (action.type === "curated-plugins") {
      if (!current.snapshot) return current;
      return {
        ...current,
        snapshot: {
          ...current.snapshot,
          curatedPlugins: Array.isArray(action.plugins) ? [...action.plugins] : [],
        },
      };
    }
    if (action.type === "tab") {
      const tabs = current.snapshot?.tabs ?? [];
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
      const selectedComponentIds = toggle(current.selectedComponentIds, action.componentId, action.checked);
      const selectedPluginIds = action.componentId === "chatgpt" && action.checked === false
        && current.activeTab === "install" && !hasInstalledChatGpt(current.snapshot)
        ? []
        : current.selectedPluginIds;
      return { ...current, selectedComponentIds, selectedPluginIds, confirmationPending: false };
    }
    if (action.type === "toggle-skill") {
      return { ...current, selectedSkillIds: toggle(current.selectedSkillIds, action.skillId, action.checked), confirmationPending: false };
    }
    if (action.type === "toggle-plugin") {
      const selectedPluginIds = toggle(current.selectedPluginIds, action.pluginId, action.checked);
      const selectedComponentIds = action.checked === true && current.activeTab === "install"
        && !hasInstalledChatGpt(current.snapshot)
        ? toggle(current.selectedComponentIds, "chatgpt", true)
        : current.selectedComponentIds;
      return { ...current, selectedComponentIds, selectedPluginIds, confirmationPending: false };
    }
    if (action.type === "skill-query") return { ...current, skillQuery: String(action.query ?? "") };
    if (action.type === "toggle-skills") return { ...current, skillsExpanded: !current.skillsExpanded };
    if (action.type === "install-root") {
      return { ...current, installRootToken: action.token, customInstallRootSelected: true, confirmationPending: false };
    }
    if (action.type === "confirm-open") return { ...current, confirmationPending: true };
    if (action.type === "confirm-close") return { ...current, confirmationPending: false };
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
        const task = {
          taskId: event.taskId,
          kind: snapshot.task?.kind ?? current.activeTab,
          phase: event.phase,
          componentId: event.componentId ?? null,
          percent: Number.isFinite(Number(event.percent)) ? Number(event.percent) : null,
          critical: event.cancellable === false,
          cancellable: event.cancellable === true,
          downloadedBytes: Number.isFinite(Number(event.downloadedBytes)) ? Number(event.downloadedBytes) : null,
          totalBytes: Number.isFinite(Number(event.totalBytes)) ? Number(event.totalBytes) : null,
          bytesPerSecond: Number.isFinite(Number(event.bytesPerSecond)) ? Number(event.bytesPerSecond) : null,
        };
        const priorLogs = snapshot.logs ?? [];
        const logs = event.message && priorLogs.at(-1) !== event.message
          ? [...priorLogs, event.message].slice(-500)
          : priorLogs;
        return { ...current, snapshot: { ...snapshot, task, logs }, confirmationPending: false };
      }
      if (event.type === "finished") {
        return { ...current, snapshot: { ...snapshot, task: null }, lastResult: event.result ?? null, confirmationPending: false };
      }
    }
    if (action.type === "task-result") {
      return {
        ...current,
        snapshot: current.snapshot ? { ...current.snapshot, task: null } : current.snapshot,
        lastResult: action.result ?? null,
        confirmationPending: false,
      };
    }
    return current;
  }

  function installedSkills(snapshot) {
    const catalog = new Map(catalogSkills(snapshot).map((item) => [item.id, item]));
    return (snapshot?.skills ?? [])
      .filter((item) => item?.status === "succeeded" && item?.versionAfter)
      .map((item) => {
        const id = item.componentId ?? item.id;
        const known = catalog.get(id);
        return { id, name: known?.name ?? item.name ?? id, description: known?.description ?? "已安装 Skill", version: item.versionAfter };
      });
  }

  function renderSkillPicker({
    mode, items, selectedIds, pluginItems = [], selectedPluginIds = [], query = "", maxVisibleRows = 6,
  } = {}) {
    const selected = new Set(uniqueIds(selectedIds));
    const selectedPlugins = new Set(uniqueIds(selectedPluginIds));
    const needle = String(query).trim().toLocaleLowerCase("zh-CN");
    const visible = (Array.isArray(items) ? items : []).filter((item) => {
      const haystack = `${item?.name ?? ""} ${item?.id ?? ""} ${item?.description ?? ""}`.toLocaleLowerCase("zh-CN");
      return !needle || haystack.includes(needle);
    });
    const visiblePlugins = (Array.isArray(pluginItems) ? pluginItems : []).filter((item) => {
      const haystack = `${item?.name ?? ""} ${item?.id ?? ""} ${item?.description ?? ""} ${(item?.capabilities ?? []).join(" ")}`.toLocaleLowerCase("zh-CN");
      return !needle || haystack.includes(needle);
    });
    const skillRows = visible.map((item) => `
        <label class="software-skill-row">
          <input type="checkbox" data-software-skill="${escapeHtml(item.id)}"${selected.has(item.id) ? " checked" : ""}>
          <span><strong>${escapeHtml(item.name || item.id)}</strong><small>${escapeHtml(item.description || "")}</small></span>
          <code>${escapeHtml(item.id)}</code>
        </label>`).join("");
    const pluginRows = visiblePlugins.map((item) => {
      const disabled = item.selectable === false;
      const detail = conciseSkillDescription(item);
      return `
        <label class="software-skill-row${disabled ? " disabled" : ""}">
          <input type="checkbox" data-software-plugin="${escapeHtml(item.id)}"${selectedPlugins.has(item.id) ? " checked" : ""}${disabled ? " disabled" : ""}>
          <span><strong>${escapeHtml(item.name || item.id)}</strong><small>${escapeHtml(detail)}</small></span>
          <code>${escapeHtml(item.id)}</code>
        </label>`;
    }).join("");
    const rows = skillRows || pluginRows ? `${skillRows}${pluginRows}` : '<div class="software-empty-row">没有匹配的 Skill</div>';
    return `
      <section class="software-skill-picker" data-skill-picker-mode="${escapeHtml(mode)}" data-visible-rows="${Number(maxVisibleRows) || 6}">
        <div class="software-skill-search">
          <input type="search" data-software-skill-query value="${escapeHtml(query)}" placeholder="搜索 Skill 名称或用途" aria-label="搜索 Skill 名称或用途">
          <span>已选择 ${selected.size + selectedPlugins.size} 项</span>
        </div>
        <div class="software-skill-list">${rows}</div>
      </section>`;
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
    let note;
    if (entry.id === "chatgpt") {
      if (tab === "uninstall") note = "删除程序和 ChatGPT 快捷方式，保留登录、配置和历史";
      else if (tab === "update") note = entry.updateState === "update-available" ? "更新后保留当前版本用于一次回滚" : "ChatGPT 登录与历史不会改变";
      else note = "创建 ChatGPT 桌面图标；登录、配置和历史保存在官方 .codex 目录";
    } else if (entry.id === "v2rayn") {
      if (tab === "uninstall") note = "删除程序和 V2RayN 快捷方式，保留订阅和节点配置";
      else note = `创建 V2RayN 桌面图标 · <button type="button" class="software-link-button" data-software-register data-url="${REGISTER_URL}">没有账号？打开注册地址</button>`;
    } else {
      const owner = entry.ownership === "external" || entry.message === "git_external_installed" ? "外部安装" : entry.installedVersion ? "CodexBridge 管理" : "尚未安装";
      const installPath = entry.installPath ? ` · <code>${escapeHtml(entry.installPath)}</code>` : "";
      note = tab === "uninstall"
        ? `卸载 Git 程序，保留配置、SSH 密钥和仓库 · ${owner}${installPath}`
        : `已有 Git 会在原位置更新；不创建桌面图标 · ${owner}${installPath}`;
    }
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
            <span><input type="checkbox" data-software-component="${escapeHtml(entry.id)}"${selected.has(entry.id) ? " checked" : ""}${unavailable || snapshot.readOnly || snapshot.task ? " disabled" : ""}> <strong>${escapeHtml(entry.name)}</strong></span>
            <span class="software-state ${statusClass}">${escapeHtml(status)}</span>
          </div>
          <div class="software-component-version">${componentDetail(entry, tab)}</div>
          <div class="software-component-note">${componentNote(entry, tab)}</div>
        </label>`;
    }).join("");
  }

  function renderSkillsCard(state) {
    const snapshot = state.snapshot;
    const installed = installedSkills(snapshot);
    const available = catalogSkills(snapshot);
    const plugins = Array.isArray(snapshot?.curatedPlugins) ? snapshot.curatedPlugins : [];
    const availablePlugins = plugins;
    const installedPlugins = plugins.filter((plugin) => plugin.installed === true);
    const selectedCount = state.selectedSkillIds.length + state.selectedPluginIds.length;
    const unavailable = snapshot.readOnly || state.activeTab === "rollback";
    const status = state.activeTab === "uninstall"
      ? `${installed.length + installedPlugins.length} 项已安装`
      : `${selectedCount} 项已选`;
    const detail = state.activeTab === "uninstall"
      ? "从已安装列表中精确选择要卸载的 Skill"
      : `按名称和用途选择需要的 Skill（共 ${available.length + availablePlugins.length} 项）`;
    return `
      <article class="software-component-card software-skills-card${state.skillsExpanded ? " selected" : ""}${unavailable ? " disabled" : ""}">
        <div class="software-component-head">
          <strong>Skills</strong>
          <span class="software-state ${selectedCount > 0 || installed.length > 0 ? "installed" : "missing"}">${escapeHtml(status)}</span>
        </div>
        <div class="software-component-version">${escapeHtml(detail)}</div>
        <button type="button" class="software-skills-toggle" data-software-toggle-skills${unavailable || snapshot.task ? " disabled" : ""}>${state.skillsExpanded ? "收起 Skill 列表" : "展开 Skill 列表"} <span aria-hidden="true">${state.skillsExpanded ? "↑" : "→"}</span></button>
      </article>`;
  }

  function renderRollbackCards(state) {
    const selected = new Set(state.selectedComponentIds);
    return (state.snapshot?.rollback ?? []).map((entry) => `
      <label class="software-component-card rollback${selected.has(entry.id) ? " selected" : ""}">
        <div class="software-component-head">
          <span><input type="checkbox" data-software-component="${escapeHtml(entry.id)}"${selected.has(entry.id) ? " checked" : ""}${state.snapshot.readOnly || state.snapshot.task ? " disabled" : ""}> <strong>${escapeHtml(entry.name || componentName(entry.id, state.snapshot))}</strong></span>
          <span class="software-state rollback">可回滚</span>
        </div>
        <div class="software-component-version">当前 ${escapeHtml(entry.version || "-")}<br><b>恢复到 ${escapeHtml(entry.previousVersion || "上一版本")}</b></div>
        <div class="software-component-note">回滚成功后会删除当前新版本，并清除这一次回滚记录</div>
      </label>`).join("");
  }

  function renderSkillsDrawer(state) {
    if (!state.skillsExpanded || !["install", "uninstall"].includes(state.activeTab)) return "";
    const pickerItems = state.activeTab === "install"
      ? catalogSkills(state.snapshot)
      : installedSkills(state.snapshot);
    const allPlugins = Array.isArray(state.snapshot?.curatedPlugins) ? state.snapshot.curatedPlugins : [];
    const pluginItems = state.activeTab === "install"
      ? allPlugins
      : allPlugins.filter((plugin) => plugin.installed === true);
    const picker = renderSkillPicker({
      mode: state.activeTab,
      items: pickerItems,
      selectedIds: state.selectedSkillIds,
      pluginItems,
      selectedPluginIds: state.selectedPluginIds,
      query: state.skillQuery,
      maxVisibleRows: 6,
    });
    return `<section class="software-skills-panel software-skills-drawer">
      <div class="software-skills-title"><div><strong>Skills 列表</strong><p>${state.activeTab === "uninstall" ? "只显示本机已安装且可安全卸载的项目" : "勾选后安装；同名 Skill 会直接替换为所选版本"}</p></div><span>${pickerItems.length + pluginItems.length} 项</span></div>
      ${picker}
    </section>`;
  }

  function actionLabel(tab) {
    return ({ install: "确认并开始", update: "开始更新", uninstall: "确认卸载", rollback: "确认回滚" })[tab] ?? "开始";
  }

  function selectionNames(state) {
    const componentNames = state.selectedComponentIds.map((id) => componentName(id, state.snapshot));
    const skillMap = new Map([
      ...catalogSkills(state.snapshot),
      ...installedSkills(state.snapshot),
    ].map((item) => [item.id, item.name || item.id]));
    const pluginMap = new Map((state.snapshot?.curatedPlugins ?? []).map((item) => [item.id, item.name || item.id]));
    return [
      ...componentNames,
      ...state.selectedSkillIds.map((id) => skillMap.get(id) ?? id),
      ...state.selectedPluginIds.map((id) => pluginMap.get(id) ?? id),
    ];
  }

  function renderConfirmation(state) {
    if (!state.confirmationPending) return "";
    const names = selectionNames(state);
    return `
      <section class="software-confirmation" aria-label="操作确认">
        <div><strong>请确认本次操作</strong><p>${escapeHtml(names.join("、") || "尚未选择内容")}</p>
          ${state.activeTab === "install" && state.selectedSkillIds.length > 0 ? "<p class=\"software-warning\">同名 Skill 将被替换，原内容不会保留。</p>" : ""}
          ${state.activeTab === "uninstall" ? "<p class=\"software-warning\">只删除所选程序本体和已记录快捷方式；登录、订阅、Git 配置、SSH 密钥与项目文件保留。</p>" : ""}
        </div>
        <div class="software-confirm-actions">
          <button type="button" class="plain-button" data-software-confirm-cancel>返回</button>
          <button type="button" class="primary-button" data-software-confirm>${actionLabel(state.activeTab)}</button>
        </div>
      </section>`;
  }

  function renderTask(state) {
    const task = state.snapshot?.task;
    const logs = (state.snapshot?.logs ?? []).slice(-500);
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
        <span>${resultEntries.filter((entry) => entry.status === "succeeded").length} 项成功 · ${resultEntries.filter((entry) => entry.status === "failed").length} 项失败</span>
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
          <div><strong>${task ? "任务正在执行" : "最近一次任务"}</strong><span>${escapeHtml(task ? PHASE_LABELS[task.phase] ?? task.phase : STATUS_LABELS[state.lastResult?.status] ?? "已完成")}</span></div>
          <div>${task ? `<button type="button" class="plain-button" data-software-cancel${task.cancellable && !task.critical ? "" : " disabled"}>取消任务</button>` : ""}<button type="button" class="plain-button" data-software-copy-report>复制任务报告</button></div>
        </div>
        ${task ? `<div class="software-progress${hasPercent ? "" : " indeterminate"}"><progress max="100"${hasPercent ? ` value="${percent}"` : ""} aria-label="${hasPercent ? `任务进度 ${percent}%` : "任务正在进行"}"></progress></div>` : ""}
        ${transfer ? `<div class="software-transfer-status">${escapeHtml(transfer)}</div>` : ""}
        ${activity ? `<div class="software-phase-activity">${escapeHtml(activity)}</div>` : ""}
        ${resultSummary}
        <div class="software-log">${logs.map((line) => `<div class="software-log-line">${escapeHtml(localizedLogLine(line))}</div>`).join("")}</div>
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
    const tabs = (snapshot.tabs ?? []).map((tab) => `
      <button type="button" class="software-tab${state.activeTab === tab ? " active" : ""}" data-software-tab="${tab}" aria-selected="${state.activeTab === tab}">${TAB_LABELS[tab]}</button>`).join("");
    const cards = state.activeTab === "rollback" ? renderRollbackCards(state) : renderComponentCards(state);
    const selectedCount = state.selectedComponentIds.length + state.selectedSkillIds.length + state.selectedPluginIds.length;
    const operationDisabled = snapshot.readOnly || Boolean(snapshot.task) || selectedCount === 0;
    return `
      <div class="software-manager-heading">
        <div><h2>软件管理</h2><p>${state.activeTab === "install" ? "安装 ChatGPT 常用环境，并按你的选择创建桌面图标。" : state.activeTab === "update" ? "检查并安装可用的新版本；没有新版的项目不会重复处理。" : state.activeTab === "uninstall" ? "精确选择要卸载的软件或 Skill，用户数据始终保留。" : "恢复上一次更新前的程序版本。"}</p></div>
        <div class="software-heading-actions"><span class="software-health-badge ${healthMessage || catalogHealth.warning ? "warning" : ""}">${blockingMessage ? "安装清单不可用" : escapeHtml(catalogHealth.label)}</span><button type="button" class="ghost-button light" data-software-refresh${snapshot.task ? " disabled" : ""}>重新检测</button></div>
      </div>
      <div class="software-tabs" role="tablist">${tabs}</div>
      ${blockingMessage ? `<div class="software-unavailable"><strong>当前仅可查看</strong><p>${blockingMessage}</p></div>` : ""}
      ${!blockingMessage && catalogHealth.detail ? `<div class="software-catalog-notice">${escapeHtml(catalogHealth.detail)}</div>` : ""}
      ${state.activeTab === "install" || state.activeTab === "update" ? `
        <section class="software-install-root">
          <div class="software-install-root-copy"><strong>安装位置</strong><div class="software-install-root-value">${escapeHtml(snapshot.installRootPath || (state.customInstallRootSelected ? "已选择自定义位置" : "默认安全位置 · CBApps"))}</div><p>${state.activeTab === "update" ? "未安装的软件会安装到这里；已有软件在原位置更新" : "ChatGPT 自动使用短目录层级；登录、配置和历史仍保存在官方 .codex 目录"}</p></div>
          <button type="button" class="plain-button" data-software-choose-root${snapshot.readOnly || snapshot.task ? " disabled" : ""}>选择位置</button>
        </section>` : ""}
      ${state.activeTab === "uninstall" ? '<div class="software-warning-banner">卸载只删除所选程序本体和已记录快捷方式；ChatGPT 登录与历史、V2RayN 订阅、Git 配置、SSH 密钥和项目文件都会保留。</div>' : ""}
      ${state.activeTab === "rollback" ? '<div class="software-warning-banner">回滚只恢复上一次更新前的程序版本，成功后会删除当前新版本并消费这条回滚记录。</div>' : ""}
      <div class="software-manager-grid">${cards}${["install", "uninstall"].includes(state.activeTab) ? renderSkillsCard(state) : ""}</div>
      ${renderSkillsDrawer(state)}
      <section class="software-action-bar">
        <div><strong>${selectedCount > 0 ? `已选择 ${selectedCount} 项` : "尚未选择处理内容"}</strong><p>${escapeHtml(selectionNames(state).join("、") || "勾选后会在执行前再次确认")}</p></div>
        <button type="button" class="primary-button" data-software-start${operationDisabled ? " disabled" : ""}>${actionLabel(state.activeTab)}</button>
      </section>
      ${renderConfirmation(state)}
      ${renderTask(state)}`;
  }

  function render(root, state) {
    if (!root || typeof root !== "object") throw new TypeError("software_manager_root_required");
    root.innerHTML = renderBody(state ?? createInitialState());
    return root;
  }

  function readSelection(root) {
    const checked = (selector, key) => [...(root?.querySelectorAll?.(`${selector}:checked`) ?? [])]
      .map((element) => element?.dataset?.[key])
      .filter(Boolean);
    return Object.freeze({
      componentIds: Object.freeze(uniqueIds(checked("[data-software-component]", "softwareComponent"))),
      skillIds: Object.freeze(uniqueIds(checked("[data-software-skill]", "softwareSkill"))),
      pluginIds: Object.freeze(uniqueIds(checked("[data-software-plugin]", "softwarePlugin"))),
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
    renderSkillPicker,
    taskResultFeedback,
  });
}(window));
