const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexBridge", {
  getState: (options) => ipcRenderer.invoke("state:get", options || {}),
  selectMode: (mode) => ipcRenderer.invoke("mode:select", mode),
  saveSecrets: (secrets) => ipcRenderer.invoke("secrets:save", secrets),
  getSecret: (keyEnv) => ipcRenderer.invoke("secrets:get", keyEnv),
  saveOptions: (options) => ipcRenderer.invoke("options:save", options),
  runStartupCheck: () => ipcRenderer.invoke("startup:check"),
  saveModelSelection: (selectedModelIds) => ipcRenderer.invoke("models:saveSelection", selectedModelIds),
  saveModelImageInput: (payload) => ipcRenderer.invoke("models:saveImageInput", payload),
  saveModelImageGeneration: (payload) => ipcRenderer.invoke("models:saveImageGeneration", payload),
  saveImageProvider: (payload) => ipcRenderer.invoke("imageProviders:save", payload),
  removeImageProvider: (providerId) => ipcRenderer.invoke("imageProviders:remove", providerId),
  testImageProvider: (payload) => ipcRenderer.invoke("imageProviders:test", payload),
  clearImageGenerationHistory: (payload) => ipcRenderer.invoke("imageHistory:clear", payload),
  saveCapabilityProvider: (payload) => ipcRenderer.invoke("capabilityProviders:save", payload),
  removeCapabilityProvider: (providerId) => ipcRenderer.invoke("capabilityProviders:remove", providerId),
  testCapabilityProvider: (payload) => ipcRenderer.invoke("capabilityProviders:test", payload),
  executeCapabilityProvider: (payload) => ipcRenderer.invoke("capabilityProviders:execute", payload),
  clearCapabilityExecutionHistory: (payload) => ipcRenderer.invoke("capabilityHistory:clear", payload),
  saveModelCapabilities: (payload) => ipcRenderer.invoke("models:saveCapabilities", payload),
  resetModelCapabilities: (presetId) => ipcRenderer.invoke("models:resetCapabilities", presetId),
  refreshProviderModels: (providerId) => ipcRenderer.invoke("providers:refreshModels", providerId),
  saveProvider: (payload) => ipcRenderer.invoke("providers:save", payload),
  resetProvider: (providerId) => ipcRenderer.invoke("providers:reset", providerId),
  testProviderConnection: (payload) => ipcRenderer.invoke("providers:testConnection", payload),
  repairModelReferences: () => ipcRenderer.invoke("models:repairReferences"),
  selectLocalLogo: (payload) => ipcRenderer.invoke("logos:select", payload),
  saveCustomModel: (model) => ipcRenderer.invoke("customModel:save", model),
  removeCustomModel: (presetId) => ipcRenderer.invoke("customModel:remove", presetId),
  saveConfigProfile: (payload) => ipcRenderer.invoke("profiles:save", payload),
  applyConfigProfile: (profileId) => ipcRenderer.invoke("profiles:apply", profileId),
  exportConfigPackage: () => ipcRenderer.invoke("configPackage:export"),
  exportConfigPackageToSyncDir: () => ipcRenderer.invoke("configPackage:exportToSyncDir"),
  importLatestConfigPackageFromSyncDir: () => ipcRenderer.invoke("configPackage:importLatestFromSyncDir"),
  importConfigPackage: () => ipcRenderer.invoke("configPackage:import"),
  restoreLatestConfigPackageBackup: () => ipcRenderer.invoke("configPackage:restoreLatestImportBackup"),
  setCodexResourceEnabled: (payload) => ipcRenderer.invoke("resource:setEnabled", payload),
  updateCodexResource: (payload) => ipcRenderer.invoke("resource:update", payload),
  removeCodexResource: (payload) => ipcRenderer.invoke("resource:remove", payload),
  refreshCodexPluginMarketplaces: () => ipcRenderer.invoke("resource:refreshMarketplaces"),
  restoreCodexBackup: (backupPath) => ipcRenderer.invoke("backups:restore", backupPath),
  exportSessionMarkdown: (sessionId) => ipcRenderer.invoke("sessions:export", sessionId),
  exportProjectMarkdown: (projectKey) => ipcRenderer.invoke("sessions:exportProject", projectKey),
  exportLooseSessionsMarkdown: () => ipcRenderer.invoke("sessions:exportLoose"),
  exportAllSessionsMarkdown: () => ipcRenderer.invoke("sessions:exportAll"),
  exportFilteredSessionsMarkdown: (payload) => ipcRenderer.invoke("sessions:exportFiltered", payload),
  generateCatalog: () => ipcRenderer.invoke("catalog:generate"),
  applyCodexConfig: () => ipcRenderer.invoke("codex:apply"),
  initializeCodex: () => ipcRenderer.invoke("codex:initialize"),
  restoreCodexConfig: () => ipcRenderer.invoke("codex:restore"),
  restartCodex: () => ipcRenderer.invoke("codex:restart"),
  selectCodexDesktopExe: () => ipcRenderer.invoke("codex:select-exe"),
  previewHistoryRecovery: () => ipcRenderer.invoke("codex:history-recovery-preview"),
  recoverHistoryAccess: (options = {}) => ipcRenderer.invoke("codex:recover-history", options),
  historyRecoveryStatus: () => ipcRenderer.invoke("codex:history-recovery-status"),
  recoverCodexProjects: () => ipcRenderer.invoke("codex:recover-projects"),
  startRouter: () => ipcRenderer.invoke("router:start"),
  stopRouter: () => ipcRenderer.invoke("router:stop"),
  getDoubleQuotaState: () => ipcRenderer.invoke("doubleQuota:getState"),
  saveDoubleQuotaPort: (port) => ipcRenderer.invoke("doubleQuota:savePort", port),
  startDoubleQuota: () => ipcRenderer.invoke("doubleQuota:start"),
  restartDoubleQuota: () => ipcRenderer.invoke("doubleQuota:restart"),
  stopDoubleQuota: () => ipcRenderer.invoke("doubleQuota:stop"),
  openDoubleQuota: () => ipcRenderer.invoke("doubleQuota:open"),
  prepareDoubleQuotaExtension: () => ipcRenderer.invoke("doubleQuota:prepareExtension"),
  manageDoubleQuotaExtension: () => ipcRenderer.invoke("doubleQuota:manageExtension"),
  openDoubleQuotaExtensionManager: () => ipcRenderer.invoke("doubleQuota:openExtensionManager"),
  repairDoubleQuotaMcp: () => ipcRenderer.invoke("doubleQuota:repairMcp"),
  copyDiagnostics: () => ipcRenderer.invoke("diagnostics:copy"),
  saveDiagnostics: () => ipcRenderer.invoke("diagnostics:save"),
  selectAcceptanceReleaseDir: () => ipcRenderer.invoke("acceptance:select-release-dir"),
  saveAcceptanceReport: () => ipcRenderer.invoke("acceptance:save"),
  saveReleaseGateReport: () => ipcRenderer.invoke("releaseGate:save"),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  openFolder: (target) => ipcRenderer.invoke("folder:open", target),
  revealFile: (target) => ipcRenderer.invoke("file:reveal", target),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  openGitHub: () => ipcRenderer.invoke("github:open"),
  softwareManagerPlatform: process.platform,
  getSoftwareManagerSnapshot: () => ipcRenderer.invoke("softwareManager:getSnapshot"),
  selectSoftwareManagerInstallRoot: () => ipcRenderer.invoke("softwareManager:selectInstallRoot"),
  refreshSoftwareManager: () => ipcRenderer.invoke("softwareManager:refresh"),
  startSoftwareManagerTask: (request) => ipcRenderer.invoke("softwareManager:startTask", request),
  cancelSoftwareManagerTask: () => ipcRenderer.invoke("softwareManager:cancelTask"),
  onSoftwareManagerEvent: (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("A software manager event callback is required.");
    }
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("softwareManager:event", listener);
    return () => ipcRenderer.removeListener("softwareManager:event", listener);
  },
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
  onNavigate: (callback) => {
    ipcRenderer.on("ui:navigate", (_event, payload) => callback(payload));
  },
});
