import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Writable } from "node:stream";
import test from "node:test";

import { authorizeInstallRoot } from "../desktop/software-manager/path-policy.mjs";
import { createTransactionJournal, recoverTransactions } from "../desktop/software-manager/transaction-journal.mjs";
import { createVersionSlotManager, planPeakBytes } from "../desktop/software-manager/version-slots.mjs";

const INSTALL_ROOT_CAPABILITY = await authorizeInstallRoot({
  candidate: "D:\\CodexBridge",
  maxRelativePath: 200,
  access: async () => {},
  realpath: async (value) => value,
  lstat: async () => ({
    dev: 1, ino: 1,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    isReparsePoint: () => false,
  }),
});

function clone(value) {
  return structuredClone(value);
}

function semanticState(value) {
  const copy = clone(value);
  delete copy.generation;
  return copy;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function payloadIntegrity(value) {
  const tree = [{
    path: "payload.bin",
    size: Buffer.byteLength(value),
    directory: false,
    sha256: crypto.createHash("sha256").update(value, "utf8").digest("hex"),
  }];
  return {
    treeDigest: digest(tree),
    manifestDigest: digest(tree.map(({ path: entryPath, size, directory }) => ({
      path: entryPath, size, directory,
    }))),
  };
}

function emptyState() {
  return {
    schemaVersion: 1,
    generation: 0,
    installRoot: "D:\\CodexBridge",
    components: {},
    skills: {},
    shortcuts: [],
    rollback: null,
    activeTask: null,
    lastTask: null,
  };
}

function createSharedOwnershipBacking(initialState) {
  let persisted = clone(initialState);
  return {
    createStore() {
      return {
        async load() { return clone(persisted); },
        async compareAndSwap(expectedGeneration, next) {
          if (persisted.generation !== expectedGeneration) throw new Error("ownership_generation_conflict");
          persisted = { ...clone(next), generation: expectedGeneration + 1 };
          return clone(persisted);
        },
      };
    },
    state() { return clone(persisted); },
  };
}

function createFixture({ componentId = "chatgpt", slots = {}, state = emptyState() } = {}) {
  const rootPath = componentId === "chatgpt"
    ? "D:\\CodexBridge"
    : `D:\\CodexBridge\\${componentId === "v2rayn" ? "V2RayN" : "Git"}`;
  const roots = new Map();
  const journals = new Map();
  const calls = [];
  let identitySeed = 0;
  let failRule = null;
  let verificationReceipts = new WeakMap();

  function treeFor(node) {
    return [...node.files.entries()]
      .filter(([name]) => name !== ".codexbridge-version.json")
      .map(([name, value]) => ({
        path: name,
        size: Buffer.byteLength(String(value)),
        directory: false,
        sha256: crypto.createHash("sha256").update(String(value), "utf8").digest("hex"),
      }))
      .sort((left, right) => left.path.localeCompare(right.path, "en"));
  }

  function integrityFor(node) {
    const tree = treeFor(node);
    return {
      treeDigest: digest(tree),
      manifestDigest: digest(tree.map(({ path: entryPath, size, directory }) => ({
        path: entryPath, size, directory,
      }))),
    };
  }

  function markerFor(node, version) {
    return JSON.stringify({
      schemaVersion: 2,
      componentId,
      version,
      ...integrityFor(node),
    });
  }

  const rootSlots = new Map();
  for (const [name, version] of Object.entries(slots)) {
    const node = {
      identity: { volumeSerial: "vol", fileId: `${version}-${++identitySeed}` },
      files: new Map([["payload.bin", version === null ? "prepared-payload" : `payload-${version}`]]),
    };
    if (version !== null) node.files.set(".codexbridge-version.json", markerFor(node, version));
    rootSlots.set(name, node);
  }
  roots.set(rootPath.toLowerCase(), rootSlots);

  function maybeFail(kind, details, { after = false } = {}) {
    if (!failRule || failRule.kind !== kind || failRule.after !== after) return;
    if (failRule.match && !failRule.match(details)) return;
    const error = failRule.error;
    failRule = null;
    throw error;
  }

  function openVersionRootNoFollow(exactRoot, { expectedRootIdentity = null } = {}) {
    calls.push(["open-version-root", exactRoot, clone(expectedRootIdentity)]);
    assert.equal(exactRoot, rootPath);
    if (expectedRootIdentity !== null) {
      const componentRoot = rootSlots.get("V2RayN");
      if (!componentRoot) throw Object.assign(new Error("entry_missing"), { code: "entry_missing" });
      if (componentRoot.identity.volumeSerial !== expectedRootIdentity.volumeSerial
        || componentRoot.identity.fileId !== expectedRootIdentity.fileId) {
        throw new Error("windows_identity_changed");
      }
    }
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
      const marker = node.files.get(".codexbridge-version.json");
      let metadata = null;
      let markerStatus = "missing";
      if (marker !== undefined) {
        try {
          metadata = JSON.parse(marker);
          const integrity = integrityFor(node);
          markerStatus = metadata.schemaVersion === 2 && metadata.componentId === componentId
            && typeof metadata.version === "string"
            && metadata.treeDigest === integrity.treeDigest
            && metadata.manifestDigest === integrity.manifestDigest
            ? "complete"
            : "invalid";
          if (markerStatus === "invalid") metadata = null;
        } catch {
          markerStatus = "invalid";
        }
      }
      return {
        descriptor,
        markerStatus,
        evidence: metadata && { ...clone(metadata), identity: clone(node.identity) },
      };
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
      async sealPreparedSlotNoFollow(descriptor, metadata, verificationReceipt) {
        const internal = descriptors.get(descriptor);
        assert.equal(internal?.type, "slot");
        maybeFail("seal", { name: internal.name, metadata });
        const receipt = verificationReceipts.get(verificationReceipt);
        if (!receipt) throw new Error("version_verification_receipt_invalid");
        if (receipt.state !== "fresh") throw new Error("version_verification_receipt_consumed");
        if (receipt.node !== internal.node
          || receipt.identity.volumeSerial !== internal.node.identity.volumeSerial
          || receipt.identity.fileId !== internal.node.identity.fileId) {
          throw new Error("version_verification_receipt_directory_mismatch");
        }
        if (receipt.componentId !== metadata.componentId || receipt.version !== metadata.version
          || receipt.treeDigest !== metadata.treeDigest
          || receipt.manifestDigest !== metadata.manifestDigest) {
          throw new Error("version_verification_receipt_mismatch");
        }
        const integrity = integrityFor(internal.node);
        if (integrity.treeDigest !== receipt.treeDigest
          || integrity.manifestDigest !== receipt.manifestDigest) {
          throw new Error("version_tree_digest_mismatch");
        }
        const existing = internal.node.files.get(".codexbridge-version.json");
        const marker = { ...clone(metadata), treeDigest: receipt.treeDigest };
        if (existing !== undefined) {
          assert.deepEqual(JSON.parse(existing), marker);
        } else {
          internal.node.files.set(".codexbridge-version.json", JSON.stringify(marker));
        }
        receipt.state = "consumed";
        calls.push(["seal", internal.name, metadata.version]);
        maybeFail("seal", { name: internal.name, metadata }, { after: true });
        return { ...clone(marker), identity: clone(internal.node.identity) };
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
          async writeFile(value) {
            maybeFail("journal-write", { name });
            file.data = String(value);
            calls.push(["journal-write", name]);
            maybeFail("journal-write", { name }, { after: true });
          },
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
    async compareAndSwap(expectedGeneration, next) {
      maybeFail("state", next);
      if (persisted.generation !== expectedGeneration) throw new Error("ownership_generation_conflict");
      persisted = { ...clone(next), generation: expectedGeneration + 1 };
      calls.push(["state-commit", next.components[componentId]?.version ?? null]);
      maybeFail("state", next, { after: true });
      return clone(persisted);
    },
  };
  const fsApi = {
    openVersionRootNoFollow: async (value, options) => openVersionRootNoFollow(value, options),
    openJournalDirectoryNoFollow: async (value) => openJournalDirectoryNoFollow(value),
    async openInstallerWorkspaceRootNoFollow() {
      const receipts = new WeakMap();
      const root = Object.freeze({});
      receipts.set(root, { kind: "root" });
      const files = new Map();
      const issue = (value) => {
        const receipt = Object.freeze({});
        receipts.set(receipt, value);
        return receipt;
      };
      return {
        root,
        async createOrOpenDirectoryChildNoFollow(parent, name, options) {
          const parentInfo = receipts.get(parent);
          assert.ok(parentInfo);
          if (name === "V2RayN") {
            assert.equal(parentInfo.kind, "root");
            return issue({ kind: "component-root" });
          }
          throw new Error(`unexpected_create_or_open:${name}:${options?.role}`);
        },
        async openDirectoryChildNoFollow(parent, name) {
          const parentInfo = receipts.get(parent);
          assert.ok(parentInfo);
          const node = rootSlots.get(name);
          return node ? issue({ kind: "staging", node, name }) : null;
        },
        async createDirectoryChildNoFollow(parent, name, options) {
          assert.ok(receipts.get(parent));
          assert.equal(options?.role, "deletable");
          if (rootSlots.has(name)) throw new Error("entry_exists");
          const node = {
            identity: { volumeSerial: "vol", fileId: `prepared-${++identitySeed}` },
            files: new Map(),
          };
          rootSlots.set(name, node);
          return issue({ kind: "staging", node, name });
        },
        async openFileChildNoFollow(parent, name) {
          const parentInfo = receipts.get(parent);
          const key = `${parentInfo?.kind}:${name}`;
          return files.has(key) ? issue({ kind: "file", key, data: files.get(key), sealed: false }) : null;
        },
        async createFileChildNoFollow(parent, name) {
          const parentInfo = receipts.get(parent);
          const key = `${parentInfo?.kind}:${name}`;
          if (files.has(key)) throw new Error("entry_exists");
          files.set(key, Buffer.alloc(0));
          return issue({ kind: "file", key, data: Buffer.alloc(0), sealed: false });
        },
        async createIssuedFileWriteStreamNoFollow(receipt) {
          const internal = receipts.get(receipt);
          return new Writable({
            write(chunk, _encoding, callback) {
              internal.data = Buffer.concat([internal.data, Buffer.from(chunk)]);
              files.set(internal.key, internal.data);
              callback();
            },
          });
        },
        async sealIssuedFileNoFollow(receipt, expected) {
          const internal = receipts.get(receipt);
          const data = files.get(internal.key);
          assert.equal(data.length, expected.size);
          assert.equal(crypto.createHash("sha256").update(data).digest("hex"), expected.sha256);
          internal.sealed = true;
          return receipt;
        },
        async describeIssuedDirectoryNoFollow(receipt) {
          const internal = receipts.get(receipt);
          maybeFail("workspace-describe", { kind: internal?.kind, name: internal?.name });
          return { path: `${rootPath}\\${internal.name}`, identity: clone(internal.node.identity), created: true };
        },
        async inspectIssuedChildNoFollow(receipt) {
          const internal = receipts.get(receipt);
          assert.equal(internal?.kind, "staging");
          maybeFail("workspace-inspect", { kind: internal.kind, name: internal.name });
          return { path: `${rootPath}\\${internal.name}`, kind: "directory", size: 0, empty: internal.node.files.size === 0 };
        },
        async deleteIssuedChildNoFollow(receipt) {
          const internal = receipts.get(receipt);
          if (internal.kind === "file") files.delete(internal.key);
          else rootSlots.delete(internal.name);
        },
        async close() {},
      };
    },
  };
  const journalDir = "D:\\CodexBridge\\State\\transactions";
  const journal = createTransactionJournal({ journalDir, fsApi });
  const manager = createVersionSlotManager({
    fsApi,
    ownershipStore,
    journal,
    installRootCapability: INSTALL_ROOT_CAPABILITY,
  });

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
      return Object.fromEntries(Object.entries(names).map(([key, name]) => {
        const node = rootSlots.get(name);
        const marker = node?.files.get(".codexbridge-version.json");
        if (marker === undefined) return [key, null];
        try {
          const parsed = JSON.parse(marker);
          const integrity = integrityFor(node);
          return [key, parsed.schemaVersion === 2
            && parsed.treeDigest === integrity.treeDigest
            && parsed.manifestDigest === integrity.manifestDigest
            ? parsed.version ?? null
            : null];
        } catch {
          return [key, null];
        }
      }));
    },
    state() { return clone(persisted); },
    replaceV2RootIdentity() {
      const componentRoot = rootSlots.get("V2RayN");
      if (!componentRoot) throw new Error("fixture_v2_root_missing");
      componentRoot.identity = { volumeSerial: "foreign", fileId: `replacement-${++identitySeed}` };
    },
    addForeignV2Root() {
      if (rootSlots.has("V2RayN")) throw new Error("fixture_v2_root_occupied");
      rootSlots.set("V2RayN", {
        identity: { volumeSerial: "foreign", fileId: `reappeared-${++identitySeed}` },
        files: new Map(),
      });
    },
    slotExists(name) { return rootSlots.has(name); },
    setState(next) { persisted = clone(next); },
    resetCalls() { calls.length = 0; },
    damageSlot(name, mode) {
      const node = rootSlots.get(name);
      assert.ok(node, `expected slot ${name}`);
      if (mode === "missing") {
        rootSlots.delete(name);
      } else if (mode === "corrupt") {
        node.files.set(".codexbridge-version.json", "{");
      } else {
        throw new Error(`unsupported damage mode ${mode}`);
      }
    },
    changeSlotContent(name, value) {
      const node = rootSlots.get(name);
      assert.ok(node, `expected slot ${name}`);
      node.files.set("payload.bin", value);
    },
    replaceSlotIdentity(name) {
      const node = rootSlots.get(name);
      assert.ok(node, `expected slot ${name}`);
      node.identity = { volumeSerial: "vol", fileId: `replacement-${++identitySeed}` };
    },
    rewriteSlotMarker(name, version) {
      const node = rootSlots.get(name);
      assert.ok(node, `expected slot ${name}`);
      node.files.set(".codexbridge-version.json", markerFor(node, version));
    },
    forgetVerificationReceipts() {
      verificationReceipts = new WeakMap();
    },
    issueVerificationReceipt(version, requestedComponentId = componentId, sourceName = null) {
      const stagingName = sourceName ?? (requestedComponentId === "chatgpt" ? "ct" : "staging");
      const node = rootSlots.get(stagingName);
      assert.ok(node, `expected staging slot ${stagingName}`);
      const integrity = integrityFor(node);
      const verificationReceipt = Object.freeze(Object.create(null));
      verificationReceipts.set(verificationReceipt, {
        state: "fresh",
        node,
        identity: clone(node.identity),
        componentId: requestedComponentId,
        version,
        ...integrity,
      });
      return { verificationReceipt, ...integrity };
    },
    slotIdentity(name) {
      const node = rootSlots.get(name);
      return node ? clone(node.identity) : null;
    },
  };
}

function installedState({ componentId = "chatgpt", current, previous = null, rootPath }) {
  const state = emptyState();
  const currentName = componentId === "chatgpt" ? "c" : "current";
  const previousName = componentId === "chatgpt" ? "cp" : "previous";
  state.components[componentId] = {
    installPath: `${rootPath}\\${currentName}`,
    version: current.version,
    treeDigest: current.treeDigest,
    manifestDigest: current.manifestDigest,
    slotIdentity: clone(current.identity),
    managed: true,
  };
  if (previous) {
    state.rollback = [{
      path: `${rootPath}\\${previousName}`,
      rootPath,
      componentId,
      version: previous.version,
      treeDigest: previous.treeDigest,
      manifestDigest: previous.manifestDigest,
      slotIdentity: clone(previous.identity),
    }];
  }
  return state;
}

function fixtureWithInstalled({ currentVersion, previousVersion = null, incomingVersion = null, componentId = "chatgpt" }) {
  const rootPath = componentId === "chatgpt"
    ? "D:\\CodexBridge"
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
  const installedEvidence = (version) => ({
    version,
    identity: identityFromVersion(version),
    ...payloadIntegrity(`payload-${version}`),
  });
  const state = installedState({
    componentId,
    rootPath,
    current: installedEvidence(currentVersion),
    previous: previousVersion ? installedEvidence(previousVersion) : null,
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

function promotionPlan(
  fixture, version, componentId = "chatgpt", taskId = `promote-${version.replaceAll(".", "-")}`,
  sourceName = null,
) {
  const verification = fixture.issueVerificationReceipt(version, componentId, sourceName);
  return {
    taskId,
    componentId,
    rootPath: fixture.rootPath,
    version,
    verificationReceipt: verification.verificationReceipt,
    treeDigest: verification.treeDigest,
    manifestDigest: verification.manifestDigest,
    prepareLeaseNonce: "e".repeat(32),
    runtimeMetadata: {
      entrypointPath: `${fixture.rootPath}\\${componentId === "chatgpt" ? "c\\ChatGPT.exe" : "current\\app.exe"}`,
      requiredFiles: [`${fixture.rootPath}\\${componentId === "chatgpt" ? "c\\ChatGPT.exe" : "current\\app.exe"}`],
      health: "pending-verify",
    },
  };
}

test("first install promotes only the verified staging slot and creates no rollback", async () => {
  const fixture = createFixture({ slots: { ct: null } });
  await fixture.manager.promotePreparedVersion(promotionPlan(fixture, "1.0.0"));
  assert.deepEqual(fixture.versions(), { current: "1.0.0", previous: null, staging: null, retiring: null });
  assert.equal(fixture.state().components.chatgpt.version, "1.0.0");
  assert.equal(fixture.state().rollback, null);
});

test("legacy schema-v2 transaction records without prepare metadata still recover", async () => {
  const fixture = createFixture({ slots: { ct: null } });
  fixture.fail("rename", new Error("legacy_record_crash"), {
    after: true, match: ({ from, to }) => from === "ct" && to === "c",
  });
  await assert.rejects(
    fixture.manager.promotePreparedVersion(promotionPlan(fixture, "1.0.0")),
    /legacy_record_crash/u,
  );
  const directory = await fixture.fsApi.openJournalDirectoryNoFollow(fixture.journalDir);
  for (const name of await directory.listFileNamesNoFollow()) {
    const file = await directory.openFileNoFollow(name, "r");
    const record = JSON.parse(await file.readFile("utf8"));
    delete record.priorPrepare;
    delete record.prepareSource;
    await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await file.close();
  }
  await directory.close();
  const [pending] = await fixture.journal.listTransactions();
  assert.ok(pending.records.every((record) => record.priorPrepare === null
    && record.prepareSource === null));
  assert.equal((await recoverTransactions({ journal: fixture.journal, slots: fixture.manager })).length, 1);
  assert.deepEqual(fixture.versions(), {
    current: "1.0.0", previous: null, staging: null, retiring: null,
  });
});

test("archive prepare WAL moves only its bound task source into the fixed staging slot", async () => {
  const stagingName = `.codexbridge-prepare-${"c".repeat(32)}`;
  const taskId = "archive-source-promote";
  const fixture = createFixture({ slots: { [stagingName]: null } });
  const claimed = fixture.state();
  claimed.activeTask = {
    kind: "component-prepare", taskId, componentId: "chatgpt", version: "1.0.0",
    stagingName, stagingIdentity: fixture.slotIdentity(stagingName),
    leaseScope: "prepare", leaseNonce: "e".repeat(32),
  };
  fixture.setState(claimed);
  await fixture.manager.promotePreparedVersion(
    promotionPlan(fixture, "1.0.0", "chatgpt", taskId, stagingName),
  );
  assert.deepEqual(fixture.versions(), { current: "1.0.0", previous: null, staging: null, retiring: null });
  assert.equal(fixture.calls.some(([operation, from, to]) => operation === "rename-slot"
    && from === stagingName && to === "ct"), true);
});

test("archive prepare WAL recovers when the source moved before the prepare claim transitioned", async () => {
  const stagingName = `.codexbridge-prepare-${"d".repeat(32)}`;
  const taskId = "archive-source-crash";
  const fixture = createFixture({ slots: { [stagingName]: null } });
  const claimed = fixture.state();
  claimed.activeTask = {
    kind: "component-prepare", taskId, componentId: "chatgpt", version: "1.0.0",
    stagingName, stagingIdentity: fixture.slotIdentity(stagingName),
    leaseScope: "prepare", leaseNonce: "e".repeat(32),
  };
  fixture.setState(claimed);
  fixture.fail("state", new Error("crash_before_claim_transition"));
  await assert.rejects(fixture.manager.promotePreparedVersion(
    promotionPlan(fixture, "1.0.0", "chatgpt", taskId, stagingName),
  ), /crash_before_claim_transition/u);
  assert.equal(fixture.state().activeTask.kind, "component-prepare");
  await recoverTransactions({ journal: fixture.journal, slots: fixture.manager });
  assert.equal(fixture.state().components.chatgpt.version, "1.0.0");
  assert.equal(fixture.state().activeTask, null);
});

test("prepared staging is bound to the durable claim and only that exact identity is discarded", async () => {
  const fixture = createFixture();
  const claimed = fixture.state();
  claimed.activeTask = {
    kind: "component-prepare", taskId: "bound-staging", componentId: "chatgpt", version: "1.0.0",
    stagingName: `.codexbridge-prepare-${"a".repeat(32)}`,
    leaseScope: "prepare", leaseNonce: "bound-lease",
  };
  fixture.setState(claimed);
  const bound = await fixture.manager.bindPreparedVersion({
    componentId: "chatgpt", taskId: "bound-staging", leaseNonce: "bound-lease",
  });
  assert.deepEqual(bound.stagingIdentity, fixture.state().activeTask.stagingIdentity);
  assert.equal(await fixture.manager.discardPreparedVersion({
    componentId: "chatgpt", taskId: "bound-staging", leaseNonce: "bound-lease",
  }), true);
  assert.deepEqual(fixture.versions(), { current: null, previous: null, staging: null, retiring: null });
});

test("failed prepared-directory inspection removes every exact unbound directory", async (t) => {
  for (const scenario of [
    { label: "first V2 root describe", componentId: "v2rayn", failKind: "workspace-describe", name: "V2RayN" },
    { label: "staging inspect", componentId: "chatgpt", failKind: "workspace-inspect" },
    { label: "staging describe", componentId: "chatgpt", failKind: "workspace-describe" },
  ]) {
    await t.test(scenario.label, async () => {
      const fixture = createFixture({ componentId: scenario.componentId });
      const taskId = `bind-fault-${scenario.label.replaceAll(" ", "-").toLowerCase()}`;
      const stagingName = `.codexbridge-prepare-${scenario.componentId === "v2rayn" ? "a" : scenario.failKind.endsWith("inspect") ? "b" : "c"}`
        .padEnd(53, scenario.componentId === "v2rayn" ? "a" : scenario.failKind.endsWith("inspect") ? "b" : "c");
      const claimed = fixture.state();
      claimed.activeTask = {
        kind: "component-prepare", taskId, componentId: scenario.componentId, version: "1.0.0",
        stagingName, leaseScope: "prepare", leaseNonce: "fault-lease",
      };
      fixture.setState(claimed);
      fixture.fail(scenario.failKind, new Error(`forced_${scenario.failKind}`), {
        match: ({ name }) => scenario.name === undefined || name === scenario.name,
      });
      await assert.rejects(fixture.manager.bindPreparedVersion({
        componentId: scenario.componentId, taskId, leaseNonce: "fault-lease",
      }), new RegExp(`forced_${scenario.failKind}`, "u"));
      assert.equal(fixture.slotExists(stagingName), false);
      if (scenario.componentId === "v2rayn") assert.equal(fixture.slotExists("V2RayN"), false);
      assert.equal(await fixture.manager.discardPreparedVersion({
        componentId: scenario.componentId, taskId, leaseNonce: "fault-lease",
      }), false);
    });
  }
});

test("prepared staging discard fails closed after a same-name identity replacement", async () => {
  const fixture = createFixture();
  const claimed = fixture.state();
  claimed.activeTask = {
    kind: "component-prepare", taskId: "foreign-staging", componentId: "chatgpt", version: "1.0.0",
    stagingName: `.codexbridge-prepare-${"b".repeat(32)}`,
    leaseScope: "prepare", leaseNonce: "foreign-lease",
  };
  fixture.setState(claimed);
  await fixture.manager.bindPreparedVersion({
    componentId: "chatgpt", taskId: "foreign-staging", leaseNonce: "foreign-lease",
  });
  fixture.replaceSlotIdentity(claimed.activeTask.stagingName);
  await assert.rejects(fixture.manager.discardPreparedVersion({
    componentId: "chatgpt", taskId: "foreign-staging", leaseNonce: "foreign-lease",
  }), /slot_discard_identity_changed/u);
  assert.notEqual(fixture.state().activeTask, null);
});

test("unbound prepared staging is never adopted or deleted even when it is empty", async () => {
  const stagingName = `.codexbridge-prepare-${"7".repeat(32)}`;
  const fixture = createFixture({ slots: { [stagingName]: null } });
  const claimed = fixture.state();
  claimed.activeTask = {
    kind: "component-prepare", taskId: "unbound-occupied", componentId: "chatgpt", version: "1.0.0",
    stagingName, leaseScope: "prepare", leaseNonce: "unbound-lease",
  };
  fixture.setState(claimed);
  await assert.rejects(fixture.manager.discardPreparedVersion({
    componentId: "chatgpt", taskId: "unbound-occupied", leaseNonce: "unbound-lease",
  }), /slot_prepare_unbound_occupied/u);
  assert.equal(fixture.slotExists(stagingName), true);
  assert.notEqual(fixture.state().activeTask, null);
});

test("first V2RayN prepare atomically owns and discards its exact new component root", async () => {
  const fixture = createFixture({ componentId: "v2rayn" });
  const claimed = fixture.state();
  claimed.activeTask = {
    kind: "component-prepare", taskId: "first-v2-root", componentId: "v2rayn", version: "1.0.0",
    stagingName: `.codexbridge-prepare-${"8".repeat(32)}`,
    leaseScope: "prepare", leaseNonce: "first-v2-lease",
  };
  fixture.setState(claimed);
  const bound = await fixture.manager.bindPreparedVersion({
    componentId: "v2rayn", taskId: "first-v2-root", leaseNonce: "first-v2-lease",
  });
  assert.ok(bound.componentRootIdentity);
  assert.equal(fixture.slotExists("V2RayN"), true);
  assert.equal(await fixture.manager.discardPreparedVersion({
    componentId: "v2rayn", taskId: "first-v2-root", leaseNonce: "first-v2-lease",
  }), true);
  assert.equal(fixture.slotExists("V2RayN"), false);
});

test("first V2RayN promotion rejects a same-path replacement of its owned component root", async () => {
  const fixture = createFixture({ componentId: "v2rayn" });
  const taskId = "first-v2-root-replaced";
  const stagingName = `.codexbridge-prepare-${"3".repeat(32)}`;
  const claimed = fixture.state();
  claimed.activeTask = {
    kind: "component-prepare", taskId, componentId: "v2rayn", version: "1.0.0",
    stagingName, leaseScope: "prepare", leaseNonce: "e".repeat(32),
  };
  fixture.setState(claimed);
  await fixture.manager.bindPreparedVersion({
    componentId: "v2rayn", taskId, leaseNonce: "e".repeat(32),
  });
  fixture.replaceV2RootIdentity();
  await assert.rejects(
    fixture.manager.promotePreparedVersion(
      promotionPlan(fixture, "1.0.0", "v2rayn", taskId, stagingName),
    ),
    /windows_identity_changed/u,
  );
  assert.equal(fixture.state().activeTask.kind, "component-prepare");
  assert.deepEqual(await fixture.journal.listTransactions(), []);
});

test("foreign pre-existing V2RayN root is never adopted by first prepare", async () => {
  const fixture = createFixture({ componentId: "v2rayn", slots: { V2RayN: null } });
  const claimed = fixture.state();
  claimed.activeTask = {
    kind: "component-prepare", taskId: "foreign-v2-root", componentId: "v2rayn", version: "1.0.0",
    stagingName: `.codexbridge-prepare-${"9".repeat(32)}`,
    leaseScope: "prepare", leaseNonce: "foreign-v2-lease",
  };
  fixture.setState(claimed);
  await assert.rejects(fixture.manager.bindPreparedVersion({
    componentId: "v2rayn", taskId: "foreign-v2-root", leaseNonce: "foreign-v2-lease",
  }), /slot_component_root_occupied/u);
  assert.equal(fixture.slotExists("V2RayN"), true);
  assert.notEqual(fixture.state().activeTask, null);
});

test("first V2RayN bind save ambiguity recovers a durable bound claim after exact live cleanup", async () => {
  const fixture = createFixture({ componentId: "v2rayn" });
  const claimed = fixture.state();
  claimed.activeTask = {
    kind: "component-prepare", taskId: "v2-save-ambiguous", componentId: "v2rayn", version: "1.0.0",
    stagingName: `.codexbridge-prepare-${"6".repeat(32)}`,
    leaseScope: "prepare", leaseNonce: "v2-save-lease",
  };
  fixture.setState(claimed);
  fixture.fail("state", new Error("save_after_write"), {
    after: true,
    match: (next) => next.activeTask?.componentRootIdentity !== undefined,
  });
  await assert.rejects(fixture.manager.bindPreparedVersion({
    componentId: "v2rayn", taskId: "v2-save-ambiguous", leaseNonce: "v2-save-lease",
  }), /save_after_write/u);
  assert.equal(fixture.slotExists("V2RayN"), false);
  assert.ok(fixture.state().activeTask.componentRootIdentity);
  assert.equal(await fixture.manager.discardPreparedVersion({
    componentId: "v2rayn", taskId: "v2-save-ambiguous", leaseNonce: "v2-save-lease",
  }), true);
});

test("first V2RayN abort recovery is idempotent after its exact component root is deleted", async (t) => {
  for (const [label, armFailure] of [
    ["before abort cleanup WAL", (fixture) => fixture.fail(
      "journal-write", new Error("crash_before_abort_cleanup_wal"), {
        match: ({ name }) => name === "v2rayn.abort_cleanup_committed.json.tmp",
      },
    )],
    ["after abort cleanup WAL", (fixture) => fixture.fail(
      "state", new Error("crash_after_abort_cleanup_wal"), {
        match: (next) => next.activeTask?.kind === "software-version-slot"
          && next.activeTask.lifecycle === "clearing",
      },
    )],
  ]) {
    await t.test(label, async () => {
      const fixture = createFixture({ componentId: "v2rayn" });
      const taskId = `v2-abort-${label.startsWith("before") ? "before" : "after"}`;
      const stagingName = `.codexbridge-prepare-${label.startsWith("before") ? "4" : "5"}`.padEnd(53, label.startsWith("before") ? "4" : "5");
      const claimed = fixture.state();
      claimed.activeTask = {
        kind: "component-prepare", taskId, componentId: "v2rayn", version: "1.0.0",
        stagingName, leaseScope: "prepare", leaseNonce: "e".repeat(32),
      };
      fixture.setState(claimed);
      await fixture.manager.bindPreparedVersion({
        componentId: "v2rayn", taskId, leaseNonce: "e".repeat(32),
      });
      fixture.fail("rename", new Error("crash_first_v2_promote"), {
        after: true, match: ({ from, to }) => from === "staging" && to === "current",
      });
      await assert.rejects(fixture.manager.promotePreparedVersion(
        promotionPlan(fixture, "1.0.0", "v2rayn", taskId, stagingName),
      ), /crash_first_v2_promote/u);
      fixture.damageSlot("current", "corrupt");
      armFailure(fixture);
      await assert.rejects(recoverTransactions({ journal: fixture.journal, slots: fixture.manager }), /crash_/u);
      assert.equal(fixture.slotExists("V2RayN"), false);
      assert.equal((await recoverTransactions({ journal: fixture.journal, slots: fixture.manager })).length, 1);
      assert.equal(fixture.state().activeTask, null);
      assert.equal(fixture.state().installRoot, null);
      assert.deepEqual(await fixture.journal.listTransactions(), []);
    });
  }
});

test("first V2RayN abort finish rejects a foreign root that reappears after cleanup WAL", async () => {
  const fixture = createFixture({ componentId: "v2rayn" });
  const taskId = "v2-abort-foreign-reappeared";
  const stagingName = `.codexbridge-prepare-${"2".repeat(32)}`;
  const claimed = fixture.state();
  claimed.activeTask = {
    kind: "component-prepare", taskId, componentId: "v2rayn", version: "1.0.0",
    stagingName, leaseScope: "prepare", leaseNonce: "e".repeat(32),
  };
  fixture.setState(claimed);
  await fixture.manager.bindPreparedVersion({
    componentId: "v2rayn", taskId, leaseNonce: "e".repeat(32),
  });
  fixture.fail("rename", new Error("crash_first_v2_promote"), {
    after: true, match: ({ from, to }) => from === "staging" && to === "current",
  });
  await assert.rejects(fixture.manager.promotePreparedVersion(
    promotionPlan(fixture, "1.0.0", "v2rayn", taskId, stagingName),
  ), /crash_first_v2_promote/u);
  fixture.damageSlot("current", "corrupt");
  fixture.fail("state", new Error("crash_after_abort_cleanup_wal"), {
    match: (next) => next.activeTask?.kind === "software-version-slot"
      && next.activeTask.lifecycle === "clearing",
  });
  await assert.rejects(
    recoverTransactions({ journal: fixture.journal, slots: fixture.manager }),
    /crash_after_abort_cleanup_wal/u,
  );
  assert.equal(fixture.slotExists("V2RayN"), false);
  fixture.addForeignV2Root();
  await assert.rejects(
    recoverTransactions({ journal: fixture.journal, slots: fixture.manager }),
    /slot_component_root_identity_changed/u,
  );
  assert.notEqual(fixture.state().activeTask, null);
  assert.equal((await fixture.journal.listTransactions()).length, 1);
  assert.equal(fixture.slotExists("V2RayN"), true);
});

test("first managed ChatGPT commit atomically claims a null installRoot while promoting CBApps\\ct to CBApps\\c", async () => {
  const state = emptyState();
  state.installRoot = null;
  const fixture = createFixture({ slots: { ct: null }, state });
  await fixture.manager.promotePreparedVersion(promotionPlan(fixture, "1.0.0"));
  assert.equal(fixture.state().installRoot, "D:\\CodexBridge");
  assert.equal(fixture.state().components.chatgpt.installPath, "D:\\CodexBridge\\c");
  assert.deepEqual(fixture.versions(), { current: "1.0.0", previous: null, staging: null, retiring: null });
});

test("an unclaimed first install requires the constructor-bound install-root capability", async () => {
  const state = emptyState();
  state.installRoot = null;
  const fixture = createFixture({ state, slots: { ct: null } });
  const managerWithoutAuthority = createVersionSlotManager({
    fsApi: fixture.fsApi,
    ownershipStore: fixture.ownershipStore,
    journal: fixture.journal,
  });
  await assert.rejects(
    managerWithoutAuthority.promotePreparedVersion(promotionPlan(fixture, "1.0.0")),
    /slot_root_not_owned/u,
  );
  assert.equal(fixture.state().installRoot, null);
  assert.equal(fixture.calls.some((call) => call[0] === "open-version-root"), false);
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
  const stateCommit = fixture.calls.findIndex((call) => call[0] === "state-commit" && call[1] === "3.0.0");
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

test("recovery authorizes the journal root and ownership snapshot before opening a version root", async () => {
  const fixture = fixtureWithInstalled({ currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0" });
  fixture.fail("rename", new Error("crash_after_retire"), {
    after: true,
    match: ({ from, to }) => from === "cp" && to === "cr",
  });
  await assert.rejects(fixture.manager.promotePreparedVersion(promotionPlan(fixture, "3.0.0")), /crash_after_retire/u);
  const forgedState = fixture.state();
  forgedState.installRoot = "D:\\Outside";
  fixture.setState(forgedState);
  fixture.resetCalls();

  await assert.rejects(
    recoverTransactions({ journal: fixture.journal, slots: fixture.manager }),
    /slot_root_not_owned/u,
  );
  assert.equal(fixture.calls.some((call) => call[0] === "open-version-root"), false);
  assert.equal(fixture.calls.some((call) => ["rename-slot", "state-commit", "delete-slot"].includes(call[0])), false);
});

test("recovery rejects ownership that matches neither the pre-state nor post-state snapshot before filesystem access", async () => {
  const fixture = fixtureWithInstalled({ currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0" });
  fixture.fail("rename", new Error("crash_after_retire"), {
    after: true,
    match: ({ from, to }) => from === "cp" && to === "cr",
  });
  await assert.rejects(fixture.manager.promotePreparedVersion(promotionPlan(fixture, "3.0.0")), /crash_after_retire/u);
  const corrupt = fixture.state();
  corrupt.components.chatgpt.version = "9.9.9";
  fixture.setState(corrupt);
  fixture.resetCalls();

  await assert.rejects(
    recoverTransactions({ journal: fixture.journal, slots: fixture.manager }),
    /slot_recovery_ownership_mismatch/u,
  );
  assert.equal(fixture.calls.some((call) => call[0] === "open-version-root"), false);
  assert.equal(fixture.calls.some((call) => ["rename-slot", "state-commit", "delete-slot"].includes(call[0])), false);
});

test("recovery rejects a re-marked incoming tree whose digests differ from the journal snapshot", async () => {
  const fixture = fixtureWithInstalled({
    currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0",
  });
  fixture.fail("rename", new Error("crash_after_retire"), {
    after: true,
    match: ({ from, to }) => from === "cp" && to === "cr",
  });
  await assert.rejects(fixture.manager.promotePreparedVersion(promotionPlan(fixture, "3.0.0")), /crash_after_retire/u);
  fixture.changeSlotContent("ct", "tampered-but-re-marked");
  fixture.rewriteSlotMarker("ct", "3.0.0");
  fixture.resetCalls();

  await assert.rejects(
    recoverTransactions({ journal: fixture.journal, slots: fixture.manager }),
    /slot_unrecognized_complete_version/u,
  );
  assert.equal(fixture.calls.some((call) => ["rename-slot", "state-commit", "delete-slot"].includes(call[0])), false);
});

test("committed retiring cleanup resumes from directory identity after marker deletion and rmdir failure", async () => {
  const fixture = fixtureWithInstalled({ currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0" });
  fixture.fail("delete", new Error("retiring_rmdir_failed"), {
    match: ({ name }) => name === "cr",
  });
  await assert.rejects(fixture.manager.promotePreparedVersion(promotionPlan(fixture, "3.0.0")), /retiring_rmdir_failed/u);
  const root = await fixture.fsApi.openVersionRootNoFollow(fixture.rootPath);
  const retiring = await root.openSlotNoFollow("cr");
  assert.equal(retiring.markerStatus, "missing");
  assert.equal(retiring.evidence, null);
  await root.close();

  assert.equal((await recoverTransactions({ journal: fixture.journal, slots: fixture.manager })).length, 1);
  assert.deepEqual(fixture.versions(), { current: "3.0.0", previous: "2.0.0", staging: null, retiring: null });
});

for (const crash of [
  { name: "after retiring rename", kind: "rename", after: true, match: ({ from, to }) => from === "cp" && to === "cr" },
  { name: "after old-current rename", kind: "rename", after: true, match: ({ from, to }) => from === "c" && to === "cp" },
  { name: "after incoming rename", kind: "rename", after: true, match: ({ from, to }) => from === "ct" && to === "c" },
  {
    name: "after ownership commit",
    kind: "state",
    after: true,
    match: (next) => next.components.chatgpt?.version === "3.0.0",
  },
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

for (const damage of ["missing", "corrupt"]) {
  test(`rollback recovery aborts and restores current when the target is ${damage}`, async () => {
    const fixture = fixtureWithInstalled({ currentVersion: "2.0.0", previousVersion: "1.0.0" });
    fixture.fail("rename", new Error("rollback_forward_crash"), {
      after: true,
      match: ({ from, to }) => from === "c" && to === "cr",
    });
    await assert.rejects(fixture.manager.rollbackVersion("chatgpt"), /rollback_forward_crash/u);
    fixture.damageSlot("cp", damage);
    fixture.resetCalls();
    const restarted = createVersionSlotManager({
      fsApi: fixture.fsApi,
      ownershipStore: fixture.ownershipStore,
      journal: fixture.journal,
    });

    assert.equal((await recoverTransactions({ journal: fixture.journal, slots: restarted })).length, 1);
    assert.deepEqual(await recoverTransactions({ journal: fixture.journal, slots: restarted }), []);
    assert.deepEqual(fixture.versions(), {
      current: "2.0.0", previous: null, staging: null, retiring: null,
    });
    assert.equal(fixture.state().components.chatgpt.version, "2.0.0");
    assert.equal(fixture.state().rollback, null);
    const abortWal = fixture.calls.findIndex((call) => call[0] === "journal-commit"
      && call[1] === "chatgpt.abort_started.json");
    const restoreWal = fixture.calls.findIndex((call) => call[0] === "journal-commit"
      && call[1] === "chatgpt.abort_current_restored.json");
    const restoreRename = fixture.calls.findIndex((call) => call[0] === "rename-slot"
      && call[1] === "cr" && call[2] === "c");
    assert.ok(abortWal >= 0 && restoreWal >= 0 && restoreWal < restoreRename);
    if (damage === "corrupt") {
      assert.equal(fixture.calls.some((call) => call[0] === "rename-slot"
        && call[1] === "cp" && call[2] === "ct"), true);
      assert.equal(fixture.calls.some((call) => call[0] === "delete-slot" && call[1] === "ct"), true);
    }
  });
}

test("rollback abort recovers from an abort-cleanup-only journal after clear crashes", async () => {
  const fixture = fixtureWithInstalled({ currentVersion: "2.0.0", previousVersion: "1.0.0" });
  fixture.fail("rename", new Error("rollback_forward_crash"), {
    after: true,
    match: ({ from, to }) => from === "c" && to === "cr",
  });
  await assert.rejects(fixture.manager.rollbackVersion("chatgpt"), /rollback_forward_crash/u);
  fixture.damageSlot("cp", "corrupt");
  fixture.fail("journal-unlink", new Error("abort_journal_clear_crash"), {
    match: ({ name }) => name === "chatgpt.abort_cleanup_committed.json",
  });
  await assert.rejects(
    recoverTransactions({ journal: fixture.journal, slots: fixture.manager }),
    /abort_journal_clear_crash/u,
  );
  const [pending] = await fixture.journal.listTransactions();
  assert.deepEqual(pending.records.map((record) => record.phase), ["abort_cleanup_committed"]);
  const restarted = createVersionSlotManager({
    fsApi: fixture.fsApi,
    ownershipStore: fixture.ownershipStore,
    journal: fixture.journal,
  });

  assert.equal((await recoverTransactions({ journal: fixture.journal, slots: restarted })).length, 1);
  assert.deepEqual(await recoverTransactions({ journal: fixture.journal, slots: restarted }), []);
  assert.deepEqual(fixture.versions(), {
    current: "2.0.0", previous: null, staging: null, retiring: null,
  });
  assert.equal(fixture.state().rollback, null);
});

for (const crash of [
  { name: "after invalid target isolation", kind: "rename", after: true, match: ({ from, to }) => from === "cp" && to === "ct" },
  { name: "after original current restoration", kind: "rename", after: true, match: ({ from, to }) => from === "cr" && to === "c" },
  { name: "after abort ownership save", kind: "state", after: true },
  { name: "after invalid target deletion", kind: "delete", after: true, match: ({ name }) => name === "ct" },
]) {
  test(`rollback abort recovery is restart-idempotent ${crash.name}`, async () => {
    const fixture = fixtureWithInstalled({ currentVersion: "2.0.0", previousVersion: "1.0.0" });
    fixture.fail("rename", new Error("rollback_forward_crash"), {
      after: true,
      match: ({ from, to }) => from === "c" && to === "cr",
    });
    await assert.rejects(fixture.manager.rollbackVersion("chatgpt"), /rollback_forward_crash/u);
    fixture.damageSlot("cp", "corrupt");
    fixture.fail(crash.kind, new Error("rollback_abort_crash"), crash);
    await assert.rejects(
      recoverTransactions({ journal: fixture.journal, slots: fixture.manager }),
      /rollback_abort_crash/u,
    );
    const restarted = createVersionSlotManager({
      fsApi: fixture.fsApi,
      ownershipStore: fixture.ownershipStore,
      journal: fixture.journal,
    });

    assert.equal((await recoverTransactions({ journal: fixture.journal, slots: restarted })).length, 1);
    assert.deepEqual(await recoverTransactions({ journal: fixture.journal, slots: restarted }), []);
    assert.deepEqual(fixture.versions(), {
      current: "2.0.0", previous: null, staging: null, retiring: null,
    });
    assert.equal(fixture.state().components.chatgpt.version, "2.0.0");
    assert.equal(fixture.state().rollback, null);
  });
}

for (const crash of [
  { name: "after current retires", kind: "rename", after: true, match: ({ from, to }) => from === "c" && to === "cr" },
  { name: "after previous becomes current", kind: "rename", after: true, match: ({ from, to }) => from === "cp" && to === "c" },
  {
    name: "after rollback ownership commit",
    kind: "state",
    after: true,
    match: (next) => next.components.chatgpt?.version === "1.0.0",
  },
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

for (const crash of [
  {
    phase: "retiring_moved",
    incomingSlot: "ct",
    match: ({ from, to }) => from === "cp" && to === "cr",
  },
  {
    phase: "old_moved",
    incomingSlot: "ct",
    match: ({ from, to }) => from === "c" && to === "cp",
  },
  {
    phase: "new_promoted",
    incomingSlot: "c",
    match: ({ from, to }) => from === "ct" && to === "c",
  },
]) {
  for (const damage of ["missing", "corrupt"]) {
    test(`recovery aborts ${crash.phase} when incoming is ${damage} and restores the exact pre-state`, async () => {
      const fixture = fixtureWithInstalled({
        currentVersion: "2.0.0",
        previousVersion: "1.0.0",
        incomingVersion: "3.0.0",
      });
      const before = fixture.state();
      fixture.fail("rename", new Error(`crash_${crash.phase}`), { after: true, match: crash.match });
      await assert.rejects(
        fixture.manager.promotePreparedVersion(promotionPlan(fixture, "3.0.0")),
        new RegExp(`crash_${crash.phase}`, "u"),
      );
      fixture.damageSlot(crash.incomingSlot, damage);
      fixture.resetCalls();

      assert.equal((await recoverTransactions({ journal: fixture.journal, slots: fixture.manager })).length, 1);
      assert.deepEqual(fixture.versions(), {
        current: "2.0.0", previous: "1.0.0", staging: null, retiring: null,
      });
      assert.deepEqual(semanticState(fixture.state()), semanticState(before));
      const committedPhases = fixture.calls
        .filter((call) => call[0] === "journal-commit")
        .map((call) => call[1]);
      for (const phase of [
        "abort_started", "abort_incoming_isolated", "abort_current_restored",
        "abort_previous_restored", "abort_state_restoring", "abort_cleanup_started",
        "abort_cleanup_committed",
      ]) {
        assert.equal(committedPhases.includes(`chatgpt.${phase}.json`), true);
      }
      const currentWal = fixture.calls.findIndex((call) => call[0] === "journal-commit"
        && call[1] === "chatgpt.abort_current_restored.json");
      const currentRename = fixture.calls.findIndex((call) => call[0] === "rename-slot"
        && call[2] === "c" && call[1] !== "ct");
      const previousWal = fixture.calls.findIndex((call) => call[0] === "journal-commit"
        && call[1] === "chatgpt.abort_previous_restored.json");
      const previousRename = fixture.calls.findIndex((call) => call[0] === "rename-slot"
        && call[1] === "cr" && call[2] === "cp");
      if (currentRename !== -1) assert.ok(currentWal < currentRename);
      if (previousRename !== -1) assert.ok(previousWal < previousRename);
    });
  }
}

test("first-install abort removes only the corrupt incoming tree and restores an empty layout", async () => {
  const fixture = createFixture({ slots: { ct: null } });
  const before = fixture.state();
  fixture.fail("rename", new Error("crash_first_install"), {
    after: true,
    match: ({ from, to }) => from === "ct" && to === "c",
  });
  await assert.rejects(fixture.manager.promotePreparedVersion(promotionPlan(fixture, "1.0.0")), /crash_first_install/u);
  fixture.damageSlot("c", "corrupt");

  assert.equal((await recoverTransactions({ journal: fixture.journal, slots: fixture.manager })).length, 1);
  assert.deepEqual(fixture.versions(), { current: null, previous: null, staging: null, retiring: null });
  const expected = semanticState(before);
  expected.installRoot = null;
  assert.deepEqual(semanticState(fixture.state()), expected);
});

test("abort after ownership save but before its WAL restores the exact original ownership slice", async () => {
  const fixture = fixtureWithInstalled({
    currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0",
  });
  const original = fixture.state();
  original.components.chatgpt.channel = "stable";
  original.rollback[0].note = "preserve-this-metadata";
  original.lastTask = { taskId: "older-task", componentId: "git", action: "promote" };
  fixture.setState(original);
  fixture.fail("state", new Error("crash_after_ownership_save"), {
    after: true,
    match: (next) => next.components.chatgpt?.version === "3.0.0",
  });
  await assert.rejects(
    fixture.manager.promotePreparedVersion(promotionPlan(fixture, "3.0.0")),
    /crash_after_ownership_save/u,
  );
  fixture.damageSlot("c", "corrupt");

  assert.equal((await recoverTransactions({ journal: fixture.journal, slots: fixture.manager })).length, 1);
  assert.deepEqual(semanticState(fixture.state()), semanticState(original));
  assert.deepEqual(fixture.versions(), {
    current: "2.0.0", previous: "1.0.0", staging: null, retiring: null,
  });
});

for (const crash of [
  { name: "after incoming isolation", kind: "rename", after: true, match: ({ from, to }) => from === "c" && to === "ct" },
  { name: "after current restoration", kind: "rename", after: true, match: ({ from, to }) => from === "cp" && to === "c" },
  { name: "after previous restoration", kind: "rename", after: true, match: ({ from, to }) => from === "cr" && to === "cp" },
  { name: "after failed-incoming deletion", kind: "delete", after: true, match: ({ name }) => name === "ct" },
]) {
  test(`abort recovery is idempotent ${crash.name}`, async () => {
    const fixture = fixtureWithInstalled({
      currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0",
    });
    const before = fixture.state();
    fixture.fail("rename", new Error("forward_crash"), {
      after: true,
      match: ({ from, to }) => from === "ct" && to === "c",
    });
    await assert.rejects(fixture.manager.promotePreparedVersion(promotionPlan(fixture, "3.0.0")), /forward_crash/u);
    fixture.damageSlot("c", "corrupt");
    fixture.fail(crash.kind, new Error("abort_crash"), crash);
    await assert.rejects(
      recoverTransactions({ journal: fixture.journal, slots: fixture.manager }),
      /abort_crash/u,
    );

    assert.equal((await recoverTransactions({ journal: fixture.journal, slots: fixture.manager })).length, 1);
    assert.deepEqual(await recoverTransactions({ journal: fixture.journal, slots: fixture.manager }), []);
    assert.deepEqual(semanticState(fixture.state()), semanticState(before));
    assert.deepEqual(fixture.versions(), {
      current: "2.0.0", previous: "1.0.0", staging: null, retiring: null,
    });
  });
}

test("abort recovery is idempotent after restoring ownership but before its WAL successor", async () => {
  const fixture = fixtureWithInstalled({
    currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0",
  });
  const before = fixture.state();
  fixture.fail("state", new Error("forward_state_crash"), {
    after: true,
    match: (next) => next.components.chatgpt?.version === "3.0.0",
  });
  await assert.rejects(fixture.manager.promotePreparedVersion(promotionPlan(fixture, "3.0.0")), /forward_state_crash/u);
  fixture.damageSlot("c", "corrupt");
  fixture.fail("state", new Error("abort_state_crash"), {
    after: true,
    match: (next) => next.components.chatgpt?.version === "2.0.0",
  });
  await assert.rejects(
    recoverTransactions({ journal: fixture.journal, slots: fixture.manager }),
    /abort_state_crash/u,
  );

  assert.equal((await recoverTransactions({ journal: fixture.journal, slots: fixture.manager })).length, 1);
  assert.deepEqual(await recoverTransactions({ journal: fixture.journal, slots: fixture.manager }), []);
  assert.deepEqual(semanticState(fixture.state()), semanticState(before));
  assert.deepEqual(fixture.versions(), {
    current: "2.0.0", previous: "1.0.0", staging: null, retiring: null,
  });
});

test("V2RayN and managed Git use readable fixed slot names", async () => {
  for (const componentId of ["v2rayn", "git"]) {
    const fixture = createFixture({ componentId, slots: { staging: null } });
    await fixture.manager.promotePreparedVersion(promotionPlan(fixture, "1.0.0", componentId));
    assert.deepEqual(fixture.versions(), { current: "1.0.0", previous: null, staging: null, retiring: null });
    assert.equal(fixture.calls.some((call) => call[0] === "rename-slot" && call[1] === "staging" && call[2] === "current"), true);
  }
});

test("two managers sharing one ownership store serialize ChatGPT and Git promotions without lost state", async () => {
  const chatgpt = createFixture({ componentId: "chatgpt", slots: { ct: null } });
  const git = createFixture({ componentId: "git", slots: { staging: null } });
  let persisted = emptyState();
  let loadCount = 0;
  let saveCount = 0;
  let releaseFirstSave;
  let firstSaveReached;
  const firstSave = new Promise((resolve) => { firstSaveReached = resolve; });
  const saveBarrier = new Promise((resolve) => { releaseFirstSave = resolve; });
  const sharedStore = {
    async load() {
      loadCount += 1;
      return clone(persisted);
    },
    async compareAndSwap(expectedGeneration, next) {
      saveCount += 1;
      if (saveCount === 1) {
        firstSaveReached();
        await saveBarrier;
      }
      if (persisted.generation !== expectedGeneration) throw new Error("ownership_generation_conflict");
      persisted = { ...clone(next), generation: expectedGeneration + 1 };
      return clone(persisted);
    },
  };
  const chatgptManager = createVersionSlotManager({
    fsApi: chatgpt.fsApi, ownershipStore: sharedStore, journal: chatgpt.journal,
  });
  const gitManager = createVersionSlotManager({
    fsApi: git.fsApi, ownershipStore: sharedStore, journal: git.journal,
  });

  const chatgptPromotion = chatgptManager.promotePreparedVersion(promotionPlan(chatgpt, "1.0.0"));
  await firstSave;
  const loadCountAtBarrier = loadCount;
  const gitPromotion = gitManager.promotePreparedVersion(promotionPlan(git, "2.46.0", "git"));
  await new Promise((resolve) => setImmediate(resolve));
  const serializedAtBarrier = loadCount === loadCountAtBarrier;
  releaseFirstSave();
  await Promise.all([chatgptPromotion, gitPromotion]);

  assert.equal(serializedAtBarrier, true);
  assert.equal(persisted.components.chatgpt.version, "1.0.0");
  assert.equal(persisted.components.git.version, "2.46.0");
  assert.deepEqual(chatgpt.versions(), { current: "1.0.0", previous: null, staging: null, retiring: null });
  assert.deepEqual(git.versions(), { current: "2.46.0", previous: null, staging: null, retiring: null });
});

test("a pending ChatGPT journal blocks Git until recovery clears the transaction", async () => {
  const chatgpt = fixtureWithInstalled({
    currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0",
  });
  const git = createFixture({ componentId: "git", slots: { staging: null } });
  let persisted = chatgpt.state();
  const ownershipStore = {
    async load() { return clone(persisted); },
    async compareAndSwap(expectedGeneration, next) {
      if (persisted.generation !== expectedGeneration) throw new Error("ownership_generation_conflict");
      persisted = { ...clone(next), generation: expectedGeneration + 1 };
      return clone(persisted);
    },
  };
  const sharedJournal = createTransactionJournal({
    journalDir: chatgpt.journalDir,
    fsApi: chatgpt.fsApi,
  });
  const chatgptManager = createVersionSlotManager({
    fsApi: chatgpt.fsApi, ownershipStore, journal: sharedJournal,
  });
  const gitManager = createVersionSlotManager({
    fsApi: git.fsApi, ownershipStore, journal: sharedJournal,
  });
  chatgpt.fail("rename", new Error("chatgpt_pending_crash"), {
    after: true,
    match: ({ from, to }) => from === "c" && to === "cp",
  });
  await assert.rejects(
    chatgptManager.promotePreparedVersion(promotionPlan(chatgpt, "3.0.0")),
    /chatgpt_pending_crash/u,
  );

  await assert.rejects(
    gitManager.promotePreparedVersion(promotionPlan(git, "2.46.0", "git")),
    /slot_pending_transaction/u,
  );
  assert.equal(persisted.components.git, undefined);
  assert.equal((await recoverTransactions({ journal: sharedJournal, slots: chatgptManager })).length, 1);
  await gitManager.promotePreparedVersion(promotionPlan(git, "2.46.0", "git"));
  assert.equal(persisted.components.chatgpt.version, "3.0.0");
  assert.equal(persisted.components.git.version, "2.46.0");
});

test("a pending ChatGPT transaction in a separate journal blocks Git until its owner recovers and clears it", async () => {
  const chatgpt = fixtureWithInstalled({
    currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0",
  });
  const git = createFixture({ componentId: "git", slots: { staging: null } });
  const backing = createSharedOwnershipBacking(chatgpt.state());
  const ownershipStore = backing.createStore();
  const chatgptJournal = createTransactionJournal({
    journalDir: "D:\\CodexBridge\\State\\chatgpt-transactions",
    fsApi: chatgpt.fsApi,
  });
  const gitJournal = createTransactionJournal({
    journalDir: "D:\\CodexBridge\\State\\git-transactions",
    fsApi: git.fsApi,
  });
  const chatgptManager = createVersionSlotManager({
    fsApi: chatgpt.fsApi, ownershipStore, journal: chatgptJournal,
  });
  const gitManager = createVersionSlotManager({
    fsApi: git.fsApi, ownershipStore, journal: gitJournal,
  });
  chatgpt.fail("rename", new Error("chatgpt_separate_journal_crash"), {
    after: true,
    match: ({ from, to }) => from === "c" && to === "cp",
  });
  await assert.rejects(
    chatgptManager.promotePreparedVersion(promotionPlan(chatgpt, "3.0.0")),
    /chatgpt_separate_journal_crash/u,
  );

  await assert.rejects(
    gitManager.promotePreparedVersion(promotionPlan(git, "2.46.0", "git")),
    /slot_pending_transaction/u,
  );
  assert.equal(backing.state().components.git, undefined);
  assert.equal((await recoverTransactions({ journal: chatgptJournal, slots: chatgptManager })).length, 1);
  await gitManager.promotePreparedVersion(promotionPlan(git, "2.46.0", "git"));
  assert.equal(backing.state().components.chatgpt.version, "3.0.0");
  assert.equal(backing.state().components.git.version, "2.46.0");
});

test("a persisted pending transaction blocks new managers after process restart simulation", async () => {
  const chatgpt = fixtureWithInstalled({
    currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0",
  });
  const git = createFixture({ componentId: "git", slots: { staging: null } });
  const backing = createSharedOwnershipBacking(chatgpt.state());
  const chatgptJournalDir = "D:\\CodexBridge\\State\\restart-chatgpt-transactions";
  const gitJournalDir = "D:\\CodexBridge\\State\\restart-git-transactions";
  const firstChatgptManager = createVersionSlotManager({
    fsApi: chatgpt.fsApi,
    ownershipStore: backing.createStore(),
    journal: createTransactionJournal({ journalDir: chatgptJournalDir, fsApi: chatgpt.fsApi }),
  });
  chatgpt.fail("rename", new Error("chatgpt_restart_pending_crash"), {
    after: true,
    match: ({ from, to }) => from === "c" && to === "cp",
  });
  await assert.rejects(
    firstChatgptManager.promotePreparedVersion(promotionPlan(chatgpt, "3.0.0")),
    /chatgpt_restart_pending_crash/u,
  );

  const restartedStore = backing.createStore();
  const restartedChatgptJournal = createTransactionJournal({
    journalDir: chatgptJournalDir,
    fsApi: chatgpt.fsApi,
  });
  const restartedChatgptManager = createVersionSlotManager({
    fsApi: chatgpt.fsApi, ownershipStore: restartedStore, journal: restartedChatgptJournal,
  });
  const restartedGitManager = createVersionSlotManager({
    fsApi: git.fsApi,
    ownershipStore: restartedStore,
    journal: createTransactionJournal({ journalDir: gitJournalDir, fsApi: git.fsApi }),
  });
  await assert.rejects(
    restartedGitManager.promotePreparedVersion(promotionPlan(git, "2.46.0", "git")),
    /slot_pending_transaction/u,
  );
  assert.equal((await recoverTransactions({
    journal: restartedChatgptJournal,
    slots: restartedChatgptManager,
  })).length, 1);
  await restartedGitManager.promotePreparedVersion(promotionPlan(git, "2.46.0", "git"));
  assert.equal(backing.state().components.chatgpt.version, "3.0.0");
  assert.equal(backing.state().components.git.version, "2.46.0");
});

test("a cleanup tombstone in one journal blocks other journals only until atomic recovery clears it", async () => {
  const chatgpt = fixtureWithInstalled({
    currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0",
  });
  const git = createFixture({ componentId: "git", slots: { staging: null } });
  const backing = createSharedOwnershipBacking(chatgpt.state());
  const ownershipStore = backing.createStore();
  const chatgptJournal = createTransactionJournal({
    journalDir: "D:\\CodexBridge\\State\\tombstone-chatgpt-transactions",
    fsApi: chatgpt.fsApi,
  });
  const gitJournal = createTransactionJournal({
    journalDir: "D:\\CodexBridge\\State\\tombstone-git-transactions",
    fsApi: git.fsApi,
  });
  const chatgptManager = createVersionSlotManager({
    fsApi: chatgpt.fsApi, ownershipStore, journal: chatgptJournal,
  });
  const gitManager = createVersionSlotManager({
    fsApi: git.fsApi, ownershipStore, journal: gitJournal,
  });
  chatgpt.fail("journal-unlink", new Error("chatgpt_tombstone_clear_crash"), {
    after: true,
    match: ({ name }) => name === "chatgpt.prepared.json",
  });
  await assert.rejects(
    chatgptManager.promotePreparedVersion(promotionPlan(chatgpt, "3.0.0")),
    /chatgpt_tombstone_clear_crash/u,
  );

  await assert.rejects(
    gitManager.promotePreparedVersion(promotionPlan(git, "2.46.0", "git")),
    /slot_pending_transaction/u,
  );
  assert.equal((await recoverTransactions({ journal: chatgptJournal, slots: chatgptManager })).length, 1);
  await gitManager.promotePreparedVersion(promotionPlan(git, "2.46.0", "git"));
  assert.equal(backing.state().components.chatgpt.version, "3.0.0");
  assert.equal(backing.state().components.git.version, "2.46.0");
});

test("recovery holds the ownership-store lock through journal clear and claim release", async () => {
  const chatgpt = fixtureWithInstalled({
    currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0",
  });
  const git = createFixture({ componentId: "git", slots: { staging: null } });
  const backing = createSharedOwnershipBacking(chatgpt.state());
  const ownershipStore = backing.createStore();
  const baseChatgptJournal = createTransactionJournal({
    journalDir: "D:\\CodexBridge\\State\\atomic-chatgpt-transactions",
    fsApi: chatgpt.fsApi,
  });
  let releaseClear;
  let clearReached;
  const clearStarted = new Promise((resolve) => { clearReached = resolve; });
  const clearBarrier = new Promise((resolve) => { releaseClear = resolve; });
  const chatgptJournal = Object.freeze({
    scopeId: baseChatgptJournal.scopeId,
    record: (...args) => baseChatgptJournal.record(...args),
    listTransactions: (...args) => baseChatgptJournal.listTransactions(...args),
    async clear(...args) {
      clearReached();
      await clearBarrier;
      return baseChatgptJournal.clear(...args);
    },
  });
  const gitJournal = createTransactionJournal({
    journalDir: "D:\\CodexBridge\\State\\atomic-git-transactions",
    fsApi: git.fsApi,
  });
  const chatgptManager = createVersionSlotManager({
    fsApi: chatgpt.fsApi, ownershipStore, journal: chatgptJournal,
  });
  const gitManager = createVersionSlotManager({
    fsApi: git.fsApi, ownershipStore, journal: gitJournal,
  });
  chatgpt.fail("rename", new Error("chatgpt_atomic_recovery_crash"), {
    after: true,
    match: ({ from, to }) => from === "c" && to === "cp",
  });
  await assert.rejects(
    chatgptManager.promotePreparedVersion(promotionPlan(chatgpt, "3.0.0")),
    /chatgpt_atomic_recovery_crash/u,
  );

  const recovery = recoverTransactions({ journal: chatgptJournal, slots: chatgptManager });
  await clearStarted;
  let gitOutcome;
  const gitPromotion = gitManager.promotePreparedVersion(promotionPlan(git, "2.46.0", "git"))
    .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  gitPromotion.then((outcome) => { gitOutcome = outcome; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gitOutcome, undefined);

  releaseClear();
  assert.equal((await recovery).length, 1);
  assert.deepEqual(await gitPromotion, { ok: true });
  assert.equal(backing.state().components.chatgpt.version, "3.0.0");
  assert.equal(backing.state().components.git.version, "2.46.0");
});

test("restart recovery releases a clearing claim after its committed journal was fully cleared", async () => {
  const chatgpt = fixtureWithInstalled({
    currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0",
  });
  const git = createFixture({ componentId: "git", slots: { staging: null } });
  const chatgptJournalDir = "D:\\CodexBridge\\State\\cleared-chatgpt-transactions";
  const gitJournalDir = "D:\\CodexBridge\\State\\cleared-git-transactions";
  const chatgptJournal = createTransactionJournal({
    journalDir: chatgptJournalDir,
    fsApi: chatgpt.fsApi,
  });
  let failRelease = true;
  const firstStore = {
    load: (...args) => chatgpt.ownershipStore.load(...args),
    async compareAndSwap(expectedGeneration, next) {
      if (failRelease && next.activeTask === null
        && next.components.chatgpt?.version === "3.0.0") {
        failRelease = false;
        throw new Error("claim_release_crash");
      }
      return chatgpt.ownershipStore.compareAndSwap(expectedGeneration, next);
    },
  };
  const firstManager = createVersionSlotManager({
    fsApi: chatgpt.fsApi, ownershipStore: firstStore, journal: chatgptJournal,
  });
  await assert.rejects(
    firstManager.promotePreparedVersion(promotionPlan(chatgpt, "3.0.0")),
    /claim_release_crash/u,
  );
  assert.deepEqual(await chatgptJournal.listTransactions(), []);
  assert.equal((await firstStore.load()).activeTask.lifecycle, "clearing");

  const restartedStore = {
    load: (...args) => chatgpt.ownershipStore.load(...args),
    compareAndSwap: (...args) => chatgpt.ownershipStore.compareAndSwap(...args),
  };
  const restartedChatgptJournal = createTransactionJournal({
    journalDir: chatgptJournalDir,
    fsApi: chatgpt.fsApi,
  });
  const restartedChatgptManager = createVersionSlotManager({
    fsApi: chatgpt.fsApi, ownershipStore: restartedStore, journal: restartedChatgptJournal,
  });
  const restartedGitManager = createVersionSlotManager({
    fsApi: git.fsApi,
    ownershipStore: restartedStore,
    journal: createTransactionJournal({ journalDir: gitJournalDir, fsApi: git.fsApi }),
  });
  await assert.rejects(
    restartedGitManager.promotePreparedVersion(promotionPlan(git, "2.46.0", "git")),
    /slot_pending_transaction/u,
  );
  assert.deepEqual(await recoverTransactions({
    journal: restartedChatgptJournal,
    slots: restartedChatgptManager,
  }), []);
  assert.equal((await restartedStore.load()).activeTask, null);
  await restartedGitManager.promotePreparedVersion(promotionPlan(git, "2.46.0", "git"));
  assert.equal((await restartedStore.load()).components.chatgpt.version, "3.0.0");
  assert.equal((await restartedStore.load()).components.git.version, "2.46.0");
});

test("a pending transaction does not block a manager backed by a different ownership store", async () => {
  const chatgpt = fixtureWithInstalled({
    currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0",
  });
  const git = createFixture({ componentId: "git", slots: { staging: null } });
  const chatgptBacking = createSharedOwnershipBacking(chatgpt.state());
  const gitBacking = createSharedOwnershipBacking(git.state());
  const chatgptManager = createVersionSlotManager({
    fsApi: chatgpt.fsApi,
    ownershipStore: chatgptBacking.createStore(),
    journal: createTransactionJournal({
      journalDir: "D:\\CodexBridge\\State\\isolated-chatgpt-transactions",
      fsApi: chatgpt.fsApi,
    }),
  });
  const gitManager = createVersionSlotManager({
    fsApi: git.fsApi,
    ownershipStore: gitBacking.createStore(),
    journal: createTransactionJournal({
      journalDir: "D:\\CodexBridge\\State\\isolated-git-transactions",
      fsApi: git.fsApi,
    }),
  });
  chatgpt.fail("rename", new Error("chatgpt_isolated_pending_crash"), {
    after: true,
    match: ({ from, to }) => from === "c" && to === "cp",
  });
  await assert.rejects(
    chatgptManager.promotePreparedVersion(promotionPlan(chatgpt, "3.0.0")),
    /chatgpt_isolated_pending_crash/u,
  );

  await gitManager.promotePreparedVersion(promotionPlan(git, "2.46.0", "git"));
  assert.equal(gitBacking.state().components.git.version, "2.46.0");
  assert.equal(chatgptBacking.state().components.git, undefined);
});

test("retiring deletion stays inside the coordinated ownership snapshot", async () => {
  const fixture = fixtureWithInstalled({
    currentVersion: "2.0.0", previousVersion: "1.0.0", incomingVersion: "3.0.0",
  });
  let persisted = fixture.state();
  let saved = false;
  let loadsAfterSave = 0;
  const ownershipStore = {
    async load() {
      if (saved) {
        loadsAfterSave += 1;
        if (loadsAfterSave === 2) persisted.components.chatgpt.version = "external-change";
      }
      return clone(persisted);
    },
    async compareAndSwap(expectedGeneration, next) {
      if (persisted.generation !== expectedGeneration) throw new Error("ownership_generation_conflict");
      persisted = { ...clone(next), generation: expectedGeneration + 1 };
      saved = true;
      return clone(persisted);
    },
  };
  const manager = createVersionSlotManager({
    fsApi: fixture.fsApi, ownershipStore, journal: fixture.journal,
  });

  await manager.promotePreparedVersion(promotionPlan(fixture, "3.0.0"));
  assert.equal(persisted.components.chatgpt.version, "3.0.0");
  assert.equal(fixture.versions().retiring, null);
  assert.equal(fixture.calls.some((call) => call[0] === "delete-slot" && call[1] === "cr"), true);
});

test("slot manager fails closed without the native version-root capability", () => {
  assert.throws(
    () => createVersionSlotManager({ fsApi: {}, ownershipStore: { load() {}, save() {} }, journal: {} }),
    /slot_no_follow_capability_required/u,
  );
});

test("promotion requires a fake-verifier-issued opaque receipt and rejects post-verification content changes", async () => {
  const forgedFixture = createFixture({ slots: { ct: null } });
  const forgedPlan = promotionPlan(forgedFixture, "1.0.0");
  await assert.rejects(
    forgedFixture.manager.promotePreparedVersion({ ...forgedPlan, verificationReceipt: {} }),
    /version_verification_receipt_invalid/u,
  );
  assert.equal((await forgedFixture.journal.listTransactions()).length, 1);
  assert.deepEqual(forgedFixture.versions(), {
    current: null, previous: null, staging: null, retiring: null,
  });

  const fixture = createFixture({ slots: { ct: null } });
  const verifiedPlan = promotionPlan(fixture, "1.0.0");
  fixture.changeSlotContent("ct", "tampered-after-verification");
  await assert.rejects(
    fixture.manager.promotePreparedVersion(verifiedPlan),
    /version_tree_digest_mismatch/u,
  );
  assert.deepEqual(fixture.versions(), { current: null, previous: null, staging: null, retiring: null });
  assert.equal(fixture.state().components.chatgpt, undefined);
});

test("a failed first prepared WAL write does not consume the receipt and the same plan retries", async () => {
  const fixture = createFixture({ slots: { ct: null } });
  const plan = promotionPlan(fixture, "1.0.0");
  fixture.fail("journal-write", new Error("prepared_wal_failed"), {
    match: ({ name }) => name === "chatgpt.prepared.json.tmp",
  });

  await assert.rejects(fixture.manager.promotePreparedVersion(plan), /prepared_wal_failed/u);
  assert.equal(fixture.calls.some((call) => call[0] === "seal"), false);
  await fixture.manager.promotePreparedVersion(plan);
  assert.deepEqual(fixture.versions(), {
    current: "1.0.0", previous: null, staging: null, retiring: null,
  });
});

test("a restart recovers a seal completed after prepared WAL without the in-memory receipt", async () => {
  const fixture = createFixture({ slots: { ct: null } });
  fixture.fail("seal", new Error("crash_after_seal"), { after: true });
  await assert.rejects(
    fixture.manager.promotePreparedVersion(promotionPlan(fixture, "1.0.0")),
    /crash_after_seal/u,
  );
  const preparedWal = fixture.calls.findIndex((call) => call[0] === "journal-commit"
    && call[1] === "chatgpt.prepared.json");
  const seal = fixture.calls.findIndex((call) => call[0] === "seal");
  assert.ok(preparedWal >= 0 && preparedWal < seal);
  fixture.forgetVerificationReceipts();
  const restarted = createVersionSlotManager({
    fsApi: fixture.fsApi,
    ownershipStore: fixture.ownershipStore,
    journal: fixture.journal,
  });

  assert.equal((await recoverTransactions({ journal: fixture.journal, slots: restarted })).length, 1);
  assert.deepEqual(fixture.versions(), {
    current: "1.0.0", previous: null, staging: null, retiring: null,
  });
});

test("first-install promotion rejects a component root outside the ownership install root before mutation", async () => {
  const fixture = createFixture({ slots: { ct: null } });
  const plan = promotionPlan(fixture, "1.0.0", "chatgpt", "unauthorized-root");
  await assert.rejects(
    fixture.manager.promotePreparedVersion({
      ...plan,
      rootPath: "D:\\Other",
      runtimeMetadata: {
        entrypointPath: "D:\\Other\\c\\ChatGPT.exe",
        requiredFiles: ["D:\\Other\\c\\ChatGPT.exe"],
        health: "pending-verify",
      },
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
