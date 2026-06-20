const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexBridge", {
  getState: () => ipcRenderer.invoke("state:get"),
  selectMode: (mode) => ipcRenderer.invoke("mode:select", mode),
  saveSecrets: (secrets) => ipcRenderer.invoke("secrets:save", secrets),
  generateCatalog: () => ipcRenderer.invoke("catalog:generate"),
  applyCodexConfig: () => ipcRenderer.invoke("codex:apply"),
  startRouter: () => ipcRenderer.invoke("router:start"),
  stopRouter: () => ipcRenderer.invoke("router:stop"),
  openFolder: (target) => ipcRenderer.invoke("folder:open", target),
  openGitHub: () => ipcRenderer.invoke("github:open"),
  onLogs: (callback) => {
    ipcRenderer.on("logs:update", (_event, logs) => callback(logs));
  },
  onState: (callback) => {
    ipcRenderer.on("state:update", (_event, state) => callback(state));
  },
});

