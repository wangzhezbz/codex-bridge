import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeOwnedTemporaryDirectory } from "./smoke-temp-cleanup.mjs";
import {
  DESKTOP_RELEASE_BUILD_METADATA_FILE,
  packagedSmokeSourceEvidence,
} from "./release-source-fingerprint.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetArch = process.env.CODEXBRIDGE_MAC_ARCH || process.arch;
const appDir = newestPackagedAppDir(targetArch);
const appPath = path.join(appDir, "CodexBridge.app");
const executablePath = path.join(appPath, "Contents", "MacOS", "CodexBridge");
const electronFrameworkPath = path.join(
  appPath,
  "Contents",
  "Frameworks",
  "Electron Framework.framework",
  "Electron Framework",
);
const electronFrameworkTargetPath = path.join(
  appPath,
  "Contents",
  "Frameworks",
  "Electron Framework.framework",
  "Versions",
  "A",
  "Electron Framework",
);
const appRoot = path.join(appPath, "Contents", "Resources", "app");

assert.ok(fs.existsSync(appPath), `missing packaged app: ${appPath}`);
assert.ok(fs.existsSync(executablePath), `missing packaged executable: ${executablePath}`);
assert.ok(
  fs.existsSync(electronFrameworkPath),
  `missing packaged Electron Framework: ${electronFrameworkPath}`,
);
assert.ok(
  fs.existsSync(electronFrameworkTargetPath),
  `missing packaged Electron Framework target: ${electronFrameworkTargetPath}`,
);
assert.ok(fs.existsSync(path.join(appRoot, "src", "server.js")), "missing packaged router script");
const buildMetadata = readPackagedBuildMetadata(appRoot);
const sourceEvidence = packagedSmokeSourceEvidence({ buildMetadata }, repoRoot);
assert.equal(
  sourceEvidence.ok,
  true,
  "packaged macOS app was built from older source; run package:mac again before smoke testing",
);

if (process.platform === "darwin") {
  await smokeRouter(executablePath, appRoot);
} else {
  console.log(
    `Skipping macOS runtime smoke on ${process.platform}; structural package checks passed.`,
  );
}

console.log(`Packaged macOS smoke passed: ${appPath}`);

function readPackagedBuildMetadata(appRoot) {
  const metadataPath = path.join(appRoot, DESKTOP_RELEASE_BUILD_METADATA_FILE);
  assert.ok(fs.existsSync(metadataPath), `missing packaged build metadata: ${metadataPath}`);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.schemaVersion, 1, "unsupported packaged build metadata schema");
  assert.equal(metadata.algorithm, "sha256", "unsupported packaged source fingerprint algorithm");
  assert.match(String(metadata.sourceFingerprint || ""), /^[a-f0-9]{64}$/u);
  const packagedApp = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  assert.equal(metadata.appVersion, packagedApp.version, "packaged build metadata version mismatch");
  return metadata;
}

function newestPackagedAppDir(arch) {
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
      if (!child.isDirectory() || child.name !== `CodexBridge-darwin-${arch}`) {
        continue;
      }
      const fullPath = path.join(parent, child.name);
      if (
        !fs.existsSync(path.join(fullPath, "CodexBridge.app")) ||
        !fs.existsSync(path.join(fullPath, "CodexBridge.app", "Contents", "Resources", "app", "src", "server.js"))
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
  assert.ok(candidates.length, `no packaged CodexBridge-darwin-${arch} directory found`);
  return candidates[0].path;
}

async function smokeRouter(executablePath, appRoot) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-packaged-macos-"));
  const port = 19000 + Math.floor(Math.random() * 1000);
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

  const child = spawn(executablePath, [path.join(appRoot, "src", "server.js")], {
    cwd: appRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ROUTER_CONFIG: configPath,
    },
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
    await waitForHealth(port, 15000);
  } catch (error) {
    throw new Error(
      `packaged macOS router smoke failed: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  } finally {
    await terminateChild(child);
    removeOwnedTemporaryDirectory(tempDir, {
      parentDirectory: os.tmpdir(),
      requiredPrefix: "codexbridge-packaged-macos-",
    });
  }
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) {
    return;
  }
  child.kill("SIGTERM");
  await waitForChildExit(child, 5000);
  if (child.exitCode === null && !child.signalCode) {
    child.kill("SIGKILL");
    await waitForChildExit(child, 2000);
  }
  if (child.exitCode === null && !child.signalCode) {
    throw new Error(`packaged macOS smoke child process did not exit: ${child.pid || "unknown"}`);
  }
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.removeListener("exit", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
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
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError || new Error("health check timed out");
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
