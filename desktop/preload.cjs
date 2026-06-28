const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexBridge", {
  getState: () => ipcRenderer.invoke("state:get"),
  selectMode: (mode) => ipcRenderer.invoke("mode:select", mode),
  saveSecrets: (secrets) => ipcRenderer.invoke("secrets:save", secrets),
  getSecret: (keyEnv) => ipcRenderer.invoke("secrets:get", keyEnv),
  saveOptions: (options) => ipcRenderer.invoke("options:save", options),
  saveModelSelection: (selectedModelIds) => ipcRenderer.invoke("models:saveSelection", selectedModelIds),
  saveModelImageInput: (payload) => ipcRenderer.invoke("models:saveImageInput", payload),
  saveModelImageGeneration: (payload) => ipcRenderer.invoke("models:saveImageGeneration", payload),
  saveModelCapabilities: (payload) => ipcRenderer.invoke("models:saveCapabilities", payload),
  refreshProviderModels: (providerId) => ipcRenderer.invoke("providers:refreshModels", providerId),
  saveCustomModel: (model) => ipcRenderer.invoke("customModel:save", model),
  removeCustomModel: (presetId) => ipcRenderer.invoke("customModel:remove", presetId),
  generateCatalog: () => ipcRenderer.invoke("catalog:generate"),
  applyCodexConfig: () => ipcRenderer.invoke("codex:apply"),
  initializeCodex: () => ipcRenderer.invoke("codex:initialize"),
  restoreCodexConfig: () => ipcRenderer.invoke("codex:restore"),
  recoverHistoryAccess: () => ipcRenderer.invoke("codex:recover-history"),
  startRouter: () => ipcRenderer.invoke("router:start"),
  stopRouter: () => ipcRenderer.invoke("router:stop"),
  copyDiagnostics: () => ipcRenderer.invoke("diagnostics:copy"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  openFolder: (target) => ipcRenderer.invoke("folder:open", target),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  openGitHub: () => ipcRenderer.invoke("github:open"),
  onLogs: (callback) => {
    ipcRenderer.on("logs:update", (_event, logs) => callback(logs));
  },
  onState: (callback) => {
    ipcRenderer.on("state:update", (_event, state) => callback(state));
  },
  onUsage: (callback) => {
    ipcRenderer.on("usage:update", (_event, usage) => callback(usage));
  },
  onUpdateProgress: (callback) => {
    ipcRenderer.on("updates:progress", (_event, progress) => callback(progress));
  },
  onUpdateFinished: (callback) => {
    ipcRenderer.on("updates:finished", (_event, result) => callback(result));
  },
});
