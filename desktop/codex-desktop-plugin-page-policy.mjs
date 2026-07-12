import fs from "node:fs";
import path from "node:path";
import { listPackage, extractFile } from "@electron/asar";
import { locateOpenAIDesktopSync } from "./codex-locator.mjs";

export function hiddenPluginNamesFromDesktopSelectorSource(source = "") {
  const hiddenPluginNames = new Set();
  for (const match of String(source || "").matchAll(/plugin\.name\s*!==\s*([`'"])([^`'"]+)\1/g)) {
    const name = String(match[2] || "").trim().toLowerCase();
    if (name) hiddenPluginNames.add(name);
  }
  return [...hiddenPluginNames].sort();
}

export function readCodexDesktopPluginPagePolicy({
  homeDir,
  desktopOptions = {},
  locateDesktop = locateOpenAIDesktopSync,
} = {}) {
  let located;
  try {
    located = locateDesktop({ homeDir, desktopOptions });
  } catch (error) {
    return unavailable("desktop_locator_failed", error?.message);
  }
  const launchTarget = String(located?.launchTarget || "").trim();
  if (!launchTarget || /^shell:/i.test(launchTarget)) {
    return unavailable("desktop_path_unavailable", "ChatGPT Desktop executable path is unavailable.");
  }
  const executableDir = path.dirname(launchTarget);
  const candidates = [
    path.join(executableDir, "resources", "app.asar"),
    path.join(executableDir, "app", "resources", "app.asar"),
    path.join(path.dirname(executableDir), "resources", "app.asar"),
  ];
  const asarPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!asarPath) {
    return unavailable("desktop_asar_missing", "ChatGPT Desktop app.asar is unavailable.", { launchTarget });
  }
  try {
    const selectorFiles = listPackage(asarPath)
      .map((entry) => String(entry || "").replace(/^\\/, ""))
      .filter((entry) => /(?:^|[\\/])plugins-page-selectors-[^\\/]+\.js$/i.test(entry));
    const hiddenPluginNames = new Set();
    for (const selectorFile of selectorFiles) {
      const source = extractFile(asarPath, selectorFile).toString("utf8");
      for (const name of hiddenPluginNamesFromDesktopSelectorSource(source)) hiddenPluginNames.add(name);
    }
    if (selectorFiles.length === 0) {
      return unavailable("desktop_selector_missing", "ChatGPT Desktop plugin-page selector was not found.", {
        launchTarget,
        asarPath,
      });
    }
    return {
      ok: true,
      source: "chatgpt-desktop-renderer",
      launchTarget,
      asarPath,
      selectorFiles,
      hiddenPluginNames: [...hiddenPluginNames].sort(),
      readAt: new Date().toISOString(),
    };
  } catch (error) {
    return unavailable("desktop_selector_read_failed", error?.message, { launchTarget, asarPath });
  }
}

function unavailable(code, error, extra = {}) {
  return {
    ok: false,
    source: "chatgpt-desktop-renderer",
    code,
    error: String(error || code),
    hiddenPluginNames: [],
    ...extra,
  };
}
