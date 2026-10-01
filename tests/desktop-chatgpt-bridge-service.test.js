import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { bridgeMcpEnvironment } from "../desktop/chatgpt-bridge-mcp-entry.mjs";

const require = createRequire(import.meta.url);
const {
  createChatgptBridgeService,
  extensionManagementAction,
  uniqueResolvedPaths,
  upsertChatgptBridgeMcpConfig,
} = require("../desktop/chatgpt-bridge-service.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-double-quota-"));
  const appRootDir = path.join(root, "app");
  const dataRootDir = path.join(root, "data");
  const homeDir = path.join(root, "home");
  const chromeUserDataDir = path.join(root, "chrome-user-data");
  const vendorDir = path.join(appRootDir, "vendor", "chatgpt-codex-bridge");
  fs.mkdirSync(path.join(vendorDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(vendorDir, "chrome-extension"), { recursive: true });
  fs.mkdirSync(path.join(appRootDir, "desktop"), { recursive: true });
  fs.writeFileSync(path.join(appRootDir, "desktop", "chatgpt-bridge-mcp-entry.mjs"), "// host mcp entry\n", "utf8");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, "src", "index.js"), "// http\n", "utf8");
  fs.writeFileSync(path.join(vendorDir, "src", "mcp-server.js"), "// mcp\n", "utf8");
  fs.writeFileSync(
    path.join(vendorDir, "chrome-extension", "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Codex G某T Bridge",
      version: "0.1.57",
      version_name: "0.1.57 - 20260801",
      background: { service_worker: "background.js" },
      content_scripts: [{ js: ["bridge-config.js", "content-script.js"] }],
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(vendorDir, "chrome-extension", "background.js"), "// background\n", "utf8");
  fs.writeFileSync(path.join(vendorDir, "chrome-extension", "content-script.js"), "// content\n", "utf8");
  fs.writeFileSync(path.join(vendorDir, "chrome-extension", "bridge-config.js"), "// config\n", "utf8");
  fs.writeFileSync(
    path.join(vendorDir, "embedded-manifest.json"),
    JSON.stringify({
      name: "chatgpt-codex-bridge",
      version: "0.1.0",
      protocolVersion: 1,
      entrypoints: { http: "src/index.js", mcp: "src/mcp-server.js" },
      defaults: { host: "127.0.0.1", port: 4317 },
      healthPath: "/health",
      versionPath: "/version",
      security: { apiTokenHeader: "X-Bridge-Token" },
      extensionDir: "chrome-extension",
    }),
    "utf8",
  );
  return { root, appRootDir, dataRootDir, homeDir, vendorDir, chromeUserDataDir };
}

function availableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address()?.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function compatibleHealth() {
  return {
    ok: true,
    service: "chatgpt-codex-bridge",
    status: "ready",
    version: "0.1.0",
    protocolVersion: 1,
  };
}

function compatibleVersion() {
  return {
    service: "chatgpt-codex-bridge",
    version: "0.1.0",
    protocolVersion: 1,
    extensionProtocolVersion: "v20260801-adaptive-office-wait",
  };
}

function compatibleServiceResponse(url) {
  if (url.endsWith("/health")) return compatibleHealth();
  if (url.endsWith("/version")) return compatibleVersion();
  if (url.endsWith("/api/diagnostics/status")) {
    return { activeSyncJob: null, extension: {} };
  }
  return null;
}

test("bundled Embedded runtime exposes the v0.1.95 service and extension contracts", () => {
  const vendorDir = path.join(process.cwd(), "vendor", "chatgpt-codex-bridge");
  const embedded = JSON.parse(
    fs.readFileSync(path.join(vendorDir, "embedded-manifest.json"), "utf8"),
  );
  const extension = JSON.parse(
    fs.readFileSync(path.join(vendorDir, "chrome-extension", "manifest.json"), "utf8"),
  );

  assert.equal(embedded.version, "0.1.95");
  assert.equal(embedded.protocolVersion, 1);
  assert.equal(embedded.security.apiTokenHeader, "X-Bridge-Token");
  assert.equal(extension.name, "Codex GPT Bridge");
  assert.equal(extension.version, "0.1.95");
  assert.deepEqual(extension.content_scripts[0].js, ["bridge-config.js", "content-script.js"]);
  assert.equal(fs.existsSync(path.join(vendorDir, "chrome-extension", "bridge-auth.js")), false);
  assert.equal(fs.existsSync(path.join(vendorDir, "public", "bridge-api-client.js")), true);
  assert.equal(fs.existsSync(path.join(vendorDir, "public", "visible-branding.js")), true);
});

test("double quota service exposes the embedded manifest and default stopped state", async () => {
  const dirs = fixture();
  const service = createChatgptBridgeService({
    ...dirs,
    execPath: "C:\\Apps\\CodexBridge.exe",
    requestJson: async () => null,
  });

  const state = await service.getState();

  assert.equal(state.available, true);
  assert.equal(state.status, "stopped");
  assert.equal(state.port, 4317);
  assert.equal(state.url, "http://127.0.0.1:4317/");
  assert.equal(state.version, "0.1.0");
  assert.equal(state.protocolVersion, 1);
  assert.equal(state.extensionManifestVersion, "0.1.57");
  assert.equal(state.extensionDisplayVersion, "0.1.57 - 20260801");
  assert.equal(state.ownedProcess, false);
});

test("Windows namespace and regular extension paths collapse to one deployment target", () => {
  if (process.platform !== "win32") return;
  const regular = "C:\\Users\\李\\AppData\\Roaming\\CodexBridge\\extensions\\chatgpt-codex-bridge";
  const namespaced = `\\\\?\\${regular}`;
  assert.deepEqual(uniqueResolvedPaths([regular, namespaced]), [regular]);
});

test("MCP host entry maps the current Codex task id into Bridge task scope", () => {
  const mapped = bridgeMcpEnvironment({
    CODEX_THREAD_ID: "019f-test-thread",
    BRIDGE_CURRENT_CODEX_THREAD_ID: "",
  });
  const explicit = bridgeMcpEnvironment({
    CODEX_THREAD_ID: "019f-test-thread",
    BRIDGE_CURRENT_CODEX_THREAD_ID: "explicit-thread",
  });

  assert.equal(mapped.BRIDGE_CURRENT_CODEX_THREAD_ID, "019f-test-thread");
  assert.equal(explicit.BRIDGE_CURRENT_CODEX_THREAD_ID, "explicit-thread");
});

test("MCP repair writes the host task-scope entry instead of the raw vendor entry", async () => {
  const dirs = fixture();
  const service = createChatgptBridgeService({
    ...dirs,
    execPath: "C:\\Apps\\CodexBridge.exe",
    requestJson: async () => null,
  });

  await service.installOrRepairMcp();
  const config = fs.readFileSync(path.join(dirs.homeDir, ".codex", "config.toml"), "utf8");

  assert.match(config, /desktop\/chatgpt-bridge-mcp-entry\.mjs/);
  assert.doesNotMatch(config, /vendor\/chatgpt-codex-bridge\/src\/mcp-server\.js/);
});

test("repeated MCP repair does not rewrite config or create unbounded backups", async () => {
  const dirs = fixture();
  const service = createChatgptBridgeService({
    ...dirs,
    execPath: "C:\\Apps\\CodexBridge.exe",
    requestJson: async () => null,
  });
  const first = await service.installOrRepairMcp();
  const configDir = path.join(dirs.homeDir, ".codex");
  const configPath = path.join(configDir, "config.toml");
  const firstBytes = fs.readFileSync(configPath);
  const second = await service.installOrRepairMcp();
  const backupNames = fs.readdirSync(configDir)
    .filter((name) => name.startsWith("config.toml.double-quota-") && name.endsWith(".bak"));

  assert.equal(first.unchanged, false);
  assert.equal(second.unchanged, true);
  assert.equal(second.backupPath, "");
  assert.deepEqual(fs.readFileSync(configPath), firstBytes);
  assert.deepEqual(backupNames, []);
});

test("embedded Chrome extension exposes a user-visible build version", () => {
  const extensionManifest = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "vendor", "chatgpt-codex-bridge", "chrome-extension", "manifest.json"), "utf8"),
  );

  assert.equal(extensionManifest.version, "0.1.95");
  assert.match(extensionManifest.version_name, /20260923/);
});

test("double quota state reads the service version and extension protocol independently from health", async () => {
  const dirs = fixture();
  const requested = [];
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async (url, options) => {
      requested.push({ url, options });
      if (url.endsWith("/health")) return compatibleHealth();
      if (url.endsWith("/version")) return compatibleVersion();
      return null;
    },
  });

  const state = await service.getState();

  const savedConfig = JSON.parse(
    fs.readFileSync(path.join(dirs.dataRootDir, "config", "double-quota.json"), "utf8"),
  );
  assert.deepEqual(requested.map((entry) => entry.url), [
    "http://127.0.0.1:4317/health",
    "http://127.0.0.1:4317/version",
    "http://127.0.0.1:4317/api/diagnostics/status",
  ]);
  assert.equal(
    requested[2].options.headers["X-Bridge-Token"],
    savedConfig.apiToken,
  );
  assert.equal(state.serviceVersion, "0.1.0");
  assert.equal(state.extensionProtocolVersion, "v20260801-adaptive-office-wait");
  assert.equal(state.versionCompatible, true);
});

test("double quota extension management does not call an installed extension broken while the service is stopped", async () => {
  const scenarios = [
    { extension: { runtimeObservable: false, diskVerified: false, registeredStable: false }, action: "install", label: "开始安装" },
    { extension: { runtimeObservable: false, diskStatus: "outdated", diskVerified: false, registeredStable: true }, action: "update", label: "更新扩展" },
    { extension: { runtimeObservable: true, diskVerified: true, version: "v1", expectedVersion: "v2", connected: true, needsReload: true, registeredStable: true }, action: "update", label: "更新扩展" },
    { extension: { runtimeObservable: true, diskVerified: true, version: "v2", expectedVersion: "v2", connected: false, needsReload: false, registeredStable: true }, action: "repair", label: "重新加载扩展" },
    { extension: { runtimeObservable: true, diskVerified: true, version: "v2", expectedVersion: "v2", connected: true, needsReload: false, registeredStable: true }, action: "current", label: "扩展已是最新" },
    { extension: { runtimeObservable: false, diskVerified: true, registeredStable: false }, action: "load", label: "继续安装" },
    { extension: { runtimeObservable: false, diskVerified: true, registeredStable: true }, action: "installed", label: "扩展已安装" },
  ];

  for (const scenario of scenarios) {
    const action = extensionManagementAction(scenario.extension);
    assert.equal(action.id, scenario.action);
    assert.equal(action.label, scenario.label);
  }
});

test("double quota port validation rejects privileged and invalid ports", async () => {
  const dirs = fixture();
  const service = createChatgptBridgeService({ ...dirs, requestJson: async () => null });

  await assert.rejects(() => service.savePort(80), /1024.*65535/);
  await assert.rejects(() => service.savePort("not-a-port"), /1024.*65535/);
  const state = await service.savePort(54317);
  assert.equal(state.port, 54317);
  assert.equal(state.url, "http://127.0.0.1:54317/");
});

test("double quota health requires the explicit ready payload", async () => {
  const dirs = fixture();
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async (url) => url.endsWith("/health")
      ? { ...compatibleHealth(), ok: false }
      : compatibleVersion(),
  });

  const state = await service.getState();

  assert.equal(state.running, false);
  assert.equal(state.status, "stopped");
});

test("saving a new port keeps an owned service running until an explicit restart", async () => {
  const dirs = fixture();
  let serviceAlive = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    serviceAlive = false;
    queueMicrotask(() => child.emit("exit", 0, signal));
    return true;
  };
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async (url) => {
      if (!serviceAlive || !url.includes(":4317/")) return null;
      if (url.endsWith("/health")) return compatibleHealth();
      if (url.endsWith("/version")) return compatibleVersion();
      return { activeSyncJob: null, extension: {} };
    },
    spawnImpl() {
      serviceAlive = true;
      return child;
    },
    delay: async () => {},
  });
  await service.start();

  const state = await service.savePort(54317);

  assert.equal(state.status, "running");
  assert.equal(state.port, 54317);
  assert.equal(state.activePort, 4317);
  assert.equal(state.url, "http://127.0.0.1:4317/");
  assert.equal(state.restartRequired, true);
  assert.equal(serviceAlive, true);
  await service.stop();
});

for (const action of ["prepareExtension", "manageExtension"]) {
  test(`${action} keeps the active origin until a saved port takes effect on restart`, async () => {
    const dirs = fixture();
    let activeChild = null;
    let activePort = 0;
    const spawnPorts = [];
    const service = createChatgptBridgeService({
      ...dirs,
      requestJson: async (url) => activeChild && Number(new URL(url).port) === activePort
        ? compatibleServiceResponse(url)
        : null,
      spawnImpl(_command, _args, options) {
        activePort = Number(options.env.BRIDGE_PORT);
        spawnPorts.push(activePort);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = (signal) => {
          if (activeChild === child) activeChild = null;
          queueMicrotask(() => child.emit("exit", 0, signal));
          return true;
        };
        activeChild = child;
        return child;
      },
      delay: async () => {},
    });
    const deployedConfig = (state) => runInNewContext(
      `${fs.readFileSync(path.join(state.extensionDir, "bridge-config.js"), "utf8")}\nCODEX_BRIDGE_CONFIG;`,
    );
    try {
      const started = await service.start();
      const initialToken = deployedConfig(started).apiToken;
      await service.savePort(54318);
      const repaired = await service[action]();
      assert.equal(deployedConfig(repaired).origin, "http://127.0.0.1:4317");
      assert.equal(deployedConfig(repaired).apiToken, initialToken);
      assert.equal(repaired.extensionDisk.verified, true);
      assert.equal(repaired.extensionDeployment.origin, "http://127.0.0.1:4317");
      assert.equal(repaired.running, true);
      assert.equal(repaired.activePort, 4317);
      assert.equal(repaired.configuredPort, 54318);
      assert.equal(repaired.restartRequired, true);
      assert.deepEqual(spawnPorts, [4317]);

      const restarted = await service.restart();
      assert.equal(restarted.activePort, 54318);
      assert.equal(restarted.restartRequired, false);
      assert.equal(deployedConfig(restarted).origin, "http://127.0.0.1:54318");
      assert.equal(deployedConfig(restarted).apiToken, initialToken);
      assert.equal(restarted.extensionDisk.verified, true);
      assert.deepEqual(spawnPorts, [4317, 54318]);
    } finally {
      await service.stop();
    }
  });
}

test("a port saved during startup preparation reaches both the child and extension", { timeout: 10_000 }, async () => {
  const dirs = fixture();
  let healthCalls = 0;
  let activeChild = null;
  let activePort = 0;
  let markPrepared;
  let releasePrepared;
  const prepared = new Promise((resolve) => { markPrepared = resolve; });
  const released = new Promise((resolve) => { releasePrepared = resolve; });
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async (url) => {
      if (url.endsWith("/health") && ++healthCalls === 2) {
        // The extension has been written, but its final state probe is pending.
        markPrepared();
        await released;
      }
      return activeChild && Number(new URL(url).port) === activePort
        ? compatibleServiceResponse(url)
        : null;
    },
    spawnImpl(_command, _args, options) {
      activePort = Number(options.env.BRIDGE_PORT);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal) => {
        if (activeChild === child) activeChild = null;
        queueMicrotask(() => child.emit("exit", 0, signal));
        return true;
      };
      activeChild = child;
      return child;
    },
    delay: async () => {},
  });
  const starting = service.start();
  let saving;
  try {
    await prepared;
    saving = service.savePort(54318);
    releasePrepared();
    const [started] = await Promise.all([starting, saving]);
    const extensionConfig = runInNewContext(
      `${fs.readFileSync(path.join(started.extensionDir, "bridge-config.js"), "utf8")}\nCODEX_BRIDGE_CONFIG;`,
    );
    assert.equal(started.running, true);
    assert.equal(started.activePort, 54318);
    assert.equal(extensionConfig.origin, "http://127.0.0.1:54318");
    assert.equal(started.extensionDisk.verified, true);
    assert.equal(started.extensionDeployment.origin, "http://127.0.0.1:54318");
  } finally {
    releasePrepared();
    await Promise.allSettled([starting, saving]);
    await service.stop();
  }
});

test("extension preparation rejects continuous origin changes and remains retryable", { timeout: 10_000 }, async () => {
  const dirs = fixture();
  const configPath = path.join(dirs.dataRootDir, "config", "double-quota.json");
  let changeConfig = true;
  let changes = 0;
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async (url) => {
      if (changeConfig && url.endsWith("/health")) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        changes += 1;
        config.port = 54000 + changes;
        fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
      }
      return null;
    },
  });
  try {
    await assert.rejects(service.prepareExtension(), (error) => error.code === "bridge_extension_config_changed");
    assert.ok(changes > 1 && changes <= 3, "configuration retries must be bounded");
  } finally {
    changeConfig = false;
  }
  const retried = await service.prepareExtension();
  assert.equal(retried.extensionDisk.verified, true);
  assert.equal(retried.extensionDeployment.origin, `http://127.0.0.1:${54000 + changes}`);
});

test("double quota prepares a stable extension with the configured origin", async () => {
  const dirs = fixture();
  const service = createChatgptBridgeService({ ...dirs, requestJson: async () => null });
  await service.savePort(54318);

  const state = await service.prepareExtension();

  assert.equal(state.extensionReady, true);
  assert.match(state.extensionDir, /extensions[\\/]chatgpt-codex-bridge$/);
  assert.equal(fs.existsSync(path.join(state.extensionDir, "manifest.json")), true);
  for (const fileName of ["manifest.json", "background.js", "content-script.js", "bridge-config.js"]) {
    assert.equal(fs.existsSync(path.join(state.extensionDir, fileName)), true, fileName);
  }
  assert.match(
    fs.readFileSync(path.join(state.extensionDir, "bridge-config.js"), "utf8"),
    /http:\/\/127\.0\.0\.1:54318/,
  );
});

test("overlapping extension preparation shares one deployment", async () => {
  const dirs = fixture();
  const service = createChatgptBridgeService({ ...dirs, requestJson: async () => null });

  const first = service.prepareExtension();
  const second = service.prepareExtension();
  assert.equal(first, second);
  const [firstState, secondState] = await Promise.all([first, second]);
  assert.equal(firstState.extensionReady, true);
  assert.equal(secondState.extensionReady, true);

  const retry = service.prepareExtension();
  assert.notEqual(retry, first);
  assert.equal((await retry).extensionReady, true);
});

test("double quota persists one API token and deploys it only through extension config", async () => {
  const dirs = fixture();
  const first = createChatgptBridgeService({ ...dirs, requestJson: async () => null });

  const firstState = await first.prepareExtension();
  const configPath = path.join(dirs.dataRootDir, "config", "double-quota.json");
  assert.equal(fs.existsSync(configPath), true);
  const savedConfig = JSON.parse(
    fs.readFileSync(configPath, "utf8"),
  );
  const extensionConfig = fs.readFileSync(
    path.join(firstState.extensionDir, "bridge-config.js"),
    "utf8",
  );

  assert.match(savedConfig.apiToken, /^[a-f0-9]{64}$/);
  assert.match(extensionConfig, new RegExp(`apiToken: ${JSON.stringify(savedConfig.apiToken)}`));
  assert.equal(Object.hasOwn(firstState, "apiToken"), false);

  const second = createChatgptBridgeService({ ...dirs, requestJson: async () => null });
  await second.prepareExtension();
  const restoredConfig = JSON.parse(
    fs.readFileSync(configPath, "utf8"),
  );
  assert.equal(restoredConfig.apiToken, savedConfig.apiToken);
});

test("extension deployment does not depend on recursive cpSync and completes in a Chinese user data path", async () => {
  const dirs = fixture();
  const dataRootDir = path.join(dirs.root, "用户李", "data");
  const service = createChatgptBridgeService({
    ...dirs,
    dataRootDir,
    requestJson: async () => null,
  });
  const originalCpSync = fs.cpSync;
  fs.cpSync = () => {
    const error = new Error("simulated recursive copy failure");
    error.code = "EIO";
    throw error;
  };
  try {
    const state = await service.prepareExtension();
    assert.equal(state.extensionReady, true);
    for (const fileName of ["manifest.json", "background.js", "content-script.js", "bridge-config.js"]) {
      assert.equal(fs.existsSync(path.join(state.extensionDir, fileName)), true, fileName);
    }
  } finally {
    fs.cpSync = originalCpSync;
  }
});

test("extension management returns a safe failed state instead of leaking a Windows EIO path", async () => {
  const dirs = fixture();
  const dataRootDir = path.join(dirs.root, "用户李", "data");
  const service = createChatgptBridgeService({
    ...dirs,
    dataRootDir,
    requestJson: async () => null,
  });
  const originalWriteFile = fs.promises.writeFile;
  fs.promises.writeFile = async (target, ...args) => {
    if (String(target).includes(`${path.sep}extensions${path.sep}chatgpt-codex-bridge${path.sep}`)) {
      const error = new Error(`simulated failure at ${target}`);
      error.code = "EIO";
      throw error;
    }
    return originalWriteFile.call(fs.promises, target, ...args);
  };
  let eventLoopAdvanced = false;
  const eventLoopTimer = setTimeout(() => { eventLoopAdvanced = true; }, 5);
  try {
    const state = await service.manageExtension();
    assert.equal(eventLoopAdvanced, true);
    assert.equal(state.extensionUpdate.status, "failed");
    assert.equal(state.extensionUpdate.completed, false);
    assert.equal(state.extensionUpdate.manualReloadRequired, false);
    assert.match(state.extensionUpdate.error, /Chrome 扩展文件更新失败 \(EIO\)/);
    assert.doesNotMatch(state.extensionUpdate.error, /用户李|AppData|extensions/);
  } finally {
    clearTimeout(eventLoopTimer);
    fs.promises.writeFile = originalWriteFile;
  }
});

test("double quota writes only the canonical extension directory and leaves legacy copies untouched", async () => {
  const dirs = fixture();
  const legacyDir = path.join(dirs.dataRootDir, "chatgpt-bridge-extension");
  fs.mkdirSync(legacyDir, { recursive: true });
  for (const fileName of ["manifest.json", "background.js", "content-script.js", "bridge-config.js"]) {
    fs.writeFileSync(path.join(legacyDir, fileName), "legacy\n", "utf8");
  }
  const service = createChatgptBridgeService({ ...dirs, requestJson: async () => null });
  await service.savePort(54319);

  const state = await service.prepareExtension();

  assert.match(state.extensionDir, /extensions[\\/]chatgpt-codex-bridge$/);
  assert.deepEqual(state.extensionUpdateDirs, [state.extensionDir]);
  assert.equal(fs.readFileSync(path.join(legacyDir, "background.js"), "utf8"), "legacy\n");
  assert.equal(fs.readFileSync(path.join(legacyDir, "bridge-config.js"), "utf8"), "legacy\n");
});

test("double quota treats Chrome preference paths as registration evidence without overwriting them", async () => {
  const dirs = fixture();
  const chromeUserDataDir = path.join(dirs.root, "chrome-user-data");
  const profileDir = path.join(chromeUserDataDir, "Default");
  const loadedDir = path.join(dirs.root, "chrome-loaded-extension");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(loadedDir, { recursive: true });
  fs.writeFileSync(
    path.join(loadedDir, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Codex G某T Bridge",
      background: { service_worker: "background.js" },
      content_scripts: [{ js: ["bridge-config.js", "content-script.js"] }],
    }),
    "utf8",
  );
  for (const fileName of ["background.js", "content-script.js", "bridge-config.js"]) {
    fs.writeFileSync(path.join(loadedDir, fileName), "OLD-CHROME-COPY\n", "utf8");
  }
  fs.writeFileSync(
    path.join(profileDir, "Secure Preferences"),
    JSON.stringify({
      extensions: {
        settings: {
          abcdefghijklmnopabcdefghijklmnop: {
            location: 4,
            path: loadedDir,
          },
        },
      },
    }),
    "utf8",
  );
  const service = createChatgptBridgeService({
    ...dirs,
    chromeUserDataDir,
    requestJson: async () => null,
  });

  const state = await service.prepareExtension();

  assert.deepEqual(state.extensionRegisteredDirs, [loadedDir]);
  assert.deepEqual(state.extensionUpdateDirs, [state.extensionDir]);
  assert.equal(fs.readFileSync(path.join(loadedDir, "background.js"), "utf8"), "OLD-CHROME-COPY\n");
  assert.equal(fs.readFileSync(path.join(loadedDir, "bridge-config.js"), "utf8"), "OLD-CHROME-COPY\n");
});

test("double quota also reads unpacked extension paths stored in a direct Chrome Preferences profile", async () => {
  const dirs = fixture();
  const chromeProfileDir = path.join(dirs.root, "custom-chrome-profile");
  const loadedDir = path.join(dirs.root, "preferences-loaded-extension");
  fs.mkdirSync(chromeProfileDir, { recursive: true });
  fs.mkdirSync(loadedDir, { recursive: true });
  fs.writeFileSync(
    path.join(loadedDir, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Codex G某T Bridge",
      background: { service_worker: "background.js" },
      content_scripts: [{ js: ["bridge-config.js", "content-script.js"] }],
    }),
    "utf8",
  );
  for (const fileName of ["background.js", "content-script.js", "bridge-config.js"]) {
    fs.writeFileSync(path.join(loadedDir, fileName), "OLD-PREFERENCES-COPY\n", "utf8");
  }
  fs.writeFileSync(
    path.join(chromeProfileDir, "Preferences"),
    JSON.stringify({
      extensions: {
        settings: {
          ponmlkjihgfedcbaponmlkjihgfedcba: { location: 4, path: loadedDir },
        },
      },
    }),
    "utf8",
  );
  const service = createChatgptBridgeService({
    ...dirs,
    chromeUserDataDir: chromeProfileDir,
    requestJson: async () => null,
  });

  const state = await service.prepareExtension();

  assert.deepEqual(state.extensionRegisteredDirs, [loadedDir]);
  assert.deepEqual(state.extensionChromeIds, ["ponmlkjihgfedcbaponmlkjihgfedcba"]);
  assert.equal(fs.readFileSync(path.join(loadedDir, "content-script.js"), "utf8"), "OLD-PREFERENCES-COPY\n");
});

test("double quota recognizes a verified unpacked extension when Chrome uses a different location enum", async () => {
  const dirs = fixture();
  const chromeProfileDir = path.join(dirs.root, "location-enum-profile");
  const loadedDir = path.join(dirs.root, "location-enum-extension");
  fs.mkdirSync(chromeProfileDir, { recursive: true });
  fs.cpSync(path.join(dirs.vendorDir, "chrome-extension"), loadedDir, { recursive: true });
  fs.writeFileSync(
    path.join(chromeProfileDir, "Preferences"),
    JSON.stringify({
      extensions: {
        settings: {
          abcdefghijklmnopabcdefghijklmnop: { location: 8, path: loadedDir },
        },
      },
    }),
    "utf8",
  );
  const service = createChatgptBridgeService({
    ...dirs,
    chromeUserDataDir: chromeProfileDir,
    requestJson: async () => null,
  });

  const state = await service.getState();

  assert.deepEqual(state.extensionRegisteredDirs, [loadedDir]);
  assert.deepEqual(state.extensionChromeIds, ["abcdefghijklmnopabcdefghijklmnop"]);
});

test("double quota does not mistake the service extension source directory for Chrome's loaded directory", async () => {
  const dirs = fixture();
  const loadedDir = path.join(dirs.root, "diagnostics-loaded-extension");
  fs.mkdirSync(loadedDir, { recursive: true });
  fs.cpSync(path.join(dirs.vendorDir, "chrome-extension"), loadedDir, { recursive: true });
  fs.writeFileSync(path.join(loadedDir, "background.js"), "OLD-DIAGNOSTICS-COPY\n", "utf8");
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async (url) => {
      if (url.endsWith("/health")) return compatibleHealth();
      if (url.endsWith("/version")) return compatibleVersion();
      if (url.endsWith("/api/diagnostics/status")) {
        return {
          extension: {
            version: "v20260711-router-v2-safety",
            expectedVersion: "v20260712-preference-verify",
            connected: true,
            needsReload: true,
            sourceDir: loadedDir,
          },
        };
      }
      return null;
    },
  });

  const state = await service.prepareExtension();

  assert.deepEqual(state.extensionRegisteredDirs, []);
  assert.equal(state.extensionAction.id, "load");
  assert.deepEqual(state.extensionUpdateDirs, [state.extensionDir]);
  assert.equal(fs.readFileSync(path.join(loadedDir, "background.js"), "utf8"), "OLD-DIAGNOSTICS-COPY\n");
  assert.equal(state.extensionManagerRevision, "verified-stable-dir-v2");
  assert.equal(state.extensionDeployment.verified, true);
  assert.equal(
    state.extensionDeployment.targets.find((target) => target.path === state.extensionDir)?.verified,
    true,
  );
  assert.match(state.extensionDeployment.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("double quota deployment returns immediately instead of polling Chrome", async () => {
  const dirs = fixture();
  const profileDir = path.join(dirs.chromeUserDataDir, "Default");
  const loadedDir = path.join(dirs.root, "reloadable-chrome-extension");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.cpSync(path.join(dirs.vendorDir, "chrome-extension"), loadedDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "Secure Preferences"),
    JSON.stringify({ extensions: { settings: { abcdefghijklmnopabcdefghijklmnop: { location: 4, path: loadedDir } } } }),
    "utf8",
  );
  let diagnosticsReads = 0;
  const service = createChatgptBridgeService({
    ...dirs,
    delay: async () => {},
    requestJson: async (url) => {
      if (url.endsWith("/health")) return compatibleHealth();
      if (url.endsWith("/version")) return compatibleVersion();
      if (url.endsWith("/api/diagnostics/status")) {
        diagnosticsReads += 1;
        return { extension: { version: "v20260711-router-v2-safety", expectedVersion: "v20260712-preference-verify", connected: true, needsReload: true } };
      }
      return null;
    },
  });

  const state = await service.manageExtension();

  assert.equal(state.extensionAction.id, "load");
  assert.equal(state.extensionUpdate.status, "files_ready");
  assert.equal(state.extensionUpdate.manualReloadRequired, true);
  assert.equal(state.extensionUpdate.diskVerified, true);
  assert.equal(diagnosticsReads, 1);
});

test("verified extension deployment receipt survives service recreation", async () => {
  const dirs = fixture();
  const first = createChatgptBridgeService({ ...dirs, requestJson: async () => null });

  const installed = await first.prepareExtension();
  assert.equal(installed.extensionDisk.status, "current");
  assert.equal(installed.extensionDisk.verified, true);
  assert.equal(installed.extensionDeployment.persisted, true);
  assert.equal(fs.existsSync(installed.extensionDeployment.receiptPath), true);

  const second = createChatgptBridgeService({ ...dirs, requestJson: async () => null });
  const restored = await second.getState();
  assert.equal(restored.extensionDisk.status, "current");
  assert.equal(restored.extensionDisk.verified, true);
  assert.equal(restored.extensionDeployment.persisted, true);
  assert.equal(restored.extensionDeployment.target, restored.extensionDir);
});

test("disk installation, Chrome registration, and runtime connection are reported separately", async () => {
  const dirs = fixture();
  const service = createChatgptBridgeService({ ...dirs, requestJson: async () => null });
  await service.prepareExtension();

  const state = await service.getState();

  assert.equal(state.extensionDisk.status, "current");
  assert.equal(state.extensionBrowser.status, "not_registered");
  assert.equal(state.extensionRuntime.status, "service_offline");
  assert.equal(state.extensionInstallation.status, "awaiting_browser");
  assert.equal(state.extensionInstallation.installed, false);
  assert.equal(state.extensionAction.id, "load");
});

test("oversized extension files degrade disk verification without blocking the state page", async () => {
  const dirs = fixture();
  const service = createChatgptBridgeService({ ...dirs, requestJson: async () => null });
  const prepared = await service.prepareExtension();
  const backgroundPath = path.join(prepared.extensionDir, "background.js");
  const descriptor = fs.openSync(backgroundPath, "w");
  try { fs.ftruncateSync(descriptor, 8 * 1024 * 1024 + 1); }
  finally { fs.closeSync(descriptor); }

  const state = await service.getState();
  assert.equal(state.extensionDisk.verified, false);
  assert.equal(state.extensionDisk.mismatches.includes("background.js"), true);
});

test("a Chrome-registered extension remains installed while the service is stopped", async () => {
  const dirs = fixture();
  const service = createChatgptBridgeService({ ...dirs, requestJson: async () => null });
  const prepared = await service.prepareExtension();
  const profileDir = path.join(dirs.chromeUserDataDir, "Default");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "Preferences"),
    JSON.stringify({
      extensions: {
        settings: {
          abcdefghijklmnopabcdefghijklmnop: {
            location: 4,
            path: prepared.extensionDir,
            state: 1,
          },
        },
      },
    }),
    "utf8",
  );

  const state = await service.getState();

  assert.equal(state.running, false);
  assert.equal(state.extensionBrowser.registeredStable, true);
  assert.equal(state.extensionRuntime.status, "service_offline");
  assert.equal(state.extensionRuntime.observable, false);
  assert.equal(state.extensionInstallation.status, "installed");
  assert.equal(state.extensionInstallation.installed, true);
  assert.equal(state.extensionAction.id, "installed");
  assert.equal(state.extensionAction.complete, true);
});

test("MCP repair preserves unrelated Codex configuration and is idempotent", async () => {
  const existing = [
    'model = "gpt-5.6"',
    "",
    "[mcp_servers.github]",
    'command = "github-mcp"',
    "",
    "[mcp_servers.chatgpt_codex_bridge]",
    'command = "old.exe"',
    'args = ["old.js"]',
    "",
    "[mcp_servers.chatgpt_codex_bridge.env]",
    'BRIDGE_DATA_DIR = "old-data"',
    "",
    "[projects.'C:\\\\work']",
    'trust_level = "trusted"',
    "",
  ].join("\n");
  const payload = {
    command: "C:/Apps/CodexBridge.exe",
    mcpEntry: "C:/Apps/vendor/chatgpt-codex-bridge/src/mcp-server.js",
    dataDir: "C:/Users/test/AppData/Roaming/CodexBridge/chatgpt-bridge",
  };

  const first = upsertChatgptBridgeMcpConfig(existing, payload);
  const second = upsertChatgptBridgeMcpConfig(first, payload);

  assert.equal(first, second);
  assert.match(first, /\[mcp_servers\.github\][\s\S]*command = "github-mcp"/);
  assert.match(first, /\[projects\.'C:\\\\work'\][\s\S]*trust_level = "trusted"/);
  assert.match(first, /\[mcp_servers\.chatgpt_codex_bridge\][\s\S]*C:\/Apps\/CodexBridge\.exe/);
  assert.match(first, /BRIDGE_ROUTER_V2 = "1"/);
  assert.equal((first.match(/\[mcp_servers\.chatgpt_codex_bridge\]/g) || []).length, 1);
});

for (const transition of ["stop", "restart", "exit"]) {
  test(`a pending state probe does not publish an old child as current after ${transition}`, { timeout: 10_000 }, async () => {
    const dirs = fixture();
    let activeChild = null;
    let activePort = 0;
    let pauseNextHealth = false;
    let markPaused;
    let releaseProbe;
    const paused = new Promise((resolve) => { markPaused = resolve; });
    const released = new Promise((resolve) => { releaseProbe = resolve; });
    const service = createChatgptBridgeService({
      ...dirs,
      requestJson: async (url) => {
        const response = activeChild && Number(new URL(url).port) === activePort
          ? compatibleServiceResponse(url)
          : null;
        if (pauseNextHealth && url.endsWith("/health")) {
          pauseNextHealth = false;
          markPaused();
          await released;
        }
        return response;
      },
      spawnImpl(_command, _args, options) {
        activePort = Number(options.env.BRIDGE_PORT);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = (signal) => {
          if (activeChild === child) activeChild = null;
          queueMicrotask(() => child.emit("exit", 0, signal));
          return true;
        };
        activeChild = child;
        return child;
      },
      delay: async () => {},
    });
    await service.start();
    pauseNextHealth = true;
    const reading = service.getState();
    try {
      await paused;
      if (transition === "restart") {
        await service.savePort(54318);
        await service.restart();
      } else if (transition === "exit") {
        const exited = activeChild;
        activeChild = null;
        exited.emit("exit", 7, null);
      } else {
        await service.stop();
      }
      releaseProbe();
      const state = await reading;
      if (transition === "restart") {
        assert.equal(state.activePort, 54318);
        assert.equal(state.url, "http://127.0.0.1:54318/");
        assert.equal(state.running, true);
        assert.equal(state.ownedProcess, true);
        assert.equal(state.restartRequired, false);
      } else {
        assert.equal(state.running, false);
        assert.equal(state.ownedProcess, false);
        assert.equal(state.status, transition === "exit" ? "error" : "stopped");
      }
      assert.equal(state.externalProcess, false);
    } finally {
      releaseProbe();
      await Promise.allSettled([reading]);
      await service.stop();
    }
  });
}

test("state probes bound retries while port configuration changes continuously", { timeout: 10_000 }, async () => {
  const dirs = fixture();
  const configPath = path.join(dirs.dataRootDir, "config", "double-quota.json");
  let changing = true;
  let changes = 0;
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async (url) => {
      if (changing && url.endsWith("/health")) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        config.port = 54000 + ++changes;
        fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
      }
      return null;
    },
  });
  try {
    await assert.rejects(service.getState(), (error) => error.code === "STATE_SNAPSHOT_CHANGED_DURING_READ");
    assert.ok(changes > 1 && changes <= 3, "state retries must be bounded");
  } finally {
    changing = false;
  }
  const state = await service.getState();
  assert.equal(state.status, "stopped");
  assert.equal(state.configuredPort, 54000 + changes);
  assert.equal(state.activePort, 54000 + changes);
});

test("service attaches to a compatible external process and never kills it", async () => {
  const dirs = fixture();
  let spawnCalls = 0;
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async (url) => compatibleServiceResponse(url),
    spawnImpl() {
      spawnCalls += 1;
      throw new Error("must not spawn");
    },
  });

  const started = await service.start();
  const stopped = await service.stop();

  assert.equal(spawnCalls, 0);
  assert.equal(started.status, "attached");
  assert.equal(started.ownedProcess, false);
  assert.equal(stopped.status, "attached");
  assert.equal(stopped.externalProcess, true);
});

test("maintenance and restart refuse to interrupt an active Bridge task", async () => {
  const dirs = fixture();
  let serviceAlive = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return true;
  };
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async (url) => {
      if (!serviceAlive) return null;
      if (url.endsWith("/api/diagnostics/status")) {
        return {
          activeSyncJob: { id: "sync_active", status: "running" },
          status: { state: "running", reason: "G某T 正在处理" },
          extension: {},
        };
      }
      return compatibleServiceResponse(url);
    },
    spawnImpl() {
      serviceAlive = true;
      return child;
    },
    delay: async () => {},
  });
  await service.start();

  await assert.rejects(() => service.assertMaintenanceSafe("更新"), /正在运行.*稍后/i);
  await assert.rejects(() => service.restart(), /正在运行.*稍后/i);
  assert.deepEqual(child.killSignals, []);
});

test("explicit restart replaces only the owned Bridge child", async () => {
  const dirs = fixture();
  let activeChild = null;
  let spawnCalls = 0;
  const children = [];
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async (url) => activeChild
      ? compatibleServiceResponse(url)
      : null,
    spawnImpl() {
      spawnCalls += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killSignals = [];
      child.kill = (signal) => {
        child.killSignals.push(signal);
        activeChild = null;
        queueMicrotask(() => child.emit("exit", 0, signal));
        return true;
      };
      children.push(child);
      activeChild = child;
      return child;
    },
    delay: async () => {},
  });
  await service.start();

  const restarted = await service.restart();

  assert.equal(restarted.status, "running");
  assert.equal(spawnCalls, 2);
  assert.deepEqual(children[0].killSignals, ["SIGTERM"]);
  assert.deepEqual(children[1].killSignals, []);
  assert.doesNotThrow(() => children[0].emit("error", new Error("old child late error")));
  assert.doesNotThrow(() => children[0].emit("error", new Error("old child repeated late error")));
  const current = await service.getState();
  assert.equal(current.ownedProcess, true);
  assert.equal(current.error, restarted.error);
  await service.stop();
});

for (const pauseAt of ["maintenance diagnostics", "post-stop state"]) {
  test(`a later stop cancels a restart waiting for ${pauseAt}`, { timeout: 10_000 }, async () => {
    const dirs = fixture();
    let activeChild = null;
    let spawnCalls = 0;
    let armed = false;
    let pauseObserved = false;
    let diagnosticsCalls = 0;
    let markPaused;
    let resume;
    const paused = new Promise((resolve) => { markPaused = resolve; });
    const resumed = new Promise((resolve) => { resume = resolve; });
    const service = createChatgptBridgeService({
      ...dirs,
      requestJson: async (url) => {
        // A probe already in flight can finish with its pre-stop snapshot.
        const response = activeChild ? compatibleServiceResponse(url) : null;
        if (armed && !pauseObserved && url.endsWith("/api/diagnostics/status")) {
          diagnosticsCalls += 1;
          const shouldPause = pauseAt === "maintenance diagnostics"
            ? diagnosticsCalls === 2
            : activeChild === null;
          if (shouldPause) {
            pauseObserved = true;
            markPaused();
            await resumed;
          }
        }
        return response;
      },
      spawnImpl() {
        spawnCalls += 1;
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = (signal) => {
          if (activeChild === child) activeChild = null;
          queueMicrotask(() => child.emit("exit", 0, signal));
          return true;
        };
        activeChild = child;
        return child;
      },
      delay: async () => {},
    });
    await service.start();
    armed = true;
    const restartOutcome = service.restart().then(
      (state) => ({ state }),
      (error) => ({ error }),
    );
    try {
      await paused;
      const stopped = await service.stop();
      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.ownedProcess, false);
      resume();
      const outcome = await restartOutcome;
      assert.equal(spawnCalls, 1, "an older restart must not undo a later stop");
      assert.equal(outcome.error?.code, "bridge_start_cancelled");
      const current = await service.getState();
      assert.equal(current.running, false);
      assert.equal(current.ownedProcess, false);

      const startedAgain = await service.start();
      assert.equal(startedAgain.status, "running");
      assert.equal(startedAgain.ownedProcess, true);
      assert.equal(spawnCalls, 2);
    } finally {
      resume();
      await restartOutcome;
      await service.stop();
    }
  });
}

test("owned Bridge stop reports when graceful exit requires a forced fallback", async () => {
  const dirs = fixture();
  let serviceAlive = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    if (signal === "SIGKILL") {
      serviceAlive = false;
      queueMicrotask(() => child.emit("exit", null, signal));
    }
    return true;
  };
  const service = createChatgptBridgeService({
    ...dirs,
    stopTimeoutMs: 5,
    requestJson: async (url) => serviceAlive
      ? compatibleServiceResponse(url)
      : null,
    spawnImpl() {
      serviceAlive = true;
      return child;
    },
    delay: async () => {},
  });
  await service.start();

  const stopped = await service.stop();

  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.forcedStop, true);
  assert.match(stopped.message, /未能正常退出.*强制停止/);
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
});

test("owned Bridge remains retryable when forced stop is not confirmed", async () => {
  const dirs = fixture();
  let serviceAlive = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return true;
  };
  const service = createChatgptBridgeService({
    ...dirs,
    stopTimeoutMs: 5,
    requestJson: async (url) => serviceAlive ? compatibleServiceResponse(url) : null,
    spawnImpl() {
      serviceAlive = true;
      return child;
    },
    delay: async () => {},
  });
  await service.start();

  await assert.rejects(() => service.stop(), (error) => {
    assert.equal(error.code, "bridge_force_stop_unconfirmed");
    return true;
  });
  const state = await service.getState();
  assert.equal(state.status, "running");
  assert.equal(state.ownedProcess, true);
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
});

test("Bridge startup timeout confirms owned child exit before releasing ownership", async () => {
  const dirs = fixture();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    queueMicrotask(() => child.emit("exit", 0, signal));
    return true;
  };
  const service = createChatgptBridgeService({
    ...dirs,
    stopTimeoutMs: 5,
    requestJson: async () => null,
    spawnImpl: () => child,
    delay: async () => {},
  });

  await assert.rejects(() => service.start(), /启动超时/u);
  const state = await service.getState();
  assert.equal(state.ownedProcess, false);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
});

test("synchronous child launch failures restore a retryable non-owned error state", async () => {
  const dirs = fixture();
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async () => null,
    spawnImpl() {
      throw new Error("spawn denied");
    },
  });

  await assert.rejects(() => service.start(), /spawn denied/);
  const state = await service.getState();

  assert.equal(state.status, "error");
  assert.equal(state.ownedProcess, false);
});

test("asynchronous child launch failures are reported without a null-child stop crash", async () => {
  const dirs = fixture();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async () => null,
    spawnImpl() {
      queueMicrotask(() => child.emit("error", new Error("async spawn denied")));
      return child;
    },
    delay: async () => {},
  });

  await assert.rejects(() => service.start(), (error) => {
    assert.equal(error.code, "bridge_start_failed");
    assert.match(error.message, /async spawn denied/u);
    return true;
  });
  const state = await service.getState();
  assert.equal(state.ownedProcess, false);
  assert.doesNotThrow(() => child.emit("error", new Error("late spawn error")));
  assert.doesNotThrow(() => child.emit("error", new Error("repeated late spawn error")));
});

test("an owned child that exits during startup reports its real exit instead of stopping null", async () => {
  const dirs = fixture();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async () => null,
    spawnImpl() {
      queueMicrotask(() => child.emit("exit", 7, null));
      return child;
    },
    delay: async () => {},
  });

  await assert.rejects(() => service.start(), (error) => {
    assert.equal(error.code, "bridge_start_exited");
    assert.match(error.message, /code=7/u);
    return true;
  });
});

test("concurrent service starts share one child launch", async () => {
  const dirs = fixture();
  let serviceAlive = false;
  let spawnCalls = 0;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async (url) => serviceAlive ? compatibleServiceResponse(url) : null,
    spawnImpl() {
      spawnCalls += 1;
      serviceAlive = true;
      return child;
    },
    delay: async () => {},
  });

  const [first, second] = await Promise.all([service.start(), service.start()]);
  assert.equal(first.status, "running");
  assert.equal(second.status, "running");
  assert.equal(spawnCalls, 1);
});

test("stopping during the initial probe cancels the pending start before spawn", async () => {
  const dirs = fixture();
  let releaseInitialProbe;
  const initialProbe = new Promise((resolve) => { releaseInitialProbe = resolve; });
  let requestCalls = 0;
  let spawnCalls = 0;
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async () => {
      requestCalls += 1;
      if (requestCalls === 1) await initialProbe;
      return null;
    },
    spawnImpl() {
      spawnCalls += 1;
      throw new Error("cancelled start must not spawn");
    },
  });

  const starting = service.start();
  while (requestCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  const stopped = await service.stop();
  releaseInitialProbe();

  assert.equal(stopped.status, "stopped");
  await assert.rejects(starting, (error) => error?.code === "bridge_start_cancelled");
  assert.equal(spawnCalls, 0);
});

test("failed stop signals keep the owned child retryable instead of sticking in stopping", async () => {
  const dirs = fixture();
  let serviceAlive = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => false;
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async (url) => serviceAlive ? compatibleServiceResponse(url) : null,
    spawnImpl() {
      serviceAlive = true;
      return child;
    },
    delay: async () => {},
  });
  await service.start();

  await assert.rejects(() => service.stop(), /退出信号发送失败/);
  const state = await service.getState();

  assert.equal(state.status, "running");
  assert.equal(state.ownedProcess, true);
});

test("service starts and gracefully stops only its owned Electron-as-Node child", async () => {
  const dirs = fixture();
  let serviceAlive = false;
  const child = new EventEmitter();
  child.pid = 43210;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    serviceAlive = false;
    queueMicrotask(() => child.emit("exit", 0, signal));
    return true;
  };
  let healthCalls = 0;
  let spawnArgs = null;
  const service = createChatgptBridgeService({
    ...dirs,
    execPath: "C:\\Apps\\CodexBridge.exe",
    requestJson: async (url) => {
      healthCalls += 1;
      if (healthCalls >= 2 && child.killSignals.length === 0) {
        serviceAlive = true;
      }
      return serviceAlive ? compatibleServiceResponse(url) : null;
    },
    spawnImpl(command, args, options) {
      spawnArgs = { command, args, options };
      return child;
    },
    delay: async () => {},
  });

  const started = await service.start();
  const stopped = await service.stop();

  assert.equal(started.status, "running");
  assert.equal(started.ownedProcess, true);
  assert.equal(spawnArgs.command, "C:\\Apps\\CodexBridge.exe");
  assert.deepEqual(spawnArgs.args, [path.join(dirs.vendorDir, "src", "index.js")]);
  assert.equal(spawnArgs.options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(spawnArgs.options.env.BRIDGE_PORT, "4317");
  const savedConfig = JSON.parse(
    fs.readFileSync(path.join(dirs.dataRootDir, "config", "double-quota.json"), "utf8"),
  );
  assert.equal(spawnArgs.options.env.BRIDGE_API_TOKEN, savedConfig.apiToken);
  assert.equal(spawnArgs.options.env.BRIDGE_ROUTER_V2, "1");
  assert.equal(spawnArgs.options.windowsHide, true);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(stopped.status, "stopped");
});

test("a real asynchronous spawn failure has no owned process and remains retryable", async () => {
  const dirs = fixture();
  const service = createChatgptBridgeService({
    ...dirs,
    execPath: path.join(dirs.appRootDir, "nonexistent-executable.exe"),
    requestJson: async () => null,
    delay: () => new Promise((resolve) => setImmediate(resolve)),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(service.start(), (error) => {
      assert.equal(error.code, "bridge_start_failed");
      assert.match(error.message, /ENOENT/u);
      return true;
    });
    assert.equal((await service.getState()).ownedProcess, false);
  }
  assert.equal((await service.stop()).ownedProcess, false);
});

test("child kill errors retain ownership and the active port for a later stop retry", async () => {
  const { service, child } = outputFailureFixture();
  const killSuccessfully = child.kill;
  let attempts = 0;
  child.kill = (signal) => {
    attempts += 1;
    assert.equal(signal, "SIGTERM");
    if (attempts <= 2) {
      child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" }));
      return false;
    }
    return killSuccessfully(signal);
  };
  const started = await service.start();
  try {
    await service.savePort(started.activePort + 1);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(service.stop(), (error) => error.code === "bridge_stop_signal_rejected");
      const retained = await service.getState();
      assert.equal(retained.ownedProcess, true, "a failed kill must not turn our live child into an external process");
      assert.equal(retained.externalProcess, false);
      assert.equal(retained.activePort, started.activePort);
    }
    const stopped = await service.stop();
    assert.equal(stopped.ownedProcess, false);
    assert.equal(attempts, 3);
  } finally {
    child.kill = killSuccessfully;
    await service.stop();
  }
});

test("repeated child runtime errors remain nonfatal and only an exit releases ownership", async () => {
  const { service, child } = outputFailureFixture();
  await service.start();
  try {
    for (let index = 0; index < 2; index += 1) {
      assert.doesNotThrow(() => child.emit("error", new Error("runtime-operation-failed")));
      assert.equal((await service.getState()).ownedProcess, true);
    }
    await service.stop();
    assert.doesNotThrow(() => child.emit("error", new Error("late-error-after-exit")));
    assert.equal((await service.getState()).ownedProcess, false);
  } finally {
    await service.stop();
  }
});

test("startup timeout kill errors keep the spawned child available for stop retry", async () => {
  const dirs = fixture();
  const child = new EventEmitter();
  child.pid = 43213;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let denied = true;
  child.kill = (signal) => {
    if (denied) {
      child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" }));
      return false;
    }
    queueMicrotask(() => child.emit("exit", 0, signal));
    return true;
  };
  const service = createChatgptBridgeService({
    ...dirs, requestJson: async () => null, spawnImpl: () => child, delay: async () => {},
  });
  try {
    await assert.rejects(service.start(), /启动超时/u);
    assert.equal((await service.getState()).ownedProcess, true);
    denied = false;
    assert.equal((await service.stop()).ownedProcess, false);
  } finally {
    denied = false;
    await service.stop();
  }
});

function outputFailureFixture(log, { blockExtension = false } = {}) {
  const dirs = fixture();
  if (blockExtension) {
    fs.mkdirSync(dirs.dataRootDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.dataRootDir, "extensions"), "blocks extension directory\n", "utf8");
  }
  let alive = false;
  const child = new EventEmitter();
  child.pid = 43212;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    alive = false;
    queueMicrotask(() => child.emit("exit", 0, signal));
    return true;
  };
  const service = createChatgptBridgeService({
    ...dirs, log,
    requestJson: async (url) => alive ? compatibleServiceResponse(url) : null,
    spawnImpl: () => { alive = true; return child; },
    delay: async () => {},
  });
  return { service, child };
}

test("owned child output pipe errors remain nonfatal before and after stop", async () => {
  const logs = [];
  const { service, child } = outputFailureFixture((message) => logs.push(message));
  await service.start();
  try {
    for (const channel of ["stdout", "stderr"]) {
      child[channel].emit("data", Buffer.from(`normal-${channel}`));
      assert.doesNotThrow(() => child[channel].emit("error", new Error(`${channel}-pipe-failed`)));
      assert.ok(logs.some((message) => message.includes(`normal-${channel}`)));
      assert.ok(logs.some((message) => message.includes(`${channel}-pipe-failed`)));
    }
    assert.equal((await service.getState()).ownedProcess, true);
    assert.deepEqual(child.killSignals, []);
    await service.stop();
    for (const channel of ["stdout", "stderr"]) {
      assert.doesNotThrow(() => child[channel].emit("error", new Error(`late-${channel}-failure`)));
    }
    assert.equal((await service.getState()).ownedProcess, false);
    assert.deepEqual(child.killSignals, ["SIGTERM"]);
  } finally {
    await service.stop();
  }
});

for (const failure of ["throw", "reject"]) {
  test(`owned child logging ${failure} does not break service control`, async () => {
    const { service, child } = outputFailureFixture(() => {
      const error = new Error("log-sink-failed");
      if (failure === "throw") throw error;
      return Promise.reject(error);
    });
    await service.start();
    try {
      assert.doesNotThrow(() => child.stdout.emit("data", Buffer.from("stdout text")));
      assert.doesNotThrow(() => child.stderr.emit("data", Buffer.from("stderr text")));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await service.getState()).running, true);
      await service.stop();
      assert.equal((await service.getState()).ownedProcess, false);
    } finally {
      await service.stop();
    }
  });

  test(`optional extension warning logging ${failure} keeps startup and repair usable`, async () => {
    const { service } = outputFailureFixture(() => {
      const error = new Error("warning-log-sink-failed");
      if (failure === "throw") throw error;
      return Promise.reject(error);
    }, { blockExtension: true });
    try {
      const started = await service.start();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(started.running, true);
      assert.match(started.extensionError, /extension|扩展|ENOTDIR|EEXIST/i);
      const repaired = await service.manageExtension();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(repaired.running, true);
      assert.equal(repaired.extensionUpdate.status, "failed");
      assert.match(repaired.extensionUpdate.error, /extension|扩展|ENOTDIR|EEXIST/i);
    } finally {
      await service.stop();
    }
  });
}

test("real embedded service starts, reports ready, deploys its extension, and releases its port", {
  timeout: 30_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-double-quota-real-"));
  const appRootDir = fileURLToPath(new URL("../", import.meta.url));
  const dataRootDir = path.join(root, "data");
  const homeDir = path.join(root, "home");
  const chromeUserDataDir = path.join(root, "chrome");
  fs.mkdirSync(homeDir, { recursive: true });
  const service = createChatgptBridgeService({
    appRootDir,
    dataRootDir,
    homeDir,
    chromeUserDataDir,
    execPath: process.execPath,
    stopTimeoutMs: 5_000,
  });
  t.after(async () => {
    await service.stop().catch(() => {});
  });

  const port = await availableLoopbackPort();
  await service.savePort(port);
  const started = await service.start();
  assert.equal(started.running, true);
  assert.equal(started.ownedProcess, true);
  assert.equal(started.health?.status, "ready");
  assert.equal(started.extensionDisk?.verified, true);
  assert.equal(fs.existsSync(path.join(started.extensionDir, "manifest.json")), true);

  const nextPort = await availableLoopbackPort();
  assert.notEqual(nextPort, port);
  await service.savePort(nextPort);
  const repaired = await service.manageExtension();
  const repairedConfig = runInNewContext(
    `${fs.readFileSync(path.join(repaired.extensionDir, "bridge-config.js"), "utf8")}\nCODEX_BRIDGE_CONFIG;`,
  );
  assert.equal(repairedConfig.origin, `http://127.0.0.1:${port}`);
  const extensionHealth = await fetch(`${repairedConfig.origin}/health`);
  assert.equal(extensionHealth.status, 200);
  assert.equal((await extensionHealth.json()).status, "ready");

  const restarted = await service.restart();
  assert.equal(restarted.running, true);
  assert.equal(restarted.ownedProcess, true);
  assert.equal(restarted.activePort, nextPort);
  assert.equal(restarted.extensionDisk?.verified, true);

  const stopped = await service.stop();
  assert.equal(stopped.running, false);
  assert.equal(stopped.ownedProcess, false);
  for (const releasedPort of [port, nextPort]) {
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(releasedPort, "127.0.0.1", () => probe.close(resolve));
    });
  }
});

test("service start is not blocked when the optional Chrome extension refresh fails", async () => {
  const dirs = fixture();
  fs.mkdirSync(dirs.dataRootDir, { recursive: true });
  fs.writeFileSync(path.join(dirs.dataRootDir, "extensions"), "blocks extension directory\n", "utf8");
  let serviceAlive = false;
  const child = new EventEmitter();
  child.pid = 43211;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  let healthCalls = 0;
  let spawnCalls = 0;
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async (url) => {
      healthCalls += 1;
      if (healthCalls >= 2) serviceAlive = true;
      return serviceAlive ? compatibleServiceResponse(url) : null;
    },
    spawnImpl() {
      spawnCalls += 1;
      return child;
    },
    delay: async () => {},
  });

  const started = await service.start();

  assert.equal(spawnCalls, 1);
  assert.equal(started.status, "running");
  assert.match(started.extensionError, /extension|扩展|ENOTDIR|EEXIST/i);
});
