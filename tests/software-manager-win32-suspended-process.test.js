import assert from "node:assert/strict";
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWin32FileApi } from "../desktop/software-manager/win32-file-api.mjs";
import { createWindowsFileCapabilities } from "../desktop/software-manager/windows-file-capabilities.mjs";
import {
  createWin32SuspendedProcessCapability,
  quoteWindowsArgument,
} from "../desktop/software-manager/win32-suspended-process.mjs";

const helperPath = fileURLToPath(new URL("./fixtures/software-manager-suspended-helper.mjs", import.meta.url));
const windowsOnly = process.platform !== "win32" ? "requires CreateProcessW" : false;

test("Windows command-line quoting preserves empty, spaced, quoted, and trailing-backslash arguments", () => {
  assert.equal(quoteWindowsArgument("plain"), "plain");
  assert.equal(quoteWindowsArgument(""), "\"\"");
  assert.equal(quoteWindowsArgument("two words"), "\"two words\"");
  assert.equal(quoteWindowsArgument('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArgument("C:\\trailing slash\\"), '"C:\\trailing slash\\\\"');
});

for (const pointerSize of [8, 4]) {
  test(`suspended process uses the ${pointerSize * 8}-bit PROCESS_INFORMATION ABI and resumes only after the gate`, async () => {
    const fake = fakeKernel32(pointerSize);
    const capability = createWin32SuspendedProcessCapability({ platform: "win32", koffi: fake.koffi, pollIntervalMs: 1 });
    let released = false;
    fake.setReleasedProbe(() => released);
    const result = await capability.run({
      executablePath: "C:\\Program Files\\Git\\git.exe",
      args: ["", "two words", 'say "hi"'],
      cwd: "C:\\Program Files\\Git",
      env: { Path: "C:\\Windows", SYSTEMROOT: "C:\\Windows" },
      timeoutMs: 30_000,
      beforeResume: async () => { await Promise.resolve(); released = true; },
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(fake.calls.resumeSawReleased, [true]);
    assert.equal(released, true);
    assert.equal(fake.calls.create[0].commandLine, '"C:\\Program Files\\Git\\git.exe" "" "two words" "say \\"hi\\""');
    assert.deepEqual(fake.calls.create[0].environment, ["Path=C:\\Windows", "SYSTEMROOT=C:\\Windows"]);
    assert.equal(fake.calls.create[0].startupSize, pointerSize === 8 ? 104 : 68);
    assert.deepEqual(fake.calls.closed.sort(), [11, 12]);
    assert.equal(capability.activeProcessCount(), 0);
  });
}

test("timeout terminates the suspended-process child, waits for exit, and closes both handles", async () => {
  const fake = fakeKernel32(8, { neverExitsUntilTerminated: true });
  const capability = createWin32SuspendedProcessCapability({ platform: "win32", koffi: fake.koffi, pollIntervalMs: 1 });
  await assert.rejects(capability.run({
    executablePath: "C:\\Git\\git.exe", args: [], cwd: "C:\\Git", env: {}, timeoutMs: 30,
    beforeResume: async () => {},
  }), /windows_process_timeout/u);
  assert.equal(fake.calls.terminated.length, 1);
  assert.deepEqual(fake.calls.closed.sort(), [11, 12]);
  assert.equal(capability.activeProcessCount(), 0);
});

test("cancellation while the mutable-release gate is pending terminates the still-suspended child", async () => {
  const fake = fakeKernel32(8, { neverExitsUntilTerminated: true });
  const capability = createWin32SuspendedProcessCapability({ platform: "win32", koffi: fake.koffi, pollIntervalMs: 1 });
  const controller = new AbortController();
  const running = capability.run({
    executablePath: "C:\\Git\\git.exe", args: [], cwd: "C:\\Git", env: {}, timeoutMs: 30_000,
    signal: controller.signal, beforeResume: async () => new Promise(() => {}),
  });
  controller.abort(new Error("cancel-gate"));
  await assert.rejects(Promise.race([
    running,
    new Promise((_, reject) => setTimeout(() => reject(new Error("gate_cancellation_not_observed")), 100)),
  ]), /windows_process_aborted/u);
  assert.deepEqual(fake.calls.resumed, []);
  assert.equal(fake.calls.terminated.length, 1);
  assert.deepEqual(fake.calls.closed.sort(), [11, 12]);
  assert.equal(capability.activeProcessCount(), 0);
});

test("real CreateProcessW keeps a helper suspended until its file pin is released", { skip: windowsOnly }, async () => {
  const root = path.join(process.cwd(), `.tmp-suspended-${process.pid}-${Date.now()}`);
  const source = path.join(root, "source.txt");
  const moved = path.join(root, "moved.txt");
  await mkdir(root);
  await writeFile(source, "held");
  const fileCapabilities = createWindowsFileCapabilities({ nativeApi: createWin32FileApi() });
  const pin = await fileCapabilities.pinArchiveFileNoFollow(source);
  const capability = createWin32SuspendedProcessCapability();
  try {
    const result = await capability.run({
      executablePath: process.execPath,
      args: [helperPath, "rename", source, moved], cwd: root, env: process.env, timeoutMs: 30_000,
      beforeResume: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await assert.rejects(readFile(moved), (error) => error?.code === "ENOENT");
        await assert.rejects(rename(source, moved), (error) => ["EBUSY", "EPERM", "EACCES"].includes(error?.code));
        await pin.close();
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal((await readFile(moved, "utf8")), "held");
    assert.equal(capability.activeProcessCount(), 0);
  } finally {
    await pin.close().catch(() => {});
    await unlink(source).catch(() => {});
    await unlink(moved).catch(() => {});
    await rmdir(root).catch(() => {});
  }
});

for (const mode of ["timeout", "abort"]) {
  test(`real CreateProcessW ${mode} terminates the resumed helper and closes native handles`, { skip: windowsOnly }, async () => {
    const root = path.join(process.cwd(), `.tmp-suspended-${mode}-${process.pid}-${Date.now()}`);
    await mkdir(root);
    const capability = createWin32SuspendedProcessCapability({ pollIntervalMs: 10 });
    const controller = new AbortController();
    let childPid = 0;
    try {
      const running = capability.run({
        executablePath: process.execPath,
        args: [helperPath, "hang"], cwd: root, env: process.env,
        timeoutMs: mode === "timeout" ? 100 : 30_000,
        signal: controller.signal,
        beforeResume: async ({ pid }) => {
          childPid = pid;
          if (mode === "abort") setTimeout(() => controller.abort(new Error("cancel-test")), 50);
        },
      });
      await assert.rejects(running, new RegExp(`windows_process_${mode === "abort" ? "aborted" : "timeout"}`, "u"));
      assert.equal(capability.activeProcessCount(), 0);
      await assertProcessGone(childPid);
    } finally {
      if (childPid > 0) {
        try { process.kill(childPid, "SIGKILL"); } catch {}
      }
      await rmdir(root).catch(() => {});
    }
  });
}

function fakeKernel32(pointerSize, { neverExitsUntilTerminated = false } = {}) {
  let terminated = false;
  let releasedProbe = () => false;
  const calls = { create: [], resumed: [], terminated: [], closed: [], resumeSawReleased: [] };
  const stubs = {
    CreateProcessW(_application, commandLine, _pa, _ta, inherit, flags, environment, cwd, startup, info) {
      const commandText = readWide(commandLine);
      const environmentText = readWide(environment, true);
      calls.create.push({
        commandLine: commandText, environment: environmentText.split("\0").filter(Boolean), cwd,
        inherit, flags, startupSize: startup.readUInt32LE(0),
      });
      if (pointerSize === 8) {
        info.writeBigUInt64LE(11n, 0); info.writeBigUInt64LE(12n, 8); info.writeUInt32LE(4242, 16); info.writeUInt32LE(9, 20);
      } else {
        info.writeUInt32LE(11, 0); info.writeUInt32LE(12, 4); info.writeUInt32LE(4242, 8); info.writeUInt32LE(9, 12);
      }
      return 1;
    },
    ResumeThread(handle) { calls.resumed.push(Number(handle)); calls.resumeSawReleased.push(releasedProbe()); return 1; },
    WaitForSingleObject() { return neverExitsUntilTerminated && !terminated ? 258 : 0; },
    TerminateProcess(handle, code) { terminated = true; calls.terminated.push([Number(handle), code]); return 1; },
    GetExitCodeProcess(_handle, output) { output.writeUInt32LE(terminated ? 0xc000013a : 0, 0); return 1; },
    CloseHandle(handle) { calls.closed.push(Number(handle)); return 1; },
    GetLastError() { return 5; },
  };
  return {
    calls,
    koffi: {
      load() { return { func(_cc, name) { return stubs[name]; } }; },
      sizeof(type) { return type === "intptr_t" ? pointerSize : 4; },
    },
    setReleasedProbe(probe) { releasedProbe = probe; },
  };
}

function readWide(buffer, doubleNull = false) {
  let end = 0;
  while (end + 1 < buffer.length) {
    if (buffer.readUInt16LE(end) === 0) {
      if (!doubleNull || buffer.readUInt16LE(end + 2) === 0) break;
    }
    end += 2;
  }
  return buffer.subarray(0, end).toString("utf16le");
}

async function assertProcessGone(pid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`process_still_alive:${pid}`);
}
