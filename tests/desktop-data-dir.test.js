import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

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
      "C:\\Users\\Alice\\Desktop\\CodexBridge-v0.1.8\\CodexBridge-win32-x64\\CodexBridge.exe",
    isPackaged: true,
    platform: "win32",
  });

  assert.equal(rootDir, "C:\\Users\\Alice\\AppData\\Roaming\\CodexBridge");
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
    path.resolve("D:\\CodexBridgeData"),
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
    "codexbridge-0.1.8",
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
