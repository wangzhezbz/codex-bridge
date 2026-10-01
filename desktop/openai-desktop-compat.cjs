const { spawn: nodeSpawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DESKTOP_APP_IMAGE_NAMES = Object.freeze(["ChatGPT.exe", "Codex.exe"]);
const OFFICIAL_OPENAI_DESKTOP_PUBLISHER_IDS = new Set(["2p2nqsd0c76g0"]);
const OFFICIAL_OPENAI_DESKTOP_WIN32_APP_IDS = new Set([
  "com.openai.codex",
  "com.openai.chatgpt",
]);
const DEFAULT_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const SOURCE_PRIORITY = Object.freeze({
  running: 0,
  saved: 1,
  env: 2,
  managed: 3,
  common: 3,
  shortcut: 4,
  shortcut_target: 5,
  shell: 6,
  restricted: 7,
  path: 8,
  discovered: 9,
});

function excludedOpenAIDesktopVariant(value) {
  const text = String(value || "");
  return (
    /codex[\s._\\/-]*bridge|chatgpt[\s._\\/-]*classic/i.test(text) ||
    /(?:^|[\\/])resources[\\/]codex\.exe(?:$|[\s"'])/i.test(text)
  );
}

function canonicalSavedOpenAIDesktopTarget(desktopOptions = {}) {
  return String(
    desktopOptions?.codexDesktopLaunchTarget || desktopOptions?.codexDesktopExe || "",
  ).trim();
}

function openAIDesktopBrand(value) {
  const target = String(value || "").trim();
  if (!target || excludedOpenAIDesktopVariant(target)) {
    return "";
  }
  const baseName = windowsBaseName(target).toLowerCase();
  if (baseName === "chatgpt.exe" || baseName === "chatgpt.lnk" || baseName === "chatgpt.app") {
    return "ChatGPT";
  }
  if (baseName === "codex.exe" || baseName === "codex.lnk" || baseName === "codex.app") {
    return "Codex";
  }
  if (/(?:^|[^a-z])chatgpt(?:[^a-z]|$)/i.test(target)) {
    return "ChatGPT";
  }
  if (/(?:^|[^a-z])codex(?:[^a-z]|$)/i.test(target)) {
    return "Codex";
  }
  return "";
}

function isOpenAIDesktopExecutablePath(value) {
  const target = String(value || "").trim();
  if (!target || excludedOpenAIDesktopVariant(target)) {
    return false;
  }
  return /^(?:chatgpt|codex)\.exe$/i.test(windowsBaseName(target));
}

function isOpenAIDesktopShortcutName(value) {
  const target = String(value || "").trim();
  return Boolean(
    target &&
    /\.lnk$/i.test(target) &&
    !excludedOpenAIDesktopVariant(target) &&
    openAIDesktopBrand(target),
  );
}

function isOpenAIDesktopShellTarget(value) {
  const target = String(value || "").trim();
  if (!/^shell:AppsFolder\\/i.test(target) || excludedOpenAIDesktopVariant(target)) {
    return false;
  }
  const appId = target.replace(/^shell:AppsFolder\\/i, "");
  if (OFFICIAL_OPENAI_DESKTOP_WIN32_APP_IDS.has(appId.toLowerCase())) {
    return true;
  }
  const match = appId.match(
    /^(?:OpenAI\.ChatGPT(?:-Desktop)?|OpenAI\.Codex(?:-Desktop)?)_([^!\\]+)!/i,
  );
  return Boolean(match && OFFICIAL_OPENAI_DESKTOP_PUBLISHER_IDS.has(match[1].toLowerCase()));
}

function isOpenAIDesktopLaunchTarget(value) {
  const target = String(value || "").trim();
  if (!target || excludedOpenAIDesktopVariant(target)) {
    return false;
  }
  if (isOpenAIDesktopShellTarget(target)) {
    return true;
  }
  if (/\.lnk$/i.test(target)) {
    return isOpenAIDesktopShortcutName(target);
  }
  if (/\.exe$/i.test(target)) {
    return isOpenAIDesktopExecutablePath(target);
  }
  return /^(?:chatgpt|codex)\.app$/i.test(windowsBaseName(target));
}

function openAIDesktopLaunchKind(value) {
  const target = String(value || "").trim();
  if (!isOpenAIDesktopLaunchTarget(target)) {
    return null;
  }
  if (isOpenAIDesktopShellTarget(target)) {
    return "shell";
  }
  if (isOpenAIDesktopShortcutName(target)) {
    return "shortcut";
  }
  if (isOpenAIDesktopExecutablePath(target)) {
    return "executable";
  }
  return "mac_app";
}

function classifyOpenAIDesktopProcess(input = {}) {
  const name = String(input.name || input.imageName || "").trim();
  const processId = Number(input.processId);
  const executablePath = String(input.executablePath || "").trim();
  const commandLine = String(input.commandLine || "").trim();
  const identity = [name, executablePath, commandLine].filter(Boolean).join("\n");
  const brand = processBrand({ name, executablePath });
  const base = {
    brand,
    processId,
    executablePath,
    commandLine,
  };

  if (excludedOpenAIDesktopVariant(identity)) {
    return {
      ...base,
      recognized: false,
      safeToStop: false,
      reason: "excluded_variant",
    };
  }
  if (!brand) {
    return {
      ...base,
      recognized: false,
      safeToStop: false,
      reason: "unsupported_process",
    };
  }
  if (!Number.isInteger(processId) || processId <= 0) {
    return {
      ...base,
      recognized: true,
      safeToStop: false,
      reason: "missing_pid",
    };
  }

  const imageName = brand === "ChatGPT" ? "ChatGPT.exe" : "Codex.exe";
  const verifiedPath = isAbsoluteExecutablePath(executablePath, imageName) ||
    commandLineHasAbsoluteExecutable(commandLine, imageName);
  return {
    ...base,
    recognized: true,
    safeToStop: verifiedPath,
    reason: verifiedPath ? "verified_path" : "ambiguous_name_only",
  };
}

function authorizeOpenAIDesktopProcesses(processes = [], trustedTargets = [], { exists = fs.existsSync } = {}) {
  const rows = Array.isArray(processes) ? processes : [];
  const normalizedTargets = (Array.isArray(trustedTargets) ? trustedTargets : [])
    .map((entry) => ({
      target: String(typeof entry === "string" ? entry : entry?.target || "").trim(),
      source: String(typeof entry === "string" ? "" : entry?.source || "").trim().toLowerCase(),
    }));
  const trustedPathsByBrand = new Map(["ChatGPT", "Codex"].map((brand) => [brand, new Set()]));
  for (const entry of normalizedTargets) {
    const brand = openAIDesktopBrand(entry.target);
    if (
      trustedPathsByBrand.has(brand) &&
      ["saved", "env", "managed", "common", "shortcut_target", "restricted"].includes(entry.source) &&
      isOpenAIDesktopExecutablePath(entry.target)
    ) {
      trustedPathsByBrand.get(brand).add(normalizedWindowsPath(entry.target));
    }
  }
  const trustedStoreIdentities = normalizedTargets
    .filter((entry) => ["saved", "shortcut", "shell"].includes(entry.source))
    .map((entry) => openAIDesktopStoreIdentityFromShellTarget(entry.target))
    .filter(Boolean);
  return rows.map((item) => {
    if (!item?.recognized || !item?.safeToStop || !trustedPathsByBrand.has(item.brand)) {
      return item;
    }
    const brandKey = item.brand.toLowerCase();
    const processPath = verifiedOpenAIDesktopProcessPath(item);
    const trustedPath = trustedPathsByBrand.get(item.brand).has(normalizedWindowsPath(processPath));
    const processStoreIdentity = openAIDesktopStoreIdentityFromExecutablePath(processPath);
    const trustedStorePath = processStoreIdentity && trustedStoreIdentities.some((identity) =>
      identity.brand === processStoreIdentity.brand &&
      identity.packageName === processStoreIdentity.packageName &&
      identity.publisherId === processStoreIdentity.publisherId,
    );
    const verifiedUnpackedRelease = item.brand === "ChatGPT" &&
      isVerifiedOpenAICodexReleaseExecutable(processPath, { exists });
    return trustedPath || trustedStorePath || verifiedUnpackedRelease
      ? verifiedUnpackedRelease && !trustedPath && !trustedStorePath
        ? { ...item, reason: "verified_openai_codex_release" }
        : item
      : { ...item, safeToStop: false, reason: `untrusted_${brandKey}_path` };
  });
}

function isVerifiedOpenAICodexReleaseExecutable(value, { exists = fs.existsSync } = {}) {
  const target = String(value || "").trim();
  if (!isOpenAIDesktopExecutablePath(target) || openAIDesktopBrand(target) !== "ChatGPT") {
    return false;
  }
  const appDir = path.win32.dirname(target);
  if (path.win32.basename(appDir).toLowerCase() !== "app") {
    return false;
  }
  const releasePath = appDir.replace(/\//g, "\\");
  if (!/\\OpenAI\.Codex_[^\\]+(?:\\OpenAI\.Codex_[^\\]+)?\\app$/i.test(releasePath)) {
    return false;
  }
  const requiredFiles = [
    target,
    path.win32.join(appDir, "resources", "codex.exe"),
    path.win32.join(appDir, "resources", "app.asar"),
  ];
  try {
    return requiredFiles.every((filePath) => exists(filePath));
  } catch {
    return false;
  }
}

function buildOpenAIDesktopRestartPlan(
  processes = [],
  candidateEntries = [],
  { isLaunchable = () => true } = {},
) {
  const authorizedProcesses = authorizeOpenAIDesktopProcesses(processes, candidateEntries);
  const launchEntries = prioritizeOpenAIDesktopCandidates([
    ...authorizedProcesses
      .filter((item) => item?.safeToStop && item?.executablePath)
      .map((item) => ({ target: item.executablePath, source: "running" })),
    ...(Array.isArray(candidateEntries) ? candidateEntries : []),
  ]);
  const launchTarget = selectOpenAIDesktopLaunchEntry(launchEntries, isLaunchable)?.target || "";
  const brand = openAIDesktopBrand(launchTarget);
  const processesToStop = brand
    ? authorizedProcesses.filter((item) => item?.recognized && item?.brand === brand)
    : [];
  return {
    launchTarget,
    brand,
    launchEntries,
    authorizedProcesses,
    processesToStop,
    blockedReasons: [...new Set(
      processesToStop.filter((item) => !item.safeToStop).map((item) => item.reason).filter(Boolean),
    )],
  };
}

function selectOpenAIDesktopLaunchEntry(entries = [], isLaunchable = () => true) {
  const candidates = Array.isArray(entries) ? entries : [];
  const attemptedTargets = new Set();
  for (const entry of candidates) {
    const storeIdentity = openAIDesktopStoreIdentityFromExecutablePath(entry?.target);
    const candidate = storeIdentity
      ? candidates.find((other) => {
          const shellIdentity = openAIDesktopStoreIdentityFromShellTarget(other?.target);
          return shellIdentity &&
            shellIdentity.brand === storeIdentity.brand &&
            shellIdentity.packageName === storeIdentity.packageName &&
            shellIdentity.publisherId === storeIdentity.publisherId;
        })
      : entry;
    if (!candidate) {
      continue;
    }
    const key = String(candidate.target || "").toLowerCase();
    if (!key || attemptedTargets.has(key)) {
      continue;
    }
    attemptedTargets.add(key);
    try {
      if (isLaunchable(candidate.target)) {
        return candidate;
      }
    } catch {
      // Try the next independently verified candidate.
    }
  }
  return null;
}

async function readManagedOpenAIDesktopCandidate(getService) {
  const snapshot = await (await getService()).getSnapshot();
  if (!snapshot?.enabled || snapshot.task || snapshot.pendingRecovery) return null;
  const installed = snapshot.components?.find(entry => entry.id === "chatgpt");
  if (!installed || !/^\d+(?:\.\d+){1,3}$/.test(installed.installedVersion || "")
    || !["current", "update-available"].includes(installed.updateState)) return null;
  const root = installed.installPath;
  if (typeof root !== "string" || !/^[A-Za-z]:\\/.test(root)
    || root.includes("/") || path.win32.normalize(root) !== root
    || path.win32.basename(root).toLowerCase() !== "c"
    || root.slice(3).split("\\").some(part => !part || /[<>:"|?*\u0000-\u001f]/.test(part) || /[ .]$/.test(part))) return null;
  const target = path.win32.join(root, "ChatGPT.exe");
  return isOpenAIDesktopExecutablePath(target) ? { target, source: "managed" } : null;
}

function prioritizeOpenAIDesktopCandidates(entries = []) {
  const normalized = (Array.isArray(entries) ? entries : [])
    .map((entry, index) => ({
      target: String(typeof entry === "string" ? entry : entry?.target || "").trim(),
      source: String(typeof entry === "string" ? "discovered" : entry?.source || "discovered").trim().toLowerCase(),
      index,
    }))
    .filter((entry) => isOpenAIDesktopLaunchTarget(entry.target))
    .sort((left, right) => {
      const explicitDelta = explicitSourcePriority(left.source) - explicitSourcePriority(right.source);
      if (explicitDelta) {
        return explicitDelta;
      }
      if (explicitSourcePriority(left.source) === 0) {
        const explicitSourceDelta = sourcePriority(left.source) - sourcePriority(right.source);
        if (explicitSourceDelta) {
          return explicitSourceDelta;
        }
      }
      const brandDelta = brandPriority(openAIDesktopBrand(left.target)) - brandPriority(openAIDesktopBrand(right.target));
      if (brandDelta) {
        return brandDelta;
      }
      const sourceDelta = sourcePriority(left.source) - sourcePriority(right.source);
      if (sourceDelta) {
        return sourceDelta;
      }
      return left.index - right.index;
    });
  const seen = new Set();
  const unique = [];
  for (const entry of normalized) {
    const key = entry.target.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({ target: entry.target, source: entry.source });
  }
  return unique;
}

function openAIDesktopTargetFromShortcutResolution(resolution = {}) {
  if (!resolution || typeof resolution !== "object") {
    return "";
  }
  const targetPath = String(
    resolution.targetPath ?? resolution.target ?? resolution.launchTarget ?? resolution.path ?? "",
  ).trim();
  const argumentsValue = String(resolution.arguments ?? resolution.args ?? "").trim();
  if (excludedOpenAIDesktopVariant(`${targetPath}\n${argumentsValue}`)) {
    return "";
  }
  const shellTarget = shellTargetFromText(argumentsValue) || shellTargetFromText(targetPath);
  if (isOpenAIDesktopShellTarget(shellTarget)) {
    return shellTarget;
  }
  return isOpenAIDesktopExecutablePath(targetPath) ? targetPath : "";
}

function validatedOpenAIDesktopTargetFromShortcutResolution(
  resolution = {},
  { exists = () => false, storeInstalled = false } = {},
) {
  const launchTarget = openAIDesktopTargetFromShortcutResolution(resolution);
  if (!launchTarget) {
    return launchTarget;
  }
  if (isOpenAIDesktopShellTarget(launchTarget)) {
    if (!openAIDesktopStorePackageFamily(launchTarget)) {
      return launchTarget;
    }
    return storeInstalled ? launchTarget : "";
  }
  try {
    return exists(launchTarget) ? launchTarget : "";
  } catch {
    return "";
  }
}

function openAIDesktopStorePackageFamily(value) {
  const target = String(value || "").trim();
  if (!isOpenAIDesktopShellTarget(target)) {
    return "";
  }
  return target.match(
    /^shell:AppsFolder\\((?:OpenAI\.ChatGPT(?:-Desktop)?|OpenAI\.Codex(?:-Desktop)?)_[^!\\]+)!/i,
  )?.[1] || "";
}

function macOpenAIDesktopCandidates(homeDir = "") {
  const normalizedHome = String(homeDir || "").trim().replace(/[\\/]+$/, "");
  return [
    { appName: "ChatGPT", appPath: "/Applications/ChatGPT.app" },
    ...(normalizedHome ? [{ appName: "ChatGPT", appPath: `${normalizedHome}/Applications/ChatGPT.app` }] : []),
    { appName: "Codex", appPath: "/Applications/Codex.app" },
    ...(normalizedHome ? [{ appName: "Codex", appPath: `${normalizedHome}/Applications/Codex.app` }] : []),
  ];
}

function selectMacOpenAIDesktopApp({
  homeDir = "",
  preferredTargets = [],
  exists = () => false,
} = {}) {
  const preferred = (Array.isArray(preferredTargets) ? preferredTargets : [preferredTargets])
    .map((entry) => {
      const appPath = String(typeof entry === "string" ? entry : entry?.appPath || entry?.target || "").trim();
      const appName = String(typeof entry === "string" ? openAIDesktopBrand(appPath) : entry?.appName || openAIDesktopBrand(appPath)).trim();
      return { appName, appPath };
    })
    .filter((candidate) =>
      /^(?:ChatGPT|Codex)$/.test(candidate.appName) &&
      isOpenAIDesktopLaunchTarget(candidate.appPath) &&
      openAIDesktopLaunchKind(candidate.appPath) === "mac_app",
    );
  const candidates = prioritizeMacOpenAIDesktopCandidates([
    ...preferred,
    ...macOpenAIDesktopCandidates(homeDir),
  ]);
  for (const candidate of candidates) {
    try {
      if (exists(candidate.appPath)) {
        return candidate;
      }
    } catch {
      // An unreadable candidate is not installed for locator purposes.
    }
  }
  return null;
}

function prioritizeMacOpenAIDesktopCandidates(candidates = []) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.appName}\n${normalizeMacAppPath(candidate.appPath)}`;
    if (!candidate.appName || !candidate.appPath || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isKnownMacOpenAIDesktopApp(candidate = {}, homeDir = "") {
  const appName = String(candidate.appName || "").trim();
  const appPath = normalizeMacAppPath(candidate.appPath);
  return Boolean(
    appName &&
    appPath &&
    macOpenAIDesktopCandidates(homeDir).some((known) =>
      known.appName === appName && normalizeMacAppPath(known.appPath) === appPath,
    )
  );
}

function macOpenAIDesktopCommandPlan(candidate = {}) {
  const appName = String(candidate.appName || "").trim();
  const appPath = String(candidate.appPath || "").trim();
  if (!/^(?:ChatGPT|Codex)$/.test(appName) || !isOpenAIDesktopLaunchTarget(appPath)) {
    return null;
  }
  return {
    quit: {
      command: "osascript",
      args: [
        "-e",
        `tell application "System Events" to set openAIDesktopIsRunning to exists process "${appName}"`,
        "-e",
        `if openAIDesktopIsRunning then tell application "${appName}" to quit`,
      ],
    },
    launch: {
      command: "open",
      args: [appPath],
    },
  };
}

function parseMacOpenAIDesktopProcesses(output = "") {
  const processes = [];
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || excludedOpenAIDesktopVariant(line)) {
      continue;
    }
    const match = line.match(
      /^(\d+)\s+(.+?\/(ChatGPT|Codex)\.app\/Contents\/MacOS\/\3)(?:\s+(.*))?$/,
    );
    if (!match) {
      continue;
    }
    const processId = Number(match[1]);
    const executablePath = match[2];
    const appName = match[3];
    const appPath = executablePath.slice(0, executablePath.indexOf("/Contents/MacOS/"));
    if (!Number.isInteger(processId) || processId <= 0 || !isOpenAIDesktopLaunchTarget(appPath)) {
      continue;
    }
    processes.push({
      appName,
      appPath,
      commandLine: [executablePath, match[4] || ""].filter(Boolean).join(" "),
      executablePath,
      processId,
      recognized: true,
      safeToStop: true,
    });
  }
  return processes;
}

function runCommandCaptureWithTimeout(command, args = [], options = {}) {
  const spawnImpl = typeof options.spawnImpl === "function" ? options.spawnImpl : nodeSpawn;
  const killProcessTree = options.killProcessTree === true && (options.platform || process.platform) === "win32";
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Math.max(1, Math.round(Number(options.timeoutMs)))
    : 5000;
  const configuredMaxOutputBytes = Number(options.maxOutputBytes);
  const maxOutputBytes = Math.min(
    Number.isSafeInteger(configuredMaxOutputBytes) && configuredMaxOutputBytes > 0
      ? configuredMaxOutputBytes
      : DEFAULT_COMMAND_OUTPUT_BYTES,
    MAX_COMMAND_OUTPUT_BYTES,
  );
  const spawnOptions = {
    windowsHide: options.windowsHide !== false,
    stdio: options.stdio || ["ignore", "pipe", "ignore"],
    ...(options.env ? { env: options.env } : {}),
  };

  return new Promise((resolve) => {
    let child;
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let settled = false;
    let aborting = false;
    let rootClosed = false;
    let completeTreeCleanup = () => {};
    let timer = null;
    const capturedStdout = () => Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
    const cleanup = () => {
      child?.stdout?.removeListener?.("data", onStdout);
      child?.removeListener?.("close", onClose);
      child?.removeListener?.("error", onError);
    };
    const guardLateChildError = () => {
      const ignoreLateError = () => {};
      const releaseLateErrorGuard = () => child?.removeListener?.("error", ignoreLateError);
      child?.once?.("error", ignoreLateError);
      child?.once?.("close", releaseLateErrorGuard);
    };
    const finish = (result, { guardLateError = false } = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      cleanup();
      if (guardLateError) guardLateChildError();
      resolve(result);
    };
    const killChild = () => {
      try {
        child?.kill?.("SIGKILL");
      } catch {
        // The timeout or output-limit result remains authoritative.
      }
    };
    const failAndStop = (result) => {
      if (settled || aborting) return;
      aborting = true;
      if (timer) clearTimeout(timer);
      if (!killProcessTree) {
        finish(result, { guardLateError: true });
        killChild();
        return;
      }
      const processId = child?.pid;
      if (!Number.isSafeInteger(processId) || processId <= 1 || rootClosed || child?.exitCode != null || child?.signalCode != null) {
        finish({ ...result, processId, terminationConfirmed: false }, { guardLateError: true });
        return;
      }
      let killer, treeStopped = false, cleanupFinished = false;
      const configuredCleanup = Number(options.terminationTimeoutMs);
      const cleanupMs = Number.isFinite(configuredCleanup) && configuredCleanup > 0 ? Math.min(5000, Math.max(1, Math.round(configuredCleanup))) : 5000;
      const finishCleanup = (confirmed) => {
        if (cleanupFinished) return;
        cleanupFinished = true;
        clearTimeout(cleanupTimer);
        if (!confirmed) killChild();
        finish({ ...result, processId, terminationConfirmed: confirmed }, { guardLateError: true });
      };
      completeTreeCleanup = () => { if (treeStopped && rootClosed) finishCleanup(true); };
      const cleanupTimer = setTimeout(() => {
        try { killer?.kill?.("SIGKILL"); } catch { /* The failed cleanup remains explicit. */ }
        finishCleanup(false);
      }, cleanupMs);
      try {
        const taskkill = path.win32.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "taskkill.exe");
        killer = spawnImpl(taskkill, ["/PID", String(processId), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => finishCleanup(false));
        killer.once("close", (code) => {
          if (code !== 0) { finishCleanup(false); return; }
          treeStopped = true;
          completeTreeCleanup();
        });
      } catch { finishCleanup(false); }
    };
    const onStdout = (chunk) => {
      if (settled || aborting) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxOutputBytes - stdoutBytes;
      if (bytes.length > remaining) {
        if (remaining > 0) {
          stdoutChunks.push(bytes.subarray(0, remaining));
          stdoutBytes += remaining;
        }
        failAndStop({
          ok: false,
          stdout: capturedStdout(),
          timedOut: false,
          outputTooLarge: true,
          exitCode: null,
        });
        return;
      }
      stdoutChunks.push(bytes);
      stdoutBytes += bytes.length;
    };
    const onClose = (code) => {
      rootClosed = true;
      if (aborting) { completeTreeCleanup(); return; }
      finish({ ok: code === 0, stdout: capturedStdout(), timedOut: false, exitCode: code });
    };
    const onError = () => {
      if (aborting) return;
      if (killProcessTree && Number.isSafeInteger(child?.pid) && child.pid > 1) {
        failAndStop({ ok: false, stdout: capturedStdout(), timedOut: false, exitCode: null });
        return;
      }
      finish({ ok: false, stdout: capturedStdout(), timedOut: false, exitCode: null });
    };

    try {
      child = spawnImpl(command, Array.isArray(args) ? args : [], spawnOptions);
    } catch {
      finish({ ok: false, stdout: "", timedOut: false, exitCode: null });
      return;
    }

    child.stdout?.on?.("data", onStdout);
    child.once?.("close", onClose);
    child.once?.("error", onError);
    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      failAndStop(
        { ok: false, stdout: capturedStdout(), timedOut: true, exitCode: null },
      );
    }, timeoutMs);
    timer.unref?.();
  });
}

function spawnDetachedWithConfirmation(
  command,
  args = [],
  options = {},
  {
    spawnImpl = nodeSpawn,
    timeoutMs = 5000,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, Array.isArray(args) ? args : [], options);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeoutFn(timer);
      child.removeListener?.("error", onError);
      child.removeListener?.("spawn", onSpawn);
    };
    const guardLateChildError = () => {
      const ignoreLateError = () => {};
      const releaseGuard = () => child.removeListener?.("error", ignoreLateError);
      child.once?.("error", ignoreLateError);
      child.once?.("close", releaseGuard);
    };
    const finish = (callback, value, { terminate = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminate) {
        guardLateChildError();
        try { child.kill?.(); } catch {}
      }
      callback(value);
    };
    const onError = (error) => finish(reject, error);
    const onSpawn = () => {
      try {
        child.unref?.();
        finish(resolve, { ok: true });
      } catch (error) {
        finish(reject, error, { terminate: true });
      }
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
    const deadlineMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, 30_000)
      : 5000;
    timer = setTimeoutFn(() => {
      const error = new Error(`Desktop application did not report startup within ${deadlineMs} ms.`);
      error.code = "desktop_launch_timeout";
      finish(reject, error, { terminate: true });
    }, deadlineMs);
    timer?.unref?.();
  });
}

function summarizeOpenAIDesktopStopResults(processIds = [], results = []) {
  const ids = Array.isArray(processIds) ? processIds : [];
  const commandResults = Array.isArray(results) ? results : [];
  const failedProcessIds = ids.filter((_processId, index) => commandResults[index]?.ok !== true);
  return {
    ok: failedProcessIds.length === 0,
    stopped: ids.length - failedProcessIds.length,
    skipped: failedProcessIds.length,
    failedProcessIds,
    reasons: failedProcessIds.length ? ["taskkill_failed"] : [],
  };
}

function windowsShortcutResolverInvocation(shortcutPath, env = process.env) {
  const target = String(shortcutPath || "").trim();
  return {
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$p=[Environment]::GetEnvironmentVariable('CODEXBRIDGE_SHORTCUT_PATH','Process'); if (-not $p) { exit 2 }; $s=(New-Object -ComObject WScript.Shell).CreateShortcut($p); [Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; @{ targetPath=$s.TargetPath; arguments=$s.Arguments } | ConvertTo-Json -Compress",
    ],
    env: {
      ...(env && typeof env === "object" ? env : {}),
      CODEXBRIDGE_SHORTCUT_PATH: target,
    },
  };
}

function processBrand({ name = "", executablePath = "" } = {}) {
  const pathBase = windowsBaseName(executablePath);
  const nameBase = windowsBaseName(name);
  if (/^chatgpt\.exe$/i.test(pathBase) || /^chatgpt\.exe$/i.test(nameBase)) {
    return "ChatGPT";
  }
  if (/^codex\.exe$/i.test(pathBase) || /^codex\.exe$/i.test(nameBase)) {
    return "Codex";
  }
  return "";
}

function isAbsoluteExecutablePath(value, imageName) {
  const target = String(value || "").trim();
  return Boolean(
    target &&
    path.win32.isAbsolute(target) &&
    windowsBaseName(target).toLowerCase() === String(imageName || "").toLowerCase(),
  );
}

function commandLineHasAbsoluteExecutable(commandLine, imageName) {
  return isAbsoluteExecutablePath(commandLineExecutableToken(commandLine), imageName);
}

function commandLineExecutableToken(commandLine) {
  const text = String(commandLine || "").trim();
  if (!text) {
    return "";
  }
  if (text[0] === '"' || text[0] === "'") {
    const closing = text.indexOf(text[0], 1);
    return closing > 1 ? text.slice(1, closing) : "";
  }
  return text.match(/^\S+/)?.[0] || "";
}

function shellTargetFromText(value) {
  return String(value || "").match(/shell:AppsFolder\\[^\s"']+/i)?.[0] || "";
}

function windowsBaseName(value) {
  return path.win32.basename(String(value || "").replace(/\//g, "\\"));
}

function normalizeMacAppPath(value) {
  const target = String(value || "").trim();
  return target ? path.posix.normalize(target) : "";
}

function normalizedWindowsPath(value) {
  const target = String(value || "").trim();
  return target ? path.win32.normalize(target).toLowerCase() : "";
}

function verifiedOpenAIDesktopProcessPath(item = {}) {
  const imageName = item?.brand === "ChatGPT" ? "ChatGPT.exe" : item?.brand === "Codex" ? "Codex.exe" : "";
  if (!imageName) {
    return "";
  }
  if (isAbsoluteExecutablePath(item?.executablePath, imageName)) {
    return String(item.executablePath).trim();
  }
  const commandPath = commandLineExecutableToken(item?.commandLine);
  return isAbsoluteExecutablePath(commandPath, imageName) ? commandPath : "";
}

function openAIDesktopStoreIdentityFromShellTarget(value) {
  const target = String(value || "").trim();
  if (!isOpenAIDesktopShellTarget(target) || excludedOpenAIDesktopVariant(target)) {
    return null;
  }
  const match = target.match(
    /^shell:AppsFolder\\(OpenAI\.(?:ChatGPT|Codex)(?:-Desktop)?)_([^!\\]+)!/i,
  );
  return match
    ? {
        brand: openAIDesktopBrand(match[1]),
        packageName: match[1].toLowerCase(),
        publisherId: match[2].toLowerCase(),
      }
    : null;
}

function openAIDesktopStoreIdentityFromExecutablePath(value) {
  const target = String(value || "").trim();
  if (!target || excludedOpenAIDesktopVariant(target)) {
    return null;
  }
  const match = target.match(
    /\\WindowsApps\\(OpenAI\.(ChatGPT|Codex)(?:-Desktop)?)_[^\\]*__([^\\]+)\\(?:[^\\]+\\)*(ChatGPT|Codex)\.exe$/i,
  );
  if (!match || match[2].toLowerCase() !== match[4].toLowerCase()) {
    return null;
  }
  return {
    brand: match[2],
    packageName: match[1].toLowerCase(),
    publisherId: match[3].toLowerCase(),
  };
}

function sourcePriority(source) {
  return Object.prototype.hasOwnProperty.call(SOURCE_PRIORITY, source)
    ? SOURCE_PRIORITY[source]
    : SOURCE_PRIORITY.discovered;
}

function explicitSourcePriority(source) {
  return source === "saved" || source === "env" ? 0 : source === "managed" ? 1 : 2;
}

function brandPriority(brand) {
  return brand === "ChatGPT" ? 0 : brand === "Codex" ? 1 : 2;
}

async function recoverOpenAIProjectsSequentially(roots = [], {
  launchRoot,
  waitForRootActive = async () => true,
} = {}) {
  if (typeof launchRoot !== "function") {
    throw new Error("Project recovery requires a launchRoot function.");
  }
  const launchedRoots = [];
  for (const root of Array.isArray(roots) ? roots : []) {
    await launchRoot(root);
    launchedRoots.push(root);
    await waitForRootActive(root);
  }
  return {
    launched: launchedRoots.length,
    launchedRoots,
  };
}

module.exports = {
  DESKTOP_APP_IMAGE_NAMES,
  authorizeOpenAIDesktopProcesses,
  buildOpenAIDesktopRestartPlan,
  canonicalSavedOpenAIDesktopTarget,
  classifyOpenAIDesktopProcess,
  excludedOpenAIDesktopVariant,
  isOpenAIDesktopExecutablePath,
  isOpenAIDesktopLaunchTarget,
  isOpenAIDesktopShellTarget,
  isOpenAIDesktopShortcutName,
  isKnownMacOpenAIDesktopApp,
  macOpenAIDesktopCommandPlan,
  macOpenAIDesktopCandidates,
  parseMacOpenAIDesktopProcesses,
  openAIDesktopLaunchKind,
  openAIDesktopStorePackageFamily,
  openAIDesktopTargetFromShortcutResolution,
  openAIDesktopBrand,
  prioritizeOpenAIDesktopCandidates,
  readManagedOpenAIDesktopCandidate,
  recoverOpenAIProjectsSequentially,
  runCommandCaptureWithTimeout,
  selectMacOpenAIDesktopApp,
  spawnDetachedWithConfirmation,
  summarizeOpenAIDesktopStopResults,
  validatedOpenAIDesktopTargetFromShortcutResolution,
  windowsShortcutResolverInvocation,
};
