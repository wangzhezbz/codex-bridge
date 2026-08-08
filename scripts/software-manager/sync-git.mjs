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
    const match = /^Git-(\d+\.\d+\.\d+(?:\.\d+)?)-64-bit\.exe$/u.exec(asset?.name ?? "");
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

export function parseAuthenticodeTimestamp(output) {
  const matches = [...String(output ?? "").matchAll(/^[ \t]*Timestamp time:[ \t]*(.+ GMT)[ \t]*$/gmu)];
  if (matches.length !== 1) throw gitError("software_sync_git_timestamp_invalid");
  const milliseconds = Date.parse(matches[0][1]);
  const minimum = Date.parse("2020-01-01T00:00:00.000Z");
  if (!Number.isFinite(milliseconds) || milliseconds < minimum || milliseconds > Date.now() + 86_400_000) {
    throw gitError("software_sync_git_timestamp_invalid");
  }
  return Math.floor(milliseconds / 1_000);
}

function verificationOutput(result) {
  return `${String(result?.stdout ?? "")}\n${String(result?.stderr ?? "")}`;
}

function assertVerifiedOutput(output) {
  if (!/Timestamp Server Signature verification: ok/u.test(output)
    || !/^Signature verification: ok$/mu.test(output)
    || !/Number of verified signatures:\s*1/u.test(output)
    || !/^Succeeded$/mu.test(output)) {
    throw gitError("software_sync_git_authenticode_invalid");
  }
}

async function defaultAuthenticodeInspector(packagePath) {
  if (process.platform !== "win32") {
    const executable = String(process.env.CBI_OSSLSIGNCODE_PATH || "/usr/bin/osslsigncode");
    const caFile = String(process.env.CBI_OSSLSIGNCODE_CA_FILE || "");
    if (!path.isAbsolute(executable) || path.normalize(executable) !== executable
      || !path.isAbsolute(caFile) || path.normalize(caFile) !== caFile) {
      throw gitError("software_sync_git_authenticode_tool_invalid");
    }
    const options = { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" };
    const baseArgs = ["verify", "-CAfile", caFile, "-TSA-CAfile", caFile];
    let initial;
    try {
      initial = await execFileAsync(executable, [...baseArgs, "-in", packagePath], options);
      assertVerifiedOutput(verificationOutput(initial));
      return "Valid";
    } catch (error) {
      const verificationTime = parseAuthenticodeTimestamp(verificationOutput(error));
      const verified = await execFileAsync(executable, [
        ...baseArgs, "-time", String(verificationTime), "-in", packagePath,
      ], options);
      assertVerifiedOutput(verificationOutput(verified));
    }
    return "Valid";
  }
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
  githubToken = process.env.GITHUB_TOKEN,
} = {}) {
  const metadataHeaders = {
    accept: "application/vnd.github+json",
    "user-agent": "CodexBridge-software-sync/1",
    ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
  };
  const response = await fetchImpl(GIT_RELEASE_API_URL, {
    redirect: "error",
    headers: metadataHeaders,
  });
  if (!response?.ok) throw gitError("software_sync_git_metadata_failed");
  const selected = selectAsset(await response.json());
  const current = currentCatalog.components?.find((item) => item.id === "git");
  if (current?.version === selected.version) {
    return Object.freeze({
      id: "git",
      action: "noop",
      reason: "version_unchanged",
      version: selected.version,
      sha256: current.sha256,
      identity: `${selected.version}:${current.sha256}`,
    });
  }
  const downloaded = await downloadToPart({
    url: selected.url,
    fetchImpl,
    workRoot,
    prefix: "git",
  });
  try {
    const authenticode = String(await authenticodeInspector(downloaded.packagePath));
    if (authenticode !== "Valid") throw gitError("software_sync_git_authenticode_invalid");
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
