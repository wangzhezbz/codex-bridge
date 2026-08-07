import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { createInstallRootResolver } from "../desktop/software-manager/install-root-resolver.mjs";
import { recoverOffline } from "../desktop/software-manager/offline-recovery.mjs";

function ownership(installRoot = null) {
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

function transaction(componentId, rootPath, taskId = `${componentId}-task`) {
  return {
    taskId,
    componentId,
    mode: "promote",
    records: [],
    snapshot: { taskId, componentId, mode: "promote", rootPath },
  };
}

function recoveryFixture({ installRoot = null, transactions = [], authorizeError = null } = {}) {
  const events = [];
  const persisted = ownership(installRoot);
  const journal = {
    listTransactions: async () => {
      events.push(["journal-list"]);
      return structuredClone(transactions);
    },
    clear: async () => {},
  };
  const capabilityByPath = new Map();
  const authorizeRoot = async (candidate) => {
    events.push(["authorize", candidate]);
    if (authorizeError) throw authorizeError;
    const normalized = path.win32.normalize(candidate).replace(/[\\]+$/u, "");
    const capability = Object.freeze(Object.create(null));
    capabilityByPath.set(capability, normalized);
    return capability;
  };
  const createSlots = ({ installRootCapability }) => {
    events.push(["create-slots", capabilityByPath.get(installRootCapability)]);
    assert.equal(capabilityByPath.has(installRootCapability), true);
    return {
      recoverJournalTransactions: async (receivedJournal) => {
        events.push(["recover", capabilityByPath.get(installRootCapability)]);
        assert.equal(receivedJournal, journal);
        return transactions.map(({ taskId, componentId, mode }) => ({ taskId, componentId, mode }));
      },
    };
  };
  return {
    input: {
      ownershipStore: { load: async () => structuredClone(persisted) },
      journal,
      authorizeRoot,
      createSlots,
    },
    persisted,
    events,
  };
}

test("install-root resolver restores persisted authority with a new process-local token", async () => {
  const calls = [];
  const persisted = { installRoot: "D:\\CBApps" };
  const resolver = createInstallRootResolver({
    authorizeRoot: async (candidate) => {
      calls.push(candidate);
      return Object.freeze({ authorizedPath: candidate });
    },
    getPersistedRoot: async () => persisted.installRoot,
  });

  assert.equal(resolver.getCurrentToken(), null);
  const restored = await resolver.restoreOwnedRoot();
  assert.match(restored, /^root_[a-f0-9]{32}$/u);
  assert.equal(resolver.getCurrentToken(), restored);
  assert.deepEqual(await resolver.resolve(restored), { authorizedPath: "D:\\CBApps" });
  assert.deepEqual(calls, ["D:\\CBApps"]);
  assert.deepEqual(persisted, { installRoot: "D:\\CBApps" });
  assert.equal(JSON.stringify(persisted).includes(restored), false);
});

test("install-root candidates are isolated until adopt and discard never revokes current", async () => {
  const resolver = createInstallRootResolver({
    authorizeRoot: async (candidate) => Object.freeze({ authorizedPath: candidate }),
    getPersistedRoot: () => "D:\\Current",
  });
  const original = await resolver.restoreOwnedRoot();
  const discarded = await resolver.choose("E:\\Discarded");
  assert.equal(resolver.getCurrentToken(), original);
  await resolver.discard(discarded.token);
  await assert.rejects(resolver.resolve(discarded.token), /install_root_token_invalid/u);
  assert.deepEqual(await resolver.resolve(original), { authorizedPath: "D:\\Current" });

  const adopted = await resolver.choose("F:\\Adopted");
  await resolver.adopt(adopted.token);
  assert.equal(resolver.getCurrentToken(), adopted.token);
  assert.deepEqual(await resolver.resolve(adopted.token), { authorizedPath: "F:\\Adopted" });
  await assert.rejects(resolver.resolve(original), /install_root_token_invalid/u);
  await resolver.discard(adopted.token);
  assert.deepEqual(await resolver.resolve(adopted.token), { authorizedPath: "F:\\Adopted" });
});

test("persisted ownership root is authorized before root-bound slot recovery", async () => {
  const fixture = recoveryFixture({ installRoot: "D:\\CBApps" });
  const result = await recoverOffline(fixture.input);
  assert.deepEqual(result, { status: "recovered", installRoot: "D:\\CBApps", recovered: [] });
  assert.deepEqual(fixture.events, [
    ["journal-list"],
    ["authorize", "D:\\CBApps"],
    ["create-slots", "D:\\CBApps"],
    ["recover", "D:\\CBApps"],
  ]);
});

test("ChatGPT first-install journal restores the journal root", async () => {
  const fixture = recoveryFixture({ transactions: [transaction("chatgpt", "D:\\CBApps")] });
  const result = await recoverOffline(fixture.input);
  assert.equal(result.installRoot, "D:\\CBApps");
  assert.equal(result.recovered[0].componentId, "chatgpt");
});

test("V2RayN first-install journal restores dirname(rootPath)", async () => {
  const fixture = recoveryFixture({ transactions: [transaction("v2rayn", "D:\\CBApps\\V2RayN")] });
  const result = await recoverOffline(fixture.input);
  assert.equal(result.installRoot, "D:\\CBApps");
  assert.deepEqual(fixture.events.slice(1, 3), [
    ["authorize", "D:\\CBApps"],
    ["create-slots", "D:\\CBApps"],
  ]);
});

test("duplicate evidence for one canonical root is accepted once", async () => {
  const fixture = recoveryFixture({
    installRoot: "D:\\CBApps\\",
    transactions: [
      transaction("chatgpt", "d:\\cbapps", "chatgpt-duplicate"),
      transaction("v2rayn", "D:\\CBApps\\V2RayN", "v2rayn-duplicate"),
    ],
  });
  const result = await recoverOffline(fixture.input);
  assert.equal(result.installRoot, "D:\\CBApps");
  assert.equal(fixture.events.filter(([name]) => name === "authorize").length, 1);
  assert.equal(fixture.events.filter(([name]) => name === "create-slots").length, 1);
});

test("conflicting roots fail closed before authorization or recovery", async () => {
  const fixture = recoveryFixture({
    installRoot: "D:\\CBApps",
    transactions: [transaction("chatgpt", "E:\\Other")],
  });
  await assert.rejects(recoverOffline(fixture.input), /offline_recovery_root_conflict/u);
  assert.deepEqual(fixture.events, [["journal-list"]]);
});

test("malformed journal evidence fails closed before authorization", async () => {
  const fixture = recoveryFixture({ transactions: [{ componentId: "chatgpt", snapshot: {} }] });
  await assert.rejects(recoverOffline(fixture.input), /offline_recovery_journal_invalid/u);
  assert.deepEqual(fixture.events, [["journal-list"]]);
});

test("journal traversal and noncanonical aliases fail before authority is issued", async () => {
  for (const rootPath of ["D:\\CBApps\\..\\Foreign", "D:\\CBApps\\\\Foreign", "D:\\CBApps\\slot. "]) {
    const fixture = recoveryFixture({ transactions: [transaction("chatgpt", rootPath)] });
    await assert.rejects(recoverOffline(fixture.input), /offline_recovery_journal_invalid/u);
    assert.deepEqual(fixture.events, [["journal-list"]]);
  }
});

test("invalid root authority fails closed before slot construction", async () => {
  const authorityError = Object.assign(new Error("install_root_identity_changed"), {
    code: "install_root_identity_changed",
  });
  const fixture = recoveryFixture({ installRoot: "D:\\CBApps", authorizeError: authorityError });
  await assert.rejects(recoverOffline(fixture.input), /offline_recovery_root_authorization_failed/u);
  assert.deepEqual(fixture.events, [
    ["journal-list"],
    ["authorize", "D:\\CBApps"],
  ]);
});

test("offline recovery rejects external dependency surfaces without invoking them", async () => {
  const fixture = recoveryFixture({ installRoot: "D:\\CBApps" });
  let externalCalls = 0;
  const forbidden = () => { externalCalls += 1; throw new Error("external_call"); };
  await assert.rejects(recoverOffline({
    ...fixture.input,
    fetch: forbidden,
    registry: forbidden,
    process: forbidden,
    shortcut: forbidden,
    installer: forbidden,
    shell: forbidden,
  }), /offline_recovery_dependencies_invalid/u);
  assert.equal(externalCalls, 0);
  assert.deepEqual(fixture.events, []);
});

test("no owned or journal root is a safe no-op", async () => {
  const fixture = recoveryFixture();
  const result = await recoverOffline(fixture.input);
  assert.deepEqual(result, { status: "noop", installRoot: null, recovered: [] });
  assert.deepEqual(fixture.events, [["journal-list"]]);
});
