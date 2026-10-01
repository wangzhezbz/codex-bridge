import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { smokeGreenCodex } from "../scripts/software-manager/smoke-chatgpt-green.mjs";

function smokeFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-green-smoke-${name}-`));
  fs.mkdirSync(path.join(root, "resources"));
  fs.writeFileSync(path.join(root, "ChatGPT.exe"), "shell");
  fs.writeFileSync(path.join(root, "resources", "codex.exe"), "core");
  const verified = Object.freeze({
    outputPath: root,
    officialVersion: "26.917.9434.0",
    contentTreeSha256: "a".repeat(64),
    owlTemplateSha256: "b".repeat(64),
  });
  return {
    inputPath: root,
    reportPath: `${root}-report.json`,
    verifyDirectory: async () => verified,
    getFreePort: async () => 47821,
    sleep: async () => {},
    timeoutMs: 2,
    pollIntervalMs: 0,
    now: () => "2026-09-25T01:02:03.000Z",
  };
}

function processSet(root, pid = 4100) {
  return [
    { pid, parentPid: 1, name: "ChatGPT.exe", executablePath: path.join(root, "ChatGPT.exe"), commandLine: `"${path.join(root, "ChatGPT.exe")}"` },
    { pid: pid + 1, parentPid: pid, name: "ChatGPT.exe", executablePath: path.join(root, "ChatGPT.exe"), commandLine: `"${path.join(root, "ChatGPT.exe")}" --type=renderer` },
    { pid: pid + 2, parentPid: pid, name: "codex.exe", executablePath: path.join(root, "resources", "codex.exe"), commandLine: `"${path.join(root, "resources", "codex.exe")}" app-server` },
  ];
}

test("smoke refuses an existing Codex without killing or launching it", async () => {
  const value = smokeFixture("existing");
  const killed = [];
  let launched = false;
  await assert.rejects(smokeGreenCodex({
    ...value,
    processInspector: async () => [{ pid: 99, name: "ChatGPT.exe", executablePath: "C:\\other\\ChatGPT.exe", commandLine: "ChatGPT.exe" }],
    launcher: async () => { launched = true; return { pid: 4100 }; },
    terminateProcessTree: async (pid) => killed.push(pid),
    pageInspector: async () => [],
  }), /green_smoke_existing_instance/u);
  assert.equal(launched, false);
  assert.deepEqual(killed, []);
});

test("smoke requires renderer and app-server then cleans up only its launched tree", async () => {
  const value = smokeFixture("process-incomplete");
  const killed = [];
  let calls = 0;
  await assert.rejects(smokeGreenCodex({
    ...value,
    processInspector: async () => (++calls === 1 ? [] : [processSet(value.inputPath)[0]]),
    launcher: async () => ({ pid: 4100 }),
    terminateProcessTree: async (pid) => killed.push(pid),
    waitForExit: async () => true,
    pageInspector: async () => [{ type: "page", url: "file:///index.html", title: "Codex" }],
  }), /green_smoke_process_incomplete/u);
  assert.deepEqual(killed, [4100]);
});

test("smoke rejects an empty page even when all required processes exist", async () => {
  const value = smokeFixture("page-missing");
  let calls = 0;
  await assert.rejects(smokeGreenCodex({
    ...value,
    processInspector: async () => (++calls === 1 ? [] : processSet(value.inputPath)),
    launcher: async () => ({ pid: 4100 }),
    terminateProcessTree: async () => {},
    waitForExit: async () => true,
    pageInspector: async () => [],
  }), /green_smoke_page_missing/u);
});

test("successful smoke writes exact hash-bound evidence after proving cleanup", async () => {
  const value = smokeFixture("success");
  let processCalls = 0;
  let verifyCalls = 0;
  const report = await smokeGreenCodex({
    ...value,
    verifyDirectory: async () => { verifyCalls += 1; return value.verifyDirectory(); },
    processInspector: async () => (++processCalls === 1 ? [] : processSet(value.inputPath)),
    launcher: async ({ executablePath, env, args }) => {
      assert.equal(executablePath, path.join(value.inputPath, "ChatGPT.exe"));
      assert.match(env.CODEX_ELECTRON_USER_DATA_PATH, /codex-green-smoke-/u);
      assert.ok(args.includes("--remote-debugging-port=47821"));
      return { pid: 4100 };
    },
    terminateProcessTree: async () => {},
    waitForExit: async () => true,
    pageInspector: async () => [{ id: "page-1", type: "page", url: "file:///index.html", title: "Codex" }],
  });
  assert.equal(verifyCalls, 2);
  assert.deepEqual(Object.keys(report), [
    "schemaVersion", "ok", "checkedAt", "officialVersion", "contentTreeSha256",
    "shellTemplateSha256", "processEvidence", "pageEvidence", "cleanupEvidence",
  ]);
  assert.equal(report.ok, true);
  assert.equal(report.processEvidence.main.executablePath, path.join(value.inputPath, "ChatGPT.exe"));
  assert.equal(report.processEvidence.renderer.parentPid, 4100);
  assert.equal(report.processEvidence.appServer.executablePath, path.join(value.inputPath, "resources", "codex.exe"));
  assert.equal(Object.hasOwn(report.processEvidence.main, "commandLine"), false);
  assert.equal(Object.hasOwn(report.processEvidence.renderer, "commandLine"), false);
  assert.equal(Object.hasOwn(report.processEvidence.appServer, "commandLine"), false);
  assert.equal(report.cleanupEvidence.processTreeExited, true);
  assert.equal(report.cleanupEvidence.userDataRemoved, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(value.reportPath, "utf8")), report);
});

test("smoke rejects package drift between launch and cleanup", async () => {
  const value = smokeFixture("drift");
  let processCalls = 0;
  let verifyCalls = 0;
  await assert.rejects(smokeGreenCodex({
    ...value,
    verifyDirectory: async () => ({
      ...await value.verifyDirectory(),
      contentTreeSha256: (++verifyCalls === 1 ? "a" : "c").repeat(64),
    }),
    processInspector: async () => (++processCalls === 1 ? [] : processSet(value.inputPath)),
    launcher: async () => ({ pid: 4100 }),
    terminateProcessTree: async () => {},
    waitForExit: async () => true,
    pageInspector: async () => [{ id: "page-1", type: "page", url: "file:///index.html", title: "Codex" }],
  }), /green_smoke_source_changed/u);
  assert.equal(fs.existsSync(value.reportPath), false);
});

test("process termination failure still removes the owned smoke user-data directory", async () => {
  const value = smokeFixture("cleanup-failure");
  let processCalls = 0;
  let userDataPath = "";
  await assert.rejects(smokeGreenCodex({
    ...value,
    processInspector: async () => (++processCalls === 1 ? [] : processSet(value.inputPath)),
    launcher: async ({ env }) => { userDataPath = env.CODEX_ELECTRON_USER_DATA_PATH; return { pid: 4100 }; },
    terminateProcessTree: async () => { throw new Error("termination-failed"); },
    waitForExit: async () => false,
    pageInspector: async () => [{ id: "page-1", type: "page", url: "file:///index.html?token=secret", title: "Codex" }],
  }), /termination-failed/u);
  assert.ok(userDataPath);
  assert.equal(fs.existsSync(userDataPath), false);
});
