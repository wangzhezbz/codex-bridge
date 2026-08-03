"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const CHROME_EXTENSION_MANAGER_URL = "chrome://extensions/";
const SAFE_PROFILE_NAME = /^(Default|Guest Profile|System Profile|Profile \d+)$/;

function chromeExtensionManagerPlan({ profileName = "", env = process.env } = {}) {
  const normalizedProfile = String(profileName || "").trim();
  const launchArgs = [];
  if (SAFE_PROFILE_NAME.test(normalizedProfile)) {
    launchArgs.push(`--profile-directory=${normalizedProfile}`);
  }
  // Chrome ignores externally supplied chrome:// URLs in an already-running
  // desktop session. A dedicated local launcher gives the native helper one
  // unambiguous window to focus and leaves useful instructions if navigation
  // is blocked by Windows foreground protection.
  const launcherUrl = pathToFileURL(
    path.join(__dirname, "chrome-extension-launcher.html"),
  ).href;
  const navigationScriptPath = path.join(__dirname, "chrome-extension-manager.ps1");
  launchArgs.push("--new-window", launcherUrl);
  return {
    url: CHROME_EXTENSION_MANAGER_URL,
    urlCopied: true,
    launchArgs,
    navigationCommand: "powershell.exe",
    navigationArgs: [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      navigationScriptPath,
    ],
    navigationEnv: env && typeof env === "object" ? { ...env } : {},
  };
}

function parseChromeExtensionManagerResult(result) {
  try {
    const parsed = JSON.parse(String(result?.stdout || "").trim());
    if (result?.ok === true && parsed?.activated === true && parsed?.navigated === true) {
      return {
        activated: true,
        navigated: true,
        title: String(parsed.title || ""),
      };
    }
  } catch {
    // The caller reports one stable user-facing failure for malformed helper output.
  }
  throw new Error("Chrome extension manager navigation was not verified");
}

module.exports = {
  CHROME_EXTENSION_MANAGER_URL,
  chromeExtensionManagerPlan,
  parseChromeExtensionManagerResult,
};
