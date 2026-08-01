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
