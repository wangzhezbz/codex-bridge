import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createWindowsPrivateAcl } from "./windows-private-acl.mjs";

const ARTIFACT_MODE = 0o600;
const DEFAULT_TARGET_MODE = 0o644;
const JOURNAL_VERSION = 1;
const JOURNAL_PREFIX = ".codexbridge-config-transaction.";
const JOURNAL_SUFFIX = ".journal.json";
const JOURNAL_STAGES = new Set([
  "planning",
  "prepared",
  "committing",
  "verifying",
  "complete",
  "rolling_back",
  "recovery_required",
]);
const MAX_ROLLBACK_ERRORS = 8;
const MAX_JOURNAL_ENTRIES = 1024;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TRANSACTION_ID_PATTERN = /^[a-f0-9-]{16,64}$/;
const SAFE_CAUSE_CODE_PATTERN = /^[a-z0-9_]{1,96}$/;
const TRANSACTION_FAILURE_PHASES = new Set([
  "planning",
  "private_staging",
  "candidate_staging",
  "validation",
  "commit",
  "verify",
  "rollback",
  "cleanup",
]);

let defaultWindowsPrivateAcl;

function getDefaultWindowsPrivateAcl() {
  if (!defaultWindowsPrivateAcl) {
    defaultWindowsPrivateAcl = createWindowsPrivateAcl();
  }
  return defaultWindowsPrivateAcl;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.promises.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !["EACCES", "EBADF", "EISDIR", "EINVAL", "EPERM"].includes(error?.code)
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function syncFile(filePath, applyMetadata) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, "r+");
  } catch (error) {
    if (!["EACCES", "EPERM"].includes(error?.code)) {
      throw error;
    }
    await fs.promises.chmod(filePath, ARTIFACT_MODE);
    handle = await fs.promises.open(filePath, "r+");
  }
  try {
    if (typeof applyMetadata === "function") {
      await applyMetadata();
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const defaultFileOps = {
  chmod: (...args) => fs.promises.chmod(...args),
  lstat: (...args) => fs.promises.lstat(...args),
  mkdir: (...args) => fs.promises.mkdir(...args),
  readFile: (...args) => fs.promises.readFile(...args),
  readdir: (...args) => fs.promises.readdir(...args),
  realpath: (...args) => fs.promises.realpath(...args),
  rename: (...args) => fs.promises.rename(...args),
  rmdir: (...args) => fs.promises.rmdir(...args),
  stat: (...args) => fs.promises.stat(...args),
  syncDirectory,
  syncFile,
  unlink: (...args) => fs.promises.unlink(...args),
  writeFile: (...args) => fs.promises.writeFile(...args),
};

function isMissingFileError(error) {
  return error?.code === "ENOENT";
}

function safeErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  return /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : "operation_failed";
}

function rollbackDiagnostic(stage, entryIndex, error, recoveryId) {
  const diagnostic = {
    stage,
    entryIndex,
    code: safeErrorCode(error),
  };
  if (recoveryId) {
    diagnostic.recoveryId = recoveryId;
  }
  return diagnostic;
}

function configurationError(code, message) {
  const error = new Error(message);
  error.name = "ConfigWriteCoordinatorError";
  error.code = code;
  return error;
}

function unsafePathError(message) {
  return configurationError("config_write_unsafe_path", message);
}

function createTransactionError(
  primaryCause,
  failurePhase,
  diagnostics,
  recoveryId,
) {
  const error = new Error("Configuration transaction failed");
  error.name = "ConfigTransactionError";
  error.code = "config_transaction_failed";
  error.failurePhase = TRANSACTION_FAILURE_PHASES.has(failurePhase)
    ? failurePhase
    : "planning";
  const primaryCauseCode = typeof primaryCause?.code === "string"
    ? primaryCause.code.trim().toLowerCase()
    : "";
  error.causeCode = SAFE_CAUSE_CODE_PATTERN.test(primaryCauseCode)
    ? primaryCauseCode
    : "operation_failed";
  error.rollbackErrors = diagnostics.slice(0, MAX_ROLLBACK_ERRORS);
  error.rollbackComplete = diagnostics.length === 0;
  if (recoveryId) {
    error.recoveryId = recoveryId;
  }
  return error;
}

function createRecoveryError(pending) {
  const error = new Error("Configuration recovery requires attention");
  error.name = "ConfigRecoveryError";
  error.code = "config_recovery_incomplete";
  error.pending = pending.slice(0, MAX_ROLLBACK_ERRORS);
  return error;
}

function contentBytes(content) {
  if (typeof content === "string") {
    return Buffer.from(content, "utf8");
  }
  if (Buffer.isBuffer(content) || ArrayBuffer.isView(content)) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  }
  throw new TypeError("entry content must be a string or Buffer");
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathComparisonKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInsideRoot(filePath, rootPath) {
  const targetKey = pathComparisonKey(filePath);
  const rootKey = pathComparisonKey(rootPath);
  const relative = path.relative(rootKey, targetKey);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function normalizeConfiguration({ allowedRoots, journalDir } = {}) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw configurationError(
      "config_write_coordinator_invalid_configuration",
      "allowedRoots must be a non-empty array",
    );
  }
  if (typeof journalDir !== "string" || journalDir.length === 0) {
    throw configurationError(
      "config_write_coordinator_invalid_configuration",
      "journalDir is required",
    );
  }

  const normalizedRoots = [];
  const seen = new Set();
  for (const root of allowedRoots) {
    if (typeof root !== "string" || root.length === 0 || !path.isAbsolute(root)) {
      throw configurationError(
        "config_write_coordinator_invalid_configuration",
        "allowedRoots must contain absolute paths",
      );
    }
    const resolved = path.resolve(root);
    const key = pathComparisonKey(resolved);
    if (!seen.has(key)) {
      seen.add(key);
      normalizedRoots.push(resolved);
    }
  }
  normalizedRoots.sort((left, right) =>
    pathComparisonKey(left).localeCompare(pathComparisonKey(right)),
  );

  if (!path.isAbsolute(journalDir)) {
    throw configurationError(
      "config_write_coordinator_invalid_configuration",
      "journalDir must be an absolute path",
    );
  }
  const normalizedJournalDir = path.resolve(journalDir);
  if (!normalizedRoots.some((root) => isPathInsideRoot(normalizedJournalDir, root))) {
    throw configurationError(
      "config_write_coordinator_invalid_configuration",
      "journalDir must be inside an allowed root",
    );
  }

  return Object.freeze({
    allowedRoots: Object.freeze(normalizedRoots),
    journalDir: normalizedJournalDir,
  });
}

function sameConfiguration(left, right) {
  return (
    pathComparisonKey(left.journalDir) === pathComparisonKey(right.journalDir) &&
    left.allowedRoots.length === right.allowedRoots.length &&
    left.allowedRoots.every(
      (root, index) =>
        pathComparisonKey(root) === pathComparisonKey(right.allowedRoots[index]),
    )
  );
}

function normalizeExpectedOriginal(expectedOriginal) {
  if (expectedOriginal === undefined) {
    return null;
  }
  if (typeof expectedOriginal === "string" || Buffer.isBuffer(expectedOriginal)) {
    const bytes = contentBytes(expectedOriginal);
    return { existed: true, bytes, sha256: hashBytes(bytes) };
  }
  if (!expectedOriginal || typeof expectedOriginal !== "object") {
    throw new TypeError("expectedOriginal must be bytes, text, or an expectation object");
  }
  const existed = expectedOriginal.existed ?? expectedOriginal.exists;
  if (existed === false) {
    return { existed: false, bytes: null, sha256: null };
  }
  const bytes = expectedOriginal.bytes === undefined
    ? null
    : contentBytes(expectedOriginal.bytes);
  const sha256 = bytes
    ? hashBytes(bytes)
    : String(expectedOriginal.sha256 || "").toLowerCase();
  if (existed !== true || !SHA256_PATTERN.test(sha256)) {
    throw new TypeError(
      "expectedOriginal must declare exists and provide bytes or a SHA-256 hash",
    );
  }
  return { existed: true, bytes, sha256 };
}

function stateMatchesExpectation(state, expectation) {
  if (!expectation) {
    return true;
  }
  if (state.existed !== expectation.existed) {
    return false;
  }
  if (!state.existed) {
    return true;
  }
  if (expectation.bytes && !state.bytes.equals(expectation.bytes)) {
    return false;
  }
  return state.sha256 === expectation.sha256;
}

function validateEntryMode(mode, label) {
  if (mode === undefined) {
    return undefined;
  }
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new TypeError(`${label} must be an integer permission mode`);
  }
  return mode;
}

function validatePreparedTransaction(prepared, configuration) {
  if (!prepared || !Array.isArray(prepared.entries)) {
    throw new TypeError("prepare must return an entries array");
  }
  if (prepared.entries.length > MAX_JOURNAL_ENTRIES) {
    throw new TypeError("transaction contains too many entries");
  }

  const seenTargets = new Set();
  const entries = prepared.entries.map((entry) => {
    if (!entry || typeof entry.target !== "string" || entry.target.length === 0) {
      throw new TypeError("each entry must have a target");
    }
    if (!path.isAbsolute(entry.target)) {
      throw new TypeError("transaction targets must be absolute paths");
    }
    if (typeof entry.validate !== "function") {
      throw new TypeError("each entry must have a validate function");
    }
    const target = path.resolve(entry.target);
    if (!configuration.allowedRoots.some((root) => isPathInsideRoot(target, root))) {
      throw unsafePathError("transaction target is outside configured roots");
    }
    const targetKey = pathComparisonKey(target);
    if (seenTargets.has(targetKey)) {
      throw new TypeError("transaction targets must be unique");
    }
    seenTargets.add(targetKey);
    const bytes = contentBytes(entry.content);
    return {
      ...entry,
      bytes,
      expectedOriginal: normalizeExpectedOriginal(entry.expectedOriginal),
      mode: validateEntryMode(entry.mode, "entry mode"),
      sensitive: entry.sensitive === true,
      target,
    };
  });
  return { ...prepared, entries };
}

function transactionStagingDirectory(target, transactionId) {
  return path.join(
    path.dirname(target),
    `.codexbridge-private-stage.${transactionId}`,
  );
}

function transactionArtifactPath(target, kind, transactionId, entryIndex) {
  return path.join(
    transactionStagingDirectory(target, transactionId),
    `.${path.basename(target)}.${kind}.${transactionId}.${entryIndex}.tmp`,
  );
}

function legacyTransactionArtifactPath(target, kind, transactionId, entryIndex) {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${kind}.${transactionId}.${entryIndex}.tmp`,
  );
}

function journalEntryUsesPrivateStaging(entry, transactionId) {
  return (
    entry.changed &&
    entry.candidatePath === transactionArtifactPath(
      entry.target,
      "candidate",
      transactionId,
      entry.index,
    )
  );
}

function journalRestoreArtifactPaths(entry, transactionId) {
  const privateRestorePath = transactionArtifactPath(
    entry.target,
    "restore",
    transactionId,
    entry.index,
  );
  if (journalEntryUsesPrivateStaging(entry, transactionId)) {
    return [privateRestorePath];
  }
  return [
    privateRestorePath,
    legacyTransactionArtifactPath(
      entry.target,
      "restore",
      transactionId,
      entry.index,
    ),
  ];
}

function journalPathFor(configuration, transactionId) {
  return path.join(
    configuration.journalDir,
    `${JOURNAL_PREFIX}${transactionId}${JOURNAL_SUFFIX}`,
  );
}

function journalTransactionId(fileName) {
  if (!fileName.startsWith(JOURNAL_PREFIX) || !fileName.endsWith(JOURNAL_SUFFIX)) {
    return null;
  }
  const transactionId = fileName.slice(
    JOURNAL_PREFIX.length,
    -JOURNAL_SUFFIX.length,
  );
  return TRANSACTION_ID_PATTERN.test(transactionId) ? transactionId : null;
}

function journalBytes(journal) {
  return Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
}

function stateMatchesJournalHash(state, existed, sha256) {
  return state.existed === existed && (!existed || state.sha256 === sha256);
}

function statsIdentity(stats) {
  return `${String(stats?.dev)}:${String(stats?.ino)}`;
}

function deriveTargetMode(entry, original) {
  if (entry.sensitive) {
    return ARTIFACT_MODE;
  }
  if (original.existed && Number.isInteger(original.mode)) {
    return original.mode;
  }
  return entry.mode ?? DEFAULT_TARGET_MODE;
}

export function createConfigWriteCoordinator({
  allowedRoots,
  fileOps,
  journalDir,
  nextRevision,
  platform = process.platform,
  privateAcl,
} = {}) {
  const ops = { ...defaultFileOps, ...fileOps };
  const generateRevision = nextRevision ?? randomUUID;
  const windowsPrivateAcl = platform === "win32"
    ? (privateAcl ?? getDefaultWindowsPrivateAcl())
    : null;
  if (
    platform === "win32" &&
    typeof windowsPrivateAcl?.securePath !== "function"
  ) {
    throw configurationError(
      "config_write_coordinator_invalid_configuration",
      "privateAcl.securePath is required on Windows",
    );
  }
  const exclusiveContext = new AsyncLocalStorage();
  const coordinatorToken = Object.freeze({});
  let configuration = null;
  let queue = Promise.resolve();

  function configure(nextConfiguration) {
    const normalized = normalizeConfiguration(nextConfiguration);
    if (configuration) {
      if (!sameConfiguration(configuration, normalized)) {
        throw configurationError(
          "config_write_coordinator_already_configured",
          "config write coordinator configuration is immutable",
        );
      }
      return configuration;
    }
    configuration = normalized;
    return configuration;
  }

  if (allowedRoots !== undefined || journalDir !== undefined) {
    configure({ allowedRoots, journalDir });
  }

  async function readState(target, includeMode = false) {
    try {
      const bytes = contentBytes(await ops.readFile(target));
      let mode;
      if (includeMode) {
        const stats = await ops.stat(target);
        mode = stats.mode & 0o777;
      }
      return { existed: true, bytes, sha256: hashBytes(bytes), mode };
    } catch (error) {
      if (isMissingFileError(error)) {
        return { existed: false, bytes: null, sha256: null, mode: undefined };
      }
      throw error;
    }
  }

  async function physicalPathIntent(startPath) {
    const requested = path.resolve(startPath);
    let current = requested;
    while (true) {
      try {
        const realAncestor = await ops.realpath(current);
        return path.resolve(realAncestor, path.relative(current, requested));
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
        const parent = path.dirname(current);
        if (parent === current) {
          throw error;
        }
        current = parent;
      }
    }
  }

  async function assertPhysicalPathAllowed(target) {
    const resolvedTarget = path.resolve(target);
    const physicalRoots = [];
    for (const root of configuration.allowedRoots) {
      try {
        const rootStats = await ops.lstat(root);
        if (rootStats.isSymbolicLink?.()) {
          throw unsafePathError("configured allowed roots must not be symbolic links");
        }
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
      physicalRoots.push(await physicalPathIntent(root));
    }
    let targetStats;
    try {
      targetStats = await ops.lstat(resolvedTarget);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    if (targetStats?.isSymbolicLink?.()) {
      throw unsafePathError("configuration target must not be a symbolic link");
    }
    const physicalParent = await physicalPathIntent(path.dirname(resolvedTarget));
    if (!physicalRoots.some((root) => isPathInsideRoot(physicalParent, root))) {
      throw unsafePathError("configuration target resolves outside configured roots");
    }
  }

  async function readOriginal(entry, entryIndex) {
    const state = await readState(entry.target, true);
    if (!stateMatchesExpectation(state, entry.expectedOriginal)) {
      throw new Error("expected original does not match current target");
    }
    return { ...state, entry, entryIndex };
  }

  async function unlinkIfPresent(filePath) {
    try {
      await ops.unlink(filePath);
      return true;
    } catch (error) {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
  }

  async function rmdirIfPresent(directory) {
    try {
      await ops.rmdir(directory);
      return true;
    } catch (error) {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
  }

  async function artifactState(filePath) {
    let stats;
    try {
      stats = await ops.lstat(filePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return { existed: false, bytes: null, sha256: null };
      }
      throw error;
    }
    if (
      stats.isSymbolicLink?.() ||
      (typeof stats.isFile === "function" && !stats.isFile()) ||
      (Number.isInteger(stats.nlink) && stats.nlink !== 1)
    ) {
      throw new Error("transaction artifact must be one private regular file");
    }
    if (platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new Error("transaction artifact permissions are not private");
    }
    return {
      ...(await readState(filePath, false)),
      mode: stats.mode & 0o777,
    };
  }

  async function writePrivateFile(
    filePath,
    bytes,
    { flag = "wx", parentIsPrivate = false } = {},
  ) {
    let created = false;
    try {
      await ops.writeFile(filePath, bytes, {
        flag,
        flush: true,
        mode: ARTIFACT_MODE,
      });
      created = true;
      await ops.syncFile(filePath, async () => {
        await ops.chmod(filePath, ARTIFACT_MODE);
        if (platform === "win32" && !parentIsPrivate) {
          await windowsPrivateAcl.securePath(filePath, { kind: "file" });
        }
      });
    } catch (error) {
      // A Windows file is born with its parent's inherited DACL before Node can
      // replace it. If ACL application or verification fails, remove the known
      // private artifact immediately rather than leaving candidate bytes under
      // a broad inherited ACL for the later recovery scan to inspect.
      if (created || error?.code !== "EEXIST") {
        try {
          if (await unlinkIfPresent(filePath)) {
            await ops.syncDirectory(path.dirname(filePath));
          }
        } catch {
          throw configurationError(
            "windows_private_acl_cleanup_failed",
            "private artifact cleanup failed",
          );
        }
      }
      throw error;
    }
  }

  async function writeInitialJournal(journalPath, journal) {
    await writePrivateFile(journalPath, journalBytes(journal), {
      parentIsPrivate: true,
    });
    await ops.syncDirectory(path.dirname(journalPath));
  }

  async function replaceJournal(journalPath, journal) {
    const updatePath = `${journalPath}.update.tmp`;
    await unlinkIfPresent(updatePath);
    await writePrivateFile(updatePath, journalBytes(journal), {
      parentIsPrivate: true,
    });
    await ops.rename(updatePath, journalPath);
    await ops.syncFile(journalPath, () => ops.chmod(journalPath, ARTIFACT_MODE));
    await ops.syncDirectory(path.dirname(journalPath));
  }

  async function removeJournal(journalPath) {
    await unlinkIfPresent(`${journalPath}.update.tmp`);
    await unlinkIfPresent(journalPath);
    await ops.syncDirectory(path.dirname(journalPath));
  }

  function validateJournalPath(filePath) {
    if (!isPathInsideRoot(filePath, configuration.journalDir)) {
      throw new Error("journal path is outside the configured journal directory");
    }
  }

  function validateJournal(journal, journalPath, transactionId) {
    validateJournalPath(journalPath);
    if (
      !journal ||
      journal.version !== JOURNAL_VERSION ||
      journal.transactionId !== transactionId ||
      !JOURNAL_STAGES.has(journal.stage) ||
      !Array.isArray(journal.entries) ||
      journal.entries.length > MAX_JOURNAL_ENTRIES
    ) {
      throw new Error("invalid transaction journal metadata");
    }

    const seenTargets = new Set();
    for (let index = 0; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index];
      if (
        !entry ||
        entry.index !== index ||
        typeof entry.target !== "string" ||
        !path.isAbsolute(entry.target) ||
        typeof entry.changed !== "boolean" ||
        typeof entry.existed !== "boolean" ||
        !["pending", "committed"].includes(entry.state) ||
        !SHA256_PATTERN.test(entry.candidateSha256) ||
        (entry.existed && !SHA256_PATTERN.test(entry.originalSha256)) ||
        (!entry.existed && entry.originalSha256 !== null) ||
        !Number.isInteger(entry.targetMode) ||
        entry.targetMode < 0 ||
        entry.targetMode > 0o777 ||
        !(
          entry.originalMode === null ||
          (Number.isInteger(entry.originalMode) &&
            entry.originalMode >= 0 &&
            entry.originalMode <= 0o777)
        )
      ) {
        throw new Error("invalid transaction journal entry");
      }
      const target = path.resolve(entry.target);
      if (
        target !== entry.target ||
        !configuration.allowedRoots.some((root) => isPathInsideRoot(target, root))
      ) {
        throw new Error("journal target is outside configured roots");
      }
      const targetKey = pathComparisonKey(target);
      if (seenTargets.has(targetKey)) {
        throw new Error("journal targets must be unique");
      }
      seenTargets.add(targetKey);
      const privateCandidatePath = transactionArtifactPath(
        target,
        "candidate",
        transactionId,
        index,
      );
      const privateRollbackPath = entry.existed && entry.changed
        ? transactionArtifactPath(target, "rollback", transactionId, index)
        : null;
      const legacyCandidatePath = legacyTransactionArtifactPath(
        target,
        "candidate",
        transactionId,
        index,
      );
      const legacyRollbackPath = entry.existed && entry.changed
        ? legacyTransactionArtifactPath(target, "rollback", transactionId, index)
        : null;
      const candidatePath = entry.changed ? entry.candidatePath : null;
      const matchesPrivateLayout =
        candidatePath === (entry.changed ? privateCandidatePath : null) &&
        entry.rollbackPath === privateRollbackPath;
      const matchesLegacyLayout =
        candidatePath === (entry.changed ? legacyCandidatePath : null) &&
        entry.rollbackPath === legacyRollbackPath;
      if (!matchesPrivateLayout && !matchesLegacyLayout) {
        throw new Error("journal artifact path does not match its target");
      }
    }
    return journal;
  }

  async function cleanupJournalArtifacts(journal, {
    preserveEntryIndexes = new Set(),
    preserveRollbackIndexes = new Set(),
  } = {}) {
    const diagnostics = [];
    const changedDirectories = new Set();
    const stagingDirectories = new Map();
    for (const entry of journal.entries) {
      if (entry.changed) {
        const stagingDirectory = transactionStagingDirectory(
          entry.target,
          journal.transactionId,
        );
        const stagingKey = pathComparisonKey(stagingDirectory);
        const state = stagingDirectories.get(stagingKey) || {
          directory: stagingDirectory,
          entryIndex: entry.index,
          preserve: false,
        };
        state.preserve ||=
          preserveEntryIndexes.has(entry.index) ||
          preserveRollbackIndexes.has(entry.index);
        stagingDirectories.set(stagingKey, state);
      }
      if (preserveEntryIndexes.has(entry.index)) {
        continue;
      }
      try {
        await assertPhysicalPathAllowed(entry.target);
      } catch (error) {
        diagnostics.push(
          rollbackDiagnostic("cleanup_physical_path", entry.index, error, journal.transactionId),
        );
        const stagingKey = pathComparisonKey(
          transactionStagingDirectory(entry.target, journal.transactionId),
        );
        if (stagingDirectories.has(stagingKey)) {
          stagingDirectories.get(stagingKey).preserve = true;
        }
        continue;
      }
      for (const [kind, artifactPath] of [
        ["candidate", entry.candidatePath],
        ["rollback", entry.rollbackPath],
        ...(entry.existed && entry.changed
          ? journalRestoreArtifactPaths(entry, journal.transactionId).map(
            (restorePath, index) => [index === 0 ? "restore" : "restore_legacy", restorePath],
          )
          : []),
      ]) {
        if (!artifactPath || (kind === "rollback" && preserveRollbackIndexes.has(entry.index))) {
          continue;
        }
        try {
          if (await unlinkIfPresent(artifactPath)) {
            changedDirectories.add(path.dirname(artifactPath));
          }
        } catch (error) {
          diagnostics.push(
            rollbackDiagnostic(`cleanup_${kind}`, entry.index, error, journal.transactionId),
          );
        }
      }
    }
    for (const directory of changedDirectories) {
      try {
        await ops.syncDirectory(directory);
      } catch (error) {
        diagnostics.push(
          rollbackDiagnostic("cleanup_sync", -1, error, journal.transactionId),
        );
      }
    }
    for (const { directory, entryIndex, preserve } of stagingDirectories.values()) {
      if (preserve) {
        continue;
      }
      try {
        if (await rmdirIfPresent(directory)) {
          await ops.syncDirectory(path.dirname(directory));
        }
      } catch (error) {
        diagnostics.push(
          rollbackDiagnostic(
            "cleanup_staging",
            entryIndex,
            error,
            journal.transactionId,
          ),
        );
      }
    }
    return diagnostics;
  }

  async function rollbackJournal(journal, journalPath) {
    const diagnostics = [];
    const preserveEntryIndexes = new Set();
    const preserveRollbackIndexes = new Set();

    for (const entry of [...journal.entries].reverse()) {
      if (!entry.changed) {
        continue;
      }
      try {
        await assertPhysicalPathAllowed(entry.target);
      } catch (error) {
        diagnostics.push(
          rollbackDiagnostic("physical_path", entry.index, error, journal.transactionId),
        );
        preserveEntryIndexes.add(entry.index);
        if (entry.rollbackPath) {
          preserveRollbackIndexes.add(entry.index);
        }
        continue;
      }

      let target;
      let candidateArtifact;
      try {
        target = await readState(entry.target, true);
        candidateArtifact = entry.candidatePath
          ? await artifactState(entry.candidatePath)
          : { existed: false };
      } catch (error) {
        diagnostics.push(
          rollbackDiagnostic("inspect", entry.index, error, journal.transactionId),
        );
        preserveEntryIndexes.add(entry.index);
        if (entry.rollbackPath) {
          preserveRollbackIndexes.add(entry.index);
        }
        continue;
      }

      const targetIsOriginal = stateMatchesJournalHash(
        target,
        entry.existed,
        entry.originalSha256,
      );
      const targetIsCandidate = stateMatchesJournalHash(
        target,
        true,
        entry.candidateSha256,
      );
      const definitelyNotCommitted =
        entry.state === "pending" && candidateArtifact.existed;

      if (definitelyNotCommitted) {
        continue;
      }
      if (targetIsOriginal) {
        if (entry.existed && Number.isInteger(entry.originalMode)) {
          try {
            await assertPhysicalPathAllowed(entry.target);
            await ops.syncFile(
              entry.target,
              () => ops.chmod(entry.target, entry.originalMode),
            );
            await ops.syncDirectory(path.dirname(entry.target));
          } catch (error) {
            diagnostics.push(
              rollbackDiagnostic("restore_mode", entry.index, error, journal.transactionId),
            );
            if (entry.rollbackPath) {
              preserveRollbackIndexes.add(entry.index);
            }
          }
        }
        continue;
      }
      if (!targetIsCandidate) {
        diagnostics.push(
          rollbackDiagnostic(
            "conflict",
            entry.index,
            configurationError("ECONFLICT", "target changed during recovery"),
            journal.transactionId,
          ),
        );
        if (entry.rollbackPath) {
          preserveRollbackIndexes.add(entry.index);
        }
        continue;
      }

      try {
        await assertPhysicalPathAllowed(entry.target);
        if (!entry.existed) {
          await ops.unlink(entry.target);
          await ops.syncDirectory(path.dirname(entry.target));
        } else {
          const rollback = await artifactState(entry.rollbackPath);
          if (!stateMatchesJournalHash(rollback, true, entry.originalSha256)) {
            throw configurationError("EROLLBACK", "rollback artifact is unavailable");
          }
          const restorePaths = journalRestoreArtifactPaths(
            entry,
            journal.transactionId,
          );
          let restorePath = restorePaths[0];
          let restore = await artifactState(restorePath);
          if (!restore.existed && restorePaths.length > 1) {
            const legacyRestore = await artifactState(restorePaths[1]);
            if (legacyRestore.existed) {
              restorePath = restorePaths[1];
              restore = legacyRestore;
            }
          }
          if (restore.existed) {
            if (!stateMatchesJournalHash(restore, true, entry.originalSha256)) {
              throw configurationError("EROLLBACK", "restore artifact is invalid");
            }
          } else {
            await writePrivateFile(restorePath, rollback.bytes, {
              parentIsPrivate: true,
            });
            await ops.syncDirectory(path.dirname(restorePath));
          }
          await assertPhysicalPathAllowed(entry.target);
          await ops.rename(restorePath, entry.target);
          await ops.syncFile(
            entry.target,
            () => ops.chmod(entry.target, entry.originalMode ?? entry.targetMode),
          );
          await ops.syncDirectory(path.dirname(entry.target));
        }
      } catch (error) {
        diagnostics.push(
          rollbackDiagnostic("restore", entry.index, error, journal.transactionId),
        );
        if (entry.rollbackPath) {
          preserveRollbackIndexes.add(entry.index);
        }
      }
    }

    diagnostics.push(
      ...(await cleanupJournalArtifacts(journal, {
        preserveEntryIndexes,
        preserveRollbackIndexes,
      })),
    );
    if (diagnostics.length === 0) {
      try {
        await removeJournal(journalPath);
      } catch (error) {
        diagnostics.push(
          rollbackDiagnostic("cleanup_journal", -1, error, journal.transactionId),
        );
      }
    }
    return diagnostics;
  }

  async function readAndValidateJournal(journalPath, transactionId) {
    let before = await ops.lstat(journalPath);
    if (
      before.isSymbolicLink?.() ||
      (typeof before.isFile === "function" && !before.isFile()) ||
      (Number.isInteger(before.nlink) && before.nlink !== 1) ||
      before.size > MAX_JOURNAL_BYTES ||
      (platform !== "win32" && (before.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())
    ) {
      throw new Error("transaction journal source is not one private regular file");
    }
    if (platform === "win32") {
      await windowsPrivateAcl.securePath(journalPath, { kind: "file" });
      before = await ops.lstat(journalPath);
      if (
        before.isSymbolicLink?.() ||
        (typeof before.isFile === "function" && !before.isFile()) ||
        (Number.isInteger(before.nlink) && before.nlink !== 1) ||
        before.size > MAX_JOURNAL_BYTES
      ) {
        throw new Error("transaction journal source is not one private regular file");
      }
    }
    const bytes = contentBytes(await ops.readFile(journalPath));
    if (bytes.length > MAX_JOURNAL_BYTES) {
      throw new Error("transaction journal exceeds the size limit");
    }
    const after = await ops.lstat(journalPath);
    if (
      after.isSymbolicLink?.() ||
      String(after.dev) !== String(before.dev) ||
      String(after.ino) !== String(before.ino) ||
      after.size !== before.size
    ) {
      throw new Error("transaction journal changed while being read");
    }
    const journal = JSON.parse(contentBytes(bytes).toString("utf8"));
    return validateJournal(journal, journalPath, transactionId);
  }

  async function secureJournalDirectory({ create }) {
    await assertPhysicalPathAllowed(configuration.journalDir);
    if (create) {
      await ops.mkdir(configuration.journalDir, {
        mode: 0o700,
        recursive: true,
      });
    }
    let stats;
    try {
      stats = await ops.lstat(configuration.journalDir);
    } catch (error) {
      if (!create && isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
    if (
      stats.isSymbolicLink?.() ||
      (typeof stats.isDirectory === "function" && !stats.isDirectory())
    ) {
      throw new Error("transaction journal directory must be a private directory");
    }
    await ops.chmod(configuration.journalDir, 0o700);
    if (platform === "win32") {
      await windowsPrivateAcl.securePath(configuration.journalDir, {
        kind: "directory",
      });
    }
    await ops.syncDirectory(configuration.journalDir);
    const secured = await ops.lstat(configuration.journalDir);
    if (
      secured.isSymbolicLink?.() ||
      (typeof secured.isDirectory === "function" && !secured.isDirectory()) ||
      statsIdentity(secured) !== statsIdentity(stats) ||
      (platform !== "win32" && (secured.mode & 0o077) !== 0)
    ) {
      throw new Error("transaction journal directory permissions are not private");
    }
    await assertPhysicalPathAllowed(configuration.journalDir);
    return true;
  }

  async function secureTransactionStagingDirectory(
    target,
    transactionId,
    { create },
  ) {
    const stagingDirectory = transactionStagingDirectory(target, transactionId);
    await assertPhysicalPathAllowed(target);
    if (create) {
      await ops.mkdir(stagingDirectory, { mode: 0o700 });
    }
    let before;
    try {
      before = await ops.lstat(stagingDirectory);
    } catch (error) {
      if (!create && isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
    if (
      before.isSymbolicLink?.() ||
      (typeof before.isDirectory === "function" && !before.isDirectory())
    ) {
      throw new Error("transaction staging path must be a private directory");
    }
    await ops.chmod(stagingDirectory, 0o700);
    if (platform === "win32") {
      await windowsPrivateAcl.securePath(stagingDirectory, {
        kind: "directory",
      });
    }
    await ops.syncDirectory(stagingDirectory);
    await ops.syncDirectory(path.dirname(stagingDirectory));
    const after = await ops.lstat(stagingDirectory);
    if (
      after.isSymbolicLink?.() ||
      (typeof after.isDirectory === "function" && !after.isDirectory()) ||
      statsIdentity(after) !== statsIdentity(before) ||
      (platform !== "win32" && (after.mode & 0o077) !== 0)
    ) {
      throw new Error("transaction staging directory changed while securing it");
    }
    await assertPhysicalPathAllowed(target);
    return true;
  }

  async function secureJournalStagingDirectories(journal) {
    const securedDirectories = new Set();
    const securedLegacyFiles = new Set();
    for (const entry of journal.entries) {
      if (!entry.changed) {
        continue;
      }
      const stagingDirectory = transactionStagingDirectory(
        entry.target,
        journal.transactionId,
      );
      const key = pathComparisonKey(stagingDirectory);
      if (!securedDirectories.has(key)) {
        securedDirectories.add(key);
        const exists = await secureTransactionStagingDirectory(
          entry.target,
          journal.transactionId,
          { create: false },
        );
        if (!exists && !journalEntryUsesPrivateStaging(entry, journal.transactionId)) {
          await secureTransactionStagingDirectory(
            entry.target,
            journal.transactionId,
            { create: true },
          );
        }
      }
      if (
        platform !== "win32" ||
        journalEntryUsesPrivateStaging(entry, journal.transactionId)
      ) {
        continue;
      }
      for (const legacyPath of [
        entry.candidatePath,
        entry.rollbackPath,
        legacyTransactionArtifactPath(
          entry.target,
          "restore",
          journal.transactionId,
          entry.index,
        ),
      ]) {
        if (!legacyPath) {
          continue;
        }
        const legacyKey = pathComparisonKey(legacyPath);
        if (securedLegacyFiles.has(legacyKey)) {
          continue;
        }
        let stats;
        try {
          stats = await ops.lstat(legacyPath);
        } catch (error) {
          if (isMissingFileError(error)) {
            continue;
          }
          throw error;
        }
        if (
          stats.isSymbolicLink?.() ||
          (typeof stats.isFile === "function" && !stats.isFile()) ||
          (Number.isInteger(stats.nlink) && stats.nlink !== 1)
        ) {
          throw new Error("legacy transaction artifact is not one regular file");
        }
        await windowsPrivateAcl.securePath(legacyPath, { kind: "file" });
        securedLegacyFiles.add(legacyKey);
      }
    }
  }

  async function recoverConfiguredJournals({ throwOnPending }) {
    await assertPhysicalPathAllowed(configuration.journalDir);
    if (!(await secureJournalDirectory({ create: false }))) {
      return { recovered: 0, cleaned: 0, pending: [] };
    }
    let names;
    try {
      names = await ops.readdir(configuration.journalDir);
    } catch (error) {
      if (isMissingFileError(error)) {
        return { recovered: 0, cleaned: 0, pending: [] };
      }
      throw error;
    }

    const pending = [];
    let recovered = 0;
    let cleaned = 0;
    const nameSet = new Set(names);
    const journalSources = new Map();
    for (const name of names) {
      const transactionId = journalTransactionId(name);
      if (transactionId) {
        journalSources.set(name, name);
        continue;
      }
      if (!name.endsWith(`${JOURNAL_SUFFIX}.update.tmp`)) {
        continue;
      }
      const baseName = name.slice(0, -".update.tmp".length);
      if (journalTransactionId(baseName) && !nameSet.has(baseName)) {
        journalSources.set(baseName, name);
      }
    }

    for (const [baseName, sourceName] of [...journalSources.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const transactionId = journalTransactionId(baseName);
      const journalPath = path.join(configuration.journalDir, baseName);
      const sourcePath = path.join(configuration.journalDir, sourceName);
      let journal;
      try {
        journal = await readAndValidateJournal(sourcePath, transactionId);
      } catch (error) {
        pending.push({
          recoveryId: transactionId,
          stage: "read_journal",
          entryIndex: -1,
          code: safeErrorCode(error),
        });
        continue;
      }

      let physicalPathsValid = true;
      for (const entry of journal.entries) {
        try {
          await assertPhysicalPathAllowed(entry.target);
        } catch (error) {
          pending.push(
            rollbackDiagnostic("physical_path", entry.index, error, transactionId),
          );
          physicalPathsValid = false;
        }
      }
      if (!physicalPathsValid) {
        continue;
      }
      try {
        await secureJournalStagingDirectories(journal);
      } catch (error) {
        pending.push(
          rollbackDiagnostic("secure_staging", -1, error, transactionId),
        );
        continue;
      }

      if (journal.stage === "complete") {
        const diagnostics = await cleanupJournalArtifacts(journal);
        if (diagnostics.length === 0) {
          try {
            await removeJournal(journalPath);
            cleaned += 1;
          } catch (error) {
            diagnostics.push(
              rollbackDiagnostic("cleanup_journal", -1, error, transactionId),
            );
          }
        }
        pending.push(...diagnostics);
        continue;
      }

      const diagnostics = await rollbackJournal(journal, journalPath);
      if (diagnostics.length === 0) {
        recovered += 1;
      } else {
        pending.push(...diagnostics);
      }
    }

    const report = { recovered, cleaned, pending };
    if (throwOnPending && pending.length > 0) {
      throw createRecoveryError(pending);
    }
    return report;
  }

  async function updateJournalStage(journal, journalPath, stage) {
    journal.stage = stage;
    await replaceJournal(journalPath, journal);
  }

  async function execute({ operation, prepare, verifyCommitted } = {}) {
    let journal = null;
    let journalPath = null;
    let failurePhase = "planning";

    try {
      await recoverConfiguredJournals({ throwOnPending: true });
      if (typeof prepare !== "function") {
        throw new TypeError("prepare must be a function");
      }

      const configRevision = await generateRevision();
      if (typeof configRevision !== "string" || configRevision.length === 0) {
        throw new TypeError("nextRevision must return a non-empty string");
      }
      const prepared = validatePreparedTransaction(
        await prepare({ operation, configRevision }),
        configuration,
      );

      for (const entry of prepared.entries) {
        await assertPhysicalPathAllowed(entry.target);
      }

      const originals = [];
      for (let index = 0; index < prepared.entries.length; index += 1) {
        originals.push(await readOriginal(prepared.entries[index], index));
      }
      const candidates = [];
      for (const original of originals) {
        const bytesUnchanged =
          original.existed && original.bytes.equals(original.entry.bytes);
        let existingPrivate = false;
        if (
          platform === "win32" &&
          bytesUnchanged &&
          original.entry.sensitive &&
          typeof windowsPrivateAcl.verifyPath === "function"
        ) {
          try {
            await windowsPrivateAcl.verifyPath(original.entry.target, { kind: "file" });
            existingPrivate = true;
          } catch {
            // If privacy cannot be proven, republish through the hardened path.
          }
        }
        const privateRepublish =
          platform === "win32" &&
          bytesUnchanged &&
          original.entry.sensitive &&
          !existingPrivate;
        const unchanged = bytesUnchanged && !privateRepublish;
        candidates.push({
          entry: original.entry,
          entryIndex: original.entryIndex,
          original,
          unchanged,
          expectedBytes: original.entry.bytes,
          targetMode: deriveTargetMode(original.entry, original),
          tempPath: null,
        });
      }

      const changedCandidates = candidates.filter((candidate) => !candidate.unchanged);
      if (changedCandidates.length > 0) {
        const transactionId = randomUUID();
        journalPath = journalPathFor(configuration, transactionId);
        const parentDirectories = new Set(
          changedCandidates.map((candidate) => path.dirname(candidate.entry.target)),
        );
        for (const parentDirectory of parentDirectories) {
          await ops.mkdir(parentDirectory, { recursive: true });
        }
        failurePhase = "private_staging";
        await secureJournalDirectory({ create: true });

        journal = {
          version: JOURNAL_VERSION,
          transactionId,
          stage: "planning",
          entries: candidates.map((candidate) => {
            const changed = !candidate.unchanged;
            const candidatePath = changed
              ? transactionArtifactPath(
                candidate.entry.target,
                "candidate",
                transactionId,
                candidate.entryIndex,
              )
              : null;
            const rollbackPath = changed && candidate.original.existed
              ? transactionArtifactPath(
                candidate.entry.target,
                "rollback",
                transactionId,
                candidate.entryIndex,
              )
              : null;
            candidate.tempPath = candidatePath;
            return {
              index: candidate.entryIndex,
              target: candidate.entry.target,
              candidatePath,
              rollbackPath,
              existed: candidate.original.existed,
              changed,
              originalSha256: candidate.original.sha256,
              candidateSha256: hashBytes(candidate.expectedBytes),
              originalMode: candidate.original.mode ?? null,
              targetMode: candidate.targetMode,
              state: "pending",
            };
          }),
        };
        await writeInitialJournal(journalPath, journal);

        const stagingDirectories = new Map();
        for (const metadata of journal.entries) {
          if (!metadata.changed) {
            continue;
          }
          const stagingDirectory = transactionStagingDirectory(
            metadata.target,
            transactionId,
          );
          stagingDirectories.set(pathComparisonKey(stagingDirectory), {
            stagingDirectory,
            target: metadata.target,
          });
        }
        // A staging directory is empty while its inherited DACL is replaced.
        // Candidate and rollback bytes are written only after that exact DACL
        // has been verified, so no secret is ever born under a broad parent ACL.
        for (const { target } of stagingDirectories.values()) {
          await secureTransactionStagingDirectory(target, transactionId, {
            create: true,
          });
        }

        failurePhase = "candidate_staging";
        const stagedPrivatePaths = [];
        // This narrows parent-reparse races while the process is alive. A crash
        // between the write and this check still needs a future native openat /
        // Windows directory-handle helper to close completely.
        const writeStagedPrivateFile = async (entry, artifactPath, bytes) => {
          await assertPhysicalPathAllowed(entry.target);
          await writePrivateFile(artifactPath, bytes, {
            parentIsPrivate: true,
          });
          stagedPrivatePaths.push(artifactPath);
          try {
            await assertPhysicalPathAllowed(entry.target);
          } catch (error) {
            for (const stagedPath of [...stagedPrivatePaths].reverse()) {
              try {
                await unlinkIfPresent(stagedPath);
              } catch {
                // The transaction journal remains for explicit recovery.
              }
            }
            throw error;
          }
        };
        for (const metadata of journal.entries) {
          if (!metadata.changed) {
            continue;
          }
          const candidate = candidates[metadata.index];
          if (metadata.rollbackPath) {
            await writeStagedPrivateFile(
              candidate.entry,
              metadata.rollbackPath,
              candidate.original.bytes,
            );
          }
          await writeStagedPrivateFile(
            candidate.entry,
            metadata.candidatePath,
            candidate.expectedBytes,
          );
        }
        for (const { stagingDirectory } of stagingDirectories.values()) {
          await ops.syncDirectory(stagingDirectory);
        }
        await updateJournalStage(journal, journalPath, "prepared");
      }

      failurePhase = "validation";
      const candidateEntries = candidates.map((candidate) => ({
        id: candidate.entry.id,
        target: candidate.entry.target,
        content: candidate.entry.content,
        tempPath: candidate.tempPath,
        unchanged: candidate.unchanged,
      }));
      for (const candidate of candidates) {
        await candidate.entry.validate({
          operation,
          configRevision,
          id: candidate.entry.id,
          target: candidate.entry.target,
          content: candidate.entry.content,
          tempPath: candidate.tempPath,
          unchanged: candidate.unchanged,
          entries: candidateEntries,
          value: prepared.value,
        });
      }

      for (const candidate of changedCandidates) {
        await assertPhysicalPathAllowed(candidate.entry.target);
        const metadata = journal.entries[candidate.entryIndex];
        const stagedCandidate = await artifactState(candidate.tempPath);
        if (!stateMatchesJournalHash(
          stagedCandidate,
          true,
          metadata.candidateSha256,
        )) {
          throw new Error("candidate artifact changed before commit");
        }
        if (metadata.rollbackPath) {
          const rollback = await artifactState(metadata.rollbackPath);
          if (!stateMatchesJournalHash(
            rollback,
            true,
            metadata.originalSha256,
          )) {
            throw new Error("rollback artifact changed before commit");
          }
        }
        const current = await readState(candidate.entry.target, false);
        if (!stateMatchesJournalHash(
          current,
          candidate.original.existed,
          candidate.original.sha256,
        )) {
          throw new Error("configuration target changed before commit");
        }
      }

      failurePhase = "commit";
      if (journal) {
        await updateJournalStage(journal, journalPath, "committing");
      }
      for (const candidate of changedCandidates) {
        await assertPhysicalPathAllowed(candidate.entry.target);
        const metadata = journal.entries[candidate.entryIndex];
        const stagedCandidate = await artifactState(candidate.tempPath);
        if (!stateMatchesJournalHash(
          stagedCandidate,
          true,
          metadata.candidateSha256,
        )) {
          throw new Error("candidate artifact changed before commit");
        }
        const current = await readState(candidate.entry.target, false);
        if (!stateMatchesJournalHash(
          current,
          candidate.original.existed,
          candidate.original.sha256,
        )) {
          throw new Error("configuration target changed before commit");
        }

        // The private child staging directory remains on the target volume, so
        // rename preserves atomic visibility without a cross-volume copy. The
        // final non-cooperative editor read/CAS -> rename syscall gap requires a
        // native ReplaceFileW/renameat2 helper to eliminate.
        await ops.rename(candidate.tempPath, candidate.entry.target);
        await ops.syncFile(candidate.entry.target, async () => {
          await ops.chmod(candidate.entry.target, candidate.targetMode);
          if (platform === "win32" && candidate.entry.sensitive) {
            await windowsPrivateAcl.securePath(candidate.entry.target, {
              kind: "file",
            });
          }
        });
        await ops.syncDirectory(path.dirname(candidate.entry.target));
        metadata.state = "committed";
        await replaceJournal(journalPath, journal);
      }

      failurePhase = "verify";
      if (journal) {
        await updateJournalStage(journal, journalPath, "verifying");
      }
      const committedEntries = [];
      for (const candidate of candidates) {
        const state = await readState(candidate.entry.target, false);
        if (!state.existed || !state.bytes.equals(candidate.expectedBytes)) {
          throw new Error("committed file bytes differ from the validated candidate");
        }
        committedEntries.push({
          id: candidate.entry.id,
          target: candidate.entry.target,
          content: candidate.entry.content,
          bytes: state.bytes,
        });
      }

      if (typeof verifyCommitted === "function") {
        await verifyCommitted({
          operation,
          configRevision,
          entries: committedEntries,
          value: prepared.value,
        });
      }

      for (const candidate of candidates) {
        await assertPhysicalPathAllowed(candidate.entry.target);
        const state = await readState(candidate.entry.target, false);
        if (!state.existed || !state.bytes.equals(candidate.expectedBytes)) {
          throw new Error("configuration target changed during committed verification");
        }
      }

      failurePhase = "cleanup";
      if (journal) {
        await updateJournalStage(journal, journalPath, "complete");
        const cleanupDiagnostics = await cleanupJournalArtifacts(journal);
        if (cleanupDiagnostics.length === 0) {
          try {
            await removeJournal(journalPath);
          } catch {
            // A complete journal is intentionally retained for safe startup cleanup.
          }
        }
      }
      return { configRevision, value: prepared.value };
    } catch (error) {
      if (!journal && error?.code === "config_recovery_incomplete") {
        throw error;
      }
      const primaryFailurePhase = failurePhase;
      let diagnostics = [];
      if (journal && journalPath) {
        failurePhase = "rollback";
        let journalStageDiagnostic = null;
        try {
          await updateJournalStage(journal, journalPath, "rolling_back");
        } catch (error) {
          journalStageDiagnostic = rollbackDiagnostic(
            "journal_rollback",
            -1,
            error,
            journal.transactionId,
          );
        }
        const rollbackDiagnostics = await rollbackJournal(journal, journalPath);
        if (rollbackDiagnostics.length > 0) {
          diagnostics = [
            ...(journalStageDiagnostic ? [journalStageDiagnostic] : []),
            ...rollbackDiagnostics,
          ];
          journal.stage = "recovery_required";
          try {
            await replaceJournal(journalPath, journal);
          } catch (error) {
            diagnostics.push(
              rollbackDiagnostic("journal_recovery", -1, error, journal.transactionId),
            );
          }
        }
      }
      throw createTransactionError(
        error,
        primaryFailurePhase,
        diagnostics,
        diagnostics.length > 0 ? journal?.transactionId : undefined,
      );
    }
  }

  function enqueue(work, kind) {
    if (!configuration) {
      return Promise.reject(
        configurationError(
          "config_write_coordinator_not_configured",
          "config write coordinator must be configured before use",
        ),
      );
    }
    const currentContext = exclusiveContext.getStore();
    if (currentContext?.token === coordinatorToken && currentContext.active) {
      if (kind === "transaction") {
        return Promise.reject(
          configurationError(
            "config_write_nested_transaction",
            "configuration transactions cannot be nested",
          ),
        );
      }
      const nested = Promise.resolve().then(work);
      const trackedOutcome = nested.then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ status: "rejected", reason }),
      );
      currentContext.pending.add(trackedOutcome);
      return nested;
    }
    const result = queue.then(() => {
      const context = {
        token: coordinatorToken,
        kind,
        active: true,
        pending: new Set(),
      };
      return exclusiveContext.run(context, async () => {
        let value;
        let failure;
        try {
          value = await work();
        } catch (error) {
          failure = error;
        }
        while (context.pending.size > 0) {
          const pendingBatch = [...context.pending];
          pendingBatch.forEach((pending) => context.pending.delete(pending));
          const pendingResults = await Promise.all(pendingBatch);
          if (!failure) {
            failure = pendingResults.find(({ status }) => status === "rejected")?.reason;
          }
        }
        context.active = false;
        if (failure) {
          throw failure;
        }
        return value;
      });
    });
    queue = result.catch(() => undefined);
    return result;
  }

  function runTransaction(transaction) {
    return enqueue(() => execute(transaction), "transaction");
  }

  function runExclusive(work) {
    if (typeof work !== "function") {
      throw new TypeError("runExclusive requires a function");
    }
    const inheritedContext = exclusiveContext.getStore();
    const reusesActiveLease =
      inheritedContext?.token === coordinatorToken && inheritedContext.active;
    return enqueue(async () => {
      if (!reusesActiveLease) {
        await recoverConfiguredJournals({ throwOnPending: true });
      }
      return work();
    }, "exclusive");
  }

  function recoverPendingTransactions() {
    const currentContext = exclusiveContext.getStore();
    if (
      currentContext?.token === coordinatorToken &&
      currentContext.active &&
      currentContext.kind === "transaction"
    ) {
      return Promise.reject(
        configurationError(
          "config_write_nested_recovery",
          "configuration recovery cannot scan an active transaction",
        ),
      );
    }
    return enqueue(
      () => recoverConfiguredJournals({ throwOnPending: true }),
      "recovery",
    );
  }

  return {
    configure,
    recoverPendingTransactions,
    runExclusive,
    runTransaction,
  };
}
