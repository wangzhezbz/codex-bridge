const api = window.codexBridge;
let state = null;
let draftSelection = [];
let dragSlotIndex = null;
let editingCustomPresetId = null;
let activeProviderId = null;
let usageRangeDays = 7;
let modelPageView = "catalog";
let editingProviderId = null;
let customReturnView = "catalog";
let scopedCustomProviderId = null;
let usageResizeState = null;
let usageColumnCssRules = null;
const resourceExpandedKeys = new Set();
const usageColumnWidths = [168, 190, 128, 84, 112, 112, 112, 112, 176, 168];
const VVIP_PRANK_MESSAGES = new Map([
  ["收购OPEN AI", ["预算暂缺 7 万亿，法务已经先把 PPT 标题建好了。", "任务排期：3000年，敬请期待。。。"]],
  ["免费洗脚", ["水温默认 42 度，足浴大模型正在学习“轻点”和“再重点”。", "任务排期：3000年，敬请期待。。。"]],
  ["送房送车", ["车钥匙和房本已经画在白板上，等宇宙交付中心开门。", "任务排期：3000年，敬请期待。。。"]],
  ["接入Claude", ["Claude 正在门口换鞋，进屋前还要先签一份很厚的路由协议。", "任务排期：3000年，敬请期待。。。"]],
  ["免费GPT", ["价格已经砍到 0，账单系统听完当场选择重启。", "任务排期：3000年，敬请期待。。。"]],
  ["长生不老", ["已提交给生命科学组，回复说先把熬夜修好。", "任务排期：3000年，敬请期待。。。"]],
  ["送媳妇", ["姻缘服务拒绝被 API 化，建议先提升个人魅力版本号。", "任务排期：3000年，敬请期待。。。"]],
  ["Computer Use", ["电脑已经同意上班，但鼠标说它要双休。", "任务排期：3000年，敬请期待。。。"]],
  ["免费生图", ["显卡正在排队领免费奶茶，画布先在原地热身。", "任务排期：3000年，敬请期待。。。"]],
  ["一键起飞", ["塔台批准了一半，另一半卡在“别真的飞走”评审。", "任务排期：3000年，敬请期待。。。"]],
  ["牛了个逼", ["已触发夸夸保护机制，再夸就要收性能税了。", "任务排期：3000年，敬请期待。。。"]],
  ["无限额度", ["无限已到账，额度正在从有限宇宙慢慢搬家。", "任务排期：3000年，敬请期待。。。"]],
]);
const VVIP_FALLBACK_PRANK = ["产品经理已经认真点头，工程师也已经郑重收藏到“梦里开发”清单。", "任务排期：3000年，敬请期待。。。"];

prepareRendererLayout();

const els = {
  routerStatus: document.querySelector("#routerStatus"),
  modeStatus: document.querySelector("#modeStatus"),
  appVersion: document.querySelector("#appVersion"),
  rootDir: document.querySelector("#rootDir"),
  selectedCount: document.querySelector("#selectedCount"),
  keySummary: document.querySelector("#keySummary"),
  keySummaryDetail: document.querySelector("#keySummaryDetail"),
  healthStatus: document.querySelector("#healthStatus"),
  startupCheckSummary: document.querySelector("#startupCheckSummary"),
  startupCheckList: document.querySelector("#startupCheckList"),
  runStartupCheck: document.querySelector("#runStartupCheck"),
  bypassSystemProxy: document.querySelector("#bypassSystemProxy"),
  routerPort: document.querySelector("#routerPort"),
  saveDesktopOptions: document.querySelector("#saveDesktopOptions"),
  profileList: document.querySelector("#profileList"),
  saveConfigProfile: document.querySelector("#saveConfigProfile"),
  backupList: document.querySelector("#backupList"),
  resourceSummary: document.querySelector("#resourceSummary"),
  resourceList: document.querySelector("#resourceList"),
  copyResourceDiagnostics: document.querySelector("#copyResourceDiagnostics"),
  sessionList: document.querySelector("#sessionList"),
  recoverHistoryAccessSessions: document.querySelector("#recoverHistoryAccessSessions"),
  copyDiagnostics: document.querySelector("#copyDiagnostics"),
  latestUsage: document.querySelector("#latestUsage"),
  providerGrid: document.querySelector("#providerGrid"),
  providerPreview: document.querySelector("#providerPreview"),
  selectedModels: document.querySelector("#selectedModels"),
  modelPool: document.querySelector("#modelPool"),
  modelConfigPool: document.querySelector("#modelConfigPool"),
  statCalls: document.querySelector("#statCalls"),
  statTokens: document.querySelector("#statTokens"),
  statPrompt: document.querySelector("#statPrompt"),
  statCache: document.querySelector("#statCache"),
  statCompletion: document.querySelector("#statCompletion"),
  usageChart: document.querySelector("#usageChart"),
  usageRange: document.querySelector("#usageRange"),
  usageTable: document.querySelector("#usageTable"),
  logOutput: document.querySelector("#logOutput"),
  toast: document.querySelector("#toast"),
  requestDetailDialog: document.querySelector("#requestDetailDialog"),
  requestDetailBody: document.querySelector("#requestDetailBody"),
  closeRequestDetail: document.querySelector("#closeRequestDetail"),
  customModelForm: document.querySelector("#customModelForm"),
  customFormTitle: document.querySelector("#customFormTitle"),
  customFormDescription: document.querySelector("#customFormDescription"),
  customSubmitButton: document.querySelector("#customSubmitButton"),
  customImageInput: document.querySelector("#customImageInput"),
  cancelCustomEdit: document.querySelector("#cancelCustomEdit"),
  routerToggle: document.querySelector("#routerToggle"),
  restartCodex: document.querySelector("#restartCodex"),
  selectCodexDesktopExe: document.querySelector("#selectCodexDesktopExe"),
  codexDesktopPath: document.querySelector("#codexDesktopPath"),
  checkUpdates: document.querySelector("#checkUpdates"),
  updateDialog: document.querySelector("#updateDialog"),
  updateDialogVersion: document.querySelector("#updateDialogVersion"),
  updateDialogMessage: document.querySelector("#updateDialogMessage"),
  updateDialogAsset: document.querySelector("#updateDialogAsset"),
  updateProgress: document.querySelector("#updateProgress"),
  updateProgressText: document.querySelector("#updateProgressText"),
  updateProgressPercent: document.querySelector("#updateProgressPercent"),
  updateProgressTrack: document.querySelector("#updateProgressTrack"),
  updateProgressBar: document.querySelector("#updateProgressBar"),
  confirmUpdate: document.querySelector("#confirmUpdate"),
  cancelUpdate: document.querySelector("#cancelUpdate"),
  vvipDialog: document.querySelector("#vvipDialog"),
  vvipFeatureName: document.querySelector("#vvipFeatureName"),
  vvipDialogMessage: document.querySelector("#vvipDialogMessage"),
  vvipDialogNote: document.querySelector("#vvipDialogNote"),
  closeVvipDialog: document.querySelector("#closeVvipDialog"),
};

function prepareRendererLayout() {
  document.querySelector('[data-section="modelConfig"]')?.remove();
  document.querySelector("#rootDir")?.closest(".metric")?.remove();
  document.querySelector(".metric-row")?.classList.add("three-metrics");

  const modelsSection = document.querySelector("#models");
  modelsSection?.firstElementChild?.classList.add("model-catalog-panel");
  const modelConfigSection = document.querySelector("#modelConfig");
  if (modelsSection && modelConfigSection && !document.querySelector(".merged-model-config")) {
    const wrapper = document.createElement("div");
    wrapper.className = "merged-model-config";
    while (modelConfigSection.firstElementChild) {
      wrapper.appendChild(modelConfigSection.firstElementChild);
    }
    wrapper.children[0]?.classList.add("provider-editor-panel", "hidden");
    wrapper.children[1]?.classList.add("model-advanced-panel", "hidden");
    wrapper.children[2]?.classList.add("custom-editor-panel", "hidden");
    modelsSection.appendChild(wrapper);
    modelConfigSection.remove();
  }

  const modelPool = document.querySelector("#modelPool");
  if (modelPool && !document.querySelector("#providerPreview")) {
    const preview = document.createElement("div");
    preview.id = "providerPreview";
    preview.className = "provider-preview";
    modelPool.before(preview);
  }

  const usageChart = document.querySelector("#usageChart");
  if (usageChart && !document.querySelector("#usageRange")) {
    const controls = document.createElement("div");
    controls.id = "usageRange";
    controls.className = "segmented usage-range";
    controls.innerHTML = [1, 3, 7, 14, 30]
      .map((days) => `<button type="button" data-usage-range="${days}">${days}天</button>`)
      .join("");
    usageChart.before(controls);
  }
}
document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    activateSection(button.dataset.section);
  });
});

function activateSection(sectionId) {
  const section = document.querySelector(`#${sectionId}`);
  const button = document.querySelector(`.nav-item[data-section="${sectionId}"]`);
  if (!section || !button) {
    return;
  }
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  document.querySelectorAll(".section-panel").forEach((item) => item.classList.add("hidden"));
  button.classList.add("active");
  section.classList.remove("hidden");
}

document.querySelectorAll("[data-usage-range]").forEach((button) => {
  button.addEventListener("click", () => {
    usageRangeDays = Number(button.dataset.usageRange || 7);
    renderUsage();
  });
});

document.querySelectorAll(".mode-card").forEach((button) => {
  button.addEventListener("click", () =>
    runAction(button, async () => {
      state = await api.selectMode(button.dataset.mode);
      draftSelection = [...state.selectedModelIds];
      render();
      showToast("计费模式已切换，模型列表已按该模式更新。");
    }),
  );
});

document.querySelector("#recoverHistoryAccess")?.addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    const result = await api.recoverHistoryAccess();
    await refresh();
    showToast(result?.message || "已开启历史对话显示；当前 CodexBridge 配置保持不变。");
  }),
);

els.routerToggle.addEventListener("click", () =>
  runAction(els.routerToggle, async () => {
    if (state?.routerRunning) {
      await api.stopRouter();
      showToast("Router 已关闭。");
    } else {
      await api.startRouter();
      showToast("Router 已启动。");
    }
    await refresh();
  }),
);

els.restartCodex.addEventListener("click", () =>
  runAction(els.restartCodex, async () => {
    const result = await api.restartCodex();
    await refresh();
    showToast(result?.message || "Codex 已重启。");
  }),
);

els.selectCodexDesktopExe.addEventListener("click", () =>
  runAction(els.selectCodexDesktopExe, async () => {
    const result = await api.selectCodexDesktopExe();
    if (result?.canceled) {
      return;
    }
    state = result?.state || await api.getState();
    render();
    showToast(`已保存 Codex 启动项：${result?.path || codexDesktopLaunchPath() || "自动查找"}`);
  }),
);

els.saveDesktopOptions.addEventListener("click", () =>
  runAction(els.saveDesktopOptions, async () => {
    state = await api.saveOptions({
      bypassSystemProxy: els.bypassSystemProxy.checked,
      routerPort: Number(els.routerPort.value || 15722),
    });
    render();
    showToast(
      "基础设置已保存；端口或代理变更会在重新启动 Router 后生效。",
    );
  }),
);

els.runStartupCheck?.addEventListener("click", () =>
  runAction(els.runStartupCheck, async () => {
    state = {
      ...state,
      startupCheck: await api.runStartupCheck(),
    };
    renderStartupCheck();
    showToast("启动体检已刷新。");
  }),
);

els.saveConfigProfile?.addEventListener("click", () =>
  runAction(els.saveConfigProfile, async () => {
    const name = `配置档 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
    const response = await api.saveConfigProfile({
      name,
      selectedModelIds: draftSelection,
    });
    state = response?.state || await api.getState();
    draftSelection = [...state.selectedModelIds];
    render();
    showToast(`已保存配置档：${response?.saved?.name || name}`);
  }),
);

els.copyResourceDiagnostics?.addEventListener("click", () =>
  runAction(els.copyResourceDiagnostics, async () => {
    const summary = await api.copyDiagnostics();
    showToast(`资源诊断已复制，最近错误 ${summary?.errorCount || 0} 条。`);
  }),
);

els.recoverHistoryAccessSessions?.addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    const result = await api.recoverHistoryAccess();
    await refresh();
    showToast(result?.message || "历史对话访问已刷新。");
  }),
);

els.closeRequestDetail?.addEventListener("click", hideRequestDetail);
els.requestDetailDialog?.addEventListener("click", (event) => {
  if (event.target === els.requestDetailDialog) {
    hideRequestDetail();
  }
});

els.copyDiagnostics.addEventListener("click", () =>
  runAction(els.copyDiagnostics, async () => {
    const summary = await api.copyDiagnostics();
    await refresh();
    showToast(`诊断信息已复制。最近错误 ${summary?.errorCount || 0} 条，发给我就能排查。`);
  }),
);

document.querySelector("#saveModelSelectionPanel").addEventListener("click", (event) =>
  saveModelSelection(event.currentTarget),
);

els.customModelForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runAction(els.customSubmitButton, async () => {
    const editingModel = editingCustomPresetId ? modelMap().get(editingCustomPresetId) : null;
    const wasEditing = Boolean(editingCustomPresetId);
    const model = customModelFormPayload(editingModel);
    const returnView = customReturnView;
    const returnProviderId = scopedCustomProviderId || editingProviderId;
    await api.saveCustomModel(model);
    resetCustomModelForm({ preserveView: true });
    if (returnView === "provider" && returnProviderId) {
      modelPageView = "provider";
      editingProviderId = returnProviderId;
      activeProviderId = returnProviderId;
    } else {
      modelPageView = "catalog";
    }
    scopedCustomProviderId = null;
    customReturnView = "catalog";
    await refresh();
    showToast(
      wasEditing
        ? "自定义模型已更新。API Key 为空时会保留本机已保存的 Key。"
        : "自定义模型已添加。API Key 会保存在本机，同一服务商可以继续添加多个模型。",
    );
  });
});

document.querySelector("#testCustomConnection").addEventListener("click", (event) => {
  runAction(event.currentTarget, async () => {
    const result = await api.testProviderConnection(customProviderPayload(true));
    showToast(
      result.ok
        ? `连接测试通过：HTTP ${result.status || 200}`
        : `连接测试失败：${result.error || result.message || "unknown error"}`,
      result.ok ? "success" : "error",
    );
  });
});

document.querySelector("#customLogoUpload")?.addEventListener("click", (event) => {
  runAction(event.currentTarget, async () => {
    const ownerId = scopedCustomProviderId || editingCustomPresetId || `custom-${slugifyProviderId(value("#customProviderName") || "provider")}`;
    const result = await api.selectLocalLogo({ ownerId, applyToProvider: false });
    if (result?.canceled) {
      return;
    }
    setValue("#customLogoUrl", result.logoUrl || "");
    renderCustomLogoUploadState();
    showToast("本地图标已选择，保存模型后生效。");
  });
});

els.cancelCustomEdit.addEventListener("click", () => {
  resetCustomModelForm({ preserveView: true });
  returnFromCustomEditor();
});

bindFolderButton("#openConfigFolder", "config");
bindFolderButton("#openUpdateFolder", "updates");
document.querySelector("#openGitHub").addEventListener("click", () => api.openGitHub());
els.checkUpdates.addEventListener("click", () =>
  runAction(els.checkUpdates, async () => {
    const updatePlan = await api.checkForUpdates();
    if (!updatePlan.ok) {
      throw new Error(updatePlan.message || "检查更新失败。");
    }
    if (!updatePlan.updateAvailable) {
      showToast(updatePlan.message || "当前已经是最新版。");
      return;
    }
    const accepted = await showUpdateDialog(updatePlan);
    if (!accepted) {
      showToast("已取消更新。");
      return;
    }
    const installerUpdate = updatePlan.asset?.kind === "installer";
    setUpdateDialogBusy(true);
    renderUpdateProgress({
      phase: "checking",
      downloadedBytes: 0,
      totalBytes: updatePlan.asset?.size || 0,
      percent: 0,
    });
    showToast(
      installerUpdate
        ? "正在下载安装器，完成后会自动打开安装程序。"
        : "正在下载更新包，完成后会打开更新目录。",
    );
    try {
      const result = await api.installUpdate();
      renderUpdateProgress({
        phase: result.installerPath ? "launching" : "ready",
        downloadedBytes: updatePlan.asset?.size || 0,
        totalBytes: updatePlan.asset?.size || 0,
        percent: 100,
        message: result.nextStep || result.message,
      });
      setUpdateDialogBusy(false);
      showToast(result.nextStep || result.message || "更新包已下载，当前程序保持运行。");
    } catch (error) {
      setUpdateDialogBusy(false);
      renderUpdateProgress({
        phase: "error",
        message: error?.message || String(error),
      });
      throw error;
    }
  }),
);

document.querySelectorAll("[data-vvip-feature]").forEach((button) => {
  button.addEventListener("click", () => showVvipDialog(button.dataset.vvipFeature || button.textContent.trim()));
});

els.closeVvipDialog?.addEventListener("click", hideVvipDialog);
els.vvipDialog?.addEventListener("click", (event) => {
  if (event.target === els.vvipDialog) {
    hideVvipDialog();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.requestDetailDialog?.classList.contains("hidden")) {
    hideRequestDetail();
    return;
  }
  if (event.key === "Escape" && !els.vvipDialog?.classList.contains("hidden")) {
    hideVvipDialog();
  }
});

api.onLogs((logs) => renderLogs(logs));
api.onUpdateProgress?.((progress) => renderUpdateProgress(progress));
api.onUpdateFinished?.((result) => {
  showToast(result?.message || "CodexBridge 已更新完成。");
});
api.onNavigate?.((payload) => {
  activateSection(payload?.section || "dashboard");
});
api.onUsage((usage) => {
  if (!state) {
    return;
  }
  state = {
    ...state,
    usageEvents: usage.usageEvents || [],
    usageSummary: usage.usageSummary || emptyUsageSummary(),
  };
  renderUsage();
  renderOverviewUsage();
});
api.onState((nextState) => {
  state = nextState;
  draftSelection = [...(state.selectedModelIds || [])];
  render();
});

refresh();

async function refresh() {
  state = await api.getState();
  draftSelection = [...(state.selectedModelIds || [])];
  render();
}

function render() {
  if (!state) {
    return;
  }

  els.routerStatus.textContent = state.routerRunning ? "Router 运行中" : "Router 未启动";
  els.routerStatus.classList.toggle("muted", !state.routerRunning);
  els.modeStatus.textContent = state.mode === "hybrid" ? "混合模式" : "全部 API";
  els.modeStatus.classList.toggle("muted", false);
  els.appVersion.textContent = `v${state.appVersion || "-"}`;
  if (els.rootDir) {
    els.rootDir.textContent = state.rootDir;
  }
  els.selectedCount.textContent = String(draftSelection.length);
  const keySummary = keySummaryInfo();
  els.keySummary.textContent = keySummary.text;
  els.keySummaryDetail.textContent = keySummary.detail;
  els.bypassSystemProxy.checked = Boolean(state.desktopOptions?.bypassSystemProxy);
  if (document.activeElement !== els.routerPort) {
    els.routerPort.value = String(state.desktopOptions?.routerPort || 15722);
  }
  renderCodexDesktopPath();

  document.querySelectorAll(".mode-card").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  });

  renderRouterToggle();
  renderHealthStatus();
  renderStartupCheck();
  renderSelectedModels();
  renderModelPageView();
  renderProviderPreview();
  renderModelPool();
  renderProviderEditor();
  renderCustomEditor();
  renderCustomFormState();
  renderProfiles();
  renderBackups();
  renderResources();
  renderSessions();
  renderUsage();
  renderOverviewUsage();
  renderLogs(state.logs || []);
}

function renderCodexDesktopPath() {
  if (!els.codexDesktopPath) {
    return;
  }
  const launchPath = codexDesktopLaunchPath();
  els.codexDesktopPath.textContent = launchPath || "自动查找";
  els.codexDesktopPath.title = launchPath || "自动查找常见安装路径、开始菜单快捷方式和 CODEX_DESKTOP_EXE";
}

function codexDesktopLaunchPath() {
  return state.desktopOptions?.codexDesktopLaunchTarget || state.desktopOptions?.codexDesktopExe || "";
}

function renderHealthStatus() {
  const health = state.lastHealth;
  const isStarting = Boolean(health?.starting);
  els.healthStatus.classList.toggle("ok", Boolean(health?.ok));
  els.healthStatus.classList.toggle("bad", Boolean(health && !health.ok && !isStarting));
  els.healthStatus.classList.toggle("starting", isStarting);
  if (!health) {
    els.healthStatus.textContent = "Router 健康检查：尚未检查";
    return;
  }
  const checkedAt = health.checkedAt ? ` · ${formatTime(health.checkedAt)}` : "";
  if (isStarting) {
    els.healthStatus.textContent = `Router 正在启动，等待健康检查${checkedAt}`;
    return;
  }
  const unhealthyRoutes = Number(health.unhealthyRoutes || 0);
  const routeAttention = unhealthyRoutes > 0 ? `，${unhealthyRoutes} 条上游需关注` : "";
  els.healthStatus.textContent = health.ok
    ? `Router 健康检查通过：${health.models?.length || 0} 个模型已加载${routeAttention}${checkedAt}`
    : `Router 健康检查失败：${health.message || "未知错误"}${checkedAt}`;
}

function renderStartupCheck() {
  if (!(els.startupCheckSummary && els.startupCheckList)) {
    return;
  }
  const check = state.startupCheck;
  if (!check) {
    els.startupCheckSummary.innerHTML = `<div class="empty-state">暂无体检结果。</div>`;
    els.startupCheckList.innerHTML = "";
    return;
  }
  const summary = check.summary || {};
  els.startupCheckSummary.innerHTML = `
    <article class="check-summary-card ${summary.ok ? "pass" : "fail"}">
      <span>总状态</span>
      <strong>${summary.ok ? "可启动" : "需要处理"}</strong>
    </article>
    <article class="check-summary-card pass">
      <span>通过</span>
      <strong>${formatNumber(summary.pass)}</strong>
    </article>
    <article class="check-summary-card warn">
      <span>提醒</span>
      <strong>${formatNumber(summary.warn)}</strong>
    </article>
    <article class="check-summary-card fail">
      <span>失败</span>
      <strong>${formatNumber(summary.fail)}</strong>
    </article>
  `;
  const items = Array.isArray(check.items) ? check.items : [];
  els.startupCheckList.innerHTML = items.length
    ? items
        .map(
          (item) => `
            <article class="check-item ${escapeHtml(item.status || "warn")}">
              <div>
                <strong>${escapeHtml(item.label || item.id || "-")}</strong>
                <p>${escapeHtml(item.detail || "-")}</p>
                ${item.action ? `<small>${escapeHtml(item.action)}</small>` : ""}
              </div>
              <span>${checkStatusLabel(item.status)}</span>
            </article>
          `,
        )
        .join("")
    : `<div class="empty-state">暂无体检项目。</div>`;
}

function renderProfiles() {
  if (!els.profileList) {
    return;
  }
  const profiles = Array.isArray(state.configProfiles) ? state.configProfiles : [];
  if (!profiles.length) {
    els.profileList.innerHTML = `<div class="empty-state">还没有保存配置档。保存后可以在这里改名和快速切换。</div>`;
    return;
  }
  els.profileList.innerHTML = profiles
    .map(
      (profile) => `
        <article class="profile-item">
          <div class="profile-main">
            <input class="profile-name-input" value="${escapeHtml(profile.name)}" data-profile-name="${escapeHtml(profile.id)}" aria-label="配置档名称" />
            <p>
              <span title="${escapeHtml(profileModeHelp(profile.mode))}">${escapeHtml(profileModeLabel(profile.mode))}</span>
              · ${formatNumber(profile.selectedModelIds?.length || 0)} 个模型
              · ${formatTime(profile.updatedAt)}
            </p>
          </div>
          <div class="profile-actions">
            <button class="ghost-button light small" type="button" data-rename-profile="${escapeHtml(profile.id)}">保存名称</button>
            <button class="primary-button small" type="button" data-apply-profile="${escapeHtml(profile.id)}">应用</button>
          </div>
        </article>
      `,
    )
    .join("");
  els.profileList.querySelectorAll("[data-rename-profile]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const profile = profiles.find((item) => item.id === button.dataset.renameProfile);
        const input = els.profileList.querySelector(`[data-profile-name="${cssEscape(button.dataset.renameProfile)}"]`);
        const nextName = input?.value?.trim();
        if (!profile || !nextName) {
          showToast("配置档名称不能为空。", "error");
          return;
        }
        const response = await api.saveConfigProfile({ ...profile, name: nextName });
        state = response?.state || await api.getState();
        render();
        showToast("配置档名称已保存。");
      }),
    );
  });
  els.profileList.querySelectorAll("[data-apply-profile]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        state = await api.applyConfigProfile(button.dataset.applyProfile);
        draftSelection = [...(state.selectedModelIds || [])];
        render();
        showToast("配置档已应用。");
      }),
    );
  });
}

function profileModeLabel(mode) {
  if (mode === "hybrid") {
    return "混合模式";
  }
  if (mode === "all_api" || mode === "all-api") {
    return "全部 API 模式";
  }
  return "未知模式";
}

function profileModeHelp(mode) {
  if (mode === "hybrid") {
    return "混合模式：保留 Codex 原生 GPT 能力，同时把 API 模型加入同一个模型栏。";
  }
  if (mode === "all_api" || mode === "all-api") {
    return "全部 API 模式：模型栏完全由 CodexBridge API 路由接管。";
  }
  return "当前配置档保存时的运行模式。";
}

function renderBackups() {
  if (!els.backupList) {
    return;
  }
  const backups = Array.isArray(state.codexBackups) ? state.codexBackups : [];
  if (!backups.length) {
    els.backupList.innerHTML = `<div class="empty-state">暂未发现 CodexBridge 配置备份。</div>`;
    return;
  }
  els.backupList.innerHTML = `
    <div class="backup-list-head">
      <span>共 ${formatNumber(backups.length)} 个备份，按时间倒序显示</span>
    </div>
    ${backups
    .slice(0, 16)
    .map(
      (backup) => `
        <article class="compact-list-item">
          <div>
            <strong>${escapeHtml(backup.name)}</strong>
            <p>${escapeHtml(backupKindLabel(backup.kind))} · ${formatBytes(backup.size)} · ${formatTime(backup.updatedAt)}</p>
          </div>
          <button class="ghost-button light small" type="button" data-restore-backup="${escapeHtml(backup.fullPath)}">恢复</button>
        </article>
      `,
    )
    .join("")}
    ${backups.length > 16 ? `<div class="backup-list-foot">仅显示最近 16 个，完整备份仍保存在 Codex 配置目录。</div>` : ""}
  `;
  els.backupList.querySelectorAll("[data-restore-backup]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const accepted = await showConfirmDialog({
          title: "恢复 Codex 配置备份",
          message: "将用选中的备份覆盖当前 config.toml。当前配置会先自动备份，方便回退。",
          confirmText: "恢复备份",
        });
        if (!accepted) {
          return;
        }
        const response = await api.restoreCodexBackup(button.dataset.restoreBackup);
        state = response?.state || await api.getState();
        render();
        showToast("Codex 配置备份已恢复。");
      }),
    );
  });
}

function backupKindLabel(kind) {
  if (kind === "codexbridge") {
    return "写入前备份";
  }
  if (kind === "before_restore") {
    return "恢复前备份";
  }
  if (kind === "history_access") {
    return "历史修复备份";
  }
  return "配置备份";
}

function showConfirmDialog({ title, message, confirmText = "确认", cancelText = "取消" } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop runtime-confirm-backdrop";
    backdrop.innerHTML = `
      <div class="request-detail-dialog runtime-confirm-dialog" role="dialog" aria-modal="true">
        <header>
          <h2>${escapeHtml(title || "确认操作")}</h2>
        </header>
        <p>${escapeHtml(message || "")}</p>
        <div class="runtime-confirm-actions">
          <button class="ghost-button light" type="button" data-confirm-cancel>${escapeHtml(cancelText)}</button>
          <button class="primary-button" type="button" data-confirm-ok>${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;
    const close = (accepted) => {
      backdrop.remove();
      resolve(accepted);
    };
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        close(false);
      }
    });
    backdrop.querySelector("[data-confirm-cancel]")?.addEventListener("click", () => close(false));
    backdrop.querySelector("[data-confirm-ok]")?.addEventListener("click", () => close(true));
    document.body.appendChild(backdrop);
    backdrop.querySelector("[data-confirm-ok]")?.focus();
  });
}

function renderResources() {
  if (!(els.resourceSummary && els.resourceList)) {
    return;
  }
  const resources = state.codexResources || {};
  const summary = resources.summary || {};
  const discoveredSummary = resources.discoveredSummary || {};
  const discoveredTotal = Object.values(discoveredSummary).reduce((total, value) => total + Number(value || 0), 0);
  els.resourceSummary.innerHTML = `
    <article><span>插件</span><strong>${formatNumber(summary.plugins)}</strong></article>
    <article><span>MCP</span><strong>${formatNumber(summary.mcpServers)}</strong></article>
    <article><span>技能</span><strong>${formatNumber(summary.skills)}</strong></article>
    <article><span>提示词</span><strong>${formatNumber(summary.prompts)}</strong></article>
    <article><span>规则文件</span><strong>${formatNumber(summary.agentFiles)}</strong></article>
  `;
  const availableBlocks = [
    resourceBlock("MCP 服务", resources.mcpServers, resourceLabel, "mcpServers"),
    resourceBlock("插件", resources.plugins, resourceLabel, "plugins"),
    resourceBlock("技能", resources.skills, resourceLabel, "skills"),
    resourceBlock("提示词", resources.prompts, resourceLabel, "prompts"),
    resourceBlock("规则文件", resources.agentFiles, resourceLabel, "agentFiles"),
  ];
  const discovered = resources.discovered || {};
  const discoveredBlocks = [
    resourceBlock("未启用 MCP", discovered.mcpServers, resourceLabel, "discoveredMcpServers"),
    resourceBlock("未启用/缓存插件", discovered.plugins, resourceLabel, "discoveredPlugins"),
    resourceBlock("缓存技能", discovered.skills, resourceLabel, "discoveredSkills"),
  ].filter((block) => block);
  els.resourceList.innerHTML = `
    <div class="resource-section-title">当前可用</div>
    ${availableBlocks.join("")}
    ${discoveredTotal ? `
      <details class="resource-diagnostics">
        <summary>
          <strong>本地诊断</strong>
          <span>${formatNumber(discoveredTotal)} 项未启用、内置或缓存资源</span>
        </summary>
        <div class="resource-diagnostics-grid">
          ${discoveredBlocks.join("")}
        </div>
      </details>
    ` : ""}
  `;
  els.resourceList.querySelectorAll("[data-resource-expand]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.resourceExpand;
      if (!key) {
        return;
      }
      if (resourceExpandedKeys.has(key)) {
        resourceExpandedKeys.delete(key);
      } else {
        resourceExpandedKeys.add(key);
      }
      renderResources();
    });
  });
}

function renderSessions() {
  if (!els.sessionList) {
    return;
  }
  const sessions = Array.isArray(state.codexSessions) ? state.codexSessions : [];
  if (!sessions.length) {
    els.sessionList.innerHTML = `<div class="empty-state">未读取到本机 Codex 会话，可能是当前 Codex 版本未暴露本地会话库。</div>`;
    return;
  }
  const grouped = groupSessionsByProject(sessions);
  els.sessionList.innerHTML = `
    <div class="session-overview">
      <span>会话 ${formatNumber(sessions.length)} 个</span>
      <span>项目 ${formatNumber(grouped.projects.length)} 个</span>
    </div>
    <details class="session-folder" open>
      <summary>
        <strong>项目文件夹</strong>
        <span>${formatNumber(grouped.projects.length)} 个项目</span>
      </summary>
      <div class="session-projects">
        ${grouped.projects.length
          ? grouped.projects.map(sessionProjectBlock).join("")
          : `<div class="empty-state">没有识别到项目文件夹。</div>`}
      </div>
    </details>
    <details class="session-folder" open>
      <summary>
        <strong>无项目会话</strong>
        <span>${formatNumber(grouped.looseSessions.length)} 个会话</span>
      </summary>
      <div class="session-project-list">
        ${grouped.looseSessions.length
          ? grouped.looseSessions.map(sessionItem).join("")
          : `<div class="empty-state">没有无项目会话。</div>`}
      </div>
    </details>
  `;
  bindSessionExportButtons();
}

function bindSessionExportButtons() {
  els.sessionList.querySelectorAll("[data-export-session]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        const response = await api.exportSessionMarkdown(button.dataset.exportSession);
        showToast(`会话已导出到剪贴板：${formatNumber(response?.markdownLength || 0)} 字符。`);
      }),
    );
  });
}

function resourceBlock(title, items = [], labelFn = (item) => item?.name || "-", key = title) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length && key.startsWith("discovered")) {
    return "";
  }
  const expanded = resourceExpandedKeys.has(key);
  const visible = expanded ? list : list.slice(0, 10);
  const rows = list.length
    ? visible
        .map((item) => `<li>${escapeHtml(labelFn(item))}</li>`)
        .join("")
    : `<li class="muted">暂无</li>`;
  return `
    <article class="resource-block ${expanded ? "expanded" : ""}">
      <header>
        <strong>${escapeHtml(title)}</strong>
        <span>${formatNumber(list.length)}</span>
      </header>
      <ul>${rows}</ul>
      ${list.length > 10 ? `
        <button class="resource-more-button" type="button" data-resource-expand="${escapeHtml(key)}">
          ${expanded ? "收起" : `展开全部（还有 ${formatNumber(list.length - visible.length)} 项）`}
        </button>
      ` : ""}
    </article>
  `;
}

function resourceLabel(item = {}) {
  const name = item.name || item.id || item.path || item.command || "-";
  const source = item.source || item.pluginSource || "";
  const version = item.version ? ` · v${item.version}` : "";
  const plugin = item.pluginId ? ` · ${item.pluginId}` : "";
  const availability = resourceAvailabilityLabel(item.availability);
  const suffix = `${plugin}${version}${availability ? ` · ${availability}` : ""}`;
  return source ? `${name} · ${resourceSourceLabel(source)}${suffix}` : `${name}${suffix}`;
}

function resourceSourceLabel(source) {
  if (source === "config") {
    return "Codex 配置";
  }
  if (source === "codex") {
    return "本机配置目录";
  }
  if (source === "agents") {
    return "Agents 配置目录";
  }
  if (source === "plugin") {
    return "插件内置";
  }
  if (source === "project") {
    return "当前项目目录";
  }
  if (source === "cache") {
    return "Codex 本地安装";
  }
  return source;
}

function resourceAvailabilityLabel(availability) {
  if (availability === "disabled") {
    return "未启用";
  }
  if (availability === "internal") {
    return "内置运行能力";
  }
  if (availability === "local") {
    return "本地目录";
  }
  if (availability === "plugin") {
    return "插件内置";
  }
  if (availability === "cached") {
    return "缓存，未启用";
  }
  return "";
}

function groupSessionsByProject(sessions = []) {
  const projects = new Map();
  const looseSessions = [];
  for (const session of sessions) {
    const key = sessionProjectKey(session);
    if (!key) {
      looseSessions.push(session);
      continue;
    }
    if (!projects.has(key)) {
      projects.set(key, {
        key,
        name: sessionProjectLabel(session),
        path: cleanProjectPath(session.projectPath || ""),
        sessions: [],
      });
    }
    projects.get(key).sessions.push(session);
  }
  return {
    projects: [...projects.values()].sort((left, right) => left.name.localeCompare(right.name)),
    looseSessions,
  };
}

function sessionProjectBlock(project) {
  return `
    <details class="session-project" data-session-project="${escapeHtml(project.key)}">
      <summary class="session-project-toggle">
        <div>
          <strong>${escapeHtml(project.name)}</strong>
          ${project.path ? `<small>${escapeHtml(project.path)}</small>` : ""}
        </div>
        <span>${formatNumber(project.sessions.length)} 个会话</span>
      </summary>
      <div class="session-project-list">
        ${project.sessions.map(sessionItem).join("")}
      </div>
    </details>
  `;
}

function sessionItem(session) {
  return `
    <article class="session-item">
      <div>
        <strong>${escapeHtml(session.title || session.firstUserMessage || session.id)}</strong>
        <p>
          ${escapeHtml(session.model || session.modelProvider || "-")}
          · ${escapeHtml(session.source || session.threadSource || "-")}
        </p>
        ${session.projectPath
          ? `<small>${escapeHtml(cleanProjectPath(session.projectPath))}</small>`
          : session.workspacePath
            ? `<small>${escapeHtml(cleanProjectPath(session.workspacePath))}</small>`
            : ""}
        <small>${escapeHtml(shortText(session.firstUserMessage || session.id, 140))}</small>
      </div>
      <button class="ghost-button light small" type="button" data-export-session="${escapeHtml(session.id)}">导出 Markdown</button>
    </article>
  `;
}

function sessionProjectKey(session = {}) {
  const projectPath = cleanProjectPath(session.projectPath || "");
  const project = String(session.project || "").trim();
  if (projectPath) {
    return `path:${canonicalProjectPathKey(projectPath)}`;
  }
  if (project) {
    return `name:${project.toLowerCase()}`;
  }
  return "";
}

function sessionProjectLabel(session = {}) {
  if (session.project) {
    return session.project;
  }
  if (session.projectPath) {
    const clean = cleanProjectPath(session.projectPath);
    return clean.split(/[\\/]/).filter(Boolean).pop() || clean;
  }
  return "未识别项目";
}

function cleanProjectPath(projectPath = "") {
  return String(projectPath || "").replace(/^\\\\\?\\/, "").trim();
}

function canonicalProjectPathKey(projectPath = "") {
  return cleanProjectPath(projectPath)
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function checkStatusLabel(status) {
  if (status === "pass") {
    return "通过";
  }
  if (status === "fail") {
    return "失败";
  }
  return "提醒";
}

function renderRouterToggle() {
  els.routerToggle.classList.toggle("running", Boolean(state.routerRunning));
  els.routerToggle.setAttribute("aria-pressed", state.routerRunning ? "true" : "false");
  els.routerToggle.querySelector("strong").textContent = state.routerRunning ? "Router 运行中" : "Router 已关闭";
  els.routerToggle.querySelector("small").textContent = state.routerRunning ? "点击关闭本地网关" : "点击启动本地网关";
}

function renderModelPageView() {
  const catalog = document.querySelector(".model-catalog-panel");
  const providerPanel = document.querySelector(".provider-editor-panel");
  const customPanel = document.querySelector(".custom-editor-panel");
  catalog?.classList.toggle("hidden", modelPageView !== "catalog");
  providerPanel?.classList.toggle("hidden", modelPageView !== "provider");
  customPanel?.classList.toggle("hidden", modelPageView !== "custom");
}

function openProviderEditor(providerId) {
  editingProviderId = providerId;
  modelPageView = "provider";
  render();
  document.querySelector(".provider-editor-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function openProviderCustomModelEditor(providerId) {
  const provider = providerFor(providerId);
  if (!provider) {
    showToast("没有找到这个供应商。", "error");
    return;
  }
  editingProviderId = provider.id;
  activeProviderId = provider.id;
  openCustomEditor(null, { returnView: "provider", providerId: provider.id });
}

function openCustomEditor(presetId = null, options = {}) {
  modelPageView = "custom";
  customReturnView = options.returnView || (modelPageView === "provider" ? "provider" : "catalog");
  scopedCustomProviderId = options.providerId || null;
  if (!scopedCustomProviderId && options.returnView !== "provider") {
    editingProviderId = null;
  }
  if (presetId) {
    startCustomModelEdit(presetId, { preserveView: true, scroll: false });
  } else {
    resetCustomModelForm({ preserveView: true });
  }
  render();
  document.querySelector(".custom-editor-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function openModelCatalog() {
  modelPageView = "catalog";
  editingProviderId = null;
  customReturnView = "catalog";
  scopedCustomProviderId = null;
  render();
  document.querySelector(".model-catalog-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function returnFromCustomEditor() {
  if (customReturnView === "provider" && editingProviderId) {
    modelPageView = "provider";
    scopedCustomProviderId = null;
    render();
    document.querySelector(".provider-editor-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  openModelCatalog();
}

function providerSecretKey(provider = {}) {
  return provider?.keyEnv || provider?.apiKeyEnv || "";
}

function providerRequiresApiKey(provider = {}) {
  return (provider?.authMode || "api_key") === "api_key" && Boolean(providerSecretKey(provider));
}

function providerHasSavedApiKey(provider = {}) {
  if (!providerRequiresApiKey(provider)) {
    return true;
  }
  const keyEnv = providerSecretKey(provider);
  return Boolean(keyEnv && state.secretStatus?.[keyEnv]);
}

function providerCanRefreshModels(provider = {}) {
  return Boolean(provider?.baseUrl) && provider?.authMode !== "codex_openai" && providerHasSavedApiKey(provider);
}

function renderProviders() {
  const cards = state.providers.map((provider) => {
    const saved = provider.keyEnv ? Boolean(state.secretStatus?.[provider.keyEnv]) : true;
    const status = provider.keyEnv ? (saved ? "已保存" : "未保存") : "无需 Key";
    const directoryInfo = providerModelDirectoryInfo(provider.id);
    const keyControl = provider.keyEnv
      ? `
        <label>
          <span>${escapeHtml(provider.keyLabel || "API Key")}</span>
          <div class="secret-row">
            <input type="password" data-key-env="${escapeHtml(provider.keyEnv)}" placeholder="${saved ? "已保存，点查看可查看或修改" : "sk-..."}" />
            <button class="ghost-button light small" type="button" data-toggle-secret data-saved="${saved ? "true" : "false"}">${saved ? "查看" : "显示"}</button>
          </div>
        </label>
      `
      : `<div class="no-key">使用 Codex/OpenAI 登录态，无需在这里填写 API Key。</div>`;
    const saveButton = provider.keyEnv
      ? `<button class="primary-button small" data-save-provider="${escapeHtml(provider.id)}">保存这个 Key</button>`
      : "";
    const keyButton = provider.keyUrl
      ? `<button class="plain-button small" data-open-url="${escapeHtml(provider.keyUrl)}">获取 API Key</button>`
      : "";
    const refreshButton = providerCanRefreshModels(provider)
      ? `<button class="ghost-button light small" data-refresh-provider-models="${escapeHtml(provider.id)}">刷新模型</button>`
      : "";
    return `
      <article class="provider-card" data-provider-id="${escapeHtml(provider.id)}">
        <div class="provider-head">
          <div>
            <h3>${escapeHtml(provider.name)}</h3>
            <p>${escapeHtml(provider.description || "")}</p>
          </div>
          <span class="tag ${saved ? "ok" : ""}">${status}</span>
        </div>
        <p class="provider-model-directory">${escapeHtml(directoryInfo)}</p>
        ${keyControl}
        <div class="provider-actions">
          ${saveButton}
          ${keyButton}
          ${refreshButton}
          ${provider.docsUrl ? `<button class="ghost-button light small" data-open-url="${escapeHtml(provider.docsUrl)}">文档</button>` : ""}
        </div>
      </article>
    `;
  });
  els.providerGrid.innerHTML = cards.join("");

  els.providerGrid.querySelectorAll("[data-open-url]").forEach((button) => {
    button.addEventListener("click", () => api.openExternal(button.dataset.openUrl));
  });
  els.providerGrid.querySelectorAll("[data-toggle-secret]").forEach((button) => {
    button.addEventListener("click", () => runAction(button, async () => {
      const input = button.closest(".secret-row").querySelector("input");
      const showing = input.type === "text";
      if (showing) {
        input.type = "password";
        button.textContent = button.dataset.saved === "true" && !input.value ? "查看" : "显示";
        return;
      }
      if (button.dataset.saved === "true" && !input.value) {
        input.value = await api.getSecret(input.dataset.keyEnv);
      }
      input.type = "text";
      button.textContent = "隐藏";
    }));
  });
  els.providerGrid.querySelectorAll("[data-save-provider]").forEach((button) => {
    button.addEventListener("click", () => saveProviderSecret(button));
  });
  bindProviderRefreshButtons(els.providerGrid);
}

function bindProviderRefreshButtons(root) {
  if (!root) {
    return;
  }
  root.querySelectorAll("[data-refresh-provider-models]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      runAction(button, async () => {
        await saveProviderSettingsBeforeRemoteAction(button);
        const response = await api.refreshProviderModels(button.dataset.refreshProviderModels);
        state = response?.state || await api.getState();
        draftSelection = [...state.selectedModelIds];
        render();
        const result = response?.result || {};
        showToast(
          result.ok
            ? `模型列表已刷新：${result.count || 0} 个`
            : `模型列表刷新失败：${result.error || "unknown error"}`,
          result.ok ? "success" : "error",
        );
      });
    });
  });
}

async function saveProviderSettingsBeforeRemoteAction(button) {
  const card = button.closest(".provider-editor-card");
  const apiKey = card?.querySelector("[data-key-env]")?.value.trim();
  if (!card || !apiKey) {
    return null;
  }
  return saveProviderSettingsFromCard(card);
}

function renderProviderEditor() {
  const panel = document.querySelector(".provider-editor-panel");
  if (!panel || !els.providerGrid) {
    return;
  }
  if (modelPageView !== "provider") {
    els.providerGrid.innerHTML = "";
    return;
  }
  const provider = providerFor(editingProviderId || activeProviderId) || state.providers?.[0];
  if (!provider) {
    els.providerGrid.innerHTML = `<div class="empty-state">没有可编辑的供应商。</div>`;
    return;
  }
  const models = (state.modelPresets || []).filter((model) => model.providerId === provider.id);
  const apiValue = providerApiValue(provider, models);
  const keyEnv = providerSecretKey(provider);
  const saved = keyEnv ? Boolean(state.secretStatus?.[keyEnv]) : true;
  const status = keyEnv ? (saved ? "已保存" : "未保存") : "无需 Key";
  const needsKey = providerRequiresApiKey(provider);
  const remoteDisabledAttrs = needsKey && !saved
    ? `disabled data-provider-refresh-disabled="true" title="先填写并保存 API Key 后再使用"`
    : `data-provider-refresh-disabled="false"`;
  const keyControl = keyEnv
    ? `
      <label class="provider-secret-field">
        <span>${escapeHtml(provider.keyLabel || "API Key")}</span>
        <div class="secret-row">
          <input type="password" data-key-env="${escapeHtml(keyEnv)}" placeholder="${saved ? "已保存，点击查看可查看或修改" : "sk-..."}" />
          <button class="ghost-button light small" type="button" data-toggle-secret data-saved="${saved ? "true" : "false"}">${saved ? "查看" : "显示"}</button>
        </div>
      </label>
    `
    : `<div class="no-key">使用 Codex/OpenAI 登录态，不需要在这里填写 API Key。</div>`;
  const saveButton = provider.keyEnv
    ? `<button class="primary-button small" type="button" data-save-provider-settings="${escapeHtml(provider.id)}">保存设置</button>`
    : `<button class="primary-button small" type="button" data-save-provider-settings="${escapeHtml(provider.id)}">保存设置</button>`;
  const testButton = provider.baseUrl && provider.authMode !== "codex_openai"
    ? `<button class="ghost-button light small" type="button" data-test-provider-connection="${escapeHtml(provider.id)}" ${remoteDisabledAttrs}>测试连接</button>`
    : "";
  const keyButton = provider.keyUrl
    ? `<button class="plain-button small" type="button" data-open-url="${escapeHtml(provider.keyUrl)}">获取 Key</button>`
    : "";
  const refreshButton = provider.baseUrl && provider.authMode !== "codex_openai"
    ? `<button class="ghost-button light small" type="button" data-refresh-provider-models="${escapeHtml(provider.id)}" ${remoteDisabledAttrs}>同步模型列表</button>`
    : "";

  els.providerGrid.innerHTML = `
    <div class="editor-page-head">
      <button class="ghost-button light small" type="button" data-back-model-catalog>返回模型列表</button>
    </div>
    <article class="provider-card provider-editor-card" data-provider-id="${escapeHtml(provider.id)}">
      <div class="provider-head">
        <div class="provider-title">
          <button class="provider-logo-button" type="button" data-provider-logo-upload="${escapeHtml(provider.id)}" title="点击上传本地图标">
            ${providerLogo(provider)}
          </button>
          <div>
            <h3>${escapeHtml(provider.name)}</h3>
            <p>${escapeHtml(provider.description || "")}</p>
          </div>
        </div>
        <span class="tag ${saved ? "ok" : ""}">${status}</span>
      </div>
      <div class="provider-settings-grid" data-provider-settings data-provider-id="${escapeHtml(provider.id)}" data-provider-key-env="${escapeHtml(provider.keyEnv || "")}" data-provider-auth-mode="${escapeHtml(provider.authMode || "api_key")}" data-provider-custom="${provider.custom ? "true" : "false"}">
        <label>
          <span>供应商名称</span>
          <input data-provider-name value="${escapeHtml(provider.name || "")}" placeholder="例如 DeepSeek" />
        </label>
        <label>
          <span>显示短名</span>
          <input data-provider-short-name value="${escapeHtml(provider.shortName || provider.name || provider.id)}" placeholder="例如 DeepSeek" />
        </label>
        <label class="wide-field">
          <span>Base URL</span>
          <input data-provider-base-url value="${escapeHtml(provider.baseUrl || "")}" placeholder="https://api.example.com/v1" />
        </label>
        <label>
          <span>接口类型</span>
          <select data-provider-api>
            <option value="chat_completions" ${apiValue === "chat_completions" ? "selected" : ""}>Chat Completions</option>
            <option value="responses" ${apiValue === "responses" ? "selected" : ""}>Responses</option>
          </select>
        </label>
        <label>
          <span>获取 Key 链接</span>
          <input data-provider-key-url value="${escapeHtml(provider.keyUrl || "")}" placeholder="https://example.com/keys" />
        </label>
        <label>
          <span>官网 / 文档</span>
          <input data-provider-docs-url value="${escapeHtml(provider.docsUrl || "")}" placeholder="https://example.com/docs" />
        </label>
      </div>
      ${keyControl}
      <div class="provider-actions">
        ${saveButton}
        ${testButton}
        ${keyButton}
        ${provider.docsUrl ? `<button class="ghost-button light small" type="button" data-open-url="${escapeHtml(provider.docsUrl)}">文档</button>` : ""}
      </div>
      <div class="provider-model-list">
        <div class="provider-model-list-head">
          <div>
            <strong>模型列表</strong>
            <span>${models.length} 个模型</span>
          </div>
          <div class="provider-model-list-actions">
            ${refreshButton}
            <button class="ghost-button light small" type="button" data-open-provider-custom-model="${escapeHtml(provider.id)}">添加自定义模型</button>
          </div>
        </div>
        ${providerModelEditorRows(models)}
      </div>
    </article>
  `;
  bindProviderEditorActions(els.providerGrid);
}

function providerDetailValue(label, value) {
  return `
    <div class="provider-detail-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "-")}</strong>
    </div>
  `;
}

function providerApiValue(provider, models = []) {
  if (provider?.api === "responses" || provider?.api === "chat_completions") {
    return provider.api;
  }
  const firstModel = models.find((model) => model.api === "responses" || model.api === "chat_completions");
  return firstModel?.api || "chat_completions";
}

function providerModelEditorRows(models) {
  if (!models.length) {
    return `<div class="empty-state">这个供应商还没有模型。可以同步模型列表，或从自定义页面手动添加。</div>`;
  }
  return models.map((model) => providerModelEditorRow(model)).join("");
}

function providerModelEditorRow(model) {
  return `
    <div class="provider-model-row">
      <div class="provider-model-main">
        <strong>${escapeHtml(model.displayName)}</strong>
        <span>${escapeHtml(model.model)} · ${escapeHtml(model.api || "-")} · ${escapeHtml(modelFriendlySummary(model))}</span>
      </div>
      <div class="provider-model-controls">
        ${modelConfigControls(model, modelSupportsImage(model))}
      </div>
    </div>
  `;
}

function bindProviderEditorActions(root) {
  root.querySelectorAll("[data-back-model-catalog]").forEach((button) => {
    button.addEventListener("click", openModelCatalog);
  });
  root.querySelectorAll("[data-open-custom-editor]").forEach((button) => {
    button.addEventListener("click", () => openCustomEditor());
  });
  root.querySelectorAll("[data-open-provider-custom-model]").forEach((button) => {
    button.addEventListener("click", () => openProviderCustomModelEditor(button.dataset.openProviderCustomModel));
  });
  root.querySelectorAll("[data-provider-logo-upload]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      runAction(button, async () => {
        const providerId = button.dataset.providerLogoUpload;
        const response = await api.selectLocalLogo({ providerId, ownerId: providerId, applyToProvider: true });
        if (response?.canceled) {
          return;
        }
        state = response?.state || await api.getState();
        draftSelection = [...state.selectedModelIds];
        render();
        showToast("供应商图标已更新。");
      });
    });
  });
  root.querySelectorAll("[data-open-url]").forEach((button) => {
    button.addEventListener("click", () => api.openExternal(button.dataset.openUrl));
  });
  root.querySelectorAll("[data-toggle-secret]").forEach((button) => {
    button.addEventListener("click", () => runAction(button, async () => {
      const input = button.closest(".secret-row").querySelector("input");
      const showing = input.type === "text";
      if (showing) {
        input.type = "password";
        button.textContent = button.dataset.saved === "true" && !input.value ? "查看" : "显示";
        return;
      }
      if (button.dataset.saved === "true" && !input.value) {
        input.value = await api.getSecret(input.dataset.keyEnv);
      }
      input.type = "text";
      button.textContent = "隐藏";
    }));
  });
  root.querySelectorAll("[data-save-provider]").forEach((button) => {
    button.addEventListener("click", () => saveProviderSecret(button));
  });
  root.querySelectorAll("[data-save-provider-settings]").forEach((button) => {
    button.addEventListener("click", () => saveProviderSettings(button));
  });
  root.querySelectorAll("[data-key-env]").forEach((input) => {
    input.addEventListener("input", () => updateProviderRemoteActionState(input.closest(".provider-editor-card")));
  });
  root.querySelectorAll("[data-test-provider-connection]").forEach((button) => {
    button.addEventListener("click", () => testProviderConnection(button));
  });
  root.querySelectorAll(".provider-editor-card").forEach((card) => updateProviderRemoteActionState(card));
  bindProviderRefreshButtons(root);
  bindModelConfigControls(root);
}

function updateProviderRemoteActionState(card) {
  if (!card) {
    return;
  }
  const provider = providerFor(card.dataset.providerId);
  const typedKey = card.querySelector("[data-key-env]")?.value.trim() || "";
  const disabled = providerRequiresApiKey(provider) && !providerHasSavedApiKey(provider) && !typedKey;
  const hint = "先填写并保存 API Key 后再使用";
  card.querySelectorAll("[data-test-provider-connection], [data-refresh-provider-models]").forEach((button) => {
    button.disabled = disabled;
    button.dataset.providerRefreshDisabled = disabled ? "true" : "false";
    if (disabled) {
      button.title = hint;
    } else if (button.title === hint) {
      button.removeAttribute("title");
    }
  });
}

function providerSettingsPayload(card) {
  const settings = card?.querySelector("[data-provider-settings]");
  const provider = providerFor(settings?.dataset.providerId || card?.dataset.providerId);
  const apiKey = card?.querySelector("[data-key-env]")?.value.trim() || "";
  return {
    providerId: provider?.id || settings?.dataset.providerId || "",
    id: provider?.id || settings?.dataset.providerId || "",
    name: settings?.querySelector("[data-provider-name]")?.value.trim() || provider?.name || "",
    shortName: settings?.querySelector("[data-provider-short-name]")?.value.trim() || provider?.shortName || "",
    baseUrl: settings?.querySelector("[data-provider-base-url]")?.value.trim() || "",
    api: settings?.querySelector("[data-provider-api]")?.value || providerApiValue(provider),
    keyUrl: settings?.querySelector("[data-provider-key-url]")?.value.trim() || "",
    docsUrl: settings?.querySelector("[data-provider-docs-url]")?.value.trim() || "",
    keyEnv: settings?.dataset.providerKeyEnv || provider?.keyEnv || "",
    authMode: settings?.dataset.providerAuthMode || provider?.authMode || "api_key",
    custom: settings?.dataset.providerCustom === "true",
    apiKey,
  };
}

function saveProviderSettings(button) {
  return runAction(button, async () => {
    const card = button.closest(".provider-editor-card");
    await saveProviderSettingsFromCard(card);
    render();
    showToast("供应商设置已保存，相关模型会使用新的 Base URL 和接口类型。");
  });
}

async function saveProviderSettingsFromCard(card) {
  const response = await api.saveProvider(providerSettingsPayload(card));
  state = response?.state || await api.getState();
  draftSelection = [...state.selectedModelIds];
  return response;
}

function testProviderConnection(button) {
  return runAction(button, async () => {
    const card = button.closest(".provider-editor-card");
    const result = await api.testProviderConnection(providerSettingsPayload(card));
    showToast(
      result.ok
        ? `连接测试通过：HTTP ${result.status || 200}`
        : `连接测试失败：${result.error || result.message || "unknown error"}`,
      result.ok ? "success" : "error",
    );
  });
}

function renderCustomEditor() {
  const panel = document.querySelector(".custom-editor-panel");
  if (!panel) {
    return;
  }
  if (!panel.querySelector(".custom-editor-toolbar")) {
    panel.insertAdjacentHTML(
      "afterbegin",
      `
        <div class="custom-editor-toolbar">
          <button class="ghost-button light small" type="button" data-back-model-catalog>返回模型列表</button>
        </div>
      `,
    );
  }
  panel.querySelectorAll("[data-back-model-catalog]").forEach((button) => {
    button.onclick = returnFromCustomEditor;
  });
}

function saveProviderSecret(button) {
  return runAction(button, async () => {
    const card = button.closest(".provider-card");
    const input = card?.querySelector("[data-key-env]");
    if (!input) {
      throw new Error("没有找到这个供应商的 API Key 输入框。");
    }
    if (!input?.value.trim()) {
      throw new Error("请输入新的 API Key。空输入不会覆盖旧密钥。");
    }
    await api.saveSecrets({ [input.dataset.keyEnv]: input.value.trim() });
    input.value = "";
    await refresh();
    showToast("这个 API Key 已保存到本机，可随时点查看后修改。");
  });
}

function renderSelectedModels() {
  const modelsById = modelMap();
  if (!draftSelection.length) {
    els.selectedModels.innerHTML = `
      <div class="slot-card empty">
        <span>未选择模型</span>
        <strong>至少选择一个模型</strong>
        <small>从下方模型卡片加入，保存后写入 CodexBridge 模型目录。</small>
      </div>
    `;
    return;
  }

  els.selectedModels.innerHTML = draftSelection
    .map((presetId, index) => {
      const model = modelsById.get(presetId);
      return `
        <div class="slot-card ${model ? "filled" : "missing"}" draggable="true" data-slot-index="${index}">
          <span>第 ${index + 1} 个模型</span>
          <strong>${model ? escapeHtml(model.displayName) : "模型不可用"}</strong>
          <small>${model ? `${escapeHtml(model.model)} · ${escapeHtml(providerName(model.providerId))}` : escapeHtml(presetId)}</small>
        </div>
      `;
    })
    .join("");

  els.selectedModels.querySelectorAll(".slot-card").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      dragSlotIndex = Number(card.dataset.slotIndex);
      event.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => {
      dragSlotIndex = null;
      card.classList.remove("dragging");
      els.selectedModels.querySelectorAll(".slot-card").forEach((item) => item.classList.remove("drop-target"));
    });
    card.addEventListener("dragover", (event) => {
      if (dragSlotIndex === null) {
        return;
      }
      event.preventDefault();
      card.classList.add("drop-target");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      const targetIndex = Number(card.dataset.slotIndex);
      reorderDraftSelection(dragSlotIndex, targetIndex);
      dragSlotIndex = null;
      render();
      showToast("顺序已调整，点“保存选择”后写入 CodexBridge 模型目录。");
    });
  });
}

function reorderDraftSelection(fromIndex, targetSlotIndex) {
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= draftSelection.length) {
    return;
  }
  const next = [...draftSelection];
  const [moved] = next.splice(fromIndex, 1);
  const insertIndex = Math.max(0, Math.min(targetSlotIndex, next.length));
  next.splice(insertIndex, 0, moved);
  draftSelection = next;
}

function renderProviderPreview() {
  if (!els.providerPreview || !state) {
    return;
  }
  const grouped = groupByProvider(state.modelPresets || []);
  const providerIds = grouped.map(([providerId]) => providerId);
  if (!activeProviderId || (!providerIds.includes(activeProviderId) && activeProviderId !== "__custom__")) {
    activeProviderId = providerIds[0] || "__custom__";
  }
  const customCount = (state.modelPresets || []).filter((model) => model.custom).length;
  const tiles = [
    `
      <button class="provider-preview-card ${activeProviderId === "__custom__" ? "active" : ""}" type="button" data-provider-preview="__custom__" data-open-custom-editor>
        ${providerLogo({ id: "__custom__", name: "Custom" })}
        <strong>自定义</strong>
        <small>${customCount ? `${customCount} 个模型` : "添加模型"}</small>
      </button>
    `,
    ...grouped.map(([providerId, models]) => {
      const provider = providerFor(providerId);
      return `
        <button class="provider-preview-card ${activeProviderId === providerId ? "active" : ""}" type="button" data-provider-preview="${escapeHtml(providerId)}">
          ${providerLogo(provider)}
          <strong>${escapeHtml(provider?.shortName || provider?.name || providerId)}</strong>
          <small>${models.length} 个模型</small>
        </button>
      `;
    }),
  ];
  els.providerPreview.innerHTML = tiles.join("");
  els.providerPreview.querySelectorAll("[data-provider-preview]").forEach((button) => {
    button.addEventListener("click", () => {
      activeProviderId = button.dataset.providerPreview;
      if (activeProviderId === "__custom__") {
        openCustomEditor();
        return;
      }
      renderProviderPreview();
      renderModelPool();
    });
  });
}

function providerLogo(provider = {}) {
  if (provider?.id === "__custom__") {
    return `<span class="provider-logo provider-logo-add" title="添加自定义模型" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M15 7h2v8h8v2h-8v8h-2v-8H7v-2h8z"/></svg></span>`;
  }
  const customLogo = String(provider?.logoUrl || "").trim();
  if (customLogo) {
    const label = provider?.shortName || provider?.name || provider?.id || "Provider";
    return `<span class="provider-logo provider-logo-custom-url" title="${escapeHtml(label)}"><img src="${escapeHtml(customLogo)}" alt="${escapeHtml(label)} logo" loading="lazy"></span>`;
  }
  const key = providerLogoKey(provider);
  const label = provider?.shortName || provider?.name || provider?.id || "Provider";
  const file = PROVIDER_LOGO_FILES[key] || PROVIDER_LOGO_FILES.default;
  if (file) {
    return `<span class="provider-logo provider-logo-${escapeHtml(key)}" title="${escapeHtml(label)}"><img src="./assets/providers/${escapeHtml(file)}" alt="${escapeHtml(label)} logo" loading="lazy"></span>`;
  }
  return `<span class="provider-logo provider-logo-custom" title="${escapeHtml(label)}" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M15 7h2v8h8v2h-8v8h-2v-8H7v-2h8z"/></svg></span>`;
}

function providerLogoKey(provider = {}) {
  const text = [provider.id, provider.shortName, provider.name].filter(Boolean).join(" ").toLowerCase() || "default";
  if (text === "__custom__" || text.includes("custom")) return "custom";
  if (text.includes("codex") || text === "gpt") return "codex";
  if (text.includes("openai")) return "openai";
  if (text.includes("deepseek")) return "deepseek";
  if (text.includes("kimi") || text.includes("moonshot")) return "kimi";
  if (text.includes("xiaomi") || text.includes("mimo")) return "mimo";
  if (text.includes("minimax")) return "minimax";
  if (text.includes("step")) return "stepfun";
  if (text.includes("qianfan") || text.includes("baidu")) return "qianfan";
  if (text.includes("hunyuan") || text.includes("tencent")) return "hunyuan";
  if (text.includes("doubao") || text.includes("volc")) return "doubao";
  if (text.includes("qwen") || text.includes("dashscope") || text.includes("aliyun")) return "qwen";
  if (text.includes("glm") || text.includes("zhipu")) return "glm";
  if (text.includes("openrouter")) return "openrouter";
  if (text.includes("silicon")) return "siliconflow";
  return "default";
}

const PROVIDER_LOGO_FILES = {
  codex: "openai.svg",
  openai: "openai.svg",
  deepseek: "deepseek.svg",
  kimi: "kimi.svg",
  mimo: "mimo.svg",
  minimax: "minimax.svg",
  stepfun: "stepfun.svg",
  qianfan: "qianfan.svg",
  hunyuan: "hunyuan.svg",
  doubao: "doubao.svg",
  qwen: "qwen.svg",
  glm: "glm.svg",
  openrouter: "openrouter.svg",
  siliconflow: "siliconflow.svg",
  custom: "default.svg",
  default: "default.svg",
};

function renderModelPool() {
  const selected = new Set(draftSelection);
  renderModelCardGroups(els.modelPool, selected, false);
  bindModelSelection(els.modelPool);
}

function renderModelConfigPool() {
  if (els.modelConfigPool) {
    els.modelConfigPool.innerHTML = "";
  }
}

function renderModelCardGroups(target, selected, includeControls) {
  if (!target) {
    return;
  }
  const visibleModels = activeProviderId === "__custom__"
    ? (state.modelPresets || []).filter((model) => model.custom)
    : activeProviderId
      ? (state.modelPresets || []).filter((model) => model.providerId === activeProviderId)
      : (state.modelPresets || []);
  const grouped = groupByProvider(visibleModels);
  target.innerHTML = grouped
    .map(([providerId, models]) => {
      const provider = providerFor(providerId);
      const refreshButton = providerCanRefreshModels(provider)
        ? `<button class="ghost-button light small" type="button" data-refresh-provider-models="${escapeHtml(provider.id)}">刷新模型列表</button>`
        : "";
      return `
        <section class="model-group">
          <div class="model-group-title">
            <div>
              <h3>${escapeHtml(provider?.name || providerId)}</h3>
              <span>${models.length} 个模型</span>
            </div>
            <div class="model-group-actions">
              ${refreshButton}
              <button class="ghost-button light small" type="button" data-provider-edit="${escapeHtml(providerId)}">编辑</button>
            </div>
          </div>
          <div class="model-card-grid">
            ${models.map((model) => modelCard(model, selected, includeControls)).join("")}
          </div>
        </section>
      `;
    })
    .join("");
  if (!grouped.length) {
    target.innerHTML = `<div class="empty-state">请选择一个供应商，或进入自定义模型页面添加模型。</div>`;
  }
  bindProviderRefreshButtons(target);
  target.querySelectorAll("[data-provider-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      activeProviderId = button.dataset.providerEdit;
      openProviderEditor(button.dataset.providerEdit);
    });
  });
}

function bindModelSelection(target) {
  target.querySelectorAll("[data-model-id]").forEach((button) => {
    button.addEventListener("click", () => toggleModel(button.dataset.modelId));
  });
}

function bindModelConfigControls(target) {
  if (!target) {
    return;
  }
  target.querySelectorAll("[data-image-input-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      runAction(button, async () => {
        const model = modelMap().get(button.dataset.imageInputToggle);
        const next = !modelSupportsImage(model);
        state = await api.saveModelImageInput({
          presetId: button.dataset.imageInputToggle,
          imageInput: next,
        });
        draftSelection = [...state.selectedModelIds];
        render();
        showToast(next ? "图片上传已开启。" : "图片上传已关闭。");
      });
    });
  });
  target.querySelectorAll("[data-image-gen-mode]").forEach((select) => {
    select.addEventListener("click", (event) => event.stopPropagation());
    select.addEventListener("change", () => {
      renderImageGenerationPanelMode(select.closest("[data-image-gen-config]"));
    });
  });
  target.querySelectorAll("[data-image-gen-save]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      saveImageGenerationSettings(button);
    });
  });
  target.querySelectorAll("[data-image-gen-toggle-secret]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      runAction(button, async () => {
        const panel = button.closest("[data-image-gen-config]");
        const input = panel.querySelector("[data-image-gen-api-key]");
        const keyEnv = panel.querySelector("[data-image-gen-key-env]")?.value.trim();
        if (input.type === "text") {
          input.type = "password";
          button.textContent = "查看";
          return;
        }
        if (keyEnv && !input.value) {
          input.value = await api.getSecret(keyEnv);
        }
        input.type = "text";
        button.textContent = "隐藏";
      });
    });
  });
  target.querySelectorAll("[data-capability-save]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      saveModelCapabilitySettings(button);
    });
  });
  target.querySelectorAll("[data-reset-model-capabilities]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      runAction(button, async () => {
        const response = await api.resetModelCapabilities(button.dataset.resetModelCapabilities);
        state = response?.state || await api.getState();
        draftSelection = [...state.selectedModelIds];
        render();
        showToast("模型能力已恢复默认；上下文如需修改可重新保存。");
      });
    });
  });
  target.querySelectorAll("[data-model-context-save]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      saveInlineModelContext(button);
    });
  });
  target.querySelectorAll("[data-edit-custom]").forEach((button) => {
    button.addEventListener("click", () => openCustomEditor(button.dataset.editCustom));
  });
  target.querySelectorAll("[data-remove-custom]").forEach((button) => {
    button.addEventListener("click", () =>
      runAction(button, async () => {
        if (editingCustomPresetId === button.dataset.removeCustom) {
          resetCustomModelForm();
        }
        state = await api.removeCustomModel(button.dataset.removeCustom);
        draftSelection = [...state.selectedModelIds];
        render();
        showToast("自定义模型已删除。");
      }),
    );
  });
}

function modelCard(model, selected, includeControls = true) {
  const isSelected = selected.has(model.presetId);
  const supportsImage = modelSupportsImage(model);
  const isNativeDisabled = state.mode === "all_api" && model.authMode === "codex_openai";
  const disabled = isNativeDisabled;
  const reason = isNativeDisabled
    ? "全部 API 模式不能选择订阅模型"
    : providerName(model.providerId);
  return `
    <div class="model-card-shell">
      <button class="model-card ${isSelected ? "selected" : ""}" data-model-id="${escapeHtml(model.presetId)}" ${disabled ? "disabled" : ""}>
        <span class="model-title">${escapeHtml(model.displayName)}</span>
        <span class="model-meta">${escapeHtml(model.model)} · ${escapeHtml(providerName(model.providerId))}</span>
        <span class="model-capability-summary">${escapeHtml(includeControls ? modelFriendlySummary(model) : modelCatalogSummary(model))}</span>
        ${includeControls ? modelCapabilityBadges(model) : ""}
        ${includeControls ? modelCapabilityHints(model) : ""}
        ${includeControls ? `<span class="model-foot">${escapeHtml(reason)}</span>` : ""}
      </button>
      ${includeControls ? modelConfigControls(model, supportsImage) : ""}
    </div>
  `;
}

function modelFriendlySummary(model) {
  const modalities = new Set(inputModalitiesForModel(model));
  const parts = [
    model.api === "responses" ? "Responses" : "Chat",
    `上下文 ${formatCompactContext(model.contextWindow || 258400)}`,
    modalities.has("image") ? "图片可用" : "纯文本",
  ];
  if (modalities.has("file")) {
    parts.push("文件可用");
  }
  if (modalities.has("audio")) {
    parts.push("音频可用");
  }
  return parts.join(" · ");
}

function modelCatalogSummary(model) {
  const modalities = new Set(inputModalitiesForModel(model));
  const parts = [model.api === "responses" ? "Responses" : "Chat"];
  if (modalities.has("image")) {
    parts.push("图片");
  }
  if (modalities.has("file")) {
    parts.push("文件");
  }
  return parts.join(" · ");
}

function modelConfigControls(model, supportsImage) {
  return `
    <button
      class="capability-toggle ${supportsImage ? "enabled" : ""}"
      type="button"
      data-image-input-toggle="${escapeHtml(model.presetId)}"
      aria-pressed="${supportsImage ? "true" : "false"}"
      title="${supportsImage ? "点击关闭图片上传" : "点击开启图片上传"}"
    >
      <span>图片上传</span>
      <strong>${supportsImage ? "开" : "关"}</strong>
    </button>
    ${inlineModelContextControl(model)}
    ${modelCapabilityResetControl(model)}
    ${
      model.custom
        ? `<div class="model-card-actions">
            <button class="text-button edit-model" data-edit-custom="${escapeHtml(model.presetId)}">编辑</button>
            <button class="text-button remove-model" data-remove-custom="${escapeHtml(model.presetId)}">删除</button>
          </div>`
        : ""
    }
  `;
}

function modelCapabilityResetControl(model) {
  if (model.capabilityOverrideSource !== "manual") {
    return "";
  }
  return `
    <div class="capability-reset-panel">
      <div>
        <strong>已修改模型能力</strong>
        <span>可恢复默认能力声明，避免旧覆盖影响路由判断。</span>
      </div>
      <button class="ghost-button light small" type="button" data-reset-model-capabilities="${escapeHtml(model.presetId)}">恢复默认</button>
    </div>
  `;
}

function inlineModelContextControl(model) {
  return `
    <div class="model-context-inline" data-model-context="${escapeHtml(model.presetId)}">
      <label>
        <span>上下文</span>
        <input type="number" min="1" step="1" data-inline-context value="${escapeHtml(String(model.contextWindow || 258400))}" />
      </label>
      <button class="ghost-button light small" type="button" data-model-context-save="${escapeHtml(model.presetId)}">保存上下文</button>
    </div>
  `;
}

function imageGenerationControl(model) {
  const settings = imageGenerationSettingsForModel(model);
  const mode = settings.mode || "official";
  const custom = mode === "custom";
  const saved = Boolean(settings.apiKeyEnv && state.secretStatus?.[settings.apiKeyEnv]);
  return `
    <div class="image-generation-panel ${custom ? "custom" : ""}" data-image-gen-config data-preset-id="${escapeHtml(model.presetId)}">
      <div class="image-generation-head">
        <label>
          <span>图片生成</span>
          <select data-image-gen-mode>
            <option value="official" ${mode === "official" ? "selected" : ""}>官方 OpenAI</option>
            <option value="custom" ${mode === "custom" ? "selected" : ""}>自定义生图</option>
            <option value="off" ${mode === "off" ? "selected" : ""}>关闭</option>
          </select>
        </label>
        <button class="ghost-button light small" type="button" data-image-gen-save>保存生图设置</button>
      </div>
      <div class="image-generation-note" data-image-gen-note>
        ${mode === "official"
          ? "默认走 OpenAI 官方图片生成。订阅和 OpenAI API 模型建议保持这一项。"
          : mode === "off"
            ? "关闭后，这个模型遇到生图请求会按普通文本请求发给当前模型。"
            : "这个模型的生图请求会转发到下面填写的图片生成接口。"}
      </div>
      <div class="image-generation-fields ${custom ? "" : "hidden"}">
        <label>
          <span>服务名</span>
          <input data-image-gen-display-name value="${escapeHtml(settings.displayName || "Custom Image Generation")}" placeholder="例如 My Image API" />
        </label>
        <label>
          <span>Base URL</span>
          <input data-image-gen-base-url value="${escapeHtml(settings.baseUrl || "")}" placeholder="例如 https://api.example.com/v1" />
        </label>
        <label>
          <span>Endpoint</span>
          <input data-image-gen-endpoint value="${escapeHtml(settings.endpoint || "/images/generations")}" placeholder="/images/generations" />
        </label>
        <label>
          <span>模型名</span>
          <input data-image-gen-model value="${escapeHtml(settings.model || "")}" placeholder="例如 image-model-v1" />
        </label>
        <label>
          <span>尺寸</span>
          <input data-image-gen-size value="${escapeHtml(settings.size || "1024x1024")}" placeholder="1024x1024" />
        </label>
        <label>
          <span>Key 名</span>
          <input data-image-gen-key-env value="${escapeHtml(settings.apiKeyEnv || "IMAGE_GENERATION_API_KEY")}" placeholder="IMAGE_GENERATION_API_KEY" />
        </label>
        <label class="wide-field">
          <span>API Key ${saved ? "（已保存）" : ""}</span>
          <div class="secret-row">
            <input type="password" data-image-gen-api-key placeholder="${saved ? "已保存，留空不修改" : "sk-..."}" />
            ${saved ? `<button class="ghost-button light small" type="button" data-image-gen-toggle-secret>查看</button>` : ""}
          </div>
        </label>
      </div>
    </div>
  `;
}

function imageGenerationSettingsForModel(model) {
  const override = state.imageGenerationOverrides?.[model.presetId];
  if (override?.mode === "custom" || override?.mode === "off") {
    return override;
  }
  if (override?.mode === "official" && modelAllowsOfficialImageGeneration(model)) {
    return override;
  }
  if (!modelAllowsOfficialImageGeneration(model)) {
    return { mode: "off" };
  }
  return {
    enabled: true,
    mode: "official",
    displayName: "OpenAI Image Generation",
    baseUrl: "https://api.openai.com/v1",
    endpoint: "/images/generations",
    model: "gpt-image-1",
    size: "1024x1024",
    apiKeyEnv: "OPENAI_API_KEY",
  };
}

function modelAllowsOfficialImageGeneration(model = {}) {
  const providerId = String(model.providerId || model.provider || "").toLowerCase();
  const authMode = String(model.authMode || "").toLowerCase();
  return providerId === "codex" || providerId === "openai" || authMode === "codex_openai";
}

function renderImageGenerationPanelMode(panel) {
  if (!panel) {
    return;
  }
  const mode = panel.querySelector("[data-image-gen-mode]")?.value || "official";
  panel.classList.toggle("custom", mode === "custom");
  panel.querySelector(".image-generation-fields")?.classList.toggle("hidden", mode !== "custom");
  const note = panel.querySelector("[data-image-gen-note]");
  if (note) {
    note.textContent = mode === "official"
      ? "默认走 OpenAI 官方图片生成。订阅和 OpenAI API 模型建议保持这一项。"
      : mode === "off"
        ? "关闭后，这个模型遇到生图请求会按普通文本请求发给当前模型。"
        : "这个模型的生图请求会转发到下面填写的图片生成接口。";
  }
}

function saveImageGenerationSettings(button) {
  return runAction(button, async () => {
    const panel = button.closest("[data-image-gen-config]");
    const imageGeneration = imageGenerationPayload(panel);
    if (imageGeneration.mode === "custom") {
      const apiKey = panel.querySelector("[data-image-gen-api-key]")?.value.trim();
      if (apiKey) {
        await api.saveSecrets({ [imageGeneration.apiKeyEnv]: apiKey });
      }
    }
    state = await api.saveModelImageGeneration({
      presetId: panel.dataset.presetId,
      imageGeneration,
    });
    draftSelection = [...state.selectedModelIds];
    render();
    showToast("图片生成设置已保存，只影响这一张模型卡。");
  });
}

function imageGenerationPayload(panel) {
  const mode = panel.querySelector("[data-image-gen-mode]")?.value || "official";
  const model = modelMap().get(panel.dataset.presetId);
  if (mode === "off") {
    return { mode: "off" };
  }
  if (mode !== "custom") {
    if (!modelAllowsOfficialImageGeneration(model)) {
      return { mode: "off" };
    }
    return { mode: "official" };
  }
  return {
    mode: "custom",
    displayName: panel.querySelector("[data-image-gen-display-name]")?.value.trim(),
    baseUrl: panel.querySelector("[data-image-gen-base-url]")?.value.trim(),
    endpoint: panel.querySelector("[data-image-gen-endpoint]")?.value.trim(),
    model: panel.querySelector("[data-image-gen-model]")?.value.trim(),
    size: panel.querySelector("[data-image-gen-size]")?.value.trim(),
    apiKeyEnv: panel.querySelector("[data-image-gen-key-env]")?.value.trim(),
  };
}

function capabilityOverrideControl(model) {
  const modalities = new Set(inputModalitiesForModel(model));
  const manual = model.capabilityOverrideSource === "manual";
  const reasoningMode = model.reasoningCapabilityOverride?.mode || "";
  return `
    <details class="capability-override" data-capability-config data-preset-id="${escapeHtml(model.presetId)}">
      <summary>
        <span>能力覆盖</span>
        <strong>${manual ? "手动" : "默认"}</strong>
      </summary>
      <div class="capability-fields">
        <label>
          <span>Context</span>
          <input type="number" min="1" step="1" data-cap-context value="${escapeHtml(String(model.contextWindow || 258400))}" />
        </label>
        <label class="checkbox-field compact">
          <input type="checkbox" data-cap-file ${modalities.has("file") ? "checked" : ""} />
          <span>文件</span>
        </label>
        <label class="checkbox-field compact">
          <input type="checkbox" data-cap-audio ${modalities.has("audio") ? "checked" : ""} />
          <span>音频</span>
        </label>
        <label>
          <span>Reasoning</span>
          <select data-cap-reasoning>
            ${capabilityReasoningOption("", "自动", reasoningMode)}
            ${capabilityReasoningOption("unknown", "未知", reasoningMode)}
            ${capabilityReasoningOption("supported", "支持", reasoningMode)}
            ${capabilityReasoningOption("unsupported", "不支持", reasoningMode)}
          </select>
        </label>
        <button class="ghost-button light small" type="button" data-capability-save>保存能力</button>
      </div>
      <p class="capability-note">只影响这个模型的能力声明和目录，不改 API Key、tools 或 MCP。</p>
    </details>
  `;
}

function capabilityReasoningOption(value, label, selected) {
  return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function saveModelCapabilitySettings(button) {
  return runAction(button, async () => {
    const panel = button.closest("[data-capability-config]");
    const presetId = panel.dataset.presetId;
    const model = modelMap().get(presetId);
    const inputModalities = ["text"];
    if (modelSupportsImage(model)) {
      inputModalities.push("image");
    }
    if (panel.querySelector("[data-cap-file]")?.checked) {
      inputModalities.push("file");
    }
    if (panel.querySelector("[data-cap-audio]")?.checked) {
      inputModalities.push("audio");
    }
    const contextWindow = Number(panel.querySelector("[data-cap-context]")?.value || 0);
    const reasoningMode = panel.querySelector("[data-cap-reasoning]")?.value || "";
    const response = await api.saveModelCapabilities({
      presetId,
      capabilities: {
        inputModalities,
        contextWindow,
        reasoning: reasoningMode ? { mode: reasoningMode } : undefined,
      },
    });
    state = response?.state || await api.getState();
    draftSelection = [...state.selectedModelIds];
    render();
    showToast("模型能力覆盖已保存。");
  });
}

function saveInlineModelContext(button) {
  return runAction(button, async () => {
    const container = button.closest("[data-model-context]");
    const presetId = container?.dataset.modelContext || button.dataset.modelContextSave;
    const model = modelMap().get(presetId);
    const contextWindow = Number(container?.querySelector("[data-inline-context]")?.value || 0);
    if (!model || !Number.isFinite(contextWindow) || contextWindow <= 0) {
      throw new Error("请输入有效的上下文大小。");
    }
    const response = await api.saveModelCapabilities({
      presetId,
      capabilities: {
        contextWindow,
      },
    });
    state = response?.state || await api.getState();
    draftSelection = [...state.selectedModelIds];
    render();
    showToast("这个模型的上下文大小已保存。");
  });
}

function modelCapabilitySummary(model) {
  const status = modelCapabilityStatus(model);
  const modalities = new Set(inputModalitiesForModel(model));
  const parts = [
    `上游 ${status.provider || providerName(model.providerId)} / ${status.api || model.api}`,
    `Context ${formatNumber(model.contextWindow || 258400)}`,
    `图片${modalities.has("image") ? "开" : "关"}`,
    `文件${modalities.has("file") ? "开" : "默认"}`,
  ];
  if (modalities.has("audio")) {
    parts.push("音频开");
  }
  if (model.reasoningCapabilityOverride?.mode) {
    parts.push(`Reasoning ${model.reasoningCapabilityOverride.mode}`);
  }
  if (model.capabilityOverrideSource === "manual") {
    parts.push("手动");
  }
  return parts.join(" · ");
}

function modelCapabilityStatus(model) {
  if (model?.capabilityStatus) {
    return model.capabilityStatus;
  }
  const modalities = new Set(inputModalitiesForModel(model));
  const api = model?.api === "responses" ? "responses" : "chat_completions";
  return {
    provider: model?.providerFamily || model?.providerId || model?.provider || "unknown",
    api,
    upstreamModel: model?.model || "",
    tools: api === "responses" ? "native" : "chat-functions",
    mcpNamespaces: "native",
    images: modalities.has("image") ? (api === "responses" ? "native" : "chat-image-url") : "none",
    files: api === "responses" ? "native" : (model?.custom ? "none" : "text-placeholder"),
    audio: modalities.has("audio") ? (api === "responses" ? "native" : "chat-input-audio") : "none",
    compact: api === "responses" ? "responses-native" : "chat-summary",
    compactStrategy: api === "responses" ? "responses-json" : "chat-json",
    contextWindow: model?.contextWindow || 258400,
  };
}

function modelCapabilityBadges(model) {
  const status = modelCapabilityStatus(model);
  const badges = [
    ["上游", status.provider || providerName(model.providerId)],
    ["API", status.api || model.api || "-"],
    ["Tools", status.tools || "unknown"],
    ["MCP", status.mcpNamespaces || "unknown"],
    ["Image", status.images || "unknown"],
    ["File", status.files || "unknown"],
    ["Compact", status.compact || "unknown"],
  ];
  return `
    <span class="model-capability-badges" data-capability-badges>
      ${badges
        .map(([label, value]) => `<span class="capability-badge"><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</span>`)
        .join("")}
    </span>
  `;
}

function modelCapabilityHints(model) {
  const status = modelCapabilityStatus(model);
  const hints = [];
  if (status.images === "none") {
    hints.push("图片不直传");
  }
  if (status.files === "none") {
    hints.push("文件不直传");
  }
  if (status.compact === "unknown" || status.compact === "none") {
    hints.push("压缩需回退");
  }
  if (!hints.length) {
    return "";
  }
  return `<span class="model-capability-hints">${hints.map(escapeHtml).join(" · ")}</span>`;
}

function modelSupportsImage(model) {
  return Array.isArray(model?.inputModalities) && model.inputModalities.includes("image");
}

function inputModalitiesForModel(model) {
  if (Array.isArray(model?.inputModalities) && model.inputModalities.length) {
    return model.inputModalities;
  }
  return model?.api === "responses" ? ["text", "image"] : ["text"];
}

function toggleModel(presetId) {
  if (draftSelection.includes(presetId)) {
    draftSelection = draftSelection.filter((id) => id !== presetId);
  } else {
    draftSelection = [...draftSelection, presetId];
  }
  render();
}

function saveModelSelection(button) {
  return runAction(button, async () => {
    state = await api.saveModelSelection(draftSelection);
    draftSelection = [...state.selectedModelIds];
    render();
    showToast("模型选择已保存，并已更新 Router 配置。");
  });
}

function startCustomModelEdit(presetId, options = {}) {
  const model = modelMap().get(presetId);
  if (!model?.custom) {
    showToast("没有找到这个自定义模型。", "error");
    return;
  }
  if (!options.preserveView) {
    modelPageView = "custom";
  }
  editingCustomPresetId = presetId;
  setValue("#customProviderName", model.providerName || providerName(model.providerId));
  setValue("#customDisplayName", model.displayName || "");
  setValue("#customModelName", model.model || "");
  setValue("#customBaseUrl", model.baseUrl || "");
  setValue("#customKeyUrl", model.keyUrl || "");
  setValue("#customDocsUrl", model.docsUrl || "");
  setValue("#customLogoUrl", model.logoUrl || "");
  setValue("#customApiType", model.api === "responses" ? "responses" : "chat_completions");
  setValue("#customContextWindow", String(model.contextWindow || 258400));
  setValue("#customApiKey", "");
  document.querySelector("#customApiKey").placeholder = state.secretStatus?.[model.keyEnv || model.apiKeyEnv]
    ? "已保存，留空不修改"
    : "sk-...";
  els.customImageInput.checked = modelSupportsImage(model);
  renderCustomFormState();
  if (options.scroll !== false) {
    els.customModelForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function resetCustomModelForm(options = {}) {
  editingCustomPresetId = null;
  els.customModelForm.reset();
  setValue("#customLogoUrl", "");
  setValue("#customContextWindow", "258400");
  document.querySelector("#customApiKey").placeholder = "新服务商请填写；已有 Key 可留空";
  if (!options.preserveView && modelPageView === "custom") {
    modelPageView = "catalog";
  }
  renderCustomFormState();
}

function customModelFormPayload(editingModel = null) {
  if (scopedCustomProviderId && !editingModel) {
    return customModelFromProvider(providerFor(scopedCustomProviderId));
  }
  return {
    presetId: editingCustomPresetId || undefined,
    providerId: editingModel?.providerId,
    providerName: value("#customProviderName"),
    displayName: value("#customDisplayName"),
    model: value("#customModelName"),
    baseUrl: value("#customBaseUrl"),
    keyUrl: value("#customKeyUrl"),
    docsUrl: value("#customDocsUrl"),
    logoUrl: value("#customLogoUrl") || editingModel?.logoUrl || "",
    api: value("#customApiType"),
    keyEnv: editingModel?.keyEnv || editingModel?.apiKeyEnv,
    apiKey: value("#customApiKey"),
    inputModalities: els.customImageInput.checked ? ["text", "image"] : ["text"],
    contextWindow: Number(value("#customContextWindow") || 258400),
  };
}

function customModelFromProvider(provider) {
  if (!provider) {
    throw new Error("没有找到要继承的供应商。");
  }
  const modelName = value("#customModelName");
  return {
    providerId: provider.id,
    providerName: provider.name || provider.id,
    displayName: modelName,
    model: modelName,
    baseUrl: provider.baseUrl || "",
    keyUrl: provider.keyUrl || "",
    docsUrl: provider.docsUrl || "",
    logoUrl: provider.logoUrl || "",
    api: value("#customApiType") || providerApiValue(provider),
    keyEnv: provider.keyEnv || provider.apiKeyEnv || "",
    apiKey: "",
    inputModalities: els.customImageInput.checked ? ["text", "image"] : ["text"],
    contextWindow: Number(value("#customContextWindow") || 258400),
  };
}

function customProviderPayload(includeApiKey = false) {
  const editingModel = editingCustomPresetId ? modelMap().get(editingCustomPresetId) : null;
  if (scopedCustomProviderId && !editingModel) {
    const provider = providerFor(scopedCustomProviderId);
    return {
      providerId: provider?.id || "",
      id: provider?.id || "",
      name: provider?.name || "",
      shortName: provider?.shortName || provider?.name || "",
      baseUrl: provider?.baseUrl || "",
      api: value("#customApiType") || providerApiValue(provider),
      keyEnv: provider?.keyEnv || provider?.apiKeyEnv || "",
      keyUrl: provider?.keyUrl || "",
      docsUrl: provider?.docsUrl || "",
      logoUrl: provider?.logoUrl || "",
      authMode: provider?.authMode || "api_key",
      custom: true,
      apiKey: "",
    };
  }
  const providerName = value("#customProviderName") || editingModel?.providerName || "Custom";
  const providerId = editingModel?.providerId || `custom-${slugifyProviderId(providerName)}`;
  const keyEnv = editingModel?.keyEnv || editingModel?.apiKeyEnv || `${slugifyEnvName(providerName)}_API_KEY`;
  return {
    providerId,
    id: providerId,
    name: providerName,
    shortName: providerName,
    baseUrl: value("#customBaseUrl") || editingModel?.baseUrl || "",
    api: value("#customApiType") || editingModel?.api || "chat_completions",
    keyEnv,
    keyUrl: value("#customKeyUrl") || editingModel?.keyUrl || "",
    docsUrl: value("#customDocsUrl") || editingModel?.docsUrl || "",
    logoUrl: value("#customLogoUrl") || editingModel?.logoUrl || "",
    authMode: "api_key",
    custom: true,
    apiKey: includeApiKey ? value("#customApiKey") : "",
  };
}

function slugifyProviderId(value) {
  return String(value || "custom")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "custom";
}

function slugifyEnvName(value) {
  return String(value || "CUSTOM")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "CUSTOM";
}

function renderCustomFormState() {
  const editing = Boolean(editingCustomPresetId);
  const scoped = Boolean(scopedCustomProviderId) && !editing;
  const provider = scoped ? providerFor(scopedCustomProviderId) : null;
  els.customModelForm.classList.toggle("provider-scoped", scoped);
  document.querySelector("#customModelNameLabel").textContent = scoped ? "模型名称" : "真实模型名";
  els.customFormTitle.textContent = editing
    ? "编辑自定义模型"
    : scoped
      ? `添加 ${provider?.shortName || provider?.name || "供应商"} 自定义模型`
      : "添加自定义模型";
  els.customFormDescription.textContent = editing
    ? "修改后会覆盖当前自定义模型，并保留原来的 API Key 名称。"
    : scoped
      ? `沿用 ${provider?.name || "当前供应商"} 的 Base URL、API Key、文档和图标，只填写要新增的模型。`
      : "用于接入任何 OpenAI-compatible 服务商。显示名给 Codex 看，真实模型名发给服务商。";
  els.customSubmitButton.textContent = editing ? "保存修改" : "添加模型";
  els.cancelCustomEdit.classList.toggle("hidden", !editing && !scoped);
  if (scoped && provider) {
    setValue("#customProviderName", provider.name || provider.id);
    setValue("#customDisplayName", value("#customModelName"));
    setValue("#customBaseUrl", provider.baseUrl || "");
    setValue("#customKeyUrl", provider.keyUrl || "");
    setValue("#customDocsUrl", provider.docsUrl || "");
    setValue("#customLogoUrl", provider.logoUrl || "");
    setValue("#customApiType", providerApiValue(provider));
  }
  renderCustomLogoUploadState();
}

function renderCustomLogoUploadState() {
  const logoUrl = value("#customLogoUrl");
  const preview = document.querySelector("#customLogoPreview");
  const status = document.querySelector("#customLogoStatus");
  if (preview) {
    preview.innerHTML = logoUrl
      ? `<img src="${escapeHtml(logoUrl)}" alt="" loading="lazy" />`
      : `<img src="./assets/providers/default.svg" alt="" loading="lazy" />`;
  }
  if (status) {
    status.textContent = logoUrl ? "已选择本地图标" : "未选择时使用默认 AI 图标";
  }
}

function renderUsage() {
  const summary = state.usageSummary || emptyUsageSummary();
  const current = summary.current || summary;
  const history = summary.history || emptyUsageSummary();
  const events = filterUsageEvents(current.events || state.usageEvents || [], usageRangeDays);
  const ranged = summarizeUsageEvents(events, current);
  updateUsageRangeButtons();
  els.statCalls.textContent = formatNumber(ranged.totalCalls || 0);
  els.statTokens.textContent = formatNumber(ranged.totalTokens || 0);
  els.statPrompt.textContent = formatInputTokens(ranged);
  els.statCache.textContent = formatCacheTokens(ranged);
  els.statCompletion.textContent = formatNumber(ranged.completionTokens || 0);
  renderUsageChart(ranged.byModel || []);
  renderUsageTableStable(ranged.byModel || [], events, history);
}

function updateUsageRangeButtons() {
  document.querySelectorAll("[data-usage-range]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.usageRange) === Number(usageRangeDays));
  });
}

function filterUsageEvents(events, days) {
  const list = Array.isArray(events) ? events : [];
  const rangeDays = Number(days || 0);
  if (!rangeDays || rangeDays <= 0) {
    return list;
  }
  const cutoff = Date.now() - rangeDays * 24 * 60 * 60 * 1000;
  return list.filter((event) => {
    const value = event?.finishedAt || event?.startedAt || event?.timestamp || event?.time;
    const time = value ? new Date(value).getTime() : 0;
    return Number.isFinite(time) && time >= cutoff;
  });
}

function summarizeUsageEvents(events, fallback = emptyUsageSummary()) {
  if (!Array.isArray(events) || !events.length) {
    return {
      ...fallback,
      byModel: fallback.byModel || [],
      events: [],
    };
  }
  const byModel = new Map();
  const total = {
    totalCalls: 0,
    totalTokens: 0,
    promptTokens: 0,
    freshPromptTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    completionTokens: 0,
    statusCounts: {},
    byModel: [],
    events,
    latest: events[0] || null,
  };
  for (const event of events) {
    const promptTokens = Number(event.promptTokens || 0);
    const freshPromptTokens = Number(event.freshPromptTokens ?? promptTokens);
    const cacheReadTokens = Number(event.cacheReadTokens || 0);
    const cacheCreationTokens = Number(event.cacheCreationTokens || 0);
    const completionTokens = Number(event.completionTokens || 0);
    const totalTokens = Number(event.totalTokens || promptTokens + completionTokens);
    const status = event.status || "-";
    total.totalCalls += 1;
    total.promptTokens += promptTokens;
    total.freshPromptTokens += freshPromptTokens;
    total.cacheReadTokens += cacheReadTokens;
    total.cacheCreationTokens += cacheCreationTokens;
    total.completionTokens += completionTokens;
    total.totalTokens += totalTokens;
    total.statusCounts[status] = (total.statusCounts[status] || 0) + 1;

    const key = [
      event.route || "",
      event.upstreamModel || "",
      event.api || "",
      event.isCurrentRoute === false ? "history" : "current",
    ].join("\u0000");
    if (!byModel.has(key)) {
      byModel.set(key, {
        route: event.route,
        upstreamModel: event.upstreamModel,
        api: event.api,
        calls: 0,
        promptTokens: 0,
        freshPromptTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        statusCounts: {},
        errors: 0,
        fastZeroTokenErrors: 0,
        lastStatus: "-",
        lastError: "",
        lastAt: null,
        isCurrentRoute: event.isCurrentRoute,
      });
    }
    const row = byModel.get(key);
    row.calls += 1;
    row.promptTokens += promptTokens;
    row.freshPromptTokens += freshPromptTokens;
    row.cacheReadTokens += cacheReadTokens;
    row.cacheCreationTokens += cacheCreationTokens;
    row.completionTokens += completionTokens;
    row.totalTokens += totalTokens;
    row.statusCounts[status] = (row.statusCounts[status] || 0) + 1;
    row.lastStatus = status;
    row.lastError = event.error || row.lastError;
    row.lastAt = event.finishedAt || event.startedAt || row.lastAt;
    if (Number(status) >= 400) {
      row.errors += 1;
      if (totalTokens === 0 && Number(event.durationMs || 0) < 1000) {
        row.fastZeroTokenErrors += 1;
      }
    }
  }
  total.byModel = [...byModel.values()].sort((left, right) => {
    const leftTime = new Date(left.lastAt || 0).getTime();
    const rightTime = new Date(right.lastAt || 0).getTime();
    return rightTime - leftTime;
  });
  return total;
}

function renderOverviewUsage() {
  const latest = state.usageSummary?.current?.latest || state.usageSummary?.latest;
  if (!latest) {
    els.latestUsage.textContent = "暂无";
    return;
  }
  const route = latest.route || latest.codexModel;
  const upstream = latest.upstreamModel ? ` -> ${latest.upstreamModel}` : "";
  const provider = routeProviderName(route);
  const api = latest.api ? ` · ${latest.api}` : "";
  els.latestUsage.textContent = `${displayRoute(route)}${upstream} · 上游 ${provider}${api} · ${latest.status || "unknown"} · ${formatNumber(latest.totalTokens || 0)} token`;
}

function renderUsageChart(rows) {
  if (!rows.length) {
    els.usageChart.innerHTML = `<div class="empty-state">还没有调用记录。启动 Router 后，在 Codex 里对话一次，这里会显示每个模型的调用量。</div>`;
    return;
  }
  const maxTokens = Math.max(...rows.map((row) => row.totalTokens || 0));
  const maxCalls = Math.max(...rows.map((row) => row.calls || 0), 1);
  els.usageChart.innerHTML = rows
    .map((row) => {
      const value = maxTokens > 0 ? row.totalTokens : row.calls;
      const max = maxTokens > 0 ? maxTokens : maxCalls;
      const width = Math.max(5, Math.ceil(((value / max) * 100) / 5) * 5);
      const label = maxTokens > 0 ? `${formatNumber(row.totalTokens)} token` : `${formatNumber(row.calls)} 次`;
      const stateLabel = usageRouteState(row);
      return `
        <div class="usage-bar">
          <div class="usage-bar-head">
            <strong>${escapeHtml(displayRoute(row.route))}</strong>
            <span>${escapeHtml(row.upstreamModel || "-")}${stateLabel ? ` · ${stateLabel}` : ""} · ${label}</span>
          </div>
          <div class="bar-track"><span class="w-${width}"></span></div>
        </div>
      `;
    })
    .join("");
}

function usageRouteState(row) {
  if (row?.isCurrentRoute === true) {
    return "当前";
  }
  if (row?.isCurrentRoute === false) {
    return "历史";
  }
  return "";
}

function usageStatusText(row) {
  const stateLabel = usageRouteState(row);
  const status = usageErrorStatusText(row);
  return stateLabel ? `${stateLabel} · ${status}` : String(status);
}

function usageErrorStatusText(row) {
  if (!row?.errors) {
    return row?.lastStatus || "-";
  }
  const fastZero = Number(row.fastZeroTokenErrors || 0);
  const errorDetail = row.lastError || row.lastStatus || "";
  if (fastZero > 0 && fastZero === Number(row.errors || 0)) {
    return `${row.errors} 次 0 token 快速失败：${errorDetail}`;
  }
  if (fastZero > 0) {
    return `${row.errors} 错误（${fastZero} 次 0 token 快速失败）：${errorDetail}`;
  }
  return `${row.errors} 错误：${errorDetail}`;
}

function usageEventStatusText(event) {
  if (!(event?.status && event.status >= 400)) {
    return event?.status || "-";
  }
  const fastZero =
    Number(event.totalTokens || 0) === 0 &&
    Number.isFinite(Number(event.durationMs)) &&
    Number(event.durationMs) < 1000;
  const prefix = fastZero ? `${event.status} 0 token 快速失败` : String(event.status);
  return `${prefix}${event.error ? `：${event.error}` : ""}`;
}

function renderUsageTable(rows, events) {
  const modelRows = rows.length
    ? rows
        .map(
          (row) => `
            <div class="usage-row">
              <span>${escapeHtml(displayRoute(row.route))}</span>
              <span>${escapeHtml(row.upstreamModel || "-")}</span>
              <span>${escapeHtml(row.api || "-")}</span>
              <span>${formatNumber(row.calls)}</span>
              <span>${formatInputTokens(row)}</span>
              <span>${formatCacheTokens(row)}</span>
              <span>${formatNumber(row.completionTokens)}</span>
              <span>${formatNumber(row.totalTokens)}</span>
              <span>${escapeHtml(usageStatusText(row))}</span>
              <span>${formatTime(row.lastAt)}</span>
            </div>
          `,
        )
        .join("")
    : `<div class="empty-state">暂无模型汇总。</div>`;
  const eventRows = events.length
    ? events
        .slice(0, 40)
        .map(
          (event) => `
            <div class="usage-row recent">
              <span>${escapeHtml(displayRoute(event.route))}</span>
              <span>${escapeHtml(event.upstreamModel || "-")}</span>
              <span>${escapeHtml(event.api || "-")}</span>
              <span>${escapeHtml(usageEventStatusText(event))}</span>
              <span>${formatInputTokens(event)}</span>
              <span>${formatCacheTokens(event)}</span>
              <span>${formatNumber(event.completionTokens)}</span>
              <span>${formatNumber(event.totalTokens)}</span>
              <span>${formatDuration(event.durationMs)}</span>
              <span>${formatTime(event.finishedAt || event.startedAt)}</span>
            </div>
          `,
        )
        .join("")
    : `<div class="empty-state">暂无明细记录。</div>`;
  els.usageTable.innerHTML = `
    <h3>按模型汇总</h3>
    <div class="usage-grid header">
      <span>当前显示名</span><span>实际上游模型</span><span>接口</span><span>次数</span><span>输入</span><span>缓存</span><span>输出</span><span>总量</span><span>状态</span><span>最近时间</span>
    </div>
    <div class="usage-grid">${modelRows}</div>
    <h3>最近请求</h3>
    <div class="usage-grid header">
      <span>当前显示名</span><span>实际上游模型</span><span>接口</span><span>状态</span><span>输入</span><span>缓存</span><span>输出</span><span>总量</span><span>耗时</span><span>时间</span>
    </div>
    <div class="usage-grid">${eventRows}</div>
  `;
}

function usageGridTemplate() {
  return usageColumnWidths.map((width) => `${width}px`).join(" ");
}

function usageGridMinWidth() {
  return usageColumnWidths.reduce((sum, width) => sum + Number(width || 0), 0);
}

function usageHeaderCell(label, index) {
  return `
    <span class="usage-header-cell">
      ${escapeHtml(label)}
      <button class="usage-resizer" type="button" data-usage-col="${index}" aria-label="调整列宽"></button>
    </span>
  `;
}

function bindUsageColumnResizers() {
  els.usageTable.querySelectorAll(".usage-resizer").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      usageResizeState = {
        column: Number(button.dataset.usageCol),
        startX: event.clientX,
        startWidth: usageColumnWidths[Number(button.dataset.usageCol)] || 112,
      };
      document.body.classList.add("resizing-usage-column");
      window.addEventListener("pointermove", resizeUsageColumn);
      window.addEventListener("pointerup", stopUsageColumnResize, { once: true });
    });
  });
}

function resizeUsageColumn(event) {
  if (!usageResizeState) {
    return;
  }
  const next = Math.max(72, usageResizeState.startWidth + event.clientX - usageResizeState.startX);
  usageColumnWidths[usageResizeState.column] = next;
  applyUsageColumnWidths();
}

function stopUsageColumnResize() {
  usageResizeState = null;
  document.body.classList.remove("resizing-usage-column");
  window.removeEventListener("pointermove", resizeUsageColumn);
}

function applyUsageColumnWidths() {
  const rules = ensureUsageColumnCssRules();
  if (!rules) {
    return;
  }
  rules.grid.style.minWidth = `${usageGridMinWidth()}px`;
  rules.row.style.gridTemplateColumns = usageGridTemplate();
}

function ensureUsageColumnCssRules() {
  if (usageColumnCssRules?.grid && usageColumnCssRules?.row) {
    return usageColumnCssRules;
  }
  const styles = Array.from(document.styleSheets);
  const sheet = styles.find((item) => {
    try {
      return String(item.href || "").endsWith("/styles.css") || String(item.href || "").endsWith("\\styles.css");
    } catch {
      return false;
    }
  });
  if (!sheet) {
    return null;
  }
  try {
    const gridIndex = sheet.cssRules.length;
    sheet.insertRule(".usage-table-block .usage-grid.usage-grid-resizable {}", gridIndex);
    const rowIndex = sheet.cssRules.length;
    sheet.insertRule(".usage-table-block .usage-row.usage-grid-resizable {}", rowIndex);
    usageColumnCssRules = {
      grid: sheet.cssRules[gridIndex],
      row: sheet.cssRules[rowIndex],
    };
  } catch (error) {
    console.warn("Unable to install usage column CSS rules", error);
    return null;
  }
  return usageColumnCssRules;
}

function renderUsageTableStable(rows, events, history = {}) {
  const modelRows = rows.length
    ? rows
        .map(
          (row) => `
            <div class="usage-row usage-grid-resizable">
              <span>${escapeHtml(displayRoute(row.route))}</span>
              <span>${escapeHtml(row.upstreamModel || "-")}</span>
              <span>${escapeHtml(row.api || "-")}</span>
              <span>${formatNumber(row.calls)}</span>
              <span>${formatInputTokens(row)}</span>
              <span>${formatCacheTokens(row)}</span>
              <span>${formatNumber(row.completionTokens)}</span>
              <span>${formatNumber(row.totalTokens)}</span>
              <span>${escapeHtml(usageStatusText(row))}</span>
              <span>${formatTime(row.lastAt)}</span>
            </div>
          `,
        )
        .join("")
    : `<div class="empty-state">暂无模型汇总。</div>`;
  const eventRows = events.length
    ? events
        .slice(0, 40)
        .map(
          (event, index) => `
            <div class="usage-row usage-grid-resizable recent">
              <span>${escapeHtml(displayRoute(event.route))}</span>
              <span>${escapeHtml(event.upstreamModel || "-")}</span>
              <span>${escapeHtml(event.api || "-")}</span>
              <span class="usage-status-cell">
                <button class="mini-link" type="button" data-request-detail="${escapeHtml(event.requestId || event.id || index)}">详情</button>
                ${escapeHtml(usageEventStatusText(event))}
              </span>
              <span>${formatInputTokens(event)}</span>
              <span>${formatCacheTokens(event)}</span>
              <span>${formatNumber(event.completionTokens)}</span>
              <span>${formatNumber(event.totalTokens)}</span>
              <span>${formatDuration(event.durationMs)}</span>
              <span>${formatTime(event.finishedAt || event.startedAt)}</span>
            </div>
          `,
        )
        .join("")
    : `<div class="empty-state">暂无明细记录。</div>`;
  const modelHeaders = ["当前显示名", "实际上游模型", "接口", "次数", "输入", "缓存", "输出", "总量", "状态", "最近时间"];
  const eventHeaders = ["当前显示名", "实际上游模型", "接口", "状态", "输入", "缓存", "输出", "总量", "耗时", "时间"];
  els.usageTable.innerHTML = `
    <h3>按模型汇总</h3>
    <div class="usage-table-block">
      <div class="usage-grid usage-grid-resizable">
        <div class="usage-row usage-grid-resizable header">
          ${modelHeaders.map((label, index) => usageHeaderCell(label, index)).join("")}
        </div>
        ${modelRows}
      </div>
    </div>
    <h3>最近请求</h3>
    <div class="usage-table-block">
      <div class="usage-grid usage-grid-resizable">
        <div class="usage-row usage-grid-resizable header">
          ${eventHeaders.map((label, index) => usageHeaderCell(label, index)).join("")}
        </div>
        ${eventRows}
      </div>
    </div>
  `;
  applyUsageColumnWidths();
  bindUsageColumnResizers();
  bindRequestDetailButtons(events);
}

function bindRequestDetailButtons(events = []) {
  const eventMap = new Map(
    (Array.isArray(events) ? events : []).map((event, index) => [
      String(event.requestId || event.id || index),
      event,
    ]),
  );
  els.usageTable.querySelectorAll("[data-request-detail]").forEach((button) => {
    button.addEventListener("click", () => showRequestDetail(eventMap.get(button.dataset.requestDetail)));
  });
}

function showRequestDetail(event) {
  if (!(els.requestDetailDialog && els.requestDetailBody)) {
    return;
  }
  if (!event) {
    showToast("没有找到这条请求详情。", "error");
    return;
  }
  const upstreamUrl = event.upstreamUrl || event.baseUrl || event.url || "";
  const rows = [
    ["当前显示名", displayRoute(event.route)],
    ["真实模型", event.upstreamModel || event.model || "-"],
    ["接口", event.api || "-"],
    ["上游 URL", upstreamUrl || "-"],
    ["状态", usageEventStatusText(event)],
    ["耗时", formatDuration(event.durationMs)],
    ["Token", `${formatNumber(event.totalTokens)} 总 / ${formatNumber(event.promptTokens || 0)} 输入 / ${formatNumber(event.completionTokens || 0)} 输出`],
    ["开始时间", formatTime(event.startedAt)],
    ["结束时间", formatTime(event.finishedAt)],
    ["错误", event.error || event.errorType || "-"],
  ];
  els.requestDetailBody.innerHTML = `
    <div class="request-detail-grid">
      ${rows.map(([label, value]) => requestDetailItem(label, redactDetail(value))).join("")}
    </div>
  `;
  els.requestDetailDialog.classList.remove("hidden");
  els.requestDetailDialog.setAttribute("aria-hidden", "false");
}

function hideRequestDetail() {
  els.requestDetailDialog?.classList.add("hidden");
  els.requestDetailDialog?.setAttribute("aria-hidden", "true");
}

function requestDetailItem(label, value) {
  return `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "-")}</strong>
    </article>
  `;
}

function redactDetail(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak)-[A-Za-z0-9._-]{6,}\b/gi, (match) => {
      const prefix = match.slice(0, 2).toLowerCase();
      return `${prefix}-[REDACTED]`;
    })
    .replace(/<\s*(ak)-[A-Za-z0-9._-]{6,}\s*>/gi, "<ak-[REDACTED]>")
    .replace(/\b(?:org|proj)-[A-Za-z0-9._-]{8,}\b/gi, (match) => {
      const prefix = match.split("-")[0].toLowerCase();
      return `${prefix}-[REDACTED]`;
    })
    .replace(/([?&](?:api[_-]?key|key|token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/:\/\/([^:/\s]+):([^@\s]+)@/g, "://$1:[REDACTED]@");
}
async function runAction(button, fn) {
  try {
    if (button) {
      button.disabled = true;
      button.classList.add("loading");
    }
    await fn();
  } catch (error) {
    const message = error?.message || String(error);
    showToast(message, "error");
    console.error(error);
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove("loading");
    }
  }
}

function bindFolderButton(selector, target) {
  const button = document.querySelector(selector);
  if (!button) {
    return;
  }
  button.addEventListener("click", () =>
    runAction(button, async () => {
      const result = await api.openFolder(target);
      if (!result?.ok) {
        throw new Error(result?.message || "打开目录失败。");
      }
    }),
  );
}

function keySummaryInfo() {
  const diagnostics = state.diagnostics;
  if (diagnostics) {
    const invalidBaseUrls = diagnostics.invalidBaseUrls || [];
    const missingApiKeys = diagnostics.missingApiKeys || [];
    if (invalidBaseUrls.length) {
      return {
        needed: diagnostics.apiKeyRoutes || 0,
        saved: diagnostics.savedApiKeyRoutes || 0,
        text: `发现 ${invalidBaseUrls.length} 个地址错误`,
        detail: invalidBaseUrls
          .map((item) => `${item.displayName || item.id}: ${item.baseUrl || "Base URL 为空"}`)
          .join("；"),
      };
    }
    if (missingApiKeys.length) {
      return {
        needed: diagnostics.apiKeyRoutes || 0,
        saved: diagnostics.savedApiKeyRoutes || 0,
        text: `还缺 ${missingApiKeys.length} 个 API Key`,
        detail: missingApiKeys
          .map((item) => `${item.displayName || item.id}: ${item.apiKeyEnv || "API Key"}`)
          .join("；"),
      };
    }
    if (!diagnostics.apiKeyRoutes) {
      return {
        needed: 0,
        saved: 0,
        text: "当前选择无需 API Key",
        detail: "GPT 订阅模型会使用 Codex/OpenAI 登录态。",
      };
    }
    return {
      needed: diagnostics.apiKeyRoutes,
      saved: diagnostics.savedApiKeyRoutes,
      text: "所需 API Key 已全部保存",
      detail: `已选 ${diagnostics.apiKeyRoutes} 个 API 模型，密钥已准备好。`,
    };
  }

  const needed = new Set();
  const modelsById = modelMap();
  for (const id of draftSelection) {
    const model = modelsById.get(id);
    const provider = providerFor(model?.providerId);
    if (model?.authMode === "api_key" && (model.apiKeyEnv || model.keyEnv || provider?.keyEnv)) {
      needed.add(model.apiKeyEnv || model.keyEnv || provider.keyEnv);
    }
  }
  const saved = [...needed].filter((key) => state.secretStatus?.[key]).length;
  const missing = needed.size - saved;
  const text = needed.size === 0
    ? "当前选择无需 API Key"
    : missing === 0
      ? "所需 API Key 已全部保存"
      : `还缺 ${missing} 个 API Key`;
  return {
    needed: needed.size,
    saved,
    text,
    detail:
      needed.size === 0
        ? "GPT 订阅模型会使用 Codex/OpenAI 登录态。"
        : "只看当前模型栏里 DeepSeek、Kimi 等 API 模型需要的密钥。",
  };
}

function renderLogs(logs) {
  els.logOutput.textContent = logs.length
    ? logs.join("\n")
    : "暂无日志。启动 Router 或点击操作按钮后，这里会显示执行结果。";
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

function showVvipDialog(featureName) {
  const feature = String(featureName || "神秘功能").trim() || "神秘功能";
  const prank = vvipPrankFor(feature);
  els.vvipFeatureName.textContent = feature;
  els.vvipDialogMessage.textContent = prank.message;
  els.vvipDialogNote.textContent = prank.note;
  els.vvipDialog.classList.remove("hidden");
  els.vvipDialog.setAttribute("aria-hidden", "false");
  els.closeVvipDialog?.focus();
}

function vvipPrankFor(featureName) {
  const [note, message] = VVIP_PRANK_MESSAGES.get(featureName) || VVIP_FALLBACK_PRANK;
  return { message, note };
}

function hideVvipDialog() {
  els.vvipDialog?.classList.add("hidden");
  els.vvipDialog?.setAttribute("aria-hidden", "true");
}

function showUpdateDialog(updatePlan) {
  return new Promise((resolve) => {
    const installerUpdate = updatePlan.asset?.kind === "installer";
    els.updateDialogVersion.textContent = `v${updatePlan.latestVersion || ""}`;
    els.updateDialogMessage.textContent =
      "下载完成后会保存到更新目录，当前程序保持运行，可手动处理。";
    if (installerUpdate) {
      els.updateDialogMessage.textContent =
        "下载完成后会打开安装器，当前窗口会退出，安装完成后会启动新版。";
    }
    els.updateDialogAsset.textContent = updatePlan.asset
      ? `${updatePlan.asset.name} · ${formatBytes(updatePlan.asset.size)}`
      : "未读取到更新包信息";
    setUpdateDialogBusy(false);
    resetUpdateProgress();
    els.updateDialog.classList.remove("hidden");
    els.updateDialog.setAttribute("aria-hidden", "false");
    els.confirmUpdate.focus();

    const finish = (accepted) => {
      els.confirmUpdate.removeEventListener("click", accept);
      els.cancelUpdate.removeEventListener("click", cancel);
      els.updateDialog.removeEventListener("click", backdropCancel);
      document.removeEventListener("keydown", escapeCancel);
      if (!accepted) {
        hideUpdateDialog();
      }
      resolve(accepted);
    };
    const accept = () => finish(true);
    const cancel = () => finish(false);
    const backdropCancel = (event) => {
      if (event.target === els.updateDialog) {
        finish(false);
      }
    };
    const escapeCancel = (event) => {
      if (event.key === "Escape") {
        finish(false);
      }
    };

    els.confirmUpdate.addEventListener("click", accept);
    els.cancelUpdate.addEventListener("click", cancel);
    els.updateDialog.addEventListener("click", backdropCancel);
    document.addEventListener("keydown", escapeCancel);
  });
}

function hideUpdateDialog() {
  els.updateDialog.classList.add("hidden");
  els.updateDialog.setAttribute("aria-hidden", "true");
}

function setUpdateDialogBusy(isBusy) {
  els.updateDialog.classList.toggle("is-busy", Boolean(isBusy));
  els.confirmUpdate.disabled = Boolean(isBusy);
  els.cancelUpdate.disabled = Boolean(isBusy);
  els.confirmUpdate.textContent = isBusy ? "下载中..." : "下载更新包";
}

function resetUpdateProgress() {
  els.updateProgress.classList.add("hidden");
  els.updateProgressTrack.classList.remove("indeterminate");
  els.updateProgressText.textContent = "等待下载";
  els.updateProgressPercent.textContent = "0%";
  els.updateProgressBar.style.width = "0%";
}

function renderUpdateProgress(progress = {}) {
  els.updateProgress.classList.remove("hidden");
  const downloadedBytes = Number(progress.downloadedBytes || 0);
  const totalBytes = Number(progress.totalBytes || 0);
  const percent = Number.isFinite(Number(progress.percent))
    ? Math.max(0, Math.min(100, Math.floor(Number(progress.percent))))
    : totalBytes > 0
      ? Math.max(0, Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100)))
      : 0;
  const hasKnownSize = totalBytes > 0;
  const bytesPerSecond = Number(progress.bytesPerSecond || 0);
  const isIndeterminate = !hasKnownSize && progress.phase !== "error" && progress.phase !== "ready";
  els.updateProgressTrack.classList.toggle("indeterminate", isIndeterminate);
  els.updateProgressBar.style.width = isIndeterminate ? "45%" : `${percent}%`;
  els.updateProgressPercent.textContent = isIndeterminate ? "计算中" : `${percent}%`;
  els.updateProgressText.textContent = progress.message || updateProgressText(progress.phase, {
    downloadedBytes,
    totalBytes,
    percent,
    bytesPerSecond,
  });
}

function updateProgressText(phase, details) {
  if (phase === "checking") {
    return "正在确认最新版本...";
  }
  if (phase === "downloading") {
    const speedText = details.bytesPerSecond > 0 ? ` · ${formatBytes(details.bytesPerSecond)}/s` : "";
    return details.totalBytes > 0
      ? `正在下载 ${formatBytes(details.downloadedBytes)} / ${formatBytes(details.totalBytes)}${speedText}`
      : `正在下载更新包...${speedText}`;
  }
  if (phase === "ready") {
    return "下载完成，更新包已保存在 updates 目录。";
  }
  if (phase === "launching") {
    return "下载完成，正在启动安装器...";
  }
  if (phase === "error") {
    return "更新失败，请稍后重试。";
  }
  return "准备更新...";
}

function showToast(message, type = "success") {
  els.toast.textContent = message;
  els.toast.className = `toast ${type}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.classList.add("hidden");
  }, 3600);
}

function emptyUsageSummary() {
  return {
    totalCalls: 0,
    totalTokens: 0,
    promptTokens: 0,
    freshPromptTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    completionTokens: 0,
    statusCounts: {},
    byModel: [],
    latest: null,
    current: {
      totalCalls: 0,
      totalTokens: 0,
      promptTokens: 0,
      freshPromptTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      completionTokens: 0,
      statusCounts: {},
      byModel: [],
      events: [],
      latest: null,
    },
    history: {
      totalCalls: 0,
      totalTokens: 0,
      promptTokens: 0,
      freshPromptTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      completionTokens: 0,
      statusCounts: {},
      byModel: [],
      events: [],
      latest: null,
    },
  };
}

function groupByProvider(models) {
  const groups = new Map();
  for (const model of models) {
    if (!groups.has(model.providerId)) {
      groups.set(model.providerId, []);
    }
    groups.get(model.providerId).push(model);
  }
  return [...groups.entries()];
}

function providerModelDirectoryInfo(providerId) {
  const entry = state.modelDirectory?.providers?.[providerId];
  if (!entry) {
    return "模型目录：离线 preset，可手动刷新";
  }
  const age = modelDirectoryAgeLabel(entry.fetchedAt);
  const stale = modelDirectoryIsStale(entry.fetchedAt);
  return `模型目录：${entry.models?.length || 0} 个 · ${age}${stale ? " · 可能过期" : ""}`;
}

function modelDirectoryAgeLabel(value) {
  if (!value) {
    return "未知时间";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return formatTime(value);
}

function modelDirectoryIsStale(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return true;
  }
  return Date.now() - date.getTime() > 7 * 24 * 60 * 60 * 1000;
}

function providerFor(providerId) {
  return (state.providers || []).find((provider) => provider.id === providerId);
}

function providerName(providerId) {
  return providerFor(providerId)?.shortName || providerFor(providerId)?.name || providerId || "-";
}

function routeProviderName(routeId) {
  const configured = (state.models || []).find(
    (item) => item.id === routeId || item.sourcePresetId === routeId,
  );
  if (configured) {
    return providerName(configured.provider || configured.providerFamily || configured.providerId);
  }
  const preset = modelMap().get(routeId);
  if (preset) {
    return providerName(preset.providerId || preset.provider || preset.providerFamily);
  }
  return "-";
}

function modelMap() {
  return new Map((state.modelPresets || []).map((model) => [model.presetId, model]));
}

function displayRoute(route) {
  const configured = (state.models || []).find((item) => item.id === route);
  if (configured?.displayName) {
    return configured.displayName;
  }
  const preset = modelMap().get(route);
  return preset?.displayName || route || "-";
}

function shortText(value, maxLength = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function cssEscape(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(String(value || ""));
  }
  return String(value || "").replace(/["\\]/g, "\\$&");
}

function value(selector) {
  return document.querySelector(selector).value.trim();
}

function setValue(selector, value) {
  document.querySelector(selector).value = value || "";
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function formatCompactContext(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) {
    return "-";
  }
  if (number >= 1000000) {
    return `${Math.round(number / 100000) / 10}M`;
  }
  if (number >= 1000) {
    return `${Math.round(number / 1000)}K`;
  }
  return formatNumber(number);
}

function formatInputTokens(item) {
  const fresh = Number(item?.freshPromptTokens ?? item?.promptTokens ?? 0);
  return formatNumber(fresh);
}

function formatCacheTokens(item) {
  const cacheRead = Number(item?.cacheReadTokens || 0);
  const cacheCreation = Number(item?.cacheCreationTokens || 0);
  const total = cacheRead + cacheCreation;
  if (total <= 0) {
    return "0";
  }
  if (cacheCreation > 0) {
    return `${formatNumber(total)}（读 ${formatNumber(cacheRead)} / 写 ${formatNumber(cacheCreation)}）`;
  }
  return formatNumber(cacheRead);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "大小未知";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (value < 1000) {
    return `${value} ms`;
  }
  return `${(value / 1000).toFixed(1)} s`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
