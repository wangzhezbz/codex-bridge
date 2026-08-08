import fs from "node:fs/promises";
import path from "node:path";

function fakeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function resolveSafeRoot(env) {
  if (env?.CODEXBRIDGE_SOFTWARE_MANAGER_FAKE_HOST !== "1") {
    throw fakeError("software_manager_fake_host_not_enabled");
  }
  const root = path.resolve(String(env?.CODEXBRIDGE_SOFTWARE_MANAGER_TEST_ROOT || ""));
  const parsed = path.parse(root);
  if (!root || root === parsed.root || path.dirname(root) === root) {
    throw fakeError("software_manager_fake_host_root_rejected");
  }
  return root;
}

function inside(root, ...segments) {
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw fakeError("software_manager_fake_host_path_escape");
  }
  return target;
}

async function writeVersion(target, version) {
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "version.txt"), `${version}\n`, "utf8");
}

async function moveIfPresent(source, destination) {
  try {
    await fs.rename(source, destination);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function removeFileIfPresent(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function removeEmptyDirectory(directoryPath) {
  try {
    await fs.rmdir(directoryPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function runFakeHostTransaction({ env = process.env } = {}) {
  const root = resolveSafeRoot(env);
  const paths = [];
  const lifecycle = [];
  const externalCalls = [];
  const component = inside(root, "components", "chatgpt");
  const current = inside(component, "current");
  const previous = inside(component, "previous");
  const staging = inside(component, "staging");
  const journalDir = inside(root, "journal");
  const skillDir = inside(root, "skills", "documents");
  const cancelled = inside(root, "cancelled", "must-not-exist.txt");
  paths.push(component, current, previous, staging, journalDir, skillDir, cancelled);
  await fs.mkdir(component, { recursive: true });
  await fs.mkdir(journalDir, { recursive: true });

  await writeVersion(current, "1");
  lifecycle.push("install:1");

  await moveIfPresent(current, previous);
  await writeVersion(current, "2");
  lifecycle.push("update:2");

  await writeVersion(staging, "3");
  await removeFileIfPresent(path.join(previous, "version.txt"));
  await removeEmptyDirectory(previous);
  await moveIfPresent(current, previous);
  await moveIfPresent(staging, current);
  lifecycle.push("update:3");

  await moveIfPresent(current, staging);
  await moveIfPresent(previous, current);
  await moveIfPresent(staging, previous);
  lifecycle.push("rollback:2");

  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "version: 1\n", "utf8");
  await fs.writeFile(path.join(skillDir, "SKILL.md.next"), "version: 2\n", "utf8");
  await removeFileIfPresent(path.join(skillDir, "SKILL.md"));
  await fs.rename(path.join(skillDir, "SKILL.md.next"), path.join(skillDir, "SKILL.md"));
  lifecycle.push("skill:replace");

  const controller = new AbortController();
  controller.abort();
  if (!controller.signal.aborted) await fs.writeFile(cancelled, "unexpected", "utf8");
  lifecycle.push("cancel:verified");

  const recoveryJournal = path.join(journalDir, "recover.json");
  const recoveryTarget = inside(root, "recovered", "marker.txt");
  paths.push(recoveryJournal, recoveryTarget);
  await fs.writeFile(recoveryJournal, JSON.stringify({ target: recoveryTarget }), "utf8");
  const pending = JSON.parse(await fs.readFile(recoveryJournal, "utf8"));
  if (pending.target !== recoveryTarget) throw fakeError("software_manager_fake_host_journal_invalid");
  await fs.mkdir(path.dirname(recoveryTarget), { recursive: true });
  await fs.writeFile(recoveryTarget, "recovered\n", "utf8");
  await fs.unlink(recoveryJournal);
  lifecycle.push("journal:recovered");

  for (const slot of [current, previous]) {
    await removeFileIfPresent(path.join(slot, "version.txt"));
    await removeEmptyDirectory(slot);
  }
  lifecycle.push("uninstall:complete");

  const skillText = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
  const journalEntries = await fs.readdir(journalDir);
  return Object.freeze({
    lifecycle: Object.freeze(lifecycle),
    externalCalls: Object.freeze(externalCalls),
    paths: Object.freeze(paths),
    currentVersion: null,
    previousVersion: null,
    skillVersion: /version:\s*(\d+)/u.exec(skillText)?.[1] || null,
    cancelledMutationPresent: await fs.stat(cancelled).then(() => true, () => false),
    pendingJournalCount: journalEntries.length,
  });
}
