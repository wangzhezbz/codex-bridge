import { execFile } from "node:child_process";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { downloadToPart } from "./sync-v2rayn.mjs";

export const GIT_RELEASE_API_URL = "https://api.github.com/repos/git-for-windows/git/releases/latest";
const execFileAsync = promisify(execFile);

function gitError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function selectAsset(metadata) {
  if (!metadata || !Array.isArray(metadata.assets) || metadata.assets.length > 1_000) {
    throw gitError("software_sync_git_metadata_invalid");
  }
  const candidates = metadata.assets.map((asset) => {
    const match = /^Git-(\d+\.\d+\.\d+)-64-bit\.exe$/u.exec(asset?.name ?? "");
    return match ? { asset, version: match[1] } : null;
  }).filter(Boolean);
  if (candidates.length !== 1) throw gitError("software_sync_git_asset_invalid");
  let url;
  try {
    url = new URL(candidates[0].asset.browser_download_url);
  } catch {
    throw gitError("software_sync_git_asset_rejected");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com"
    || !url.pathname.startsWith("/git-for-windows/git/releases/download/") || url.search || url.hash) {
    throw gitError("software_sync_git_asset_rejected");
  }
  return { ...candidates[0], url: url.href };
}

async function defaultAuthenticodeInspector(packagePath) {
  const command = "$s=Get-AuthenticodeSignature -LiteralPath $env:CBI_GIT_INSTALLER;[Console]::Out.Write($s.Status)";
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
  ], {
    env: { ...process.env, CBI_GIT_INSTALLER: packagePath },
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  return String(stdout).trim();
}

export async function inspectGitRelease({
  currentCatalog = { components: [] },
  fetchImpl = globalThis.fetch,
  authenticodeInspector = defaultAuthenticodeInspector,
  workRoot,
} = {}) {
  const response = await fetchImpl(GIT_RELEASE_API_URL, {
    redirect: "error",
    headers: { accept: "application/vnd.github+json", "user-agent": "CodexBridge-software-sync/1" },
  });
  if (!response?.ok) throw gitError("software_sync_git_metadata_failed");
  const selected = selectAsset(await response.json());
  const downloaded = await downloadToPart({
    url: selected.url,
    fetchImpl,
    workRoot,
    prefix: "git",
  });
  try {
    const authenticode = String(await authenticodeInspector(downloaded.packagePath));
    if (authenticode !== "Valid") throw gitError("software_sync_git_authenticode_invalid");
    const current = currentCatalog.components?.find((item) => item.id === "git");
    const unchanged = current?.sha256 === downloaded.sha256;
    return Object.freeze({
      ...downloaded,
      id: "git",
      action: unchanged ? "noop" : "publish",
      ...(unchanged ? { reason: "content_unchanged" } : {}),
      version: selected.version,
      identity: `${selected.version}:${downloaded.sha256}`,
      authenticode,
      format: "exe",
      entrypoint: "cmd/git.exe",
      requiredFiles: Object.freeze(["cmd/git.exe"]),
      maxRelativePathLength: 32,
    });
  } catch (error) {
    await fsPromises.unlink(downloaded.packagePath).catch(() => {});
    throw error;
  }
}
