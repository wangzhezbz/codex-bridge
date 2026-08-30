export const COMPONENT_IDS = Object.freeze(["chatgpt", "v2rayn", "git"]);
export const MAX_SOFTWARE_PACKAGE_BYTES = 16 * 1_024 * 1_024 * 1_024;
export const MAX_SOFTWARE_PACKAGE_ENTRIES = 16_384;
export const TEST_CATALOG_ORIGIN = "https://shanhaiyouling.com";
export const TEST_CATALOG_PATH = "/codexbridge-install-test/component-catalog.json";
export const TEST_PACKAGE_PATH = "/codexbridge-test/packages/";
export const TEST_COS_PACKAGE_ORIGIN = "https://codex-1431412335.cos.ap-guangzhou.myqcloud.com";
export const TEST_COS_PACKAGE_PATH = "/codexbridge-test/packages/";
export const TEST_DOGECLOUD_PACKAGE_ORIGIN = "https://download.shanhaiyouling.com";
export const TEST_DOGECLOUD_PACKAGE_PATH = "/codexbridge-test/packages/";

const COMPONENT_KEYS = new Set([
  "id", "name", "version", "architecture", "format", "assetUrl", "size", "sha256",
  "entrypoint", "requiredFiles", "maxRelativePathLength", "publishedAt", "supportsRollback",
]);
const SKILL_KEYS = new Set(["id", "name", "description", "version", "assetUrl", "size", "sha256", "files"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^\d+(?:\.\d+){0,3}$/;

export function catalogError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function compareVersions(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !VERSION_PATTERN.test(left) || !VERSION_PATTERN.test(right)) {
    throw catalogError("catalog_version_invalid");
  }
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export function resolveCatalogAssetUrl(catalogUrl, assetUrl) {
  if (typeof assetUrl !== "string" || /%(?:2e|2f|5c)/i.test(assetUrl)) {
    throw catalogError("catalog_asset_url_rejected");
  }
  let resolved;
  try {
    resolved = new URL(assetUrl, catalogUrl);
  } catch {
    throw catalogError("catalog_asset_url_invalid");
  }
  const authorizedPackagePath = resolved.origin === TEST_CATALOG_ORIGIN
    ? TEST_PACKAGE_PATH
    : resolved.origin === TEST_COS_PACKAGE_ORIGIN ? TEST_COS_PACKAGE_PATH
      : resolved.origin === TEST_DOGECLOUD_PACKAGE_ORIGIN ? TEST_DOGECLOUD_PACKAGE_PATH : null;
  if (resolved.protocol !== "https:" || authorizedPackagePath === null
    || !resolved.pathname.startsWith(authorizedPackagePath) || resolved.pathname === authorizedPackagePath
    || resolved.search || resolved.hash) {
    throw catalogError("catalog_asset_url_rejected");
  }
  return resolved.href;
}

export function parseCatalog(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, new Set(["schemaVersion", "components", "skills"]))) {
    throw catalogError("catalog_schema_invalid");
  }
  if (value.schemaVersion !== 1 || !Array.isArray(value.components) || !Array.isArray(value.skills)) {
    throw catalogError("catalog_schema_invalid");
  }

  const componentIds = new Set();
  const skillIds = new Set();
  const components = value.components.map((component) => parseComponent(component, componentIds));
  const skills = value.skills.map((skill) => parseSkill(skill, skillIds));
  return Object.freeze({ components: Object.freeze(components), schemaVersion: 1, skills: Object.freeze(skills) });
}

function parseComponent(component, ids) {
  if (!isPlainObject(component) || !hasOnlyKeys(component, COMPONENT_KEYS)) throw catalogError("catalog_component_invalid");
  if (!COMPONENT_IDS.includes(component.id)) throw catalogError("catalog_component_id_invalid");
  if (ids.has(component.id)) throw catalogError("catalog_component_id_duplicate");
  ids.add(component.id);
  if (!isSafeAssetUrl(component.assetUrl)) throw catalogError("catalog_asset_url_invalid");
  if (!isNonEmptyString(component.name) || !VERSION_PATTERN.test(component.version)
    || !["x64", "arm64"].includes(component.architecture) || !["zip", "7z", "exe"].includes(component.format)
    || !isSoftwarePackageSize(component.size)
    || !SHA256_PATTERN.test(component.sha256) || !isSafeRelativePath(component.entrypoint)
    || !isSafePathList(component.requiredFiles) || !isPositiveSafeInteger(component.maxRelativePathLength)
    || !isIsoDate(component.publishedAt) || typeof component.supportsRollback !== "boolean") {
    throw catalogError("catalog_component_invalid");
  }
  return Object.freeze({ ...component, requiredFiles: Object.freeze([...component.requiredFiles]) });
}

function parseSkill(skill, ids) {
  if (!isPlainObject(skill) || !hasOnlyKeys(skill, SKILL_KEYS)) throw catalogError("catalog_skill_invalid");
  if (!isSafeId(skill.id)) throw catalogError("catalog_skill_id_invalid");
  if (ids.has(skill.id)) throw catalogError("catalog_skill_id_duplicate");
  ids.add(skill.id);
  if (!isSafeAssetUrl(skill.assetUrl)) throw catalogError("catalog_asset_url_invalid");
  if (!isNonEmptyString(skill.name) || !isNonEmptyString(skill.description) || !VERSION_PATTERN.test(skill.version)
    || !isSoftwarePackageSize(skill.size)
    || !SHA256_PATTERN.test(skill.sha256) || !isSafePathList(skill.files) || !skill.files.includes("SKILL.md")) {
    throw catalogError("catalog_skill_invalid");
  }
  return Object.freeze({ ...skill, files: Object.freeze([...skill.files]) });
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.has(key)) && Object.keys(value).length === allowedKeys.size;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSoftwarePackageSize(value) {
  return isPositiveSafeInteger(value) && value <= MAX_SOFTWARE_PACKAGE_BYTES;
}

function isSafeId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isSafeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.startsWith("/") && !value.split("/").includes("..");
}

function isSafePathList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isSafeRelativePath) && new Set(value).size === value.length;
}

function isSafeAssetUrl(value) {
  try {
    resolveCatalogAssetUrl(`${TEST_CATALOG_ORIGIN}${TEST_CATALOG_PATH}`, value);
    return true;
  } catch {
    return false;
  }
}

function isIsoDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
