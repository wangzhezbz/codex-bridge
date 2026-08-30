import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DOGECLOUD_PACKAGE_BASE_URL = "https://download.shanhaiyouling.com/codexbridge-test/packages/";
const OBJECT_PREFIX = "codexbridge-test/packages/";
const SHA256 = /^[a-f0-9]{64}$/u;

function artifactError(code, cause = undefined) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function exactAbsoluteFile(value, code) {
  const raw = String(value || "");
  if (!raw || !path.isAbsolute(raw) || path.normalize(raw) !== raw || raw.includes("\0")) {
    throw artifactError(code);
  }
  let stat;
  try {
    stat = fs.statSync(raw);
  } catch (error) {
    throw artifactError(code, error);
  }
  if (!stat.isFile()) throw artifactError(code);
  return { path: raw, stat };
}

function safeRelativePath(value) {
  const raw = String(value || "");
  const parts = raw.split("/");
  if (!raw || raw.includes("\\") || raw.startsWith("/")
    || parts.some((part) => !part || part === "." || part === "..")
    || encodeURI(raw) !== raw) {
    throw artifactError("dogecloud_relative_path_rejected");
  }
  return raw;
}

function verifiedPackage({ sourcePath, expectedSize, expectedSha256 }) {
  const source = exactAbsoluteFile(sourcePath, "dogecloud_source_file_invalid");
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || source.stat.size !== expectedSize
    || !SHA256.test(expectedSha256 ?? "")) {
    throw artifactError("dogecloud_source_binding_invalid");
  }
  const digest = crypto.createHash("sha256").update(fs.readFileSync(source.path)).digest("hex");
  if (digest !== expectedSha256) throw artifactError("dogecloud_source_binding_invalid");
  return source.path;
}

function localResult({ packageBaseUrl, relativePath, expectedSize, expectedSha256 }) {
  return Object.freeze({
    action: "local",
    objectKey: null,
    size: expectedSize,
    sha256: expectedSha256,
    url: new URL(relativePath, packageBaseUrl).href,
  });
}

export function createDogeCloudArtifactPublisher({
  packageBaseUrl,
  env = process.env,
  execute = execFileAsync,
} = {}) {
  let base;
  try {
    base = new URL(String(packageBaseUrl || ""));
  } catch {
    throw artifactError("dogecloud_package_base_url_invalid");
  }
  const enabled = base.href === DOGECLOUD_PACKAGE_BASE_URL;
  let settings = null;
  if (enabled) {
    const accessKey = String(env?.CBI_DOGECLOUD_ACCESS_KEY || "").trim();
    const secretKey = String(env?.CBI_DOGECLOUD_SECRET_KEY || "").trim();
    const bucket = String(env?.CBI_DOGECLOUD_BUCKET || "").trim();
    if (!accessKey || !secretKey || bucket !== "codex") throw artifactError("dogecloud_credentials_required");
    const uploader = exactAbsoluteFile(env?.CBI_DOGECLOUD_UPLOADER, "dogecloud_uploader_required").path;
    const python = exactAbsoluteFile(env?.CBI_DOGECLOUD_PYTHON, "dogecloud_python_required").path;
    settings = Object.freeze({ accessKey, secretKey, bucket, uploader, python });
  }

  return Object.freeze({
    async publish({ sourcePath, relativePath, expectedSize, expectedSha256 } = {}) {
      const relative = safeRelativePath(relativePath);
      const source = verifiedPackage({ sourcePath, expectedSize, expectedSha256 });
      if (!enabled) return localResult({ packageBaseUrl: base.href, relativePath: relative, expectedSize, expectedSha256 });
      const objectKey = `${OBJECT_PREFIX}${relative}`;
      const url = new URL(relative, base).href;
      let stdout;
      try {
        ({ stdout } = await execute(settings.python, [
          settings.uploader,
          "--file", source,
          "--bucket", settings.bucket,
          "--object-key", objectKey,
          "--cdn-url", url,
          "--expected-size", String(expectedSize),
          "--expected-sha256", expectedSha256,
        ], {
          env: {
            ...process.env,
            ...env,
            CBI_DOGECLOUD_ACCESS_KEY: settings.accessKey,
            CBI_DOGECLOUD_SECRET_KEY: settings.secretKey,
          },
          windowsHide: true,
          timeout: 60 * 60 * 1000,
          maxBuffer: 1024 * 1024,
        }));
      } catch (error) {
        throw artifactError("dogecloud_upload_failed", error);
      }
      let result;
      try {
        result = JSON.parse(String(stdout || ""));
      } catch {
        throw artifactError("dogecloud_upload_result_invalid");
      }
      if (!result || !["uploaded", "verified"].includes(result.action)
        || result.objectKey !== objectKey || result.size !== expectedSize || result.sha256 !== expectedSha256) {
        throw artifactError("dogecloud_upload_result_invalid");
      }
      return Object.freeze({ action: result.action, objectKey, size: expectedSize, sha256: expectedSha256, url });
    },
  });
}
