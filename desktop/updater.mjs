export const GITHUB_LATEST_RELEASE_URL =
  "https://api.github.com/repos/wangzhezbz/codex-bridge/releases/latest";

export function assetNameForPlatform(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") {
    return "CodexBridge-Windows-x64-Portable.zip";
  }
  if (platform === "darwin" && arch === "arm64") {
    return "CodexBridge-macOS-arm64-Portable.zip";
  }
  if (platform === "darwin" && arch === "x64") {
    return "CodexBridge-macOS-x64-Portable.zip";
  }
  return null;
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
  release,
} = {}) {
  const assetName = assetNameForPlatform(platform, arch);
  const latestVersion = normalizeVersion(release?.tag_name || release?.name || "");
  if (!assetName) {
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
  const asset = (release.assets || []).find((item) => item?.name === assetName);
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
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("当前运行环境没有可用的 fetch，无法检查更新。");
  }
  const response = await fetchImpl(releaseUrl, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "CodexBridge",
    },
  });
  if (!response.ok) {
    throw new Error(`检查更新失败：GitHub 返回 HTTP ${response.status}`);
  }
  return response.json();
}

export function generateWindowsPortableUpdateScript({
  parentPid,
  zipPath,
  currentAppDir,
  exeName,
  workDir,
  logPath,
}) {
  return `$ErrorActionPreference = 'Stop'
$PARENT_PID = ${Number(parentPid) || 0}
$ZIP_PATH = ${psQuote(zipPath)}
$CURRENT_APP_DIR = ${psQuote(currentAppDir)}
$EXE_NAME = ${psQuote(exeName)}
$WORK_DIR = ${psQuote(workDir)}
$LOG_PATH = ${psQuote(logPath)}
$backupDir = $null

function Write-UpdateLog([string]$Message) {
  $dir = Split-Path -Parent $LOG_PATH
  if ($dir) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  Add-Content -LiteralPath $LOG_PATH -Value ("[" + (Get-Date).ToString("s") + "] " + $Message)
}

try {
  Write-UpdateLog "Waiting for CodexBridge process $PARENT_PID to exit."
  $deadline = (Get-Date).AddSeconds(90)
  while (Get-Process -Id $PARENT_PID -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deadline) {
      throw "CodexBridge did not exit within 90 seconds."
    }
    Start-Sleep -Milliseconds 500
  }

  New-Item -ItemType Directory -Force -Path $WORK_DIR | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $appParent = Split-Path -Parent $CURRENT_APP_DIR
  $appLeaf = Split-Path -Leaf $CURRENT_APP_DIR
  $backupLeaf = "$appLeaf.previous-$stamp"
  $backupDir = Join-Path $appParent $backupLeaf
  $extractDir = Join-Path $WORK_DIR "extract-$stamp"

  Write-UpdateLog "Extracting update package."
  New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
  Expand-Archive -LiteralPath $ZIP_PATH -DestinationPath $extractDir -Force

  $newExe = Get-ChildItem -LiteralPath $extractDir -Filter $EXE_NAME -File -Recurse | Select-Object -First 1
  if (-not $newExe) {
    throw "The update package does not contain $EXE_NAME."
  }
  $newAppDir = $newExe.Directory.FullName

  Write-UpdateLog "Renaming current app directory to $backupLeaf."
  Rename-Item -LiteralPath $CURRENT_APP_DIR -NewName $backupLeaf

  Write-UpdateLog "Moving new app directory into place."
  Move-Item -LiteralPath $newAppDir -Destination $CURRENT_APP_DIR

  $nextExe = Join-Path $CURRENT_APP_DIR $EXE_NAME
  Write-UpdateLog "Starting updated CodexBridge: $nextExe"
  Start-Process -FilePath $nextExe
  Write-UpdateLog "Update completed. Previous version kept at $backupDir."
} catch {
  Write-UpdateLog ("Update failed: " + $_.Exception.Message)
  $appParent = Split-Path -Parent $CURRENT_APP_DIR
  $appLeaf = Split-Path -Leaf $CURRENT_APP_DIR
  if ($backupDir -and (Test-Path -LiteralPath $backupDir) -and -not (Test-Path -LiteralPath $CURRENT_APP_DIR)) {
    Rename-Item -LiteralPath $backupDir -NewName $appLeaf
  }
  $fallbackExe = Join-Path $CURRENT_APP_DIR $EXE_NAME
  if (Test-Path -LiteralPath $fallbackExe) {
    Start-Process -FilePath $fallbackExe
  }
}
`;
}

export function generateMacPortableUpdateScript({
  parentPid,
  zipPath,
  currentAppBundle,
  workDir,
  logPath,
}) {
  return `#!/bin/sh
set -eu
PARENT_PID=${Number(parentPid) || 0}
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

trap 'log "Update failed."; restore_old_app' ERR

log "Waiting for CodexBridge process $PARENT_PID to exit."
deadline=$(( $(date +%s) + 90 ))
while kill -0 "$PARENT_PID" 2>/dev/null; do
  if [ "$(date +%s)" -gt "$deadline" ]; then
    log "CodexBridge did not exit within 90 seconds."
    exit 1
  fi
  sleep 1
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
log "Update completed. Previous version kept at $backup_bundle."
`;
}

function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function parseVersion(value) {
  return normalizeVersion(value)
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function psQuote(value) {
  return `'${String(value || "").replaceAll("'", "''")}'`;
}

function shQuote(value) {
  return `'${String(value || "").replaceAll("'", "'\"'\"'")}'`;
}
