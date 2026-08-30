import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { createInstallRootResolver } from "../desktop/software-manager/install-root-resolver.mjs";
import { recoverOffline } from "../desktop/software-manager/offline-recovery.mjs";
import { authorizeInstallRoot } from "../desktop/software-manager/path-policy.mjs";
import { createVersionSlotManager } from "../desktop/software-manager/version-slots.mjs";

const JOURNAL_SCOPE = "d:\\codexbridge\\state\\offline-transactions";

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

function versionClaim(componentId, rootPath, lifecycle = "active", taskId = `${componentId}-task`) {
  return {
    kind: "software-version-slot",
    schemaVersion: 1,
    lifecycle,
    journalScope: JOURNAL_SCOPE,
    taskId,
    componentId,
    mode: "promote",
    rootPath,
  };
}

function transaction(componentId, rootPath, taskId = `${componentId}-task`) {
  const slots = componentId === "chatgpt"
    ? { current: "c", previous: "cp", staging: "ct", retiring: "cr" }
    : { current: "current", previous: "previous", staging: "staging", retiring: "retiring" };
  const paths = Object.fromEntries(Object.entries(slots).map(([key, value]) => [key, `${rootPath}\\${value}`]));
  const incomingIdentity = { volumeSerial: "volume-1", fileId: `${componentId}-incoming` };
  const snapshot = {
    schemaVersion: 2,
    taskId,
    componentId,
    mode: "promote",
    phase: "prepared",
    rootPath,
    slots,
    paths,
    versions: { incoming: "1.0.0", current: null, previous: null },
    identities: { incoming: incomingIdentity, current: null, previous: null },
    integrities: {
      incoming: { treeDigest: "a".repeat(64), manifestDigest: "b".repeat(64) },
      current: null,
      previous: null,
    },
    runtimeMetadata: {
      entrypointPath: `${paths.current}\\app.exe`,
      requiredFiles: [`${paths.current}\\app.exe`],
      health: "pending-verify",
    },
    ownershipBefore: {
      installRoot: null,
      component: null,
      rollback: null,
      activeTask: versionClaim(componentId, rootPath, "active", taskId),
      lastTask: null,
    },
  };
  return {
    taskId,
    componentId,
    mode: "promote",
    records: [structuredClone(snapshot)],
    snapshot,
  };
}

function recoveryFixture({ installRoot = null, activeTask = null, transactions = [], authorizeError = null } = {}) {
  const events = [];
  const persisted = ownership(installRoot);
  persisted.activeTask = structuredClone(activeTask);
  const journal = {
    scopeId: JOURNAL_SCOPE,
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

function realEmptyJournalRecoveryFixture(lifecycle, { componentId = "chatgpt" } = {}) {
  const rootPath = componentId === "chatgpt" ? "D:\\CBApps" : `D:\\CBApps\\${componentId === "git" ? "Git" : "V2RayN"}`;
  let persisted = ownership(lifecycle === "clearing" ? "D:\\CBApps" : null);
  persisted.activeTask = versionClaim(componentId, rootPath, lifecycle);
  const journalCalls = [];
  const journal = Object.freeze({
    scopeId: JOURNAL_SCOPE,
    record: async () => { throw new Error("unexpected_journal_record"); },
    listTransactions: async () => {
      journalCalls.push("list");
      return [];
    },
    clear: async () => { throw new Error("unexpected_journal_clear"); },
  });
  const ownershipStore = {
    load: async () => structuredClone(persisted),
    async compareAndSwap(expectedGeneration, next) {
      assert.equal(expectedGeneration, persisted.generation);
      assert.equal(next.generation, persisted.generation + 1);
      persisted = structuredClone(next);
      return structuredClone(persisted);
    },
  };
  let versionRootOpens = 0;
  const fsApi = {
    openVersionRootNoFollow: async () => {
      versionRootOpens += 1;
      throw new Error("unexpected_version_root_open");
    },
  };
  const authorizeRoot = (candidate) => authorizeInstallRoot({
    candidate,
    env: {},
    maxRelativePath: 80,
    access: async () => {},
    realpath: async (expected) => expected,
    lstat: async () => ({
      dev: 7,
      ino: 11,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      isReparsePoint: () => false,
    }),
  });
  return {
    input: {
      ownershipStore,
      journal,
      authorizeRoot,
      createSlots: ({ installRootCapability }) => createVersionSlotManager({
        fsApi,
        ownershipStore,
        journal,
        installRootCapability,
      }),
    },
    state: () => structuredClone(persisted),
    journalCalls,
    versionRootOpens: () => versionRootOpens,
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
  assert.equal(resolver.getCurrentPath(), null);
  const restored = await resolver.restoreOwnedRoot();
  assert.match(restored, /^root_[a-f0-9]{32}$/u);
  assert.equal(resolver.getCurrentToken(), restored);
  assert.equal(resolver.getCurrentPath(), "D:\\CBApps");
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
  assert.equal(resolver.getCurrentPath(), "F:\\Adopted");
  assert.deepEqual(await resolver.resolve(adopted.token), { authorizedPath: "F:\\Adopted" });
  await assert.rejects(resolver.resolve(original), /install_root_token_invalid/u);
  await resolver.discard(adopted.token);
  assert.deepEqual(await resolver.resolve(adopted.token), { authorizedPath: "F:\\Adopted" });
});

test("install-root resolver can revoke the current process-local authority without persistence", async () => {
  const resolver = createInstallRootResolver({
    authorizeRoot: async (candidate) => Object.freeze({ authorizedPath: candidate }),
    getPersistedRoot: () => "D:\\Current",
  });
  const original = await resolver.restoreOwnedRoot();
  assert.equal(resolver.getCurrentToken(), original);
  await resolver.clearCurrent();
  assert.equal(resolver.getCurrentToken(), null);
  assert.equal(resolver.getCurrentPath(), null);
  await assert.rejects(resolver.resolve(original), /install_root_token_invalid/u);
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

test("reserved-before-WAL active claim restores root authority and is released by real slot recovery", async () => {
  const fixture = realEmptyJournalRecoveryFixture("reserved");
  const result = await recoverOffline(fixture.input);
  assert.deepEqual(result, { status: "recovered", installRoot: "D:\\CBApps", recovered: [] });
  assert.equal(fixture.state().activeTask, null);
  assert.deepEqual(fixture.journalCalls, ["list", "list"]);
  assert.equal(fixture.versionRootOpens(), 0);
});

test("clearing claim with an already-cleared journal is released by real slot recovery", async () => {
  const fixture = realEmptyJournalRecoveryFixture("clearing");
  const result = await recoverOffline(fixture.input);
  assert.equal(result.installRoot, "D:\\CBApps");
  assert.equal(fixture.state().activeTask, null);
  assert.equal(fixture.versionRootOpens(), 0);
});

test("active claim with a missing journal reaches the existing slot fail-closed path", async () => {
  const fixture = realEmptyJournalRecoveryFixture("active");
  await assert.rejects(recoverOffline(fixture.input), /slot_recovery_journal_missing/u);
  assert.equal(fixture.state().activeTask.lifecycle, "active");
  assert.equal(fixture.versionRootOpens(), 0);
});

test("Git reserved and clearing claims with an empty journal reach real slot release", async () => {
  for (const lifecycle of ["reserved", "clearing"]) {
    const fixture = realEmptyJournalRecoveryFixture(lifecycle, { componentId: "git" });
    const result = await recoverOffline(fixture.input);
    assert.deepEqual(result, { status: "recovered", installRoot: "D:\\CBApps", recovered: [] });
    assert.equal(fixture.state().activeTask, null);
    assert.deepEqual(fixture.journalCalls, ["list", "list"]);
    assert.equal(fixture.versionRootOpens(), 0);
  }
});

test("Git active claim with a missing journal reaches the real slot fail-closed path", async () => {
  const fixture = realEmptyJournalRecoveryFixture("active", { componentId: "git" });
  await assert.rejects(recoverOffline(fixture.input), /slot_recovery_journal_missing/u);
  assert.equal(fixture.state().activeTask.lifecycle, "active");
  assert.equal(fixture.versionRootOpens(), 0);
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

test("active claim and journal root conflict fails before authorization", async () => {
  const activeTask = versionClaim("chatgpt", "D:\\CBApps", "reserved");
  const fixture = recoveryFixture({
    activeTask,
    transactions: [transaction("chatgpt", "E:\\Other", "other-task")],
  });
  await assert.rejects(recoverOffline(fixture.input), /offline_recovery_root_conflict/u);
  assert.deepEqual(fixture.events, [["journal-list"]]);
});

test("malformed software-version-slot active claim fails before authorization", async () => {
  const malformedClaims = [
    { ...versionClaim("chatgpt", "D:\\CBApps", "reserved"), unexpected: true },
    versionClaim("v2rayn", "D:\\CBApps\\NotV2RayN", "reserved"),
    { ...versionClaim("chatgpt", "D:\\CBApps", "reserved"), journalScope: "d:\\foreign\\journal" },
    { ...versionClaim("git", "D:\\CBApps\\Git", "reserved"), unexpected: true },
    versionClaim("git", "D:\\CBApps\\NotGit", "reserved"),
    { ...versionClaim("git", "D:\\CBApps\\Git", "reserved"), journalScope: "d:\\foreign\\journal" },
  ];
  for (const activeTask of malformedClaims) {
    const fixture = recoveryFixture({ activeTask });
    await assert.rejects(recoverOffline(fixture.input), /offline_recovery_state_invalid/u);
    assert.deepEqual(fixture.events, [["journal-list"]]);
  }
});

test("Git active claim must agree exactly with a persisted install root", async () => {
  const fixture = recoveryFixture({
    installRoot: "E:\\Other",
    activeTask: versionClaim("git", "D:\\CBApps\\Git", "reserved"),
  });
  await assert.rejects(recoverOffline(fixture.input), /offline_recovery_state_invalid/u);
  assert.deepEqual(fixture.events, [["journal-list"]]);
});

test("V2RayN and Git journal roots require their exact fixed component leaf", async () => {
  for (const [componentId, rootPath] of [
    ["v2rayn", "D:\\CBApps\\NotV2RayN"],
    ["v2rayn", "D:\\CBApps\\v2rayn"],
    ["git", "D:\\CBApps\\NotGit"],
    ["git", "D:\\CBApps\\git"],
  ]) {
    const fixture = recoveryFixture({ transactions: [transaction(componentId, rootPath)] });
    await assert.rejects(recoverOffline(fixture.input), /offline_recovery_journal_invalid/u);
    assert.deepEqual(fixture.events, [["journal-list"]]);
  }
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
