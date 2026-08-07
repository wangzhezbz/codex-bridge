import test from "node:test";
import assert from "node:assert/strict";

import { createSoftwareManagerService } from "../desktop/software-manager/service.mjs";

const COMPONENT_IDS = ["chatgpt", "v2rayn", "git"];

function operationResult(componentId, action, status = "succeeded", extra = {}) {
  return {
    componentId,
    action,
    status,
    versionBefore: null,
    versionAfter: status === "succeeded" && action !== "uninstall" ? "2.0.0" : null,
    message: `${componentId}_${action}_${status}`,
    rollbackAvailable: false,
    ...extra,
  };
}

function componentEntry(id, version = "2.0.0") {
  return Object.freeze({
    id,
    name: id === "chatgpt" ? "ChatGPT" : id === "v2rayn" ? "V2RayN" : "Git",
    version,
    size: 100,
    supportsRollback: true,
  });
}

function skillEntry(id = "documents") {
  return Object.freeze({ id, name: id, description: `${id} description`, version: "1.0.0", size: 10 });
}

function catalogFixture({ skills = [skillEntry()] } = {}) {
  const components = new Map(COMPONENT_IDS.map((id) => [id, componentEntry(id)]));
  const skillMap = new Map(skills.map((entry) => [entry.id, entry]));
  return Object.freeze({
    getComponent(id) {
      if (!components.has(id)) throw new Error("catalog_component_entry_missing");
      return components.get(id);
    },
    getSkill(id) {
      if (!skillMap.has(id)) throw new Error("catalog_skill_entry_missing");
      return skillMap.get(id);
    },
    listSkills() { return [...skillMap.values()]; },
  });
}

function adapterFixture(id, options = {}) {
  const calls = options.calls ?? [];
  const inspect = options.inspect ?? operationResult(id, "inspect", "skipped", { message: `${id}_not_installed` });
  const invoke = async (action, context) => {
    calls.push({ id, action, context });
    if (options[action]) return options[action](context);
    return operationResult(id, action);
  };
  return {
    inspectInstalled: (context) => invoke("inspect", context).then((value) => options.inspect ? value : inspect),
    prepare: (context) => invoke("prepare", context),
    commit: (context) => invoke("commit", context),
    verify: (context) => invoke("verify", context),
    uninstall: (context) => invoke("uninstall", context),
    rollback: (context) => invoke("rollback", context),
  };
}

function skillsAdapterFixture(options = {}) {
  const calls = options.calls ?? [];
  const invoke = async (action, context) => {
    calls.push({ id: "skills", action, context });
    if (options[action]) return options[action](context);
    return (context.skillIds ?? []).map((id) => operationResult(id, action));
  };
  return {
    inspectInstalled: (context) => invoke("inspect", context),
    prepare: (context) => invoke("prepare", context),
    commit: (context) => invoke("commit", context),
    verify: (context) => invoke("verify", context),
    uninstall: (context) => invoke("uninstall", context),
    rollback: (context) => invoke("rollback", context),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixtureService(options = {}) {
  const calls = options.calls ?? [];
  const state = options.state ?? {
    activeTask: null,
    components: {},
    skills: {},
    rollback: null,
  };
  const adapters = {
    chatgpt: adapterFixture("chatgpt", { calls, ...(options.chatgpt ?? {}) }),
    v2rayn: adapterFixture("v2rayn", { calls, ...(options.v2rayn ?? {}) }),
    git: adapterFixture("git", { calls, ...(options.git ?? {}) }),
    skills: skillsAdapterFixture({ calls, ...(options.skills ?? {}) }),
    ...(options.adapters ?? {}),
  };
  const catalogProvider = options.catalogProvider ?? {
    getCurrent: () => options.catalogUnavailable ? null : (options.catalogService ?? catalogFixture()),
    refresh: async () => options.catalogUnavailable ? null : (options.catalogService ?? catalogFixture()),
  };
  let tick = 0;
  const service = createSoftwareManagerService({
    platform: options.platform ?? "win32",
    catalogProvider,
    adapters: options.adapterFactory && options.fixedAdapters === undefined ? null : (options.fixedAdapters ?? adapters),
    ownershipStore: options.ownershipStore ?? { load: async () => structuredClone(state) },
    recoverTransactions: options.recoverTransactions ?? (async () => []),
    installRootResolver: options.installRootResolver ?? {
      choose: async () => ({ token: "root_token_00000001", capability: { kind: "root" } }),
      resolve: async () => ({ kind: "root" }),
      getCurrentToken: () => "root_token_00000001",
      adopt: async () => {},
      discard: async () => {},
    },
    adapterFactory: options.adapterFactory,
    logSink: options.logSink,
    clock: options.clock ?? { now: () => 1_700_000_000_000 + tick++ },
    taskIdFactory: options.taskIdFactory ?? (() => "task-1"),
    maxPendingLogWrites: options.maxPendingLogWrites,
    logWriteTimeoutMs: options.logWriteTimeoutMs,
    maxListenerQueue: options.maxListenerQueue,
  });
  return { service, calls, state, adapters };
}

test("module exposes the complete service interface", () => {
  const { service } = fixtureService();
  for (const method of [
    "getSnapshot", "chooseInstallRoot", "refresh", "startTask", "cancelTask",
    "recoverPending", "hasCriticalTask", "prepareForQuit", "beginQuit", "refreshQuit", "releaseQuit", "subscribe",
  ]) assert.equal(typeof service[method], "function", method);
});

test("non-Windows snapshots are disabled and cannot start a task", async () => {
  const { service } = fixtureService({ platform: "darwin" });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.platform, "darwin");
  await assert.rejects(
    service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] }),
    /software_manager_platform_disabled/,
  );
});

test("catalog-unavailable snapshot is read-only without exposing package authority", async () => {
  const { service } = fixtureService({ catalogUnavailable: true });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.catalog.available, false);
  assert.equal(JSON.stringify(snapshot).includes("assetUrl"), false);
  await assert.rejects(
    service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] }),
    /software_manager_catalog_unavailable/,
  );
});

test("install defaults select only ChatGPT and update defaults follow adapter inspection", async () => {
  const { service } = fixtureService({
    chatgpt: { inspect: async () => operationResult("chatgpt", "inspect", "succeeded", { versionBefore: "1.0.0", versionAfter: "1.0.0" }) },
    v2rayn: { inspect: async () => operationResult("v2rayn", "inspect", "succeeded", { versionBefore: "2.0.0", versionAfter: "2.0.0" }) },
  });
  const snapshot = await service.getSnapshot();
  assert.deepEqual(snapshot.defaults.install.componentIds, ["chatgpt"]);
  assert.deepEqual(snapshot.defaults.install.skillIds, []);
  assert.deepEqual(snapshot.defaults.update.componentIds, ["chatgpt"]);
  assert.equal(snapshot.components.find(({ id }) => id === "v2rayn").updateState, "current");
  assert.equal(snapshot.components.find(({ id }) => id === "git").updateState, "not-installed");
});

test("rollback tab is absent when no eligible record exists", async () => {
  const { service } = fixtureService();
  assert.equal((await service.getSnapshot()).tabs.includes("rollback"), false);
});

test("rollback tab is present only for a recent eligible adapter record", async () => {
  const { service } = fixtureService({
    chatgpt: { inspect: async () => operationResult("chatgpt", "inspect", "succeeded", {
      versionBefore: "2.0.0", versionAfter: "2.0.0", rollbackAvailable: true,
    }) },
  });
  const snapshot = await service.getSnapshot();
  assert.deepEqual(snapshot.tabs, ["install", "update", "uninstall", "rollback"]);
  assert.deepEqual(snapshot.rollback.map(({ id }) => id), ["chatgpt"]);
});

test("chooseInstallRoot returns only an opaque token and adapters receive only resolved authority", async () => {
  const seen = [];
  const events = [];
  const adopted = [];
  const discarded = [];
  const { service } = fixtureService({
    installRootResolver: {
      choose: async (candidate) => { seen.push(candidate); return { token: "opaque_root_123456", capability: { proof: 7 } }; },
      resolve: async (token) => { seen.push(token); return { proof: 7 }; },
      getCurrentToken: () => "opaque_root_123456",
      adopt: async (token) => { adopted.push(token); },
      discard: async (token) => { discarded.push(token); },
    },
    adapterFactory: ({ installRootCapability }) => {
      assert.deepEqual(installRootCapability, { proof: 7 });
      return {
        chatgpt: adapterFixture("chatgpt"), v2rayn: adapterFixture("v2rayn"),
        git: adapterFixture("git"), skills: skillsAdapterFixture(),
      };
    },
  });
  service.subscribe((event) => events.push(event));
  assert.deepEqual(await service.chooseInstallRoot("C:\\Chosen"), { installRootToken: "opaque_root_123456" });
  assert.equal(events.some(({ type }) => type === "snapshot"), true);
  const result = await service.startTask({
    kind: "install", componentIds: ["chatgpt"], skillIds: [], installRootToken: "opaque_root_123456",
  });
  assert.equal(result.status, "succeeded");
  assert.equal(seen.includes("C:\\Chosen"), true);
  assert.equal(seen.filter((value) => value !== "C:\\Chosen").every((value) => value === "opaque_root_123456"), true);
  assert.deepEqual(adopted, ["opaque_root_123456"]);
  assert.deepEqual(discarded, []);
  assert.equal(JSON.stringify(result).includes("C:\\Chosen"), false);
});

test("a failed install-root candidate is discarded without revoking the committed token", async () => {
  const oldToken = "root_token_00000001";
  const candidateToken = "root_token_00000002";
  const available = new Set([oldToken]);
  let current = oldToken;
  const events = [];
  const { service } = fixtureService({
    installRootResolver: {
      getCurrentToken: () => current,
      choose: async () => { available.add(candidateToken); return { token: candidateToken }; },
      resolve: async (token) => {
        if (!available.has(token)) throw new Error("unknown root token");
        return { token };
      },
      adopt: async (token) => {
        assert.equal(token, candidateToken);
        available.delete(current);
        current = token;
      },
      discard: async (token) => { if (token !== current) available.delete(token); },
    },
    adapterFactory: async ({ installRootCapability }) => {
      if (installRootCapability.token === candidateToken) throw new Error("candidate inspection failed");
      return {
        chatgpt: adapterFixture("chatgpt"), v2rayn: adapterFixture("v2rayn"),
        git: adapterFixture("git"), skills: skillsAdapterFixture(),
      };
    },
  });
  service.subscribe((event) => events.push(event));
  await assert.rejects(service.chooseInstallRoot("C:\\Candidate"), /software_manager_snapshot_failed/);
  assert.equal(current, oldToken);
  assert.deepEqual(await service.startTask({
    kind: "install", componentIds: ["chatgpt"], skillIds: [], installRootToken: oldToken,
  }).then(({ status }) => status), "succeeded");
  assert.equal(available.has(oldToken), true);
  assert.equal(available.has(candidateToken), false);
  assert.equal(events.some(({ type }) => type === "snapshot"), false);
});

test("request schema is exact, ordered, duplicate-free, and authority-safe", async () => {
  const { service } = fixtureService();
  const invalid = [
    null,
    { kind: "execute", componentIds: [], skillIds: [] },
    { kind: "install", componentIds: ["unknown"], skillIds: [] },
    { kind: "install", componentIds: ["chatgpt", "chatgpt"], skillIds: [] },
    { kind: "install", componentIds: [], skillIds: ["documents", "documents"] },
    { kind: "install", componentIds: [], skillIds: ["../documents"] },
    { kind: "install", componentIds: [], skillIds: ["not-in-catalog"] },
    { kind: "install", componentIds: [], skillIds: [] },
    { kind: "update", componentIds: [], skillIds: ["documents"] },
    { kind: "rollback", componentIds: [], skillIds: ["documents"] },
    { kind: "install", componentIds: [], skillIds: [], installRoot: "C:\\attacker" },
    { kind: "install", componentIds: [], skillIds: [], catalog: {} },
    { kind: "install", componentIds: [], skillIds: [], installRootToken: "C:\\raw-path" },
  ];
  for (const request of invalid) await assert.rejects(service.startTask(request), /software_manager_request_invalid/);

  const { service: ordered, calls } = fixtureService();
  await ordered.startTask({ kind: "install", componentIds: ["v2rayn", "chatgpt"], skillIds: [] });
  assert.deepEqual(calls.filter(({ action }) => action === "prepare").map(({ id }) => id), ["v2rayn", "chatgpt"]);
});

test("a catalog that cannot provide complete trusted public entries stays read-only and rejects tasks", async () => {
  const { service } = fixtureService({
    catalogService: {
      getComponent: () => { throw new Error("catalog corrupt"); },
      getSkill: () => { throw new Error("catalog corrupt"); },
      listSkills: () => [],
    },
  });
  assert.equal((await service.getSnapshot()).readOnly, true);
  await assert.rejects(
    service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] }),
    /software_manager_catalog_unavailable/,
  );
});

test("malformed catalog metadata never becomes renderer-visible authority", async () => {
  const { service } = fixtureService({
    catalogService: {
      getComponent: (id) => ({ id, name: id, version: "not-a-version", size: -1, supportsRollback: "yes", assetUrl: "https://secret" }),
      getSkill: () => { throw new Error("missing"); },
      listSkills: () => [],
    },
  });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.readOnly, true);
  assert.equal(JSON.stringify(snapshot).includes("https://secret"), false);
  await assert.rejects(
    service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] }),
    /software_manager_catalog_unavailable/,
  );
});

test("continues with the next component after one independent failure", async () => {
  const { service } = fixtureService({
    chatgpt: { prepare: async () => operationResult("chatgpt", "prepare", "failed") },
  });
  const result = await service.startTask({ kind: "install", componentIds: ["chatgpt", "v2rayn"], skillIds: [] });
  assert.deepEqual(result.components.map(({ status }) => status), ["failed", "succeeded"]);
  assert.equal(result.status, "partial");
});

test("update re-inspects selected components and skips an already-current version without preparing it", async () => {
  let prepares = 0;
  const { service } = fixtureService({
    chatgpt: {
      inspect: async () => operationResult("chatgpt", "inspect", "succeeded", { versionBefore: "2.0.0", versionAfter: "2.0.0" }),
      prepare: async () => { prepares += 1; return operationResult("chatgpt", "prepare"); },
    },
  });
  const result = await service.startTask({ kind: "update", componentIds: ["chatgpt"], skillIds: [] });
  assert.equal(prepares, 0);
  assert.deepEqual(result.components.map(({ status }) => status), ["skipped"]);
  assert.match(result.components[0].message, /already_current/);
});

test("components execute serially in request order", async () => {
  const order = [];
  const first = deferred();
  const started = deferred();
  const { service } = fixtureService({
    chatgpt: {
      prepare: async () => { order.push("chatgpt:prepare"); started.resolve(); await first.promise; return operationResult("chatgpt", "prepare"); },
      commit: async () => { order.push("chatgpt:commit"); return operationResult("chatgpt", "commit"); },
    },
    v2rayn: { prepare: async () => { order.push("v2rayn:prepare"); return operationResult("v2rayn", "prepare"); } },
  });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt", "v2rayn"], skillIds: [] });
  await started.promise;
  assert.deepEqual(order, ["chatgpt:prepare"]);
  first.resolve();
  await running;
  assert.deepEqual(order.slice(0, 3), ["chatgpt:prepare", "chatgpt:commit", "v2rayn:prepare"]);
});

test("duplicate and concurrent starts reject immediately while recovery is pending", async () => {
  const recovery = deferred();
  const { service } = fixtureService({ recoverTransactions: () => recovery.promise });
  const first = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  await assert.rejects(
    service.startTask({ kind: "install", componentIds: ["v2rayn"], skillIds: [] }),
    /software_manager_task_running/,
  );
  recovery.resolve([]);
  await first;
});

test("a start waiting on recovery is not exposed as an accepted task", async () => {
  const recovery = deferred();
  const { service } = fixtureService({ recoverTransactions: () => recovery.promise });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  assert.deepEqual(service.prepareForQuit(), { allowQuit: true });
  assert.deepEqual(service.cancelTask(), { cancelled: false, reason: "idle" });
  recovery.resolve([]);
  const result = await running;
  assert.equal(result.status, "succeeded");
  assert.equal(result.components.length, 1);
});

test("recovery runs before new work and fails closed on a persistent Task 7 claim", async () => {
  const order = [];
  const state = { activeTask: { kind: "component-prepare", taskId: "other", componentId: "chatgpt", version: "2.0.0", leaseScope: "prepare", leaseNonce: "1".repeat(32) }, components: {}, skills: {}, rollback: null };
  const { service } = fixtureService({
    state,
    recoverTransactions: async () => { order.push("recover"); },
    chatgpt: { inspect: async () => { order.push("inspect"); return operationResult("chatgpt", "inspect", "failed"); } },
  });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.pendingRecovery, true);
  assert.equal(snapshot.task.external, true);
  await assert.rejects(
    service.startTask({ kind: "install", componentIds: ["v2rayn"], skillIds: [] }),
    /software_manager_pending_recovery/,
  );
  assert.deepEqual(order, ["recover", "recover"]);
});

test("a later start retries failed recovery and proceeds only after the durable claim clears", async () => {
  const state = {
    activeTask: { kind: "component-prepare", taskId: "other", componentId: "chatgpt", version: "2.0.0" },
    components: {}, skills: {}, rollback: null,
  };
  let recoveries = 0;
  const { service } = fixtureService({
    state,
    recoverTransactions: async () => {
      recoveries += 1;
      if (recoveries === 2) state.activeTask = null;
    },
  });
  assert.equal((await service.recoverPending()).pending, true);
  const result = await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  assert.equal(recoveries, 2);
  assert.equal(result.status, "succeeded");
});

test("an installed Skill remains eligible for uninstall after it leaves the current catalog", async () => {
  const state = {
    activeTask: null, components: {}, rollback: null,
    skills: { legacy: { version: "1.0.0", target: "C:\\Skills\\legacy", packageSha256: "a".repeat(64), skillMdSha256: "b".repeat(64) } },
  };
  const { service } = fixtureService({
    state,
    skills: {
      inspect: async ({ skillIds }) => skillIds.map((id) => operationResult(id, "inspect", "succeeded", { versionBefore: "1.0.0", versionAfter: "1.0.0" })),
    },
  });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.skills.some(({ componentId }) => componentId === "legacy"), true);
  const result = await service.startTask({ kind: "uninstall", componentIds: [], skillIds: ["legacy"] });
  assert.equal(result.skills[0].status, "succeeded");
});

test("catalog provider exceptions produce a read-only snapshot instead of escaping", async () => {
  const { service } = fixtureService({
    catalogProvider: {
      getCurrent: async () => { throw new Error("network token=secret"); },
      refresh: async () => { throw new Error("network token=secret"); },
    },
  });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.catalog.available, false);
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);
});

test("cancel aborts a cancellable download and never enters commit", async () => {
  const entered = deferred();
  let commitCalled = false;
  const { service } = fixtureService({
    chatgpt: {
      prepare: async ({ signal, onProgress }) => {
        assert.equal(signal instanceof AbortSignal, true);
        onProgress({ phase: "download", percent: 10, message: "downloading" });
        entered.resolve();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return operationResult("chatgpt", "prepare", "failed", { message: "download_cancelled" });
      },
      commit: async () => { commitCalled = true; return operationResult("chatgpt", "commit"); },
    },
  });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  await entered.promise;
  assert.deepEqual(service.cancelTask(), { cancelled: true });
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(commitCalled, false);
});

test("late progress after abort cannot re-enable cancellation", async () => {
  const entered = deferred();
  const release = deferred();
  const late = deferred();
  const finish = deferred();
  const progressEvents = [];
  const { service } = fixtureService({
    chatgpt: {
      prepare: async ({ signal, onProgress }) => {
        entered.resolve({ signal, onProgress });
        await release.promise;
        onProgress({ phase: "download", percent: 90, message: "late" });
        late.resolve();
        await finish.promise;
        return operationResult("chatgpt", "prepare", "failed");
      },
    },
  });
  service.subscribe((event) => { if (event.type === "progress") progressEvents.push(event); });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  const { signal } = await entered.promise;
  assert.deepEqual(service.cancelTask(), { cancelled: true });
  assert.equal(signal.aborted, true);
  release.resolve();
  await late.promise;
  await Promise.resolve();
  assert.equal(progressEvents.at(-1).cancellable, false);
  assert.equal(service.hasCriticalTask(), false);
  finish.resolve();
  await running;
  assert.deepEqual(service.cancelTask(), { cancelled: false, reason: "idle" });
});

test("a stale prepare progress callback cannot downgrade critical commit state", async () => {
  let staleProgress;
  const commitEntered = deferred();
  const commitRelease = deferred();
  const events = [];
  const { service } = fixtureService({
    chatgpt: {
      prepare: async ({ onProgress }) => {
        staleProgress = onProgress;
        return operationResult("chatgpt", "prepare");
      },
      commit: async (context) => {
        assert.equal(Object.hasOwn(context, "signal"), false);
        commitEntered.resolve();
        await commitRelease.promise;
        return operationResult("chatgpt", "commit");
      },
    },
  });
  service.subscribe((event) => { if (event.type === "progress") events.push(event); });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  await commitEntered.promise;
  const before = events.length;
  await staleProgress({ phase: "download", percent: 99, message: "stale" });
  assert.equal(events.length, before);
  assert.equal(service.hasCriticalTask(), true);
  assert.deepEqual(service.cancelTask(), { cancelled: false, reason: "critical" });
  commitRelease.resolve();
  assert.equal((await running).status, "succeeded");
});

test("critical commit scope ends before the next component prepare without reviving stale progress", async () => {
  let staleProgress;
  const secondEntered = deferred();
  let secondSignal;
  const events = [];
  const { service } = fixtureService({
    chatgpt: {
      prepare: async ({ onProgress }) => { staleProgress = onProgress; return operationResult("chatgpt", "prepare"); },
    },
    v2rayn: {
      prepare: async ({ signal, onProgress }) => {
        secondSignal = signal;
        await onProgress({ phase: "download", percent: 1, message: "second-ready" });
        secondEntered.resolve();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return operationResult("v2rayn", "prepare", "failed");
      },
    },
  });
  service.subscribe((event) => { if (event.type === "progress") events.push(event); });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt", "v2rayn"], skillIds: [] });
  await secondEntered.promise;
  assert.equal(service.hasCriticalTask(), false);
  assert.deepEqual(service.prepareForQuit(), { allowQuit: false, reason: "running", canCancel: true });
  const before = events.length;
  await staleProgress({ phase: "download", percent: 99, message: "stale-first" });
  assert.equal(events.length, before);
  assert.deepEqual(service.cancelTask(), { cancelled: true });
  assert.equal(secondSignal.aborted, true);
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.components.map(({ status }) => status), ["succeeded", "failed"]);
});

test("only an accepted cancellable-phase cancel makes the final result cancelled", async () => {
  const entered = deferred();
  const release = deferred();
  const { service } = fixtureService({
    chatgpt: {
      prepare: async ({ signal }) => {
        entered.resolve(signal);
        await release.promise;
        return operationResult("chatgpt", "prepare");
      },
    },
  });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  const signal = await entered.promise;
  assert.deepEqual(service.cancelTask(), { cancelled: true });
  assert.equal(signal.aborted, true);
  release.resolve();
  const result = await running;
  assert.equal(result.status, "cancelled");
});

test("accepted cancellation has one stable cancelling state for cancel and quit", async () => {
  const entered = deferred();
  const release = deferred();
  const { service } = fixtureService({
    chatgpt: {
      prepare: async ({ signal }) => {
        entered.resolve(signal);
        await release.promise;
        return operationResult("chatgpt", "prepare", "failed");
      },
    },
  });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  const signal = await entered.promise;
  assert.deepEqual(service.cancelTask(), { cancelled: true });
  assert.equal(signal.aborted, true);
  assert.deepEqual(service.cancelTask(), { cancelled: false, reason: "already_cancelled" });
  assert.deepEqual(service.prepareForQuit(), { allowQuit: false, reason: "cancelling", canCancel: false });
  release.resolve();
  assert.equal((await running).status, "cancelled");
});

test("cancel is disabled before critical commit and no AbortSignal reaches critical code", async () => {
  const entered = deferred();
  const release = deferred();
  const progress = [];
  const { service } = fixtureService({
    chatgpt: {
      commit: async (context) => {
        assert.equal(Object.hasOwn(context, "signal"), false);
        entered.resolve();
        await release.promise;
        return operationResult("chatgpt", "commit");
      },
    },
  });
  service.subscribe((event) => { if (event.type === "progress") progress.push(event); });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  await entered.promise;
  assert.equal(service.hasCriticalTask(), true);
  assert.deepEqual(service.cancelTask(), { cancelled: false, reason: "critical" });
  assert.deepEqual(service.prepareForQuit(), { allowQuit: false, reason: "critical" });
  assert.equal(progress.at(-1).cancellable, false);
  release.resolve();
  await running;
  assert.equal(service.hasCriticalTask(), false);
});

test("uninstall and rollback are critical from entry and never receive AbortSignal", async () => {
  for (const kind of ["uninstall", "rollback"]) {
    const entered = deferred();
    const release = deferred();
    const operation = async (context) => {
      assert.equal(Object.hasOwn(context, "signal"), false);
      entered.resolve(); await release.promise; return operationResult("chatgpt", kind);
    };
    const { service } = fixtureService({ chatgpt: { [kind]: operation } });
    const running = service.startTask({ kind, componentIds: ["chatgpt"], skillIds: [] });
    await entered.promise;
    assert.deepEqual(service.cancelTask(), { cancelled: false, reason: "critical" });
    release.resolve(); await running;
  }
});

test("quit decisions distinguish idle, cancellable running, and critical", async () => {
  const entered = deferred();
  const { service } = fixtureService({
    chatgpt: {
      prepare: async ({ signal }) => {
        entered.resolve();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return operationResult("chatgpt", "prepare", "failed");
      },
    },
  });
  assert.deepEqual(service.prepareForQuit(), { allowQuit: true });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  await entered.promise;
  assert.deepEqual(service.prepareForQuit(), { allowQuit: false, reason: "running", canCancel: true });
  service.cancelTask(); await running;
  assert.deepEqual(service.prepareForQuit(), { allowQuit: true });
});

test("quit reservation is atomic with a start waiting on recovery and blocks later starts until release", async () => {
  const recovery = deferred();
  const { service } = fixtureService({ recoverTransactions: () => recovery.promise });
  const starting = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  const quitting = service.beginQuit();
  recovery.resolve([]);
  await assert.rejects(starting, /software_manager_quit_reserved/);
  const decision = await quitting;
  assert.equal(decision.allowQuit, true);
  assert.equal(typeof decision.reservation, "object");
  await assert.rejects(
    service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] }),
    /software_manager_quit_reserved/,
  );
  assert.equal(service.releaseQuit(decision.reservation), true);
  assert.equal((await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] })).status, "succeeded");
});

test("quit reservation observes an accepted running task without waiting for that task to finish", async () => {
  const entered = deferred();
  const { service } = fixtureService({
    chatgpt: {
      prepare: async ({ signal }) => {
        entered.resolve();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return operationResult("chatgpt", "prepare", "failed");
      },
    },
  });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  await entered.promise;
  const decision = await Promise.race([
    service.beginQuit(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("quit reservation waited for running task")), 100)),
  ]);
  assert.deepEqual(
    { allowQuit: decision.allowQuit, reason: decision.reason, canCancel: decision.canCancel },
    { allowQuit: false, reason: "running", canCancel: true },
  );
  assert.deepEqual(service.cancelTask(), { cancelled: true });
  await running;
  assert.deepEqual(await service.refreshQuit(decision.reservation), { allowQuit: true });
  assert.equal(service.releaseQuit(decision.reservation), true);
});

test("recovery failure makes synchronous and reserved quit decisions fail closed", async () => {
  const { service } = fixtureService({
    recoverTransactions: async () => { throw new Error("recovery failed"); },
  });
  assert.equal((await service.recoverPending()).pending, true);
  assert.deepEqual(service.prepareForQuit(), { allowQuit: false, reason: "critical" });
  const decision = await service.beginQuit();
  assert.equal(decision.allowQuit, false);
  assert.equal(decision.reason, "critical");
  assert.equal(service.releaseQuit(decision.reservation), true);
});

test("finishing log drain is non-critical and non-cancellable across cancel, quit, and snapshot", async () => {
  const entered = deferred();
  const release = deferred();
  const { service } = fixtureService({
    logWriteTimeoutMs: 5_000,
    logSink: {
      async write(entry) {
        if (entry.phase === "finished") { entered.resolve(); await release.promise; }
      },
    },
  });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  await entered.promise;
  assert.deepEqual(service.cancelTask(), { cancelled: false, reason: "not_cancellable" });
  assert.deepEqual(service.prepareForQuit(), { allowQuit: false, reason: "running", canCancel: false });
  const task = (await service.getSnapshot()).task;
  assert.deepEqual({ phase: task.phase, critical: task.critical, cancellable: task.cancellable }, {
    phase: "finishing", critical: false, cancellable: false,
  });
  release.resolve();
  assert.equal((await running).status, "succeeded");
});

test("critical state is reset even when an adapter throws", async () => {
  const { service } = fixtureService({ chatgpt: { commit: async () => { throw new Error("boom"); } } });
  const result = await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  assert.equal(result.status, "failed");
  assert.equal(service.hasCriticalTask(), false);
  assert.deepEqual(service.prepareForQuit(), { allowQuit: true });
});

test("an external durable claim is one consistent effective critical task", async () => {
  const state = {
    activeTask: {
      kind: "component-prepare", taskId: "other", componentId: "chatgpt", version: "2.0.0",
      leaseNonce: "N".repeat(32),
    },
    components: {}, skills: {}, rollback: null,
  };
  let chooseCalls = 0;
  const { service } = fixtureService({
    state,
    installRootResolver: {
      choose: async () => { chooseCalls += 1; return { token: "root_token_00000002" }; },
      resolve: async () => ({ kind: "root" }),
      getCurrentToken: () => "root_token_00000001",
      adopt: async () => {},
      discard: async () => {},
    },
  });
  const snapshot = await service.getSnapshot();
  assert.deepEqual(Object.keys(snapshot.task).sort(), [
    "cancellable", "componentId", "critical", "external", "kind", "phase", "taskId",
  ]);
  assert.equal(snapshot.task.external, true);
  assert.equal(snapshot.task.critical, true);
  assert.equal(JSON.stringify(snapshot).includes("N".repeat(32)), false);
  assert.equal(service.hasCriticalTask(), true);
  assert.deepEqual(service.prepareForQuit(), { allowQuit: false, reason: "critical" });
  assert.deepEqual(service.cancelTask(), { cancelled: false, reason: "critical" });
  await assert.rejects(service.chooseInstallRoot("C:\\New"), /software_manager_pending_recovery/);
  await assert.rejects(service.refresh(), /software_manager_pending_recovery/);
  assert.equal(chooseCalls, 0);
});

test("external skill claims expose only the public kind and normalized component id", async () => {
  const state = {
    activeTask: {
      kind: "skill-prepare", taskId: "other", skillId: "documents", target: "C:\\secret\\documents",
      digest: "f".repeat(64), nonce: "N".repeat(32),
    },
    components: {}, skills: {}, rollback: null,
  };
  const { service } = fixtureService({ state });
  const task = (await service.getSnapshot()).task;
  assert.deepEqual({ ...task }, {
    external: true,
    critical: true,
    cancellable: false,
    taskId: "other",
    kind: "skill-prepare",
    phase: "skill-prepare",
    componentId: "documents",
  });
  assert.equal(JSON.stringify(task).includes("secret"), false);
  assert.equal(JSON.stringify(task).includes("N".repeat(32)), false);
});

test("external task component identity is derived from kind-specific fixed fields", async () => {
  const state = {
    activeTask: {
      kind: "git-uninstall", taskId: "other", componentId: "chatgpt", skillId: "documents",
      targetDir: "C:\\secret\\git",
    },
    components: {}, skills: {}, rollback: null,
  };
  const { service } = fixtureService({ state });
  const task = (await service.getSnapshot()).task;
  assert.equal(task.kind, "git-uninstall");
  assert.equal(task.componentId, "git");
  assert.equal(JSON.stringify(task).includes("chatgpt"), false);
  assert.equal(JSON.stringify(task).includes("documents"), false);
});

test("snapshot retries stale recovery through the entry gate after an external claim clears", async () => {
  const state = {
    activeTask: { kind: "component-prepare", taskId: "other", componentId: "chatgpt", version: "2.0.0" },
    components: {}, skills: {}, rollback: null,
  };
  let recoveries = 0;
  const { service } = fixtureService({ state, recoverTransactions: async () => { recoveries += 1; } });
  assert.equal((await service.getSnapshot()).pendingRecovery, true);
  state.activeTask = null;
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.pendingRecovery, false);
  assert.equal(snapshot.readOnly, false);
  assert.equal(recoveries, 2);
});

test("refresh and root choice enter the gate before retrying one stale recovery", async () => {
  const state = {
    activeTask: { kind: "component-prepare", taskId: "other", componentId: "chatgpt", version: "2.0.0" },
    components: {}, skills: {}, rollback: null,
  };
  let recoveries = 0;
  const { service } = fixtureService({ state, recoverTransactions: async () => { recoveries += 1; } });
  assert.equal((await service.getSnapshot()).pendingRecovery, true);
  state.activeTask = null;
  const [refreshed, chosen] = await Promise.all([service.refresh(), service.chooseInstallRoot("C:\\Chosen")]);
  assert.equal(refreshed.pendingRecovery, false);
  assert.match(chosen.installRootToken, /^root_token_/u);
  assert.equal(recoveries, 2);
});

test("concurrent explicit recovery callers share one recovery execution", async () => {
  const entered = deferred();
  const release = deferred();
  let recoveries = 0;
  const { service } = fixtureService({
    recoverTransactions: async () => { recoveries += 1; entered.resolve(); await release.promise; },
  });
  const first = service.recoverPending();
  const second = service.recoverPending();
  await entered.promise;
  assert.equal(recoveries, 1);
  release.resolve();
  assert.deepEqual(await first, await second);
  assert.equal(recoveries, 1);
});

test("entry gate preserves refresh-before-start ordering in the same turn", async () => {
  const order = [];
  const serviceCatalog = catalogFixture();
  const { service } = fixtureService({
    catalogProvider: {
      getCurrent: () => serviceCatalog,
      refresh: async () => { order.push("refresh"); return serviceCatalog; },
    },
    chatgpt: {
      prepare: async () => { order.push("prepare"); return operationResult("chatgpt", "prepare"); },
    },
  });
  const refreshing = service.refresh();
  const starting = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  await Promise.all([refreshing, starting]);
  assert.deepEqual(order.slice(0, 2), ["refresh", "prepare"]);
});

test("every asynchronous entry gate fresh-loads a durable claim created after a healthy recovery", async () => {
  for (const entry of ["snapshot", "refresh", "choose", "start", "recover"]) {
    const state = { activeTask: null, components: {}, skills: {}, rollback: null };
    let recoveries = 0;
    const { service } = fixtureService({ state, recoverTransactions: async () => { recoveries += 1; } });
    assert.equal((await service.getSnapshot()).pendingRecovery, false);
    state.activeTask = {
      kind: "component-prepare", taskId: `external-${entry}`, componentId: "chatgpt", version: "2.0.0",
    };
    if (entry === "snapshot") {
      const snapshot = await service.getSnapshot();
      assert.equal(snapshot.pendingRecovery, true);
      assert.equal(snapshot.task.external, true);
      assert.deepEqual(service.prepareForQuit(), { allowQuit: false, reason: "critical" });
    } else if (entry === "refresh") {
      await assert.rejects(service.refresh(), /software_manager_pending_recovery/);
    } else if (entry === "choose") {
      await assert.rejects(service.chooseInstallRoot("C:\\Chosen"), /software_manager_pending_recovery/);
    } else if (entry === "start") {
      await assert.rejects(
        service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] }),
        /software_manager_pending_recovery/,
      );
    } else {
      assert.equal((await service.recoverPending()).pending, true);
    }
    assert.equal(recoveries, 2, entry);
  }
});

test("healthy fresh ownership checks stay cheap and concurrent claim recovery runs once", async () => {
  const state = { activeTask: null, components: {}, skills: {}, rollback: null };
  let recoveries = 0;
  const { service } = fixtureService({
    state,
    recoverTransactions: async () => {
      recoveries += 1;
      if (recoveries === 2) state.activeTask = null;
    },
  });
  await service.getSnapshot();
  await service.refresh();
  await service.chooseInstallRoot("C:\\Chosen");
  assert.equal((await service.getSnapshot()).pendingRecovery, false);
  assert.equal(recoveries, 1);

  state.activeTask = { kind: "component-prepare", taskId: "external-race", componentId: "chatgpt", version: "2.0.0" };
  const [refreshed, chosen] = await Promise.all([service.refresh(), service.chooseInstallRoot("C:\\Other")]);
  assert.equal(refreshed.pendingRecovery, false);
  assert.match(chosen.installRootToken, /^root_token_/u);
  assert.equal(recoveries, 2);
});

test("fresh ownership recheck catches claims created during refresh, root choice, and start preflight", async () => {
  for (const entry of ["refresh", "choose", "start"]) {
    const state = { activeTask: null, components: {}, skills: {}, rollback: null };
    let prepareCalls = 0;
    let armStartClaim = false;
    const serviceCatalog = catalogFixture();
    const claim = () => {
      state.activeTask = { kind: "component-prepare", taskId: `race-${entry}`, componentId: "chatgpt", version: "2.0.0" };
    };
    const options = { state, recoverTransactions: async () => {} };
    if (entry === "refresh") {
      options.catalogProvider = { getCurrent: () => serviceCatalog, refresh: async () => { claim(); return serviceCatalog; } };
    } else if (entry === "choose") {
      options.installRootResolver = {
        choose: async () => { claim(); return { token: "root_token_00000002" }; },
        resolve: async () => ({ kind: "root" }),
        getCurrentToken: () => "root_token_00000001",
        adopt: async () => {},
        discard: async () => {},
      };
    } else {
      options.adapterFactory = async () => {
        if (armStartClaim) claim();
        return {
          chatgpt: adapterFixture("chatgpt", { prepare: async () => { prepareCalls += 1; return operationResult("chatgpt", "prepare"); } }),
          v2rayn: adapterFixture("v2rayn"), git: adapterFixture("git"), skills: skillsAdapterFixture(),
        };
      };
    }
    const { service } = fixtureService(options);
    await service.getSnapshot();
    if (entry === "start") armStartClaim = true;
    if (entry === "refresh") await assert.rejects(service.refresh(), /software_manager_pending_recovery/);
    else if (entry === "choose") await assert.rejects(service.chooseInstallRoot("C:\\Race"), /software_manager_pending_recovery/);
    else await assert.rejects(
      service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] }),
      /software_manager_pending_recovery/,
    );
    assert.equal(prepareCalls, 0);
    assert.equal((await service.getSnapshot()).task.external, true);
  }
});

test("install-root choice stays transactional when a durable claim appears during candidate inspection", async () => {
  const oldToken = "root_token_old_0001";
  const candidateToken = "root_token_new_0002";
  const state = { activeTask: null, components: {}, skills: {}, rollback: null };
  const prepareTokens = [];
  const events = [];
  const adaptersFor = (token) => ({
    chatgpt: adapterFixture("chatgpt", {
      inspect: async () => {
        if (token === candidateToken) {
          state.activeTask = { kind: "component-prepare", taskId: "claim-during-inspect", componentId: "chatgpt", version: "2.0.0" };
        }
        const version = token === candidateToken ? "9.0.0" : "1.0.0";
        return operationResult("chatgpt", "inspect", "succeeded", { versionBefore: version, versionAfter: version });
      },
      prepare: async () => { prepareTokens.push(token); return operationResult("chatgpt", "prepare"); },
    }),
    v2rayn: adapterFixture("v2rayn"),
    git: adapterFixture("git"),
    skills: skillsAdapterFixture(),
  });
  const { service } = fixtureService({
    state,
    adapterFactory: async ({ installRootCapability }) => adaptersFor(installRootCapability.token),
    installRootResolver: {
      choose: async () => ({ token: candidateToken }),
      resolve: async (token) => ({ token }),
      getCurrentToken: () => oldToken,
      adopt: async () => {},
      discard: async () => {},
    },
    recoverTransactions: async () => {},
  });
  assert.equal((await service.getSnapshot()).components.find(({ id }) => id === "chatgpt").installedVersion, "1.0.0");
  service.subscribe((event) => { if (event.type === "snapshot") events.push(event); });
  await assert.rejects(service.chooseInstallRoot("C:\\Candidate"), /software_manager_pending_recovery/);
  assert.equal(events.length, 0);
  const pending = await service.getSnapshot();
  assert.equal(pending.pendingRecovery, true);
  assert.equal(pending.components.find(({ id }) => id === "chatgpt").installedVersion, "1.0.0");

  state.activeTask = null;
  await service.recoverPending();
  await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  assert.deepEqual(prepareTokens, [oldToken]);
});

test("recovery cannot re-enter while a service task owns the unified entry gate", async () => {
  const entered = deferred();
  const release = deferred();
  const { service } = fixtureService({
    chatgpt: { commit: async () => { entered.resolve(); await release.promise; return operationResult("chatgpt", "commit"); } },
  });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  await entered.promise;
  await assert.rejects(service.recoverPending(), /software_manager_task_running/);
  release.resolve();
  await running;
});

test("malformed or mismatched component results cannot impersonate success", async () => {
  const malformed = [
    { componentId: "chatgpt", action: "prepare", status: "succeeded", versionBefore: null, versionAfter: "2.0.0", message: "ok", rollbackAvailable: false, extra: true },
    { componentId: "v2rayn", action: "prepare", status: "succeeded", versionBefore: null, versionAfter: "2.0.0", message: "ok", rollbackAvailable: false },
    Object.assign(Object.create({ inherited: true }), operationResult("chatgpt", "prepare")),
  ];
  for (const value of malformed) {
    const { service } = fixtureService({ chatgpt: { prepare: async () => value } });
    const result = await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
    assert.equal(result.status, "failed");
    assert.equal(result.components[0].status, "failed");
  }
});

test("adapter versions and action-specific null semantics are strict", async () => {
  const malformed = [
    operationResult("chatgpt", "prepare", "succeeded", { versionAfter: "not-a-version" }),
    operationResult("chatgpt", "prepare", "succeeded", { versionAfter: null }),
    operationResult("chatgpt", "prepare", "failed", { versionBefore: "1.2.beta" }),
  ];
  for (const value of malformed) {
    const { service } = fixtureService({ chatgpt: { prepare: async () => value } });
    const result = await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
    assert.equal(result.components[0].status, "failed");
    assert.match(result.components[0].message, /adapter_result_invalid/);
  }
  const { service } = fixtureService({
    chatgpt: { uninstall: async () => operationResult("chatgpt", "uninstall", "succeeded", { versionAfter: "2.0.0" }) },
  });
  const uninstall = await service.startTask({ kind: "uninstall", componentIds: ["chatgpt"], skillIds: [] });
  assert.equal(uninstall.components[0].status, "failed");
  assert.match(uninstall.components[0].message, /adapter_result_invalid/);
});

test("Skill adapter output rejects duplicate, missing, unknown, or extra IDs as one malformed batch", async () => {
  const catalogService = catalogFixture({ skills: [skillEntry("documents"), skillEntry("spreadsheets")] });
  const badOutputs = [
    [operationResult("documents", "prepare")],
    [operationResult("documents", "prepare"), operationResult("documents", "prepare")],
    [operationResult("documents", "prepare"), operationResult("unknown", "prepare")],
    [operationResult("documents", "prepare"), operationResult("spreadsheets", "prepare"), operationResult("extra", "prepare")],
  ];
  for (const output of badOutputs) {
    const { service } = fixtureService({ catalogService, skills: { prepare: async () => output } });
    const result = await service.startTask({ kind: "install", componentIds: [], skillIds: ["documents", "spreadsheets"] });
    assert.equal(result.status, "failed");
    assert.deepEqual(result.skills.map(({ status }) => status), ["failed", "failed"]);
  }
});

test("overall status needs a real success; skipped plus failed is failed", async () => {
  const { service } = fixtureService({
    chatgpt: { prepare: async () => operationResult("chatgpt", "prepare", "failed") },
    v2rayn: { prepare: async () => operationResult("v2rayn", "prepare", "skipped") },
  });
  const result = await service.startTask({ kind: "install", componentIds: ["chatgpt", "v2rayn"], skillIds: [] });
  assert.equal(result.status, "failed");
});

test("overall status treats all-skipped and success-plus-skipped as succeeded", async () => {
  const { service: allSkipped } = fixtureService({
    chatgpt: { prepare: async () => operationResult("chatgpt", "prepare", "skipped") },
    v2rayn: { prepare: async () => operationResult("v2rayn", "prepare", "skipped") },
  });
  assert.equal((await allSkipped.startTask({
    kind: "install", componentIds: ["chatgpt", "v2rayn"], skillIds: [],
  })).status, "succeeded");

  const { service: mixed } = fixtureService({
    v2rayn: { prepare: async () => operationResult("v2rayn", "prepare", "skipped") },
  });
  assert.equal((await mixed.startTask({
    kind: "install", componentIds: ["chatgpt", "v2rayn"], skillIds: [],
  })).status, "succeeded");
});

test("Skill results remain per-item and one failure does not erase another success", async () => {
  const catalogService = catalogFixture({ skills: [skillEntry("documents"), skillEntry("spreadsheets")] });
  const { service } = fixtureService({
    catalogService,
    skills: {
      prepare: async ({ skillIds }) => skillIds.map((id) => operationResult(
        id,
        "prepare",
        id === "documents" ? "failed" : "succeeded",
        id === "documents" ? { message: "software_manager_adapter_result_invalid" } : {},
      )),
    },
  });
  const result = await service.startTask({ kind: "install", componentIds: [], skillIds: ["documents", "spreadsheets"] });
  assert.deepEqual(result.skills.map(({ status }) => status), ["failed", "succeeded"]);
  assert.equal(result.status, "partial");
});

test("UI logs keep only the latest 500 lines", async () => {
  const { service } = fixtureService({
    chatgpt: {
      prepare: async ({ onProgress }) => {
        for (let index = 0; index < 510; index += 1) onProgress({ phase: "download", percent: index % 100, message: `line-${index}` });
        return operationResult("chatgpt", "prepare");
      },
    },
  });
  await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  const logs = (await service.getSnapshot()).logs;
  assert.equal(logs.length, 500);
  assert.equal(logs.some(({ message }) => message === "line-0"), false);
  assert.equal(logs.some(({ message }) => message === "line-509"), true);
});

test("events and disk logs redact case variants, encoded credentials, query strings, and nested Error causes", async () => {
  const disk = [];
  const events = [];
  const nested = new Error("Bearer TOPSECRET https://user:pass@example.test/sub?token=abc");
  nested.cause = new Error("API_KEY%3Dencoded-secret registrationCode=2aEq");
  nested.downloadToken = "download-secret";
  const { service } = fixtureService({
    logSink: { write: async (entry) => { disk.push(entry); } },
    chatgpt: {
      prepare: async ({ onProgress }) => {
        onProgress({
          phase: "download", percent: 5,
          message: "bEaReR abc123 subscription=https%3A%2F%2Fx.test%2Fsub%3Fcredential%3Dvalue",
          error: nested,
          pathToken: "opaque-secret",
        });
        return operationResult("chatgpt", "prepare", "failed", { message: nested.message });
      },
    },
  });
  service.subscribe((event) => events.push(event));
  await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  await new Promise((resolve) => setImmediate(resolve));
  const text = JSON.stringify({ events, disk, snapshot: await service.getSnapshot() });
  for (const secret of ["TOPSECRET", "abc123", "user:pass", "abc", "encoded-secret", "2aEq", "value", "download-secret", "opaque-secret"]) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.match(text, /REDACTED/);
  assert.equal(text.includes("component-catalog.json.sig"), false);
});

test("bounded asynchronous disk sink failure never fails a task", async () => {
  const held = deferred();
  const started = deferred();
  let writes = 0;
  let active = 0;
  let maxActive = 0;
  const { service } = fixtureService({
    maxPendingLogWrites: 2,
    logSink: { write: async () => {
      writes += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try { if (writes === 1) { started.resolve(); await held.promise; } throw new Error("disk unavailable"); }
      finally { active -= 1; }
    } },
    chatgpt: {
      prepare: async ({ onProgress }) => {
        for (let index = 0; index < 20; index += 1) onProgress({ phase: "download", percent: index, message: `safe-${index}` });
        return operationResult("chatgpt", "prepare");
      },
    },
  });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  await started.promise;
  held.resolve();
  const result = await running;
  assert.equal(result.status, "succeeded");
  assert.equal(maxActive <= 2, true);
  await new Promise((resolve) => setImmediate(resolve));
});

test("a hung log sink times out, degrades once, and cannot hold task completion", async () => {
  let writes = 0;
  const { service } = fixtureService({
    logWriteTimeoutMs: 20,
    logSink: { write: async () => { writes += 1; await new Promise(() => {}); } },
  });
  const outcome = await Promise.race([
    service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] }),
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 500)),
  ]);
  assert.notEqual(outcome, "timed-out");
  assert.equal(outcome.status, "succeeded");
  const snapshot = await service.getSnapshot();
  assert.deepEqual({ ...snapshot.logging }, {
    degraded: true,
    pendingWrites: 0,
    error: "software_manager_log_sink_degraded",
    recovery: "restart-service",
  });
  assert.equal(writes, 1);
  assert.equal(snapshot.logs.filter(({ message }) => message === "software_manager_log_sink_degraded").length, 1);
});

test("coalesced progress shares one completion promise and keeps only the latest of 100k updates", async () => {
  const sinkEntered = deferred();
  const sinkRelease = deferred();
  const burstReady = deferred();
  const disk = [];
  let sharedPromise = null;
  let allShared = true;
  const { service } = fixtureService({
    maxPendingLogWrites: 2,
    logWriteTimeoutMs: 5_000,
    logSink: {
      async write(entry) {
        disk.push(entry);
        if (disk.length === 1) { sinkEntered.resolve(); await sinkRelease.promise; }
      },
    },
    chatgpt: {
      prepare: async ({ onProgress }) => {
        await sinkEntered.promise;
        for (let index = 0; index < 100_000; index += 1) {
          const completion = onProgress({ phase: "download", percent: index % 100, message: `burst-${index}` });
          if (index === 0) sharedPromise = completion;
          else if (completion !== sharedPromise) allShared = false;
        }
        burstReady.resolve();
        return operationResult("chatgpt", "prepare", "failed");
      },
    },
  });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  await burstReady.promise;
  assert.equal(allShared, true);
  assert.equal((await service.getSnapshot()).logging.pendingWrites, 2);
  sinkRelease.resolve();
  await running;
  assert.equal(disk.some(({ message }) => message === "burst-99999"), true);
  assert.equal(disk.some(({ message }) => message === "burst-0"), false);
});

test("non-awaited progress uses a truly bounded log queue and cancellation remains bounded", async () => {
  const entered = deferred();
  const release = deferred();
  const { service } = fixtureService({
    maxPendingLogWrites: 4,
    logWriteTimeoutMs: 20,
    logSink: { write: async () => new Promise(() => {}) },
    chatgpt: {
      prepare: async ({ signal, onProgress }) => {
        for (let index = 0; index < 1_000; index += 1) {
          onProgress({ phase: "download", percent: index % 100, message: `burst-${index}` });
        }
        entered.resolve(signal);
        await release.promise;
        return operationResult("chatgpt", "prepare", "failed");
      },
    },
  });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  await entered.promise;
  const during = await service.getSnapshot();
  assert.equal(during.logging.pendingWrites <= 4, true);
  assert.deepEqual(service.cancelTask(), { cancelled: true });
  assert.deepEqual(service.prepareForQuit(), { allowQuit: false, reason: "cancelling", canCancel: false });
  release.resolve();
  const outcome = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve("timed-out"), 500))]);
  assert.notEqual(outcome, "timed-out");
  assert.equal(outcome.status, "cancelled");
});

test("disk log writes are lossless and ordered and task completion drains the queue", async () => {
  const gate = deferred();
  const started = deferred();
  const disk = [];
  let first = true;
  const { service } = fixtureService({
    maxPendingLogWrites: 4,
    logSink: { write: async (entry) => {
      if (first) { first = false; started.resolve(); await gate.promise; }
      disk.push(entry);
    } },
    chatgpt: {
      prepare: async ({ onProgress }) => {
        for (let index = 0; index < 12; index += 1) await onProgress({ phase: "download", percent: index, message: `ordered-${index}` });
        return operationResult("chatgpt", "prepare");
      },
    },
  });
  let finished = false;
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] }).then((value) => { finished = true; return value; });
  await started.promise;
  await Promise.resolve();
  assert.equal(finished, false);
  gate.resolve();
  assert.equal((await running).status, "succeeded");
  const messages = disk.map(({ message }) => message);
  assert.deepEqual(messages.filter((value) => /^ordered-/u.test(value)), Array.from({ length: 12 }, (_, index) => `ordered-${index}`));
  assert.match(messages.at(-1), /task_succeeded/);
});

test("disk sink failure is contained and exposed as a redacted degraded snapshot", async () => {
  const { service } = fixtureService({
    logSink: { write: async () => { throw new Error("C:\\secret\\token.txt api_key='NEVER'"); } },
  });
  const result = await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  assert.equal(result.status, "succeeded");
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.logging.degraded, true);
  const text = JSON.stringify(snapshot);
  assert.equal(text.includes("NEVER"), false);
  assert.equal(text.includes("C:\\secret"), false);
});

test("redaction preserves normal text while bounding deep hostile structures with null-prototype output", async () => {
  const events = [];
  const hostile = Object.create(null);
  hostile.__proto__ = "ghp_123456789012345678901234567890123456";
  hostile.constructor = "sk-123456789012345678901234567890";
  hostile.prototype = "Basic dXNlcjpwYXNz";
  hostile.normal = "ordinary update message";
  let cursor = hostile;
  for (let index = 0; index < 20; index += 1) { cursor.child = Object.create(null); cursor = cursor.child; }
  const { service } = fixtureService({
    chatgpt: {
      prepare: async ({ onProgress }) => {
        await onProgress({
          phase: "download",
          percent: 1,
          message: [
            "ordinary update message",
            "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
            "sk-svcacct-abcdefghijklmnopqrstuvwxyz012345",
            "sk-ant-abcdefghijklmnopqrstuvwxyz012345",
            "xai-abcdefghijklmnopqrstuvwxyz012345",
            "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
            "hf_abcdefghijklmnopqrstuvwxyz012345",
            "https://private.example/path?q=secret",
            "file:///C:/private/token.txt",
            "\\\\server\\share\\private.txt",
            "vless://secret@example.com:443/path",
            "vmess://opaque-secret",
            "trojan://secret@example.com",
            "ss://opaque-secret",
            "ssr://opaque-secret",
            "ws://private.example/socket",
            "wss://private.example/socket",
            "socks5://private.example:1080",
            "x://single-letter-secret",
            "ordinary x:text label",
          ].join(" "),
          hostile,
          api_key: "'QUOTED'",
        });
        return operationResult("chatgpt", "prepare");
      },
    },
  });
  service.subscribe((event) => events.push(event));
  await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = await service.getSnapshot();
  const text = JSON.stringify({ events, snapshot });
  assert.match(text, /ordinary update message/);
  for (const secret of [
    "ghp_123456789012345678901234567890123456",
    "sk-123456789012345678901234567890",
    "dXNlcjpwYXNz",
    "QUOTED",
    "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
    "sk-svcacct-abcdefghijklmnopqrstuvwxyz012345",
    "sk-ant-abcdefghijklmnopqrstuvwxyz012345",
    "xai-abcdefghijklmnopqrstuvwxyz012345",
    "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "hf_abcdefghijklmnopqrstuvwxyz012345",
    "private.example",
    "file:///C:/private",
    "server\\share\\private",
    "vless://",
    "vmess://",
    "trojan://",
    "ss://",
    "ssr://",
    "ws://",
    "wss://",
    "socks5://",
    "x://",
  ]) assert.equal(text.includes(secret), false);
  assert.equal(text.includes("ordinary x:text label"), true);
  assert.equal(text.length < 200_000, true);
  assert.equal(Object.getPrototypeOf(events[0]), null);
  assert.equal(Object.isFrozen(events[0]), true);
});

test("subscriber exceptions are isolated and unsubscribe is idempotent", async () => {
  let received = 0;
  const { service } = fixtureService();
  service.subscribe(() => { throw new Error("listener failed"); });
  const unsubscribe = service.subscribe(() => { received += 1; });
  await service.refresh();
  assert.equal(received > 0, true);
  unsubscribe(); unsubscribe();
  const before = received;
  await service.refresh();
  assert.equal(received, before);
});

test("async subscribers are ordered per listener, do not block the service, and rejected promises are contained", async () => {
  const gate = deferred();
  const observed = [];
  const { service } = fixtureService();
  service.subscribe(async (event) => {
    if (event.type !== "snapshot") return;
    observed.push("start");
    await gate.promise;
    observed.push("end");
  });
  service.subscribe(async () => { throw new Error("async listener failure"); });
  const first = await service.refresh();
  assert.equal(first.enabled, true);
  assert.deepEqual(observed, ["start"]);
  const secondPromise = service.refresh();
  await Promise.resolve();
  assert.deepEqual(observed, ["start"]);
  gate.resolve();
  await secondPromise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, ["start", "end", "start", "end"]);
});

test("slow listeners have bounded coalescing queues without losing the latest progress or finished", async () => {
  const gate = deferred();
  const observed = [];
  let held = false;
  const { service } = fixtureService({
    maxListenerQueue: 8,
    chatgpt: {
      prepare: async ({ onProgress }) => {
        for (let index = 0; index < 1_000; index += 1) {
          onProgress({ phase: "download", percent: index % 100, message: `listener-${index}` });
        }
        return operationResult("chatgpt", "prepare");
      },
    },
  });
  service.subscribe(async (event) => {
    observed.push(event);
    if (!held && event.type === "progress") { held = true; await gate.promise; }
  });
  const result = await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  assert.equal(result.status, "succeeded");
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed.length <= 12, true);
  assert.equal(observed.some(({ type, message }) => type === "progress" && message === "listener-999"), true);
  assert.equal(observed.some(({ type }) => type === "finished"), true);
});

test("a listener-triggered operation does not feed back to its causal listeners but still reaches peers", async () => {
  const nestedDone = deferred();
  const { service } = fixtureService();
  let firstCount = 0;
  let secondCount = 0;
  let triggered = false;
  service.subscribe(async (event) => {
    if (event.type !== "snapshot") return;
    firstCount += 1;
    if (!triggered) {
      triggered = true;
      await service.refresh();
      nestedDone.resolve();
    }
  });
  service.subscribe((event) => { if (event.type === "snapshot") secondCount += 1; });
  await service.refresh();
  await nestedDone.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstCount, 1);
  assert.equal(secondCount, 2);
});

test("same-key listener coalescing uses only the latest event causes", async () => {
  const bBlocked = deferred();
  const releaseB = deferred();
  const aNestedDone = deferred();
  const bFeedbackDone = deferred();
  const { service } = fixtureService();
  let aCount = 0;
  let bCount = 0;
  service.subscribe(async (event) => {
    if (event.type !== "snapshot") return;
    aCount += 1;
    if (aCount === 1) {
      await bBlocked.promise;
      await service.refresh();
      aNestedDone.resolve();
    }
  });
  service.subscribe(async (event) => {
    if (event.type !== "snapshot") return;
    bCount += 1;
    if (bCount === 1) {
      bBlocked.resolve();
      await releaseB.promise;
    } else if (bCount === 2) {
      await service.refresh();
      bFeedbackDone.resolve();
    }
  });

  await service.refresh();
  await aNestedDone.promise;
  await service.refresh();
  releaseB.resolve();
  await Promise.race([
    bFeedbackDone.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("listener cause replacement timeout")), 500)),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bCount, 2);
  assert.equal(aCount, 3);
});

test("causal ancestry stops two listeners from recursively refreshing each other", async () => {
  const settled = deferred();
  const { service } = fixtureService();
  const counts = [0, 0];
  let triggered = 0;
  const listener = (index) => async (event) => {
    if (event.type !== "snapshot") return;
    counts[index] += 1;
    if (triggered < 12) {
      triggered += 1;
      await service.refresh();
    }
    if (counts[0] >= 2 && counts[1] >= 2) settled.resolve();
  };
  service.subscribe(listener(0));
  service.subscribe(listener(1));
  await service.refresh();
  await Promise.race([
    settled.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("listener causal loop timeout")), 500)),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(counts, [2, 2]);
  assert.equal(triggered, 4);
});

test("a detached listener callback outlives its causal lease and receives later feedback normally", async () => {
  const receivedTwice = deferred();
  const { service } = fixtureService();
  let received = 0;
  let scheduled = false;
  service.subscribe((event) => {
    if (event.type !== "snapshot") return;
    received += 1;
    if (received === 2) receivedTwice.resolve();
    if (!scheduled) {
      scheduled = true;
      setImmediate(() => { void service.refresh(); });
    }
  });
  await service.refresh();
  await Promise.race([
    receivedTwice.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("detached listener feedback timeout")), 500)),
  ]);
  assert.equal(received, 2);
});

test("repeated subscription of the same function has independent unsubscribe identity", async () => {
  let received = 0;
  const listener = () => { received += 1; };
  const { service } = fixtureService();
  const first = service.subscribe(listener);
  const second = service.subscribe(listener);
  await service.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received, 2);
  first();
  await service.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received, 3);
  second();
});

test("subscription count is bounded and unsubscribe releases capacity", () => {
  const { service } = fixtureService();
  const unsubscribers = Array.from({ length: 32 }, () => service.subscribe(() => {}));
  assert.throws(() => service.subscribe(() => {}), /software_manager_listener_limit/);
  unsubscribers[0]();
  assert.equal(typeof service.subscribe(() => {}), "function");
});

test("duplicate injected task IDs are replaced with unique process-safe IDs", async () => {
  const { service } = fixtureService({ taskIdFactory: () => "duplicate-task" });
  const first = await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  const second = await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  assert.notEqual(first.taskId, second.taskId);
  assert.match(second.taskId, /^software-/u);
});

test("thousands of repeated injected task IDs remain unique without an unbounded history contract", async () => {
  const { service } = fixtureService({ taskIdFactory: () => "same-task" });
  const ids = new Set();
  for (let index = 0; index < 1_000; index += 1) {
    const result = await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
    ids.add(result.taskId);
  }
  assert.equal(ids.size, 1_000);
});

test("finished event uses deterministic fake-clock timestamps and a unified result", async () => {
  const events = [];
  const values = [1000, 2000, 3000, 4000, 5000];
  const { service } = fixtureService({ clock: { now: () => values.shift() ?? 6000 } });
  service.subscribe((event) => events.push(event));
  const result = await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  assert.equal(result.taskId, "task-1");
  assert.equal(result.kind, "install");
  assert.equal(Array.isArray(result.components), true);
  assert.equal(Array.isArray(result.skills), true);
  const finished = events.find(({ type }) => type === "finished");
  assert.deepEqual(finished.result, result);
  assert.equal(Number.isSafeInteger(result.startedAt), true);
  assert.equal(Number.isSafeInteger(result.finishedAt), true);
});
