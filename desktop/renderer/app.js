const api = window.codexBridge;
let state = null;

const els = {
  routerStatus: document.querySelector("#routerStatus"),
  modeStatus: document.querySelector("#modeStatus"),
  rootDir: document.querySelector("#rootDir"),
  modelCount: document.querySelector("#modelCount"),
  keySummary: document.querySelector("#keySummary"),
  modelTable: document.querySelector("#modelTable"),
  logOutput: document.querySelector("#logOutput"),
  fennoKey: document.querySelector("#fennoKey"),
  deepseekKey: document.querySelector("#deepseekKey"),
  moonshotKey: document.querySelector("#moonshotKey"),
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
  button.addEventListener("click", async () => {
    await api.selectMode(button.dataset.mode);
    await refresh();
  });
});

document.querySelector("#saveSecrets").addEventListener("click", async () => {
  await api.saveSecrets({
    FENNO_API_KEY: els.fennoKey.value,
    DEEPSEEK_API_KEY: els.deepseekKey.value,
    MOONSHOT_API_KEY: els.moonshotKey.value,
  });
  clearSecretInputs();
  await refresh();
});

document.querySelector("#generateCatalog").addEventListener("click", async () => {
  await api.generateCatalog();
  await refresh();
});

document.querySelector("#applyCodex").addEventListener("click", async () => {
  await api.applyCodexConfig();
  await refresh();
});

document.querySelector("#startRouter").addEventListener("click", async () => {
  await api.startRouter();
  await refresh();
});

document.querySelector("#stopRouter").addEventListener("click", async () => {
  await api.stopRouter();
  await refresh();
});

document.querySelector("#openConfigFolder").addEventListener("click", () => api.openFolder("config"));
document.querySelector("#openCodexFolder").addEventListener("click", () => api.openFolder("codex"));
document.querySelector("#openGitHub").addEventListener("click", () => api.openGitHub());

api.onLogs((logs) => renderLogs(logs));
api.onState((nextState) => {
  state = nextState;
  render();
});

refresh();

async function refresh() {
  state = await api.getState();
  render();
}

function render() {
  if (!state) {
    return;
  }

  els.routerStatus.textContent = state.routerRunning ? "Router 运行中" : "Router 未启动";
  els.routerStatus.classList.toggle("muted", !state.routerRunning);
  els.modeStatus.textContent = state.mode === "hybrid" ? "混合模式" : "全部 API";
  els.rootDir.textContent = state.rootDir;
  els.modelCount.textContent = String(state.models.length);
  els.keySummary.textContent = summarizeKeys(state.secretStatus);

  document.querySelectorAll(".mode-card").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  });

  renderModels(state.models);
  renderLogs(state.logs || []);
}

function renderModels(models) {
  const rows = [
    `<div class="model-row header"><span>显示名称</span><span>路由</span><span>真实模型</span><span>认证</span></div>`,
    ...models.map((model) => {
      const auth = model.authMode === "codex_openai" ? "订阅" : "API Key";
      return `
        <div class="model-row">
          <span><span class="model-name">${escapeHtml(model.displayName)}</span><br><small>${escapeHtml(model.description || "")}</small></span>
          <span class="tag">${escapeHtml(model.id)}</span>
          <span>${escapeHtml(model.model)}</span>
          <span class="tag">${auth}</span>
        </div>
      `;
    }),
  ];
  els.modelTable.innerHTML = rows.join("");
}

function renderLogs(logs) {
  els.logOutput.textContent = logs.length ? logs.join("\n") : "暂无日志。启动 Router 后，这里会显示请求流向。";
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

function summarizeKeys(status = {}) {
  const ready = Object.values(status).filter(Boolean).length;
  return `${ready}/3 已保存`;
}

function clearSecretInputs() {
  els.fennoKey.value = "";
  els.deepseekKey.value = "";
  els.moonshotKey.value = "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

