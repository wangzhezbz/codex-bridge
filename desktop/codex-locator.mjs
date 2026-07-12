import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const NOT_FOUND = Object.freeze({
  found: false,
  launchTarget: "",
  kind: null,
  source: null,
});

const CLI_NOT_FOUND = Object.freeze({
  found: false,
  cliTarget: "",
  desktopTarget: "",
  source: null,
  kind: null,
});

const OFFICIAL_OPENAI_DESKTOP_PUBLISHER_IDS = new Set(["2p2nqsd0c76g0"]);

export function locateOpenAIDesktopSync(options = {}) {
  const platform = options?.platform || process.platform;
  const result = locateCodexCliSync({
    ...options,
    platform,
    desktopOnly: true,
  });
  const launchTarget = String(result?.desktopTarget || "").trim();
  if (!isSupportedDesktopLaunchTarget(launchTarget, platform)) {
    return { ...NOT_FOUND };
  }
  return {
    found: true,
    launchTarget,
    kind: result.kind,
    source: result.source,
  };
}

export function locateCodexCliSync({
  platform = process.platform,
  desktopOptions = {},
  env = process.env,
  homeDir = os.homedir(),
  codexCliPath = "",
  explicitCliTargets = [],
  preferredTargets = [],
  commonCandidates,
  restrictedCandidates,
  shortcutCandidates,
  shellAppCandidates,
  pathCandidates,
  resolveShortcut,
  resolveStoreInstall,
  exists = fs.existsSync,
  readDir = fs.readdirSync,
  execFile = execFileSync,
  now = Date.now,
  maxShortcutCandidates = 24,
  maxOperations = 128,
  maxDurationMs = 12000,
  desktopOnly = false,
} = {}) {
  const budget = createLocatorBudget({ now, maxOperations, maxDurationMs });
  const locatorPath = pathForPlatform(platform);
  const shortcutCandidateLimit = boundedCount(maxShortcutCandidates, 24);
  const explicitEntries = candidateEntries([
    { target: codexCliPath, source: "explicit_cli" },
    { target: desktopOptions?.codexCliPath, source: "saved_cli" },
    { target: envValue(env, "CODEX_CLI_PATH"), source: "env_cli" },
    ...asCandidateList(explicitCliTargets),
  ], "explicit_cli");
  if (!desktopOnly) {
    const explicit = firstExistingCli(explicitEntries, exists, { platform, locatorPath, budget });
    if (explicit) {
      return explicit;
    }
  }

  const shortcutResolver = typeof resolveShortcut === "function"
    ? resolveShortcut
    : (target) => resolveWindowsShortcutSync(
      target,
      execFile,
      budget.remainingTimeout(4000),
    );
  const storeResolver = typeof resolveStoreInstall === "function"
    ? resolveStoreInstall
    : (shellTarget) => resolveWindowsStoreInstallSync(
      shellTarget,
      execFile,
      budget.remainingTimeout(4000),
    );
  let desktopFallback = null;
  const rememberDesktop = (result) => {
    if (!desktopFallback && result?.desktopTarget) {
      desktopFallback = result;
    }
  };
  const acceptDesktop = (result) => {
    if (!result) {
      return null;
    }
    if (desktopOnly) {
      return isSupportedDesktopLaunchTarget(result.desktopTarget, platform) ? result : null;
    }
    if (result.found) {
      return result;
    }
    rememberDesktop(result);
    return null;
  };

  const preferredEntries = candidateEntries(preferredTargets, "preferred");
  const savedEntries = candidateEntries([
    desktopOptions?.codexDesktopLaunchTarget,
    desktopOptions?.codexDesktopExe,
  ], "saved");
  const envEntries = candidateEntries([
    envValue(env, "CHATGPT_DESKTOP_EXE"),
    envValue(env, "CODEX_DESKTOP_EXE"),
    envValue(env, "CHATGPT_DESKTOP_APP"),
    envValue(env, "CODEX_DESKTOP_APP"),
  ], "env");
  const earlyEntries = [...preferredEntries, ...savedEntries, ...envEntries];
  const earlyShortcuts = earlyEntries.filter((entry) => candidateKind(entry.target, platform) === "shortcut");
  const earlyDesktop = earlyEntries.filter((entry) => candidateKind(entry.target, platform) !== "shortcut");
  const deferredRestricted = [];

  for (const entry of earlyDesktop) {
    if (isWindowsAppsPath(entry.target)) {
      deferredRestricted.push(entry);
      continue;
    }
    const result = acceptDesktop(locateCliFromDesktopEntry(entry, {
      platform,
      locatorPath,
      exists,
      storeResolver,
      budget,
    }));
    if (result) {
      return result;
    }
  }

  const generatedShortcuts = shortcutCandidates === undefined
    ? defaultWindowsShortcutCandidates({
      platform,
      env,
      homeDir,
      maxCandidates: shortcutCandidateLimit,
    })
    : loadSyncCandidates(shortcutCandidates);
  const shortcutEntries = [
    ...earlyShortcuts,
    ...candidateEntries(generatedShortcuts, "shortcut"),
  ].slice(0, shortcutCandidateLimit);
  for (const entry of shortcutEntries) {
    const result = acceptDesktop(locateCliFromShortcut(entry, {
      platform,
      locatorPath,
      exists,
      shortcutResolver,
      storeResolver,
      budget,
    }));
    if (result) {
      return result;
    }
  }

  if (shortcutCandidates === undefined) {
    const remainingShortcutCandidates = shortcutCandidateLimit - shortcutEntries.length;
    const attemptedShortcutTargets = new Set(
      shortcutEntries.map((entry) => entry.target.toLowerCase()),
    );
    const discoveredShortcuts = discoverWindowsShortcutCandidates({
      platform,
      env,
      homeDir,
      readDir,
      budget,
      maxCandidates: remainingShortcutCandidates,
      excludedTargets: attemptedShortcutTargets,
    });
    for (const entry of candidateEntries(discoveredShortcuts, "shortcut")) {
      const result = acceptDesktop(locateCliFromShortcut(entry, {
        platform,
        locatorPath,
        exists,
        shortcutResolver,
        storeResolver,
        budget,
      }));
      if (result) {
        return result;
      }
    }
  }

  const generatedCommon = commonCandidates === undefined
    ? defaultCommonDesktopCandidates({ platform, env, homeDir })
    : loadSyncCandidates(commonCandidates);
  for (const entry of candidateEntries(generatedCommon, "common")) {
    if (isWindowsAppsPath(entry.target)) {
      deferredRestricted.push(entry);
      continue;
    }
    const result = acceptDesktop(locateCliFromDesktopEntry(entry, {
      platform,
      locatorPath,
      exists,
      storeResolver,
      budget,
    }));
    if (result) {
      return result;
    }
  }

  const generatedShellApps = shellAppCandidates === undefined
    ? (
      platform === "win32" && budget.take()
        ? defaultWindowsShellAppCandidates({
          platform,
          execFile,
          timeout: budget.remainingTimeout(4000),
        })
        : []
    )
    : loadSyncCandidates(shellAppCandidates);
  for (const entry of candidateEntries(generatedShellApps, "shell_app")) {
    const result = acceptDesktop(locateCliFromDesktopEntry(entry, {
      platform,
      locatorPath,
      exists,
      storeResolver,
      budget,
    }));
    if (result) {
      return result;
    }
  }

  const generatedRestricted = restrictedCandidates === undefined
    ? defaultRestrictedWindowsCandidates({ platform, env, homeDir })
    : loadSyncCandidates(restrictedCandidates);
  deferredRestricted.push(...candidateEntries(generatedRestricted, "windows_apps"));
  for (const entry of deferredRestricted) {
    const result = acceptDesktop(locateCliFromDesktopEntry(entry, {
      platform,
      locatorPath,
      exists,
      storeResolver,
      budget,
    }));
    if (result) {
      return result;
    }
  }

  if (desktopOnly) {
    return { ...CLI_NOT_FOUND };
  }

  const injectedPathCandidates = pathCandidates === undefined
    ? null
    : loadSyncCandidates(pathCandidates);
  const environmentPathCandidates = injectedPathCandidates === null
    ? defaultEnvironmentPathCliCandidates({ platform, env })
    : injectedPathCandidates;
  let pathResult = firstExistingCli(
    candidateEntries(environmentPathCandidates, "path"),
    exists,
    { platform, locatorPath, budget },
  );
  if (pathResult) {
    return pathResult;
  }

  if (injectedPathCandidates === null && budget.take()) {
    pathResult = firstExistingCli(
      candidateEntries(defaultPathCliCandidates({
        platform,
        execFile,
        timeout: budget.remainingTimeout(3000),
      }), "path"),
      exists,
      { platform, locatorPath, budget },
    );
    if (pathResult) {
      return pathResult;
    }
  }

  if (platform !== "win32") {
    return {
      found: true,
      cliTarget: "codex",
      desktopTarget: "",
      source: "path_literal",
      kind: "cli",
    };
  }

  return desktopFallback || { ...CLI_NOT_FOUND };
}

function pathForPlatform(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function boundedCount(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function createLocatorBudget({ now, maxOperations, maxDurationMs }) {
  const clock = typeof now === "function" ? now : Date.now;
  const operationLimit = boundedCount(maxOperations, 128);
  const durationLimit = boundedCount(maxDurationMs, 12000);
  const readTime = () => {
    try {
      const value = Number(clock());
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  };
  const startedAt = readTime();
  let operations = 0;
  const elapsed = () => Math.max(0, readTime() - startedAt);
  const available = () => operations < operationLimit && elapsed() < durationLimit;

  return {
    available,
    take() {
      if (!available()) {
        return false;
      }
      operations += 1;
      return true;
    },
    remainingTimeout(cap) {
      const maximum = Math.max(1, boundedCount(cap, 1));
      return Math.max(1, Math.min(maximum, durationLimit - elapsed()));
    },
  };
}

function candidateEntries(candidates, fallbackSource) {
  return asCandidateList(candidates)
    .map((candidate) => normalizeCandidate(candidate, fallbackSource))
    .filter((candidate) => candidate.target);
}

function loadSyncCandidates(provider) {
  try {
    const value = typeof provider === "function" ? provider() : provider;
    if (value && typeof value.then === "function") {
      return [];
    }
    return asCandidateList(value);
  } catch {
    return [];
  }
}

function safeExistsSync(exists, target, budget) {
  if (budget && !budget.take()) {
    return false;
  }
  try {
    return Boolean(target && exists(target));
  } catch {
    return false;
  }
}

function firstExistingCli(entries, exists, { platform, locatorPath, budget } = {}) {
  for (const entry of entries) {
    if (!isUsableCliTarget(entry.target, platform, locatorPath)) {
      continue;
    }
    if (!safeExistsSync(exists, entry.target, budget)) {
      continue;
    }
    return {
      found: true,
      cliTarget: entry.target,
      desktopTarget: "",
      source: entry.source,
      kind: "cli",
    };
  }
  return null;
}

function locateCliFromDesktopEntry(entry, {
  platform,
  locatorPath,
  exists,
  storeResolver,
  budget,
}) {
  const target = String(entry?.target || "").trim();
  if (!isSupportedDesktopLaunchTarget(target, platform)) {
    return null;
  }
  if (/^shell:/i.test(target)) {
    const installLocation = budget.take()
      ? storeInstallLocation(storeResolver(target))
      : "";
    if (!installLocation) {
      return null;
    }
    const cliTarget = firstExistingTarget(
      cliCandidatesForInstallRoot(installLocation, locatorPath),
      exists,
      budget,
    );
    return cliLocationResult({
      cliTarget,
      desktopTarget: target,
      source: entry.source,
      kind: "shell_app",
    });
  }
  if (!safeExistsSync(exists, target, budget)) {
    return null;
  }
  const cliTarget = firstExistingTarget(
    cliCandidatesForDesktopTarget(target, locatorPath),
    exists,
    budget,
  );
  return cliLocationResult({
    cliTarget,
    desktopTarget: target,
    source: entry.source,
    kind: candidateKind(target, platform),
  });
}

function locateCliFromShortcut(entry, {
  platform,
  locatorPath,
  exists,
  shortcutResolver,
  storeResolver,
  budget,
}) {
  const shortcut = String(entry?.target || "").trim();
  if (
    !shortcut ||
    isExcludedDesktopIdentity(shortcut) ||
    !safeExistsSync(exists, shortcut, budget)
  ) {
    return null;
  }
  let resolution = null;
  if (budget.take()) {
    try {
      resolution = shortcutResolver(shortcut);
    } catch {
      resolution = null;
    }
  }
  if (resolution && typeof resolution.then === "function") {
    resolution = null;
  }
  const parsed = shortcutResolutionTarget(resolution);
  if (
    isExcludedDesktopIdentity(parsed.shellTarget) ||
    isExcludedDesktopIdentity(parsed.target)
  ) {
    return null;
  }
  const resolvedDesktopTarget = parsed.shellTarget || parsed.target;
  if (
    resolvedDesktopTarget &&
    !isSupportedDesktopLaunchTarget(resolvedDesktopTarget, platform)
  ) {
    return null;
  }
  if (
    parsed.target &&
    !parsed.shellTarget &&
    !safeExistsSync(exists, parsed.target, budget)
  ) {
    return null;
  }
  const desktopTarget = parsed.shellTarget || parsed.target || shortcut;
  const installLocation = parsed.installLocation || (
    parsed.shellTarget && budget.take()
      ? storeInstallLocation(storeResolver(parsed.shellTarget))
      : ""
  );
  if (parsed.shellTarget && !installLocation) {
    return null;
  }
  const directCliTargets = parsed.cliTargets;
  const derivedCliTargets = [
    ...cliCandidatesForInstallRoot(installLocation, locatorPath),
    ...(!parsed.shellTarget ? cliCandidatesForDesktopTarget(parsed.target, locatorPath) : []),
  ];
  const cliTarget = firstExistingTarget(
    [...directCliTargets, ...derivedCliTargets]
      .filter((target) => isUsableCliTarget(target, platform, locatorPath)),
    exists,
    budget,
  );
  return cliLocationResult({
    cliTarget,
    desktopTarget,
    source: entry.source || "shortcut",
    kind: candidateKind(desktopTarget, platform),
  });
}

function cliLocationResult({ cliTarget = "", desktopTarget = "", source = null, kind = null }) {
  return {
    found: Boolean(cliTarget),
    cliTarget,
    desktopTarget,
    source,
    kind,
  };
}

function firstExistingTarget(candidates, exists, budget) {
  for (const target of uniqueTargets(candidates)) {
    if (safeExistsSync(exists, target, budget)) {
      return target;
    }
  }
  return "";
}

function cliCandidatesForDesktopTarget(desktopTarget, locatorPath) {
  const target = String(desktopTarget || "").trim();
  if (!target || /^shell:/i.test(target)) {
    return [];
  }
  if (/\.app[\\/]?$/i.test(target)) {
    return uniqueTargets([
      locatorPath.join(target, "Contents", "Resources", "codex"),
      locatorPath.join(target, "Contents", "Resources", "app", "resources", "codex"),
    ]);
  }
  if (
    locatorPath.basename(target).toLowerCase() === "codex.exe" &&
    locatorPath.basename(locatorPath.dirname(target)).toLowerCase() === "resources"
  ) {
    return [target];
  }
  const desktopDir = locatorPath.dirname(target);
  const roots = [desktopDir];
  if (locatorPath.basename(desktopDir).toLowerCase() === "app") {
    roots.push(locatorPath.dirname(desktopDir));
  }
  return uniqueTargets(roots.flatMap((root) => cliCandidatesForInstallRoot(root, locatorPath)));
}

function cliCandidatesForInstallRoot(installRoot, locatorPath) {
  const root = String(installRoot || "").trim();
  if (!root) {
    return [];
  }
  return [
    locatorPath.join(root, "resources", "codex.exe"),
    locatorPath.join(root, "app", "resources", "codex.exe"),
  ];
}

function uniqueTargets(values) {
  const output = [];
  const seen = new Set();
  for (const value of asCandidateList(values).flat()) {
    const target = String(value || "").trim();
    const key = target.toLowerCase();
    if (!target || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(target);
  }
  return output;
}

function isExcludedDesktopIdentity(value) {
  const identity = String(value || "").trim();
  if (!identity) {
    return false;
  }
  const normalized = identity.replace(/[\\/]+$/, "");
  const segments = /^shell:/i.test(normalized)
    ? [normalized.split("!")[0].split(/[\\/]/).at(-1)]
    : normalized.split(/[\\/]/).slice(-2);
  return segments.some((segment) => (
    /codex[\s._-]*bridge/i.test(segment) || /chatgpt[\s._-]*classic/i.test(segment)
  ));
}

function isSupportedDesktopIdentity(value) {
  const identity = String(value || "").trim();
  return Boolean(
    identity &&
    !isExcludedDesktopIdentity(identity) &&
    /codex|chatgpt/i.test(identity)
  );
}

function isSupportedDesktopShortcutName(value) {
  const fileName = String(value || "").trim();
  return /\.lnk$/i.test(fileName) && isSupportedDesktopIdentity(fileName);
}

function isSupportedDesktopLaunchTarget(value, platform = process.platform) {
  const target = String(value || "").trim();
  if (!target || isExcludedDesktopIdentity(target)) {
    return false;
  }
  if (/^shell:/i.test(target)) {
    const match = target.match(
      /^shell:AppsFolder\\OpenAI\.(?:ChatGPT|Codex)(?:-Desktop)?_([^!\\]+)!/i,
    );
    return Boolean(match && OFFICIAL_OPENAI_DESKTOP_PUBLISHER_IDS.has(match[1].toLowerCase()));
  }
  const locatorPath = pathForPlatform(platform);
  const baseName = locatorPath.basename(target).toLowerCase();
  if (platform === "darwin") {
    return baseName === "chatgpt.app" || baseName === "codex.app";
  }
  return baseName === "chatgpt.exe" || baseName === "codex.exe";
}

function desktopIdentityPriority(value) {
  const identity = String(value || "");
  if (/chatgpt/i.test(identity)) {
    return 0;
  }
  if (/codex/i.test(identity)) {
    return 1;
  }
  return 2;
}

function compareDesktopIdentityPriority(left, right) {
  return desktopIdentityPriority(left) - desktopIdentityPriority(right);
}

function startAppIdFromLine(value) {
  const line = String(value || "").trim();
  if (!line) {
    return "";
  }
  let name = "";
  let appId = line;
  if (line.startsWith("{")) {
    try {
      const parsed = JSON.parse(line);
      name = String(parsed?.name ?? parsed?.Name ?? "").trim();
      appId = String(parsed?.appId ?? parsed?.AppID ?? parsed?.appID ?? "").trim();
    } catch {
      return "";
    }
  }
  if (
    !appId ||
    isExcludedDesktopIdentity(name) ||
    isExcludedDesktopIdentity(appId)
  ) {
    return "";
  }
  return isSupportedDesktopIdentity(name) || isSupportedDesktopIdentity(appId) ? appId : "";
}

function isWindowsAppsPath(target) {
  return /[\\/]WindowsApps[\\/]/i.test(String(target || ""));
}

function isUsableCliTarget(target, platform, locatorPath = pathForPlatform(platform)) {
  const executableName = locatorPath.basename(String(target || "")).toLowerCase();
  if (executableName === "chatgpt" || executableName === "chatgpt.exe") {
    return false;
  }
  if (isExcludedDesktopIdentity(target)) {
    return false;
  }
  if (platform !== "win32" || !isWindowsAppsPath(target)) {
    return true;
  }
  return locatorPath.basename(locatorPath.dirname(String(target || ""))).toLowerCase() === "resources";
}

function defaultWindowsShortcutCandidates({
  platform,
  env,
  homeDir,
  maxCandidates,
}) {
  if (platform !== "win32") {
    return [];
  }
  const locatorPath = path.win32;
  const roots = windowsLocatorRoots(env, homeDir);
  const searchRoots = [
    locatorPath.join(roots.appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    locatorPath.join(roots.programData, "Microsoft", "Windows", "Start Menu", "Programs"),
    locatorPath.join(roots.userProfile, "Desktop"),
    locatorPath.join(roots.publicProfile, "Desktop"),
  ].filter(Boolean);
  const candidateLimit = boundedCount(maxCandidates, 24);
  const names = [
    "ChatGPT.lnk",
    "Codex.lnk",
    "ChatGPT Desktop.lnk",
    "Codex Desktop.lnk",
    "OpenAI ChatGPT.lnk",
    "OpenAI Codex.lnk",
  ];
  const primaryNames = ["ChatGPT.lnk", "Codex.lnk"];
  const fixedCandidates = [
    ...searchRoots.slice(0, 2).flatMap((root) => names.map((name) => locatorPath.join(root, name))),
    ...searchRoots.slice(2).flatMap((root) => primaryNames.map((name) => locatorPath.join(root, name))),
  ];
  return uniqueTargets(
    fixedCandidates,
  ).slice(0, candidateLimit);
}

function discoverWindowsShortcutCandidates({
  platform,
  env,
  homeDir,
  readDir,
  budget,
  maxCandidates,
  excludedTargets,
}) {
  if (platform !== "win32") {
    return [];
  }
  const locatorPath = path.win32;
  const roots = windowsLocatorRoots(env, homeDir);
  const searchRoots = [
    locatorPath.join(roots.appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    locatorPath.join(roots.programData, "Microsoft", "Windows", "Start Menu", "Programs"),
    locatorPath.join(roots.userProfile, "Desktop"),
    locatorPath.join(roots.publicProfile, "Desktop"),
  ].filter(Boolean);
  const candidateLimit = boundedCount(maxCandidates, 0);
  const discovered = [];
  for (const root of searchRoots) {
    const remaining = candidateLimit - discovered.length;
    if (remaining <= 0) {
      break;
    }
    discovered.push(...findCodexShortcutsSync(
      root,
      locatorPath,
      readDir,
      3,
      budget,
      remaining,
      excludedTargets,
    ));
  }
  return uniqueTargets(discovered)
    .sort(compareDesktopIdentityPriority)
    .slice(0, candidateLimit);
}

function findCodexShortcutsSync(
  root,
  locatorPath,
  readDir,
  maxDepth,
  budget,
  maxResults,
  excludedTargets,
) {
  if (!root || isWindowsAppsPath(root)) {
    return [];
  }
  const found = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && found.length < maxResults) {
    if (budget && !budget.take()) {
      break;
    }
    const current = stack.pop();
    let entries;
    try {
      entries = readDir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const orderedEntries = (Array.isArray(entries) ? [...entries] : [])
      .sort((left, right) => compareDesktopIdentityPriority(left?.name, right?.name));
    for (const entry of orderedEntries) {
      const entryPath = locatorPath.join(current.dir, entry.name);
      if (entry.isDirectory?.() && current.depth < maxDepth && !isWindowsAppsPath(entryPath)) {
        stack.push({ dir: entryPath, depth: current.depth + 1 });
        continue;
      }
      if (
        entry.isFile?.() &&
        isSupportedDesktopShortcutName(entry.name)
      ) {
        if (excludedTargets?.has(entryPath.toLowerCase())) {
          continue;
        }
        found.push(entryPath);
        if (found.length >= maxResults) {
          break;
        }
      }
    }
  }
  return found;
}

function defaultCommonDesktopCandidates({ platform, env, homeDir }) {
  if (platform === "darwin") {
    return [
      "/Applications/ChatGPT.app",
      path.posix.join(homeDir, "Applications", "ChatGPT.app"),
      "/Applications/Codex.app",
      path.posix.join(homeDir, "Applications", "Codex.app"),
    ];
  }
  if (platform !== "win32") {
    return [];
  }
  const p = path.win32;
  const roots = windowsLocatorRoots(env, homeDir);
  return uniqueTargets([
    p.join(roots.localAppData, "OpenAI", "ChatGPT", "ChatGPT.exe"),
    p.join(roots.localAppData, "OpenAI", "ChatGPT", "app", "ChatGPT.exe"),
    p.join(roots.localAppData, "Programs", "ChatGPT", "ChatGPT.exe"),
    p.join(roots.localAppData, "Programs", "ChatGPT", "app", "ChatGPT.exe"),
    p.join(roots.localAppData, "Programs", "ChatGPT Desktop", "ChatGPT.exe"),
    p.join(roots.localAppData, "Programs", "OpenAI ChatGPT", "ChatGPT.exe"),
    p.join(roots.localAppData, "ChatGPT", "ChatGPT.exe"),
    p.join(roots.programFiles, "ChatGPT", "ChatGPT.exe"),
    p.join(roots.programFiles, "OpenAI ChatGPT", "ChatGPT.exe"),
    p.join(roots.programFiles, "OpenAI", "ChatGPT", "ChatGPT.exe"),
    p.join(roots.programFilesX86, "ChatGPT", "ChatGPT.exe"),
    p.join(roots.programFilesX86, "OpenAI ChatGPT", "ChatGPT.exe"),
    p.join(roots.localAppData, "OpenAI", "Codex", "Codex.exe"),
    p.join(roots.localAppData, "OpenAI", "Codex", "app", "Codex.exe"),
    p.join(roots.localAppData, "Programs", "Codex", "Codex.exe"),
    p.join(roots.localAppData, "Programs", "Codex", "app", "Codex.exe"),
    p.join(roots.localAppData, "Programs", "Codex Desktop", "Codex.exe"),
    p.join(roots.localAppData, "Programs", "OpenAI Codex", "Codex.exe"),
    p.join(roots.localAppData, "Codex", "Codex.exe"),
    p.join(roots.programFiles, "Codex", "Codex.exe"),
    p.join(roots.programFiles, "OpenAI Codex", "Codex.exe"),
    p.join(roots.programFiles, "OpenAI", "Codex", "Codex.exe"),
    p.join(roots.programFilesX86, "Codex", "Codex.exe"),
    p.join(roots.programFilesX86, "OpenAI Codex", "Codex.exe"),
  ]);
}

function defaultRestrictedWindowsCandidates({ platform, env, homeDir }) {
  if (platform !== "win32") {
    return [];
  }
  const roots = windowsLocatorRoots(env, homeDir);
  return [
    path.win32.join(roots.localAppData, "Microsoft", "WindowsApps", "ChatGPT.exe"),
    path.win32.join(roots.localAppData, "Microsoft", "WindowsApps", "Codex.exe"),
  ];
}

function windowsLocatorRoots(env, homeDir) {
  const p = path.win32;
  const userProfile = envValue(env, "USERPROFILE") || String(homeDir || "").trim() || os.homedir();
  const driveRoot = p.parse(userProfile).root || "C:\\";
  const systemDrive = envValue(env, "SystemDrive", "SYSTEMDRIVE") || driveRoot.replace(/[\\/]$/, "");
  return {
    userProfile,
    appData: envValue(env, "APPDATA") || p.join(userProfile, "AppData", "Roaming"),
    localAppData: envValue(env, "LOCALAPPDATA") || p.join(userProfile, "AppData", "Local"),
    programData: envValue(env, "ProgramData", "PROGRAMDATA") || p.join(systemDrive, "ProgramData"),
    publicProfile: envValue(env, "PUBLIC") || p.join(p.dirname(userProfile), "Public"),
    programFiles: envValue(env, "ProgramFiles", "PROGRAMFILES") || p.join(driveRoot, "Program Files"),
    programFilesX86: envValue(env, "ProgramFiles(x86)", "PROGRAMFILES(X86)") || p.join(driveRoot, "Program Files (x86)"),
  };
}

function defaultWindowsShellAppCandidates({ platform, execFile, timeout = 4000 }) {
  if (platform !== "win32") {
    return [];
  }
  try {
    const output = execFile("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; $blocked='(?i)Codex[\\s._-]*Bridge|ChatGPT[\\s._-]*Classic'; Get-StartApps | Where-Object { (($_.Name -match '(?i)Codex|ChatGPT') -or ($_.AppID -match '(?i)Codex|ChatGPT')) -and ($_.Name -notmatch $blocked) -and ($_.AppID -notmatch $blocked) } | ForEach-Object { @{ name=[string]$_.Name; appId=[string]$_.AppID } | ConvertTo-Json -Compress }",
    ], { encoding: "utf8", windowsHide: true, timeout });
    return String(output || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .map(startAppIdFromLine)
      .filter(Boolean)
      .sort(compareDesktopIdentityPriority)
      .map((appId) => `shell:AppsFolder\\${appId}`);
  } catch {
    return [];
  }
}

function defaultEnvironmentPathCliCandidates({ platform, env }) {
  const locatorPath = pathForPlatform(platform);
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const delimiter = platform === "win32" ? ";" : ":";
  return uniqueTargets(
    envValue(env, "PATH")
      .split(delimiter)
      .map((directory) => directory.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"))
      .filter(Boolean)
      .map((directory) => locatorPath.join(directory, executableName)),
  );
}

function defaultPathCliCandidates({ platform, execFile, timeout = 3000 }) {
  const command = platform === "win32" ? "where.exe" : "which";
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const locatorPath = pathForPlatform(platform);
  try {
    const output = execFile(command, [executableName], {
      encoding: "utf8",
      windowsHide: true,
      timeout,
    });
    return String(output || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => locatorPath.basename(line).toLowerCase() === executableName);
  } catch {
    return [];
  }
}

function resolveWindowsShortcutSync(shortcutPath, execFile, timeout = 4000) {
  try {
    const output = execFile("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$shortcutPath=[Environment]::GetEnvironmentVariable('CODEXBRIDGE_SHORTCUT_PATH'); if ([string]::IsNullOrWhiteSpace($shortcutPath)) { exit 2 }; $s=(New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath); [Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; @{ targetPath=$s.TargetPath; arguments=$s.Arguments } | ConvertTo-Json -Compress",
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout,
      env: {
        ...process.env,
        CODEXBRIDGE_SHORTCUT_PATH: String(shortcutPath || ""),
      },
    });
    return JSON.parse(String(output || "null"));
  } catch {
    return null;
  }
}

function resolveWindowsStoreInstallSync(shellTarget, execFile, timeout = 4000) {
  const appId = String(shellTarget || "").replace(/^shell:AppsFolder\\/i, "").trim();
  const packageFamily = appId.split("!")[0] || "";
  if (!packageFamily) {
    return "";
  }
  try {
    const output = execFile("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$packageFamily=[Environment]::GetEnvironmentVariable('CODEXBRIDGE_PACKAGE_FAMILY'); if ([string]::IsNullOrWhiteSpace($packageFamily)) { exit 2 }; $p=Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq $packageFamily } | Select-Object -First 1; if ($p) { $p.InstallLocation }",
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout,
      env: {
        ...process.env,
        CODEXBRIDGE_PACKAGE_FAMILY: packageFamily,
      },
    });
    return String(output || "").trim().split(/\r?\n/)[0] || "";
  } catch {
    return "";
  }
}

function storeInstallLocation(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  return String(
    value.installLocation ?? value.packageInstallLocation ?? value.path ?? "",
  ).trim();
}

function asCandidateList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return value == null ? [] : [value];
}

function normalizeCandidate(candidate, fallbackSource) {
  if (candidate && typeof candidate === "object") {
    const target = candidate.target ?? candidate.launchTarget ?? "";
    return {
      target: String(target || "").trim(),
      source: String(candidate.source || fallbackSource),
    };
  }
  return {
    target: String(candidate || "").trim(),
    source: fallbackSource,
  };
}

function candidateKind(target, platform) {
  if (/^shell:/i.test(target)) {
    return "shell_app";
  }
  if (/\.lnk$/i.test(target)) {
    return "shortcut";
  }
  if (platform === "darwin" && /\.app[\\/]?$/i.test(target)) {
    return "mac_app";
  }
  return "executable";
}

async function safeExists(exists, target) {
  try {
    return Boolean(await exists(target));
  } catch {
    return false;
  }
}

async function resultForCandidate(candidate, source, platform, exists) {
  const normalized = normalizeCandidate(candidate, source);
  if (!normalized.target || isExcludedDesktopIdentity(normalized.target)) {
    return null;
  }
  const kind = candidateKind(normalized.target, platform);
  if (kind !== "shell_app" && !(await safeExists(exists, normalized.target))) {
    return null;
  }
  return {
    found: true,
    launchTarget: normalized.target,
    kind,
    source: normalized.source,
  };
}

async function firstLocated(candidates, source, platform, exists) {
  for (const candidate of asCandidateList(candidates)) {
    const result = await resultForCandidate(candidate, source, platform, exists);
    if (result) {
      return result;
    }
  }
  return null;
}

function envValue(env, key) {
  if (!env || typeof env !== "object") {
    return "";
  }
  if (env[key] != null) {
    return String(env[key]).trim();
  }
  const match = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return match ? String(env[match] || "").trim() : "";
}

async function loadInjectedCandidates(provider) {
  try {
    const value = typeof provider === "function" ? await provider() : provider;
    return asCandidateList(value);
  } catch {
    return [];
  }
}

function shellTargetFromText(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const match = text.match(/shell:AppsFolder\\[^\s"']+/i);
  return match?.[0] || "";
}

function shortcutResolutionTarget(resolution) {
  if (typeof resolution === "string") {
    return {
      shellTarget: shellTargetFromText(resolution),
      target: resolution.trim(),
      installLocation: "",
      cliTargets: [],
    };
  }
  if (!resolution || typeof resolution !== "object") {
    return { shellTarget: "", target: "", installLocation: "", cliTargets: [] };
  }
  const target = String(
    resolution.target
      ?? resolution.launchTarget
      ?? resolution.targetPath
      ?? resolution.path
      ?? "",
  ).trim();
  const shellTarget = [
    resolution.arguments,
    resolution.args,
    resolution.appId,
    target,
  ].map(shellTargetFromText).find(Boolean) || "";
  const installLocation = String(
    resolution.installLocation
      ?? resolution.packageInstallLocation
      ?? resolution.installRoot
      ?? "",
  ).trim();
  const cliTargets = asCandidateList(
    resolution.cliTargets ?? resolution.cliTarget ?? resolution.codexCliPath ?? [],
  )
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return { shellTarget, target, installLocation, cliTargets };
}

async function locateShortcut(shortcutCandidate, platform, exists, resolveShortcut) {
  const normalized = normalizeCandidate(shortcutCandidate, "shortcut");
  if (
    !normalized.target ||
    isExcludedDesktopIdentity(normalized.target) ||
    !(await safeExists(exists, normalized.target))
  ) {
    return null;
  }

  if (typeof resolveShortcut === "function") {
    try {
      const resolution = shortcutResolutionTarget(await resolveShortcut(normalized.target));
      if (
        isExcludedDesktopIdentity(resolution.shellTarget) ||
        isExcludedDesktopIdentity(resolution.target)
      ) {
        return null;
      }
      if (resolution.shellTarget) {
        return {
          found: true,
          launchTarget: resolution.shellTarget,
          kind: "shell_app",
          source: normalized.source,
        };
      }
      const resolved = await resultForCandidate(
        resolution.target,
        normalized.source,
        platform,
        exists,
      );
      if (resolved) {
        return resolved;
      }
    } catch {
      // A valid shortcut remains launchable even when target inspection is unavailable.
    }
  }

  return {
    found: true,
    launchTarget: normalized.target,
    kind: "shortcut",
    source: normalized.source,
  };
}

export async function locateCodexInstall({
  platform = process.platform,
  desktopOptions = {},
  env = process.env,
  homeDir = os.homedir(),
  preferredTargets = [],
  commonCandidates = [],
  shortcutCandidates = [],
  resolveShortcut,
  shellAppCandidates,
  pathCandidates,
  exists = fs.existsSync,
} = {}) {
  // The async compatibility API stays injection-only; sync Task 6 discovery owns defaults.
  void homeDir;

  const orderedSources = [
    [preferredTargets, "preferred"],
    [
      [
        desktopOptions?.codexDesktopLaunchTarget,
        desktopOptions?.codexDesktopExe,
      ],
      "saved",
    ],
    [[
      envValue(env, "CHATGPT_DESKTOP_EXE"),
      envValue(env, "CODEX_DESKTOP_EXE"),
    ], "env"],
    [commonCandidates, "common"],
  ];

  for (const [candidates, source] of orderedSources) {
    const result = await firstLocated(candidates, source, platform, exists);
    if (result) {
      return result;
    }
  }

  if (platform === "win32") {
    for (const shortcutCandidate of asCandidateList(shortcutCandidates)) {
      const result = await locateShortcut(
        shortcutCandidate,
        platform,
        exists,
        resolveShortcut,
      );
      if (result) {
        return result;
      }
    }

    const shellCandidates = await loadInjectedCandidates(shellAppCandidates);
    const shellResult = await firstLocated(shellCandidates, "shell_app", platform, exists);
    if (shellResult) {
      return shellResult;
    }
  }

  const discoveredPaths = await loadInjectedCandidates(pathCandidates);
  const pathResult = await firstLocated(discoveredPaths, "path", platform, exists);
  return pathResult || { ...NOT_FOUND };
}
