import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as codexLocator from "../desktop/codex-locator.mjs";

const { locateCodexInstall } = codexLocator;

function locate(overrides = {}) {
  return locateCodexInstall({
    platform: "win32",
    desktopOptions: {},
    env: {},
    homeDir: "C:\\Users\\tester",
    preferredTargets: [],
    commonCandidates: [],
    shortcutCandidates: [],
    resolveShortcut: async () => "",
    shellAppCandidates: async () => [],
    pathCandidates: async () => [],
    exists: () => false,
    ...overrides,
  });
}

function locateCli(overrides = {}) {
  return codexLocator.locateCodexCliSync({
    platform: "win32",
    desktopOptions: {},
    env: { PATH: "" },
    homeDir: "C:\\Users\\tester",
    explicitCliTargets: [],
    pathCandidates: [],
    shellAppCandidates: [],
    readDir: () => [],
    exists: () => false,
    ...overrides,
  });
}

function locateDesktop(overrides = {}) {
  return codexLocator.locateOpenAIDesktopSync({
    platform: "win32",
    desktopOptions: {},
    env: { PATH: "" },
    homeDir: "C:\\Users\\tester",
    explicitCliTargets: [],
    preferredTargets: [],
    commonCandidates: [],
    restrictedCandidates: [],
    shortcutCandidates: [],
    shellAppCandidates: [],
    pathCandidates: [],
    readDir: () => [],
    exists: () => false,
    ...overrides,
  });
}

test("exports a synchronous Codex CLI locator without changing the async locator", () => {
  assert.equal(typeof codexLocator.locateCodexCliSync, "function");
  assert.equal(typeof codexLocator.locateOpenAIDesktopSync, "function");
  assert.equal(typeof locateCodexInstall, "function");
});

test("desktop-only discovery ignores an explicit CLI and validates the resolved desktop target", () => {
  const cliTarget = "C:\\Tools\\codex.exe";
  const shortcut = "C:\\Menu\\ChatGPT.lnk";
  const desktopTarget = "C:\\Apps\\ChatGPT\\ChatGPT.exe";

  const result = locateDesktop({
    env: { PATH: "", CODEX_CLI_PATH: cliTarget },
    shortcutCandidates: [shortcut],
    exists: (candidate) => [cliTarget, shortcut, desktopTarget].includes(candidate),
    resolveShortcut: () => ({ targetPath: desktopTarget, arguments: "" }),
  });

  assert.deepEqual(result, {
    found: true,
    launchTarget: desktopTarget,
    kind: "executable",
    source: "shortcut",
  });
});

test("desktop-only discovery rejects existing shortcuts that resolve to web browsers or nowhere", () => {
  const shortcut = "C:\\Menu\\ChatGPT.lnk";
  const chromeTarget = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  for (const resolution of [
    { targetPath: chromeTarget, arguments: "https://chatgpt.com" },
    { targetPath: "C:\\Missing\\ChatGPT.exe", arguments: "" },
    null,
  ]) {
    const result = locateDesktop({
      shortcutCandidates: [shortcut],
      exists: (candidate) => [shortcut, chromeTarget].includes(candidate),
      resolveShortcut: () => resolution,
    });
    assert.deepEqual(result, {
      found: false,
      launchTarget: "",
      kind: null,
      source: null,
    });
  }
});

test("desktop-only discovery accepts supported exe, app, Store, and resolved shortcut targets", () => {
  const chatgptExe = "C:\\Apps\\ChatGPT\\ChatGPT.exe";
  assert.equal(locateDesktop({
    commonCandidates: [chatgptExe],
    exists: (candidate) => candidate === chatgptExe,
  }).launchTarget, chatgptExe);

  const codexShortcut = "C:\\Menu\\Codex.lnk";
  const codexExe = "C:\\Apps\\Codex\\Codex.exe";
  assert.equal(locateDesktop({
    shortcutCandidates: [codexShortcut],
    exists: (candidate) => candidate === codexShortcut || candidate === codexExe,
    resolveShortcut: () => ({ targetPath: codexExe }),
  }).launchTarget, codexExe);

  const storeTarget = "shell:AppsFolder\\OpenAI.ChatGPT_2p2nqsd0c76g0!App";
  assert.equal(locateDesktop({
    shellAppCandidates: [storeTarget],
    resolveStoreInstall: () => "C:\\Store\\ChatGPT",
  }).launchTarget, storeTarget);
  const registeredWin32Target = "shell:AppsFolder\\com.openai.codex";
  assert.equal(locateDesktop({
    shellAppCandidates: [registeredWin32Target],
  }).launchTarget, registeredWin32Target);
  assert.equal(locateDesktop({
    shellAppCandidates: ["shell:AppsFolder\\OpenAI.ChatGPT_untrusted!App"],
    resolveStoreInstall: () => "",
  }).found, false);

  const macApp = "/Applications/ChatGPT.app";
  assert.equal(locateDesktop({
    platform: "darwin",
    commonCandidates: [macApp],
    exists: (candidate) => candidate === macApp,
  }).launchTarget, macApp);
});

test("desktop-only discovery reuses the shared shortcut candidate and operation budgets", () => {
  const shortcuts = Array.from({ length: 20 }, (_, index) => `C:\\Menu\\ChatGPT-${index}.lnk`);
  let resolutions = 0;
  const result = locateDesktop({
    shortcutCandidates: shortcuts,
    maxShortcutCandidates: 3,
    maxOperations: 20,
    maxDurationMs: 1000,
    now: () => 0,
    exists: (candidate) => shortcuts.includes(candidate),
    resolveShortcut: () => {
      resolutions += 1;
      return null;
    },
  });

  assert.equal(resolutions, 3);
  assert.equal(result.found, false);
});

test("default shortcut resolver binds special paths out of band", () => {
  const shortcut = "C:\\菜单 含空格\\ChatGPT's Desktop.lnk";
  const desktopTarget = "C:\\Apps\\ChatGPT\\ChatGPT.exe";
  const cliTarget = "C:\\Apps\\ChatGPT\\resources\\codex.exe";
  let invocation = null;

  const result = locateCli({
    shortcutCandidates: [shortcut],
    commonCandidates: [],
    restrictedCandidates: [],
    exists: (candidate) => [shortcut, desktopTarget, cliTarget].includes(candidate),
    execFile: (command, args, options) => {
      invocation = { command, args, options };
      return JSON.stringify({ targetPath: desktopTarget, arguments: "" });
    },
  });

  assert.equal(invocation?.command, "powershell.exe");
  assert.equal(invocation?.options?.env?.CODEXBRIDGE_SHORTCUT_PATH, shortcut);
  assert.equal(invocation?.args.includes(shortcut), false);
  assert.deepEqual(result, {
    found: true,
    cliTarget,
    desktopTarget,
    source: "shortcut",
    kind: "executable",
  });
});

test("default shortcut resolver opens a real lnk whose path has spaces, Chinese, and an apostrophe", {
  skip: process.platform !== "win32"
    ? "Windows-only integration test"
    : process.env.CODEXBRIDGE_SKIP_WINDOWS_HOSTED_RUNNER_INTEGRATION === "1"
      ? "GitHub-hosted Windows runners do not expose a stable interactive WScript COM session"
      : false,
}, (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-locator-"));
  const installRoot = path.join(tempRoot, "含 空格's ChatGPT");
  const resourcesDir = path.join(installRoot, "resources");
  const desktopTarget = path.join(installRoot, "ChatGPT.exe");
  const cliTarget = path.join(resourcesDir, "codex.exe");
  const shortcut = path.join(tempRoot, "聊天 ChatGPT's Desktop.lnk");

  fs.mkdirSync(installRoot);
  fs.mkdirSync(resourcesDir);
  fs.copyFileSync(process.execPath, desktopTarget);
  fs.writeFileSync(cliTarget, "");
  const canonicalDesktopTarget = fs.realpathSync.native(desktopTarget);
  const canonicalCliTarget = fs.realpathSync.native(cliTarget);
  t.after(() => {
    for (const file of [shortcut, cliTarget, desktopTarget]) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
    for (const directory of [resourcesDir, installRoot, tempRoot]) {
      if (fs.existsSync(directory)) {
        fs.rmdirSync(directory);
      }
    }
  });

  execFileSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "$shortcutPath=[Environment]::GetEnvironmentVariable('CODEXBRIDGE_TEST_SHORTCUT_PATH'); $targetPath=[Environment]::GetEnvironmentVariable('CODEXBRIDGE_TEST_SHORTCUT_TARGET'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath); $s.TargetPath=$targetPath; $s.Arguments=\"--fixture '中文 参数'\"; $s.Save()",
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      CODEXBRIDGE_TEST_SHORTCUT_PATH: shortcut,
      CODEXBRIDGE_TEST_SHORTCUT_TARGET: desktopTarget,
    },
  });
  assert.equal(fs.existsSync(shortcut), true);

  const result = locateCli({
    shortcutCandidates: [shortcut],
    commonCandidates: [],
    restrictedCandidates: [],
    exists: fs.existsSync,
  });

  assert.deepEqual(result, {
    found: true,
    cliTarget: canonicalCliTarget,
    desktopTarget: canonicalDesktopTarget,
    source: "shortcut",
    kind: "executable",
  });
});

test("default Store resolver binds package family out of band and finds packaged codex CLI", () => {
  const packageFamily = "OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0";
  const shellTarget = `shell:AppsFolder\\${packageFamily}!App`;
  const installRoot = "C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT-Desktop_1.0.0_x64__2p2nqsd0c76g0";
  const cliTarget = `${installRoot}\\resources\\codex.exe`;
  let invocation = null;

  const result = locateCli({
    shortcutCandidates: [],
    commonCandidates: [],
    restrictedCandidates: [],
    shellAppCandidates: [shellTarget],
    pathCandidates: [],
    exists: (candidate) => candidate === cliTarget,
    execFile: (command, args, options) => {
      invocation = { command, args, options };
      return `${installRoot}\n`;
    },
  });

  assert.equal(invocation?.command, "powershell.exe");
  assert.equal(invocation?.options?.env?.CODEXBRIDGE_PACKAGE_FAMILY, packageFamily);
  assert.equal(invocation?.args.includes(packageFamily), false);
  assert.deepEqual(result, {
    found: true,
    cliTarget,
    desktopTarget: shellTarget,
    source: "shell_app",
    kind: "shell_app",
  });
});

test("default Start Menu and Desktop shortcuts resolve packaged resources CLI without PATH or explicit CLI", () => {
  const env = {
    PATH: "",
    USERPROFILE: "C:\\Users\\tester",
    APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    ProgramData: "C:\\ProgramData",
    PUBLIC: "C:\\Users\\Public",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  };
  const startMenuShortcut = "C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Codex.lnk";
  const desktopShortcut = "C:\\Users\\tester\\Desktop\\Codex.lnk";
  const startDesktop = "C:\\Apps\\StartCodex\\Codex.exe";
  const desktopDesktop = "C:\\Apps\\DesktopCodex\\Codex.exe";
  const startCli = "C:\\Apps\\StartCodex\\resources\\codex.exe";
  const desktopCli = "C:\\Apps\\DesktopCodex\\resources\\codex.exe";

  const fromStartMenu = locateCli({
    env,
    exists: (candidate) => [startMenuShortcut, startDesktop, startCli].includes(candidate),
    resolveShortcut: (candidate) => candidate === startMenuShortcut ? { targetPath: startDesktop } : null,
  });
  assert.deepEqual(fromStartMenu, {
    found: true,
    cliTarget: startCli,
    desktopTarget: startDesktop,
    source: "shortcut",
    kind: "executable",
  });

  const fromDesktop = locateCli({
    env,
    exists: (candidate) => [desktopShortcut, desktopDesktop, desktopCli].includes(candidate),
    resolveShortcut: (candidate) => candidate === desktopShortcut ? { targetPath: desktopDesktop } : null,
  });
  assert.deepEqual(fromDesktop, {
    found: true,
    cliTarget: desktopCli,
    desktopTarget: desktopDesktop,
    source: "shortcut",
    kind: "executable",
  });
});

test("default ChatGPT shortcut names resolve ChatGPT.exe to the packaged codex CLI", () => {
  const env = {
    PATH: "",
    USERPROFILE: "C:\\Users\\tester",
    APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    ProgramData: "C:\\ProgramData",
    PUBLIC: "C:\\Users\\Public",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  };
  const shortcutRoot = `${env.APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs`;
  const cases = [
    ["ChatGPT.lnk", "resources\\codex.exe"],
    ["ChatGPT Desktop.lnk", "app\\resources\\codex.exe"],
    ["OpenAI ChatGPT.lnk", "resources\\codex.exe"],
  ];

  for (const [shortcutName, cliSuffix] of cases) {
    const shortcut = `${shortcutRoot}\\${shortcutName}`;
    const desktopTarget = "C:\\Apps\\Unified ChatGPT\\ChatGPT.exe";
    const cliTarget = `C:\\Apps\\Unified ChatGPT\\${cliSuffix}`;
    const checked = [];
    const result = locateCli({
      env,
      commonCandidates: [],
      restrictedCandidates: [],
      exists: (candidate) => {
        checked.push(candidate);
        return candidate === shortcut || candidate === desktopTarget || candidate === cliTarget;
      },
      resolveShortcut: (candidate) => candidate === shortcut
        ? { targetPath: desktopTarget, arguments: "--background" }
        : null,
    });

    assert.deepEqual(result, {
      found: true,
      cliTarget,
      desktopTarget,
      source: "shortcut",
      kind: "executable",
    }, shortcutName);
    assert.equal(
      checked.some((candidate) => /[\\/]resources[\\/]chatgpt\.exe$/i.test(candidate)),
      false,
      `${shortcutName} must never derive a ChatGPT CLI`,
    );
  }
});

test("coexisting default shortcuts prefer unified ChatGPT and keep legacy Codex as fallback", () => {
  const env = {
    PATH: "",
    USERPROFILE: "C:\\Users\\tester",
    APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    ProgramData: "C:\\ProgramData",
    PUBLIC: "C:\\Users\\Public",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  };
  const root = `${env.APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs`;
  const chatgptShortcut = `${root}\\ChatGPT.lnk`;
  const codexShortcut = `${root}\\Codex.lnk`;
  const chatgptTarget = "C:\\Apps\\ChatGPT\\ChatGPT.exe";
  const codexTarget = "C:\\Apps\\Codex\\Codex.exe";
  const chatgptCli = "C:\\Apps\\ChatGPT\\resources\\codex.exe";
  const codexCli = "C:\\Apps\\Codex\\resources\\codex.exe";
  const resolved = [];

  const result = locateCli({
    env,
    commonCandidates: [],
    restrictedCandidates: [],
    exists: (candidate) => [
      chatgptShortcut,
      codexShortcut,
      chatgptTarget,
      codexTarget,
      chatgptCli,
      codexCli,
    ].includes(candidate),
    resolveShortcut: (candidate) => {
      resolved.push(candidate);
      return candidate === chatgptShortcut
        ? { targetPath: chatgptTarget }
        : { targetPath: codexTarget };
    },
  });

  assert.deepEqual(resolved, [chatgptShortcut]);
  assert.deepEqual(result, {
    found: true,
    cliTarget: chatgptCli,
    desktopTarget: chatgptTarget,
    source: "shortcut",
    kind: "executable",
  });
});

test("unified ChatGPT common installs take deterministic precedence over a legacy Codex install", () => {
  const env = {
    PATH: "",
    USERPROFILE: "C:\\Users\\tester",
    APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    ProgramData: "C:\\ProgramData",
    PUBLIC: "C:\\Users\\Public",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  };
  const chatgptTarget = `${env.LOCALAPPDATA}\\Programs\\ChatGPT\\ChatGPT.exe`;
  const chatgptCli = `${env.LOCALAPPDATA}\\Programs\\ChatGPT\\app\\resources\\codex.exe`;
  const legacyTarget = `${env.LOCALAPPDATA}\\OpenAI\\Codex\\Codex.exe`;
  const legacyCli = `${env.LOCALAPPDATA}\\OpenAI\\Codex\\resources\\codex.exe`;

  const result = locateCli({
    env,
    shortcutCandidates: [],
    commonCandidates: undefined,
    restrictedCandidates: [],
    exists: (candidate) => [chatgptTarget, chatgptCli, legacyTarget, legacyCli].includes(candidate),
  });

  assert.deepEqual(result, {
    found: true,
    cliTarget: chatgptCli,
    desktopTarget: chatgptTarget,
    source: "common",
    kind: "executable",
  });
});

test("CHATGPT_DESKTOP_EXE precedes the legacy env alias while saved desktop settings remain highest", () => {
  const chatgptTarget = "C:\\Env\\ChatGPT\\ChatGPT.exe";
  const chatgptCli = "C:\\Env\\ChatGPT\\resources\\codex.exe";
  const codexTarget = "C:\\Env\\Codex\\Codex.exe";
  const codexCli = "C:\\Env\\Codex\\resources\\codex.exe";
  const savedTarget = "C:\\Saved\\Codex\\Codex.exe";
  const savedCli = "C:\\Saved\\Codex\\resources\\codex.exe";
  const env = {
    PATH: "",
    CHATGPT_DESKTOP_EXE: chatgptTarget,
    CODEX_DESKTOP_EXE: codexTarget,
  };
  const exists = (candidate) => [
    chatgptTarget,
    chatgptCli,
    codexTarget,
    codexCli,
    savedTarget,
    savedCli,
  ].includes(candidate);

  const fromEnvironment = locateCli({
    env,
    shortcutCandidates: [],
    commonCandidates: [],
    restrictedCandidates: [],
    exists,
  });
  assert.deepEqual(fromEnvironment, {
    found: true,
    cliTarget: chatgptCli,
    desktopTarget: chatgptTarget,
    source: "env",
    kind: "executable",
  });

  const fromSaved = locateCli({
    env,
    desktopOptions: { codexDesktopExe: savedTarget },
    shortcutCandidates: [],
    commonCandidates: [],
    restrictedCandidates: [],
    exists,
  });
  assert.deepEqual(fromSaved, {
    found: true,
    cliTarget: savedCli,
    desktopTarget: savedTarget,
    source: "saved",
    kind: "executable",
  });
});

test("async restart locator recognizes CHATGPT_DESKTOP_EXE before CODEX_DESKTOP_EXE", async () => {
  const chatgptTarget = "C:\\Env\\ChatGPT\\ChatGPT.exe";
  const codexTarget = "C:\\Env\\Codex\\Codex.exe";

  const result = await locate({
    env: {
      CHATGPT_DESKTOP_EXE: chatgptTarget,
      CODEX_DESKTOP_EXE: codexTarget,
    },
    exists: (candidate) => candidate === chatgptTarget || candidate === codexTarget,
  });

  assert.deepEqual(result, {
    found: true,
    launchTarget: chatgptTarget,
    kind: "executable",
    source: "env",
  });
});

test("macOS ChatGPT.app resolves its codex CLI sibling without inventing a ChatGPT CLI", () => {
  const appTarget = "/Applications/ChatGPT.app";
  const appCli = "/Applications/ChatGPT.app/Contents/Resources/app/resources/codex";
  const checked = [];

  const result = codexLocator.locateCodexCliSync({
    platform: "darwin",
    env: { PATH: "" },
    homeDir: "/Users/tester",
    shortcutCandidates: [],
    commonCandidates: undefined,
    restrictedCandidates: [],
    shellAppCandidates: [],
    pathCandidates: [],
    exists: (candidate) => {
      checked.push(candidate);
      return candidate === appTarget || candidate === appCli;
    },
  });

  assert.deepEqual(result, {
    found: true,
    cliTarget: appCli,
    desktopTarget: appTarget,
    source: "common",
    kind: "mac_app",
  });
  assert.equal(
    checked.some((candidate) => /Contents[\\/]Resources(?:[\\/]app[\\/]resources)?[\\/]chatgpt(?:\.exe)?$/i.test(candidate)),
    false,
  );
});

test("Store discovery accepts ChatGPT and Codex AppIDs but rejects ChatGPT Classic and CodexBridge", () => {
  const chatgptShell = "shell:AppsFolder\\OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!App";
  const classicShell = "shell:AppsFolder\\OpenAI.ChatGPTClassic_2p2nqsd0c76g0!App";
  const bridgeShell = "shell:AppsFolder\\OpenAI.CodexBridge_2p2nqsd0c76g0!App";
  const codexShell = "shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App";
  const chatgptRoot = "C:\\Store\\ChatGPT";
  const codexRoot = "C:\\Store\\Codex";
  const chatgptCli = `${chatgptRoot}\\app\\resources\\codex.exe`;
  const codexCli = `${codexRoot}\\resources\\codex.exe`;
  const startAppOutput = [codexShell, classicShell, bridgeShell, chatgptShell]
    .map((target) => target.replace(/^shell:AppsFolder\\/i, ""))
    .join("\n");
  const execFile = (_command, args) => {
    assert.match(args.join(" "), /Get-StartApps/);
    return startAppOutput;
  };

  const fallbackCalls = [];
  const fallback = locateCli({
    shortcutCandidates: [],
    commonCandidates: [],
    restrictedCandidates: [],
    shellAppCandidates: undefined,
    pathCandidates: [],
    execFile,
    resolveStoreInstall: (shellTarget) => {
      fallbackCalls.push(shellTarget);
      return shellTarget === chatgptShell ? chatgptRoot : codexRoot;
    },
    exists: (candidate) => candidate === codexCli,
  });
  assert.deepEqual(fallbackCalls, [chatgptShell, codexShell]);
  assert.deepEqual(fallback, {
    found: true,
    cliTarget: codexCli,
    desktopTarget: codexShell,
    source: "shell_app",
    kind: "shell_app",
  });

  const chatgptCalls = [];
  const unified = locateCli({
    shortcutCandidates: [],
    commonCandidates: [],
    restrictedCandidates: [],
    shellAppCandidates: undefined,
    pathCandidates: [],
    execFile,
    resolveStoreInstall: (shellTarget) => {
      chatgptCalls.push(shellTarget);
      return chatgptRoot;
    },
    exists: (candidate) => candidate === chatgptCli,
  });
  assert.deepEqual(chatgptCalls, [chatgptShell]);
  assert.deepEqual(unified, {
    found: true,
    cliTarget: chatgptCli,
    desktopTarget: chatgptShell,
    source: "shell_app",
    kind: "shell_app",
  });
});

test("desktop identity exclusion only checks the selected app and not its parent folders", () => {
  const target = "C:\\Builds\\CodexBridge-release\\OpenAI\\ChatGPT.exe";
  const result = codexLocator.locateOpenAIDesktopSync({
    platform: "win32",
    preferredTargets: [target],
    exists: (candidate) => candidate === target,
    shellAppCandidates: [],
    shortcutCandidates: [],
    commonCandidates: [],
    restrictedCandidates: [],
    pathCandidates: [],
  });

  assert.equal(result.found, true);
  assert.equal(result.launchTarget, target);
});

test("bounded Desktop shortcut discovery accepts ChatGPT names while ignoring Classic and CodexBridge", () => {
  const env = {
    PATH: "",
    USERPROFILE: "C:\\Users\\tester",
    APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    ProgramData: "C:\\ProgramData",
    PUBLIC: "C:\\Users\\Public",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  };
  const desktopRoot = `${env.USERPROFILE}\\Desktop`;
  const validShortcut = `${desktopRoot}\\ChatGPT Desktop.lnk`;
  const legacyShortcut = `${desktopRoot}\\Codex Preview.lnk`;
  const classicShortcut = `${desktopRoot}\\ChatGPT Classic.lnk`;
  const bridgeShortcut = `${desktopRoot}\\CodexBridge.lnk`;
  const desktopTarget = "C:\\Apps\\ChatGPT\\ChatGPT.exe";
  const cliTarget = "C:\\Apps\\ChatGPT\\resources\\codex.exe";
  const legacyTarget = "C:\\Apps\\Codex\\Codex.exe";
  const legacyCli = "C:\\Apps\\Codex\\resources\\codex.exe";
  const checked = [];

  const result = locateCli({
    env,
    commonCandidates: [],
    restrictedCandidates: [],
    maxShortcutCandidates: 17,
    readDir: (directory) => directory === desktopRoot
      ? [
        { name: "ChatGPT Classic.lnk", isDirectory: () => false, isFile: () => true },
        { name: "CodexBridge.lnk", isDirectory: () => false, isFile: () => true },
        { name: "Codex Preview.lnk", isDirectory: () => false, isFile: () => true },
        { name: "ChatGPT Desktop.lnk", isDirectory: () => false, isFile: () => true },
      ]
      : [],
    exists: (candidate) => {
      checked.push(candidate);
      return [validShortcut, legacyShortcut, desktopTarget, legacyTarget, cliTarget, legacyCli].includes(candidate);
    },
    resolveShortcut: (candidate) => candidate === validShortcut
      ? { targetPath: desktopTarget }
      : { targetPath: legacyTarget },
  });

  assert.equal(checked.includes(classicShortcut), false);
  assert.equal(checked.includes(bridgeShortcut), false);
  assert.equal(checked.includes(legacyShortcut), false);
  assert.deepEqual(result, {
    found: true,
    cliTarget,
    desktopTarget,
    source: "shortcut",
    kind: "executable",
  });
});

test("desktop discovery skips ChatGPT Classic and CodexBridge before a supported running app", async () => {
  const classicTarget = "C:\\Apps\\ChatGPT Classic\\ChatGPT.exe";
  const bridgeTarget = "C:\\Apps\\CodexBridge\\CodexBridge.exe";
  const chatgptTarget = "C:\\Apps\\ChatGPT\\ChatGPT.exe";
  const legacyTarget = "C:\\Apps\\Codex\\Codex.exe";

  const result = await locate({
    preferredTargets: [
      { target: classicTarget, source: "running" },
      { target: bridgeTarget, source: "running" },
      { target: chatgptTarget, source: "running" },
      { target: legacyTarget, source: "running" },
    ],
    exists: () => true,
  });

  assert.deepEqual(result, {
    found: true,
    launchTarget: chatgptTarget,
    kind: "executable",
    source: "running",
  });
});

test("a ChatGPT desktop executable is never accepted as the codex CLI", () => {
  const chatgptDesktop = "C:\\Tools\\ChatGPT.exe";
  const codexCli = "C:\\Tools\\codex.exe";

  const result = locateCli({
    shortcutCandidates: [],
    commonCandidates: [],
    restrictedCandidates: [],
    pathCandidates: [chatgptDesktop, codexCli],
    exists: (candidate) => candidate === chatgptDesktop || candidate === codexCli,
  });

  assert.deepEqual(result, {
    found: true,
    cliTarget: codexCli,
    desktopTarget: "",
    source: "path",
    kind: "cli",
  });
});

test("shortcut metadata cannot smuggle a ChatGPT executable in as the CLI", () => {
  const shortcut = "C:\\Menu\\ChatGPT.lnk";
  const desktopTarget = "C:\\Apps\\ChatGPT\\ChatGPT.exe";
  const wrongCli = "C:\\Apps\\ChatGPT\\resources\\chatgpt.exe";
  const codexCli = "C:\\Apps\\ChatGPT\\resources\\codex.exe";

  const result = locateCli({
    shortcutCandidates: [shortcut],
    commonCandidates: [],
    restrictedCandidates: [],
    exists: (candidate) => [shortcut, desktopTarget, wrongCli, codexCli].includes(candidate),
    resolveShortcut: () => ({
      targetPath: desktopTarget,
      cliTargets: [wrongCli, codexCli],
    }),
  });

  assert.deepEqual(result, {
    found: true,
    cliTarget: codexCli,
    desktopTarget,
    source: "shortcut",
    kind: "executable",
  });
});

test("Store shortcut arguments resolve shell desktop target and app resources CLI", () => {
  const shortcut = "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Codex.lnk";
  const shellTarget = "shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App";
  const installRoot = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0_x64__2p2nqsd0c76g0";
  const cliTarget = `${installRoot}\\app\\resources\\codex.exe`;

  const result = locateCli({
    shortcutCandidates: [shortcut],
    commonCandidates: [],
    restrictedCandidates: [],
    exists: (candidate) => candidate === shortcut || candidate === cliTarget,
    resolveShortcut: () => ({
      targetPath: "C:\\Windows\\explorer.exe",
      arguments: shellTarget,
      installLocation: installRoot,
    }),
  });

  assert.deepEqual(result, {
    found: true,
    cliTarget,
    desktopTarget: shellTarget,
    source: "shortcut",
    kind: "shell_app",
  });
});

test("shortcut resolution wins before an access denied WindowsApps executable candidate", () => {
  const restricted = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0\\Codex.exe";
  const shortcut = "C:\\Users\\tester\\Desktop\\Codex.lnk";
  const desktopTarget = "C:\\Safe\\Codex\\Codex.exe";
  const cliTarget = "C:\\Safe\\Codex\\resources\\codex.exe";
  let restrictedChecks = 0;

  const result = locateCli({
    shortcutCandidates: [shortcut],
    commonCandidates: [restricted],
    restrictedCandidates: [],
    exists: (candidate) => {
      if (candidate === restricted) {
        restrictedChecks += 1;
        const error = new Error("access denied");
        error.code = "EACCES";
        throw error;
      }
      return [shortcut, desktopTarget, cliTarget].includes(candidate);
    },
    resolveShortcut: () => ({ targetPath: desktopTarget }),
  });

  assert.equal(restrictedChecks, 0);
  assert.equal(result.cliTarget, cliTarget);
  assert.equal(result.source, "shortcut");
});

test("saved desktop executable resolves an app resources CLI sibling", () => {
  const desktopTarget = "C:\\Saved\\Codex\\Codex.exe";
  const cliTarget = "C:\\Saved\\Codex\\app\\resources\\codex.exe";

  const result = locateCli({
    desktopOptions: { codexDesktopExe: desktopTarget },
    shortcutCandidates: [],
    commonCandidates: [],
    restrictedCandidates: [],
    exists: (candidate) => candidate === desktopTarget || candidate === cliTarget,
  });

  assert.deepEqual(result, {
    found: true,
    cliTarget,
    desktopTarget,
    source: "saved",
    kind: "executable",
  });
});

test("default common installation candidates resolve the packaged CLI", () => {
  const env = {
    PATH: "",
    USERPROFILE: "C:\\Users\\tester",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
    ProgramData: "C:\\ProgramData",
    PUBLIC: "C:\\Users\\Public",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  };
  const desktopTarget = "C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\Codex.exe";
  const cliTarget = "C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\resources\\codex.exe";

  const result = locateCli({
    env,
    shortcutCandidates: [],
    commonCandidates: undefined,
    restrictedCandidates: [],
    exists: (candidate) => candidate === desktopTarget || candidate === cliTarget,
  });

  assert.deepEqual(result, {
    found: true,
    cliTarget,
    desktopTarget,
    source: "common",
    kind: "executable",
  });
});

test("missing explicit CLI falls through to a resolved PATH CLI", () => {
  const missing = "C:\\Missing\\resources\\codex.exe";
  const pathCli = "C:\\Tools\\codex.exe";

  const result = locateCli({
    explicitCliTargets: [missing],
    shortcutCandidates: [],
    commonCandidates: [],
    restrictedCandidates: [],
    pathCandidates: [pathCli],
    exists: (candidate) => candidate === pathCli,
  });

  assert.deepEqual(result, {
    found: true,
    cliTarget: pathCli,
    desktopTarget: "",
    source: "path",
    kind: "cli",
  });
});

test("Linux and macOS resolve PATH safely, mac bundles expose CLI siblings, and literal codex remains a fallback", () => {
  const linuxCli = "/opt/codex/bin/codex";
  const linux = codexLocator.locateCodexCliSync({
    platform: "linux",
    env: { PATH: "/missing:/opt/codex/bin" },
    homeDir: "/home/tester",
    shortcutCandidates: [],
    commonCandidates: [],
    restrictedCandidates: [],
    shellAppCandidates: [],
    exists: (candidate) => candidate === linuxCli,
    execFile: () => {
      throw new Error("safe PATH traversal should win before which");
    },
  });
  assert.deepEqual(linux, {
    found: true,
    cliTarget: linuxCli,
    desktopTarget: "",
    source: "path",
    kind: "cli",
  });

  const macWhichCli = "/usr/local/bin/codex";
  const macWhich = codexLocator.locateCodexCliSync({
    platform: "darwin",
    env: { PATH: "" },
    homeDir: "/Users/tester",
    shortcutCandidates: [],
    commonCandidates: [],
    restrictedCandidates: [],
    shellAppCandidates: [],
    exists: (candidate) => candidate === macWhichCli,
    execFile: (command, args) => {
      assert.equal(command, "which");
      assert.deepEqual(args, ["codex"]);
      return `${macWhichCli}\n`;
    },
  });
  assert.equal(macWhich.cliTarget, macWhichCli);
  assert.equal(macWhich.source, "path");

  const appTarget = "/Applications/Codex.app";
  const appCli = "/Applications/Codex.app/Contents/Resources/codex";
  const macBundle = codexLocator.locateCodexCliSync({
    platform: "darwin",
    env: { PATH: "" },
    homeDir: "/Users/tester",
    shortcutCandidates: [],
    commonCandidates: [appTarget],
    restrictedCandidates: [],
    shellAppCandidates: [],
    pathCandidates: [],
    exists: (candidate) => candidate === appTarget || candidate === appCli,
  });
  assert.deepEqual(macBundle, {
    found: true,
    cliTarget: appCli,
    desktopTarget: appTarget,
    source: "common",
    kind: "mac_app",
  });

  const literal = codexLocator.locateCodexCliSync({
    platform: "linux",
    env: { PATH: "" },
    homeDir: "/home/tester",
    shortcutCandidates: [],
    commonCandidates: [],
    restrictedCandidates: [],
    shellAppCandidates: [],
    exists: () => false,
    execFile: () => {
      throw new Error("which unavailable");
    },
  });
  assert.deepEqual(literal, {
    found: true,
    cliTarget: "codex",
    desktopTarget: "",
    source: "path_literal",
    kind: "cli",
  });
});

test("WindowsApps PATH aliases are never accepted as CLI and later packaged candidates still win", () => {
  const alias = "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\Codex.exe";
  const packagedCli = "C:\\Program Files\\Codex\\resources\\codex.exe";

  const result = locateCli({
    shortcutCandidates: [],
    commonCandidates: [],
    restrictedCandidates: [],
    pathCandidates: [alias, packagedCli],
    exists: (candidate) => candidate === alias || candidate === packagedCli,
  });

  assert.deepEqual(result, {
    found: true,
    cliTarget: packagedCli,
    desktopTarget: "",
    source: "path",
    kind: "cli",
  });
});

test("synchronous shortcut resolution obeys candidate, operation, and elapsed-time budgets", () => {
  const shortcuts = Array.from({ length: 64 }, (_, index) => `C:\\Menu\\Codex-${index}.lnk`);

  let cappedCalls = 0;
  locateCli({
    shortcutCandidates: shortcuts,
    commonCandidates: [],
    restrictedCandidates: [],
    maxShortcutCandidates: 4,
    maxOperations: 100,
    maxDurationMs: 1000,
    now: () => 0,
    exists: (candidate) => shortcuts.includes(candidate),
    resolveShortcut: () => {
      cappedCalls += 1;
      return null;
    },
  });
  assert.equal(cappedCalls, 4);

  let operationCalls = 0;
  locateCli({
    shortcutCandidates: shortcuts,
    commonCandidates: [],
    restrictedCandidates: [],
    maxShortcutCandidates: 64,
    maxOperations: 4,
    maxDurationMs: 1000,
    now: () => 0,
    exists: (candidate) => shortcuts.includes(candidate),
    resolveShortcut: () => {
      operationCalls += 1;
      return null;
    },
  });
  assert.equal(operationCalls, 2);

  let elapsedMs = 0;
  let timedCalls = 0;
  locateCli({
    shortcutCandidates: shortcuts,
    commonCandidates: [],
    restrictedCandidates: [],
    maxShortcutCandidates: 64,
    maxOperations: 100,
    maxDurationMs: 50,
    now: () => elapsedMs,
    exists: (candidate) => shortcuts.includes(candidate),
    resolveShortcut: () => {
      timedCalls += 1;
      elapsedMs = 60;
      return null;
    },
  });
  assert.equal(timedCalls, 1);
});

test("fixed shortcuts resolve before wide directory discovery can exhaust the shared budget", () => {
  const env = {
    PATH: "",
    USERPROFILE: "C:\\Users\\tester",
    APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    ProgramData: "C:\\ProgramData",
    PUBLIC: "C:\\Users\\Public",
  };
  const shortcut = "C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\ChatGPT.lnk";
  const desktopTarget = "C:\\Apps\\ChatGPT\\ChatGPT.exe";
  const cliTarget = "C:\\Apps\\ChatGPT\\resources\\codex.exe";
  const wideDirectory = Array.from({ length: 64 }, (_, index) => ({
    name: `nested-${index}`,
    isDirectory: () => true,
    isFile: () => false,
  }));
  let readDirectoryCalls = 0;

  const result = locateCli({
    env,
    commonCandidates: [],
    restrictedCandidates: [],
    maxOperations: 4,
    maxDurationMs: 1000,
    now: () => 0,
    readDir: () => {
      readDirectoryCalls += 1;
      return wideDirectory;
    },
    exists: (candidate) => candidate === shortcut || candidate === desktopTarget || candidate === cliTarget,
    resolveShortcut: (candidate) => candidate === shortcut
      ? { targetPath: desktopTarget }
      : null,
  });

  assert.deepEqual(result, {
    found: true,
    cliTarget,
    desktopTarget,
    source: "shortcut",
    kind: "executable",
  });
  assert.equal(readDirectoryCalls, 0);
});

test("shortcut Arguments extract only the exact shell AppsFolder token", () => {
  const shortcut = "C:\\Users\\tester\\Desktop\\Codex.lnk";
  const shellTarget = "shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App";
  const installRoot = "C:\\Store\\Codex";
  const cliTarget = `${installRoot}\\app\\resources\\codex.exe`;
  const argumentVariants = [
    shellTarget,
    `${shellTarget} --background`,
    `--open ${shellTarget} --background`,
    `"${shellTarget}" --background`,
  ];

  for (const argumentsValue of argumentVariants) {
    const result = locateCli({
      shortcutCandidates: [shortcut],
      commonCandidates: [],
      restrictedCandidates: [],
      exists: (candidate) => candidate === shortcut || candidate === cliTarget,
      resolveShortcut: () => ({
        targetPath: "C:\\Windows\\explorer.exe",
        arguments: argumentsValue,
        installLocation: installRoot,
      }),
    });
    assert.equal(result.desktopTarget, shellTarget, argumentsValue);
    assert.equal(result.cliTarget, cliTarget, argumentsValue);
  }
});

test("prefers an injected running target and preserves its source", async () => {
  const runningTarget = "C:\\Running\\Codex.exe";
  const laterPreferredTarget = "C:\\Preferred\\Codex.exe";

  const result = await locate({
    preferredTargets: [
      { target: runningTarget, source: "running" },
      laterPreferredTarget,
    ],
    exists: (candidate) => candidate === runningTarget || candidate === laterPreferredTarget,
  });

  assert.deepEqual(result, {
    found: true,
    launchTarget: runningTarget,
    kind: "executable",
    source: "running",
  });

  const aliased = await locate({
    preferredTargets: [
      { launchTarget: laterPreferredTarget, source: "running" },
    ],
    exists: (candidate) => candidate === laterPreferredTarget,
  });
  assert.deepEqual(aliased, {
    found: true,
    launchTarget: laterPreferredTarget,
    kind: "executable",
    source: "running",
  });
});

test("checks saved, environment, and common executable candidates in order", async () => {
  const savedTarget = "C:\\Saved\\Codex.exe";
  const envTarget = "C:\\Env\\Codex.exe";
  const commonTarget = "C:\\Common\\Codex.exe";

  const saved = await locate({
    desktopOptions: { codexDesktopLaunchTarget: savedTarget },
    env: { CODEX_DESKTOP_EXE: envTarget },
    commonCandidates: [commonTarget],
    exists: () => true,
  });
  assert.deepEqual(saved, {
    found: true,
    launchTarget: savedTarget,
    kind: "executable",
    source: "saved",
  });

  const environment = await locate({
    desktopOptions: { codexDesktopLaunchTarget: savedTarget },
    env: { CODEX_DESKTOP_EXE: envTarget },
    commonCandidates: [commonTarget],
    exists: (candidate) => candidate !== savedTarget,
  });
  assert.deepEqual(environment, {
    found: true,
    launchTarget: envTarget,
    kind: "executable",
    source: "env",
  });

  const common = await locate({
    desktopOptions: { codexDesktopLaunchTarget: savedTarget },
    env: { CODEX_DESKTOP_EXE: envTarget },
    commonCandidates: [commonTarget],
    exists: (candidate) => candidate === commonTarget,
  });
  assert.deepEqual(common, {
    found: true,
    launchTarget: commonTarget,
    kind: "executable",
    source: "common",
  });
});

test("resolves an existing Start Menu shortcut before returning it", async () => {
  const shortcut = "C:\\Users\\tester\\Start Menu\\Programs\\Codex.lnk";
  const target = "C:\\Apps\\Codex\\Codex.exe";
  const resolved = [];

  const result = await locate({
    shortcutCandidates: [shortcut],
    exists: (candidate) => candidate === shortcut || candidate === target,
    resolveShortcut: async (candidate) => {
      resolved.push(candidate);
      return target;
    },
  });

  assert.deepEqual(resolved, [shortcut]);
  assert.deepEqual(result, {
    found: true,
    launchTarget: target,
    kind: "executable",
    source: "shortcut",
  });
});

test("uses a Microsoft Store shell target exposed by a resolved shortcut", async () => {
  const shortcut = "C:\\ProgramData\\Start Menu\\Programs\\Codex.lnk";
  const shellTarget = "shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App";

  const result = await locate({
    shortcutCandidates: [shortcut],
    exists: (candidate) => candidate === shortcut,
    resolveShortcut: async () => ({
      targetPath: "C:\\Windows\\explorer.exe",
      arguments: shellTarget,
    }),
  });

  assert.deepEqual(result, {
    found: true,
    launchTarget: shellTarget,
    kind: "shell_app",
    source: "shortcut",
  });
});

test("continues to shortcuts when an explicit WindowsApps candidate is access-restricted", async () => {
  const windowsAppsTarget = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0\\Codex.exe";
  const shortcut = "C:\\Users\\tester\\Desktop\\Codex.lnk";
  const shortcutTarget = "C:\\Users\\tester\\Apps\\Codex.exe";
  const checked = [];

  const result = await locate({
    commonCandidates: [windowsAppsTarget],
    shortcutCandidates: [shortcut],
    exists: (candidate) => {
      checked.push(candidate);
      if (candidate === windowsAppsTarget) {
        const error = new Error("access denied");
        error.code = "EACCES";
        throw error;
      }
      return candidate === shortcut || candidate === shortcutTarget;
    },
    resolveShortcut: async () => shortcutTarget,
  });

  assert.deepEqual(checked, [windowsAppsTarget, shortcut, shortcutTarget]);
  assert.deepEqual(result, {
    found: true,
    launchTarget: shortcutTarget,
    kind: "executable",
    source: "shortcut",
  });
});

test("uses shell app discovery before PATH discovery", async () => {
  const shellTarget = "shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App";
  const pathTarget = "C:\\Tools\\Codex.exe";
  let pathQueries = 0;

  const shellResult = await locate({
    shellAppCandidates: async () => [shellTarget],
    pathCandidates: async () => {
      pathQueries += 1;
      return [pathTarget];
    },
    exists: (candidate) => candidate === pathTarget,
  });
  assert.equal(pathQueries, 0);
  assert.deepEqual(shellResult, {
    found: true,
    launchTarget: shellTarget,
    kind: "shell_app",
    source: "shell_app",
  });

  const pathResult = await locate({
    shellAppCandidates: async () => [],
    pathCandidates: async () => [pathTarget],
    exists: (candidate) => candidate === pathTarget,
  });
  assert.deepEqual(pathResult, {
    found: true,
    launchTarget: pathTarget,
    kind: "executable",
    source: "path",
  });
});

test("classifies an injected macOS application bundle as a mac app", async () => {
  const appTarget = "/Applications/Codex.app";

  const result = await locate({
    platform: "darwin",
    preferredTargets: [appTarget],
    exists: (candidate) => candidate === appTarget,
  });

  assert.deepEqual(result, {
    found: true,
    launchTarget: appTarget,
    kind: "mac_app",
    source: "preferred",
  });
});

test("returns an existing shortcut itself when its target cannot be resolved", async () => {
  const shortcut = "C:\\Users\\tester\\Desktop\\Codex.lnk";

  const result = await locate({
    shortcutCandidates: [shortcut],
    exists: (candidate) => candidate === shortcut,
    resolveShortcut: async () => "",
  });

  assert.deepEqual(result, {
    found: true,
    launchTarget: shortcut,
    kind: "shortcut",
    source: "shortcut",
  });
});

test("reports not found cleanly when every injected discovery source is empty", async () => {
  const result = await locate({
    preferredTargets: ["C:\\Missing\\Preferred\\Codex.exe"],
    desktopOptions: { codexDesktopExe: "C:\\Missing\\Saved\\Codex.exe" },
    env: { CODEX_DESKTOP_EXE: "C:\\Missing\\Env\\Codex.exe" },
    commonCandidates: ["C:\\Missing\\Common\\Codex.exe"],
    shortcutCandidates: ["C:\\Missing\\Codex.lnk"],
    shellAppCandidates: async () => [],
    pathCandidates: async () => [],
    exists: () => false,
  });

  assert.deepEqual(result, {
    found: false,
    launchTarget: "",
    kind: null,
    source: null,
  });
});
