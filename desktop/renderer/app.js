const api = window.codexBridge;
let state = null;
let draftSelection = [];
let dragSlotIndex = null;
let editingCustomPresetId = null;

const els = {
  routerStatus: document.querySelector("#routerStatus"),
  modeStatus: document.querySelector("#modeStatus"),
  rootDir: document.querySelector("#rootDir"),
  selectedCount: document.querySelector("#selectedCount"),
  maxModels: document.querySelector("#maxModels"),
  keySummary: document.querySelector("#keySummary"),
  keySummaryDetail: document.querySelector("#keySummaryDetail"),
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
  cancelCustomEdit: document.querySelector("#cancelCustomEdit"),
  routerToggle: document.querySelector("#routerToggle"),
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

document.querySelector("#recoverHistoryAccess").addEventListener("click", (event) =>
  runAction(event.currentTarget, async () => {
    const result = await api.recoverHistoryAccess();
    await refresh();
    showToast(result?.message || "已恢复 CodexBridge 写入前的 Codex 配置。请重启 Codex 查看历史对话。");
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
      inputModalities: editingModel?.inputModalities,
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
document.querySelector("#openGitHub").addEventListener("click", () => api.openGitHub());

api.onLogs((logs) => renderLogs(logs));
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
  els.rootDir.textContent = state.rootDir;
  els.selectedCount.textContent = String(draftSelection.length);
  els.maxModels.textContent = String(state.maxModels || 5);
  const keySummary = keySummaryInfo();
  els.keySummary.textContent = keySummary.text;
  els.keySummaryDetail.textContent = keySummary.detail;

  document.querySelectorAll(".mode-card").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  });

  renderRouterToggle();
  renderProviders();
  renderSelectedModels();
  renderModelPool();
  renderCustomFormState();
  renderUsage();
  renderOverviewUsage();
  renderLogs(state.logs || []);
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
