const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexBridge", {
  getState: () => ipcRenderer.invoke("state:get"),
  selectMode: (mode) => ipcRenderer.invoke("mode:select", mode),
  saveSecrets: (secrets) => ipcRenderer.invoke("secrets:save", secrets),
  saveModelSelection: (selectedModelIds) => ipcRenderer.invoke("models:saveSelection", selectedModelIds),
  saveCustomModel: (model) => ipcRenderer.invoke("customModel:save", model),
  removeCustomModel: (presetId) => ipcRenderer.invoke("customModel:remove", presetId),
  generateCatalog: () => ipcRenderer.invoke("catalog:generate"),
  applyCodexConfig: () => ipcRenderer.invoke("codex:apply"),
  initializeCodex: () => ipcRenderer.invoke("codex:initialize"),
  restartCodex: () => ipcRenderer.invoke("codex:restart"),
  startRouter: () => ipcRenderer.invoke("router:start"),
  stopRouter: () => ipcRenderer.invoke("router:stop"),
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
});
