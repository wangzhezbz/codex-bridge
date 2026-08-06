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

test("launches only a validated absolute executable through execFile with no shell", async () => {
  const fixture = fakeHost();
  await fixture.host.launchOwned("D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe");
  assertCommand(fixture.calls.execFile[0], "D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe", []);
  assert.equal(fixture.calls.execFile[0].options.detached, true);
  await assert.rejects(fixture.host.launchOwned("ChatGPT.exe"), /executable_path_absolute_required/);
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
  const fixture = fakeHost({ shortcuts: new Map([
    [`${desktopPath}\\ChatGPT.lnk`, { target: "C:\\Other\\ChatGPT.exe" }],
    [`${desktopPath}\\ChatGPT（1）.lnk`, { target: "C:\\Other\\ChatGPT.exe" }],
  ]) });

  const record = await fixture.host.createShortcut({ desktopPath, name: "ChatGPT", targetPath });

  assert.deepEqual(record, {
    path: `${desktopPath}\\ChatGPT（2）.lnk`,
    desktopPath,
    targetPath,
  });
  assert.deepEqual(fixture.calls.shortcutWrites, [{
    path: `${desktopPath}\\ChatGPT（2）.lnk`,
    operation: "create",
    options: { target: targetPath, cwd: "D:\\CBApps\\ChatGPT\\c", description: "ChatGPT" },
  }]);
});

test("supports the native Electron shell shortcut API without a synthetic existence method", async () => {
  const desktopPath = "C:\\Users\\me\\Desktop";
  const targetPath = "D:\\CBApps\\ChatGPT\\c\\ChatGPT.exe";
  const occupiedPath = `${desktopPath}\\ChatGPT.lnk`;
  const createdPath = `${desktopPath}\\ChatGPT（1）.lnk`;
  const shortcuts = new Map([[occupiedPath, { target: "C:\\Other\\ChatGPT.exe" }]]);
  const writes = [];
  const trashed = [];
  const electronShell = {
    readShortcutLink(shortcutPath) {
      if (!shortcuts.has(shortcutPath)) throw new Error("missing shortcut");
      return shortcuts.get(shortcutPath);
    },
    writeShortcutLink(shortcutPath, operation, options) {
      writes.push(shortcutPath);
      if (shortcuts.has(shortcutPath)) return false;
      shortcuts.set(shortcutPath, { target: options.target });
      return true;
    },
    async trashItem(shortcutPath) {
      trashed.push(shortcutPath);
      shortcuts.delete(shortcutPath);
    },
  };
  const host = createWindowsHost({
    platform: "win32",
    env: {},
    electronShell,
    async execFile() { return { exitCode: 0, stdout: "", stderr: "" }; },
  });

  const record = await host.createShortcut({ desktopPath, name: "ChatGPT", targetPath });
  assert.equal(record.path, createdPath);
  assert.deepEqual(writes, [occupiedPath, createdPath]);
  assert.deepEqual(await host.removeRecordedShortcut(record), { removed: true, path: createdPath });
  assert.deepEqual(trashed, [createdPath]);
  assert.equal(shortcuts.has(occupiedPath), true);
  assert.equal(shortcuts.has(createdPath), false);
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
  assert.deepEqual(fixture.calls.trashed, [recordedPath]);
  assert.equal(fixture.shortcuts.has(recordedPath), false);
  assert.equal(fixture.shortcuts.has(otherPath), true);
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
  assert.deepEqual(fixture.calls.trashed, []);
});

test("Git installer command uses a fixed verified silent argument list", async () => {
  const fixture = fakeHost();
  await fixture.host.runGitInstaller({ installerPath: "D:\\staging\\Git.exe", targetDir: "D:\\CBApps\\Git\\current" });
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
} = {}) {
  const calls = {
    execFile: [],
    registry: [],
    processList: 0,
    shortcutWrites: [],
    trashed: [],
  };

  const execFile = async (file, args, options) => {
    calls.execFile.push({ file, args: [...args], options });
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
  const electronShell = {
    async shortcutExists(shortcutPath) {
      return shortcuts.has(shortcutPath);
    },
    readShortcutLink(shortcutPath) {
      if (!shortcuts.has(shortcutPath)) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return { ...shortcuts.get(shortcutPath) };
    },
    writeShortcutLink(shortcutPath, operation, options) {
      calls.shortcutWrites.push({ path: shortcutPath, operation, options });
      if (shortcuts.has(shortcutPath)) return false;
      shortcuts.set(shortcutPath, { target: options.target });
      return true;
    },
    async trashItem(shortcutPath) {
      calls.trashed.push(shortcutPath);
      shortcuts.delete(shortcutPath);
    },
  };

  return {
    host: createWindowsHost({ platform, execFile, electronShell, registryReader, processLister, env }),
    calls,
    shortcuts,
  };
}

function assertCommand(call, file, args) {
  assert.equal(call.file, file);
  assert.deepEqual(call.args, args);
  assert.equal(call.options.shell, false);
}
