import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createOwnershipStore } from "../desktop/software-manager/state-store.mjs";

function state(installRoot = "C:\\Tools\\CodexBridge") {
  return {
    schemaVersion: 1,
    installRoot,
    components: {},
    skills: {},
    shortcuts: [],
    rollback: null,
    activeTask: null,
    lastTask: null,
  };
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

test("save flushes ownership.json.tmp and atomically renames it", async () => {
  const memory = createMemoryStateFs();
  const calls = memory.calls;
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });
  const next = state();

  await store.save(next);

  assert.deepEqual(await store.load(), next);
  assert.ok(calls.find(([operation]) => operation === "sync"));
  assert.ok(calls.find((call) => call[0] === "rename-entry-no-follow"
    && call[1] === "ownership.json.tmp" && call[2] === "ownership.json"));
});

test("a validated previous state is retained as ownership.json.bak", async () => {
  const memory = createMemoryStateFs();
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });
  const previous = state("C:\\Previous");
  const next = state("C:\\Next");
  await store.save(previous);
  await store.save(next);

  assert.deepEqual(JSON.parse(memory.get("ownership.json.bak")), previous);
  assert.deepEqual(await store.load(), next);
});

test("load falls back to a validated backup after interrupted atomic rename", async () => {
  const memory = createMemoryStateFs();
  const previous = state("C:\\Previous");
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });
  await store.save(previous);
  memory.setFailFinalRename(true);
  await assert.rejects(store.save(state("C:\\Next")), /interrupted/);

  assert.deepEqual(await store.load(), previous);
});

test("state files that are links or reparse points are never followed", async () => {
  const fsApi = {
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
    fsApi: { async openStateDirectoryNoFollow() { touched = true; } },
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

test("malformed persisted nested state safely degrades without mutation", async () => {
  const malformed = { ...state(), components: { app: "C:\\Windows" } };
  const memory = createMemoryStateFs({ "ownership.json": JSON.stringify(malformed) });
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });
  assert.deepEqual(await store.load(), state(null));
  assert.equal(memory.calls.some(([operation]) => ["write", "unlink-entry-no-follow", "rename-entry-no-follow"].includes(operation)), false);
});

test("retains JSON metadata while only fixed path fields define ownership records", async () => {
  const next = {
    ...state(),
    components: { app: { installPath: "C:\\Owned\\app", version: "C:\\Windows" } },
    skills: { documents: { sha256: "C:\\Windows", target: "C:\\Owned\\skills\\documents" } },
    shortcuts: [{ message: "C:\\Windows", path: "C:\\Owned\\shortcut.lnk" }],
    rollback: [{ path: "C:\\Owned\\rollback", reason: "update" }],
    activeTask: { message: "C:\\Windows", progress: 50 },
  };
  const memory = createMemoryStateFs();
  const store = createOwnershipStore({ stateDir: path.resolve("state"), fsApi: memory.fsApi });
  await store.save(next);
  assert.deepEqual(await store.load(), next);
});
