import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createOwnershipStore } from "../desktop/software-manager/state-store.mjs";

const CANONICAL_SKILLS_ROOT = "C:\\Users\\me\\.codex\\skills";
const testStateLock = async () => ({ async release() {} });
const testOperationLease = async (_stateDir, { nonce, scope }) => ({ nonce, scope, async release() {} });

function state(installRoot = "C:\\Tools\\CodexBridge") {
  return {
    schemaVersion: 1,
    generation: 0,
    installRoot,
    components: {},
    skills: {},
    shortcuts: [],
    rollback: null,
    activeTask: null,
    lastTask: null,
  };
}

function committed(value, generation) {
  return { ...structuredClone(value), generation };
}

function legacyState(value = state()) {
  const legacy = structuredClone(value);
  delete legacy.generation;
  return legacy;
}

function createMemoryStateFs(initial = {}) {
  let nextIdentity = 1;
  let failFinalRename = false;
  const calls = [];
  const entries = new Map(Object.entries(initial).map(([name, data]) => [
    name,
    { data, identity: nextIdentity++, name },
  ]));

  function fileHandle(node) {
    return {
      entry: { identity: node.identity, name: node.name },
      async readFile() { calls.push(["read", node.name, node.identity]); return node.data; },
      async writeFile(data) { calls.push(["write", node.name, node.identity]); node.data = data; },
      async sync() { calls.push(["sync", node.name, node.identity]); },
      async close() { calls.push(["close-file", node.name, node.identity]); },
    };
  }

  function current(entry) {
    const node = entries.get(entry.name);
    if (!node || node.identity !== entry.identity) {
      throw Object.assign(new Error("stale_entry_identity"), { code: "stale_entry_identity" });
    }
    return node;
  }

  const fsApi = {
    async acquireStateLockNoFollow() {
      calls.push(["acquire-state-lock"]);
      let released = false;
      return { async release() { assert.equal(released, false); released = true; calls.push(["release-state-lock"]); } };
    },
    acquireOperationLeaseNoFollow: testOperationLease,
    async openStateDirectoryNoFollow(stateDir) {
      calls.push(["open-directory-no-follow", stateDir]);
      return {
        async openFileNoFollow(name, flags) {
          calls.push(["open-file-no-follow", name, flags]);
          if (flags === "r") return entries.has(name) ? fileHandle(entries.get(name)) : null;
          if (flags !== "wx" || entries.has(name)) throw Object.assign(new Error("entry_exists"), { code: "EEXIST" });
          const node = { data: "", identity: nextIdentity++, name };
          entries.set(name, node);
          return fileHandle(node);
        },
        async unlinkEntryNoFollow(entry) {
          calls.push(["unlink-entry-no-follow", entry.name, entry.identity]);
          current(entry);
          entries.delete(entry.name);
        },
        async renameEntryNoFollow(entry, destinationName) {
          calls.push(["rename-entry-no-follow", entry.name, destinationName, entry.identity]);
          if (failFinalRename && entry.name === "ownership.json.tmp" && destinationName === "ownership.json") {
            throw Object.assign(new Error("interrupted"), { code: "EIO" });
          }
          const node = current(entry);
          if (entries.has(destinationName)) throw Object.assign(new Error("destination_exists"), { code: "EEXIST" });
          entries.delete(entry.name);
          node.name = destinationName;
          entries.set(destinationName, node);
        },
        async close() { calls.push(["close-directory"]); },
      };
    },
  };

  return {
    calls,
    fsApi,
    get(name) { return entries.get(name)?.data ?? null; },
    replace(name, data) {
      entries.set(name, { data, identity: nextIdentity++, name });
    },
    setFailFinalRename(value) { failFinalRename = value; },
  };
}

test("missing or corrupt ownership state falls back to an empty schema", async () => {
  const memory = createMemoryStateFs();
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });
  assert.deepEqual(await store.load(), state(null));

  memory.replace("ownership.json", "{broken");
  assert.deepEqual(await store.load(), state(null));
});

test("a strict legacy eight-field main ownership file migrates to generation zero and is atomically published", async () => {
  const legacy = legacyState(state("C:\\Legacy"));
  const memory = createMemoryStateFs({ "ownership.json": JSON.stringify(legacy) });
  const store = createOwnershipStore({ stateDir: path.resolve("legacy-main"), fsApi: memory.fsApi });
  const loaded = await store.load();
  assert.deepEqual(loaded, { ...legacy, generation: 0 });
  assert.deepEqual(JSON.parse(memory.get("ownership.json")), loaded);
  assert.equal(memory.calls.some((call) => call[0] === "rename-entry-no-follow"
    && call[1] === "ownership.json.tmp" && call[2] === "ownership.json"), true);
});

test("legacy backup fallback migrates atomically without treating the old schema as empty", async () => {
  const legacy = legacyState(state("C:\\LegacyBackup"));
  const memory = createMemoryStateFs({
    "ownership.json": "{broken",
    "ownership.json.bak": JSON.stringify(legacy),
  });
  const store = createOwnershipStore({ stateDir: path.resolve("legacy-backup"), fsApi: memory.fsApi });
  assert.deepEqual(await store.load(), { ...legacy, generation: 0 });
  assert.deepEqual(JSON.parse(memory.get("ownership.json")), { ...legacy, generation: 0 });
});

test("legacy ownership preserves a known active transaction during migration", async () => {
  const current = state("D:\\CBApps");
  current.components.chatgpt = { managed: true, installPath: "D:\\CBApps\\c", version: "1.0.0" };
  current.activeTask = {
    kind: "component-uninstall", taskId: "legacy-uninstall", componentId: "chatgpt", rootPath: "D:\\CBApps",
  };
  const legacy = legacyState(current);
  const memory = createMemoryStateFs({ "ownership.json": JSON.stringify(legacy) });
  const store = createOwnershipStore({ stateDir: path.resolve("legacy-active"), fsApi: memory.fsApi });
  const loaded = await store.load();
  assert.deepEqual(loaded.activeTask, current.activeTask);
  assert.equal(loaded.generation, 0);
});

test("a generation-bearing round3 component prepare migrates only its exact known shape", async () => {
  const current = state("D:\\CBApps");
  current.activeTask = {
    kind: "component-prepare", taskId: "legacy-prepare", componentId: "chatgpt", version: "2.0.0",
  };
  const memory = createMemoryStateFs({
    "ownership.json": "{broken",
    "ownership.json.bak": JSON.stringify(current),
  });
  const store = createOwnershipStore({ stateDir: path.resolve("round3-prepare"), fsApi: memory.fsApi });
  const loaded = await store.load();
  assert.deepEqual(loaded.activeTask, {
    kind: "legacy-abandoned-prepare", originalKind: "component-prepare",
    taskId: "legacy-prepare", componentId: "chatgpt", version: "2.0.0",
  });
  assert.deepEqual(JSON.parse(memory.get("ownership.json")), loaded);
});

test("a generation-bearing round3 Git install migrates to strict discovery reconciliation", async () => {
  const current = state("D:\\CBApps");
  current.activeTask = {
    kind: "git-install", taskId: "legacy-git", version: "2.51.0",
    targetDir: "D:\\CBApps\\Git", executablePath: "D:\\CBApps\\Git\\cmd\\git.exe",
    installerPath: "D:\\CBApps\\downloads\\git-2.51.0.exe", installerSha256: "a".repeat(64),
    replacedInstaller: null,
  };
  const memory = createMemoryStateFs({ "ownership.json": JSON.stringify(current) });
  const store = createOwnershipStore({ stateDir: path.resolve("round3-git"), fsApi: memory.fsApi });
  const loaded = await store.load();
  assert.equal(loaded.activeTask.kind, "legacy-git-install-recovery");
  assert.equal(loaded.activeTask.taskId, "legacy-git");
  assert.equal(loaded.generation, 0);
  assert.deepEqual(JSON.parse(memory.get("ownership.json")), loaded);
});

test("round3 active tasks with an extra field stay invalid in main and backup", async () => {
  const current = state("D:\\CBApps");
  current.activeTask = {
    kind: "component-prepare", taskId: "legacy-extra", componentId: "chatgpt", version: "2.0.0", surprise: true,
  };
  for (const name of ["ownership.json", "ownership.json.bak"]) {
    const memory = createMemoryStateFs({ [name]: JSON.stringify(current) });
    const store = createOwnershipStore({ stateDir: path.resolve(`round3-invalid-${name}`), fsApi: memory.fsApi });
    await assert.rejects(store.load(), /ownership_state_invalid/u);
    assert.equal(JSON.parse(memory.get(name)).activeTask.surprise, true);
  }
});

test("bound archive prepare identity round-trips while Git and malformed identities fail closed", async () => {
  const bound = state("D:\\CBApps");
  bound.activeTask = {
    kind: "component-prepare", taskId: "bound-archive", componentId: "chatgpt", version: "2.0.0",
    leaseScope: "prepare", leaseNonce: "a".repeat(32),
    stagingName: `.p-${"b".repeat(32)}`,
    stagingIdentity: { volumeSerial: "volume", fileId: "staging" },
  };
  const memory = createMemoryStateFs({ "ownership.json": JSON.stringify(bound) });
  const store = createOwnershipStore({ stateDir: path.resolve("bound-archive"), fsApi: memory.fsApi });
  assert.deepEqual((await store.load()).activeTask, bound.activeTask);

  for (const activeTask of [
    { ...bound.activeTask, componentId: "git" },
    { ...bound.activeTask, stagingIdentity: { volumeSerial: "volume" } },
    { ...bound.activeTask, stagingIdentity: { volumeSerial: "volume", fileId: "staging", extra: true } },
  ]) {
    const invalid = state("D:\\CBApps");
    invalid.activeTask = activeTask;
    const invalidMemory = createMemoryStateFs({ "ownership.json": JSON.stringify(invalid) });
    const invalidStore = createOwnershipStore({
      stateDir: path.resolve(`bound-invalid-${Math.random()}`), fsApi: invalidMemory.fsApi,
    });
    await assert.rejects(invalidStore.load(), /ownership_state_invalid/u);
  }
});

test("unknown or extra legacy fields fail closed and are never replaced with an empty ownership file", async () => {
  const unknown = { ...legacyState(state("C:\\Legacy")), surprise: true };
  const serialized = JSON.stringify(unknown);
  const memory = createMemoryStateFs({ "ownership.json": serialized });
  const store = createOwnershipStore({ stateDir: path.resolve("legacy-invalid"), fsApi: memory.fsApi });
  await assert.rejects(store.load(), /ownership_state_invalid/u);
  assert.equal(memory.get("ownership.json"), serialized);
  assert.equal(memory.calls.some(([operation]) => ["write", "unlink-entry-no-follow", "rename-entry-no-follow"].includes(operation)), false);
});

test("save flushes ownership.json.tmp and atomically renames it", async () => {
  const memory = createMemoryStateFs();
  const calls = memory.calls;
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });
  const next = state();

  await store.save(next);

  assert.deepEqual(await store.load(), committed(next, 1));
  assert.ok(calls.find(([operation]) => operation === "sync"));
  assert.ok(calls.find((call) => call[0] === "rename-entry-no-follow"
    && call[1] === "ownership.json.tmp" && call[2] === "ownership.json"));
});

test("compareAndSwap rejects a stale persisted generation without mutating ownership", async () => {
  const memory = createMemoryStateFs();
  const store = createOwnershipStore({ stateDir: path.resolve("state-cas"), fsApi: memory.fsApi });
  const first = await store.compareAndSwap(0, state("C:\\First"));
  assert.equal(first.generation, 1);
  await assert.rejects(store.compareAndSwap(0, state("C:\\Stale")), /generation_conflict/u);
  assert.deepEqual(await store.load(), first);
});

test("a validated previous state is retained as ownership.json.bak", async () => {
  const memory = createMemoryStateFs();
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });
  const previous = state("C:\\Previous");
  const next = state("C:\\Next");
  await store.save(previous);
  await store.save(next);

  assert.deepEqual(JSON.parse(memory.get("ownership.json.bak")), committed(previous, 1));
  assert.deepEqual(await store.load(), committed(next, 2));
});

test("load falls back to a validated backup after interrupted atomic rename", async () => {
  const memory = createMemoryStateFs();
  const previous = state("C:\\Previous");
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });
  await store.save(previous);
  memory.setFailFinalRename(true);
  await assert.rejects(store.save(state("C:\\Next")), /interrupted/);

  assert.deepEqual(await store.load(), committed(previous, 1));
});

test("state files that are links or reparse points are never followed", async () => {
  const fsApi = {
    acquireStateLockNoFollow: testStateLock,
    acquireOperationLeaseNoFollow: testOperationLease,
    async openStateDirectoryNoFollow() {
      throw Object.assign(new Error("state_reparse_point"), { code: "state_reparse_point" });
    },
  };
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi });
  await assert.rejects(store.load(), /reparse/i);
});

test("save rejects malformed state before writing", async () => {
  let touched = false;
  const store = createOwnershipStore({
    stateDir: path.resolve("state"),
    fsApi: {
      acquireStateLockNoFollow: testStateLock,
      acquireOperationLeaseNoFollow: testOperationLease,
      async openStateDirectoryNoFollow() { touched = true; },
    },
  });
  await assert.rejects(store.save({ schemaVersion: 1 }), { code: "ownership_state_invalid" });
  assert.equal(touched, false);
});

test("fails closed when state fsApi has no stable no-follow capability", () => {
  assert.throws(() => createOwnershipStore({
    stateDir: path.resolve("state"),
    fsApi: {},
  }), /no.follow|capability/i);
});

test("state store fails closed when only a process-local queue exists without an OS lock capability", () => {
  assert.throws(() => createOwnershipStore({
    stateDir: path.resolve("state"),
    fsApi: { async openStateDirectoryNoFollow() {} },
  }), /state_lock_capability_required/u);
});

test("an OS lock release failure always releases the in-process gate for the next operation", async () => {
  const memory = createMemoryStateFs();
  let releases = 0;
  memory.fsApi.acquireStateLockNoFollow = async () => ({
    async release() {
      releases += 1;
      if (releases === 1) throw Object.assign(new Error("release_failed"), { code: "release_failed" });
    },
  });
  const store = createOwnershipStore({ stateDir: path.resolve("release-state"), fsApi: memory.fsApi });
  await assert.rejects(store.load(), { code: "release_failed" });
  const second = await Promise.race([
    store.load(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("memory_gate_stuck")), 100)),
  ]);
  assert.equal(second.generation, 0);
  assert.equal(releases, 2);
});

test("reads through a stable handle when the state path is replaced after open", async () => {
  const original = state("C:\\Original");
  const external = state("C:\\External");
  const memory = createMemoryStateFs({ "ownership.json": JSON.stringify(original) });
  const originalOpen = memory.fsApi.openStateDirectoryNoFollow;
  memory.fsApi.openStateDirectoryNoFollow = async (...args) => {
    const directory = await originalOpen(...args);
    const originalOpenFile = directory.openFileNoFollow;
    directory.openFileNoFollow = async (name, flags) => {
      const handle = await originalOpenFile(name, flags);
      if (name === "ownership.json" && handle) memory.replace(name, JSON.stringify(external));
      return handle;
    };
    return directory;
  };
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });
  assert.deepEqual(await store.load(), original);
});

for (const code of ["state_directory_reparse_point", "ancestor_reparse_point"]) {
  test(`rejects unsafe state directory capability result ${code}`, async () => {
    const store = createOwnershipStore({
      stateDir: path.resolve("state", "nested"),
      fsApi: {
        acquireStateLockNoFollow: testStateLock,
        acquireOperationLeaseNoFollow: testOperationLease,
        async openStateDirectoryNoFollow() { throw Object.assign(new Error(code), { code }); },
      },
    });
    await assert.rejects(store.load(), /reparse/i);
  });
}

test("identity-aware rename refuses a state entry replaced after stable open", async () => {
  const previous = state("C:\\Previous");
  const memory = createMemoryStateFs({ "ownership.json": JSON.stringify(previous) });
  const originalOpen = memory.fsApi.openStateDirectoryNoFollow;
  memory.fsApi.openStateDirectoryNoFollow = async (...args) => {
    const directory = await originalOpen(...args);
    const originalRename = directory.renameEntryNoFollow;
    directory.renameEntryNoFollow = async (entry, destination) => {
      if (entry.name === "ownership.json") {
        memory.replace(entry.name, JSON.stringify(state("C:\\External")));
      }
      return originalRename(entry, destination);
    };
    return directory;
  };
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });
  await assert.rejects(store.save(state("C:\\Next")), /stale_entry_identity/);
  assert.deepEqual(JSON.parse(memory.get("ownership.json")), state("C:\\External"));
});

const malformedNestedStateCases = [
  ["inherited top-level installRoot", () => Object.assign(Object.create({ installRoot: "C:\\Windows" }), {
    schemaVersion: 1,
    generation: 0,
    components: {},
    skills: {},
    shortcuts: [],
    rollback: null,
    activeTask: null,
    lastTask: null,
  })],
  ["string component", () => ({ ...state(), components: { app: "C:\\Windows" } })],
  ["array skill", () => ({ ...state(), skills: { documents: ["C:\\Windows"] } })],
  ["string shortcut", () => ({ ...state(), shortcuts: ["C:\\Windows"] })],
  ["malformed rollback", () => ({ ...state(), rollback: { message: "C:\\Windows" } })],
  ["array activeTask", () => ({ ...state(), activeTask: ["C:\\Windows"] })],
];

for (const [label, buildState] of malformedNestedStateCases) {
  test(`rejects malformed nested state before opening the state directory: ${label}`, async () => {
    const memory = createMemoryStateFs();
    const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });
    await assert.rejects(store.save(buildState()), { code: "ownership_state_invalid" });
    assert.deepEqual(memory.calls, []);
  });
}

test("malformed persisted nested state fails closed without mutation", async () => {
  const malformed = { ...state(), components: { app: "C:\\Windows" } };
  const memory = createMemoryStateFs({ "ownership.json": JSON.stringify(malformed) });
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });
  await assert.rejects(store.load(), { code: "ownership_state_invalid" });
  assert.equal(memory.calls.some(([operation]) => ["write", "unlink-entry-no-follow", "rename-entry-no-follow"].includes(operation)), false);
});

test("legacy shortcut ownership without an unforgeable marker fails closed without dropping the record", async () => {
  const legacyShortcutState = {
    ...state(),
    components: {
      chatgpt: {
        installPath: "C:\\Tools\\CodexBridge\\c",
        entrypointPath: "C:\\Tools\\CodexBridge\\c\\ChatGPT.exe",
      },
    },
    shortcuts: [{ path: "C:\\Users\\me\\Desktop\\ChatGPT.lnk" }],
  };
  const raw = JSON.stringify(legacyShortcutState);
  const memory = createMemoryStateFs({ "ownership.json": raw });
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });

  await assert.rejects(store.load(), { code: "ownership_state_invalid" });
  assert.equal(memory.get("ownership.json"), raw);
  assert.equal(memory.calls.some(([operation]) => ["write", "unlink-entry-no-follow", "rename-entry-no-follow"].includes(operation)), false);
});

test("retains JSON metadata while only fixed path fields define ownership records", async () => {
  const next = {
    ...state(),
    components: {
      app: { installPath: "C:\\Owned\\app", version: "C:\\Windows" },
      chatgpt: {
        managed: true,
        installPath: "C:\\Tools\\CodexBridge\\c",
        entrypointPath: "C:\\Tools\\CodexBridge\\c\\ChatGPT.exe",
      },
    },
    skills: { documents: { sha256: "C:\\Windows", target: "C:\\Owned\\skills\\documents" } },
    shortcuts: [{
      componentId: "chatgpt", name: "ChatGPT", path: "C:\\Owned\\ChatGPT.lnk",
      desktopPath: "C:\\Owned", targetPath: "C:\\Tools\\CodexBridge\\c\\ChatGPT.exe",
      creationId: "a".repeat(32),
    }],
    rollback: [{ path: "C:\\Owned\\rollback", reason: "update" }],
    activeTask: null,
    lastTask: { message: "C:\\Windows", progress: 50 },
  };
  const memory = createMemoryStateFs();
  const store = createOwnershipStore({
    stateDir: path.resolve("state"),
    fsApi: memory.fsApi,
    skillsRoot: "C:\\Owned\\skills",
  });
  await store.save(next);
  assert.deepEqual(await store.load(), committed(next, 1));
});

test("store saves and loads Skill ownership bound to its injected canonical Skills root", async () => {
  const next = {
    ...state(),
    skills: { documents: { target: "C:\\Users\\me\\.codex\\skills\\documents" } },
  };
  const memory = createMemoryStateFs();
  const store = createOwnershipStore({
    stateDir: path.resolve("state"),
    fsApi: memory.fsApi,
    skillsRoot: CANONICAL_SKILLS_ROOT,
  });

  await store.save(next);
  assert.deepEqual(await store.load(), committed(next, 1));
});

test("Skill replacement active task requires one strict persisted 128-bit swapId", async () => {
  const target = `${CANONICAL_SKILLS_ROOT}\\documents`;
  const baseTask = {
    kind: "skill-replace",
    phase: "reserved",
    taskId: "skill-swap",
    skillId: "documents",
    installRoot: "C:\\Owned",
    skillsRoot: CANONICAL_SKILLS_ROOT,
    target,
    version: "1.0.0",
    packageSha256: "a".repeat(64),
    skillMdSha256: "b".repeat(64),
    treeDigest: "c".repeat(64),
    manifestDigest: "d".repeat(64),
    previousEvidence: { kind: "absent" },
    leaseScope: "prepare",
    leaseNonce: "f".repeat(32),
  };

  const valid = { ...state("C:\\Owned"), activeTask: { ...baseTask, swapId: "e".repeat(32) } };
  const validMemory = createMemoryStateFs();
  const validStore = createOwnershipStore({
    stateDir: path.resolve("skill-swap-valid"),
    fsApi: validMemory.fsApi,
    skillsRoot: CANONICAL_SKILLS_ROOT,
  });
  await validStore.save(valid);
  assert.equal((await validStore.load()).activeTask.swapId, "e".repeat(32));

  for (const [label, activeTask] of [
    ["missing", baseTask],
    ["missing-install-root", { ...baseTask, installRoot: undefined, swapId: "e".repeat(32) }],
    ["foreign-install-root", { ...baseTask, installRoot: "D:\\Elsewhere", swapId: "e".repeat(32) }],
    ["bad-lease", { ...baseTask, leaseNonce: "f".repeat(31), swapId: "e".repeat(32) }],
    ["short", { ...baseTask, swapId: "e".repeat(31) }],
    ["uppercase", { ...baseTask, swapId: "E".repeat(32) }],
    ["extra", { ...baseTask, swapId: "e".repeat(32), surprise: true }],
  ]) {
    const memory = createMemoryStateFs();
    const store = createOwnershipStore({
      stateDir: path.resolve(`skill-swap-${label}`),
      fsApi: memory.fsApi,
      skillsRoot: CANONICAL_SKILLS_ROOT,
    });
    await assert.rejects(store.save({ ...state("C:\\Owned"), activeTask }), { code: "ownership_state_invalid" });
    assert.equal(memory.calls.length, 0);
  }
});

test("store fails closed for Skill ownership without an injected canonical Skills root", async () => {
  const withSkill = {
    ...state(),
    skills: { documents: { target: "C:\\Users\\me\\.codex\\skills\\documents" } },
  };
  const memory = createMemoryStateFs({ "ownership.json": JSON.stringify(withSkill) });
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });

  await assert.rejects(store.save(withSkill), { code: "ownership_state_invalid" });
  await assert.rejects(store.load(), { code: "ownership_state_invalid" });
  assert.equal(memory.calls.some(([operation]) => ["write", "unlink-entry-no-follow", "rename-entry-no-follow"].includes(operation)), false);
});

for (const [label, target] of [
  ["Windows prefix with the same .codex suffix", "C:\\Windows\\.codex\\skills\\documents"],
  ["another user", "C:\\Users\\other\\.codex\\skills\\documents"],
  ["another drive", "D:\\Users\\me\\.codex\\skills\\documents"],
  ["case alias", "c:\\Users\\me\\.codex\\skills\\documents"],
  ["trailing-dot alias", "C:\\Users\\me\\.codex\\skills\\documents."],
  ["nested target", "C:\\Users\\me\\.codex\\skills\\nested\\documents"],
  ["different Skill ID", "C:\\Users\\me\\.codex\\skills\\pdf"],
]) {
  test(`store rejects Skill ownership outside its injected canonical root: ${label}`, async () => {
    const invalid = { ...state(), skills: { documents: { target } } };
    const memory = createMemoryStateFs({ "ownership.json": JSON.stringify(invalid) });
    const store = createOwnershipStore({
      stateDir: path.resolve("state"),
      fsApi: memory.fsApi,
      skillsRoot: CANONICAL_SKILLS_ROOT,
    });

    await assert.rejects(store.save(invalid), { code: "ownership_state_invalid" });
    await assert.rejects(store.load(), { code: "ownership_state_invalid" });
    assert.equal(memory.calls.some(([operation]) => ["write", "unlink-entry-no-follow", "rename-entry-no-follow"].includes(operation)), false);
  });
}

const unsafeOwnershipStatePaths = [
  ["slash UNC", "//server/share/owned"],
  ["backslash UNC", "\\\\server\\share\\owned"],
  ["device namespace", "\\\\?\\C:\\owned"],
  ["DOS device namespace", "\\\\.\\C:\\owned"],
  ["non-drive absolute", "\\owned\\root"],
  ["trailing dot segment", "C:\\Owned.\\app"],
  ["trailing space segment", "C:\\Owned \\app"],
  [".codex data path", "C:\\Users\\me\\.codex\\data"],
];

for (const [label, unsafePath] of unsafeOwnershipStatePaths) {
  test(`state store fails closed for non-canonical ownership path: ${label}`, async () => {
    const invalid = state(unsafePath);
    const memory = createMemoryStateFs();
    const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });
    await assert.rejects(store.save(invalid), { code: "ownership_state_invalid" });
    assert.deepEqual(memory.calls, []);

    memory.replace("ownership.json", JSON.stringify(invalid));
    await assert.rejects(store.load(), { code: "ownership_state_invalid" });
    assert.equal(memory.calls.some(([operation]) => ["write", "unlink-entry-no-follow", "rename-entry-no-follow"].includes(operation)), false);
  });
}
