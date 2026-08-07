import path from "node:path";

import { recoverTransactions } from "./transaction-journal.mjs";
import { isVersionTransactionClaim } from "./version-slots.mjs";

const DEPENDENCY_KEYS = Object.freeze([
  "ownershipStore",
  "journal",
  "authorizeRoot",
  "createSlots",
]);
const COMPONENT_IDS = new Set(["chatgpt", "v2rayn", "git"]);
const COMPONENT_ROOT_NAMES = Object.freeze({ chatgpt: null, v2rayn: "V2RayN", git: "Git" });
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function recoveryError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDependencies(value) {
  return isPlainRecord(value)
    && Object.keys(value).length === DEPENDENCY_KEYS.length
    && DEPENDENCY_KEYS.every((key) => Object.hasOwn(value, key));
}

function canonicalInstallRoot(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_760
    || value.trim() !== value || value !== value.normalize("NFC") || value.includes("\0")) {
    throw recoveryError("offline_recovery_root_invalid");
  }
  const slashNormalized = value.replaceAll("/", "\\");
  if (slashNormalized.startsWith("\\\\") || !/^[A-Za-z]:\\/u.test(slashNormalized)) {
    throw recoveryError("offline_recovery_root_invalid");
  }
  const rawSegments = slashNormalized.slice(3).split("\\");
  const finalIndex = rawSegments.length - 1;
  if (rawSegments.some((segment, index) => (
    segment.length === 0 && index !== finalIndex
  ) || segment === "." || segment === ".." || segment.length > 255
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(segment) || /[ .]$/u.test(segment)
    || RESERVED_NAME.test(segment))) {
    throw recoveryError("offline_recovery_root_invalid");
  }
  const normalized = path.win32.normalize(slashNormalized).replace(/[\\]+$/u, "");
  const parsed = path.win32.parse(normalized);
  if (normalized.toLowerCase() === parsed.root.replace(/[\\]+$/u, "").toLowerCase()) {
    throw recoveryError("offline_recovery_root_invalid");
  }
  const segments = normalized.slice(parsed.root.length).split("\\");
  if (segments.length === 0 || segments.length > 64 || segments.some((segment) => (
    segment.length === 0 || segment.length > 255 || segment === "." || segment === ".."
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(segment) || /[ .]$/u.test(segment)
    || RESERVED_NAME.test(segment)
  ))) throw recoveryError("offline_recovery_root_invalid");
  return normalized;
}

function installRootFromComponentRoot(componentId, rootPath) {
  const componentRoot = canonicalInstallRoot(rootPath);
  if (componentId === "chatgpt") return componentRoot;
  const installRoot = canonicalInstallRoot(path.win32.dirname(componentRoot));
  if (componentRoot !== path.win32.join(installRoot, COMPONENT_ROOT_NAMES[componentId])) {
    throw recoveryError("offline_recovery_component_root_invalid");
  }
  return installRoot;
}

function rootFromTransaction(transaction) {
  if (!isPlainRecord(transaction) || !COMPONENT_IDS.has(transaction.componentId)
    || typeof transaction.taskId !== "string" || transaction.taskId.length === 0
    || !["promote", "rollback"].includes(transaction.mode) || !Array.isArray(transaction.records)
    || !isPlainRecord(transaction.snapshot)
    || transaction.snapshot.componentId !== transaction.componentId
    || transaction.snapshot.taskId !== transaction.taskId || transaction.snapshot.mode !== transaction.mode
    || typeof transaction.snapshot.rootPath !== "string") {
    throw recoveryError("offline_recovery_journal_invalid");
  }
  try {
    return installRootFromComponentRoot(transaction.componentId, transaction.snapshot.rootPath);
  } catch (error) {
    throw recoveryError("offline_recovery_journal_invalid", error);
  }
}

function rootFromActiveTask(ownership, journalScope) {
  const activeTask = ownership.activeTask;
  if (activeTask === null || activeTask === undefined) return null;
  if (!isPlainRecord(activeTask) || activeTask.kind !== "software-version-slot") return null;
  if (!isVersionTransactionClaim(activeTask) || activeTask.journalScope !== journalScope) {
    throw recoveryError("offline_recovery_state_invalid");
  }
  try {
    const installRoot = installRootFromComponentRoot(activeTask.componentId, activeTask.rootPath);
    if (ownership.installRoot !== null
      && canonicalInstallRoot(ownership.installRoot) !== installRoot) {
      throw recoveryError("offline_recovery_state_invalid");
    }
    return installRoot;
  } catch (error) {
    if (error?.code === "offline_recovery_state_invalid") throw error;
    throw recoveryError("offline_recovery_state_invalid", error);
  }
}

function inferUniqueRoot(ownership, transactions, journalScope) {
  if (!isPlainRecord(ownership)
    || !(ownership.installRoot === null || typeof ownership.installRoot === "string")
    || !Array.isArray(transactions)) {
    throw recoveryError("offline_recovery_state_invalid");
  }
  const candidates = [];
  if (ownership.installRoot !== null) candidates.push(ownership.installRoot);
  const activeTaskRoot = rootFromActiveTask(ownership, journalScope);
  if (activeTaskRoot !== null) candidates.push(activeTaskRoot);
  for (const transaction of transactions) candidates.push(rootFromTransaction(transaction));
  if (candidates.length === 0) return null;

  const unique = new Map();
  for (const candidate of candidates) {
    let canonical;
    try {
      canonical = canonicalInstallRoot(candidate);
    } catch (error) {
      throw recoveryError("offline_recovery_root_invalid", error);
    }
    const key = canonical.toLowerCase();
    if (!unique.has(key)) unique.set(key, canonical);
  }
  if (unique.size !== 1) throw recoveryError("offline_recovery_root_conflict");
  return unique.values().next().value;
}

export async function recoverOffline(dependencies) {
  if (!hasExactDependencies(dependencies)) {
    throw recoveryError("offline_recovery_dependencies_invalid");
  }
  const { ownershipStore, journal, authorizeRoot, createSlots } = dependencies;
  if (!ownershipStore || typeof ownershipStore.load !== "function"
    || !journal || typeof journal.scopeId !== "string"
    || typeof journal.listTransactions !== "function" || typeof journal.clear !== "function"
    || typeof authorizeRoot !== "function" || typeof createSlots !== "function") {
    throw recoveryError("offline_recovery_dependencies_invalid");
  }

  const ownership = await ownershipStore.load();
  let transactions;
  try {
    transactions = await journal.listTransactions();
  } catch (error) {
    throw recoveryError("offline_recovery_journal_invalid", error);
  }
  const installRoot = inferUniqueRoot(ownership, transactions, journal.scopeId);
  if (installRoot === null) {
    return Object.freeze({ status: "noop", installRoot: null, recovered: Object.freeze([]) });
  }

  let installRootCapability;
  try {
    installRootCapability = await authorizeRoot(installRoot);
  } catch (error) {
    throw recoveryError("offline_recovery_root_authorization_failed", error);
  }
  if (!installRootCapability || typeof installRootCapability !== "object") {
    throw recoveryError("offline_recovery_root_authorization_failed");
  }

  const slots = await createSlots({ installRootCapability });
  if (!slots || typeof slots.recoverJournalTransactions !== "function") {
    throw recoveryError("offline_recovery_slots_invalid");
  }
  const recovered = await recoverTransactions({ journal, slots });
  if (!Array.isArray(recovered)) throw recoveryError("offline_recovery_result_invalid");
  return Object.freeze({
    status: "recovered",
    installRoot,
    recovered: Object.freeze(structuredClone(recovered)),
  });
}
