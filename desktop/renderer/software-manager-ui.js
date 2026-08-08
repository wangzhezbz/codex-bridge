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

  function componentName(id, snapshot) {
    return snapshot?.components?.find((entry) => entry.id === id)?.name
      || snapshot?.catalog?.components?.find((entry) => entry.id === id)?.name
      || ({ chatgpt: "ChatGPT", v2rayn: "V2RayN", git: "Git" }[id] ?? id);
  }

  function defaultSelection(snapshot, tab) {
    if (!snapshot || !snapshot.enabled || snapshot.readOnly) {
      return Object.freeze({ componentIds: Object.freeze([]), skillIds: Object.freeze([]) });
    }
    if (tab === "install" || tab === "update") {
      const configured = snapshot.defaults?.[tab] ?? {};
      return Object.freeze({
        componentIds: Object.freeze(uniqueIds(configured.componentIds)),
        skillIds: Object.freeze(uniqueIds(configured.skillIds)),
      });
    }
    return Object.freeze({ componentIds: Object.freeze([]), skillIds: Object.freeze([]) });
  }

  function createInitialState() {
    return {
      snapshot: null,
      activeTab: "install",
      selectedComponentIds: [],
      selectedSkillIds: [],
      skillQuery: "",
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
        confirmationPending: false,
        loading: false,
        error: null,
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
        skillQuery: "",
        confirmationPending: false,
      };
    }
    if (action.type === "toggle-component") {
      return { ...current, selectedComponentIds: toggle(current.selectedComponentIds, action.componentId, action.checked), confirmationPending: false };
    }
    if (action.type === "toggle-skill") {
      return { ...current, selectedSkillIds: toggle(current.selectedSkillIds, action.skillId, action.checked), confirmationPending: false };
    }
    if (action.type === "skill-query") return { ...current, skillQuery: String(action.query ?? "") };
    if (action.type === "install-root") {
      return { ...current, installRootToken: action.token, customInstallRootSelected: true, confirmationPending: false };
    }
    if (action.type === "confirm-open") return { ...current, confirmationPending: true };
    if (action.type === "confirm-close") return { ...current, confirmationPending: false };
    if (action.type === "task-event") {
      const snapshot = current.snapshot;
      if (!snapshot) return current;
      const event = action.event ?? {};
      if (event.type === "progress") {
        const task = {
          taskId: event.taskId,
          kind: snapshot.task?.kind ?? current.activeTab,
          phase: event.phase,
          componentId: event.componentId ?? null,
          percent: Number.isFinite(Number(event.percent)) ? Number(event.percent) : null,
          critical: event.cancellable === false,
          cancellable: event.cancellable === true,
        };
        const logs = [...(snapshot.logs ?? []), event.message].filter(Boolean).slice(-500);
        return { ...current, snapshot: { ...snapshot, task, logs }, confirmationPending: false };
      }
      if (event.type === "finished") {
        return { ...current, snapshot: { ...snapshot, task: null }, lastResult: event.result ?? null, confirmationPending: false };
      }
    }
    return current;
  }

  function installedSkills(snapshot) {
    const catalog = new Map((snapshot?.catalog?.skills ?? []).map((item) => [item.id, item]));
    return (snapshot?.skills ?? [])
      .filter((item) => item?.status === "succeeded" && item?.versionAfter)
      .map((item) => {
        const id = item.componentId ?? item.id;
        const known = catalog.get(id);
        return { id, name: known?.name ?? item.name ?? id, description: known?.description ?? "已安装 Skill", version: item.versionAfter };
      });
  }

  function renderSkillPicker({ mode, items, selectedIds, query = "", maxVisibleRows = 6 } = {}) {
    const selected = new Set(uniqueIds(selectedIds));
    const needle = String(query).trim().toLocaleLowerCase("zh-CN");
    const visible = (Array.isArray(items) ? items : []).filter((item) => {
      const haystack = `${item?.name ?? ""} ${item?.id ?? ""} ${item?.description ?? ""}`.toLocaleLowerCase("zh-CN");
      return !needle || haystack.includes(needle);
    });
    const rows = visible.length > 0
      ? visible.map((item) => `
        <label class="software-skill-row">
          <input type="checkbox" data-software-skill="${escapeHtml(item.id)}"${selected.has(item.id) ? " checked" : ""}>
          <span><strong>${escapeHtml(item.name || item.id)}</strong><small>${escapeHtml(item.description || "")}</small></span>
          <code>${escapeHtml(item.id)}</code>
        </label>`).join("")
      : '<div class="software-empty-row">没有匹配的 Skill</div>';
    return `
      <section class="software-skill-picker" data-skill-picker-mode="${escapeHtml(mode)}" data-visible-rows="${Number(maxVisibleRows) || 6}">
        <div class="software-skill-search">
          <input type="search" data-software-skill-query value="${escapeHtml(query)}" placeholder="搜索 Skill 名称或用途" aria-label="搜索 Skill 名称或用途">
          <span>已选择 ${selected.size} 项</span>
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
    if (tab === "update" && entry.updateState === "update-available") {
      return `当前 ${escapeHtml(entry.installedVersion)} <b>→</b> 最新 ${escapeHtml(entry.version)}`;
    }
    if (tab === "update" && entry.updateState === "current") return `当前版本 ${escapeHtml(entry.installedVersion)}`;
    if (tab === "uninstall") return entry.installedVersion ? `版本 ${escapeHtml(entry.installedVersion)}` : "本机没有可卸载版本";
    return `版本 ${escapeHtml(entry.version)} · ${escapeHtml(formatBytes(entry.size))}`;
  }

  function componentNote(entry, tab) {
    if (entry.id === "chatgpt") {
      if (tab === "uninstall") return "删除程序和 ChatGPT 快捷方式，保留登录、配置和历史";
      if (tab === "update") return entry.updateState === "update-available" ? "更新后保留当前版本用于一次回滚" : "ChatGPT 登录与历史不会改变";
      return "创建 ChatGPT 桌面图标；登录、配置和历史保存在官方 .codex 目录";
    }
    if (entry.id === "v2rayn") {
      if (tab === "uninstall") return "删除程序和 V2RayN 快捷方式，保留订阅和节点配置";
      return `创建 V2RayN 桌面图标 · <button type="button" class="software-link-button" data-software-register data-url="${REGISTER_URL}">没有账号？打开注册地址</button>`;
    }
    const owner = entry.ownership === "external" || entry.message === "git_external_installed" ? "外部安装" : entry.installedVersion ? "CodexBridge 管理" : "尚未安装";
    const installPath = entry.installPath ? ` · <code>${escapeHtml(entry.installPath)}</code>` : "";
    if (tab === "uninstall") return `卸载 Git 程序，保留配置、SSH 密钥和仓库 · ${owner}${installPath}`;
    return `已有 Git 会在原位置更新；不创建桌面图标 · ${owner}${installPath}`;
  }

  function renderComponentCards(state) {
    const snapshot = state.snapshot;
    const selected = new Set(state.selectedComponentIds);
    const entries = snapshot?.components ?? [];
    const tab = state.activeTab;
    return entries.map((entry) => {
      const [status, statusClass] = componentStatus(entry, tab);
      const unavailable = tab === "update" && entry.updateState === "current"
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

  function actionLabel(tab) {
    return ({ install: "确认并开始", update: "开始更新", uninstall: "确认卸载", rollback: "确认回滚" })[tab] ?? "开始";
  }

  function selectionNames(state) {
    const componentNames = state.selectedComponentIds.map((id) => componentName(id, state.snapshot));
    const skillMap = new Map([
      ...(state.snapshot?.catalog?.skills ?? []),
      ...installedSkills(state.snapshot),
    ].map((item) => [item.id, item.name || item.id]));
    return [...componentNames, ...state.selectedSkillIds.map((id) => skillMap.get(id) ?? id)];
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
    const percent = Number.isFinite(task?.percent) ? Math.max(0, Math.min(100, task.percent)) : 0;
    return `
      <section class="software-task-panel" aria-live="polite">
        <div class="software-task-head">
          <div><strong>${task ? "任务正在执行" : "最近一次任务"}</strong><span>${escapeHtml(task?.phase || state.lastResult?.status || "已完成")}</span></div>
          ${task ? `<button type="button" class="plain-button" data-software-cancel${task.cancellable && !task.critical ? "" : " disabled"}>取消任务</button>` : ""}
        </div>
        ${task ? `<div class="software-progress"><progress max="100" value="${percent}" aria-label="任务进度 ${percent}%"></progress></div>` : ""}
        <div class="software-log">${logs.map((line) => `<div class="software-log-line">${escapeHtml(typeof line === "string" ? line : line?.message ?? JSON.stringify(line))}</div>`).join("")}</div>
      </section>`;
  }

  function renderBody(state) {
    const snapshot = state.snapshot;
    if (state.loading && !snapshot) return '<div class="software-loading">正在读取本机环境和可用版本…</div>';
    if (state.error && !snapshot) return `<div class="software-unavailable"><strong>软件管理暂不可用</strong><p>${escapeHtml(state.error)}</p></div>`;
    if (!snapshot) return '<div class="software-loading">打开软件管理后才会开始检测。</div>';

    const readOnlyMessage = snapshot.unavailableReason === "software_manager_startup_failed"
      ? "软件管理本地恢复失败，当前已安全停用；Router 和其他功能不受影响。重启 CodexBridge 后可重新检测。"
      : !snapshot.catalog?.available ? "暂时无法取得可信软件清单，当前页面只读，不会执行安装或卸载。"
        : snapshot.pendingRecovery ? "存在尚未完成的本地事务，恢复完成前不会执行新操作。" : "";
    const tabs = (snapshot.tabs ?? []).map((tab) => `
      <button type="button" class="software-tab${state.activeTab === tab ? " active" : ""}" data-software-tab="${tab}" aria-selected="${state.activeTab === tab}">${TAB_LABELS[tab]}</button>`).join("");
    const pickerItems = state.activeTab === "install" ? snapshot.catalog?.skills ?? [] : installedSkills(snapshot);
    const showSkills = state.activeTab === "install" || state.activeTab === "uninstall";
    const cards = state.activeTab === "rollback" ? renderRollbackCards(state) : renderComponentCards(state);
    const selectedCount = state.selectedComponentIds.length + state.selectedSkillIds.length;
    const operationDisabled = snapshot.readOnly || Boolean(snapshot.task) || selectedCount === 0;
    return `
      <div class="software-manager-heading">
        <div><h2>软件管理</h2><p>${state.activeTab === "install" ? "安装 ChatGPT 常用环境，并按你的选择创建桌面图标。" : state.activeTab === "update" ? "检查并安装可用的新版本；没有新版的项目不会重复处理。" : state.activeTab === "uninstall" ? "精确选择要卸载的软件或 Skill，用户数据始终保留。" : "恢复上一次更新前的程序版本。"}</p></div>
        <button type="button" class="ghost-button light" data-software-refresh${snapshot.task ? " disabled" : ""}>重新检测</button>
      </div>
      <div class="software-tabs" role="tablist">${tabs}</div>
      ${readOnlyMessage ? `<div class="software-unavailable"><strong>当前仅可查看</strong><p>${readOnlyMessage}</p></div>` : ""}
      ${state.activeTab === "install" ? `
        <section class="software-install-root">
          <div><strong>安装位置</strong><p>${state.customInstallRootSelected ? "已选择自定义位置" : "使用默认安全位置；ChatGPT 自动使用短目录层级"}</p></div>
          <button type="button" class="plain-button" data-software-choose-root${snapshot.readOnly || snapshot.task ? " disabled" : ""}>选择位置</button>
        </section>` : ""}
      ${state.activeTab === "uninstall" ? '<div class="software-warning-banner">卸载只删除所选程序本体和已记录快捷方式；ChatGPT 登录与历史、V2RayN 订阅、Git 配置、SSH 密钥和项目文件都会保留。</div>' : ""}
      ${state.activeTab === "rollback" ? '<div class="software-warning-banner">回滚只恢复上一次更新前的程序版本，成功后会删除当前新版本并消费这条回滚记录。</div>' : ""}
      <div class="software-manager-grid">${cards}</div>
      ${showSkills ? `<section class="software-skills-panel"><div class="software-skills-title"><div><strong>Skills</strong><p>${state.activeTab === "install" ? "从列表中选择要安装或强制替换的 Skill" : "从已安装列表中精确选择要卸载的 Skill"}</p></div><span>${pickerItems.length} 项</span></div>${renderSkillPicker({ mode: state.activeTab, items: pickerItems, selectedIds: state.selectedSkillIds, query: state.skillQuery, maxVisibleRows: 6 })}</section>` : ""}
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
    });
  }

  global.CodexBridgeSoftwareManagerUI = Object.freeze({
    createInitialState,
    defaultSelection,
    readSelection,
    reduce,
    render,
    renderSkillPicker,
  });
}(window));
