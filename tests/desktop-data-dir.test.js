import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

const require = createRequire(import.meta.url);
const {
  legacyPortableDataCandidates,
  migrateLegacyPortableData,
  resolveDataRootDir,
} = require("../desktop/data-dir.cjs");

test("packaged desktop data defaults to stable user appdata directory", () => {
  const rootDir = resolveDataRootDir({
    appRootDir: "F:\\game_code\\router",
    env: {
      APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
    },
    execPath:
      "C:\\Users\\Alice\\Desktop\\CodexBridge-v0.1.10\\CodexBridge-win32-x64\\CodexBridge.exe",
    isPackaged: true,
    platform: "win32",
  });

  assert.equal(rootDir, "C:\\Users\\Alice\\AppData\\Roaming\\CodexBridge");
});

test("packaged macOS desktop data defaults to Application Support", () => {
  const rootDir = resolveDataRootDir({
    appRootDir: "/Users/alice/dev/codex-bridge",
    env: {
      HOME: "/Users/alice",
    },
    execPath: "/Applications/CodexBridge.app/Contents/MacOS/CodexBridge",
    isPackaged: true,
    platform: "darwin",
  });

  assert.equal(rootDir, "/Users/alice/Library/Application Support/CodexBridge");
});

test("developer and explicit data directories still keep their current behavior", () => {
  assert.equal(
    resolveDataRootDir({
      appRootDir: "F:\\game_code\\router",
      env: {},
      execPath: "F:\\game_code\\router\\node_modules\\electron\\dist\\electron.exe",
      isPackaged: false,
      platform: "win32",
    }),
    "F:\\game_code\\router",
  );

  assert.equal(
    resolveDataRootDir({
      appRootDir: "F:\\game_code\\router",
      env: { CODEXBRIDGE_DATA_DIR: "D:\\CodexBridgeData" },
      execPath: "C:\\App\\CodexBridge.exe",
      isPackaged: true,
      platform: "win32",
    }),
    path.win32.resolve("D:\\CodexBridgeData"),
  );
});

test("legacy portable data migration copies old settings without overwriting new ones", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-parent-"));
  const oldPackage = path.join(parent, "codexbridge-0.1.3", "CodexBridge-win32-x64");
  const legacyDir = path.join(oldPackage, "CodexBridgeData");
  const newDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-appdata-"));

  fs.mkdirSync(path.join(legacyDir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, "config", "secrets.local.json"),
    '{"DEEPSEEK_API_KEY":"old-key"}\n',
    "utf8",
  );
  fs.writeFileSync(
    path.join(legacyDir, "config", "model-selection.json"),
    '{"selectedModelIds":["kimi-k2-7-code"]}\n',
    "utf8",
  );
  fs.writeFileSync(path.join(legacyDir, "model-catalog.json"), '{"models":[]}\n', "utf8");

  fs.mkdirSync(path.join(newDir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(newDir, "config", "secrets.local.json"),
    '{"DEEPSEEK_API_KEY":"new-key"}\n',
    "utf8",
  );

  const result = migrateLegacyPortableData({
    targetDir: newDir,
    legacyDirs: [legacyDir],
  });

  assert.equal(result.copiedFiles, 2);
  assert.match(result.messages.join("\n"), /已从旧版免安装数据迁移 2 个文件/);
  assert.doesNotMatch(result.messages.join("\n"), /Migrated .* legacy portable data/i);
  assert.equal(
    fs.readFileSync(path.join(newDir, "config", "secrets.local.json"), "utf8"),
    '{"DEEPSEEK_API_KEY":"new-key"}\n',
  );
  assert.equal(
    fs.readFileSync(path.join(newDir, "config", "model-selection.json"), "utf8"),
    '{"selectedModelIds":["kimi-k2-7-code"]}\n',
  );
  assert.equal(
    fs.readFileSync(path.join(newDir, "model-catalog.json"), "utf8"),
    '{"models":[]}\n',
  );
});

test("legacy portable candidate search finds older extracted packages nearby", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-packages-"));
  const currentExe = path.join(
    parent,
    "codexbridge-0.1.10",
    "CodexBridge-win32-x64",
    "CodexBridge.exe",
  );
  const oldDataDir = path.join(
    parent,
    "codexbridge-0.1.3",
    "CodexBridge-win32-x64",
    "CodexBridgeData",
  );
  fs.mkdirSync(path.join(oldDataDir, "config"), { recursive: true });
  fs.writeFileSync(path.join(oldDataDir, "config", "custom-models.json"), "[]\n", "utf8");

  const candidates = legacyPortableDataCandidates({
    execPath: currentExe,
    targetDir: path.join(os.tmpdir(), "codexbridge-target"),
  });

  assert.ok(candidates.includes(oldDataDir));
});

test("legacy portable migration can run in a worker without blocking the desktop thread", async () => {
  // Keep the fixture more than four ancestors below the shared runner temp.
  // The production discovery intentionally inspects nearby package siblings;
  // without this isolation, fixtures from earlier tests in RUNNER_TEMP are
  // also valid migration candidates on GitHub's Windows runner.
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-worker-scope-"));
  const parent = path.join(fixtureRoot, "level-1", "level-2", "level-3", "packages");
  const currentExe = path.join(
    parent,
    "codexbridge-current",
    "CodexBridge-win32-x64",
    "CodexBridge.exe",
  );
  const oldDataDir = path.join(
    parent,
    "codexbridge-old",
    "CodexBridge-win32-x64",
    "CodexBridgeData",
  );
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-worker-target-"));
  fs.mkdirSync(path.dirname(currentExe), { recursive: true });
  fs.writeFileSync(currentExe, "fixture\n", "utf8");
  fs.mkdirSync(path.join(oldDataDir, "config"), { recursive: true });
  fs.writeFileSync(path.join(oldDataDir, "config", "custom-models.json"), "[]\n", "utf8");

  const workerPath = path.resolve("desktop/legacy-migration-worker.cjs");
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: { execPath: currentExe, targetDir },
    });
    worker.once("message", (message) => {
      if (message?.ok) {
        resolve(message.result);
      } else {
        reject(new Error(message?.error || "Legacy migration worker failed"));
      }
    });
    worker.once("error", reject);
  });

  assert.equal(result.copiedFiles, 1);
  assert.equal(fs.readFileSync(path.join(targetDir, "config", "custom-models.json"), "utf8"), "[]\n");
});

test("legacy portable data migration reports failures in Chinese", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-parent-"));
  const legacyDir = path.join(parent, "codexbridge-0.1.3", "CodexBridge-win32-x64", "CodexBridgeData");
  const targetFile = path.join(parent, "not-a-directory");
  fs.mkdirSync(path.join(legacyDir, "config"), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "config", "model-selection.json"), "{}\n", "utf8");
  fs.writeFileSync(targetFile, "blocks directory creation\n", "utf8");

  const result = migrateLegacyPortableData({
    targetDir: targetFile,
    legacyDirs: [legacyDir],
  });

  const message = result.messages.join("\n");
  assert.match(message, /旧版免安装数据迁移失败/);
  assert.doesNotMatch(message, /Could not migrate legacy portable data/i);
});
