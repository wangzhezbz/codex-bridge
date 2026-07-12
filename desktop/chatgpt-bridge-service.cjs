const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const SERVICE_NAME = "chatgpt-codex-bridge";
const PROTOCOL_VERSION = 1;
const DEFAULT_PORT = 4317;
const EXTENSION_MANAGER_REVISION = "stable-dir-migration-v1";

function createChatgptBridgeService({
  appRootDir,
  dataRootDir,
  execPath = process.execPath,
  homeDir = process.env.USERPROFILE || process.env.HOME || "",
  chromeUserDataDir = defaultChromeUserDataDir(),
  spawnImpl = spawn,
  requestJson = requestJsonOverHttp,
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
  const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
  const manifest = readAndValidateManifest(manifestPath);
  const extensionManifest = readExtensionManifest(path.join(vendorDir, "chrome-extension", "manifest.json"));
  let child = null;
  let lastError = "";
  let lastExtensionDeployment = null;

  function loadConfig() {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      saved = {};
    }
    return {
      port: validPort(saved.port) ? Number(saved.port) : Number(manifest.defaults?.port || DEFAULT_PORT),
    };
  }

  function saveConfig(config) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  function runtimeInfo() {
    const config = loadConfig();
    const host = String(manifest.defaults?.host || "127.0.0.1");
    const origin = `http://${host}:${config.port}`;
    return {
      config,
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

  async function probe() {
    const info = runtimeInfo();
    const response = await requestJson(info.healthUrl, { timeoutMs: 1200 });
    if (!response) {
      return { reachable: false, compatible: false, response: null };
    }
    return {
      reachable: true,
      compatible:
        response.service === SERVICE_NAME &&
        Number(response.protocolVersion) === PROTOCOL_VERSION &&
        response.status === "ready",
      response,
    };
  }

  async function probeVersion() {
    const info = runtimeInfo();
    const response = await requestJson(info.versionUrl, { timeoutMs: 1200 });
    if (!response) {
      return { reachable: false, compatible: false, response: null };
    }
    return {
      reachable: true,
      compatible:
        response.service === SERVICE_NAME &&
        Number(response.protocolVersion) === PROTOCOL_VERSION &&
        Boolean(String(response.extensionProtocolVersion || "").trim()),
      response,
    };
  }

  async function probeDiagnostics() {
    const info = runtimeInfo();
    const response = await requestJson(info.diagnosticsUrl, { timeoutMs: 1800 });
    return response && typeof response === "object"
      ? { reachable: true, response }
      : { reachable: false, response: null };
  }

  async function getState() {
    const info = runtimeInfo();
    const [health, versionStatus, diagnosticsStatus] = await Promise.all([
      probe(),
      probeVersion(),
      probeDiagnostics(),
    ]);
    const ownedProcess = Boolean(child);
    const status = health.compatible
      ? ownedProcess ? "running" : "attached"
      : ownedProcess ? "starting" : lastError ? "error" : "stopped";
    const extensionFiles = extensionDirectoryStatus(extensionDir);
    const chromeInstallations = discoverChromeBridgeExtensionInstallations(chromeUserDataDir);
    const extensionDiagnostics = diagnosticsStatus.response?.extension || {};
    const extensionLoadedDirs = uniqueResolvedPaths(
      chromeInstallations.map((entry) => entry.path),
    );
    const extensionChromeIds = [...new Set(chromeInstallations.map((entry) => entry.id).filter(Boolean))];
    const extensionUpdateDirs = extensionTargetDirectories(
      extensionDir,
      legacyExtensionDir,
      extensionLoadedDirs,
    );
    const extensionAction = extensionManagementAction({
      ...extensionDiagnostics,
      expectedVersion:
        extensionDiagnostics.expectedVersion ||
        versionStatus.response?.extensionProtocolVersion ||
        "",
      localComplete: extensionFiles.complete,
      loadedExtensionDetected: extensionLoadedDirs.length > 0,
    });
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
      error: lastError,
      port: info.config.port,
      host: info.host,
      url: info.url,
      version: manifest.version,
      protocolVersion: manifest.protocolVersion,
      vendorDir,
      dataDir: bridgeDataDir,
      extensionDir,
      extensionLoadedDirs,
      extensionChromeIds,
      extensionUpdateDirs,
      extensionManagerRevision: EXTENSION_MANAGER_REVISION,
      extensionDeployment: lastExtensionDeployment,
      extensionReady: extensionFiles.complete,
      mcpInstalled: hasChatgptBridgeMcpConfig(codexConfigPath),
      codexConfigPath,
    };
  }

  async function savePort(port) {
    if (!validPort(port)) {
      throw new Error("双倍额度端口必须是 1024 到 65535 之间的整数。");
    }
    if (child) {
      throw new Error("请先停止双倍额度服务，再修改端口。");
    }
    saveConfig({ port: Number(port) });
    await prepareExtension();
    lastError = "";
    return getState();
  }

  async function prepareExtension() {
    const info = runtimeInfo();
    const sourceDir = path.join(vendorDir, manifest.extensionDir || "chrome-extension");
    if (!fs.existsSync(path.join(sourceDir, "manifest.json"))) {
      throw new Error("双倍额度 Chrome 扩展不完整，缺少 manifest.json。");
    }
    const configSource = [
      "globalThis.CODEX_BRIDGE_CONFIG = Object.freeze({",
      `  origin: ${JSON.stringify(info.origin)}`,
      "});",
      "",
    ].join("\n");
    const loadedExtensionDirs = uniqueResolvedPaths(
      discoverChromeBridgeExtensionInstallations(chromeUserDataDir).map((entry) => entry.path),
    );
    const targetDirs = extensionTargetDirectories(
      extensionDir,
      legacyExtensionDir,
      loadedExtensionDirs,
    );
    const deploymentTargets = [];
    for (const targetDir of targetDirs) {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
      writeFileAtomic(path.join(targetDir, "bridge-config.js"), configSource);
      deploymentTargets.push(verifyExtensionTarget(sourceDir, targetDir, configSource));
    }
    lastExtensionDeployment = {
      updatedAt: new Date().toISOString(),
      verified: deploymentTargets.length > 0 && deploymentTargets.every((target) => target.verified),
      targets: deploymentTargets,
    };
    if (!lastExtensionDeployment.verified) {
      const failed = deploymentTargets.filter((target) => !target.verified).map((target) => target.path);
      throw new Error(`扩展文件复制后校验失败：${failed.join("；") || "没有可校验的目标目录"}`);
    }
    return getState();
  }

  async function manageExtension() {
    const before = await getState();
    let current = await prepareExtension();
    for (let attempt = 0; attempt < 20 && current.extensionAction?.complete !== true; attempt += 1) {
      if (
        before.extensionAction?.id === "reinstall" ||
        (before.extensionAction?.id === "install" && before.extensionDiagnostics?.connected !== true)
      ) {
        break;
      }
      await delay(750);
      current = await getState();
    }
    const completed = current.extensionAction?.complete === true;
    return {
      ...current,
      extensionUpdate: {
        status: completed
          ? "updated"
          : before.extensionAction?.id === "reinstall"
            ? "reinstall_required"
            : "manual_action_required",
        completed,
        manualReloadRequired: !completed,
        updatedDirectories: current.extensionUpdateDirs,
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

    await prepareExtension();
    const info = runtimeInfo();
    if (!fs.existsSync(info.httpEntry)) {
      throw new Error("双倍额度服务入口不存在，请重新安装 CodexBridge。");
    }
    fs.mkdirSync(bridgeDataDir, { recursive: true });
    lastError = "";
    child = spawnImpl(execPath, [info.httpEntry], {
      cwd: vendorDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        BRIDGE_HOST: info.host,
        BRIDGE_PORT: String(info.config.port),
        BRIDGE_DATA_DIR: bridgeDataDir,
        BRIDGE_EXTENSION_DIR: extensionDir,
        BRIDGE_ROUTER_V2: "0",
        BRIDGE_GPT_TRANSPORT: "web-sync",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const launchedChild = child;
    launchedChild.stdout?.on("data", (chunk) => log(`[double-quota] ${String(chunk).trim()}`));
    launchedChild.stderr?.on("data", (chunk) => log(`[double-quota] ${String(chunk).trim()}`));
    launchedChild.once("exit", (code, signal) => {
      if (child === launchedChild) {
        child = null;
        if (code !== 0 && signal !== "SIGTERM") {
          lastError = `双倍额度服务已退出（code=${code ?? "-"}, signal=${signal || "-"}）。`;
        }
      }
    });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const health = await probe();
      if (health.compatible) {
        return getState();
      }
      if (!child) {
        break;
      }
      await delay(250);
    }
    const failedChild = child;
    child = null;
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
    await terminateOwnedChild(ownedChild);
    if (child === ownedChild) {
      child = null;
    }
    lastError = "";
    return getState();
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
    getState,
    installOrRepairMcp,
    manageExtension,
    prepareExtension,
    savePort,
    start,
    stop,
  };
}

function extensionTargetDirectories(extensionDir, legacyExtensionDir, loadedExtensionDirs = []) {
  const targets = [extensionDir, ...loadedExtensionDirs];
  if (extensionDirectoryStatus(legacyExtensionDir).complete) {
    targets.push(legacyExtensionDir);
  }
  return [...new Set(targets.map((target) => path.resolve(target)))];
}

function uniqueResolvedPaths(values = []) {
  const result = new Map();
  for (const value of values) {
    const candidate = String(value || "").trim();
    if (!candidate || !path.isAbsolute(candidate)) {
      continue;
    }
    const resolved = path.resolve(candidate);
    result.set(resolved.toLowerCase(), resolved);
  }
  return [...result.values()];
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
      manifest.name === "Codex GPT Bridge" &&
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
      version: String(manifest.version || "").trim(),
      versionName: String(manifest.version_name || manifest.version || "").trim(),
    };
  } catch {
    return { version: "", versionName: "" };
  }
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
    'BRIDGE_ROUTER_V2 = "0"',
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

function extensionDirectoryStatus(extensionDir) {
  const requiredFiles = ["manifest.json", "background.js", "content-script.js", "bridge-config.js"];
  const files = Object.fromEntries(requiredFiles.map((fileName) => [
    fileName,
    fs.existsSync(path.join(extensionDir, fileName)),
  ]));
  return {
    complete: requiredFiles.every((fileName) => files[fileName]),
    files,
    requiredFiles,
  };
}

function extensionManagementAction({
  version = "",
  expectedVersion = "",
  connected = false,
  needsReload = false,
  localComplete = false,
  loadedExtensionDetected = false,
} = {}) {
  const current = String(version || "").trim();
  const expected = String(expectedVersion || "").trim();
  if (!current) {
    return {
      id: "install",
      label: "安装扩展",
      complete: false,
      detail: localComplete
        ? "固定扩展目录已准备，但尚未检测到 Chrome 扩展连接。"
        : "未检测到扩展，请安装内置扩展。",
    };
  }
  if (!loadedExtensionDetected && (current !== expected || needsReload)) {
    return {
      id: "reinstall",
      label: "安装新版扩展",
      complete: false,
      detail: "检测到旧扩展仍在运行，但 Chrome 没有暴露其磁盘目录；需要重新加载固定安装目录。",
    };
  }
  if (!expected || current !== expected || needsReload) {
    return {
      id: "update",
      label: "更新扩展",
      complete: false,
      detail: `当前扩展 ${current}，需要 ${expected || "当前内置版本"}。`,
    };
  }
  if (!connected) {
    return {
      id: "repair",
      label: "修复扩展",
      complete: false,
      detail: "扩展版本一致，但当前未连接 Bridge。",
    };
  }
  return {
    id: "current",
    label: "扩展已是最新",
    complete: true,
    detail: "扩展版本一致且连接正常。",
  };
}

function writeFileAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, "utf8");
  fs.renameSync(temp, target);
}

function timestampForFile() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
}

function requestJsonOverHttp(url, { timeoutMs = 1200 } = {}) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
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
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("双倍额度服务未能在限定时间内退出。"));
    }, timeoutMs);
    child.once("exit", () => finish());
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
  upsertChatgptBridgeMcpConfig,
};
