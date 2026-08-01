import fs from "node:fs/promises";
import fsSync from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fetchInitWithProxy, proxyLogLabel } from "../src/proxy.js";

export const GITHUB_LATEST_RELEASE_URL =
  "https://api.github.com/repos/wangzhezbz/codex-bridge/releases/latest";
export const GITHUB_LATEST_RELEASE_PAGE_URL =
  "https://github.com/wangzhezbz/codex-bridge/releases/latest";
export const GITHUB_LATEST_DOWNLOAD_BASE_URL =
  "https://github.com/wangzhezbz/codex-bridge/releases/latest/download";

const RELEASE_ASSETS = [
  {
    name: "CodexBridge-Windows-x64-Setup.exe",
    platform: "win32",
    arch: "x64",
    kind: "installer",
  },
  {
    name: "CodexBridge-Windows-x64-Portable.zip",
    platform: "win32",
    arch: "x64",
    kind: "portable",
  },
  {
    name: "CodexBridge-macOS-arm64-Portable.zip",
    platform: "darwin",
    arch: "arm64",
    kind: "portable",
  },
  {
    name: "CodexBridge-macOS-x64-Portable.zip",
    platform: "darwin",
    arch: "x64",
    kind: "portable",
  },
];
const RELEASE_ASSET_NAMES = RELEASE_ASSETS.map((asset) => asset.name);

export function assetNameForPlatform(platform = process.platform, arch = process.arch, options = {}) {
  return assetCandidatesForPlatform(platform, arch, options)[0]?.name || null;
}

export function inferUpdateInstallKind({
  forcedInstallKind = "",
  appIsPackaged = false,
  platform = process.platform,
  execPath = process.execPath,
  localAppData = process.env.LOCALAPPDATA || "",
  registryRoot = "",
  portableMarkerFound = false,
} = {}) {
  const forced = String(forcedInstallKind || "").toLowerCase();
  if (forced === "installed" || forced === "portable") {
    return forced;
  }
  if (!appIsPackaged || platform !== "win32") {
    return "portable";
  }

  const appDir = path.dirname(path.resolve(String(execPath || "")));
  if (isVersionedInstalledAppDir(appDir)) {
    return "installed";
  }
  if (registryRoot && isPathInsideOrEqual(appDir, registryRoot)) {
    return "installed";
  }
  if (localAppData) {
    const installedRoot = path.resolve(localAppData, "Programs", "CodexBridge");
    if (isPathInsideOrEqual(appDir, installedRoot)) {
      return "installed";
    }
  }
  if (portableMarkerFound || isWindowsPortableReleaseLayout(appDir)) {
    return "portable";
  }

  return "installed";
}

function isVersionedInstalledAppDir(appDir) {
  return /^app-/i.test(path.basename(path.resolve(String(appDir || ""))));
}

function isWindowsPortableReleaseLayout(appDir) {
  const resolved = path.resolve(String(appDir || ""));
  const folder = path.basename(resolved);
  const parent = path.basename(path.dirname(resolved));
  return /^CodexBridge-win32-x64$/i.test(folder) && /^CodexBridge-Windows-x64-Portable(?:-|$)/i.test(parent);
}

function assetCandidatesForPlatform(platform = process.platform, arch = process.arch, options = {}) {
  const candidates = RELEASE_ASSETS.filter((asset) => asset.platform === platform && asset.arch === arch);
  if (platform === "win32" && options.installKind === "portable") {
    return [...candidates].sort((left, right) => {
      if (left.kind === right.kind) {
        return 0;
      }
      return left.kind === "portable" ? -1 : 1;
    });
  }
  return candidates;
}

export function isNewerVersion(latestTag, currentVersion) {
  const latest = parseVersion(latestTag);
  const current = parseVersion(currentVersion);
  for (let index = 0; index < Math.max(latest.length, current.length); index += 1) {
    const left = latest[index] || 0;
    const right = current[index] || 0;
    if (left > right) {
      return true;
    }
    if (left < right) {
      return false;
    }
  }
  return false;
}

export function planReleaseUpdate({
  currentVersion,
  platform = process.platform,
  arch = process.arch,
  installKind = "installed",
  release,
} = {}) {
  const assetCandidates = assetCandidatesForPlatform(platform, arch, { installKind });
  const latestVersion = normalizeVersion(release?.tag_name || release?.name || "");
  if (!assetCandidates.length) {
    return {
      ok: false,
      updateAvailable: false,
      latestVersion,
      message: `当前系统暂不支持应用内更新：${platform} ${arch}`,
    };
  }
  if (!release || !latestVersion) {
    return {
      ok: false,
      updateAvailable: false,
      latestVersion,
      message: "没有读取到可用的 GitHub Release。",
    };
  }

  const releaseAssets = release.assets || [];
  const primaryCandidate = assetCandidates[0];
  const primaryAsset = releaseAssets.find((item) => item?.name === primaryCandidate?.name);
  if (platform === "win32" && installKind !== "portable" && primaryCandidate?.kind === "installer" && !primaryAsset?.browser_download_url) {
    return {
      ok: false,
      updateAvailable: false,
      latestVersion,
      releaseUrl: release.html_url || "",
      message:
        `Windows 安装版更新必须发布 ${primaryCandidate.name} 安装器；` +
        "本次 Release 缺少 Setup.exe，CodexBridge 不会自动下载 Portable.zip。请补发安装器后再更新。",
    };
  }
  const candidate = assetCandidates.find((assetInfo) =>
    releaseAssets.some((item) => item?.name === assetInfo.name && item?.browser_download_url),
  );
  const asset = releaseAssets.find((item) => item?.name === candidate?.name);
  if (!asset?.browser_download_url) {
    const expectedNames = assetCandidates.map((item) => item.name).join(", ");
    return {
      ok: false,
      updateAvailable: false,
      latestVersion,
      releaseUrl: release.html_url || "",
      message: `最新版本没有找到当前系统的更新包：${expectedNames}`,
    };
  }
  const updateAvailable = isNewerVersion(latestVersion, currentVersion);
  const assetSha256 = releaseAssetSha256(asset);
  if (updateAvailable && !assetSha256) {
    return {
      ok: false,
      updateAvailable: false,
      currentVersion: normalizeVersion(currentVersion),
      latestVersion,
      releaseUrl: release.html_url || "",
      message:
        `更新包 ${asset.name} 缺少可信的 GitHub SHA-256 digest；` +
        "CodexBridge 已阻止自动下载和安装。",
    };
  }

  const fallbackCandidate = candidate.kind === "installer"
    ? assetCandidates.find((assetInfo) =>
        assetInfo.kind === "portable" &&
        releaseAssets.some((item) => item?.name === assetInfo.name && item?.browser_download_url),
      )
    : null;
  const fallbackAsset = fallbackCandidate
    ? releaseAssets.find((item) => item?.name === fallbackCandidate.name)
    : null;
  const installMode = candidate.kind === "installer"
    ? "windows_setup"
    : platform === "win32" || platform === "darwin"
      ? "portable_replacement"
      : "manual_portable";
  return {
    ok: true,
    updateAvailable,
    currentVersion: normalizeVersion(currentVersion),
    latestVersion,
    releaseUrl: release.html_url || "",
    releaseNotes: release.body || "",
    installMode,
    asset: releaseAssetPayload(asset, candidate),
    fallbackAsset: fallbackAsset ? releaseAssetPayload(fallbackAsset, fallbackCandidate) : null,
    message: updateAvailable
      ? `发现新版本 ${latestVersion}。`
      : `当前已经是最新版本 ${normalizeVersion(currentVersion)}。`,
    nextStep: releaseUpdateNextStep(installMode),
  };
}

export function validateDownloadedReleaseAsset(filePath, asset = {}) {
  const resolved = path.resolve(String(filePath || ""));
  if (!resolved) {
    throw new Error("Downloaded release asset path is empty.");
  }
  const stat = fsSync.statSync(resolved);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Downloaded ${asset?.name || "release asset"} is empty or not a file.`);
  }
  const expectedSha256 = normalizeSha256(asset?.sha256);
  if (!expectedSha256) {
    throw new Error(
      `Downloaded ${asset?.name || "release asset"} is missing a trusted SHA-256 digest.`,
    );
  }
  const headerBuffer = Buffer.alloc(4);
  const fd = fsSync.openSync(resolved, "r");
  const hash = createHash("sha256");
  try {
    fsSync.readSync(fd, headerBuffer, 0, headerBuffer.length, 0);
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < stat.size) {
      const bytesRead = fsSync.readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, stat.size - position),
        position,
      );
      if (bytesRead <= 0) {
        break;
      }
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    fsSync.closeSync(fd);
  }
  const headerHex = headerBuffer.toString("hex").toLowerCase();
  const kind = String(asset?.kind || "").toLowerCase();
  if (kind === "installer" && !headerHex.startsWith("4d5a")) {
    throw new Error(`Downloaded installer has an invalid installer header: ${headerHex || "empty"}.`);
  }
  if (kind === "portable" && !headerHex.startsWith("504b")) {
    throw new Error(`Downloaded portable package has an invalid portable header: ${headerHex || "empty"}.`);
  }
  const actualSha256 = hash.digest("hex");
  if (!timingSafeEqual(
    Buffer.from(actualSha256, "hex"),
    Buffer.from(expectedSha256, "hex"),
  )) {
    throw new Error(
      `Downloaded ${asset?.name || "release asset"} SHA-256 mismatch: ` +
      `expected ${expectedSha256}, got ${actualSha256}.`,
    );
  }
  return {
    ok: true,
    path: resolved,
    size: stat.size,
    headerHex,
    kind,
    sha256: actualSha256,
  };
}

function releaseUpdateNextStep(installMode) {
  if (installMode === "windows_setup") {
    return "下载完成后会自动运行安装器、关闭旧版并打开新版。";
  }
  if (installMode === "portable_replacement") {
    return "下载完成后会自动重启到新版，并清理更新包和旧版备份。";
  }
  return "下载完成后会保存到更新目录；当前程序保持运行，可退出后手动解压打开新版。";
}

const MANAGED_PACKAGE_RE = /^(\d{4}-\d{2}-\d{2}-\d{9})-CodexBridge-.*\.(?:exe|zip|dmg)$/i;
const MANAGED_SIDE_FILE_RE = /^(?:install|manual|apply)-update-(\d{4}-\d{2}-\d{2}-\d{9})\.(?:txt|ps1|sh)$/i;

export async function cleanupManagedUpdateArtifacts(updateDir, { keepPackages = 2, removeFile = fs.rm } = {}) {
  const resolvedDir = path.resolve(String(updateDir || ""));
  if (!resolvedDir) {
    return { deleted: [], failed: [] };
  }
  let entries = [];
  try {
    entries = await fs.readdir(resolvedDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { deleted: [], failed: [] };
    }
    throw error;
  }

  const packageEntries = entries
    .filter((entry) => entry.isFile() && MANAGED_PACKAGE_RE.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      stamp: entry.name.match(MANAGED_PACKAGE_RE)?.[1] || "",
    }))
    .sort((left, right) => right.stamp.localeCompare(left.stamp));
  const keepStamps = new Set(packageEntries.slice(0, Math.max(0, keepPackages)).map((entry) => entry.stamp));
  const deleteNames = new Set();
  for (const entry of packageEntries) {
    if (!keepStamps.has(entry.stamp)) {
      deleteNames.add(entry.name);
    }
  }
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const sideMatch = entry.name.match(MANAGED_SIDE_FILE_RE);
    if (sideMatch && !keepStamps.has(sideMatch[1])) {
      deleteNames.add(entry.name);
    }
  }

  const deleted = [];
  const failed = [];
  for (const name of [...deleteNames].sort()) {
    const filePath = path.resolve(resolvedDir, name);
    if (path.dirname(filePath) !== resolvedDir) {
      continue;
    }
    try {
      await removeFile(filePath, { force: true });
      deleted.push(filePath);
    } catch (error) {
      failed.push({
        path: filePath,
        message: error?.message || String(error),
      });
    }
  }
  return { deleted, failed };
}

export async function installedAppVersionCleanupTargets({
  installedRoots = [],
  currentAppDir = "",
} = {}) {
  const current = normalizeFsPath(currentAppDir);
  const roots = uniqueFsPaths(installedRoots.map((item) => normalizeFsPath(item)).filter(Boolean));
  const targets = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^app-/i.test(entry.name)) {
        continue;
      }
      const target = path.resolve(root, entry.name);
      if (path.dirname(target) !== root || sameFsPath(target, current)) {
        continue;
      }
      targets.push(target);
    }
  }
  return uniqueFsPaths(targets);
}

const LEGACY_INSTALLED_APP_FILES = [
  "CodexBridge.exe",
  "chrome_100_percent.pak",
  "chrome_200_percent.pak",
  "d3dcompiler_47.dll",
  "ffmpeg.dll",
  "icudtl.dat",
  "libEGL.dll",
  "libGLESv2.dll",
  "LICENSE.electron.txt",
  "LICENSES.chromium.html",
  "resources.pak",
  "snapshot_blob.bin",
  "v8_context_snapshot.bin",
  "vk_swiftshader.dll",
  "vk_swiftshader_icd.json",
  "vulkan-1.dll",
];
const LEGACY_INSTALLED_APP_DIRS = [
  "locales",
  "resources",
  "swiftshader",
];

export async function installedLegacyAppCleanupTargets({
  installedRoots = [],
  currentAppDir = "",
  exeName = "CodexBridge.exe",
} = {}) {
  const current = normalizeFsPath(currentAppDir);
  const roots = uniqueFsPaths(installedRoots.map((item) => normalizeFsPath(item)).filter(Boolean));
  const targets = [];
  for (const root of roots) {
    if (!current || sameFsPath(root, current) || !isPathInsideOrEqual(current, root)) {
      continue;
    }
    if (!await isCodexBridgeLegacyRoot(root, exeName)) {
      continue;
    }
    for (const fileName of LEGACY_INSTALLED_APP_FILES) {
      const filePath = path.resolve(root, fileName);
      if (path.dirname(filePath) === root && await pathIsFile(filePath)) {
        targets.push({ path: filePath, kind: "file" });
      }
    }
    for (const dirName of LEGACY_INSTALLED_APP_DIRS) {
      const dirPath = path.resolve(root, dirName);
      if (path.dirname(dirPath) === root && !isPathInsideOrEqual(current, dirPath) && await pathIsDirectory(dirPath)) {
        targets.push({ path: dirPath, kind: "directory" });
      }
    }
  }
  return uniqueCleanupTargets(targets);
}

async function isCodexBridgeLegacyRoot(root, exeName) {
  const exePath = path.resolve(root, exeName || "CodexBridge.exe");
  const packageJsonPath = path.resolve(root, "resources", "app", "package.json");
  if (!await pathIsFile(exePath) || !await pathIsFile(packageJsonPath)) {
    return false;
  }
  try {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
    return /codex[-_ ]?bridge/i.test(String(packageJson?.name || ""));
  } catch {
    return false;
  }
}

async function pathIsFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function pathIsDirectory(dirPath) {
  try {
    return (await fs.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

function uniqueCleanupTargets(targets = []) {
  const seen = new Set();
  const result = [];
  for (const target of targets) {
    const targetPath = normalizeFsPath(target?.path);
    const kind = target?.kind === "directory" ? "directory" : "file";
    if (!targetPath) {
      continue;
    }
    const key = `${kind}:${fsPathKey(targetPath)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ path: targetPath, kind });
  }
  return result;
}

function releaseAssetPayload(asset, assetInfo) {
  return {
    name: asset.name,
    kind: assetInfo.kind,
    size: Number(asset.size || 0),
    downloadUrl: asset.browser_download_url,
    sha256: releaseAssetSha256(asset),
  };
}

function releaseAssetSha256(asset = {}) {
  const digest = String(asset?.digest || "").trim();
  const match = digest.match(/^sha256:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : "";
}

function normalizeSha256(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

function legacyPlanReleaseUpdate({
  currentVersion,
  platform = process.platform,
  arch = process.arch,
  release,
} = {}) {
  const assetCandidates = assetCandidatesForPlatform(platform, arch);
  const latestVersion = normalizeVersion(release?.tag_name || release?.name || "");
  if (!assetCandidates.length) {
    return {
      ok: false,
      updateAvailable: false,
      latestVersion,
      message: `当前系统暂不支持应用内更新：${platform} ${arch}`,
    };
  }
  if (!release || !latestVersion) {
    return {
      ok: false,
      updateAvailable: false,
      latestVersion,
      message: "没有读取到可用的 GitHub Release。",
    };
  }
  const releaseAssets = release.assets || [];
  const candidate = assetCandidates.find((assetInfo) =>
    releaseAssets.some((item) => item?.name === assetInfo.name && item?.browser_download_url),
  );
  const asset = releaseAssets.find((item) => item?.name === candidate?.name);
  if (!asset?.browser_download_url) {
    return {
      ok: false,
      updateAvailable: false,
      latestVersion,
      releaseUrl: release.html_url || "",
      message: `最新版没有找到当前系统的包：${assetName}`,
    };
  }
  const updateAvailable = isNewerVersion(latestVersion, currentVersion);
  return {
    ok: true,
    updateAvailable,
    currentVersion: normalizeVersion(currentVersion),
    latestVersion,
    releaseUrl: release.html_url || "",
    releaseNotes: release.body || "",
    asset: {
      name: asset.name,
      kind: candidate.kind,
      size: Number(asset.size || 0),
      downloadUrl: asset.browser_download_url,
    },
    message: updateAvailable
      ? `发现新版本 ${latestVersion}。`
      : `当前已是最新版本 ${normalizeVersion(currentVersion)}。`,
  };
}

export async function fetchLatestRelease({
  fetchImpl = globalThis.fetch,
  releaseUrl = GITHUB_LATEST_RELEASE_URL,
  latestReleasePageUrl = GITHUB_LATEST_RELEASE_PAGE_URL,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("当前运行环境没有可用的 fetch，无法检查更新。");
  }
  return fetchLatestReleaseWithFallback({ fetchImpl, releaseUrl, latestReleasePageUrl });
}

async function fetchLatestReleaseWithFallback({
  fetchImpl,
  releaseUrl,
  latestReleasePageUrl,
}) {
  let apiError = null;
  try {
    const response = await fetchImpl(releaseUrl, fetchInitWithProxy(releaseUrl, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "CodexBridge",
      },
    }));
    if (response.ok) {
      return response.json();
    }
    apiError = new Error(`GitHub API 返回 HTTP ${response.status}`);
  } catch (error) {
    apiError = error;
  }

  try {
    return await fetchLatestReleaseFromLatestPage({ fetchImpl, latestReleasePageUrl });
  } catch (fallbackError) {
    throw new Error(
      `检查更新失败：${apiError?.message || "GitHub API 不可用"}；releases/latest 兜底也失败：${fallbackError.message}`,
    );
  }
}

async function fetchLatestReleaseFromLatestPage({
  fetchImpl,
  latestReleasePageUrl,
}) {
  const response = await fetchImpl(latestReleasePageUrl, fetchInitWithProxy(latestReleasePageUrl, {
    redirect: "manual",
    headers: {
      accept: "text/html,*/*",
      "user-agent": "CodexBridge",
    },
  }));

  let latestTag = releaseTagFromLatestResponse(response, latestReleasePageUrl);
  if (!latestTag && response.ok && typeof response.text === "function") {
    latestTag = releaseTagFromText(await response.text());
  }
  if (!latestTag) {
    throw new Error(`无法从 HTTP ${response.status} 解析最新版本标签`);
  }
  return releaseFromLatestTag(latestTag);
}

function releaseTagFromLatestResponse(response, baseUrl) {
  const candidates = [
    response?.headers?.get?.("location"),
    response?.url,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const tag = releaseTagFromUrl(candidate, baseUrl);
    if (tag) {
      return tag;
    }
  }
  return "";
}

function releaseTagFromUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    const match = url.pathname.match(/\/releases\/tag\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

function releaseTagFromText(value) {
  const match = String(value || "").match(/\/releases\/tag\/(v?[0-9][0-9A-Za-z._-]*)/);
  return match ? match[1] : "";
}

function releaseFromLatestTag(tag) {
  const latestTag = String(tag || "").trim();
  return {
    tag_name: latestTag,
    name: latestTag,
    html_url: `https://github.com/wangzhezbz/codex-bridge/releases/tag/${latestTag}`,
    body: "GitHub API 不可用，已通过 releases/latest 兜底解析最新版本。",
    assets: RELEASE_ASSET_NAMES.map((name) => ({
      name,
      size: 0,
      browser_download_url: `${GITHUB_LATEST_DOWNLOAD_BASE_URL}/${name}`,
    })),
  };
}

export function fetchInitForUpdateDownload(targetUrl, init = {}) {
  return fetchInitWithProxy(targetUrl, init);
}

export function updateDownloadProxyLabel(targetUrl) {
  return proxyLogLabel(targetUrl);
}

export function generateWindowsPortableUpdateScript({
  parentPid,
  blockingPids = [],
  zipPath,
  currentAppDir,
  exeName = "CodexBridge.exe",
  workDir,
  logPath,
}) {
  const waitPids = uniquePositivePids([parentPid, ...blockingPids]);
  return `$ErrorActionPreference = 'Stop'
$WAIT_PIDS = @(${waitPids.join(", ")})
$ZIP_PATH = ${psQuote(zipPath)}
$CURRENT_APP_DIR = ${psQuote(currentAppDir)}
$EXE_NAME = ${psQuote(exeName)}
$WORK_DIR = ${psQuote(workDir)}
$LOG_PATH = ${psQuote(logPath)}
$backupDir = $null
$updateStamp = Get-Date -Format "yyyyMMdd-HHmmss"

function Convert-UpdateText([string]$Base64) {
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Base64))
}

function Write-UpdateLog([string]$Message) {
  $dir = Split-Path -Parent $LOG_PATH
  if ($dir) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  Add-Content -LiteralPath $LOG_PATH -Value ("[" + (Get-Date).ToString("s") + "] " + $Message)
}

function Wait-UpdateProcessExit([int]$TargetPid) {
  if ($TargetPid -le 0) {
    return
  }
  Write-UpdateLog "Waiting for process $TargetPid to exit."
  $deadline = (Get-Date).AddSeconds(90)
  while (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deadline) {
      throw "Process $TargetPid did not exit within 90 seconds."
    }
    Start-Sleep -Milliseconds 500
  }
}

function Normalize-UpdatePath([string]$PathValue) {
  if (-not $PathValue) {
    return ""
  }
  try {
    return [System.IO.Path]::GetFullPath($PathValue).TrimEnd([char[]]@("\\", "/"))
  } catch {
    return $PathValue.TrimEnd([char[]]@("\\", "/"))
  }
}

function Test-UpdatePathInside([string]$Candidate, [string]$Root) {
  $candidatePath = Normalize-UpdatePath $Candidate
  $rootPath = Normalize-UpdatePath $Root
  if (-not $candidatePath -or -not $rootPath) {
    return $false
  }
  if ($candidatePath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  $prefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
  return $candidatePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-AppDirectoryProcessIds([string]$AppDir) {
  $matches = @()
  try {
    $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
  } catch {
    Write-UpdateLog ("Could not inspect running processes: " + $_.Exception.Message)
    return $matches
  }
  foreach ($process in $processes) {
    if ($process.ExecutablePath -and (Test-UpdatePathInside $process.ExecutablePath $AppDir)) {
      $matches += [int]$process.ProcessId
    }
  }
  return $matches
}

function Wait-AppDirectoryProcessesExit([string]$AppDir) {
  $deadline = (Get-Date).AddSeconds(8)
  $lastLogAt = (Get-Date).AddSeconds(-10)
  while ($true) {
    $runningPids = @(Get-AppDirectoryProcessIds $AppDir)
    if ($runningPids.Count -eq 0) {
      return
    }
    if ((Get-Date) -gt $deadline) {
      Write-UpdateLog ("Stopping lingering app directory process(es): " + ($runningPids -join ", "))
      foreach ($runningPid in $runningPids) {
        Stop-Process -Id $runningPid -Force -ErrorAction SilentlyContinue
      }
      $stopDeadline = (Get-Date).AddSeconds(20)
      while ($true) {
        $remainingPids = @(Get-AppDirectoryProcessIds $AppDir)
        if ($remainingPids.Count -eq 0) {
          return
        }
        if ((Get-Date) -gt $stopDeadline) {
          throw ("Process(es) still running from current app directory after stop: " + ($remainingPids -join ", "))
        }
        Start-Sleep -Milliseconds 500
      }
    }
    if ((Get-Date) -gt $lastLogAt.AddSeconds(2)) {
      Write-UpdateLog ("Waiting for app directory process(es) to exit: " + ($runningPids -join ", "))
      $lastLogAt = Get-Date
    }
    Start-Sleep -Milliseconds 500
  }
}

function Invoke-UpdateStep([string]$Description, [scriptblock]$Action) {
  $deadline = (Get-Date).AddSeconds(120)
  $attempt = 0
  while ($true) {
    try {
      & $Action
      return
    } catch {
      $attempt += 1
      $message = $_.Exception.Message
      if ((Get-Date) -gt $deadline) {
        throw ($Description + " failed after " + $attempt + " attempt(s): " + $message)
      }
      Write-UpdateLog ($Description + " failed on attempt " + $attempt + ": " + $message)
      Start-Sleep -Milliseconds 750
    }
  }
}

function Show-UpdateFailure([string]$Message) {
  try {
    Add-Type -AssemblyName PresentationFramework -ErrorAction Stop
    [System.Windows.MessageBox]::Show(
      ((Convert-UpdateText "Q29kZXhCcmlkZ2Ug5pu05paw5aSx6LSl77yM5pen54mI5bey5L+d55WZ44CC5pel5b+X77ya") + $LOG_PATH + [Environment]::NewLine + [Environment]::NewLine + $Message),
      (Convert-UpdateText "Q29kZXhCcmlkZ2Ug5pu05paw5aSx6LSl"),
      "OK",
      "Error"
    ) | Out-Null
  } catch {
  }
}

function Show-UpdateNotice([string]$Message, [int]$Seconds = 2) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shell.Popup($Message, $Seconds, (Convert-UpdateText "Q29kZXhCcmlkZ2Ug5pu05paw"), 64) | Out-Null
  } catch {
    Write-UpdateLog ("Could not show update notice: " + $_.Exception.Message)
  }
}

function Open-UpdateFolder() {
  try {
    Start-Process -FilePath "explorer.exe" -ArgumentList $WORK_DIR
  } catch {
    Write-UpdateLog ("Could not open update folder: " + $_.Exception.Message)
  }
}

function Remove-FileSafely([string]$FilePath, [string]$AllowedRoot, [string]$Description = "file") {
  if (-not $FilePath -or -not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    return
  }
  if (-not (Test-UpdatePathInside $FilePath $AllowedRoot)) {
    Write-UpdateLog ("Skipped removing " + $Description + " outside allowed root: " + $FilePath)
    return
  }
  Invoke-UpdateStep ("Removing " + $Description) {
    Remove-Item -LiteralPath $FilePath -Force
  }
}

function Remove-DirectoryTreeSafely([string]$DirectoryPath, [string]$AllowedRoot, [string]$Description = "directory") {
  if (-not $DirectoryPath -or -not (Test-Path -LiteralPath $DirectoryPath -PathType Container)) {
    return
  }
  $target = Normalize-UpdatePath $DirectoryPath
  $root = Normalize-UpdatePath $AllowedRoot
  if (-not $target -or -not $root -or $target.Equals($root, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-UpdatePathInside $target $root)) {
    Write-UpdateLog ("Skipped removing " + $Description + " outside allowed root: " + $DirectoryPath)
    return
  }
  Invoke-UpdateStep ("Removing " + $Description) {
    $items = @(Get-ChildItem -LiteralPath $target -Force -Recurse | Sort-Object { $_.FullName.Length } -Descending)
    foreach ($item in $items) {
      if (-not (Test-UpdatePathInside $item.FullName $target)) {
        throw ("Refusing to remove item outside target directory: " + $item.FullName)
      }
      Remove-Item -LiteralPath $item.FullName -Force
    }
    Remove-Item -LiteralPath $target -Force
  }
}

function Find-CodexBridgeAppDir([string]$Root) {
  $matches = @()
  $exeFiles = Get-ChildItem -LiteralPath $Root -Filter $EXE_NAME -File -Recurse
  foreach ($exe in $exeFiles) {
    $candidateDir = $exe.Directory.FullName
    $packageJson = Join-Path $candidateDir "resources\\app\\package.json"
    if (Test-Path -LiteralPath $packageJson) {
      $matches += $candidateDir
    }
  }

  if ($matches.Count -eq 0) {
    throw "The update package does not contain a valid CodexBridge portable app directory."
  }

  $preferred = $matches | Where-Object { (Split-Path -Leaf $_) -eq "CodexBridge-win32-x64" } | Select-Object -First 1
  if ($preferred) {
    return $preferred
  }

  if ($matches.Count -eq 1) {
    return $matches[0]
  }

  throw ("The update package contains multiple CodexBridge app directories: " + ($matches -join "; "))
}

function Assert-CodexBridgeAppDir([string]$AppDir) {
  $exePath = Join-Path $AppDir $EXE_NAME
  $packageJson = Join-Path $AppDir "resources\\app\\package.json"
  if (-not (Test-Path -LiteralPath $exePath)) {
    throw "Current app directory is missing \${EXE_NAME}: $AppDir"
  }
  if (-not (Test-Path -LiteralPath $packageJson)) {
    throw "Current app directory is missing resources\\app\\package.json: $AppDir"
  }
}

function Restore-PreviousAppDirectory() {
  if (-not $backupDir -or -not (Test-Path -LiteralPath $backupDir)) {
    Write-UpdateLog "No previous app directory backup was available to restore."
    return $false
  }

  $appParent = Split-Path -Parent $CURRENT_APP_DIR
  $appLeaf = Split-Path -Leaf $CURRENT_APP_DIR

  if (Test-Path -LiteralPath $CURRENT_APP_DIR) {
    $failedLeaf = "$appLeaf.failed-update-$updateStamp"
    Write-UpdateLog "Preserving failed app directory as $failedLeaf."
    Invoke-UpdateStep "Preserving failed app directory" {
      Rename-Item -LiteralPath $CURRENT_APP_DIR -NewName $failedLeaf
    }
  }

  Write-UpdateLog "Restoring previous app directory from $backupDir."
  Invoke-UpdateStep "Restoring previous app directory" {
    Rename-Item -LiteralPath $backupDir -NewName $appLeaf
  }
  return $true
}

function Start-CodexBridgeAfterFailure() {
  $exePath = Join-Path $CURRENT_APP_DIR $EXE_NAME
  if (-not (Test-Path -LiteralPath $exePath)) {
    Write-UpdateLog "Could not restart CodexBridge after failed update; executable missing: $exePath"
    return
  }
  try {
    Write-UpdateLog "Restarting CodexBridge after failed update: $exePath"
    Start-Process -FilePath $exePath -WorkingDirectory $CURRENT_APP_DIR
  } catch {
    Write-UpdateLog ("Could not restart CodexBridge after failed update: " + $_.Exception.Message)
  }
}

try {
  Write-UpdateLog "Updater script started."
  Write-UpdateLog "Current app directory: $CURRENT_APP_DIR"
  Write-UpdateLog "Update package: $ZIP_PATH"
  Write-UpdateLog "Update work directory: $WORK_DIR"
  Show-UpdateNotice (Convert-UpdateText "Q29kZXhCcmlkZ2Ug5q2j5Zyo5a6J6KOF5pu05paw77yM5paw54mI5pys5Lya6Ieq5Yqo5omT5byA44CC")
  foreach ($waitPid in $WAIT_PIDS) {
    Wait-UpdateProcessExit $waitPid
  }
  Wait-AppDirectoryProcessesExit $CURRENT_APP_DIR

  New-Item -ItemType Directory -Force -Path $WORK_DIR | Out-Null
  $stamp = $updateStamp
  $appParent = Split-Path -Parent $CURRENT_APP_DIR
  $appLeaf = Split-Path -Leaf $CURRENT_APP_DIR
  $backupLeaf = "$appLeaf.previous-$stamp"
  $backupDir = Join-Path $appParent $backupLeaf
  $extractDir = Join-Path $WORK_DIR "extract-$stamp"

  Write-UpdateLog "Extracting update package."
  New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
  Expand-Archive -LiteralPath $ZIP_PATH -DestinationPath $extractDir -Force

  Assert-CodexBridgeAppDir $CURRENT_APP_DIR
  $newAppDir = Find-CodexBridgeAppDir $extractDir
  Write-UpdateLog "Resolved new app directory: $newAppDir"

  Write-UpdateLog "Renaming current app directory to $backupLeaf."
  Invoke-UpdateStep "Renaming current app directory" {
    Rename-Item -LiteralPath $CURRENT_APP_DIR -NewName $backupLeaf
  }

  Write-UpdateLog "Moving new app directory into place."
  Invoke-UpdateStep "Moving new app directory into place" {
    Move-Item -LiteralPath $newAppDir -Destination $CURRENT_APP_DIR
  }

  $nextExe = Join-Path $CURRENT_APP_DIR $EXE_NAME
  Assert-CodexBridgeAppDir $CURRENT_APP_DIR
  Write-UpdateLog "Starting updated CodexBridge: $nextExe"
  $startedProcess = Start-Process -FilePath $nextExe -ArgumentList "--updated" -WorkingDirectory $CURRENT_APP_DIR -PassThru
  Start-Sleep -Seconds 8
  if (-not (Get-Process -Id $startedProcess.Id -ErrorAction SilentlyContinue)) {
    throw "Updated CodexBridge exited immediately after launch: $nextExe"
  }
  Write-UpdateLog "Updated CodexBridge stayed running; removing previous version and update package."
  Remove-DirectoryTreeSafely $backupDir $appParent "previous app directory"
  Remove-DirectoryTreeSafely $extractDir $WORK_DIR "extract directory"
  Remove-FileSafely $ZIP_PATH $WORK_DIR "update package"
  Write-UpdateLog (Convert-UpdateText "5pu05paw5a6M5oiQ77yM5pen54mI5pys5bey56e76Zmk44CC")
} catch {
  $failureMessage = $_.Exception.Message
  Write-UpdateLog ((Convert-UpdateText "5pu05paw5aSx6LSl77ya") + $failureMessage)
  Restore-PreviousAppDirectory | Out-Null
  Write-UpdateLog (Convert-UpdateText "5pu05paw5aSx6LSl77yb5bey5bC96YeP5oGi5aSN5bm26YeN5ZCv5pen54mI5pys44CC")
  Start-CodexBridgeAfterFailure
  Open-UpdateFolder
  Show-UpdateFailure $failureMessage
}
`;
}

export function generateMacPortableUpdateScript({
  parentPid,
  blockingPids = [],
  zipPath,
  currentAppBundle,
  workDir,
  logPath,
}) {
  const waitPids = uniquePositivePids([parentPid, ...blockingPids]);
  return `#!/bin/sh
set -eu
WAIT_PIDS=${shQuote(waitPids.join(" "))}
ZIP_PATH=${shQuote(zipPath)}
CURRENT_APP_BUNDLE=${shQuote(currentAppBundle)}
WORK_DIR=${shQuote(workDir)}
LOG_PATH=${shQuote(logPath)}
backup_bundle=""

log() {
  mkdir -p "$(dirname "$LOG_PATH")"
  printf '[%s] %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$1" >> "$LOG_PATH"
}

restore_old_app() {
  if [ -n "$backup_bundle" ] && [ -d "$backup_bundle" ] && [ ! -d "$CURRENT_APP_BUNDLE" ]; then
    mv "$backup_bundle" "$CURRENT_APP_BUNDLE"
    open "$CURRENT_APP_BUNDLE"
  fi
}

trap 'log "更新失败。"; restore_old_app' ERR

for pid in $WAIT_PIDS; do
  log "Waiting for process $pid to exit."
  deadline=$(( $(date +%s) + 90 ))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(date +%s)" -gt "$deadline" ]; then
      log "Process $pid did not exit within 90 seconds."
      exit 1
    fi
    sleep 1
  done
done

stamp="$(date '+%Y%m%d-%H%M%S')"
app_parent="$(dirname "$CURRENT_APP_BUNDLE")"
app_leaf="$(basename "$CURRENT_APP_BUNDLE")"
backup_bundle="$app_parent/$app_leaf.previous-$stamp"
extract_dir="$WORK_DIR/extract-$stamp"
mkdir -p "$extract_dir"

log "Extracting update package."
ditto -x -k "$ZIP_PATH" "$extract_dir"
new_app="$(find "$extract_dir" -name 'CodexBridge.app' -type d | head -n 1)"
if [ -z "$new_app" ]; then
  log "The update package does not contain CodexBridge.app."
  exit 1
fi

log "Renaming current app bundle."
mv "$CURRENT_APP_BUNDLE" "$backup_bundle"
log "Moving new app bundle into place."
mv "$new_app" "$CURRENT_APP_BUNDLE"
log "Starting updated CodexBridge."
open "$CURRENT_APP_BUNDLE"
log "更新完成，旧版本保留在 $backup_bundle。"
`;
}

function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function normalizeFsPath(value) {
  const text = String(value || "").trim();
  return text ? path.resolve(text) : "";
}

function uniqueFsPaths(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeFsPath(value);
    if (!normalized) {
      continue;
    }
    const key = fsPathKey(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function sameFsPath(left, right) {
  return fsPathKey(left) === fsPathKey(right);
}

function isPathInsideOrEqual(candidate, root) {
  const candidatePath = normalizeFsPath(candidate);
  const rootPath = normalizeFsPath(root);
  if (!candidatePath || !rootPath) {
    return false;
  }
  if (sameFsPath(candidatePath, rootPath)) {
    return true;
  }
  return fsPathKey(candidatePath).startsWith(`${fsPathKey(rootPath)}${path.sep}`);
}

function fsPathKey(value) {
  const normalized = normalizeFsPath(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parseVersion(value) {
  return normalizeVersion(value)
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function uniquePositivePids(values) {
  return [...new Set(
    values
      .map((value) => Math.floor(Number(value)))
      .filter((value) => Number.isFinite(value) && value > 0),
  )];
}

function psQuote(value) {
  return `'${String(value || "").replaceAll("'", "''")}'`;
}

function shQuote(value) {
  return `'${String(value || "").replaceAll("'", "'\"'\"'")}'`;
}
