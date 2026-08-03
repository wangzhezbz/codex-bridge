import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const {
  chromeExtensionManagerPlan,
  parseChromeExtensionManagerResult,
} = require("../desktop/chrome-extension-manager.cjs");

test("Chrome extension manager uses an address-bar navigation plan instead of a blocked chrome URL argument", () => {
  const plan = chromeExtensionManagerPlan({
    profileName: "Profile 2",
    env: { PATH: "fixture-path" },
  });

  assert.deepEqual(plan.launchArgs.slice(0, 2), [
    "--profile-directory=Profile 2",
    "--new-window",
  ]);
  assert.match(plan.launchArgs[2], /^file:\/\/\/.+chrome-extension-launcher\.html$/);
  assert.equal(plan.navigationCommand, "powershell.exe");
  assert.equal(plan.navigationArgs.includes("-File"), true);
  assert.match(plan.navigationArgs.at(-1), /chrome-extension-manager\.ps1$/);
  assert.equal(plan.navigationEnv.PATH, "fixture-path");
  assert.equal(plan.url, "chrome://extensions/");
  assert.equal(plan.urlCopied, true);
  assert.equal(plan.launchArgs.includes(plan.url), false);
});

test("Chrome extension manager ignores unsafe profile names", () => {
  const plan = chromeExtensionManagerPlan({ profileName: "Default & calc" });

  assert.equal(plan.launchArgs[0], "--new-window");
  assert.match(plan.launchArgs[1], /^file:\/\/\/.+chrome-extension-launcher\.html$/);
});

test("Chrome extension manager targets its dedicated launcher window instead of an ambiguous Chrome process", () => {
  const plan = chromeExtensionManagerPlan();
  const scriptPath = plan.navigationArgs.at(-1);

  assert.equal(existsSync(scriptPath), true);
  const script = readFileSync(scriptPath, "utf8");
  assert.match(script, /EnumWindows/);
  assert.match(script, /FindLauncherWindow/);
  assert.match(script, /ForceForeground/);
  assert.match(script, /GetForegroundWindow/);
  assert.match(script, /keybd_event/);
  assert.doesNotMatch(script, /WScript\.Shell|AppActivate/);
});

test("Chrome extension manager PowerShell helper parses on Windows", {
  skip: process.platform !== "win32",
}, () => {
  const scriptPath = chromeExtensionManagerPlan().navigationArgs.at(-1);
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:CODEXBRIDGE_CHROME_MANAGER_SCRIPT,[ref]$null,[ref]$errors); if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }",
  ], {
    env: {
      ...process.env,
      CODEXBRIDGE_CHROME_MANAGER_SCRIPT: scriptPath,
    },
    stdio: "pipe",
  });
});

test("Chrome extension manager only reports success after the native helper verifies navigation", () => {
  assert.deepEqual(parseChromeExtensionManagerResult({
    ok: true,
    stdout: '{"activated":true,"navigated":true,"title":"Extensions - Google Chrome"}',
  }), {
    activated: true,
    navigated: true,
    title: "Extensions - Google Chrome",
  });

  for (const result of [
    { ok: false, stdout: "" },
    { ok: true, stdout: "" },
    { ok: true, stdout: "not-json" },
    { ok: true, stdout: '{"activated":true,"navigated":false}' },
  ]) {
    assert.throws(
      () => parseChromeExtensionManagerResult(result),
      /Chrome extension manager navigation was not verified/,
    );
  }
});
