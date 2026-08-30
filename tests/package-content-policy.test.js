import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeOwnedTemporaryDirectory } from "../scripts/smoke-temp-cleanup.mjs";

let packagePolicy = {};
try {
  packagePolicy = await import("../scripts/package-content-policy.mjs");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") {
    throw error;
  }
}

test("Windows package policy excludes development residue and local secret material", () => {
  assert.equal(
    typeof packagePolicy.shouldIgnoreWindowsPackagePath,
    "function",
    "Windows packaging needs an executable content policy",
  );

  for (const candidate of [
    "/deploy/codexbridge-installer/install-test.sh",
    "/state/response-history.sqlite3",
    "/state/response-history.sqlite3-shm",
    "/state/response-history.sqlite3-wal",
    "/docs/release-checklist.md",
    "/.worktrees/software-manager/desktop/renderer/app.js",
    "/docs/router-remediation-record-120.md",
    "/node_modules/example/dist/index.js.map",
    "/node_modules/example/test/fixture.json",
    "/node_modules/example/__tests__/fixture.js",
    "/.env",
    "/.env.production",
    "/certificates/release-signing.pem",
    "/certificates/release-signing.key",
    "/config/router.config.json",
    "/config/secrets.local.json",
    "/state_5.sqlite.bak",
  ]) {
    assert.equal(
      packagePolicy.shouldIgnoreWindowsPackagePath(candidate),
      true,
      candidate,
    );
  }
});

test("Windows package policy preserves runtime code dependencies and public examples", () => {
  assert.equal(typeof packagePolicy.shouldIgnoreWindowsPackagePath, "function");

  for (const candidate of [
    "/src/server.js",
    "/desktop/main.cjs",
    "/node_modules/@modelcontextprotocol/sdk/dist/cjs/index.js",
    "/config/router.config.example.json",
    "/README.md",
  ]) {
    assert.equal(
      packagePolicy.shouldIgnoreWindowsPackagePath(candidate),
      false,
      candidate,
    );
  }
});

test("Windows package audit reports every forbidden packaged path with its rule", () => {
  assert.equal(typeof packagePolicy.auditWindowsPackageFilePaths, "function");

  assert.deepEqual(
    packagePolicy.auditWindowsPackageFilePaths([
      "src/server.js",
      "deploy/codexbridge-installer/dogecloud_uploader.py",
      "state/response-history.sqlite3",
      ".worktrees/software-manager/desktop/settings.mjs",
      "docs/router-remediation-record-121.md",
      "node_modules/example/dist/index.js.map",
      "config/secrets.local.json",
    ]),
    [
      { path: "deploy/codexbridge-installer/dogecloud_uploader.py", rule: "deployment_infrastructure" },
      { path: "state/response-history.sqlite3", rule: "runtime_state_tree" },
      { path: ".worktrees/software-manager/desktop/settings.mjs", rule: "development_worktree" },
      { path: "docs/router-remediation-record-121.md", rule: "internal_documentation" },
      { path: "node_modules/example/dist/index.js.map", rule: "source_map" },
      { path: "config/secrets.local.json", rule: "runtime_secret_config" },
    ],
  );
});

test("Windows package audit gate returns a clean summary and blocks forbidden files", () => {
  assert.equal(typeof packagePolicy.assertWindowsPackageFilePaths, "function");

  assert.deepEqual(
    packagePolicy.assertWindowsPackageFilePaths([
      "src/server.js",
      "desktop/main.cjs",
      "config/router.config.example.json",
    ]),
    { checkedFiles: 3, forbiddenFiles: 0, forbiddenByRule: {} },
  );
  assert.throws(
    () => packagePolicy.assertWindowsPackageFilePaths([
      "src/server.js",
      "node_modules/example/dist/index.js.map",
      "certificates/release-signing.pem",
    ]),
    (error) => {
      assert.equal(error.code, "forbidden_package_content");
      assert.deepEqual(error.violations, [
        { path: "node_modules/example/dist/index.js.map", rule: "source_map" },
        { path: "certificates/release-signing.pem", rule: "private_key_material" },
      ]);
      assert.match(error.message, /source_map/);
      assert.match(error.message, /index\.js\.map/);
      return true;
    },
  );
});

test("Windows package tree audit rejects hardlinks before release artifacts are created", (t) => {
  assert.equal(typeof packagePolicy.assertWindowsPackageTree, "function");
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-package-tree-test-"));
  t.after(() => removeOwnedTemporaryDirectory(rootDir, {
    parentDirectory: os.tmpdir(),
    requiredPrefix: "codexbridge-package-tree-test-",
  }));
  fs.mkdirSync(path.join(rootDir, "src"));
  const primaryPath = path.join(rootDir, "src", "server.js");
  fs.writeFileSync(primaryPath, "export {};\n", "utf8");

  const clean = packagePolicy.assertWindowsPackageTree(rootDir);
  assert.equal(clean.checkedFiles, 1);
  assert.equal(clean.links, 0);
  assert.equal(clean.hardlinks, 0);

  const hardlinkPath = path.join(rootDir, "src", "server-copy.js");
  fs.linkSync(primaryPath, hardlinkPath);
  assert.throws(
    () => packagePolicy.assertWindowsPackageTree(rootDir),
    (error) => error?.code === "forbidden_package_tree_entry"
      && error.violations.some((violation) => violation.rule === "package_tree_hardlink"),
  );
});

test("Windows package content policy runs in the fixed project gates", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  );

  assert.match(
    packageJson.scripts["check:syntax"],
    /scripts\/package-content-policy\.mjs/,
  );
  assert.match(
    packageJson.scripts["check:syntax"],
    /tests\/package-content-policy\.test\.js/,
  );
  assert.match(
    packageJson.scripts["test:desktop"],
    /tests\/package-content-policy\.test\.js/,
  );
});
