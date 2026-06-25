const api = window.codexBridge;
let state = null;
let draftSelection = [];
let dragSlotIndex = null;
let editingCustomPresetId = null;

const els = {
  routerStatus: document.querySelector("#routerStatus"),
  modeStatus: document.querySelector("#modeStatus"),
  appVersion: document.querySelector("#appVersion"),
  rootDir: document.querySelector("#rootDir"),
  selectedCount: document.querySelector("#selectedCount"),
  maxModels: document.querySelector("#maxModels"),
  keySummary: document.querySelector("#keySummary"),
  keySummaryDetail: document.querySelector("#keySummaryDetail"),
  healthStatus: document.querySelector("#healthStatus"),
  bypassSystemProxy: document.querySelector("#bypassSystemProxy"),
  copyDiagnostics: document.querySelector("#copyDiagnostics"),
  latestUsage: document.querySelector("#latestUsage"),
  providerGrid: document.querySelector("#providerGrid"),
  selectedModels: document.querySelector("#selectedModels"),
  modelPool: document.querySelector("#modelPool"),
  statCalls: document.querySelector("#statCalls"),
  statTokens: document.querySelector("#statTokens"),
  statPrompt: document.querySelector("#statPrompt"),
  statCompletion: document.querySelector("#statCompletion"),
  usageChart: document.querySelector("#usageChart"),
  usageTable: document.querySelector("#usageTable"),
  logOutput: document.querySelector("#logOutput"),
  toast: document.querySelector("#toast"),
  customModelForm: document.querySelector("#customModelForm"),
  customFormTitle: document.querySelector("#customFormTitle"),
  customFormDescription: document.querySelector("#customFormDescription"),
  customSubmitButton: document.querySelector("#customSubmitButton"),
  customImageInput: document.querySelector("#customImageInput"),
  cancelCustomEdit: document.querySelector("#cancelCustomEdit"),
  routerToggle: document.querySelector("#routerToggle"),
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
};

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".section-panel").forEach((section) => section.classList.add("hidden"));
    button.classList.add("active");
    document.querySelector(`#${button.dataset.section}`).classList.remove("hidden");
  });
});

document.querySelectorAll(".mode-card").forEach((button) => {
  button.addEventListener("click", () =>
    runAction(button, async () => {
      state = await api.selectMode(button.dataset.mode);
      draftSelection = [...state.selectedModelIds];
      render();
      showToast("计费模式已切换，模型配置已按该模式更新。");
    }),
  );
});

document.querySelector("#initializeCodex").addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    await api.initializeCodex();
    await refresh();
    showToast("CodexBridge 配置已更新：模型目录和 config.toml 都已写入。");
  }),
);

document.querySelector("#restoreCodexConfig").addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    const result = await api.restoreCodexConfig();
    await refresh();
    showToast(result?.backup ? "已初始化为 CodexBridge 写入前的 Codex 配置。" : "Codex 配置无需初始化。");
  }),
);

document.querySelector("#recoverHistoryAccess").addEventListener("click", (event) =>
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

els.bypassSystemProxy.addEventListener("change", () =>
  runAction(null, async () => {
    state = await api.saveOptions({
      bypassSystemProxy: els.bypassSystemProxy.checked,
    });
    render();
    showToast(
      els.bypassSystemProxy.checked
        ? "已开启代理绕过；重新启动 Router 后生效。"
        : "已关闭代理绕过；重新启动 Router 后生效。",
    );
  }),
);

els.copyDiagnostics.addEventListener("click", () =>
  runAction(els.copyDiagnostics, async () => {
    const summary = await api.copyDiagnostics();
    await refresh();
    showToast(`诊断信息已复制。最近错误 ${summary?.errorCount || 0} 条，发给我就能排查。`);
  }),
);

document.querySelector("#generateCatalog").addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    const result = await api.generateCatalog();
    if (!result.ok) {
      throw new Error(result.output || "生成模型目录失败");
    }
    await refresh();
    showToast("模型目录已生成。");
  }),
);

document.querySelector("#applyCodex").addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    const result = await api.applyCodexConfig();
    await refresh();
    showToast(result.backup ? "Codex 配置已写入，旧配置已备份。" : "Codex 配置已写入。");
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
    const model = {
      presetId: editingCustomPresetId || undefined,
      providerName: value("#customProviderName"),
      displayName: value("#customDisplayName"),
      model: value("#customModelName"),
      baseUrl: value("#customBaseUrl"),
      keyUrl: value("#customKeyUrl"),
      api: value("#customApiType"),
      keyEnv: editingModel?.keyEnv || editingModel?.apiKeyEnv,
      inputModalities: els.customImageInput.checked ? ["text", "image"] : ["text"],
      docsUrl: editingModel?.docsUrl,
      contextWindow: editingModel?.contextWindow,
    };
    await api.saveCustomModel(model);
    resetCustomModelForm();
    await refresh();
    showToast(
      wasEditing
        ? "自定义模型已更新，已保留原来的 API Key 槽位。"
        : "自定义模型已添加。去“密钥”页保存它的 API Key，再在模型池里选中它。",
    );
  });
});

els.cancelCustomEdit.addEventListener("click", () => resetCustomModelForm());

document.querySelector("#openConfigFolder").addEventListener("click", () => api.openFolder("config"));
document.querySelector("#openCodexFolder").addEventListener("click", () => api.openFolder("codex"));
document.querySelector("#openUpdateFolder").addEventListener("click", () => api.openFolder("updates"));
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
    setUpdateDialogBusy(true);
    renderUpdateProgress({
      phase: "checking",
      downloadedBytes: 0,
      totalBytes: updatePlan.asset?.size || 0,
      percent: 0,
    });
    showToast("正在下载更新包，完成后会退出并自动重启。");
    try {
      const result = await api.installUpdate();
      renderUpdateProgress({
        phase: "restarting",
        downloadedBytes: updatePlan.asset?.size || 0,
        totalBytes: updatePlan.asset?.size || 0,
        percent: 100,
      });
      showToast(result.message || "更新已开始，CodexBridge 将自动重启。");
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

api.onLogs((logs) => renderLogs(logs));
api.onUpdateProgress?.((progress) => renderUpdateProgress(progress));
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
  els.rootDir.textContent = state.rootDir;
  els.selectedCount.textContent = String(draftSelection.length);
  els.maxModels.textContent = String(state.maxModels || 5);
  const keySummary = keySummaryInfo();
  els.keySummary.textContent = keySummary.text;
  els.keySummaryDetail.textContent = keySummary.detail;
  els.bypassSystemProxy.checked = Boolean(state.desktopOptions?.bypassSystemProxy);

  document.querySelectorAll(".mode-card").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  });

  renderRouterToggle();
  renderHealthStatus();
  renderProviders();
  renderSelectedModels();
  renderModelPool();
  renderCustomFormState();
  renderUsage();
  renderOverviewUsage();
  renderLogs(state.logs || []);
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
  els.healthStatus.textContent = health.ok
    ? `Router 健康检查通过：${health.models?.length || 0} 个模型已加载${checkedAt}`
    : `Router 健康检查失败：${health.message || "未知错误"}${checkedAt}`;
}

function renderRouterToggle() {
  els.routerToggle.classList.toggle("running", Boolean(state.routerRunning));
  els.routerToggle.setAttribute("aria-pressed", state.routerRunning ? "true" : "false");
  els.routerToggle.querySelector("strong").textContent = state.routerRunning ? "Router 运行中" : "Router 已关闭";
  els.routerToggle.querySelector("small").textContent = state.routerRunning ? "点击关闭本地网关" : "点击启动本地网关";
}

function renderProviders() {
  const cards = state.providers.map((provider) => {
    const saved = provider.keyEnv ? Boolean(state.secretStatus?.[provider.keyEnv]) : true;
    const status = provider.keyEnv ? (saved ? "已保存" : "未保存") : "无需 Key";
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
    return `
      <article class="provider-card" data-provider-id="${escapeHtml(provider.id)}">
        <div class="provider-head">
          <div>
            <h3>${escapeHtml(provider.name)}</h3>
            <p>${escapeHtml(provider.description || "")}</p>
          </div>
          <span class="tag ${saved ? "ok" : ""}">${status}</span>
        </div>
        ${keyControl}
        <div class="provider-actions">
          ${saveButton}
          ${keyButton}
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
}

function saveProviderSecret(button) {
  return runAction(button, async () => {
    const card = button.closest(".provider-card");
    const input = card.querySelector("[data-key-env]");
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
  els.selectedModels.innerHTML = (state.modelSlots || [])
    .map((slot, index) => {
      const model = modelsById.get(draftSelection[index]);
      return `
        <div class="slot-card ${model ? "filled" : ""}" draggable="${model ? "true" : "false"}" data-slot-index="${index}">
          <span>${escapeHtml(slot.label)}</span>
          <strong>${model ? escapeHtml(model.displayName) : "未选择"}</strong>
          <small>${model ? escapeHtml(providerName(model.providerId)) : "拖动已选模型到这里可调整顺序"}</small>
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
      showToast("顺序已调整，点“保存选择”后写入 Codex 模型栏。");
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

function renderModelPool() {
  const selected = new Set(draftSelection);
  const max = Number(state.maxModels || 5);
  const grouped = groupByProvider(state.modelPresets || []);
  els.modelPool.innerHTML = grouped
    .map(([providerId, models]) => {
      const provider = providerFor(providerId);
      return `
        <section class="model-group">
          <div class="model-group-title">
            <h3>${escapeHtml(provider?.name || providerId)}</h3>
            <span>${models.length} 个模型</span>
          </div>
          <div class="model-card-grid">
            ${models.map((model) => modelCard(model, selected, max)).join("")}
          </div>
        </section>
      `;
    })
    .join("");

  els.modelPool.querySelectorAll("[data-model-id]").forEach((button) => {
    button.addEventListener("click", () => toggleModel(button.dataset.modelId));
  });
  els.modelPool.querySelectorAll("[data-image-input-toggle]").forEach((button) => {
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
  els.modelPool.querySelectorAll("[data-image-gen-mode]").forEach((select) => {
    select.addEventListener("click", (event) => event.stopPropagation());
    select.addEventListener("change", () => {
      renderImageGenerationPanelMode(select.closest("[data-image-gen-config]"));
    });
  });
  els.modelPool.querySelectorAll("[data-image-gen-save]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      saveImageGenerationSettings(button);
    });
  });
  els.modelPool.querySelectorAll("[data-image-gen-toggle-secret]").forEach((button) => {
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
  els.modelPool.querySelectorAll("[data-edit-custom]").forEach((button) => {
    button.addEventListener("click", () => startCustomModelEdit(button.dataset.editCustom));
  });
  els.modelPool.querySelectorAll("[data-remove-custom]").forEach((button) => {
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

function modelCard(model, selected, max) {
  const isSelected = selected.has(model.presetId);
  const supportsImage = modelSupportsImage(model);
  const isNativeDisabled = state.mode === "all_api" && model.authMode === "codex_openai";
  const isMaxed = !isSelected && draftSelection.length >= max;
  const disabled = isNativeDisabled || isMaxed;
  const reason = isNativeDisabled
    ? "全部 API 模式不能选择订阅模型"
    : isMaxed
      ? "已选满 5 个"
      : providerName(model.providerId);
  return `
    <div class="model-card-shell">
      <button class="model-card ${isSelected ? "selected" : ""}" data-model-id="${escapeHtml(model.presetId)}" ${disabled ? "disabled" : ""}>
        <span class="model-title">${escapeHtml(model.displayName)}</span>
        <span class="model-meta">${escapeHtml(model.model)} · ${escapeHtml(model.api)}</span>
        <span class="model-foot">${escapeHtml(reason)}</span>
      </button>
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
      ${imageGenerationControl(model)}
      ${
        model.custom
          ? `<div class="model-card-actions">
              <button class="text-button edit-model" data-edit-custom="${escapeHtml(model.presetId)}">编辑</button>
              <button class="text-button remove-model" data-remove-custom="${escapeHtml(model.presetId)}">删除</button>
            </div>`
          : ""
      }
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

function modelSupportsImage(model) {
  return Array.isArray(model?.inputModalities) && model.inputModalities.includes("image");
}

function toggleModel(presetId) {
  const max = Number(state.maxModels || 5);
  if (draftSelection.includes(presetId)) {
    draftSelection = draftSelection.filter((id) => id !== presetId);
  } else if (draftSelection.length < max) {
    draftSelection = [...draftSelection, presetId];
  } else {
    showToast("Codex 模型栏最多只能显示 5 个。", "error");
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

function startCustomModelEdit(presetId) {
  const model = modelMap().get(presetId);
  if (!model?.custom) {
    showToast("没有找到这个自定义模型。", "error");
    return;
  }
  editingCustomPresetId = presetId;
  setValue("#customProviderName", model.providerName || providerName(model.providerId));
  setValue("#customDisplayName", model.displayName || "");
  setValue("#customModelName", model.model || "");
  setValue("#customBaseUrl", model.baseUrl || "");
  setValue("#customKeyUrl", model.keyUrl || "");
  setValue("#customApiType", model.api === "responses" ? "responses" : "chat_completions");
  els.customImageInput.checked = modelSupportsImage(model);
  renderCustomFormState();
  els.customModelForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetCustomModelForm() {
  editingCustomPresetId = null;
  els.customModelForm.reset();
  renderCustomFormState();
}

function renderCustomFormState() {
  const editing = Boolean(editingCustomPresetId);
  els.customFormTitle.textContent = editing ? "编辑自定义模型" : "添加自定义模型";
  els.customFormDescription.textContent = editing
    ? "修改后会覆盖当前自定义模型，并保留原来的 API Key 槽位。"
    : "用于接入任何 OpenAI-compatible 服务商。显示名给 Codex 看，真实模型名发给服务商。";
  els.customSubmitButton.textContent = editing ? "保存修改" : "添加模型";
  els.cancelCustomEdit.classList.toggle("hidden", !editing);
}

function renderUsage() {
  const summary = state.usageSummary || emptyUsageSummary();
  const events = state.usageEvents || [];
  els.statCalls.textContent = formatNumber(summary.totalCalls || 0);
  els.statTokens.textContent = formatNumber(summary.totalTokens || 0);
  els.statPrompt.textContent = formatNumber(summary.promptTokens || 0);
  els.statCompletion.textContent = formatNumber(summary.completionTokens || 0);
  renderUsageChart(summary.byModel || []);
  renderUsageTableStable(summary.byModel || [], events);
}

function renderOverviewUsage() {
  const latest = state.usageSummary?.latest;
  if (!latest) {
    els.latestUsage.textContent = "暂无";
    return;
  }
  els.latestUsage.textContent = `${displayRoute(latest.route || latest.codexModel)} · ${latest.status || "unknown"} · ${formatNumber(latest.totalTokens || 0)} token`;
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
      return `
        <div class="usage-bar">
          <div class="usage-bar-head">
            <strong>${escapeHtml(displayRoute(row.route))}</strong>
            <span>${escapeHtml(row.upstreamModel || "-")} · ${label}</span>
          </div>
          <div class="bar-track"><span class="w-${width}"></span></div>
        </div>
      `;
    })
    .join("");
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
              <span>${formatNumber(row.promptTokens)}</span>
              <span>${formatNumber(row.completionTokens)}</span>
              <span>${formatNumber(row.totalTokens)}</span>
              <span>${row.errors ? `${row.errors} 错误：${escapeHtml(row.lastError || row.lastStatus || "")}` : row.lastStatus || "-"}</span>
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
              <span>${event.status && event.status >= 400 ? `${event.status} ${escapeHtml(event.error || "")}` : event.status || "-"}</span>
              <span>${formatNumber(event.promptTokens)}</span>
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
      <span>当前显示名</span><span>实际上游模型</span><span>接口</span><span>次数</span><span>输入</span><span>输出</span><span>总量</span><span>状态</span><span>最近时间</span>
    </div>
    <div class="usage-grid">${modelRows}</div>
    <h3>最近请求</h3>
    <div class="usage-grid header">
      <span>当前显示名</span><span>实际上游模型</span><span>接口</span><span>状态</span><span>输入</span><span>输出</span><span>总量</span><span>耗时</span><span>时间</span>
    </div>
    <div class="usage-grid">${eventRows}</div>
  `;
}

function renderUsageTableStable(rows, events) {
  const modelRows = rows.length
    ? rows
        .map(
          (row) => `
            <div class="usage-row">
              <span>${escapeHtml(displayRoute(row.route))}</span>
              <span>${escapeHtml(row.upstreamModel || "-")}</span>
              <span>${escapeHtml(row.api || "-")}</span>
              <span>${formatNumber(row.calls)}</span>
              <span>${formatNumber(row.promptTokens)}</span>
              <span>${formatNumber(row.completionTokens)}</span>
              <span>${formatNumber(row.totalTokens)}</span>
              <span>${row.errors ? `${row.errors} 错误：${escapeHtml(row.lastError || row.lastStatus || "")}` : row.lastStatus || "-"}</span>
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
              <span>${event.status && event.status >= 400 ? `${event.status} ${escapeHtml(event.error || "")}` : event.status || "-"}</span>
              <span>${formatNumber(event.promptTokens)}</span>
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
    <div class="usage-table-block">
      <div class="usage-grid">
        <div class="usage-row header">
          <span>当前显示名</span><span>实际上游模型</span><span>接口</span><span>次数</span><span>输入</span><span>输出</span><span>总量</span><span>状态</span><span>最近时间</span>
        </div>
        ${modelRows}
      </div>
    </div>
    <h3>最近请求</h3>
    <div class="usage-table-block">
      <div class="usage-grid">
        <div class="usage-row header">
          <span>当前显示名</span><span>实际上游模型</span><span>接口</span><span>状态</span><span>输入</span><span>输出</span><span>总量</span><span>耗时</span><span>时间</span>
        </div>
        ${eventRows}
      </div>
    </div>
  `;
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

function showUpdateDialog(updatePlan) {
  return new Promise((resolve) => {
    els.updateDialogVersion.textContent = `v${updatePlan.latestVersion || ""}`;
    els.updateDialogMessage.textContent =
      "下载完成后会退出当前程序、替换目录并自动重启。";
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
  els.confirmUpdate.textContent = isBusy ? "更新中..." : "下载并重启";
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
  const isIndeterminate = !hasKnownSize && progress.phase !== "error" && progress.phase !== "restarting";
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
  if (phase === "restarting") {
    return "下载完成，正在重启并替换程序...";
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
    completionTokens: 0,
    statusCounts: {},
    byModel: [],
    latest: null,
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

function providerFor(providerId) {
  return (state.providers || []).find((provider) => provider.id === providerId);
}

function providerName(providerId) {
  return providerFor(providerId)?.shortName || providerFor(providerId)?.name || providerId || "-";
}

function modelMap() {
  return new Map((state.modelPresets || []).map((model) => [model.presetId, model]));
}

function displayRoute(route) {
  const configured = (state.models || []).find((item) => item.id === route);
  if (configured?.displayName) {
    return configured.displayName;
  }
  const slot = (state.modelSlots || []).find((item) => item.id === route);
  return slot?.label || route || "-";
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
