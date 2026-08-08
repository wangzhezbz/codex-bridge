import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { TEST_CATALOG_ORIGIN, TEST_CATALOG_PATH } from "../shared/software-manager/catalog-schema.mjs";
import {
  CATALOG_PUBLIC_KEY_SHA256,
  CATALOG_PUBLIC_KEY_SPKI,
} from "../desktop/software-manager/catalog-public-key.mjs";

const PINNED_SEVEN_ZIP_X64_SHA256 = "b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95";
const REQUIRED_SOFTWARE_MANAGER_PATHS = Object.freeze([
  "desktop/software-manager/catalog-trust.mjs",
  "desktop/software-manager/runtime-factory.mjs",
  "node_modules/7zip-bin/win/x64/7za.exe",
  "node_modules/7zip-bin/LICENSE.txt",
]);

export const WINDOWS_PACKAGE_HARDENING_RULES = Object.freeze([
  Object.freeze({
    id: "remediation_record",
    pattern: /^\/docs\/router-remediation-record-\d+\.md$/i,
  }),
  Object.freeze({ id: "source_map", pattern: /\.map$/i }),
  Object.freeze({
    id: "development_test_tree",
    pattern: /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/i,
  }),
  Object.freeze({
    id: "environment_file",
    pattern: /(?:^|\/)\.env(?:\.[^/]+)?$/i,
  }),
  Object.freeze({
    id: "private_key_material",
    pattern: /\.(?:pem|key|p12|pfx)$/i,
  }),
  Object.freeze({ id: "partial_download", pattern: /\.part$/i }),
  Object.freeze({
    id: "software_manager_transaction_state",
    pattern: /(?:^|\/)software-manager\/(?:state|journal|skill-swaps|skill-prepares)(?:\/|$)/i,
  }),
  Object.freeze({
    id: "software_manager_server_environment",
    pattern: /(?:^|\/)deploy\/codexbridge-installer\/[^/]*\.env(?:\.[^/]+)?$/i,
  }),
  Object.freeze({
    id: "runtime_secret_config",
    pattern: /^\/config\/(?:router\.config|secrets\.local)\.json$/i,
  }),
  Object.freeze({
    id: "runtime_state_backup",
    pattern: /(?:^|\/)(?:state(?:_\d+)?\.sqlite(?:\.(?:bak|backup|shm|wal))?|response-history\.sqlite(?:-(?:shm|wal))?)$/i,
  }),
]);

function normalizedPackagePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  return `/${normalized}`;
}

export function packageRuleForPath(value) {
  const normalized = normalizedPackagePath(value);
  return WINDOWS_PACKAGE_HARDENING_RULES.find((rule) => rule.pattern.test(normalized)) || null;
}

export function shouldIgnoreWindowsPackagePath(value) {
  return Boolean(packageRuleForPath(value));
}

export function auditWindowsPackageFilePaths(filePaths = []) {
  const violations = [];
  for (const value of filePaths) {
    const normalized = normalizedPackagePath(value);
    const rule = packageRuleForPath(normalized);
    if (rule) {
      violations.push({ path: normalized.slice(1), rule: rule.id });
    }
  }
  return violations;
}

export function assertWindowsPackageFilePaths(filePaths = []) {
  const violations = auditWindowsPackageFilePaths(filePaths);
  if (violations.length) {
    const preview = violations
      .slice(0, 10)
      .map((violation) => `${violation.rule}: ${violation.path}`)
      .join("; ");
    const error = new Error(
      `Windows package contains ${violations.length} forbidden file(s): ${preview}`,
    );
    error.code = "forbidden_package_content";
    Object.defineProperty(error, "violations", {
      configurable: false,
      enumerable: false,
      value: violations,
      writable: false,
    });
    throw error;
  }
  return {
    checkedFiles: filePaths.length,
    forbiddenFiles: 0,
    forbiddenByRule: {},
  };
}

export function assertWindowsSoftwareManagerPackagePaths(filePaths = []) {
  assertWindowsPackageFilePaths(filePaths);
  const normalized = new Set(filePaths.map((value) => normalizedPackagePath(value).slice(1).toLowerCase()));
  const missing = REQUIRED_SOFTWARE_MANAGER_PATHS.filter((value) => !normalized.has(value.toLowerCase()));
  if (missing.length) {
    const error = new Error(`Windows software-manager runtime is incomplete: ${missing.join(", ")}`);
    error.code = "software_manager_package_runtime_missing";
    Object.defineProperty(error, "missing", { enumerable: false, value: missing });
    throw error;
  }
  return { checkedFiles: filePaths.length, requiredFiles: REQUIRED_SOFTWARE_MANAGER_PATHS.length };
}

export function buildSoftwareManagerReleaseReadiness({ repoRoot = process.cwd(), env = process.env } = {}) {
  const sevenZipPath = path.join(repoRoot, "node_modules", "7zip-bin", "win", "x64", "7za.exe");
  const licensePath = path.join(repoRoot, "node_modules", "7zip-bin", "LICENSE.txt");
  const fixedCatalogUrl = `${TEST_CATALOG_ORIGIN}${TEST_CATALOG_PATH}`;
  const expectedCatalogUrl = "https://shanhaiyouling.com/codexbridge-install-test/component-catalog.json";
  const actualHash = hashExistingFile(sevenZipPath);
  const fakeKey = readFakeHostPublicKey(env);
  const embeddedKeyReady = validEmbeddedPublicKey();
  const trustReady = embeddedKeyReady || fakeKey !== null;
  const items = [
    readinessItem("software_manager_catalog_url", fixedCatalogUrl === expectedCatalogUrl,
      fixedCatalogUrl, "Keep the software manager on the isolated test catalog URL."),
    readinessItem("software_manager_7zip", actualHash === PINNED_SEVEN_ZIP_X64_SHA256,
      actualHash || "missing", "Restore the pinned 7zip-bin x64 executable."),
    readinessItem("software_manager_7zip_license", fileIsNonempty(licensePath),
      licensePath, "Include the 7zip-bin license in the Windows package."),
    readinessItem("software_manager_private_key_policy",
      WINDOWS_PACKAGE_HARDENING_RULES.some((rule) => rule.id === "private_key_material"),
      "private key extensions are forbidden", "Restore the private-key package exclusion rule."),
    {
      id: trustReady ? "software_manager_catalog_trust" : "catalog_trust_not_provisioned",
      label: "Software manager catalog trust",
      status: trustReady ? "pass" : "fail",
      detail: trustReady
        ? (embeddedKeyReady ? "embedded public key is provisioned" : "ephemeral fake-host public key is valid")
        : "The isolated catalog public key has not been provisioned.",
      action: trustReady ? "" : "Provision the independent test-environment public key before release.",
    },
  ];
  return Object.freeze({
    ok: items.every((item) => item.status === "pass"),
    items: Object.freeze(items.map((item) => Object.freeze(item))),
  });
}

function hashExistingFile(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return "";
  }
}

function fileIsNonempty(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function validEmbeddedPublicKey() {
  if (typeof CATALOG_PUBLIC_KEY_SPKI !== "string" || !CATALOG_PUBLIC_KEY_SPKI.trim()
    || !/^[a-f0-9]{64}$/u.test(CATALOG_PUBLIC_KEY_SHA256 ?? "")) return false;
  try {
    const key = crypto.createPublicKey(CATALOG_PUBLIC_KEY_SPKI);
    const der = key.export({ type: "spki", format: "der" });
    return crypto.createHash("sha256").update(der).digest("hex") === CATALOG_PUBLIC_KEY_SHA256;
  } catch {
    return false;
  }
}

function readFakeHostPublicKey(env) {
  if (env?.CODEXBRIDGE_SOFTWARE_MANAGER_FAKE_HOST !== "1") return null;
  const filePath = String(env?.CODEXBRIDGE_SOFTWARE_MANAGER_FAKE_PUBLIC_KEY_FILE || "").trim();
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    return crypto.createPublicKey(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readinessItem(id, passed, detail, action) {
  return {
    id,
    label: id,
    status: passed ? "pass" : "fail",
    detail,
    action: passed ? "" : action,
  };
}
