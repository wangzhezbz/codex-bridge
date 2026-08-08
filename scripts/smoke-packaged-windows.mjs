import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHistoryRecoveryE2EFixture,
  historyRecoveryFixtureCounts,
} from "./history-recovery-e2e-fixture.mjs";
import {
  assertWindowsPackageFilePaths,
  assertWindowsSoftwareManagerPackagePaths,
} from "./package-content-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = newestPackagedAppDir();
const exePath = path.join(appDir, "CodexBridge.exe");
const appRoot = path.join(appDir, "resources", "app");
const smokeReportPath = process.env.CODEXBRIDGE_PACKAGED_SMOKE_REPORT ||
  path.join(repoRoot, "release", "packaged-smoke-report.json");
const smokeStartedAt = Date.now();

assert.ok(fs.existsSync(exePath), `missing packaged exe: ${exePath}`);
assert.ok(fs.existsSync(path.join(appRoot, "src", "server.js")), "missing packaged router script");

try {
  const packagePaths = listRegularFilePaths(appRoot);
  const packageContent = {
    ...assertWindowsPackageFilePaths(packagePaths),
    softwareManager: assertWindowsSoftwareManagerPackagePaths(packagePaths),
  };
  const embeddedBridgeSmoke = await smokeEmbeddedBridge(exePath, appRoot);
  const desktopSmoke = await smokeDesktop(exePath);
  const routerSmoke = await smokeRouter(exePath, appRoot);
  writeSmokeReport({
    ok: true,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - smokeStartedAt,
    appPath: appDir,
    exePath,
    packageContent,
    embeddedBridgeSmoke,
    desktopSmoke,
    routerSmoke,
  });
} catch (error) {
  writeSmokeReport({
    ok: false,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - smokeStartedAt,
    appPath: appDir,
    exePath,
    error: error?.message || String(error),
  });
  throw error;
}

async function smokeEmbeddedBridge(exePath, appRoot) {
  const startedAt = Date.now();
  const bridgeRoot = path.join(appRoot, "vendor", "chatgpt-codex-bridge");
  const embeddedManifestPath = path.join(bridgeRoot, "embedded-manifest.json");
  const extensionManifestPath = path.join(bridgeRoot, "chrome-extension", "manifest.json");
  const entryPath = path.join(bridgeRoot, "src", "index.js");
  const embedded = JSON.parse(fs.readFileSync(embeddedManifestPath, "utf8"));
  const extension = JSON.parse(fs.readFileSync(extensionManifestPath, "utf8"));
  assert.equal(embedded.version, "0.1.0");
  assert.equal(embedded.protocolVersion, 1);
  assert.equal(embedded.security?.apiTokenHeader, "X-Bridge-Token");
  assert.equal(extension.version, "0.1.57");
  assert.ok(fs.existsSync(path.join(bridgeRoot, "public", "bridge-api-client.js")));
  assert.ok(fs.existsSync(path.join(bridgeRoot, "public", "visible-branding.js")));
  assert.equal(fs.existsSync(path.join(bridgeRoot, "chrome-extension", "bridge-auth.js")), false);
  const dependencyVersions = {
    mcpSdk: packagedDependencyVersion(appRoot, "@modelcontextprotocol", "sdk"),
    honoNodeServer: packagedDependencyVersion(appRoot, "@hono", "node-server"),
    hono: packagedDependencyVersion(appRoot, "hono"),
    fastUri: packagedDependencyVersion(appRoot, "fast-uri"),
  };
  assertDependencyVersionAtLeast(dependencyVersions.mcpSdk, "1.30.0", "@modelcontextprotocol/sdk");
  assertDependencyVersionAtLeast(dependencyVersions.honoNodeServer, "2.0.5", "@hono/node-server");
  assertDependencyVersionAtLeast(dependencyVersions.hono, "4.12.27", "hono");
  assertDependencyVersionAtLeast(dependencyVersions.fastUri, "3.1.4", "fast-uri");

  const port = await findFreePort();
  const child = spawn(exePath, [entryPath], {
    cwd: bridgeRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_PORT: String(port),
      BRIDGE_API_TOKEN: "a".repeat(64),
      BRIDGE_DATA_DIR: path.join(os.tmpdir(), `codexbridge-embedded-smoke-${process.pid}-${Date.now()}`),
      BRIDGE_ROUTER_V2: "1",
      BRIDGE_GPT_TRANSPORT: "web-sync",
    },
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  try {
    const health = await waitForEmbeddedBridge(port, 15000);
    const version = await httpGetJson(`http://127.0.0.1:${port}/version`);
    assert.equal(version.service, "chatgpt-codex-bridge");
    assert.equal(version.version, "0.1.0");
    assert.equal(version.protocolVersion, 1);
    assert.equal(version.extensionProtocolVersion, "v20260801-adaptive-office-wait");
    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      health,
      version,
      dependencyVersions,
    };
  } catch (error) {
    throw new Error(
      `packaged Embedded Bridge smoke failed: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  } finally {
    child.kill("SIGTERM");
  }
}

function packagedDependencyVersion(appRoot, ...segments) {
  const packagePath = path.join(appRoot, "node_modules", ...segments, "package.json");
  return String(JSON.parse(fs.readFileSync(packagePath, "utf8")).version || "");
}

function assertDependencyVersionAtLeast(actual, minimum, name) {
  const actualParts = String(actual).split(".").map((value) => Number.parseInt(value, 10));
  const minimumParts = String(minimum).split(".").map((value) => Number.parseInt(value, 10));
  let comparison = 0;
  for (const index of [0, 1, 2]) {
    const left = actualParts[index] || 0;
    const right = minimumParts[index] || 0;
    if (left !== right) {
      comparison = left - right;
      break;
    }
  }
  assert.ok(comparison >= 0, `packaged ${name} ${actual} is below required ${minimum}`);
}

console.log(`Packaged smoke passed: ${exePath}`);

function listRegularFilePaths(rootDir) {
  const pending = [rootDir];
  const files = [];
  while (pending.length) {
    const currentDir = pending.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        files.push(path.relative(rootDir, fullPath).split(path.sep).join("/"));
      }
    }
  }
  files.sort();
  return files;
}

function newestPackagedAppDir() {
  const explicitAppDir = String(process.env.CODEXBRIDGE_PACKAGED_APP_DIR || "").trim();
  if (explicitAppDir) {
    return path.resolve(explicitAppDir);
  }
  const releaseDir = path.join(repoRoot, "release");
  const entries = fs.existsSync(releaseDir)
    ? fs.readdirSync(releaseDir, { withFileTypes: true })
    : [];
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const parent = path.join(releaseDir, entry.name);
    for (const child of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!child.isDirectory() || child.name !== "CodexBridge-win32-x64") {
        continue;
      }
      const fullPath = path.join(parent, child.name);
      if (
        !fs.existsSync(path.join(fullPath, "CodexBridge.exe")) ||
        !fs.existsSync(path.join(fullPath, "resources", "app", "src", "server.js"))
      ) {
        continue;
      }
      candidates.push({
        path: fullPath,
        mtimeMs: fs.statSync(fullPath).mtimeMs,
      });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  assert.ok(candidates.length, "no packaged CodexBridge-win32-x64 directory found");
  return candidates[0].path;
}

async function smokeDesktop(exePath) {
  const startedAt = Date.now();
  const localAppData = String(process.env.LOCALAPPDATA || "").trim();
  const dataRoot = process.platform === "win32" && path.win32.isAbsolute(localAppData)
    ? localAppData
    : os.tmpdir();
  const dataDir = fs.mkdtempSync(path.join(dataRoot, "codexbridge-desktop-data-"));
  const smokeHomeDir = path.join(dataDir, "home");
  const configDir = path.join(dataDir, "config");
  fs.mkdirSync(path.join(smokeHomeDir, ".codex"), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  createHistoryRecoveryE2EFixture(smokeHomeDir);
  const resourceFixture = createResourceE2EFixture(smokeHomeDir, dataDir);
  const recoveryScreenshotPath = path.join(repoRoot, "release", "history-recovery-packaged-e2e.png");
  const resourceScreenshotPath = path.join(repoRoot, "release", "resources-packaged-e2e.png");
  const routerPort = await findFreePort();
  fs.writeFileSync(
    path.join(configDir, "desktop-options.json"),
    `${JSON.stringify({
      routerPort,
      duplicateRequestProtection: true,
    }, null, 2)}\n`,
    "utf8",
  );
  const originalCodexConfig = [
    'sandbox_mode = "workspace-write"',
    'model = "gpt-5.5"',
    'model_reasoning_effort = "high"',
    'approval_policy = "on-request"',
    '',
    '[plugins."smoke@openai-curated"]',
    'enabled = true',
    '',
  ].join("\r\n");
  fs.writeFileSync(
    path.join(smokeHomeDir, ".codex", "config.toml"),
    originalCodexConfig,
    "utf8",
  );
  const result = await runProcess(exePath, [], {
    CODEXBRIDGE_DESKTOP_SMOKE: "1",
    CODEXBRIDGE_DESKTOP_SMOKE_START_ROUTER: "1",
    CODEXBRIDGE_DESKTOP_SMOKE_HOME: smokeHomeDir,
    CODEXBRIDGE_DESKTOP_SMOKE_HISTORY_RECOVERY: "1",
    CODEXBRIDGE_DESKTOP_SMOKE_SCREENSHOT: recoveryScreenshotPath,
    CODEXBRIDGE_DESKTOP_SMOKE_RESOURCE_SCREENSHOT: resourceScreenshotPath,
    CODEXBRIDGE_DESKTOP_SMOKE_RESOURCE_SNAPSHOT: resourceFixture.snapshotPath,
    CODEXBRIDGE_DATA_DIR: dataDir,
  }, 120000);
  assert.equal(
    result.code,
    0,
    `desktop smoke failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout + result.stderr, /CodexBridge desktop smoke loaded/);
  assert.match(result.stdout + result.stderr, /Router lifecycle smoke passed/);
  assert.match(result.stdout + result.stderr, /History recovery smoke passed:/);
  const resourceMatch = (result.stdout + result.stderr).match(/Packaged resource smoke passed: (\{.+\})/);
  assert.ok(resourceMatch, "missing packaged resource merge report");
  const resourceMerge = JSON.parse(resourceMatch[1]);
  assert.deepEqual(resourceMerge.pluginIds.slice().sort(), resourceFixture.expectedPluginIds.slice().sort());
  assert.deepEqual(resourceMerge.resourceSummary, {
    plugins: "11",
    apps: "1",
    mcpServers: "1",
    skills: "19",
    marketplaces: "0",
  });
  assert.equal(resourceMerge.bundledPlugins, 5);
  assert.equal(
    resourceMerge.pluginIds.filter((id) => String(id).endsWith("@openai-curated-remote")).length,
    6,
  );
  assert.ok(fs.existsSync(resourceScreenshotPath));
  const historyRecoveryMatch = (result.stdout + result.stderr).match(/History recovery smoke passed: (\{.+\})/);
  assert.ok(historyRecoveryMatch, "missing packaged history recovery IPC report");
  const historyRecovery = JSON.parse(historyRecoveryMatch[1]);
  assert.equal(historyRecovery.blocked?.phase, "awaiting_manual_exit");
  assert.equal(historyRecovery.completed?.phase, "restarted");
  assert.equal(historyRecovery.completed?.plannedInserts, 128);
  assert.equal(historyRecovery.completed?.actualInserted, 128);
  assert.equal(historyRecovery.completed?.rereadCatalogThreads, 129);
  assert.equal(historyRecovery.completed?.rereadSidebarThreads, 129);
  assert.equal(historyRecovery.completed?.commitStatus, "verified");
  assert.ok(historyRecovery.completed?.backupDir);
  assert.ok(fs.existsSync(historyRecovery.completed.backupDir));
  assert.ok(fs.existsSync(recoveryScreenshotPath));
  const recoveryCounts = historyRecoveryFixtureCounts(smokeHomeDir);
  assert.deepEqual(recoveryCounts, { catalogThreads: 129, sidebarThreads: 129 });
  assert.equal(
    fs.readFileSync(path.join(smokeHomeDir, ".codex", "config.toml"), "utf8"),
    originalCodexConfig,
  );
  return {
    ok: true,
    durationMs: Date.now() - startedAt,
    routerLifecycleOk: true,
    historyRecovery: {
      ...historyRecovery,
      reread: recoveryCounts,
      screenshotPath: recoveryScreenshotPath,
    },
    resourceMerge: { ...resourceMerge, screenshotPath: resourceScreenshotPath },
  };
}

function createResourceE2EFixture(homeDir, dataDir) {
  const codexDir = path.join(homeDir, ".codex");
  const bundled = ["sites", "browser", "chrome", "computer-use", "visualize"];
  const remote = ["github", "hyperframes", "openai-templates", "remotion", "supabase", "superpowers"];
  const pluginItems = [];
  for (const name of bundled) {
    const pluginPath = path.join(dataDir, "bundled-plugins", name);
    fs.mkdirSync(path.join(pluginPath, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginPath, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        ...(name === "sites" ? { mcpServers: { sites: { command: "node" } } } : {}),
      }),
      "utf8",
    );
    pluginItems.push({
      id: `${name}@openai-bundled`,
      name,
      path: pluginPath,
      installed: true,
      enabled: true,
    });
  }
  for (const name of remote) {
    const version = name === "github" ? "0.2.0" : "1.0.0";
    const pluginPath = path.join(codexDir, "plugins", "cache", "openai-curated-remote", name, version);
    fs.mkdirSync(path.join(pluginPath, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginPath, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name, version }),
      "utf8",
    );
    const skillPath = path.join(pluginPath, "skills", `${name}-skill`, "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, `# ${name}\n`, "utf8");
    pluginItems.push({
      id: `${name}@openai-curated-remote`,
      name,
      path: pluginPath,
      installed: true,
      enabled: true,
    });
  }
  const userSkillIds = [
    "agent-reach",
    "brainstorming",
    "executing-plans",
    "finishing-a-development-branch",
    "frontend-design",
    "hyperframes",
    "pdf",
    "playwright",
    "playwright-interactive",
    "ppt-master",
    "receiving-code-review",
    "remotion-best-practices",
    "requesting-code-review",
    "systematic-debugging",
    "test-driven-development",
    "using-git-worktrees",
    "using-superpowers",
    "verification-before-completion",
    "writing-plans",
  ];
  const userSkills = userSkillIds.map((name) => {
    const skillPath = path.join(codexDir, "skills", name, "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, `# ${name}\n`, "utf8");
    return { name, displayName: name, path: skillPath, scope: "user", enabled: true };
  });
  const recommendedDir = path.join(codexDir, "vendor_imports");
  fs.mkdirSync(recommendedDir, { recursive: true });
  fs.writeFileSync(
    path.join(recommendedDir, "skills-curated-cache.json"),
    JSON.stringify({
      skills: ["pdf", "playwright", "playwright-interactive"].map((id) => ({ id, name: id })),
    }),
    "utf8",
  );
  const desktopVisiblePlugins = pluginItems.filter((plugin) => plugin.name !== "browser");
  const snapshot = {
    codexCliSnapshot: {
      plugins: {
        ok: true,
        code: "ok",
        items: pluginItems,
      },
      mcpServers: { ok: true, code: "ok", items: [] },
    },
    codexPromptInputSnapshot: { ok: true, code: "ok", items: [] },
    codexAppServerSnapshot: {
      ok: true,
      refreshedAt: "2026-07-12T00:00:00.000Z",
      snapshotSource: "codex-app-server",
      plugins: { ok: true, items: desktopVisiblePlugins },
      apps: {
        ok: true,
        items: [{
          id: "connector_20205bf7d4e99a89d7154bb849718324",
          name: "Sites",
          pluginDisplayNames: ["Sites"],
          isAccessible: true,
          isEnabled: true,
        }],
      },
      skills: { ok: true, items: userSkills },
    },
  };
  const snapshotPath = path.join(dataDir, "resource-e2e-snapshot.json");
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
  return {
    snapshotPath,
    expectedPluginIds: [
      ...bundled.map((name) => `${name}@openai-bundled`),
      ...remote.map((name) => `${name}@openai-curated-remote`),
    ],
  };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function smokeRouter(exePath, appRoot) {
  const startedAt = Date.now();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-packaged-"));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const configPath = path.join(tempDir, "router.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      host: "127.0.0.1",
      port,
      authToken: "sk-local-codex-router",
      defaultModel: "gpt-5.5",
      models: [
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          api: "responses",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "gpt-5.5",
          authMode: "codex_openai",
        },
      ],
    }, null, 2),
    "utf8",
  );

  const child = spawn(exePath, [path.join(appRoot, "src", "server.js")], {
    cwd: appRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ROUTER_CONFIG: configPath,
    },
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    const health = await waitForHealth(port, 15000);
    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      models: Array.isArray(health?.models) ? health.models : [],
    };
  } catch (error) {
    throw new Error(
      `packaged router smoke failed: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  } finally {
    child.kill();
  }
}

function writeSmokeReport(report) {
  fs.mkdirSync(path.dirname(smokeReportPath), { recursive: true });
  fs.writeFileSync(smokeReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function runProcess(command, args, extraEnv, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`process timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const body = await httpGetJson(`http://127.0.0.1:${port}/health`);
      assert.equal(body.ok, true);
      assert.deepEqual(body.models, ["gpt-5.5"]);
      return body;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError || new Error("health check timed out");
}

async function waitForEmbeddedBridge(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const body = await httpGetJson(`http://127.0.0.1:${port}/health`);
      assert.equal(body.ok, true);
      assert.equal(body.service, "chatgpt-codex-bridge");
      assert.equal(body.status, "ready");
      assert.equal(body.version, "0.1.0");
      assert.equal(body.protocolVersion, 1);
      return body;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError || new Error("Embedded Bridge health check timed out");
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(1000, () => {
      req.destroy(new Error("request timed out"));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
