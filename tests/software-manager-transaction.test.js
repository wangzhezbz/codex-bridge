import assert from "node:assert/strict";
import test from "node:test";

import {
  createTransactionJournal,
  recoverTransactions,
} from "../desktop/software-manager/transaction-journal.mjs";

function clone(value) {
  return structuredClone(value);
}

function createJournalFs() {
  const files = new Map();
  const calls = [];
  let identity = 0;
  let failUnlinkAt = null;
  let unlinkCount = 0;

  function openDirectory() {
    const entries = new WeakMap();
    return {
      async listFileNamesNoFollow() {
        calls.push(["list"]);
        return [...files.keys()];
      },
      async openFileNoFollow(name, flags) {
        calls.push(["open", name, flags]);
        let file = files.get(name);
        if (flags === "r") {
          if (!file) return null;
        } else if (flags === "wx") {
          if (file) throw Object.assign(new Error("entry_exists"), { code: "entry_exists" });
          file = { identity: `journal-${++identity}`, data: "" };
          files.set(name, file);
        } else {
          throw new Error("unsupported flags");
        }
        const entry = Object.freeze({ name, identity: file.identity });
        entries.set(entry, file);
        return {
          entry,
          async readFile(encoding) {
            return encoding ? file.data : Buffer.from(file.data);
          },
          async writeFile(value) {
            calls.push(["write", name]);
            file.data = String(value);
          },
          async sync() {
            calls.push(["flush", name]);
          },
          async close() {
            calls.push(["close-file", name]);
          },
        };
      },
      async unlinkEntryNoFollow(entry) {
        const file = entries.get(entry);
        assert.ok(file);
        assert.equal(files.get(entry.name), file);
        unlinkCount += 1;
        if (unlinkCount === failUnlinkAt) throw new Error("journal_clear_crash");
        calls.push(["unlink", entry.name]);
        files.delete(entry.name);
      },
      async renameEntryNoFollow(entry, destinationName) {
        const file = entries.get(entry);
        assert.ok(file);
        assert.equal(files.get(entry.name), file);
        if (files.has(destinationName)) {
          throw Object.assign(new Error("entry_exists"), { code: "entry_exists" });
        }
        calls.push(["rename-handle", entry.name, destinationName]);
        files.delete(entry.name);
        files.set(destinationName, file);
      },
      async close() {
        calls.push(["close-directory"]);
      },
    };
  }

  return {
    files,
    calls,
    fsApi: { openJournalDirectoryNoFollow: async () => openDirectory() },
    failUnlink(number) { failUnlinkAt = unlinkCount + number; },
  };
}

function record(overrides = {}) {
  const rootPath = "D:\\CodexBridge";
  const identities = {
    incoming: { volumeSerial: "vol", fileId: "three" },
    current: { volumeSerial: "vol", fileId: "two" },
    previous: { volumeSerial: "vol", fileId: "one" },
  };
  const integrities = {
    incoming: { treeDigest: "3".repeat(64), manifestDigest: "a".repeat(64) },
    current: { treeDigest: "2".repeat(64), manifestDigest: "b".repeat(64) },
    previous: { treeDigest: "1".repeat(64), manifestDigest: "c".repeat(64) },
  };
  return {
    schemaVersion: 2,
    taskId: "task-3",
    componentId: "chatgpt",
    mode: "promote",
    phase: "prepared",
    rootPath,
    slots: { current: "c", previous: "cp", staging: "ct", retiring: "cr" },
    paths: {
      current: `${rootPath}\\c`,
      previous: `${rootPath}\\cp`,
      staging: `${rootPath}\\ct`,
      retiring: `${rootPath}\\cr`,
    },
    versions: { incoming: "3.0.0", current: "2.0.0", previous: "1.0.0" },
    identities,
    integrities,
    runtimeMetadata: {
      entrypointPath: `${rootPath}\\c\\ChatGPT.exe`,
      requiredFiles: [`${rootPath}\\c\\ChatGPT.exe`],
      health: "pending-verify",
    },
    ownershipBefore: {
      installRoot: rootPath,
      component: {
        installPath: `${rootPath}\\c`,
        version: "2.0.0",
        treeDigest: integrities.current.treeDigest,
        manifestDigest: integrities.current.manifestDigest,
        slotIdentity: clone(identities.current),
        managed: true,
      },
      rollback: {
        path: `${rootPath}\\cp`,
        rootPath,
        componentId: "chatgpt",
        version: "1.0.0",
        treeDigest: integrities.previous.treeDigest,
        manifestDigest: integrities.previous.manifestDigest,
        slotIdentity: clone(identities.previous),
      },
      activeTask: null,
      lastTask: null,
    },
    ...overrides,
  };
}

function rollbackRecord(overrides = {}) {
  const base = record();
  return {
    ...base,
    taskId: "rollback-chatgpt",
    mode: "rollback",
    versions: { ...base.versions, incoming: null },
    identities: { ...base.identities, incoming: null },
    integrities: { ...base.integrities, incoming: null },
    runtimeMetadata: null,
    ...overrides,
  };
}

test("journal records each phase through a flushed direct-child temp before no-replace publication", async () => {
  const fake = createJournalFs();
  const journal = createTransactionJournal({ journalDir: "D:\\State\\transactions", fsApi: fake.fsApi });
  await journal.record(record());

  const write = fake.calls.findIndex((call) => call[0] === "write");
  const flush = fake.calls.findIndex((call) => call[0] === "flush");
  const rename = fake.calls.findIndex((call) => call[0] === "rename-handle");
  assert.ok(write >= 0 && write < flush && flush < rename);
  assert.deepEqual([...fake.files.keys()], ["chatgpt.prepared.json"]);
  assert.equal(fake.calls.some((call) => call[0] === "rename"), false);
});

test("journal rejects non-fixed component slots, paths, unknown fields, and unsafe integer-like task input", async () => {
  const fake = createJournalFs();
  const journal = createTransactionJournal({ journalDir: "D:\\State\\transactions", fsApi: fake.fsApi });
  const malformed = [
    record({ componentId: "skill" }),
    record({ slots: { current: "current", previous: "cp", staging: "ct", retiring: "cr" } }),
    record({ paths: { ...record().paths, current: "D:\\Other\\c" } }),
    { ...record(), rendererPath: "D:\\victim" },
    record({ taskId: "../task" }),
  ];
  for (const value of malformed) {
    await assert.rejects(journal.record(value), /transaction_record_invalid/u);
  }
  assert.equal(fake.calls.length, 0);
});

test("journal rejects canonical-looking ADS, reserved-name, and trailing-dot roots before opening storage", async () => {
  const fake = createJournalFs();
  const journal = createTransactionJournal({ journalDir: "D:\\State\\transactions", fsApi: fake.fsApi });
  for (const rootPath of ["D:\\Owned:stream", "D:\\Safe\\CON", "D:\\Safe\\slot."]) {
    const value = record({
      rootPath,
      paths: {
        current: `${rootPath}\\c`,
        previous: `${rootPath}\\cp`,
        staging: `${rootPath}\\ct`,
        retiring: `${rootPath}\\cr`,
      },
    });
    await assert.rejects(journal.record(value), /transaction_record_invalid/u);
  }
  assert.equal(fake.calls.length, 0);
});

test("journal phase publication is idempotent only for the identical strict record", async () => {
  const fake = createJournalFs();
  const journal = createTransactionJournal({ journalDir: "D:\\State\\transactions", fsApi: fake.fsApi });
  await journal.record(record());
  const callCount = fake.calls.length;
  await journal.record(record());
  assert.equal(fake.calls.slice(callCount).some((call) => call[0] === "write"), false);
  await assert.rejects(
    journal.record(record({ versions: { ...record().versions, incoming: "4.0.0" } })),
    /transaction_journal_conflict/u,
  );
});

test("journal ignores and removes only interrupted temp entries while preserving committed phases", async () => {
  const fake = createJournalFs();
  const journal = createTransactionJournal({ journalDir: "D:\\State\\transactions", fsApi: fake.fsApi });
  await journal.record(record());
  fake.files.set("chatgpt.new_promoted.json.tmp", { identity: "orphan", data: JSON.stringify(record({ phase: "new_promoted" })) });
  const transactions = await journal.listTransactions();
  assert.equal(transactions.length, 1);
  assert.deepEqual(transactions[0].records.map((item) => item.phase), ["prepared"]);
  assert.equal(fake.files.has("chatgpt.new_promoted.json.tmp"), false);
  assert.equal(fake.files.has("chatgpt.prepared.json"), true);
});

test("journal discards a truncated uncommitted temp without treating it as a committed phase", async () => {
  const fake = createJournalFs();
  fake.files.set("chatgpt.prepared.json.tmp", { identity: "partial", data: "{" });
  const journal = createTransactionJournal({ journalDir: "D:\\State\\transactions", fsApi: fake.fsApi });
  assert.deepEqual(await journal.listTransactions(), []);
  assert.equal(fake.files.size, 0);
});

test("journal rejects phase gaps instead of inferring a completed rename from a filename", async () => {
  const fake = createJournalFs();
  const journal = createTransactionJournal({ journalDir: "D:\\State\\transactions", fsApi: fake.fsApi });
  await journal.record(record());
  await assert.rejects(
    journal.record(record({ phase: "new_promoted" })),
    /transaction_journal_phase_order_invalid/u,
  );
});

test("journal accepts only a strict idempotent abort/revert suffix after a pre-commit promote prefix", async () => {
  const fake = createJournalFs();
  const journal = createTransactionJournal({ journalDir: "D:\\State\\transactions", fsApi: fake.fsApi });
  await journal.record(record());
  await journal.record(record({ phase: "retiring_moved" }));
  await assert.rejects(
    journal.record(record({ phase: "abort_current_restored" })),
    /transaction_journal_phase_order_invalid/u,
  );
  for (const phase of [
    "abort_started", "abort_incoming_isolated", "abort_current_restored",
    "abort_previous_restored", "abort_state_restoring", "abort_cleanup_started",
    "abort_cleanup_committed",
  ]) {
    await journal.record(record({ phase }));
  }
  await journal.record(record({ phase: "abort_cleanup_committed" }));
  const [transaction] = await journal.listTransactions();
  assert.deepEqual(transaction.records.map((item) => item.phase), [
    "prepared", "retiring_moved", "abort_started", "abort_incoming_isolated",
    "abort_current_restored", "abort_previous_restored", "abort_state_restoring",
    "abort_cleanup_started", "abort_cleanup_committed",
  ]);
  await assert.rejects(
    journal.record(record({ phase: "new_promoted" })),
    /transaction_journal_phase_order_invalid/u,
  );
});

test("journal accepts the same strict abort/revert suffix for a pre-commit rollback", async () => {
  const fake = createJournalFs();
  const journal = createTransactionJournal({ journalDir: "D:\\State\\transactions", fsApi: fake.fsApi });
  await journal.record(rollbackRecord());
  await journal.record(rollbackRecord({ phase: "retiring_moved" }));
  for (const phase of [
    "abort_started", "abort_incoming_isolated", "abort_current_restored",
    "abort_previous_restored", "abort_state_restoring", "abort_cleanup_started",
    "abort_cleanup_committed",
  ]) {
    await journal.record(rollbackRecord({ phase }));
  }
  const [transaction] = await journal.listTransactions();
  assert.deepEqual(transaction.records.map((item) => item.phase), [
    "prepared", "retiring_moved", "abort_started", "abort_incoming_isolated",
    "abort_current_restored", "abort_previous_restored", "abort_state_restoring",
    "abort_cleanup_started", "abort_cleanup_committed",
  ]);
});

test("recoverTransactions rejects split recovery and delegates the complete journal lifecycle", async () => {
  const fake = createJournalFs();
  const journal = createTransactionJournal({ journalDir: "D:\\State\\transactions", fsApi: fake.fsApi });
  await journal.record(record());
  await assert.rejects(
    recoverTransactions({
      journal,
      slots: { async recoverTransaction() {} },
    }),
    /transaction_recovery_capability_invalid/u,
  );
  assert.equal((await journal.listTransactions()).length, 1);

  const seen = [];
  const recovered = await recoverTransactions({
    journal,
    slots: {
      async recoverJournalTransactions(receivedJournal) {
        assert.equal(receivedJournal, journal);
        seen.push(receivedJournal);
        const [transaction] = await receivedJournal.listTransactions();
        await receivedJournal.clear(transaction);
        return [{ taskId: transaction.taskId, componentId: transaction.componentId, mode: transaction.mode }];
      },
    },
  });
  assert.deepEqual(recovered, [{ taskId: "task-3", componentId: "chatgpt", mode: "promote" }]);
  assert.equal((await journal.listTransactions()).length, 0);
  assert.equal(seen.length, 1);
});

test("a crash while clearing a cleanup-committed journal remains recoverable and idempotent", async () => {
  const fake = createJournalFs();
  const journal = createTransactionJournal({ journalDir: "D:\\State\\transactions", fsApi: fake.fsApi });
  for (const phase of [
    "prepared", "retiring_moved", "old_moved", "new_promoted", "state_committed", "cleanup_committed",
  ]) {
    await journal.record(record({ phase }));
  }
  fake.failUnlink(3);
  await assert.rejects(journal.clear({ taskId: "task-3", componentId: "chatgpt" }), /journal_clear_crash/u);
  const remaining = await journal.listTransactions();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].records.some((item) => item.phase === "cleanup_committed"), true);
  await journal.clear(remaining[0]);
  assert.deepEqual(await journal.listTransactions(), []);
});

test("journal construction fails closed without stable no-follow direct-child primitives", () => {
  assert.throws(
    () => createTransactionJournal({ journalDir: "D:\\State\\transactions", fsApi: {} }),
    /transaction_journal_no_follow_capability_required/u,
  );
});
