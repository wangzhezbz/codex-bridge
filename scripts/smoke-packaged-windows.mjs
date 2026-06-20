import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = newestPackagedAppDir();
const exePath = path.join(appDir, "CodexBridge.exe");
const appRoot = path.join(appDir, "resources", "app");

assert.ok(fs.existsSync(exePath), `missing packaged exe: ${exePath}`);
assert.ok(fs.existsSync(path.join(appRoot, "src", "server.js")), "missing packaged router script");

await smokeDesktop(exePath);
await smokeRouter(exePath, appRoot);

console.log(`Packaged smoke passed: ${exePath}`);

function newestPackagedAppDir() {
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
  const result = await runProcess(exePath, [], {
    CODEXBRIDGE_DESKTOP_SMOKE: "1",
  }, 30000);
  assert.equal(
    result.code,
    0,
    `desktop smoke failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout + result.stderr, /CodexBridge desktop smoke loaded/);
}

async function smokeRouter(exePath, appRoot) {
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
    await waitForHealth(port, 15000);
  } catch (error) {
    throw new Error(
      `packaged router smoke failed: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  } finally {
    child.kill();
  }
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
