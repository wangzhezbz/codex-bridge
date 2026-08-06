import assert from "node:assert/strict";
import test from "node:test";

import { createTransactionJournal, recoverTransactions } from "../desktop/software-manager/transaction-journal.mjs";
import { createVersionSlotManager, planPeakBytes } from "../desktop/software-manager/version-slots.mjs";

function clone(value) {
  return structuredClone(value);
}

function emptyState() {
  return {
    schemaVersion: 1,
    installRoot: "D:\\CodexBridge",
    components: {},
    skills: {},
    shortcuts: [],
    rollback: null,
    activeTask: null,
    lastTask: null,
  };
}

function createFixture({ componentId = "chatgpt", slots = {}, state = emptyState() } = {}) {
  const rootPath = componentId === "chatgpt"
    ? "D:\\CodexBridge\\ChatGPT"
    : `D:\\CodexBridge\\${componentId === "v2rayn" ? "V2RayN" : "Git"}`;
  const roots = new Map();
  const journals = new Map();
  const calls = [];
  let identitySeed = 0;
  let failRule = null;

  const rootSlots = new Map();
  for (const [name, version] of Object.entries(slots)) {
    rootSlots.set(name, {
      identity: { volumeSerial: "vol", fileId: `${version}-${++identitySeed}` },
      evidence: version === null ? null : { schemaVersion: 1, componentId, version },
      files: new Map(version === null ? [] : [[".codexbridge-version.json", "marker"]]),
    });
  }
  roots.set(rootPath.toLowerCase(), rootSlots);

  function maybeFail(kind, details, { after = false } = {}) {
    if (!failRule || failRule.kind !== kind || failRule.after !== after) return;
    if (failRule.match && !failRule.match(details)) return;
    const error = failRule.error;
    failRule = null;
    throw error;
  }

  function openVersionRootNoFollow(exactRoot) {
    assert.equal(exactRoot, rootPath);
    const liveSlots = roots.get(exactRoot.toLowerCase());
    let closed = false;
    const descriptors = new WeakMap();

    function requireOpen() {
      if (closed) throw new Error("fixture_root_closed");
    }

    function directoryHandle(slotNode) {
      return {
        async listChildren() {
          requireOpen();
          return [...slotNode.files.keys()];
        },
        async openChildNoFollow(name) {
          requireOpen();
          if (!slotNode.files.has(name)) throw new Error("fixture_file_missing");
          const descriptor = Object.freeze({ name, kind: "file" });
          descriptors.set(descriptor, { type: "file", slotNode, name });
          return descriptor;
        },
        async unlinkChildNoFollow(descriptor) {
          const internal = descriptors.get(descriptor);
          assert.equal(internal?.type, "file");
          internal.slotNode.files.delete(internal.name);
          calls.push(["delete-file", internal.name]);
        },
        async rmdirChildNoFollow() {
          throw new Error("fixture_nested_directory_unexpected");
        },
        async close() {},
      };
    }

    async function openSlot(name) {
      requireOpen();
      const node = liveSlots.get(name);
      if (!node) return null;
      const descriptor = Object.freeze({
        name,
        kind: "directory",
        identity: clone(node.identity),
        handle: directoryHandle(node),
      });
      descriptors.set(descriptor, { type: "slot", node, name });
      return { descriptor, evidence: node.evidence && { ...clone(node.evidence), identity: clone(node.identity) } };
    }

    const root = {
      async assertChildDescriptorNoFollow(descriptor) {
        const internal = descriptors.get(descriptor);
        if (internal?.type !== "slot") throw new Error("fixture_descriptor_invalid");
        return true;
      },
      async listChildren() {
        requireOpen();
        return [...liveSlots.keys()];
      },
      async openChildNoFollow(name) {
        const slot = await openSlot(name);
        if (!slot) throw Object.assign(new Error("entry_missing"), { code: "entry_missing" });
        return slot.descriptor;
      },
      async unlinkChildNoFollow() {
        throw new Error("fixture_root_file_unexpected");
      },
      async rmdirChildNoFollow(descriptor) {
        const internal = descriptors.get(descriptor);
        assert.equal(internal?.type, "slot");
        assert.equal(internal.node.files.size, 0);
        assert.equal(liveSlots.get(internal.name), internal.node);
        maybeFail("delete", { name: internal.name });
        liveSlots.delete(internal.name);
        calls.push(["delete-slot", internal.name]);
        maybeFail("delete", { name: internal.name }, { after: true });
      },
      openSlotNoFollow: openSlot,
      async sealPreparedSlotNoFollow(descriptor, metadata) {
        const internal = descriptors.get(descriptor);
        assert.equal(internal?.type, "slot");
        if (internal.node.evidence) {
          assert.deepEqual(internal.node.evidence, metadata);
        } else {
          internal.node.evidence = clone(metadata);
          internal.node.files.set(".codexbridge-version.json", "marker");
        }
        calls.push(["seal", internal.name, metadata.version]);
        return { ...clone(metadata), identity: clone(internal.node.identity) };
      },
      async renameSlotNoReplace(descriptor, destinationName) {
        const internal = descriptors.get(descriptor);
        assert.equal(internal?.type, "slot");
        assert.equal(liveSlots.get(internal.name), internal.node);
        maybeFail("rename", { from: internal.name, to: destinationName });
        if (liveSlots.has(destinationName)) throw Object.assign(new Error("entry_exists"), { code: "entry_exists" });
        liveSlots.delete(internal.name);
        liveSlots.set(destinationName, internal.node);
        calls.push(["rename-slot", internal.name, destinationName]);
        maybeFail("rename", { from: internal.name, to: destinationName }, { after: true });
      },
      async close() {
        closed = true;
        calls.push(["close-version-root"]);
      },
    };
    return root;
  }

  function openJournalDirectoryNoFollow(journalDir) {
    let files = journals.get(journalDir);
    if (!files) {
      files = new Map();
      journals.set(journalDir, files);
    }
    const entries = new WeakMap();
    return {
      async listFileNamesNoFollow() { return [...files.keys()]; },
      async openFileNoFollow(name, flags) {
        let file = files.get(name);
        if (flags === "r") {
          if (!file) return null;
        } else {
          if (file) throw Object.assign(new Error("entry_exists"), { code: "entry_exists" });
          file = { identity: `journal-${++identitySeed}`, data: "" };
          files.set(name, file);
        }
        const entry = Object.freeze({ name, identity: file.identity });
        entries.set(entry, file);
        return {
          entry,
          async readFile() { return file.data; },
          async writeFile(value) { file.data = String(value); calls.push(["journal-write", name]); },
          async sync() { calls.push(["journal-flush", name]); },
          async close() {},
        };
      },
      async unlinkEntryNoFollow(entry) {
        assert.equal(files.get(entry.name), entries.get(entry));
        maybeFail("journal-unlink", { name: entry.name });
        files.delete(entry.name);
        calls.push(["journal-unlink", entry.name]);
        maybeFail("journal-unlink", { name: entry.name }, { after: true });
      },
      async renameEntryNoFollow(entry, destinationName) {
        const file = entries.get(entry);
        assert.equal(files.get(entry.name), file);
        if (files.has(destinationName)) throw Object.assign(new Error("entry_exists"), { code: "entry_exists" });
        files.delete(entry.name);
        files.set(destinationName, file);
        calls.push(["journal-commit", destinationName]);
      },
      async close() {},
    };
  }

  let persisted = clone(state);
  const ownershipStore = {
    async load() { return clone(persisted); },
    async save(next) {
      maybeFail("state", next);
      persisted = clone(next);
      calls.push(["state-commit", next.components[componentId]?.version ?? null]);
      maybeFail("state", next, { after: true });
    },
  };
  const fsApi = {
    openVersionRootNoFollow: async (value) => openVersionRootNoFollow(value),
    openJournalDirectoryNoFollow: async (value) => openJournalDirectoryNoFollow(value),
  };
  const journalDir = "D:\\CodexBridge\\State\\transactions";
  const journal = createTransactionJournal({ journalDir, fsApi });
  const manager = createVersionSlotManager({ fsApi, ownershipStore, journal });

  return {
    rootPath,
    journalDir,
    journal,
    manager,
    calls,
    fsApi,
    ownershipStore,
    fail(kind, error, options = {}) {
      failRule = { kind, error, after: options.after === true, match: options.match };
    },
    versions() {
      const names = componentId === "chatgpt"
        ? { current: "c", previous: "cp", staging: "ct", retiring: "cr" }
        : { current: "current", previous: "previous", staging: "staging", retiring: "retiring" };
      return Object.fromEntries(Object.entries(names).map(([key, name]) => [key, rootSlots.get(name)?.evidence?.version ?? null]));
    },
    state() { return clone(persisted); },
  };
}

function installedState({ componentId = "chatgpt", current, previous = null, rootPath }) {
  const state = emptyState();
  const currentName = componentId === "chatgpt" ? "c" : "current";
  const previousName = componentId === "chatgpt" ? "cp" : "previous";
  state.components[componentId] = {
    installPath: `${rootPath}\\${currentName}`,
    version: current.version,
    slotIdentity: clone(current.identity),
    managed: true,
  };
  if (previous) {
    state.rollback = [{
      path: `${rootPath}\\${previousName}`,
      rootPath,
      componentId,
      version: previous.version,
      slotIdentity: clone(previous.identity),
    }];
  }
  return state;
}

function fixtureWithInstalled({ currentVersion, previousVersion = null, incomingVersion = null, componentId = "chatgpt" }) {
  const rootPath = componentId === "chatgpt"
    ? "D:\\CodexBridge\\ChatGPT"
    : `D:\\CodexBridge\\${componentId === "v2rayn" ? "V2RayN" : "Git"}`;
  const currentName = componentId === "chatgpt" ? "c" : "current";
  const previousName = componentId === "chatgpt" ? "cp" : "previous";
  const stagingName = componentId === "chatgpt" ? "ct" : "staging";
  const seed = createFixture({
    componentId,
    slots: {
      [currentName]: currentVersion,
      ...(previousVersion ? { [previousName]: previousVersion } : {}),
      ...(incomingVersion ? { [stagingName]: incomingVersion } : {}),
    },
  });
  const slotMap = componentId === "chatgpt"
    ? { current: "c", previous: "cp" }
    : { current: "current", previous: "previous" };
  const currentNode = seed.manager;
  void currentNode;
  const identityFromVersion = (version) => {
    const rename = seed.calls;
    void rename;
    // The fixture deterministically allocates file IDs in Object.entries order.
    const index = [currentVersion, previousVersion, incomingVersion].filter(Boolean).indexOf(version) + 1;
    return { volumeSerial: "vol", fileId: `${version}-${index}` };
  };
  const state = installedState({
    componentId,
    rootPath,
    current: { version: currentVersion, identity: identityFromVersion(currentVersion) },
    previous: previousVersion ? { version: previousVersion, identity: identityFromVersion(previousVersion) } : null,
  });
  return createFixture({
    componentId,
    slots: {
      [slotMap.current]: currentVersion,
      ...(previousVersion ? { [slotMap.previous]: previousVersion } : {}),
      ...(incomingVersion ? { [stagingName]: incomingVersion } : {}),
    },
    state,
  });
}

function promotionPlan(fixture, version, componentId = "chatgpt", taskId = `promote-${version.replaceAll(".", "-")}`) {
  return { taskId, componentId, rootPath: fixture.rootPath, version };
}

test("first install promotes only the verified staging slot and creates no rollback", async () => {
  const fixture = createFixture({ slots: { ct: null } });
  await fixture.manager.promotePreparedVersion(promotionPlan(fixture, "1.0.0"));
  assert.deepEqual(fixture.versions(), { current: "1.0.0", previous: null, staging: null, retiring: null });
  assert.equal(fixture.state().components.chatgpt.version, "1.0.0");
  assert.equal(fixture.state().rollback, null);
});

test("first update keeps the old current as previous and records one rollback", async () => {
  const fixture = fixtureWithInstalled({ currentVersion: "1.0.0", incomingVersion: "2.0.0" });
  await fixture.manager.promotePreparedVersion(promotionPlan(fixture, "2.0.0"));
  assert.deepEqual(fixture.versions(), { current: "2.0.0", previous: "1.0.0", staging: null, retiring: null });
  assert.equal(fixture.state().rollback[0].version, "1.0.0");
});

test("second update moves oldest to retiring, commits ownership, then deletes retiring", async () => {
  const fixture = fixtureWithInstalled({ currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0" });
  await fixture.manager.promotePreparedVersion(promotionPlan(fixture, "3.0.0"));
  assert.deepEqual(fixture.versions(), { current: "3.0.0", previous: "2.0.0", staging: null, retiring: null });

  const retiringWal = fixture.calls.findIndex((call) => call[0] === "journal-commit" && call[1] === "chatgpt.retiring_moved.json");
  const retireRename = fixture.calls.findIndex((call) => call[0] === "rename-slot" && call[1] === "cp" && call[2] === "cr");
  const oldWal = fixture.calls.findIndex((call) => call[0] === "journal-commit" && call[1] === "chatgpt.old_moved.json");
  const oldRename = fixture.calls.findIndex((call) => call[0] === "rename-slot" && call[1] === "c" && call[2] === "cp");
  const newWal = fixture.calls.findIndex((call) => call[0] === "journal-commit" && call[1] === "chatgpt.new_promoted.json");
  const newRename = fixture.calls.findIndex((call) => call[0] === "rename-slot" && call[1] === "ct" && call[2] === "c");
  const stateCommit = fixture.calls.findIndex((call) => call[0] === "state-commit");
  const stateWal = fixture.calls.findIndex((call) => call[0] === "journal-commit" && call[1] === "chatgpt.state_committed.json");
  const deletion = fixture.calls.findIndex((call) => call[0] === "delete-slot" && call[1] === "cr");
  assert.ok(retiringWal < retireRename && oldWal < oldRename && newWal < newRename);
  assert.ok(newRename < stateCommit && stateCommit < stateWal && stateWal < deletion);
});

test("a failed promotion retains journal and the oldest complete version until recovery commits state", async () => {
  const fixture = fixtureWithInstalled({ currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0" });
  fixture.fail("rename", new Error("promotion_crash"), {
    match: ({ from, to }) => from === "ct" && to === "c",
  });
  await assert.rejects(fixture.manager.promotePreparedVersion(promotionPlan(fixture, "3.0.0")), /promotion_crash/u);
  assert.equal(fixture.versions().retiring, "1.0.0");
  assert.equal(fixture.state().components.chatgpt.version, "2.0.0");

  await recoverTransactions({ journal: fixture.journal, slots: fixture.manager });
  assert.deepEqual(fixture.versions(), { current: "3.0.0", previous: "2.0.0", staging: null, retiring: null });
  assert.equal(fixture.state().components.chatgpt.version, "3.0.0");
});

test("recovery recognizes a cleanup-only journal left by a crash during final clear", async () => {
  const fixture = fixtureWithInstalled({ currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0" });
  fixture.fail("journal-unlink", new Error("journal_clear_crash"), {
    match: ({ name }) => name === "chatgpt.cleanup_committed.json",
  });
  await assert.rejects(fixture.manager.promotePreparedVersion(promotionPlan(fixture, "3.0.0")), /journal_clear_crash/u);
  const pending = await fixture.journal.listTransactions();
  assert.deepEqual(pending[0].records.map((item) => item.phase), ["cleanup_committed"]);
  assert.equal((await recoverTransactions({ journal: fixture.journal, slots: fixture.manager })).length, 1);
  assert.deepEqual(fixture.versions(), { current: "3.0.0", previous: "2.0.0", staging: null, retiring: null });
});

for (const crash of [
  { name: "after retiring rename", kind: "rename", after: true, match: ({ from, to }) => from === "cp" && to === "cr" },
  { name: "after old-current rename", kind: "rename", after: true, match: ({ from, to }) => from === "c" && to === "cp" },
  { name: "after incoming rename", kind: "rename", after: true, match: ({ from, to }) => from === "ct" && to === "c" },
  { name: "after ownership commit", kind: "state", after: true },
  { name: "before retiring deletion", kind: "delete", after: false },
  { name: "after retiring deletion", kind: "delete", after: true },
]) {
  test(`crash recovery is idempotent ${crash.name}`, async () => {
    const fixture = fixtureWithInstalled({ currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0" });
    fixture.fail(crash.kind, new Error(`crash_${crash.kind}`), crash);
    await assert.rejects(fixture.manager.promotePreparedVersion(promotionPlan(fixture, "3.0.0")), /crash_/u);
    const first = await recoverTransactions({ journal: fixture.journal, slots: fixture.manager });
    const second = await recoverTransactions({ journal: fixture.journal, slots: fixture.manager });
    assert.equal(first.length, 1);
    assert.deepEqual(second, []);
    assert.deepEqual(fixture.versions(), { current: "3.0.0", previous: "2.0.0", staging: null, retiring: null });
  });
}

test("rollback swaps the previous version into current, deletes the rejected newer version, and is one-time", async () => {
  const fixture = fixtureWithInstalled({ currentVersion: "2.0.0", previousVersion: "1.0.0" });
  await fixture.manager.rollbackVersion("chatgpt");
  assert.deepEqual(fixture.versions(), { current: "1.0.0", previous: null, staging: null, retiring: null });
  assert.equal(fixture.state().components.chatgpt.version, "1.0.0");
  assert.equal(fixture.state().rollback, null);
  await assert.rejects(fixture.manager.rollbackVersion("chatgpt"), /rollback_not_available/u);
});

test("failed rollback recovery never deletes the only complete version", async () => {
  const fixture = fixtureWithInstalled({ currentVersion: "2.0.0", previousVersion: "1.0.0" });
  fixture.fail("rename", new Error("rollback_crash"), {
    after: true,
    match: ({ from, to }) => from === "c" && to === "cr",
  });
  await assert.rejects(fixture.manager.rollbackVersion("chatgpt"), /rollback_crash/u);
  assert.equal(fixture.versions().retiring, "2.0.0");
  assert.equal(fixture.versions().previous, "1.0.0");
  assert.equal(fixture.calls.some((call) => call[0] === "delete-slot"), false);

  fixture.fail("rename", new Error("rollback_retry_failed"), {
    match: ({ from, to }) => from === "cp" && to === "c",
  });
  await assert.rejects(recoverTransactions({ journal: fixture.journal, slots: fixture.manager }), /rollback_retry_failed/u);
  assert.equal(fixture.versions().retiring, "2.0.0");
  assert.equal(fixture.versions().previous, "1.0.0");
  assert.equal(fixture.calls.some((call) => call[0] === "delete-slot"), false);
});

for (const crash of [
  { name: "after current retires", kind: "rename", after: true, match: ({ from, to }) => from === "c" && to === "cr" },
  { name: "after previous becomes current", kind: "rename", after: true, match: ({ from, to }) => from === "cp" && to === "c" },
  { name: "after rollback ownership commit", kind: "state", after: true },
  { name: "before rejected-version deletion", kind: "delete", after: false },
  { name: "after rejected-version deletion", kind: "delete", after: true },
]) {
  test(`rollback recovery is idempotent ${crash.name}`, async () => {
    const fixture = fixtureWithInstalled({ currentVersion: "2.0.0", previousVersion: "1.0.0" });
    fixture.fail(crash.kind, new Error(`rollback_${crash.kind}_crash`), crash);
    await assert.rejects(fixture.manager.rollbackVersion("chatgpt"), /rollback_.*_crash/u);
    assert.equal((await recoverTransactions({ journal: fixture.journal, slots: fixture.manager })).length, 1);
    assert.deepEqual(await recoverTransactions({ journal: fixture.journal, slots: fixture.manager }), []);
    assert.deepEqual(fixture.versions(), { current: "1.0.0", previous: null, staging: null, retiring: null });
    assert.equal(fixture.state().rollback, null);
  });
}

test("recovery rejects a missing required complete slot without deleting the last known complete version", async () => {
  const fixture = fixtureWithInstalled({ currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0" });
  fixture.fail("rename", new Error("crash_after_retire"), {
    after: true,
    match: ({ from, to }) => from === "cp" && to === "cr",
  });
  await assert.rejects(fixture.manager.promotePreparedVersion(promotionPlan(fixture, "3.0.0")), /crash_after_retire/u);
  // Simulate loss of the incoming staging tree. Recovery must fail closed and preserve both complete old slots.
  const root = await fixture.fsApi.openVersionRootNoFollow(fixture.rootPath);
  const staging = await root.openSlotNoFollow("ct");
  // The fixture exposes safe descriptor deletion only; remove its marker and then the exact staging slot.
  const marker = await staging.descriptor.handle.openChildNoFollow(".codexbridge-version.json");
  await staging.descriptor.handle.unlinkChildNoFollow(marker);
  await root.rmdirChildNoFollow(staging.descriptor);
  await root.close();

  await assert.rejects(recoverTransactions({ journal: fixture.journal, slots: fixture.manager }), /slot_complete_version_missing/u);
  assert.equal(fixture.versions().current, "2.0.0");
  assert.equal(fixture.versions().retiring, "1.0.0");
  assert.equal(fixture.calls.filter((call) => call[0] === "delete-slot" && call[1] === "cr").length, 0);
});

test("V2RayN and managed Git use readable fixed slot names", async () => {
  for (const componentId of ["v2rayn", "git"]) {
    const fixture = createFixture({ componentId, slots: { staging: null } });
    await fixture.manager.promotePreparedVersion(promotionPlan(fixture, "1.0.0", componentId));
    assert.deepEqual(fixture.versions(), { current: "1.0.0", previous: null, staging: null, retiring: null });
    assert.equal(fixture.calls.some((call) => call[0] === "rename-slot" && call[1] === "staging" && call[2] === "current"), true);
  }
});

test("slot manager fails closed without the native version-root capability", () => {
  assert.throws(
    () => createVersionSlotManager({ fsApi: {}, ownershipStore: { load() {}, save() {} }, journal: {} }),
    /slot_no_follow_capability_required/u,
  );
});

test("first-install promotion rejects a component root outside the ownership install root before mutation", async () => {
  const fixture = createFixture({ slots: { ct: null } });
  await assert.rejects(
    fixture.manager.promotePreparedVersion({
      taskId: "unauthorized-root",
      componentId: "chatgpt",
      rootPath: "D:\\Other\\ChatGPT",
      version: "1.0.0",
    }),
    /slot_root_not_owned/u,
  );
  assert.equal(fixture.calls.length, 0);
});

test("peak-space planning accepts only nonnegative safe integers and rejects overflow", () => {
  assert.equal(planPeakBytes({ current: 10, previous: 20, incoming: 30 }), 60);
  assert.equal(planPeakBytes({ current: 0, previous: 0, incoming: 1 }), 1);
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, "1"]) {
    assert.throws(() => planPeakBytes({ current: value, previous: 0, incoming: 1 }), /slot_bytes_invalid/u);
  }
  assert.throws(
    () => planPeakBytes({ current: Number.MAX_SAFE_INTEGER, previous: 0, incoming: 1 }),
    /slot_bytes_overflow/u,
  );
});
