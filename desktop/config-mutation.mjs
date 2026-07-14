import { createHash } from "node:crypto";

export const CODEXBRIDGE_MANAGED_TOML_START = "# >>> CodexBridge managed config";
export const CODEXBRIDGE_MANAGED_TOML_END = "# <<< CodexBridge managed config";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const CODEXBRIDGE_MANAGED_TOP_LEVEL_KEYS = new Set([
  "model_provider",
  "model",
  "model_catalog_json",
  "model_reasoning_effort",
  "sandbox_mode",
  "approval_policy",
]);
const draftState = new WeakMap();
const candidateState = new WeakMap();

function configMutationError(code, message, properties = {}) {
  const error = new Error(message);
  error.name = "ConfigMutationError";
  error.code = code;
  for (const [key, value] of Object.entries(properties)) {
    error[key] = value;
  }
  return error;
}

function safeBytes(value, code = "config_draft_input_invalid") {
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  throw configMutationError(code, "Configuration bytes are invalid");
}

function newlineForBytes(bytes) {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d) {
      return bytes[index + 1] === 0x0a ? "\r\n" : "\r";
    }
    if (bytes[index] === 0x0a) {
      return "\n";
    }
  }
  return "\n";
}

function tomlLines(bytes) {
  const lines = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index < bytes.length && bytes[index] !== 0x0a && bytes[index] !== 0x0d) {
      continue;
    }
    let newlineEnd = index;
    let newline = "";
    if (index < bytes.length) {
      if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) {
        newlineEnd = index + 2;
        newline = "\r\n";
        index += 1;
      } else {
        newlineEnd = index + 1;
        newline = bytes[index] === 0x0d ? "\r" : "\n";
      }
    }
    lines.push({
      start,
      end: index - (newline === "\r\n" ? 1 : 0),
      newlineEnd,
      newline,
      text: bytes.subarray(start, index - (newline === "\r\n" ? 1 : 0)).toString("utf8"),
    });
    start = newlineEnd;
  }
  return lines;
}

function normalizedMarkerLine(line) {
  return String(line || "").replace(/^\uFEFF/, "").trim();
}

function isMarkerLike(line) {
  const normalized = normalizedMarkerLine(line);
  return (
    /(?:>>>|<<<)\s*CodexBridge\s+managed/i.test(normalized) ||
    /CodexBridge\s+managed\s+config/i.test(normalized)
  );
}

function inspectManagedToml(bytes) {
  const lines = tomlLines(bytes);
  const starts = [];
  const ends = [];
  let malformed = false;

  for (const line of lines) {
    const normalized = normalizedMarkerLine(line.text);
    if (normalized === CODEXBRIDGE_MANAGED_TOML_START) {
      starts.push(line);
    } else if (normalized === CODEXBRIDGE_MANAGED_TOML_END) {
      ends.push(line);
    } else if (isMarkerLike(line.text)) {
      malformed = true;
    }
  }

  if (malformed || starts.length !== ends.length || starts.length > 1) {
    throw configMutationError("managed_toml_invalid", "Managed TOML markers are invalid");
  }
  if (starts.length === 0) {
    return {
      state: "unmanaged",
      newline: newlineForBytes(bytes),
      startOffset: null,
      endOffset: null,
    };
  }
  if (starts[0].start >= ends[0].start) {
    throw configMutationError("managed_toml_invalid", "Managed TOML markers are invalid");
  }

  const bomOffset = starts[0].start === 0 && bytes.subarray(0, 3).equals(UTF8_BOM) ? 3 : 0;
  return {
    state: "managed",
    newline: starts[0].newline || newlineForBytes(bytes),
    startOffset: starts[0].start + bomOffset,
    endOffset: ends[0].end,
  };
}

export function inspectManagedCodexTomlBlock(content) {
  const bytes = safeBytes(content, "managed_toml_invalid");
  return inspectManagedToml(bytes);
}

function normalizedManagedReplacement(content, newline) {
  const bytes = safeBytes(content, "managed_toml_replacement_invalid");
  let inspected;
  try {
    inspected = inspectManagedToml(bytes);
  } catch {
    throw configMutationError(
      "managed_toml_replacement_invalid",
      "Managed TOML replacement is invalid",
    );
  }
  if (inspected.state !== "managed") {
    throw configMutationError(
      "managed_toml_replacement_invalid",
      "Managed TOML replacement is invalid",
    );
  }
  const prefix = bytes.subarray(0, inspected.startOffset).toString("utf8");
  const suffix = bytes.subarray(inspected.endOffset).toString("utf8");
  if (prefix.trim() || suffix.trim()) {
    throw configMutationError(
      "managed_toml_replacement_invalid",
      "Managed TOML replacement is invalid",
    );
  }
  const block = bytes
    .subarray(inspected.startOffset, inspected.endOffset)
    .toString("utf8")
    .split(/\r\n|\n|\r/)
    .join(newline);
  return Buffer.from(block, "utf8");
}

export function replaceManagedCodexTomlBlock(originalContent, managedBlock) {
  const original = safeBytes(originalContent, "managed_toml_invalid");
  const inspected = inspectManagedToml(original);
  const newline = inspected.newline || "\n";
  const replacement = normalizedManagedReplacement(managedBlock, newline);

  if (inspected.state === "managed") {
    return Buffer.concat([
      original.subarray(0, inspected.startOffset),
      replacement,
      original.subarray(inspected.endOffset),
    ]);
  }

  const hasBom = original.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  const prefix = hasBom ? original.subarray(0, UTF8_BOM.length) : Buffer.alloc(0);
  const body = hasBom ? original.subarray(UTF8_BOM.length) : original;
  const separator = Buffer.from(body.length ? `${newline}${newline}` : newline, "utf8");
  return Buffer.concat([prefix, replacement, separator, body]);
}

export function removeManagedCodexTomlBlock(content) {
  const bytes = safeBytes(content, "managed_toml_invalid");
  const inspected = inspectManagedToml(bytes);
  if (inspected.state === "unmanaged") {
    return Buffer.from(bytes);
  }
  return Buffer.concat([
    bytes.subarray(0, inspected.startOffset),
    bytes.subarray(inspected.endOffset),
  ]);
}

function decodeTomlQuotedKey(raw, quote) {
  if (quote === "'") {
    return raw.slice(1, -1);
  }
  try {
    const jsonCompatible = raw.replace(/\\U([0-9A-Fa-f]{8})/g, (_match, digits) => {
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10ffff) {
        throw new RangeError("invalid TOML key code point");
      }
      return JSON.stringify(String.fromCodePoint(codePoint)).slice(1, -1);
    });
    const parsed = JSON.parse(jsonCompatible);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function parseTomlDottedKey(input) {
  const value = String(input || "");
  const segments = [];
  let index = 0;

  const skipWhitespace = () => {
    while (index < value.length && /\s/.test(value[index])) {
      index += 1;
    }
  };

  while (index < value.length) {
    skipWhitespace();
    if (index >= value.length) {
      return null;
    }

    const quote = value[index] === '"' || value[index] === "'" ? value[index] : null;
    let segment = "";
    if (quote) {
      const rawStart = index;
      index += 1;
      let escaped = false;
      while (index < value.length) {
        if (quote === '"' && escaped) {
          escaped = false;
        } else if (quote === '"' && value[index] === "\\") {
          escaped = true;
        } else if (value[index] === quote) {
          break;
        }
        index += 1;
      }
      if (index >= value.length || value[index] !== quote) {
        return null;
      }
      index += 1;
      segment = decodeTomlQuotedKey(value.slice(rawStart, index), quote);
    } else {
      const start = index;
      while (index < value.length && /[A-Za-z0-9_-]/.test(value[index])) {
        index += 1;
      }
      segment = value.slice(start, index);
    }
    if (!segment) {
      return null;
    }
    segments.push(segment);

    skipWhitespace();
    if (index >= value.length) {
      return segments;
    }
    if (value[index] !== ".") {
      return null;
    }
    index += 1;
  }
  return null;
}

function tomlAssignmentKey(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "=") {
      return line.slice(0, index);
    } else if (character === "#") {
      return null;
    }
  }
  return null;
}

function tomlTableKey(line) {
  const trimmed = line.trim();
  const arrayTable = trimmed.startsWith("[[");
  const startLength = arrayTable ? 2 : trimmed.startsWith("[") ? 1 : 0;
  if (!startLength) {
    return null;
  }
  const closing = arrayTable ? "]]" : "]";
  const end = trimmed.indexOf(closing, startLength);
  if (end < 0 || !/^(?:\s*#.*)?$/.test(trimmed.slice(end + closing.length))) {
    return null;
  }
  return parseTomlDottedKey(trimmed.slice(startLength, end));
}

function isCodexBridgeOwnedTomlPath(pathSegments) {
  return (
    (pathSegments.length === 1 && CODEXBRIDGE_MANAGED_TOP_LEVEL_KEYS.has(pathSegments[0])) ||
    (pathSegments.length === 1 && pathSegments[0] === "model_providers") ||
    (pathSegments[0] === "model_providers" && pathSegments[1] === "codexbridge")
  );
}

function tomlTableConflictsWithCodexBridge(pathSegments, { arrayTable = false } = {}) {
  return !(
    !arrayTable &&
    pathSegments.length === 1 &&
    pathSegments[0] === "model_providers"
  ) && isCodexBridgeOwnedTomlPath(pathSegments);
}

function unmanagedTomlHasCodexBridgeConflict(bytes) {
  let currentTable = [];
  for (const line of tomlLines(bytes)) {
    const text = normalizedMarkerLine(line.text);
    if (!text || text.startsWith("#")) {
      continue;
    }
    if (text.startsWith("[")) {
      const tableKey = tomlTableKey(text);
      if (tableKey) {
        currentTable = tableKey;
        if (tomlTableConflictsWithCodexBridge(tableKey, {
          arrayTable: text.startsWith("[["),
        })) {
          return true;
        }
      }
      continue;
    }
    const assignmentKey = tomlAssignmentKey(text);
    if (!assignmentKey) {
      continue;
    }
    const keyPath = parseTomlDottedKey(assignmentKey);
    if (keyPath && isCodexBridgeOwnedTomlPath([...currentTable, ...keyPath])) {
      return true;
    }
  }
  return false;
}

function unmanagedAssignmentConflictsWithCodexBridge(currentTable, keyPath) {
  const fullPath = [...currentTable, ...keyPath];
  if (currentTable.length === 0) {
    return (
      (keyPath.length === 1 && CODEXBRIDGE_MANAGED_TOP_LEVEL_KEYS.has(keyPath[0])) ||
      (keyPath[0] === "model_providers" &&
        (keyPath.length === 1 || keyPath[1] === "codexbridge"))
    );
  }
  return (
    (fullPath[0] === "model_providers" && fullPath[1] === "codexbridge") ||
    (currentTable.length === 1 &&
      currentTable[0] === "model_providers" &&
      keyPath[0] === "codexbridge")
  );
}

export function removeUnmanagedCodexBridgeConflicts(content) {
  const bytes = safeBytes(content, "managed_toml_invalid");
  if (inspectManagedToml(bytes).state !== "unmanaged") {
    return Buffer.from(bytes);
  }
  const kept = [];
  let currentTable = [];
  let dropCurrentTable = false;
  for (const line of tomlLines(bytes)) {
    const text = normalizedMarkerLine(line.text);
    if (text.startsWith("[")) {
      const tableKey = tomlTableKey(text);
      if (tableKey) {
        currentTable = tableKey;
        dropCurrentTable =
          tableKey[0] === "model_providers" && tableKey[1] === "codexbridge";
      }
    }
    let remove = dropCurrentTable;
    if (!remove && text && !text.startsWith("#") && !text.startsWith("[")) {
      const assignmentKey = tomlAssignmentKey(text);
      const keyPath = assignmentKey ? parseTomlDottedKey(assignmentKey) : null;
      remove = Boolean(
        keyPath && unmanagedAssignmentConflictsWithCodexBridge(currentTable, keyPath),
      );
    }
    if (!remove) {
      kept.push(bytes.subarray(line.start, line.newlineEnd));
    }
  }
  return Buffer.concat(kept);
}

function assertJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("non-finite number");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError("unsupported JSON value");
  }
  if (seen.has(value)) {
    throw new TypeError("cyclic JSON value");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new TypeError("non-plain JSON object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("symbol JSON key");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonValue(item, seen);
    }
  } else {
    for (const item of Object.values(value)) {
      assertJsonValue(item, seen);
    }
  }
  seen.delete(value);
}

function jsonSnapshot(value, stage) {
  try {
    assertJsonValue(value);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const parsed = JSON.parse(text);
    deepFreeze(parsed);
    return { value: parsed, bytes: Buffer.from(text, "utf8") };
  } catch {
    throw configMutationError(
      "config_draft_json_invalid",
      "Configuration JSON is invalid",
      { stage },
    );
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return Object.freeze(value);
}

function requiredString(value, stage) {
  if (typeof value !== "string" || !value.trim()) {
    throw configMutationError("config_draft_input_invalid", "Configuration draft input is invalid", {
      stage,
    });
  }
  return value;
}

function originalSnapshot(input, stage) {
  if (!("originalBytes" in input)) {
    return { provided: false, bytes: undefined };
  }
  if (input.originalBytes === null) {
    return { provided: true, bytes: null };
  }
  return {
    provided: true,
    bytes: safeBytes(input.originalBytes, "config_draft_input_invalid"),
    stage,
  };
}

function candidateDescriptor({
  id,
  role,
  target,
  bytes,
  sensitive = false,
  original = { provided: false, bytes: undefined },
}) {
  const descriptor = Object.freeze({
    id,
    role,
    target: requiredString(target, role),
    sensitive: Boolean(sensitive),
    mode: sensitive ? 0o600 : undefined,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    originalState: original.provided ? (original.bytes === null ? "missing" : "file") : "unchecked",
  });
  candidateState.set(descriptor, {
    bytes: Buffer.from(bytes),
    original: {
      provided: original.provided,
      bytes: original.bytes === null || original.bytes === undefined
        ? original.bytes
        : Buffer.from(original.bytes),
    },
  });
  return descriptor;
}

function runDerivation(stage, callback, context) {
  if (typeof callback !== "function") {
    throw configMutationError("config_draft_input_invalid", "Configuration draft input is invalid", {
      stage,
    });
  }
  try {
    return callback(context);
  } catch {
    throw configMutationError(
      "config_draft_derivation_failed",
      "Configuration derivation failed",
      { stage },
    );
  }
}

function sourceSnapshots(sources) {
  if (!Array.isArray(sources)) {
    throw configMutationError("config_draft_input_invalid", "Configuration draft input is invalid", {
      stage: "sources",
    });
  }
  const seen = new Set();
  return sources.map((source) => {
    const id = requiredString(source?.id, "source");
    if (seen.has(id) || id.includes(":")) {
      throw configMutationError("config_draft_input_invalid", "Configuration draft input is invalid", {
        stage: "source",
      });
    }
    seen.add(id);
    const snapshot = jsonSnapshot(source.value, "source");
    return {
      id,
      target: requiredString(source.target, "source"),
      sensitive: Boolean(source.sensitive),
      original: originalSnapshot(source, "source"),
      ...snapshot,
    };
  });
}

function catalogModelIds(catalog) {
  if (!catalog || !Array.isArray(catalog.models)) {
    return null;
  }
  const ids = catalog.models.map((model) => String(model?.slug || model?.id || "").trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    return null;
  }
  return ids;
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function tomlValueWithoutComment(value) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function managedTomlAssignments(block) {
  const inspected = inspectManagedToml(block);
  if (inspected.state !== "managed") {
    return [];
  }
  const content = block.subarray(inspected.startOffset, inspected.endOffset).toString("utf8");
  const assignments = [];
  let currentTable = [];
  for (const line of tomlLines(Buffer.from(content, "utf8"))) {
    const text = normalizedMarkerLine(line.text);
    if (!text || text.startsWith("#")) {
      continue;
    }
    if (text.startsWith("[")) {
      const tableKey = tomlTableKey(text);
      if (tableKey) {
        currentTable = tableKey;
      }
      continue;
    }
    const assignmentKey = tomlAssignmentKey(text);
    if (!assignmentKey) {
      continue;
    }
    const keyPath = parseTomlDottedKey(assignmentKey);
    if (!keyPath) {
      continue;
    }
    assignments.push({
      path: [...currentTable, ...keyPath],
      value: tomlValueWithoutComment(text.slice(assignmentKey.length + 1)),
    });
  }
  return assignments;
}

function sameTomlPath(left, right) {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function managedTomlValues(assignments, path) {
  return assignments
    .filter((assignment) => sameTomlPath(assignment.path, path))
    .map((assignment) => assignment.value);
}

function parseTomlStringValue(value) {
  const text = String(value || "").trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1);
  }
  return null;
}

function managedTomlString(assignments, path) {
  const values = managedTomlValues(assignments, path);
  return values.length === 1 ? parseTomlStringValue(values[0]) : null;
}

function managedTomlProviderContractIsValid({ assignments, mode, routerPort }) {
  const providerPath = ["model_providers", "codexbridge"];
  const headerPath = [...providerPath, "http_headers"];
  const port = Number(routerPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return false;
  }
  const authValues = managedTomlValues(assignments, [...providerPath, "requires_openai_auth"]);
  const headerAssignments = assignments.filter(({ path }) => (
    path.length >= headerPath.length &&
    headerPath.every((segment, index) => path[index] === segment)
  ));
  if (mode === "hybrid") {
    const providerAssignments = assignments.filter(({ path }) => (
      path.length >= providerPath.length &&
      providerPath.every((segment, index) => path[index] === segment)
    ));
    return (
      managedTomlString(assignments, ["model_provider"]) === "openai" &&
      managedTomlString(assignments, ["openai_base_url"]) === `http://127.0.0.1:${port}/v1` &&
      providerAssignments.length === 0 &&
      authValues.length === 0 &&
      headerAssignments.length === 0
    );
  }
  if (
    managedTomlString(assignments, ["model_provider"]) !== "codexbridge" ||
    managedTomlString(assignments, [...providerPath, "base_url"])
      !== `http://127.0.0.1:${port}/v1` ||
    managedTomlString(assignments, [...providerPath, "wire_api"]) !== "responses"
  ) {
    return false;
  }
  if (mode !== "all_api" || authValues.length !== 1 || authValues[0] !== "false") {
    return false;
  }
  if (headerAssignments.length !== 1) {
    return false;
  }
  const [header] = headerAssignments;
  if (sameTomlPath(header.path, headerPath)) {
    return /^\{\s*Authorization\s*=\s*"Bearer sk-local-codex-router"\s*\}$/.test(header.value);
  }
  return (
    sameTomlPath(header.path, [...headerPath, "Authorization"]) &&
    parseTomlStringValue(header.value) === "Bearer sk-local-codex-router"
  );
}

function validateCrossFileState(state, contentById) {
  let selection;
  let routerConfig;
  let rootCatalog;
  let codexCatalog;
  let codexConfig;
  try {
    selection = JSON.parse(contentById.get("selection").toString("utf8"));
    JSON.parse(contentById.get("options").toString("utf8"));
    routerConfig = JSON.parse(contentById.get("routerConfig").toString("utf8"));
    rootCatalog = JSON.parse(contentById.get("rootCatalog").toString("utf8"));
    codexCatalog = state.includeCodexCatalog
      ? JSON.parse(contentById.get("codexCatalog").toString("utf8"))
      : null;
    codexConfig = state.includeCodexConfig ? contentById.get("codexConfig") : null;
  } catch {
    throw configMutationError("config_draft_inconsistent", "Configuration draft is inconsistent");
  }

  const selectedIds = Array.isArray(selection?.selectedModelIds)
    ? selection.selectedModelIds.map((id) => String(id || "").trim())
    : [];
  const routerModels = Array.isArray(routerConfig?.models) ? routerConfig.models : [];
  const routeIds = routerModels.map((model) => String(model?.id || "").trim());
  const sourceIds = routerModels.map((model) => String(model?.sourcePresetId || "").trim());
  const rootIds = catalogModelIds(rootCatalog);
  const codexIds = state.includeCodexCatalog ? catalogModelIds(codexCatalog) : null;
  const catalogsMatch = !state.includeCodexCatalog || contentById
    .get("rootCatalog")
    .equals(contentById.get("codexCatalog"));
  const managedAssignments = state.includeCodexConfig
    ? managedTomlAssignments(codexConfig)
    : [];
  const selectedModel = state.includeCodexConfig
    ? managedTomlString(managedAssignments, ["model"])
    : null;
  const catalogPath = state.includeCodexConfig
    ? managedTomlString(managedAssignments, ["model_catalog_json"])
    : null;
  const expectedCatalogPath = state.codexCatalogTarget?.replaceAll("\\", "/") || "";

  if (
    selection?.mode !== state.mode ||
    routerConfig?.mode !== state.mode ||
    routerConfig?.configRevision !== state.configRevision ||
    selectedIds.length === 0 ||
    selectedIds.some((id) => !id) ||
    new Set(selectedIds).size !== selectedIds.length ||
    routeIds.length === 0 ||
    routeIds.some((id) => !id) ||
    new Set(routeIds).size !== routeIds.length ||
    !sameStrings(sourceIds, selectedIds) ||
    !routeIds.includes(routerConfig?.defaultModel) ||
    !rootIds ||
    !sameStrings(rootIds, routeIds) ||
    (state.includeCodexCatalog && (!codexIds || !sameStrings(codexIds, routeIds))) ||
    !catalogsMatch ||
    (state.includeCodexConfig && !routeIds.includes(selectedModel)) ||
    (state.includeCodexConfig && catalogPath?.replaceAll("\\", "/") !== expectedCatalogPath) ||
    (state.includeCodexConfig && !managedTomlProviderContractIsValid({
      assignments: managedAssignments,
      mode: state.mode,
      routerPort: routerConfig?.port,
    }))
  ) {
    throw configMutationError("config_draft_inconsistent", "Configuration draft is inconsistent");
  }
}

function contentMapForDraft(state) {
  return new Map(
    state.candidates.map((candidate) => [
      candidate.id,
      Buffer.from(candidateState.get(candidate).bytes),
    ]),
  );
}

export function buildConfigMutationDraft(spec = {}) {
  const operation = requiredString(spec.operation, "operation");
  const configRevision = requiredString(spec.configRevision, "configRevision");
  const mode = requiredString(spec.mode, "mode");
  const sources = sourceSnapshots(spec.sources ?? []);
  const includeCodexConfig = spec.includeCodexConfig !== false;
  const includeCodexCatalog = spec.includeCodexCatalog !== false;
  if (includeCodexConfig && !includeCodexCatalog) {
    throw configMutationError("config_draft_input_invalid", "Configuration draft input is invalid", {
      stage: "codex_config",
    });
  }
  const codexConfigHasCurrentBytes = Object.prototype.hasOwnProperty.call(
    spec.codexConfig || {},
    "currentBytes",
  );
  const codexCurrentBytes = codexConfigHasCurrentBytes
    ? safeBytes(spec.codexConfig.currentBytes, "config_draft_input_invalid")
    : Buffer.alloc(0);
  let codexTomlInspection;
  try {
    codexTomlInspection = inspectManagedToml(codexCurrentBytes);
  } catch {
    throw configMutationError("config_draft_toml_invalid", "Managed TOML candidate is invalid", {
      stage: "managed_toml",
    });
  }
  if (
    includeCodexConfig &&
    codexTomlInspection.state === "unmanaged" &&
    spec.allowManagedBlockInsert !== true
  ) {
    throw configMutationError(
      "config_draft_toml_unmanaged",
      "Managed TOML insertion is not allowed",
      { stage: "managed_toml" },
    );
  }
  if (
    includeCodexConfig &&
    codexTomlInspection.state === "unmanaged" &&
    unmanagedTomlHasCodexBridgeConflict(codexCurrentBytes)
  ) {
    throw configMutationError(
      "config_draft_toml_conflict",
      "Unmanaged TOML conflicts with the managed configuration",
      { stage: "managed_toml" },
    );
  }
  const selection = jsonSnapshot(spec.selection?.value, "selection");
  const options = jsonSnapshot(spec.options?.value, "options");
  const frozenSources = Object.freeze(Object.fromEntries(
    sources.map((source) => [source.id, source.value]),
  ));
  const baseContext = Object.freeze({
    operation,
    configRevision,
    mode,
    sources: frozenSources,
    selection: selection.value,
    options: options.value,
  });

  const routerResult = runDerivation("router", spec.buildRouterConfig, baseContext);
  const router = jsonSnapshot(routerResult, "router");
  const routerContext = Object.freeze({ ...baseContext, routerConfig: router.value });
  const rootCatalog = jsonSnapshot(
    runDerivation("root_catalog", spec.buildRootCatalog, routerContext),
    "root_catalog",
  );
  const codexCatalog = includeCodexCatalog
    ? jsonSnapshot(
        runDerivation("codex_catalog", spec.buildCodexCatalog, routerContext),
        "codex_catalog",
      )
    : null;
  const tomlContext = Object.freeze({
    ...routerContext,
    rootCatalog: rootCatalog.value,
    codexCatalog: codexCatalog?.value ?? null,
  });
  let codexConfigBytes = null;
  if (includeCodexConfig) {
    const managedBlock = runDerivation(
      "managed_toml",
      spec.buildManagedCodexBlock,
      tomlContext,
    );
    try {
      codexConfigBytes = replaceManagedCodexTomlBlock(codexCurrentBytes, managedBlock);
    } catch {
      throw configMutationError("config_draft_toml_invalid", "Managed TOML candidate is invalid", {
        stage: "managed_toml",
      });
    }
  }

  const candidates = [
    ...sources.map((source) => candidateDescriptor({
      id: `source:${source.id}`,
      role: "source",
      target: source.target,
      bytes: source.bytes,
      sensitive: source.sensitive,
      original: source.original,
    })),
    candidateDescriptor({
      id: "selection",
      role: "selection",
      target: spec.selection?.target,
      bytes: selection.bytes,
      original: originalSnapshot(spec.selection || {}, "selection"),
    }),
    candidateDescriptor({
      id: "options",
      role: "options",
      target: spec.options?.target,
      bytes: options.bytes,
      original: originalSnapshot(spec.options || {}, "options"),
    }),
    candidateDescriptor({
      id: "routerConfig",
      role: "router",
      target: spec.router?.target,
      bytes: router.bytes,
      original: originalSnapshot(spec.router || {}, "router"),
    }),
    candidateDescriptor({
      id: "rootCatalog",
      role: "root_catalog",
      target: spec.rootCatalog?.target,
      bytes: rootCatalog.bytes,
      original: originalSnapshot(spec.rootCatalog || {}, "root_catalog"),
    }),
    ...(includeCodexCatalog ? [candidateDescriptor({
      id: "codexCatalog",
      role: "codex_catalog",
      target: spec.codexCatalog?.target,
      bytes: codexCatalog.bytes,
      original: originalSnapshot(spec.codexCatalog || {}, "codex_catalog"),
    })] : []),
    ...(includeCodexConfig ? [candidateDescriptor({
      id: "codexConfig",
      role: "managed_toml",
      target: spec.codexConfig?.target,
      bytes: codexConfigBytes,
      sensitive: true,
      original: Object.prototype.hasOwnProperty.call(spec.codexConfig || {}, "originalBytes")
        ? originalSnapshot(spec.codexConfig, "managed_toml")
        : codexConfigHasCurrentBytes
          ? { provided: true, bytes: Buffer.from(codexCurrentBytes) }
          : { provided: true, bytes: null },
    })] : []),
  ];

  const seenTargets = new Set();
  for (const candidate of candidates) {
    if (seenTargets.has(candidate.target)) {
      throw configMutationError("config_draft_input_invalid", "Configuration draft input is invalid", {
        stage: "targets",
      });
    }
    seenTargets.add(candidate.target);
  }

  const draft = Object.freeze({
    operation,
    configRevision,
    mode,
    includeCodexCatalog,
    includeCodexConfig,
    candidates: Object.freeze(candidates),
  });
  const state = {
    operation,
    configRevision,
    mode,
    includeCodexCatalog,
    includeCodexConfig,
    codexCatalogTarget: includeCodexCatalog
      ? requiredString(spec.codexCatalog?.target, "codex_catalog")
      : "",
    candidates,
  };
  draftState.set(draft, state);
  validateCrossFileState(state, contentMapForDraft(state));
  return draft;
}

export function validateConfigMutationDraft(draft) {
  const state = draftState.get(draft);
  if (!state) {
    throw configMutationError("config_draft_invalid", "Configuration draft is invalid");
  }
  const contents = contentMapForDraft(state);
  for (const candidate of state.candidates) {
    const bytes = contents.get(candidate.id);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== candidate.sha256 || bytes.length !== candidate.byteLength) {
      throw configMutationError("config_draft_invalid", "Configuration draft is invalid");
    }
  }
  validateCrossFileState(state, contents);
  return true;
}

function validateMaterializedEntries(state, entries) {
  if (!Array.isArray(entries) || entries.length !== state.candidates.length) {
    throw configMutationError(
      "config_draft_candidate_mismatch",
      "Configuration candidate does not match its draft",
    );
  }
  const byId = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || byId.has(entry.id)) {
      throw configMutationError(
        "config_draft_candidate_mismatch",
        "Configuration candidate does not match its draft",
      );
    }
    byId.set(entry.id, entry);
  }
  const contents = new Map();
  for (const candidate of state.candidates) {
    const entry = byId.get(candidate.id);
    let bytes;
    try {
      bytes = safeBytes(entry?.content, "config_draft_candidate_mismatch");
    } catch {
      throw configMutationError(
        "config_draft_candidate_mismatch",
        "Configuration candidate does not match its draft",
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (entry.target !== candidate.target || digest !== candidate.sha256) {
      throw configMutationError(
        "config_draft_candidate_mismatch",
        "Configuration candidate does not match its draft",
      );
    }
    contents.set(candidate.id, bytes);
  }
  try {
    validateCrossFileState(state, contents);
  } catch {
    throw configMutationError(
      "config_draft_candidate_mismatch",
      "Configuration candidate does not match its draft",
    );
  }
  return true;
}

export function materializeConfigMutationEntries(draft) {
  const state = draftState.get(draft);
  if (!state) {
    throw configMutationError("config_draft_invalid", "Configuration draft is invalid");
  }
  return state.candidates.map((candidate) => {
    const stored = candidateState.get(candidate);
    const entry = {
      id: candidate.id,
      target: candidate.target,
      content: Buffer.from(stored.bytes),
      sensitive: candidate.sensitive,
      async validate({ id, content, entries }) {
        if (id !== candidate.id) {
          throw configMutationError(
            "config_draft_candidate_mismatch",
            "Configuration candidate does not match its draft",
          );
        }
        const bytes = safeBytes(content, "config_draft_candidate_mismatch");
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== candidate.sha256) {
          throw configMutationError(
            "config_draft_candidate_mismatch",
            "Configuration candidate does not match its draft",
          );
        }
        return validateMaterializedEntries(state, entries);
      },
    };
    if (candidate.mode !== undefined) {
      entry.mode = candidate.mode;
    }
    if (stored.original.provided) {
      entry.expectedOriginal = stored.original.bytes === null
        ? { exists: false }
        : { exists: true, bytes: Buffer.from(stored.original.bytes) };
    }
    return entry;
  });
}
