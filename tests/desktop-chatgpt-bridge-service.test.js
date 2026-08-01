import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
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
      name: "Codex GPT Bridge",
      version: "0.1.1",
      version_name: "0.1.1 - 20260712",
      background: { service_worker: "background.js" },
      content_scripts: [{ js: ["bridge-config.js", "bridge-auth.js", "content-script.js"] }],
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(vendorDir, "chrome-extension", "background.js"), "// background\n", "utf8");
  fs.writeFileSync(path.join(vendorDir, "chrome-extension", "content-script.js"), "// content\n", "utf8");
  fs.writeFileSync(path.join(vendorDir, "chrome-extension", "bridge-auth.js"), "// auth\n", "utf8");
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
      extensionDir: "chrome-extension",
    }),
    "utf8",
  );
  return { root, appRootDir, dataRootDir, homeDir, vendorDir, chromeUserDataDir };
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
    extensionProtocolVersion: "v20260712-preference-verify",
  };
}

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
  assert.equal(state.extensionManifestVersion, "0.1.1");
  assert.equal(state.extensionDisplayVersion, "0.1.1 - 20260712");
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

test("embedded Chrome extension exposes a user-visible build version", () => {
  const extensionManifest = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "vendor", "chatgpt-codex-bridge", "chrome-extension", "manifest.json"), "utf8"),
  );

  assert.equal(extensionManifest.version, "0.1.1");
  assert.match(extensionManifest.version_name, /20260712/);
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
    requested[2].options.headers["X-CodexBridge-Token"],
    savedConfig.authToken,
  );
  assert.equal(state.serviceVersion, "0.1.0");
  assert.equal(state.extensionProtocolVersion, "v20260712-preference-verify");
  assert.equal(state.versionCompatible, true);
});

test("double quota extension management exposes install, update, repair, and current states", async () => {
  const scenarios = [
    { extension: { diskVerified: false, version: "", expectedVersion: "v2", connected: false, needsReload: false, registeredStable: false }, action: "install", label: "安装扩展" },
    { extension: { diskVerified: true, version: "v1", expectedVersion: "v2", connected: true, needsReload: true, registeredStable: true }, action: "update", label: "更新扩展" },
    { extension: { diskVerified: true, version: "v2", expectedVersion: "v2", connected: false, needsReload: false, registeredStable: true }, action: "repair", label: "修复扩展" },
    { extension: { diskVerified: true, version: "v2", expectedVersion: "v2", connected: true, needsReload: false, registeredStable: true }, action: "current", label: "扩展已是最新" },
    { extension: { diskVerified: true, version: "", expectedVersion: "v2", connected: false, needsReload: false, registeredStable: false }, action: "load", label: "在 Chrome 中安装" },
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

test("double quota prepares a stable extension with the configured origin", async () => {
  const dirs = fixture();
  const service = createChatgptBridgeService({ ...dirs, requestJson: async () => null });
  await service.savePort(54318);

  const state = await service.prepareExtension();

  assert.equal(state.extensionReady, true);
  assert.match(state.extensionDir, /extensions[\\/]chatgpt-codex-bridge$/);
  assert.equal(fs.existsSync(path.join(state.extensionDir, "manifest.json")), true);
  for (const fileName of ["manifest.json", "background.js", "content-script.js", "bridge-auth.js", "bridge-config.js"]) {
    assert.equal(fs.existsSync(path.join(state.extensionDir, fileName)), true, fileName);
  }
  assert.match(
    fs.readFileSync(path.join(state.extensionDir, "bridge-config.js"), "utf8"),
    /http:\/\/127\.0\.0\.1:54318/,
  );
});

test("double quota persists one auth token and deploys it only through extension config", async () => {
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

  assert.match(savedConfig.authToken, /^[a-f0-9]{64}$/);
  assert.match(extensionConfig, new RegExp(`authToken: ${JSON.stringify(savedConfig.authToken)}`));
  assert.equal(Object.hasOwn(firstState, "authToken"), false);

  const second = createChatgptBridgeService({ ...dirs, requestJson: async () => null });
  await second.prepareExtension();
  const restoredConfig = JSON.parse(
    fs.readFileSync(configPath, "utf8"),
  );
  assert.equal(restoredConfig.authToken, savedConfig.authToken);
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
    for (const fileName of ["manifest.json", "background.js", "content-script.js", "bridge-auth.js", "bridge-config.js"]) {
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
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (target, ...args) => {
    if (String(target).includes(`${path.sep}extensions${path.sep}chatgpt-codex-bridge${path.sep}`)) {
      const error = new Error(`simulated failure at ${target}`);
      error.code = "EIO";
      throw error;
    }
    return originalWriteFileSync(target, ...args);
  };
  try {
    const state = await service.manageExtension();
    assert.equal(state.extensionUpdate.status, "failed");
    assert.equal(state.extensionUpdate.completed, false);
    assert.equal(state.extensionUpdate.manualReloadRequired, false);
    assert.match(state.extensionUpdate.error, /Chrome 扩展文件更新失败 \(EIO\)/);
    assert.doesNotMatch(state.extensionUpdate.error, /用户李|AppData|extensions/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
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
      name: "Codex GPT Bridge",
      background: { service_worker: "background.js" },
      content_scripts: [{ js: ["bridge-config.js", "bridge-auth.js", "content-script.js"] }],
    }),
    "utf8",
  );
  for (const fileName of ["background.js", "content-script.js", "bridge-auth.js", "bridge-config.js"]) {
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
      name: "Codex GPT Bridge",
      background: { service_worker: "background.js" },
      content_scripts: [{ js: ["bridge-config.js", "bridge-auth.js", "content-script.js"] }],
    }),
    "utf8",
  );
  for (const fileName of ["background.js", "content-script.js", "bridge-auth.js", "bridge-config.js"]) {
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
  assert.equal(state.extensionAction.id, "update");
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

test("double quota update returns immediately after verified deployment instead of polling Chrome", async () => {
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

  assert.equal(state.extensionAction.id, "update");
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
  assert.equal(state.extensionRuntime.status, "not_connected");
  assert.equal(state.extensionAction.id, "load");
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
  assert.match(first, /BRIDGE_ROUTER_V2 = "0"/);
  assert.equal((first.match(/\[mcp_servers\.chatgpt_codex_bridge\]/g) || []).length, 1);
});

test("service attaches to a compatible external process and never kills it", async () => {
  const dirs = fixture();
  let spawnCalls = 0;
  const service = createChatgptBridgeService({
    ...dirs,
    requestJson: async () => compatibleHealth(),
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
    requestJson: async () => {
      healthCalls += 1;
      if (healthCalls >= 2 && child.killSignals.length === 0) {
        serviceAlive = true;
      }
      return serviceAlive ? compatibleHealth() : null;
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
  assert.equal(spawnArgs.options.env.BRIDGE_AUTH_TOKEN, savedConfig.authToken);
  assert.equal(spawnArgs.options.env.BRIDGE_ROUTER_V2, "0");
  assert.equal(spawnArgs.options.windowsHide, true);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(stopped.status, "stopped");
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
    requestJson: async () => {
      healthCalls += 1;
      if (healthCalls >= 2) serviceAlive = true;
      return serviceAlive ? compatibleHealth() : null;
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
