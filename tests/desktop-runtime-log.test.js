import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { appendBoundedLog } = require("../desktop/runtime-log.cjs");

test("desktop runtime log keeps the active file and one backup within the configured bound", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-runtime-log-"));
  const logPath = path.join(root, "desktop-runtime.log");
  fs.writeFileSync(logPath, "old\n".repeat(80), "utf8");

  appendBoundedLog(logPath, "first new line", { maxBytes: 128 });
  appendBoundedLog(logPath, "second new line", { maxBytes: 128 });

  const backupPath = `${logPath}.1`;
  assert.ok(fs.existsSync(backupPath));
  assert.ok(fs.statSync(logPath).size <= 128);
  assert.ok(fs.statSync(backupPath).size <= 128);
  assert.match(fs.readFileSync(logPath, "utf8"), /first new line/);
  assert.match(fs.readFileSync(logPath, "utf8"), /second new line/);
});

test("desktop runtime log bounds a single oversized entry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexbridge-runtime-log-entry-"));
  const logPath = path.join(root, "desktop-runtime.log");

  appendBoundedLog(logPath, "x".repeat(300), { maxBytes: 96 });

  assert.ok(fs.statSync(logPath).size <= 96);
  assert.match(fs.readFileSync(logPath, "utf8"), /x+/);
});
