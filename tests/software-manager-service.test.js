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
    versionAfter: status === "succeeded" ? "2.0.0" : null,
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
    },
    adapterFactory: options.adapterFactory,
    logSink: options.logSink,
    clock: options.clock ?? { now: () => 1_700_000_000_000 + tick++ },
    taskIdFactory: options.taskIdFactory ?? (() => "task-1"),
    maxPendingLogWrites: options.maxPendingLogWrites,
  });
  return { service, calls, state, adapters };
}

test("module exposes the complete service interface", () => {
  const { service } = fixtureService();
  for (const method of [
    "getSnapshot", "chooseInstallRoot", "refresh", "startTask", "cancelTask",
    "recoverPending", "hasCriticalTask", "prepareForQuit", "subscribe",
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
  const { service } = fixtureService({
    installRootResolver: {
      choose: async (candidate) => { seen.push(candidate); return { token: "opaque_root_123456", capability: { proof: 7 } }; },
      resolve: async (token) => { seen.push(token); return { proof: 7 }; },
      getCurrentToken: () => "opaque_root_123456",
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
  assert.equal(seen[0], "C:\\Chosen");
  assert.equal(seen.slice(1).every((value) => value === "opaque_root_123456"), true);
  assert.equal(JSON.stringify(result).includes("C:\\Chosen"), false);
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

test("an immediate cancel and quit check see a reserved start before asynchronous recovery completes", async () => {
  const recovery = deferred();
  const { service } = fixtureService({ recoverTransactions: () => recovery.promise });
  const running = service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  assert.deepEqual(service.prepareForQuit(), { allowQuit: false, reason: "running", canCancel: true });
  assert.deepEqual(service.cancelTask(), { cancelled: true });
  recovery.resolve([]);
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.components.length, 0);
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
  assert.deepEqual(order.slice(0, 2), ["recover", "inspect"]);
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
  assert.equal(progressEvents.at(-1).cancellable, false);
  assert.equal(service.hasCriticalTask(), false);
  finish.resolve();
  await running;
  assert.deepEqual(service.cancelTask(), { cancelled: false, reason: "idle" });
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

test("critical state is reset even when an adapter throws", async () => {
  const { service } = fixtureService({ chatgpt: { commit: async () => { throw new Error("boom"); } } });
  const result = await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  assert.equal(result.status, "failed");
  assert.equal(service.hasCriticalTask(), false);
  assert.deepEqual(service.prepareForQuit(), { allowQuit: true });
});

test("Skill results remain per-item and one failure does not erase another success", async () => {
  const catalogService = catalogFixture({ skills: [skillEntry("documents"), skillEntry("spreadsheets")] });
  const { service } = fixtureService({
    catalogService,
    skills: {
      prepare: async ({ skillIds }) => skillIds.map((id) => operationResult(id, "prepare", id === "documents" ? "failed" : "succeeded")),
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
  let writes = 0;
  let active = 0;
  let maxActive = 0;
  const { service } = fixtureService({
    maxPendingLogWrites: 2,
    logSink: { write: async () => {
      writes += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try { if (writes === 1) await held.promise; throw new Error("disk unavailable"); }
      finally { active -= 1; }
    } },
    chatgpt: {
      prepare: async ({ onProgress }) => {
        for (let index = 0; index < 20; index += 1) onProgress({ phase: "download", percent: index, message: `safe-${index}` });
        return operationResult("chatgpt", "prepare");
      },
    },
  });
  const result = await service.startTask({ kind: "install", componentIds: ["chatgpt"], skillIds: [] });
  assert.equal(result.status, "succeeded");
  assert.equal(maxActive <= 2, true);
  held.resolve();
  await new Promise((resolve) => setImmediate(resolve));
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
