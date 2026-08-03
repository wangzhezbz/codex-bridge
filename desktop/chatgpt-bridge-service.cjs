const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const SERVICE_NAME = "chatgpt-codex-bridge";
const PROTOCOL_VERSION = 1;
const DEFAULT_PORT = 4317;
const EXTENSION_MANAGER_REVISION = "verified-stable-dir-v2";

function createChatgptBridgeService({
  appRootDir,
  dataRootDir,
  execPath = process.execPath,
  homeDir = process.env.USERPROFILE || process.env.HOME || "",
  chromeUserDataDir = defaultChromeUserDataDir(),
  spawnImpl = spawn,
  requestJson = requestJsonOverHttp,
  stopTimeoutMs = 5000,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
} = {}) {
  if (!appRootDir || !dataRootDir) {
    throw new Error("ChatGPT Bridge requires appRootDir and dataRootDir.");
  }

  const vendorDir = path.join(appRootDir, "vendor", "chatgpt-codex-bridge");
  const manifestPath = path.join(vendorDir, "embedded-manifest.json");
  const configPath = path.join(dataRootDir, "config", "double-quota.json");
  const bridgeDataDir = path.join(dataRootDir, "chatgpt-bridge");
  const extensionDir = path.join(dataRootDir, "extensions", "chatgpt-codex-bridge");
  const legacyExtensionDir = path.join(dataRootDir, "chatgpt-bridge-extension");
  const extensionDeploymentReceiptPath = path.join(bridgeDataDir, "extension-deployment.json");
  const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
  const manifest = readAndValidateManifest(manifestPath);
  const extensionManifest = readExtensionManifest(path.join(vendorDir, "chrome-extension", "manifest.json"));
  let child = null;
  let ownedRuntime = null;
  let lifecycleStatus = "";
  let lastError = "";
  let lastExtensionError = "";
  let lastExtensionDeployment = readExtensionDeploymentReceipt(
    extensionDeploymentReceiptPath,
    extensionDir,
  );

  function loadConfig() {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      saved = {};
    }
    const savedApiToken = String(saved.apiToken || saved.authToken || "");
    const config = {
      port: validPort(saved.port) ? Number(saved.port) : Number(manifest.defaults?.port || DEFAULT_PORT),
      apiToken: /^[a-f0-9]{64}$/.test(savedApiToken)
        ? savedApiToken
        : crypto.randomBytes(32).toString("hex"),
    };
    if (config.apiToken !== saved.apiToken || config.port !== saved.port || saved.authToken) {
      saveConfig(config);
    }
    return config;
  }

  function saveConfig(config) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  function runtimeInfo(portOverride = NaN) {
    const config = loadConfig();
    const port = validPort(portOverride) ? Number(portOverride) : config.port;
    const host = String(manifest.defaults?.host || "127.0.0.1");
    const origin = `http://${host}:${port}`;
    return {
      config: { ...config, port },
      host,
      origin,
      url: `${origin}/`,
      httpEntry: path.join(vendorDir, manifest.entrypoints.http),
      mcpEntry: path.join(appRootDir, "desktop", "chatgpt-bridge-mcp-entry.mjs"),
      healthUrl: `${origin}${manifest.healthPath || "/health"}`,
      versionUrl: `${origin}${manifest.versionPath || "/version"}`,
      diagnosticsUrl: `${origin}/api/diagnostics/status`,
    };
  }

  function serviceRuntimeInfo() {
    return child && validPort(ownedRuntime?.port)
      ? runtimeInfo(ownedRuntime.port)
      : runtimeInfo();
  }

  async function probe(info = serviceRuntimeInfo()) {
    const response = await requestJson(info.healthUrl, { timeoutMs: 1200 });
    if (!response) {
      return { reachable: false, compatible: false, response: null };
    }
    return {
      reachable: true,
      compatible:
        response.ok === true &&
        response.service === SERVICE_NAME &&
        Number(response.protocolVersion) === PROTOCOL_VERSION &&
        response.status === "ready",
      response,
    };
  }

  async function probeVersion(info = serviceRuntimeInfo()) {
    const response = await requestJson(info.versionUrl, { timeoutMs: 1200 });
    if (!response) {
      return { reachable: false, compatible: false, response: null };
    }
    return {
      reachable: true,
      compatible:
        response.service === SERVICE_NAME &&
        Number(response.protocolVersion) === PROTOCOL_VERSION &&
        String(response.version || "") === String(manifest.version || "") &&
        Boolean(String(response.extensionProtocolVersion || "").trim()),
      response,
    };
  }

  async function probeDiagnostics(info = serviceRuntimeInfo()) {
    const response = await requestJson(info.diagnosticsUrl, {
      timeoutMs: 1800,
      headers: { "X-Bridge-Token": info.config.apiToken },
    });
    return response && typeof response === "object"
      ? { reachable: true, response }
      : { reachable: false, response: null };
  }

  async function getState() {
    const configuredInfo = runtimeInfo();
    const info = serviceRuntimeInfo();
    const [health, versionStatus, diagnosticsStatus] = await Promise.all([
      probe(),
      probeVersion(),
      probeDiagnostics(),
    ]);
    const ownedProcess = Boolean(child);
    const versionMismatch = health.compatible && versionStatus.reachable && !versionStatus.compatible;
    const status = lifecycleStatus === "stopping"
      ? "stopping"
      : versionMismatch
        ? "version_mismatch"
        : health.compatible
          ? ownedProcess ? "running" : "attached"
          : ownedProcess || lifecycleStatus === "starting" ? "starting" : lastError ? "error" : "stopped";
    const extensionSourceDir = path.join(vendorDir, manifest.extensionDir || "chrome-extension");
    const extensionConfigSource = bridgeExtensionConfigSource(info.origin, info.config.apiToken);
    const extensionDisk = extensionDirectoryStatus(extensionDir, {
      sourceDir: extensionSourceDir,
      configSource: extensionConfigSource,
      expectedManifest: extensionManifest,
    });
    const extensionFiles = extensionDisk;
    const chromeInstallations = discoverChromeBridgeExtensionInstallations(chromeUserDataDir);
    const extensionDiagnostics = diagnosticsStatus.response?.extension || {};
    const extensionRegisteredDirs = uniqueResolvedPaths(
      chromeInstallations.map((entry) => entry.path),
    );
    const extensionChromeIds = [...new Set(chromeInstallations.map((entry) => entry.id).filter(Boolean))];
    const registeredStable = extensionRegisteredDirs.some(
      (candidate) => sameResolvedPath(candidate, extensionDir),
    );
    const extensionBrowser = {
      status: registeredStable
        ? "registered_current_path"
        : extensionRegisteredDirs.length > 0
          ? "registered_other_path"
          : "not_registered",
      registeredStable,
      registrations: chromeInstallations,
      registeredDirs: extensionRegisteredDirs,
    };
    const expectedExtensionProtocol =
      extensionDiagnostics.expectedVersion ||
      versionStatus.response?.extensionProtocolVersion ||
      "";
    const extensionRuntimeObservable = health.compatible && diagnosticsStatus.reachable;
    const extensionRuntime = extensionRuntimeStatus(
      extensionDiagnostics,
      expectedExtensionProtocol,
      {
        observable: extensionRuntimeObservable,
        serviceRunning: health.compatible,
      },
    );
    const extensionInstallation = extensionInstallationStatus({
      diskStatus: extensionDisk.status,
      diskVerified: extensionDisk.verified,
      browserStatus: extensionBrowser.status,
      registeredStable,
      runtimeStatus: extensionRuntime.status,
    });
    const activeBridgeTask = activeBridgeTaskFromDiagnostics(diagnosticsStatus.response);
    const extensionUpdateDirs = [path.resolve(extensionDir)];
    const extensionAction = extensionManagementAction({
      ...extensionDiagnostics,
      expectedVersion: expectedExtensionProtocol,
      diskStatus: extensionDisk.status,
      diskVerified: extensionDisk.verified,
      registeredStable,
      runtimeObservable: extensionRuntimeObservable,
    });
    lastExtensionDeployment =
      readExtensionDeploymentReceipt(extensionDeploymentReceiptPath, extensionDir) ||
      lastExtensionDeployment;
    return {
      available: true,
      status,
      running: health.compatible,
      ownedProcess,
      externalProcess: health.compatible && !ownedProcess,
      compatible: health.compatible,
      health: health.response,
      serviceVersion: versionStatus.response?.version || health.response?.version || manifest.version,
      extensionProtocolVersion: versionStatus.response?.extensionProtocolVersion || "",
      extensionManifestVersion: extensionManifest.version,
      extensionDisplayVersion: extensionManifest.versionName,
      versionCompatible: versionStatus.compatible,
      extensionDiagnostics,
      extensionAction,
      extensionFiles,
      extensionDisk,
      extensionBrowser,
      extensionRuntime,
      extensionInstallation,
      activeBridgeTask,
      bridgeTaskActive: Boolean(activeBridgeTask),
      extensionError: lastExtensionError,
      error: lastError,
      port: configuredInfo.config.port,
      configuredPort: configuredInfo.config.port,
      activePort: info.config.port,
      restartRequired: ownedProcess && configuredInfo.config.port !== info.config.port,
      host: info.host,
      url: info.url,
      version: manifest.version,
      protocolVersion: manifest.protocolVersion,
      serviceFromEmbedded: ownedProcess,
      vendorDir,
      dataDir: bridgeDataDir,
      extensionDir,
      extensionRegisteredDirs,
      // Backward compatible alias. These are Chrome registration hints, not proof
      // that the extension is enabled or connected.
      extensionLoadedDirs: extensionRegisteredDirs,
      extensionChromeIds,
      extensionUpdateDirs,
      extensionManagerRevision: EXTENSION_MANAGER_REVISION,
      extensionDeployment: lastExtensionDeployment,
      extensionDeploymentReceiptPath,
      extensionReady: extensionDisk.verified,
      mcpInstalled: hasChatgptBridgeMcpConfig(codexConfigPath),
      codexConfigPath,
    };
  }

  async function savePort(port) {
    if (!validPort(port)) {
      throw new Error("双倍额度端口必须是 1024 到 65535 之间的整数。");
    }
    saveConfig({ ...loadConfig(), port: Number(port) });
    if (!child) {
      await prepareExtensionBestEffort("save-port");
    }
    lastError = "";
    return getState();
  }

  async function prepareExtensionBestEffort(context) {
    try {
      await prepareExtension();
      return true;
    } catch (error) {
      lastExtensionError = extensionErrorMessage(error);
      log(`[double-quota] extension refresh skipped context=${context} error=${lastExtensionError}`);
      return false;
    }
  }

  async function prepareExtension() {
    const info = runtimeInfo();
    const sourceDir = path.join(vendorDir, manifest.extensionDir || "chrome-extension");
    if (!fs.existsSync(path.join(sourceDir, "manifest.json"))) {
      throw new Error("双倍额度 Chrome 扩展不完整，缺少 manifest.json。");
    }
    const configSource = bridgeExtensionConfigSource(info.origin, info.config.apiToken);
    deployExtensionFiles(sourceDir, extensionDir, configSource);
    const deploymentTargets = [
      verifyExtensionTarget(sourceDir, extensionDir, configSource),
    ];
    const receipt = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      target: path.resolve(extensionDir),
      version: extensionManifest.version,
      displayVersion: extensionManifest.versionName,
      origin: info.origin,
      verified: deploymentTargets.length > 0 && deploymentTargets.every((target) => target.verified),
      targets: deploymentTargets,
    };
    if (!receipt.verified) {
      const failed = deploymentTargets.filter((target) => !target.verified).map((target) => target.path);
      throw new Error(`扩展文件复制后校验失败：${failed.join("；") || "没有可校验的目标目录"}`);
    }
    lastExtensionDeployment = persistExtensionDeploymentReceipt(
      extensionDeploymentReceiptPath,
      receipt,
    );
    lastExtensionError = "";
    return getState();
  }

  async function manageExtension() {
    let current;
    try {
      current = await prepareExtension();
    } catch (error) {
      lastExtensionError = extensionErrorMessage(error);
      log(`[double-quota] extension update failed error=${lastExtensionError}`);
      return {
        ...(await getState()),
        extensionUpdate: {
          status: "failed",
          completed: false,
          manualReloadRequired: false,
          updatedDirectories: [],
          error: lastExtensionError,
        },
      };
    }
    const completed = current.extensionAction?.complete === true;
    return {
      ...current,
      extensionUpdate: {
        status: completed
          ? "updated"
          : "files_ready",
        completed,
        manualReloadRequired: !completed,
        updatedDirectories: [path.resolve(extensionDir)],
        requestedAction: current.extensionAction?.id || "install",
        diskVerified: current.extensionDisk?.verified === true,
        receiptPath: extensionDeploymentReceiptPath,
      },
    };
  }

  async function start() {
    const existing = await probe();
    if (existing.compatible) {
      lastError = "";
      return getState();
    }
    if (existing.reachable) {
      throw new Error("配置端口已被其他服务占用，请更换端口后重试。");
    }
    if (child) {
      return getState();
    }

    await prepareExtensionBestEffort("service-start");
    const info = runtimeInfo();
    if (!fs.existsSync(info.httpEntry)) {
      throw new Error("双倍额度服务入口不存在，请重新安装 CodexBridge。");
    }
    fs.mkdirSync(bridgeDataDir, { recursive: true });
    lastError = "";
    lifecycleStatus = "starting";
    ownedRuntime = { port: info.config.port };
    try {
      child = spawnImpl(execPath, [info.httpEntry], {
        cwd: vendorDir,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          BRIDGE_HOST: info.host,
          BRIDGE_PORT: String(info.config.port),
          BRIDGE_API_TOKEN: info.config.apiToken,
          BRIDGE_DATA_DIR: bridgeDataDir,
          BRIDGE_EXTENSION_DIR: extensionDir,
          BRIDGE_ROUTER_V2: "1",
          BRIDGE_GPT_TRANSPORT: "web-sync",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      child = null;
      ownedRuntime = null;
      lifecycleStatus = "";
      lastError = error?.message || String(error);
      throw error;
    }
    const launchedChild = child;
    launchedChild.stdout?.on("data", (chunk) => log(`[double-quota] ${String(chunk).trim()}`));
    launchedChild.stderr?.on("data", (chunk) => log(`[double-quota] ${String(chunk).trim()}`));
    launchedChild.once("exit", (code, signal) => {
      if (child === launchedChild) {
        child = null;
        ownedRuntime = null;
        lifecycleStatus = "";
        if (code !== 0 && signal !== "SIGTERM") {
          lastError = `双倍额度服务已退出（code=${code ?? "-"}, signal=${signal || "-"}）。`;
        }
      }
    });

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const health = await probe();
      if (health.compatible) {
        lifecycleStatus = "";
        return getState();
      }
      if (!child) {
        break;
      }
      await delay(250);
    }
    const failedChild = child;
    child = null;
    ownedRuntime = null;
    lifecycleStatus = "";
    failedChild?.kill("SIGTERM");
    lastError = "双倍额度服务启动超时，请检查日志后重试。";
    throw new Error(lastError);
  }

  async function stop() {
    if (!child) {
      const state = await getState();
      return state.externalProcess
        ? { ...state, message: "当前服务由外部程序启动，CodexBridge 不会强制关闭它。" }
        : state;
    }
    const ownedChild = child;
    lifecycleStatus = "stopping";
    let stopResult;
    try {
      stopResult = await terminateOwnedChild(ownedChild, stopTimeoutMs);
    } catch (error) {
      lifecycleStatus = "";
      lastError = error?.message || String(error);
      throw error;
    }
    if (child === ownedChild) {
      child = null;
    }
    ownedRuntime = null;
    lifecycleStatus = "";
    lastError = "";
    const state = await getState();
    return stopResult.forced
      ? {
          ...state,
          forcedStop: true,
          message: "Bridge 未能正常退出，已强制停止。",
        }
      : state;
  }

  async function assertMaintenanceSafe(action = "维护") {
    const state = await getState();
    if (!state.running) {
      return state;
    }
    const diagnostics = await probeDiagnostics();
    if (!diagnostics.reachable) {
      throw new Error(`无法确认 Bridge 是否存在运行中的任务，已阻止${action}。请重新检测后再试。`);
    }
    const activeTask = activeBridgeTaskFromDiagnostics(diagnostics.response);
    if (activeTask) {
      throw new Error(`Bridge 存在正在运行的任务，已阻止${action}。请等待任务完成后稍后重试。`);
    }
    return state;
  }

  async function restart() {
    const state = await assertMaintenanceSafe("重启");
    if (state.externalProcess) {
      throw new Error("当前 Bridge 服务由外部程序管理，CodexBridge 不会重启它。");
    }
    if (child) {
      await stop();
    }
    return start();
  }

  async function installOrRepairMcp() {
    const info = runtimeInfo();
    fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
    const existing = fs.existsSync(codexConfigPath)
      ? fs.readFileSync(codexConfigPath, "utf8")
      : "";
    let backupPath = "";
    if (fs.existsSync(codexConfigPath)) {
      backupPath = `${codexConfigPath}.double-quota-${timestampForFile()}.bak`;
      fs.copyFileSync(codexConfigPath, backupPath);
    }
    const next = upsertChatgptBridgeMcpConfig(existing, {
      command: execPath,
      mcpEntry: info.mcpEntry,
      dataDir: bridgeDataDir,
    });
    writeFileAtomic(codexConfigPath, next);
    return { ...(await getState()), backupPath };
  }

  return {
    assertMaintenanceSafe,
    getState,
    installOrRepairMcp,
    manageExtension,
    prepareExtension,
    restart,
    savePort,
    start,
    stop,
  };
}

function activeBridgeTaskFromDiagnostics(diagnostics = null) {
  const task = diagnostics?.activeSyncJob;
  if (!task || !["pending", "queued", "running"].includes(String(task.status || ""))) {
    return null;
  }
  return {
    id: String(task.id || "").trim() || null,
    status: String(task.status || ""),
    progress: task.progress || null,
  };
}

function extensionTargetDirectories(extensionDir, legacyExtensionDir, loadedExtensionDirs = []) {
  const targets = [extensionDir, ...loadedExtensionDirs];
  if (extensionDirectoryStatus(legacyExtensionDir).complete) {
    targets.push(legacyExtensionDir);
  }
  return uniqueResolvedPaths(targets);
}

function uniqueResolvedPaths(values = []) {
  const result = new Map();
  for (const value of values) {
    const candidate = String(value || "").trim();
    if (!candidate || !path.isAbsolute(candidate)) {
      continue;
    }
    const resolved = resolvedFilesystemPath(candidate);
    result.set(resolved.toLowerCase(), resolved);
  }
  return [...result.values()];
}

function resolvedFilesystemPath(value) {
  let candidate = String(value || "").trim();
  if (process.platform === "win32") {
    if (/^\\\\\?\\UNC\\/i.test(candidate)) {
      candidate = `\\\\${candidate.slice(8)}`;
    } else if (/^\\\\\?\\/i.test(candidate)) {
      candidate = candidate.slice(4);
    }
  }
  return path.resolve(candidate);
}

function extensionErrorMessage(error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/i.test(error.code)
    ? ` (${error.code})`
    : "";
  return `Chrome 扩展文件更新失败${code}，双倍额度服务仍可独立启动；请稍后使用“更新扩展”重试。`;
}

function verifyExtensionTarget(sourceDir, targetDir, configSource) {
  const mismatches = [];
  for (const relativePath of listRegularFiles(sourceDir)) {
    if (relativePath.toLowerCase() === "bridge-config.js") {
      continue;
    }
    const sourcePath = path.join(sourceDir, relativePath);
    const targetPath = path.join(targetDir, relativePath);
    if (!fs.existsSync(targetPath) || sha256File(sourcePath) !== sha256File(targetPath)) {
      mismatches.push(relativePath);
    }
  }
  const configPath = path.join(targetDir, "bridge-config.js");
  if (!fs.existsSync(configPath) || fs.readFileSync(configPath, "utf8") !== configSource) {
    mismatches.push("bridge-config.js");
  }
  return {
    path: path.resolve(targetDir),
    verified: mismatches.length === 0,
    mismatches,
  };
}

function deployExtensionFiles(sourceDir, targetDir, configSource) {
  for (const relativePath of listRegularFiles(sourceDir)) {
    if (relativePath.toLowerCase() === "bridge-config.js") {
      continue;
    }
    const sourcePath = path.join(sourceDir, relativePath);
    const targetPath = path.join(targetDir, relativePath);
    const content = withTransientFsRetry(() => fs.readFileSync(sourcePath));
    withTransientFsRetry(() => writeFileAtomic(targetPath, content));
  }
  withTransientFsRetry(() => writeFileAtomic(path.join(targetDir, "bridge-config.js"), configSource));
}

function withTransientFsRetry(operation, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!["EIO", "EBUSY", "EPERM"].includes(String(error?.code || "")) || attempt + 1 >= attempts) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1));
    }
  }
  throw lastError;
}

function listRegularFiles(rootDir, relativeDir = "") {
  const currentDir = path.join(rootDir, relativeDir);
  const files = [];
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...listRegularFiles(rootDir, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function defaultChromeUserDataDir() {
  const localAppData = String(process.env.LOCALAPPDATA || "").trim();
  return localAppData
    ? path.join(localAppData, "Google", "Chrome", "User Data")
    : "";
}

function discoverChromeBridgeExtensionInstallations(chromeUserDataDir) {
  const root = String(chromeUserDataDir || "").trim();
  if (!root || !path.isAbsolute(root)) {
    return [];
  }
  let childProfiles;
  try {
    childProfiles = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (
        entry.name === "Default" ||
        entry.name === "Guest Profile" ||
        entry.name === "System Profile" ||
        /^Profile \d+$/.test(entry.name)
      ))
      .slice(0, 64)
      .map((entry) => path.join(root, entry.name));
  } catch {
    childProfiles = [];
  }
  const profiles = [root, ...childProfiles];
  const discovered = [];
  for (const profile of profiles) {
    for (const preferencesName of ["Secure Preferences", "Preferences"]) {
      const preferencesPath = path.join(profile, preferencesName);
      let preferences;
      try {
        const stat = fs.statSync(preferencesPath);
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) {
          continue;
        }
        preferences = JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
      } catch {
        continue;
      }
      const settings = preferences?.extensions?.settings;
      if (!settings || typeof settings !== "object") {
        continue;
      }
      for (const [id, extension] of Object.entries(settings)) {
        const candidate = String(extension?.path || "").trim();
        // Chrome's numeric ManifestLocation value is an implementation detail and
        // has changed across desktop builds.  The absolute path plus the strict
        // Bridge manifest/file validation below is the authoritative evidence
        // that this is the unpacked extension we are allowed to update.
        if (!path.isAbsolute(candidate)) {
          continue;
        }
        const resolved = path.resolve(candidate);
        if (isVerifiedBridgeExtensionDirectory(resolved)) {
          discovered.push({
            id: String(id || "").trim(),
            path: resolved,
            profileDir: profile,
            preferencesPath,
          });
        }
      }
    }
  }
  const unique = new Map();
  for (const entry of discovered) {
    unique.set(`${entry.id}\0${entry.path.toLowerCase()}`, entry);
  }
  return [...unique.values()];
}

function isVerifiedBridgeExtensionDirectory(candidate) {
  try {
    const manifestPath = path.join(candidate, "manifest.json");
    const stat = fs.statSync(manifestPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      return false;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const scripts = Array.isArray(manifest.content_scripts)
      ? manifest.content_scripts.flatMap((entry) => Array.isArray(entry?.js) ? entry.js : [])
      : [];
    return manifest.manifest_version === 3 &&
      ["Codex GPT Bridge", "Codex G某T Bridge"].includes(manifest.name) &&
      manifest.background?.service_worker === "background.js" &&
      scripts.includes("bridge-config.js") &&
      scripts.includes("content-script.js");
  } catch {
    return false;
  }
}

function readAndValidateManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`双倍额度嵌入清单无法读取：${error.message}`);
  }
  if (
    manifest.name !== SERVICE_NAME ||
    Number(manifest.protocolVersion) !== PROTOCOL_VERSION ||
    !manifest.entrypoints?.http ||
    !manifest.entrypoints?.mcp
  ) {
    throw new Error("双倍额度嵌入清单不兼容，请更新 CodexBridge。");
  }
  return manifest;
}

function readExtensionManifest(manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return {
      name: String(manifest.name || "").trim(),
      version: String(manifest.version || "").trim(),
      versionName: String(manifest.version_name || manifest.version || "").trim(),
      backgroundScript: String(manifest.background?.service_worker || "").trim(),
      contentScripts: Array.isArray(manifest.content_scripts)
        ? manifest.content_scripts.flatMap((entry) => Array.isArray(entry?.js) ? entry.js : [])
        : [],
    };
  } catch {
    return {
      name: "",
      version: "",
      versionName: "",
      backgroundScript: "",
      contentScripts: [],
    };
  }
}

function expectedExtensionFiles(expectedManifest = null) {
  const files = [
    "manifest.json",
    expectedManifest?.backgroundScript || "background.js",
    ...(expectedManifest?.contentScripts?.length
      ? expectedManifest.contentScripts
      : ["bridge-config.js", "content-script.js"]),
  ];
  return [...new Set(files.map((value) => String(value || "").trim()).filter(Boolean))];
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function compatibleTomlPath(value) {
  return String(value).replaceAll("\\", "/");
}

function escapeTomlString(value) {
  return compatibleTomlPath(value).replaceAll('"', '\\"');
}

function upsertChatgptBridgeMcpConfig(content, { command, mcpEntry, dataDir }) {
  const lines = String(content || "").replaceAll("\r\n", "\n").split("\n");
  const retained = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)?.[1] || "";
    if (header) {
      const isTarget = header === "mcp_servers.chatgpt_codex_bridge" ||
        header.startsWith("mcp_servers.chatgpt_codex_bridge.");
      if (isTarget) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) {
      retained.push(line);
    }
  }
  while (retained.length && !retained.at(-1).trim()) {
    retained.pop();
  }
  const block = [
    "[mcp_servers.chatgpt_codex_bridge]",
    `command = "${escapeTomlString(command)}"`,
    `args = ["${escapeTomlString(mcpEntry)}"]`,
    "",
    "[mcp_servers.chatgpt_codex_bridge.env]",
    'ELECTRON_RUN_AS_NODE = "1"',
    `BRIDGE_DATA_DIR = "${escapeTomlString(dataDir)}"`,
    'BRIDGE_ROUTER_V2 = "1"',
    'BRIDGE_GPT_TRANSPORT = "web-sync"',
  ];
  return `${[...retained, ...(retained.length ? [""] : []), ...block].join("\n")}\n`;
}

function hasChatgptBridgeMcpConfig(configPath) {
  try {
    return /^\s*\[mcp_servers\.chatgpt_codex_bridge\]\s*$/m.test(
      fs.readFileSync(configPath, "utf8"),
    );
  } catch {
    return false;
  }
}

function bridgeExtensionConfigSource(origin, apiToken) {
  return [
    "globalThis.CODEX_BRIDGE_CONFIG = Object.freeze({",
    `  origin: ${JSON.stringify(origin)},`,
    `  apiToken: ${JSON.stringify(apiToken)}`,
    "});",
    "",
  ].join("\n");
}

function extensionDirectoryStatus(extensionDir, {
  sourceDir = "",
  configSource = "",
  expectedManifest = null,
} = {}) {
  const requiredFiles = expectedExtensionFiles(expectedManifest);
  const files = Object.fromEntries(requiredFiles.map((fileName) => [
    fileName,
    fs.existsSync(path.join(extensionDir, fileName)),
  ]));
  const complete = requiredFiles.every((fileName) => files[fileName]);
  let manifest = null;
  if (files["manifest.json"]) {
    try {
      manifest = readExtensionManifest(path.join(extensionDir, "manifest.json"));
    } catch {
      manifest = null;
    }
  }
  let verification = { verified: false, mismatches: [] };
  if (complete && sourceDir && configSource && fs.existsSync(sourceDir)) {
    verification = verifyExtensionTarget(sourceDir, extensionDir, configSource);
  }
  const expectedVersion = String(expectedManifest?.version || "").trim();
  const versionMatches = !expectedVersion || manifest?.version === expectedVersion;
  const verified = complete && verification.verified && versionMatches;
  return {
    status: !complete
      ? Object.values(files).some(Boolean) ? "incomplete" : "missing"
      : verified ? "current" : "outdated",
    complete,
    verified,
    files,
    requiredFiles,
    version: manifest?.version || "",
    displayVersion: manifest?.versionName || manifest?.version || "",
    mismatches: [
      ...verification.mismatches,
      ...(versionMatches ? [] : ["manifest.version"]),
    ],
  };
}

function extensionManagementAction({
  version = "",
  expectedVersion = "",
  connected = false,
  needsReload = false,
  diskStatus = "missing",
  diskVerified = false,
  registeredStable = false,
  runtimeObservable = true,
} = {}) {
  const current = String(version || "").trim();
  const expected = String(expectedVersion || "").trim();
  if (!diskVerified) {
    const updateExisting = diskStatus === "outdated" || diskStatus === "incomplete";
    return {
      id: updateExisting ? "update" : "install",
      label: updateExisting ? "更新扩展" : "开始安装",
      complete: false,
      detail: updateExisting
        ? "固定目录中的扩展文件不是当前内置版本，请更新后在 Chrome 中重新加载。"
        : "扩展文件尚未完整安装，请部署内置扩展。",
    };
  }
  if (!registeredStable) {
    return {
      id: "load",
      label: "继续安装",
      complete: false,
      detail: "扩展文件已准备好，等待在 Chrome 中加载固定目录。",
    };
  }
  if (runtimeObservable && current && (!expected || current !== expected || needsReload)) {
    return {
      id: "update",
      label: "更新扩展",
      complete: false,
      detail: `当前运行协议 ${current}，需要 ${expected || "当前内置版本"}。`,
    };
  }
  if (!runtimeObservable) {
    return {
      id: "installed",
      label: "扩展已安装",
      complete: true,
      detail: "扩展文件和 Chrome 登记正常；启动服务后再检测实时连接。",
    };
  }
  if (!connected) {
    return {
      id: "repair",
      label: "重新加载扩展",
      complete: false,
      detail: "Chrome 已登记扩展，但当前没有收到扩展实时连接。",
    };
  }
  return {
    id: "current",
    label: "扩展已是最新",
    complete: true,
    detail: "扩展文件、Chrome 登记和实时连接均正常。",
  };
}

function extensionRuntimeStatus(
  extensionDiagnostics = {},
  expectedVersion = "",
  { observable = true, serviceRunning = true } = {},
) {
  const version = String(extensionDiagnostics.version || "").trim();
  const expected = String(
    extensionDiagnostics.expectedVersion || expectedVersion || "",
  ).trim();
  const connected = extensionDiagnostics.connected === true;
  if (!observable) {
    return {
      status: serviceRunning ? "unavailable" : "service_offline",
      observable: false,
      connected: false,
      stale: false,
      needsReload: false,
      version: "",
      expectedVersion: expected,
      sourceDir: "",
    };
  }
  const stale = Boolean(
    extensionDiagnostics.needsReload === true ||
    (version && expected && version !== expected),
  );
  return {
    status: stale ? "stale" : connected ? "connected" : "not_connected",
    observable: true,
    connected,
    stale,
    needsReload: extensionDiagnostics.needsReload === true,
    version,
    expectedVersion: expected,
    sourceDir: String(extensionDiagnostics.sourceDir || "").trim(),
  };
}

function extensionInstallationStatus({
  diskStatus = "missing",
  diskVerified = false,
  browserStatus = "not_registered",
  registeredStable = false,
  runtimeStatus = "service_offline",
} = {}) {
  if (!diskVerified) {
    const installedButOutdated = diskStatus === "outdated" && registeredStable;
    return {
      status: diskStatus === "outdated" ? "update_required" : diskStatus === "incomplete" ? "incomplete" : "missing",
      installed: installedButOutdated,
      filesReady: false,
      browserLoaded: installedButOutdated,
    };
  }
  if (!registeredStable) {
    return {
      status: browserStatus === "registered_other_path" ? "old_path" : "awaiting_browser",
      installed: false,
      filesReady: true,
      browserLoaded: false,
    };
  }
  return {
    status: runtimeStatus === "stale" ? "update_required" : "installed",
    installed: true,
    filesReady: true,
    browserLoaded: true,
  };
}

function sameResolvedPath(left, right) {
  if (!left || !right) return false;
  return resolvedFilesystemPath(left).toLowerCase() === resolvedFilesystemPath(right).toLowerCase();
}

function readExtensionDeploymentReceipt(receiptPath, extensionDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (
      parsed?.schemaVersion !== 1 ||
      parsed?.verified !== true ||
      !sameResolvedPath(parsed?.target, extensionDir)
    ) {
      return null;
    }
    return {
      ...parsed,
      persisted: true,
      receiptPath: path.resolve(receiptPath),
    };
  } catch {
    return null;
  }
}

function persistExtensionDeploymentReceipt(receiptPath, receipt) {
  writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return {
    ...receipt,
    persisted: true,
    receiptPath: path.resolve(receiptPath),
  };
}

function writeFileAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, content, Buffer.isBuffer(content) ? undefined : "utf8");
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // The explicit temporary file may not exist when the write itself failed.
    }
    throw error;
  }
}

function timestampForFile() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
}

function requestJsonOverHttp(url, { timeoutMs = 1200, headers = {} } = {}) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });
}

function terminateOwnedChild(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result = { forced: false }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
        finish(null, { forced: true });
      } catch (error) {
        finish(error);
      }
    }, timeoutMs);
    child.once("exit", () => finish(null, { forced: false }));
    try {
      if (!child.kill("SIGTERM")) {
        finish(new Error("双倍额度服务退出信号发送失败。"));
      }
    } catch (error) {
      finish(error);
    }
  });
}

module.exports = {
  createChatgptBridgeService,
  extensionManagementAction,
  extensionInstallationStatus,
  uniqueResolvedPaths,
  upsertChatgptBridgeMcpConfig,
};
