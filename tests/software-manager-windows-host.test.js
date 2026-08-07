import test from "node:test";
import assert from "node:assert/strict";

import { createWindowsHost } from "../desktop/software-manager/windows-host.mjs";

const REGISTRY_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1",
];
const REGISTRY_FIELDS = ["DisplayName", "DisplayVersion", "InstallLocation", "UninstallString"];
const AUTHENTICODE_COMMAND = "$s=Get-AuthenticodeSignature -LiteralPath $env:CB_SM_PACKAGE_PATH; @{Status=[string]$s.Status; Thumbprint=$s.SignerCertificate.Thumbprint; Subject=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress";

test("rejects construction outside Windows before any host adapter can run", () => {
  let called = false;
  assert.throws(
    () => createWindowsHost({ platform: "darwin", execFile: async () => { called = true; } }),
    /windows_platform_required/,
  );
  assert.equal(called, false);
});

test("discovers one registered Git only when the registry and PATH executable uniquely correspond", async () => {
  const fixture = fakeHost({
    registryRecords: new Map([[REGISTRY_KEYS[0], gitRegistryRecord()]]),
    wherePaths: ["D:\\Apps\\Git\\cmd\\git.exe"],
  });

  const result = await fixture.host.discoverGit();

  assert.deepEqual(result, {
    kind: "external",
    ownership: "external",
    version: "2.51.0.windows.1",
    installDir: "D:\\Apps\\Git",
    executablePath: "D:\\Apps\\Git\\cmd\\git.exe",
    uninstallerPath: "D:\\Apps\\Git\\unins000.exe",
    registryKey: REGISTRY_KEYS[0],
  });
  assert.deepEqual(fixture.calls.registry.map(({ key }) => key), REGISTRY_KEYS);
  assert.equal(fixture.calls.registry.every(({ fields }) => fields !== REGISTRY_FIELDS
    && JSON.stringify(fields) === JSON.stringify(REGISTRY_FIELDS)), true);
  assertCommand(fixture.calls.execFile.at(-1), "where.exe", ["git.exe"]);
});

test("default Git registry discovery invokes only fixed reg.exe keys and arguments", async () => {
  const fixture = fakeHost({
    registryRecords: null,
    wherePaths: ["D:\\Apps\\Git\\cmd\\git.exe"],
    regOutputs: new Map([[REGISTRY_KEYS[0], registryText(gitRegistryRecord())]]),
  });

  const result = await fixture.host.discoverGit();

  assert.equal(result.executablePath, "D:\\Apps\\Git\\cmd\\git.exe");
  const registryCalls = fixture.calls.execFile.filter(({ file }) => file === "reg.exe");
  assert.deepEqual(registryCalls.map(({ args }) => args), REGISTRY_KEYS.map((key) => ["query", key]));
  assert.equal(registryCalls.every(({ options }) => options.shell === false), true);
});

test("rejects multiple registered Git installations before selecting a target", async () => {
  const fixture = fakeHost({
    registryRecords: new Map([
      [REGISTRY_KEYS[0], gitRegistryRecord()],
      [REGISTRY_KEYS[2], gitRegistryRecord({
        installLocation: "E:\\OtherGit",
        uninstallString: "E:\\OtherGit\\unins000.exe",
      })],
    ]),
    wherePaths: ["D:\\Apps\\Git\\cmd\\git.exe", "E:\\OtherGit\\cmd\\git.exe"],
  });
  await assert.rejects(fixture.host.discoverGit(), /git_multiple_installations/);
});

test("rejects portable or unregistered Git found on PATH", async () => {
  const fixture = fakeHost({
    registryRecords: new Map(),
    wherePaths: ["D:\\PortableGit\\cmd\\git.exe"],
  });
  await assert.rejects(fixture.host.discoverGit(), /git_portable_or_unregistered/);
});

test("reports no Git only when both registered and PATH discoveries are empty", async () => {
  const fixture = fakeHost({ registryRecords: new Map(), wherePaths: [] });
  assert.deepEqual(await fixture.host.discoverGit(), { kind: "none" });
});

test("treats normal reg.exe and where.exe not-found rejections as an empty discovery", async () => {
  const calls = [];
  const host = createWindowsHost({
    platform: "win32",
    env: {},
    electronShell: {},
    async execFile(file, args, options) {
      calls.push({ file, args, options });
      const error = new Error("not found");
      error.code = 1;
      error.stdout = "";
      error.stderr = "not found";
      throw error;
    },
  });

  assert.deepEqual(await host.discoverGit(), { kind: "none" });
  assert.deepEqual(calls.map(({ file }) => file), ["reg.exe", "reg.exe", "reg.exe", "where.exe"]);
  assert.equal(calls.every(({ options }) => options.shell === false), true);
});

for (const [label, record, error] of [
  ["missing install location", gitRegistryRecord({ installLocation: undefined }), /git_registry_incomplete/],
  ["unexpected registry field", { ...gitRegistryRecord(), QuietUninstallString: "malicious" }, /git_registry_fields_rejected/],
  ["non-Git display name", gitRegistryRecord({ displayName: "PortableGit" }), /git_registry_incomplete/],
  ["uninstaller outside the install", gitRegistryRecord({ uninstallString: "C:\\Other\\unins000.exe" }), /git_registry_incomplete/],
  ["uninstaller arguments", gitRegistryRecord({ uninstallString: "\"D:\\Apps\\Git\\unins000.exe\" /SILENT" }), /git_registry_incomplete/],
]) {
  test(`rejects an incomplete registered Git record: ${label}`, async () => {
    const fixture = fakeHost({
      registryRecords: new Map([[REGISTRY_KEYS[0], record]]),
      wherePaths: ["D:\\Apps\\Git\\cmd\\git.exe"],
    });
    await assert.rejects(fixture.host.discoverGit(), error);
  });
}

test("rejects a registered Git whose PATH executable does not uniquely match", async () => {
  const fixture = fakeHost({
    registryRecords: new Map([[REGISTRY_KEYS[0], gitRegistryRecord()]]),
    wherePaths: ["E:\\PortableGit\\cmd\\git.exe"],
  });
  await assert.rejects(fixture.host.discoverGit(), /git_executable_mismatch/);
});

test("Authenticode uses one fixed PowerShell command and a child-only package environment variable", async () => {
  const packagePath = "D:\\staging\\Git $(Get-ChildItem).exe";
  const parentEnv = { PATH: "C:\\Windows", KEEP: "parent" };
  const fixture = fakeHost({ env: parentEnv, authenticode: {
    Status: "Valid",
    Thumbprint: "ABC123",
    Subject: "CN=Git for Windows",
  } });

  const result = await fixture.host.verifyAuthenticode(packagePath);

  assert.deepEqual(result, { status: "Valid", thumbprint: "ABC123", subject: "CN=Git for Windows" });
  assert.deepEqual(parentEnv, { PATH: "C:\\Windows", KEEP: "parent" });
  const call = fixture.calls.execFile[0];
  assertCommand(call, "powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", AUTHENTICODE_COMMAND,
  ]);
  assert.equal(call.args.includes(packagePath), false);
  assert.notEqual(call.options.env, parentEnv);
  assert.deepEqual(call.options.env, { ...parentEnv, CB_SM_PACKAGE_PATH: packagePath });
});

test("Authenticode rejects malformed output instead of treating it as unsigned metadata", async () => {
  const fixture = fakeHost({ authenticodeOutput: "not-json" });
  await assert.rejects(fixture.host.verifyAuthenticode("D:\\staging\\Git.exe"), /authenticode_output_invalid/);
});

test("stops only processes whose normalized absolute executable path is exactly owned", async () => {
  const fixture = fakeHost({ processes: [
    { pid: 11, name: "ChatGPT.exe", executablePath: "D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe" },
    { pid: 12, name: "ChatGPT.exe", executablePath: "C:\\Program Files\\ChatGPT\\ChatGPT.exe" },
    { pid: 13, name: "anything.exe", executablePath: "d:/cbapps/chatgpt/c/CHATGPT.EXE" },
    { pid: 14, name: "ChatGPT.exe", executablePath: null },
  ] });

  const result = await fixture.host.stopOwnedProcesses(["D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe"]);

  assert.deepEqual(result, { stoppedProcessIds: [11, 13] });
  const taskkillCalls = fixture.calls.execFile.filter(({ file }) => file === "taskkill.exe");
  assert.deepEqual(taskkillCalls.map(({ args }) => args), [
    ["/PID", "11", "/F"],
    ["/PID", "13", "/F"],
  ]);
  assert.equal(taskkillCalls.every(({ options }) => options.shell === false), true);
});

test("revalidates PID executable ownership immediately before stopping and skips a reused PID", async () => {
  const calls = { list: 0, execFile: [] };
  const host = createWindowsHost({
    platform: "win32",
    env: {},
    electronShell: {},
    async execFile(file, args, options) {
      calls.execFile.push({ file, args, options });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async processLister() {
      calls.list += 1;
      return calls.list === 1
        ? [{ pid: 21, executablePath: "D:\\Owned\\ChatGPT.exe" }]
        : [{ pid: 21, executablePath: "C:\\Other\\ChatGPT.exe" }];
    },
  });

  const result = await host.stopOwnedProcesses(["D:\\Owned\\ChatGPT.exe"]);

  assert.deepEqual(result, { stoppedProcessIds: [] });
  assert.equal(calls.list, 2);
  assert.deepEqual(calls.execFile, []);
});

test("default process discovery keeps owned paths out of its fixed PowerShell command", async () => {
  const calls = [];
  const ownedPath = "D:\\Owned $(Get-Process)\\ChatGPT.exe";
  const host = createWindowsHost({
    platform: "win32",
    env: {},
    electronShell: {},
    async execFile(file, args, options) {
      calls.push({ file, args, options });
      if (file === "powershell.exe") {
        return { exitCode: 0, stdout: JSON.stringify({ ProcessId: 31, ExecutablePath: ownedPath }), stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(await host.stopOwnedProcesses([ownedPath]), { stoppedProcessIds: [31] });
  const listCalls = calls.filter(({ file }) => file === "powershell.exe");
  assert.equal(listCalls.length, 2);
  assert.equal(listCalls.every(({ args }) => args.join(" ").includes(ownedPath) === false), true);
  assert.equal(listCalls.every(({ args }) => args.at(-1)
    === "@(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"), true);
  assert.deepEqual(calls.at(-1).args, ["/PID", "31", "/F"]);
});

test("process ownership rejects relative executable paths before listing or stopping anything", async () => {
  const fixture = fakeHost({ processes: [{ pid: 11, executablePath: "D:\\Apps\\tool.exe" }] });
  await assert.rejects(fixture.host.stopOwnedProcesses(["ChatGPT.exe"]), /executable_path_absolute_required/);
  assert.equal(fixture.calls.processList, 0);
  assert.equal(fixture.calls.execFile.length, 0);
});

test("launchOwned waits for spawn evidence, unrefs, and never waits for process exit", { timeout: 1_000 }, async () => {
  const fixture = fakeHost();
  const result = await fixture.host.launchOwned("D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe");

  assert.deepEqual(result, { executablePath: "D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe", pid: 4242 });
  assert.equal(fixture.calls.execFile.length, 0);
  assert.deepEqual(fixture.calls.spawnDetached, [{
    file: "D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe",
    args: [],
    options: {
      shell: false,
      stdio: "ignore",
      windowsHide: false,
      detached: true,
      env: { PATH: "C:\\Windows" },
    },
  }]);
  assert.deepEqual(fixture.calls.unref, [4242]);
  assert.equal(fixture.spawnExitSettled(), false);
  await assert.rejects(fixture.host.launchOwned("ChatGPT.exe"), /executable_path_absolute_required/);
});

test("launchOwned does not claim success before delayed spawn evidence and does not unref a failed spawn", async () => {
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const delayed = fakeHost({ spawnStarted: started });
  let settled = false;
  const pending = delayed.host.launchOwned("D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe")
    .finally(() => { settled = true; });

  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(delayed.calls.unref, []);
  resolveStarted();
  await pending;
  assert.deepEqual(delayed.calls.unref, [4242]);

  const failed = fakeHost({ spawnStarted: Promise.reject(new Error("spawn failed")) });
  await assert.rejects(
    failed.host.launchOwned("D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe"),
    /owned_process_launch_failed/,
  );
  assert.deepEqual(failed.calls.unref, []);
});

test("launchOwned fails closed when the detached-spawn capability is absent", async () => {
  const host = createWindowsHost({
    platform: "win32",
    env: {},
    electronShell: {},
    async execFile() { return { exitCode: 0, stdout: "", stderr: "" }; },
  });
  await assert.rejects(host.launchOwned("D:\\Owned\\ChatGPT.exe"), /spawn_detached_adapter_required/);
});

test("launchOwned does not return started when detached handle unref fails", async () => {
  const fixture = fakeHost({ spawnUnrefFailure: new Error("unref failed") });
  await assert.rejects(
    fixture.host.launchOwned("D:\\Owned\\ChatGPT.exe"),
    /owned_process_launch_failed/,
  );
  assert.deepEqual(fixture.calls.unref, [4242]);
});

test("rejects Windows alternate-data-stream paths before executing them", async () => {
  const fixture = fakeHost();
  await assert.rejects(
    fixture.host.launchOwned("D:\\CBApps\\ChatGPT.exe:payload.exe"),
    /executable_path_absolute_required|executable_path_rejected/,
  );
  await assert.rejects(
    fixture.host.runGitInstaller({
      installerPath: "D:\\staging\\Git.exe",
      targetDir: "D:\\CBApps:alternate\\Git",
    }),
    /git_target_absolute_required/,
  );
  assert.equal(fixture.calls.execFile.length, 0);
});

test("creates shortcut collision names in ChatGPT.lnk, ChatGPT（1）.lnk order without overwriting", async () => {
  const desktopPath = "C:\\Users\\me\\Desktop";
  const targetPath = "D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe";
  const basePath = `${desktopPath}\\ChatGPT.lnk`;
  const firstCollisionPath = `${desktopPath}\\ChatGPT（1）.lnk`;
  const fixture = fakeHost({ shortcuts: new Map([
    [basePath, { target: "C:\\Other\\ChatGPT.exe" }],
    [firstCollisionPath, { target: "C:\\Other2\\ChatGPT.exe" }],
  ]) });

  const record = await fixture.host.createShortcut({ desktopPath, name: "ChatGPT", targetPath });

  assert.deepEqual(record, {
    path: `${desktopPath}\\ChatGPT（2）.lnk`,
    desktopPath,
    targetPath,
  });
  assert.deepEqual(fixture.calls.tempCreates, [{ directory: desktopPath, suffix: ".lnk" }]);
  assert.deepEqual(fixture.calls.shortcutWrites, [{
    path: `${desktopPath}\\.codexbridge-shortcut-1.lnk`,
    operation: "create",
    options: { target: targetPath, cwd: "D:\\CBApps\\ChatGPT\\c", description: "ChatGPT" },
  }]);
  assert.equal(fixture.calls.tempSeals.length, 1);
  assert.equal(fixture.calls.shortcutReads[0].held, true);
  assert.deepEqual(fixture.calls.shortcutCommits.map(({ destinationPath }) => destinationPath), [
    basePath,
    firstCollisionPath,
    `${desktopPath}\\ChatGPT（2）.lnk`,
  ]);
  assert.equal(fixture.shortcuts.get(basePath).target, "C:\\Other\\ChatGPT.exe");
  assert.equal(fixture.shortcuts.get(firstCollisionPath).target, "C:\\Other2\\ChatGPT.exe");
  assert.equal(fixture.shortcuts.get(record.path).target, targetPath);
  assert.deepEqual(fixture.calls.tempRemoves, []);
});

test("shortcut creation cleans only its exact temporary link when atomic commit fails", async () => {
  const desktopPath = "C:\\Users\\me\\Desktop";
  const existingPath = `${desktopPath}\\ChatGPT.lnk`;
  const fixture = fakeHost({
    shortcuts: new Map([[existingPath, { target: "C:\\Other\\ChatGPT.exe" }]]),
    shortcutCommitFailure: new Error("native commit failed"),
  });

  await assert.rejects(
    fixture.host.createShortcut({
      desktopPath,
      name: "ChatGPT",
      targetPath: "D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe",
    }),
    /shortcut_commit_failed/,
  );

  assert.deepEqual(fixture.calls.shortcutWrites.map(({ path: shortcutPath }) => shortcutPath), [
    `${desktopPath}\\.codexbridge-shortcut-1.lnk`,
  ]);
  assert.deepEqual(fixture.calls.tempRemoves.map(({ path: shortcutPath }) => shortcutPath), [
    `${desktopPath}\\.codexbridge-shortcut-1.lnk`,
  ]);
  assert.equal(fixture.shortcuts.get(existingPath).target, "C:\\Other\\ChatGPT.exe");
  assert.equal(fixture.shortcuts.size, 1);
});

test("shortcut creation cleans a capability-owned temp object that fails same-desktop validation", async () => {
  const fixture = fakeHost({ shortcutTempPath: "D:\\Other\\.codexbridge-shortcut-1.lnk" });

  await assert.rejects(
    fixture.host.createShortcut({
      desktopPath: "C:\\Users\\me\\Desktop",
      name: "ChatGPT",
      targetPath: "D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe",
    }),
    /shortcut_temp_capability_invalid/,
  );

  assert.deepEqual(fixture.calls.shortcutWrites, []);
  assert.deepEqual(fixture.calls.tempRemoves.map(({ path: shortcutPath }) => shortcutPath), [
    "D:\\Other\\.codexbridge-shortcut-1.lnk",
  ]);
});

test("shortcut methods fail closed without atomic shortcut filesystem capabilities", async () => {
  const writes = [];
  const electronShell = {
    writeShortcutLink(...args) { writes.push(args); return true; },
    readShortcutLink() { return { target: "D:\\Owned\\ChatGPT.exe" }; },
  };
  const host = createWindowsHost({
    platform: "win32",
    env: {},
    electronShell,
    spawnDetached: defaultSpawnDetached(),
    async execFile() { return { exitCode: 0, stdout: "", stderr: "" }; },
  });

  await assert.rejects(
    host.createShortcut({
      desktopPath: "C:\\Users\\me\\Desktop",
      name: "ChatGPT",
      targetPath: "D:\\Owned\\ChatGPT.exe",
    }),
    /shortcut_file_capability_required/,
  );
  await assert.rejects(
    host.removeRecordedShortcut({
      path: "C:\\Users\\me\\Desktop\\ChatGPT.lnk",
      desktopPath: "C:\\Users\\me\\Desktop",
      targetPath: "D:\\Owned\\ChatGPT.exe",
    }),
    /shortcut_file_capability_required/,
  );
  assert.deepEqual(writes, []);
});

test("shortcut creation rejects renderer-controlled names and non-absolute targets", async () => {
  const fixture = fakeHost();
  await assert.rejects(
    fixture.host.createShortcut({
      desktopPath: "C:\\Users\\me\\Desktop",
      name: "..\\payload",
      targetPath: "D:\\CBApps\\app.exe",
    }),
    /shortcut_name_rejected/,
  );
  await assert.rejects(
    fixture.host.createShortcut({ desktopPath: "C:\\Users\\me\\Desktop", name: "ChatGPT", targetPath: "app.exe" }),
    /executable_path_absolute_required/,
  );
  assert.equal(fixture.calls.shortcutWrites.length, 0);
});

test("removes only the exact recorded desktop shortcut when its current target still matches", async () => {
  const desktopPath = "C:\\Users\\me\\Desktop";
  const recordedPath = `${desktopPath}\\ChatGPT（1）.lnk`;
  const otherPath = `${desktopPath}\\ChatGPT.lnk`;
  const targetPath = "D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe";
  const fixture = fakeHost({ shortcuts: new Map([
    [recordedPath, { target: targetPath }],
    [otherPath, { target: "C:\\Other\\ChatGPT.exe" }],
  ]) });

  const result = await fixture.host.removeRecordedShortcut({ path: recordedPath, desktopPath, targetPath });

  assert.deepEqual(result, { removed: true, path: recordedPath });
  assert.deepEqual(fixture.calls.fileRemoves.map(({ path: shortcutPath }) => shortcutPath), [recordedPath]);
  assert.equal(fixture.shortcuts.has(recordedPath), false);
  assert.equal(fixture.shortcuts.has(otherPath), true);
});

test("recorded shortcut removal distinguishes absent and non-file paths without mutation", async () => {
  const desktopPath = "C:\\Users\\me\\Desktop";
  const targetPath = "D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe";
  const absentPath = `${desktopPath}\\ChatGPT.lnk`;
  const otherPath = `${desktopPath}\\ChatGPT（1）.lnk`;
  const fixture = fakeHost({ otherShortcutPaths: new Set([otherPath]) });

  assert.deepEqual(
    await fixture.host.removeRecordedShortcut({ path: absentPath, desktopPath, targetPath }),
    { removed: false, path: absentPath },
  );
  await assert.rejects(
    fixture.host.removeRecordedShortcut({ path: otherPath, desktopPath, targetPath }),
    /shortcut_path_not_file/,
  );
  assert.deepEqual(fixture.calls.fileRemoves, []);
});

test("refuses shortcut deletion outside the recorded desktop or after target replacement", async () => {
  const desktopPath = "C:\\Users\\me\\Desktop";
  const targetPath = "D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe";
  const outside = "C:\\Users\\me\\Documents\\ChatGPT.lnk";
  const inside = `${desktopPath}\\ChatGPT.lnk`;
  const fixture = fakeHost({ shortcuts: new Map([
    [outside, { target: targetPath }],
    [inside, { target: "C:\\Other\\ChatGPT.exe" }],
  ]) });

  await assert.rejects(
    fixture.host.removeRecordedShortcut({ path: outside, desktopPath, targetPath }),
    /shortcut_path_not_desktop_child/,
  );
  await assert.rejects(
    fixture.host.removeRecordedShortcut({ path: inside, desktopPath, targetPath }),
    /shortcut_target_mismatch/,
  );
  assert.deepEqual(fixture.calls.fileRemoves, []);
  assert.equal(fixture.calls.fileReleases.length, 1);
});

test("recorded shortcut removal reads and removes through the same held inspection descriptor", async () => {
  const desktopPath = "C:\\Users\\me\\Desktop";
  const shortcutPath = `${desktopPath}\\ChatGPT.lnk`;
  const targetPath = "D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe";
  const fixture = fakeHost({ shortcuts: new Map([[shortcutPath, { target: targetPath }]]) });

  await fixture.host.removeRecordedShortcut({ path: shortcutPath, desktopPath, targetPath });

  assert.equal(fixture.calls.shortcutReads[0].held, true);
  assert.equal(fixture.calls.fileRemoves[0], fixture.calls.fileInspects[0].descriptor);
  assert.deepEqual(fixture.calls.fileReleases, []);
});

test("Git installer command uses a fixed verified silent argument list", async () => {
  const fixture = fakeHost();
  await fixture.host.runGitInstaller({
    installerPath: "D:\\staging\\Git.exe", targetDir: "D:\\CBApps\\Git\\current", onStarted: async () => {},
  });
  assertCommand(fixture.calls.execFile[0], "D:\\staging\\Git.exe", [
    "/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-", "/CLOSEAPPLICATIONS",
    "/o:PathOption=Cmd", "/DIR=D:\\CBApps\\Git\\current",
  ]);
});

test("Git uninstaller command accepts only a direct-child uninstaller and fixed arguments", async () => {
  const fixture = fakeHost();
  await fixture.host.runGitUninstaller({
    uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
    installDir: "D:\\CBApps\\Git",
    onStarted: async () => {},
  });
  assertCommand(fixture.calls.execFile[0], "D:\\CBApps\\Git\\unins000.exe", [
    "/VERYSILENT", "/NORESTART", "/NOCANCEL",
  ]);
  await assert.rejects(
    fixture.host.runGitUninstaller({
      uninstallerPath: "C:\\Other\\unins000.exe",
      installDir: "D:\\CBApps\\Git",
    }),
    /git_uninstaller_path_mismatch/,
  );
});

test("Git execution releases mutable pins only after spawn evidence and before process completion", async () => {
  let allowSpawn;
  let allowExit;
  let started = false;
  let completed = false;
  const spawnGate = new Promise((resolve) => { allowSpawn = resolve; });
  const exitGate = new Promise((resolve) => { allowExit = resolve; });
  const host = createWindowsHost({
    platform: "win32",
    env: {},
    electronShell: {},
    async execFile(_file, _args, options) {
      await spawnGate;
      await options.onSpawn();
      assert.equal(started, true, "the start callback releases mutable pins at spawn");
      await exitGate;
      completed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  const running = host.runGitInstaller({
    installerPath: "D:\\staging\\Git.exe",
    targetDir: "D:\\CBApps\\Git",
    onStarted: async () => { started = true; },
  });
  await Promise.resolve();
  assert.equal(started, false, "pins remain held before the child is created");
  allowSpawn();
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false, "the installer may still be running after mutable pins are released");
  allowExit();
  await running;
});

test("Git execution forwards bounded timeout and cancellation and requires spawn evidence", async () => {
  const controller = new AbortController();
  let receivedOptions;
  const host = createWindowsHost({
    platform: "win32",
    env: {},
    electronShell: {},
    async execFile(_file, _args, options) {
      receivedOptions = options;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(host.runGitInstaller({
    installerPath: "D:\\staging\\Git.exe",
    targetDir: "D:\\CBApps\\Git",
    timeoutMs: 45_000,
    signal: controller.signal,
    onStarted: async () => {},
  }), /git_process_start_evidence_missing/u);
  assert.equal(receivedOptions.timeout, 45_000);
  assert.equal(receivedOptions.signal, controller.signal);
});

for (const [label, action] of [
  ["relative installer", (host) => host.runGitInstaller({ installerPath: "Git.exe", targetDir: "D:\\CBApps\\Git" })],
  ["relative target", (host) => host.runGitInstaller({ installerPath: "D:\\staging\\Git.exe", targetDir: "Git" })],
  ["drive-root target", (host) => host.runGitInstaller({ installerPath: "D:\\staging\\Git.exe", targetDir: "D:\\" })],
  ["relative uninstaller", (host) => host.runGitUninstaller({ uninstallerPath: "unins000.exe", installDir: "D:\\Git" })],
]) {
  test(`rejects unsafe Git command plan: ${label}`, async () => {
    const fixture = fakeHost();
    await assert.rejects(action(fixture.host), /absolute|required|root|mismatch/);
    assert.equal(fixture.calls.execFile.length, 0);
  });
}

function gitRegistryRecord(overrides = {}) {
  const source = {
    displayName: "Git",
    displayVersion: "2.51.0.windows.1",
    installLocation: "D:\\Apps\\Git",
    uninstallString: "D:\\Apps\\Git\\unins000.exe",
    ...overrides,
  };
  const result = {};
  if (source.displayName !== undefined) result.DisplayName = source.displayName;
  if (source.displayVersion !== undefined) result.DisplayVersion = source.displayVersion;
  if (source.installLocation !== undefined) result.InstallLocation = source.installLocation;
  if (source.uninstallString !== undefined) result.UninstallString = source.uninstallString;
  return result;
}

function registryText(record) {
  const rows = Object.entries(record).map(([name, value]) => `    ${name}    REG_SZ    ${value}`);
  return [`HKEY_LOCAL_MACHINE\\Software\\Git_is1`, ...rows, ""].join("\r\n");
}

function fakeHost({
  platform = "win32",
  env = { PATH: "C:\\Windows" },
  registryRecords = new Map(),
  regOutputs = new Map(),
  wherePaths = [],
  authenticode = { Status: "Valid", Thumbprint: "ABC", Subject: "CN=Signer" },
  authenticodeOutput,
  processes = [],
  shortcuts = new Map(),
  otherShortcutPaths = new Set(),
  shortcutCommitFailure = null,
  shortcutTempPath = null,
  spawnStarted = Promise.resolve(),
  spawnUnrefFailure = null,
} = {}) {
  const calls = {
    execFile: [],
    registry: [],
    processList: 0,
    spawnDetached: [],
    unref: [],
    shortcutWrites: [],
    shortcutReads: [],
    tempCreates: [],
    tempSeals: [],
    shortcutCommits: [],
    tempRemoves: [],
    fileInspects: [],
    fileRemoves: [],
    fileReleases: [],
  };
  let spawnExitSettled = false;
  const spawnExit = new Promise(() => {}).finally(() => { spawnExitSettled = true; });
  const identities = new Map();
  let identitySequence = 0;
  for (const shortcutPath of shortcuts.keys()) {
    identities.set(shortcutPath, `identity-${++identitySequence}`);
  }
  const tempReservations = new Map();
  const heldPaths = new Map();
  let tempSequence = 0;

  const execFile = async (file, args, options) => {
    calls.execFile.push({ file, args: [...args], options });
    await options.onSpawn?.();
    if (file === "reg.exe") {
      const key = args[1];
      if (!regOutputs.has(key)) return { exitCode: 1, stdout: "", stderr: "not found" };
      return { exitCode: 0, stdout: regOutputs.get(key), stderr: "" };
    }
    if (file === "where.exe") {
      return wherePaths.length === 0
        ? { exitCode: 1, stdout: "", stderr: "not found" }
        : { exitCode: 0, stdout: `${wherePaths.join("\r\n")}\r\n`, stderr: "" };
    }
    if (file === "powershell.exe" && args.at(-1) === AUTHENTICODE_COMMAND) {
      return {
        exitCode: 0,
        stdout: authenticodeOutput ?? JSON.stringify(authenticode),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const registryReader = registryRecords === null ? undefined : async ({ key, fields }) => {
    calls.registry.push({ key, fields });
    return registryRecords.get(key) ?? null;
  };
  const processLister = async () => {
    calls.processList += 1;
    return processes;
  };
  const spawnDetached = async (file, args, options) => {
    calls.spawnDetached.push({ file, args: [...args], options });
    return {
      pid: 4242,
      started: spawnStarted,
      exit: spawnExit,
      unref() {
        calls.unref.push(4242);
        if (spawnUnrefFailure) throw spawnUnrefFailure;
      },
    };
  };
  const electronShell = {
    readShortcutLink(shortcutPath) {
      calls.shortcutReads.push({ path: shortcutPath, held: heldPaths.has(shortcutPath) });
      if (!shortcuts.has(shortcutPath)) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return { ...shortcuts.get(shortcutPath) };
    },
    writeShortcutLink(shortcutPath, operation, options) {
      calls.shortcutWrites.push({ path: shortcutPath, operation, options });
      otherShortcutPaths.delete(shortcutPath);
      shortcuts.set(shortcutPath, { target: options.target });
      identities.set(shortcutPath, `identity-${++identitySequence}`);
      return true;
    },
  };
  const shortcutFileApi = {
    async createTemp({ directory, suffix }) {
      calls.tempCreates.push({ directory, suffix });
      const temp = {
        path: shortcutTempPath ?? `${directory}\\.codexbridge-shortcut-${++tempSequence}${suffix}`,
        token: `temp-${tempSequence}`,
      };
      tempReservations.set(temp.token, temp);
      identities.set(temp.path, `identity-${++identitySequence}`);
      return temp;
    },
    async sealTemp(temp) {
      calls.tempSeals.push(temp);
      if (!tempReservations.has(temp?.token) || !shortcuts.has(temp.path)) {
        throw new Error("invalid temp capability");
      }
      const sealed = { path: temp.path, token: temp.token, sealToken: `seal-${temp.token}` };
      heldPaths.set(sealed.path, sealed);
      return sealed;
    },
    async commitNoReplace(sealed, destinationPath) {
      calls.shortcutCommits.push({ temp: sealed, destinationPath });
      if (shortcutCommitFailure) throw shortcutCommitFailure;
      if (!tempReservations.has(sealed?.token) || heldPaths.get(sealed.path) !== sealed
        || !shortcuts.has(sealed.path)) {
        throw new Error("invalid temp capability");
      }
      if (shortcuts.has(destinationPath) || otherShortcutPaths.has(destinationPath)
        || [...tempReservations.values()].some((entry) => entry.path === destinationPath)) {
        return "occupied";
      }
      shortcuts.set(destinationPath, shortcuts.get(sealed.path));
      identities.set(destinationPath, identities.get(sealed.path));
      shortcuts.delete(sealed.path);
      identities.delete(sealed.path);
      tempReservations.delete(sealed.token);
      heldPaths.delete(sealed.path);
      return "committed";
    },
    async removeTemp(temp) {
      calls.tempRemoves.push(temp);
      if (!tempReservations.has(temp?.token)) throw new Error("invalid temp capability");
      shortcuts.delete(temp.path);
      identities.delete(temp.path);
      tempReservations.delete(temp.token);
      heldPaths.delete(temp.path);
    },
    async inspectExact(shortcutPath) {
      const call = { path: shortcutPath, descriptor: null };
      calls.fileInspects.push(call);
      if (otherShortcutPaths.has(shortcutPath)) return { kind: "other" };
      if (!shortcuts.has(shortcutPath)) return { kind: "absent" };
      const descriptor = { kind: "file", path: shortcutPath, token: `inspect-${++identitySequence}` };
      call.descriptor = descriptor;
      heldPaths.set(shortcutPath, descriptor);
      return descriptor;
    },
    async removeExact(descriptor) {
      calls.fileRemoves.push(descriptor);
      const shortcutPath = descriptor?.path;
      if (heldPaths.get(shortcutPath) !== descriptor || !shortcuts.has(shortcutPath)) return false;
      shortcuts.delete(shortcutPath);
      identities.delete(shortcutPath);
      heldPaths.delete(shortcutPath);
      return true;
    },
    async release(descriptor) {
      calls.fileReleases.push(descriptor);
      if (heldPaths.get(descriptor?.path) === descriptor) heldPaths.delete(descriptor.path);
    },
  };

  return {
    host: createWindowsHost({
      platform,
      execFile,
      electronShell,
      registryReader,
      processLister,
      shortcutFileApi,
      spawnDetached,
      env,
    }),
    calls,
    shortcuts,
    spawnExitSettled: () => spawnExitSettled,
  };
}

function defaultSpawnDetached() {
  return async () => ({ pid: 4242, started: Promise.resolve(), unref() {} });
}

function assertCommand(call, file, args) {
  assert.equal(call.file, file);
  assert.deepEqual(call.args, args);
  assert.equal(call.options.shell, false);
}
