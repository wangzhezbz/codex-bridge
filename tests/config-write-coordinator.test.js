import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createConfigWriteCoordinator as createProductionConfigWriteCoordinator,
} from "../desktop/config-write-coordinator.mjs";

const fsp = fs.promises;

const noOpPrivateAcl = Object.freeze({
  async securePath() {},
});

function createConfigWriteCoordinator(options = {}) {
  return createProductionConfigWriteCoordinator({
    privateAcl: noOpPrivateAcl,
    ...options,
  });
}

function createTransactionTargets(prefix) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(rootDir, "config");
  const codexDir = path.join(rootDir, "home", ".codex");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });

  return [
    path.join(configDir, "model-selection.json"),
    path.join(configDir, "router.config.json"),
    path.join(codexDir, "codexbridge-model-catalog.json"),
    path.join(codexDir, "config.toml"),
  ];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected transaction to reject");
}

function errorSnapshot(error) {
  const properties = Object.fromEntries(
    Object.getOwnPropertyNames(error).map((name) => [name, error[name]]),
  );
  return JSON.stringify(properties);
}

function coordinatorSafetyForTargets(targets) {
  const allowedRoot = path.dirname(path.dirname(targets[0]));
  return {
    allowedRoots: [allowedRoot],
    journalDir: path.join(allowedRoot, ".config-transactions"),
  };
}

function privateStagingDirectoriesForTarget(target) {
  return fs.readdirSync(path.dirname(target), { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory() &&
      entry.name.startsWith(".codexbridge-private-stage."))
    .map((entry) => path.join(path.dirname(target), entry.name));
}

function privateStagingArtifactNamesForTarget(target) {
  return privateStagingDirectoriesForTarget(target).flatMap((directory) =>
    fs.readdirSync(directory));
}

test("configuration is mandatory, idempotent for the same roots, and immutable after first use", async () => {
  const targets = createTransactionTargets("codexbridge-config-coordinator-configure-");
  const safety = coordinatorSafetyForTargets(targets);
  const coordinator = createConfigWriteCoordinator();

  await assert.rejects(
    coordinator.runExclusive(async () => {}),
    (error) => error?.code === "config_write_coordinator_not_configured",
  );
  assert.deepEqual(coordinator.configure(safety), {
    allowedRoots: safety.allowedRoots.map((root) => path.resolve(root)),
    journalDir: path.resolve(safety.journalDir),
  });
  assert.deepEqual(coordinator.configure({
    allowedRoots: [path.join(safety.allowedRoots[0], ".")],
    journalDir: path.join(safety.journalDir, "."),
  }), {
    allowedRoots: safety.allowedRoots.map((root) => path.resolve(root)),
    journalDir: path.resolve(safety.journalDir),
  });
  assert.throws(
    () => coordinator.configure({
      allowedRoots: [path.dirname(safety.allowedRoots[0])],
      journalDir: safety.journalDir,
    }),
    (error) => error?.code === "config_write_coordinator_already_configured",
  );
  await coordinator.runExclusive(async () => {});
});

test("filesystem and drive roots contain their descendants without a doubled-separator false rejection", async () => {
  const driveRoot = path.parse(process.cwd()).root;
  const journalDir = path.join(process.cwd(), ".coordinator-root-fixture");
  const coordinator = createConfigWriteCoordinator({
    allowedRoots: [driveRoot],
    journalDir,
  });
  await coordinator.runExclusive(async () => {});
});

test("rejects transaction targets outside configured roots before creating files", async () => {
  const targets = createTransactionTargets("codexbridge-config-coordinator-root-guard-");
  const safety = coordinatorSafetyForTargets(targets);
  const outsideRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-config-coordinator-outside-"),
  );
  const outsideTarget = path.join(outsideRoot, "must-not-exist.json");
  const coordinator = createConfigWriteCoordinator(safety);

  const error = await captureRejection(coordinator.runTransaction({
    operation: "outside-root",
    prepare: async () => ({
      entries: [
        {
          id: "outside",
          target: outsideTarget,
          content: "secret-must-not-be-written",
          validate: async () => {},
        },
      ],
    }),
  }));

  assert.equal(error.code, "config_transaction_failed");
  assert.equal(error.failurePhase, "planning");
  assert.equal(error.causeCode, "config_write_unsafe_path");
  assert.equal(fs.existsSync(outsideTarget), false);
  assert.equal(fs.existsSync(safety.journalDir), false);
});

test("rejects a target whose in-root parent junction resolves outside the allowed root", async (t) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-config-coordinator-junction-root-"),
  );
  const outsideDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-config-coordinator-junction-outside-"),
  );
  const linkedDir = path.join(rootDir, "linked-config");
  try {
    fs.symlinkSync(outsideDir, linkedDir, "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
      t.skip(`junction creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const target = path.join(linkedDir, "must-not-write.json");
  const coordinator = createConfigWriteCoordinator({
    allowedRoots: [rootDir],
    journalDir: path.join(rootDir, ".transactions"),
  });

  const error = await captureRejection(coordinator.runTransaction({
    operation: "junction-escape",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          content: "must-not-write",
          validate: async () => {},
        },
      ],
    }),
  }));

  assert.equal(error.code, "config_transaction_failed");
  assert.equal(fs.existsSync(path.join(outsideDir, "must-not-write.json")), false);
});

test("rejects a configured allowed root that is itself a junction", async (t) => {
  const anchorDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-config-coordinator-root-junction-anchor-"),
  );
  const physicalRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-config-coordinator-root-junction-physical-"),
  );
  const linkedRoot = path.join(anchorDir, "linked-root");
  try {
    fs.symlinkSync(physicalRoot, linkedRoot, "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
      t.skip(`junction creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const target = path.join(linkedRoot, "config", "target.json");
  const coordinator = createConfigWriteCoordinator({
    allowedRoots: [linkedRoot],
    journalDir: path.join(linkedRoot, ".transactions"),
  });

  const error = await captureRejection(coordinator.runTransaction({
    operation: "linked-root",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          content: "must-not-write",
          validate: async () => {},
        },
      ],
    }),
  }));
  assert.equal(error.code, "config_transaction_failed");
  assert.equal(fs.existsSync(path.join(physicalRoot, "config", "target.json")), false);
});

test("a configured allowed root may be missing until the first transaction creates it", async () => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-config-coordinator-missing-root-"),
  );
  const missingCodexRoot = path.join(rootDir, "empty-home", ".codex");
  const target = path.join(missingCodexRoot, "config.toml");
  const coordinator = createConfigWriteCoordinator({
    allowedRoots: [path.join(rootDir, "project"), missingCodexRoot],
    journalDir: path.join(rootDir, "project", ".transactions"),
  });

  await coordinator.runTransaction({
    operation: "missing-allowed-root",
    prepare: async () => ({
      entries: [
        {
          id: "codex-config",
          target,
          content: "model = \"bridge\"\n",
          validate: async () => {},
        },
      ],
    }),
  });

  assert.equal(fs.readFileSync(target, "utf8"), "model = \"bridge\"\n");
});

test("rejects normalized duplicate targets before staging candidates", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-duplicate-guard-",
  );
  let stagedWrites = 0;
  const coordinator = createConfigWriteCoordinator({
    ...coordinatorSafetyForTargets([target]),
    fileOps: {
      async writeFile(filePath, content, options) {
        stagedWrites += 1;
        await fsp.writeFile(filePath, content, options);
      },
    },
  });
  const alternateSpelling = `${path.dirname(target)}${path.sep}.${path.sep}${path.basename(target)}`;

  const error = await captureRejection(coordinator.runTransaction({
    operation: "duplicate-target",
    prepare: async () => ({
      entries: [target, alternateSpelling].map((entryTarget, index) => ({
        id: `duplicate-${index}`,
        target: entryTarget,
        content: `candidate-${index}`,
        validate: async () => {},
      })),
    }),
  }));

  assert.equal(error.code, "config_transaction_failed");
  assert.equal(stagedWrites, 0);
  assert.equal(fs.existsSync(target), false);
});

test("expected-original CAS preserves an external edit made after candidate validation", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-cas-external-edit-",
  );
  fs.writeFileSync(target, "original");
  const writtenArtifacts = [];
  const coordinator = createConfigWriteCoordinator({
    ...coordinatorSafetyForTargets([target]),
    fileOps: {
      async writeFile(filePath, content, options) {
        writtenArtifacts.push(filePath);
        await fsp.writeFile(filePath, content, options);
      },
    },
  });

  const error = await captureRejection(coordinator.runTransaction({
    operation: "cas-external-edit",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          expectedOriginal: Buffer.from("original"),
          content: "candidate",
          async validate() {
            await fsp.writeFile(target, "external-edit");
          },
        },
      ],
    }),
  }));

  assert.equal(error.code, "config_transaction_failed");
  assert.equal(fs.readFileSync(target, "utf8"), "external-edit");
  for (const artifactPath of writtenArtifacts) {
    assert.equal(fs.existsSync(artifactPath), false, `left transaction artifact ${artifactPath}`);
  }
});

test("CAS preserves an external edit even when its bytes equal the staged candidate", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-cas-same-candidate-",
  );
  fs.writeFileSync(target, "original");
  const safety = coordinatorSafetyForTargets([target]);
  const coordinator = createConfigWriteCoordinator(safety);

  const error = await captureRejection(coordinator.runTransaction({
    operation: "cas-same-candidate",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          expectedOriginal: "original",
          content: "candidate",
          async validate() {
            await fsp.writeFile(target, "candidate");
          },
        },
      ],
    }),
  }));

  assert.equal(error.code, "config_transaction_failed");
  assert.equal(error.rollbackComplete, true);
  assert.equal(fs.readFileSync(target, "utf8"), "candidate");
  assert.deepEqual(fs.readdirSync(safety.journalDir), []);
  assert.deepEqual(
    fs.readdirSync(path.dirname(target)).filter((name) =>
      name.includes(".candidate.") || name.includes(".rollback.")),
    [],
  );
});

test("candidate tampering after validation is detected before rename and leaves the target original", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-candidate-tamper-",
  );
  fs.writeFileSync(target, "original");
  const safety = coordinatorSafetyForTargets([target]);
  const coordinator = createConfigWriteCoordinator(safety);

  const error = await captureRejection(coordinator.runTransaction({
    operation: "candidate-tamper",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          content: "candidate",
          async validate({ tempPath }) {
            await fsp.writeFile(tempPath, "tampered-candidate");
          },
        },
      ],
    }),
  }));

  assert.equal(error.code, "config_transaction_failed");
  assert.equal(error.rollbackComplete, true);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(safety.journalDir), []);
  assert.deepEqual(
    fs.readdirSync(path.dirname(target)).filter((name) =>
      name.includes(".candidate.") || name.includes(".rollback.")),
    [],
  );
});

test("best-effort post-write checking removes staged artifacts after a parent junction swap", async (t) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-config-coordinator-stage-swap-root-"),
  );
  const configDir = path.join(rootDir, "config");
  const movedParent = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-config-coordinator-stage-swap-moved-"),
  );
  const movedConfigDir = path.join(movedParent, "config");
  const target = path.join(configDir, "secret.json");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(target, "original");
  let swapped = false;
  const coordinator = createConfigWriteCoordinator({
    allowedRoots: [rootDir],
    journalDir: path.join(rootDir, ".transactions"),
    fileOps: {
      async writeFile(filePath, content, options) {
        if (!swapped && filePath.includes(".candidate.")) {
          swapped = true;
          fs.renameSync(configDir, movedConfigDir);
          try {
            fs.symlinkSync(movedConfigDir, configDir, "junction");
          } catch (error) {
            if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
              t.skip(`junction creation unavailable: ${error.code}`);
              throw error;
            }
            throw error;
          }
        }
        await fsp.writeFile(filePath, content, options);
      },
    },
  });

  const error = await captureRejection(coordinator.runTransaction({
    operation: "stage-parent-swap",
    prepare: async () => ({
      entries: [
        {
          id: "secret",
          target,
          content: "sk-stage-secret",
          sensitive: true,
          validate: async () => {},
        },
      ],
    }),
  }));

  assert.equal(swapped, true);
  assert.equal(error.code, "config_transaction_failed");
  assert.deepEqual(
    fs.readdirSync(movedConfigDir).filter((name) =>
      name.includes(".candidate.") || name.includes(".rollback.")),
    [],
  );
  assert.equal(fs.readFileSync(path.join(movedConfigDir, "secret.json"), "utf8"), "original");
});

test("expected-original SHA-256 mismatch rejects before staging any private artifact", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-cas-hash-",
  );
  fs.writeFileSync(target, "current");
  let writes = 0;
  const coordinator = createConfigWriteCoordinator({
    ...coordinatorSafetyForTargets([target]),
    fileOps: {
      async writeFile(filePath, content, options) {
        writes += 1;
        await fsp.writeFile(filePath, content, options);
      },
    },
  });
  const staleHash = createHash("sha256").update("stale").digest("hex");

  const error = await captureRejection(coordinator.runTransaction({
    operation: "cas-hash-mismatch",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          expectedOriginal: { exists: true, sha256: staleHash },
          content: "candidate",
          validate: async () => {},
        },
      ],
    }),
  }));

  assert.equal(error.code, "config_transaction_failed");
  assert.equal(writes, 0);
  assert.equal(fs.readFileSync(target, "utf8"), "current");
  assert.equal(fs.existsSync(coordinatorSafetyForTargets([target]).journalDir), false);
});

test("skips candidate and commit writes for an unchanged entry while still validating it", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-unchanged-",
  );
  fs.writeFileSync(target, "unchanged");
  let candidateWrites = 0;
  let candidateRenames = 0;
  let validateCalls = 0;
  const coordinator = createConfigWriteCoordinator({
    ...coordinatorSafetyForTargets([target]),
    fileOps: {
      async writeFile(filePath, content, options) {
        if (filePath.includes(".candidate.")) {
          candidateWrites += 1;
        }
        await fsp.writeFile(filePath, content, options);
      },
      async rename(from, to) {
        if (from.includes(".candidate.")) {
          candidateRenames += 1;
        }
        await fsp.rename(from, to);
      },
    },
  });

  const result = await coordinator.runTransaction({
    operation: "unchanged",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          content: "unchanged",
          async validate(context) {
            validateCalls += 1;
            assert.equal(context.unchanged, true);
            assert.equal(context.tempPath, null);
          },
        },
      ],
      value: "same",
    }),
  });

  assert.deepEqual(result, { configRevision: result.configRevision, value: "same" });
  assert.equal(validateCalls, 1);
  assert.equal(candidateWrites, 0);
  assert.equal(candidateRenames, 0);
  assert.equal(fs.readFileSync(target, "utf8"), "unchanged");
});

test("writes four same-directory candidates, validates all of them, then commits and returns the revision", async () => {
  const targets = createTransactionTargets("codexbridge-config-coordinator-success-");
  targets.forEach((target, index) => fs.writeFileSync(target, `old-${index}`));

  const events = [];
  const candidateTemps = [];
  const candidateByTarget = new Map();
  const fileOps = {
    async writeFile(filePath, content) {
      if (filePath.includes(".candidate.")) {
        candidateTemps.push(filePath);
        events.push({ type: "write", filePath });
      }
      await fsp.writeFile(filePath, content);
    },
    async rename(from, to) {
      if (from.includes(".candidate.")) {
        events.push({ type: "rename", from, to });
        assert.equal(path.dirname(path.dirname(from)), path.dirname(to));
        assert.match(
          path.basename(path.dirname(from)),
          /^\.codexbridge-private-stage\./u,
        );
      }
      await fsp.rename(from, to);
    },
  };
  const coordinator = createConfigWriteCoordinator({
    ...coordinatorSafetyForTargets(targets),
    fileOps,
    nextRevision: () => "revision-success",
  });

  const result = await coordinator.runTransaction({
    operation: "mode:select",
    async prepare({ configRevision }) {
      assert.equal(configRevision, "revision-success");
      const entries = targets.map((target, index) => {
        const id = `target-${index}`;
        const content = Buffer.from(`candidate-${index}-${configRevision}`);
        candidateByTarget.set(target, content);
        return {
          id,
          target,
          content,
          async validate(context) {
            events.push({ type: "validate", id });
            assert.equal(context.id, id);
            assert.equal(context.target, target);
            assert.equal(context.configRevision, configRevision);
            assert.equal(
              path.dirname(path.dirname(context.tempPath)),
              path.dirname(target),
            );
            assert.match(
              path.basename(path.dirname(context.tempPath)),
              /^\.codexbridge-private-stage\./u,
            );
            assert.deepEqual(await fsp.readFile(context.tempPath), content);
          },
        };
      });
      return { entries, value: { mode: "all_api" } };
    },
    async verifyCommitted({ configRevision, entries, value }) {
      events.push({ type: "verify" });
      assert.equal(configRevision, "revision-success");
      assert.deepEqual(value, { mode: "all_api" });
      assert.deepEqual(
        entries.map(({ id, target }) => ({ id, target })),
        targets.map((target, index) => ({ id: `target-${index}`, target })),
      );
      for (const target of targets) {
        assert.deepEqual(await fsp.readFile(target), candidateByTarget.get(target));
      }
    },
  });

  assert.deepEqual(result, {
    configRevision: "revision-success",
    value: { mode: "all_api" },
  });
  assert.equal(candidateTemps.length, 4);
  assert.equal(new Set(candidateTemps).size, 4);

  const eventTypes = events.map(({ type }) => type);
  const writeIndexes = eventTypes.flatMap((type, index) => (type === "write" ? [index] : []));
  const validateIndexes = eventTypes.flatMap((type, index) =>
    type === "validate" ? [index] : [],
  );
  const renameIndexes = eventTypes.flatMap((type, index) => (type === "rename" ? [index] : []));
  assert.equal(Math.max(...writeIndexes) < Math.min(...validateIndexes), true);
  assert.equal(Math.max(...validateIndexes) < Math.min(...renameIndexes), true);
  assert.equal(Math.max(...renameIndexes) < eventTypes.indexOf("verify"), true);
});

test("creates each unique missing target parent recursively so an empty home needs no auth.json", async () => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-config-coordinator-empty-home-"),
  );
  const configDir = path.join(rootDir, "config");
  const codexDir = path.join(rootDir, "empty-home", ".codex");
  const targets = [
    path.join(configDir, "model-selection.json"),
    path.join(configDir, "router.config.json"),
    path.join(codexDir, "codexbridge-model-catalog.json"),
    path.join(codexDir, "config.toml"),
  ];
  const mkdirCalls = [];
  const coordinator = createConfigWriteCoordinator({
    ...coordinatorSafetyForTargets(targets),
    fileOps: {
      async mkdir(directory, options) {
        mkdirCalls.push({ directory, options });
        await fsp.mkdir(directory, options);
      },
    },
    nextRevision: () => "revision-empty-home",
  });

  const result = await coordinator.runTransaction({
    operation: "mode:select",
    prepare: async () => ({
      entries: targets.map((target, index) => ({
        id: `target-${index}`,
        target,
        content: `candidate-${index}`,
        async validate({ tempPath }) {
          assert.equal(fs.existsSync(tempPath), true);
        },
      })),
      value: { mode: "all_api" },
    }),
    async verifyCommitted() {
      targets.forEach((target, index) => {
        assert.equal(fs.readFileSync(target, "utf8"), `candidate-${index}`);
      });
    },
  });

  assert.deepEqual(result, {
    configRevision: "revision-empty-home",
    value: { mode: "all_api" },
  });
  assert.deepEqual(mkdirCalls.slice(0, 3), [
    { directory: configDir, options: { recursive: true } },
    { directory: codexDir, options: { recursive: true } },
    {
      directory: coordinatorSafetyForTargets(targets).journalDir,
      options: { mode: 0o700, recursive: true },
    },
  ]);
  assert.equal(mkdirCalls.length, 5);
  const stagingMkdirCalls = mkdirCalls.slice(3);
  assert.deepEqual(
    stagingMkdirCalls.map(({ options }) => options),
    [{ mode: 0o700 }, { mode: 0o700 }],
  );
  assert.deepEqual(
    new Set(stagingMkdirCalls.map(({ directory }) => path.dirname(directory))),
    new Set([configDir, codexDir]),
  );
  stagingMkdirCalls.forEach(({ directory }) => {
    assert.match(path.basename(directory), /^\.codexbridge-private-stage\./u);
  });
  assert.equal(fs.existsSync(path.join(codexDir, "auth.json")), false);
});

test("a last-target rename failure restores bytes, explicitly removes a new target, and cleans known artifacts", async () => {
  const targets = createTransactionTargets("codexbridge-config-coordinator-rename-failure-");
  const originalBytes = [
    null,
    Buffer.from([0, 255, 1, 2, 3]),
    Buffer.from("old-catalog\r\n", "utf8"),
    Buffer.from("old-toml\n", "utf8"),
  ];
  for (let index = 1; index < targets.length; index += 1) {
    fs.writeFileSync(targets[index], originalBytes[index]);
  }

  const writtenArtifacts = [];
  const candidateTemps = new Set();
  const unlinkCalls = [];
  let injected = false;
  const fileOps = {
    async writeFile(filePath, content) {
      writtenArtifacts.push(filePath);
      if (filePath.includes(".candidate.")) {
        candidateTemps.add(filePath);
      }
      await fsp.writeFile(filePath, content);
    },
    async rename(from, to) {
      if (!injected && to === targets.at(-1) && candidateTemps.has(from)) {
        injected = true;
        const error = new Error("injected last commit failure with sensitive detail");
        error.code = "EACCES";
        throw error;
      }
      await fsp.rename(from, to);
    },
    async unlink(filePath) {
      unlinkCalls.push(filePath);
      await fsp.unlink(filePath);
    },
  };
  const coordinator = createConfigWriteCoordinator({
    ...coordinatorSafetyForTargets(targets),
    fileOps,
    nextRevision: () => "draft-rename-failure",
  });

  const error = await captureRejection(
    coordinator.runTransaction({
      operation: "mode:select",
      prepare: async () => ({
        entries: targets.map((target, index) => ({
          id: `target-${index}`,
          target,
          content: Buffer.from(`new-${index}`),
          validate: async () => {},
        })),
        value: { mode: "all_api" },
      }),
    }),
  );

  assert.equal(injected, true);
  assert.equal(error.code, "config_transaction_failed");
  assert.equal(error.failurePhase, "commit");
  assert.equal(error.causeCode, "eacces");
  assert.equal(error.rollbackComplete, true);
  assert.deepEqual(error.rollbackErrors, []);
  assert.equal(fs.existsSync(targets[0]), false);
  assert.equal(unlinkCalls.includes(targets[0]), true);
  for (let index = 1; index < targets.length; index += 1) {
    assert.deepEqual(fs.readFileSync(targets[index]), originalBytes[index]);
  }
  for (const artifactPath of writtenArtifacts) {
    assert.equal(fs.existsSync(artifactPath), false, `left transaction artifact ${artifactPath}`);
  }
});

test("candidate-write and post-rename chmod failures both restore cleanly and leave the queue usable", async (t) => {
  for (const phase of ["candidate_write", "target_chmod"]) {
    await t.test(phase, async () => {
      const [target] = createTransactionTargets(
        `codexbridge-config-coordinator-${phase}-`,
      );
      fs.writeFileSync(target, "original");
      const safety = coordinatorSafetyForTargets([target]);
      let inject = true;
      const coordinator = createConfigWriteCoordinator({
        ...safety,
        fileOps: {
          async chmod(filePath, mode) {
            if (inject && phase === "target_chmod" && filePath === target) {
              inject = false;
              const error = new Error("injected target chmod failure");
              error.code = "EACCES";
              throw error;
            }
            await fsp.chmod(filePath, mode);
          },
          async writeFile(filePath, content, options) {
            if (
              inject &&
              phase === "candidate_write" &&
              filePath.includes(".candidate.")
            ) {
              inject = false;
              const error = new Error("injected candidate write failure");
              error.code = "ENOSPC";
              throw error;
            }
            await fsp.writeFile(filePath, content, options);
          },
        },
      });

      const error = await captureRejection(coordinator.runTransaction({
        operation: phase,
        prepare: async () => ({
          entries: [
            {
              id: "target",
              target,
              content: "candidate",
              validate: async () => {},
            },
          ],
        }),
      }));
      assert.equal(error.rollbackComplete, true);
      assert.equal(fs.readFileSync(target, "utf8"), "original");
      assert.deepEqual(fs.readdirSync(safety.journalDir), []);
      assert.deepEqual(
        fs.readdirSync(path.dirname(target)).filter((name) =>
          name.includes(".candidate.") || name.includes(".rollback.")),
        [],
      );

      await coordinator.runTransaction({
        operation: `${phase}:retry`,
        prepare: async () => ({
          entries: [
            {
              id: "target",
              target,
              content: "final",
              validate: async () => {},
            },
          ],
        }),
      });
      assert.equal(fs.readFileSync(target, "utf8"), "final");
    });
  }
});

test("post-commit external tampering fails closed and preserves a recovery copy without overwriting it", async () => {
  const targets = createTransactionTargets("codexbridge-config-coordinator-byte-mismatch-");
  const originalBytes = [
    Buffer.from("old-selection\r\n", "utf8"),
    Buffer.from([0, 255, 12, 13, 10]),
    Buffer.from("old-catalog\n", "utf8"),
    Buffer.from("old-toml\r\n", "utf8"),
  ];
  targets.forEach((target, index) => fs.writeFileSync(target, originalBytes[index]));

  const draftRevision = "draft-byte-mismatch-must-not-escape";
  const candidateRouter = `${JSON.stringify({
    mode: "all_api",
    configRevision: draftRevision,
    note: "事务模式",
    routes: [{ modelId: "same-model-id" }],
  })}\n`;
  const tamperedRouter = `${JSON.stringify({
    mode: "hybrid",
    configRevision: "stale-revision",
    note: "事务模式",
    routes: [{ modelId: "same-model-id" }],
  })}\n`;
  assert.deepEqual(
    JSON.parse(candidateRouter).routes.map(({ modelId }) => modelId),
    JSON.parse(tamperedRouter).routes.map(({ modelId }) => modelId),
  );

  const candidateContents = [
    Buffer.from('{"mode":"all_api","selectedModelIds":["same-model-id"]}\n'),
    candidateRouter,
    Buffer.from('{"models":[{"slug":"same-model-id"}]}\n'),
    'requires_openai_auth = false\nAuthorization = "Bearer sk-local-codex-router"\n',
  ];
  const writtenArtifacts = [];
  const candidateTemps = new Set();
  let tampered = false;
  let verifyCommittedCalls = 0;
  const fileOps = {
    async writeFile(filePath, content, options) {
      writtenArtifacts.push(filePath);
      if (filePath.includes(".candidate.")) {
        candidateTemps.add(filePath);
      }
      await fsp.writeFile(filePath, content, options);
    },
    async rename(from, to) {
      await fsp.rename(from, to);
      if (!tampered && to === targets.at(-1) && candidateTemps.has(from)) {
        tampered = true;
        await fsp.writeFile(targets[1], tamperedRouter);
      }
    },
  };
  const coordinator = createConfigWriteCoordinator({
    ...coordinatorSafetyForTargets(targets),
    fileOps,
    nextRevision: () => draftRevision,
  });

  let error;
  try {
    await coordinator.runTransaction({
      operation: "mode:select",
      prepare: async () => ({
        entries: targets.map((target, index) => ({
          id: `target-${index}`,
          target,
          content: candidateContents[index],
          validate: async () => {},
        })),
        value: { configRevision: draftRevision, mode: "all_api" },
      }),
      async verifyCommitted() {
        verifyCommittedCalls += 1;
      },
    });
  } catch (caught) {
    error = caught;
  }

  assert.equal(tampered, true);
  assert.equal(verifyCommittedCalls, 0);
  assert.ok(error, "expected byte mismatch to reject the transaction");
  assert.equal(error.code, "config_transaction_failed");
  assert.equal(error.rollbackComplete, false);
  assert.equal(typeof error.recoveryId, "string");
  assert.equal(
    error.rollbackErrors.some(({ stage, entryIndex }) =>
      stage === "conflict" && entryIndex === 1),
    true,
  );
  assert.equal(error.configRevision, undefined);
  assert.equal(error.value, undefined);
  assert.doesNotMatch(errorSnapshot(error), new RegExp(draftRevision));
  assert.deepEqual(fs.readFileSync(targets[1]), Buffer.from(tamperedRouter));
  [0, 2, 3].forEach((index) => {
    assert.deepEqual(fs.readFileSync(targets[index]), originalBytes[index]);
  });
  const retainedPaths = writtenArtifacts.filter((artifactPath) => fs.existsSync(artifactPath));
  assert.equal(retainedPaths.some((artifactPath) => artifactPath.includes(".rollback.")), true);
  assert.equal(retainedPaths.some((artifactPath) => artifactPath.endsWith(".journal.json")), true);
  for (const retainedPath of retainedPaths) {
    assert.doesNotMatch(fs.readFileSync(retainedPath, "utf8"), /draft-byte-mismatch-must-not-escape/);
  }
});

test("verifyCommitted failure rolls every target back without exposing draft revision, value, or logs", async () => {
  const targets = createTransactionTargets("codexbridge-config-coordinator-verify-failure-");
  const originals = targets.map((target, index) => Buffer.from(`original-${index}`));
  targets.forEach((target, index) => fs.writeFileSync(target, originals[index]));

  const draftRevision = "draft-must-not-escape";
  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logged.push(args);
  console.error = (...args) => logged.push(args);

  let error;
  try {
    const coordinator = createConfigWriteCoordinator({
      ...coordinatorSafetyForTargets(targets),
      nextRevision: () => draftRevision,
    });
    error = await captureRejection(
      coordinator.runTransaction({
        operation: "mode:select",
        async prepare({ configRevision }) {
          return {
            entries: targets.map((target, index) => ({
              id: `target-${index}`,
              target,
              content: Buffer.from(`candidate-${index}-${configRevision}`),
              validate: async () => {},
            })),
            value: { configRevision, unpublished: true },
          };
        },
        async verifyCommitted({ configRevision }) {
          for (let index = 0; index < targets.length; index += 1) {
            assert.equal(
              fs.readFileSync(targets[index], "utf8"),
              `candidate-${index}-${configRevision}`,
            );
          }
          throw new Error(`health mismatch for ${configRevision}`);
        },
      }),
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(error.code, "config_transaction_failed");
  assert.equal(error.rollbackComplete, true);
  assert.deepEqual(error.rollbackErrors, []);
  assert.equal(error.configRevision, undefined);
  assert.equal(error.value, undefined);
  assert.doesNotMatch(errorSnapshot(error), new RegExp(draftRevision));
  assert.doesNotMatch(JSON.stringify(logged), new RegExp(draftRevision));
  targets.forEach((target, index) => {
    assert.deepEqual(fs.readFileSync(target), originals[index]);
  });
});

test("an external edit during verifyCommitted prevents success and is preserved as a recovery conflict", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-verify-external-edit-",
  );
  fs.writeFileSync(target, "original");
  const safety = coordinatorSafetyForTargets([target]);
  const coordinator = createConfigWriteCoordinator(safety);

  const error = await captureRejection(coordinator.runTransaction({
    operation: "verify-external-edit",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          content: "candidate",
          validate: async () => {},
        },
      ],
    }),
    async verifyCommitted() {
      await fsp.writeFile(target, "external-during-verify");
    },
  }));

  assert.equal(error.code, "config_transaction_failed");
  assert.equal(error.rollbackComplete, false);
  assert.equal(typeof error.recoveryId, "string");
  assert.equal(fs.readFileSync(target, "utf8"), "external-during-verify");
  assert.equal(
    fs.readdirSync(safety.journalDir).filter((name) => name.endsWith(".journal.json")).length,
    1,
  );
});

test("two concurrent transactions run strictly serially without interleaving prepare, validate, or verify", async () => {
  const [target] = createTransactionTargets("codexbridge-config-coordinator-serial-");
  fs.writeFileSync(target, "initial");

  const firstEntered = deferred();
  const releaseFirst = deferred();
  const events = [];
  let revisionIndex = 0;
  const coordinator = createConfigWriteCoordinator({
    ...coordinatorSafetyForTargets([target]),
    nextRevision: () => `revision-${++revisionIndex}`,
  });

  function run(label, waitInPrepare = false) {
    return coordinator.runTransaction({
      operation: label,
      async prepare({ configRevision }) {
        events.push(`prepare:${label}`);
        if (waitInPrepare) {
          firstEntered.resolve();
          await releaseFirst.promise;
        }
        return {
          entries: [
            {
              id: label,
              target,
              content: `${label}:${configRevision}`,
              async validate() {
                events.push(`validate:${label}`);
              },
            },
          ],
          value: label,
        };
      },
      async verifyCommitted() {
        events.push(`verify:${label}`);
      },
    });
  }

  const first = run("first", true);
  const second = run("second");
  await firstEntered.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["prepare:first"]);

  releaseFirst.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(events, [
    "prepare:first",
    "validate:first",
    "verify:first",
    "prepare:second",
    "validate:second",
    "verify:second",
  ]);
  assert.deepEqual(firstResult, { configRevision: "revision-1", value: "first" });
  assert.deepEqual(secondResult, { configRevision: "revision-2", value: "second" });
  assert.equal(fs.readFileSync(target, "utf8"), "second:revision-2");
});

test("runExclusive shares the transaction FIFO and nested exclusive work does not deadlock", async () => {
  const [target] = createTransactionTargets("codexbridge-config-coordinator-exclusive-");
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const events = [];
  const coordinator = createConfigWriteCoordinator({
    ...coordinatorSafetyForTargets([target]),
    nextRevision: () => "revision-exclusive",
  });

  const first = coordinator.runExclusive(async () => {
    events.push("exclusive:first:start");
    firstEntered.resolve();
    await releaseFirst.promise;
    await coordinator.runExclusive(async () => {
      events.push("exclusive:nested");
    });
    events.push("exclusive:first:end");
  });
  const transaction = coordinator.runTransaction({
    operation: "queued-transaction",
    prepare: async () => {
      events.push("transaction:prepare");
      return {
        entries: [
          {
            id: "target",
            target,
            content: "committed",
            validate: async () => {},
          },
        ],
      };
    },
  });
  const last = coordinator.runExclusive(async () => {
    events.push("exclusive:last");
  });

  await firstEntered.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["exclusive:first:start"]);
  releaseFirst.resolve();
  await Promise.all([first, transaction, last]);

  assert.deepEqual(events, [
    "exclusive:first:start",
    "exclusive:nested",
    "exclusive:first:end",
    "transaction:prepare",
    "exclusive:last",
  ]);
  assert.equal(fs.readFileSync(target, "utf8"), "committed");
});

test("detached work inheriting an expired exclusive context re-enters the FIFO instead of bypassing it", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-expired-context-",
  );
  const coordinator = createConfigWriteCoordinator(
    coordinatorSafetyForTargets([target]),
  );
  const triggerDetached = deferred();
  const detachedWaiting = deferred();
  const detachedEntered = deferred();
  const blockerEntered = deferred();
  const releaseBlocker = deferred();
  const events = [];
  let detachedDone;

  await coordinator.runExclusive(async () => {
    detachedDone = new Promise((resolve, reject) => {
      setTimeout(async () => {
        detachedWaiting.resolve();
        try {
          await triggerDetached.promise;
          await coordinator.runExclusive(async () => {
            events.push("detached");
            detachedEntered.resolve();
          });
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 0);
    });
  });
  await detachedWaiting.promise;
  const blocker = coordinator.runExclusive(async () => {
    events.push("blocker:start");
    blockerEntered.resolve();
    await releaseBlocker.promise;
    events.push("blocker:end");
  });
  await blockerEntered.promise;
  triggerDetached.resolve();
  const bypassed = await Promise.race([
    detachedEntered.promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  assert.equal(bypassed, false);
  assert.deepEqual(events, ["blocker:start"]);

  releaseBlocker.resolve();
  await Promise.all([blocker, detachedDone]);
  assert.deepEqual(events, ["blocker:start", "blocker:end", "detached"]);
});

test("an unawaited nested exclusive rejection is retained until the outer lease reports it", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-nested-rejection-",
  );
  const coordinator = createConfigWriteCoordinator(
    coordinatorSafetyForTargets([target]),
  );
  const error = await captureRejection(coordinator.runExclusive(async () => {
    void coordinator.runExclusive(async () => {
      const nestedError = new Error("nested failure");
      nestedError.code = "ENESTED";
      throw nestedError;
    });
    await new Promise((resolve) => setImmediate(resolve));
  }));

  assert.equal(error.code, "ENESTED");
  await coordinator.runExclusive(async () => {});
});

test("rejects a transaction nested inside runExclusive without breaking the FIFO", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-nested-transaction-",
  );
  const coordinator = createConfigWriteCoordinator({
    ...coordinatorSafetyForTargets([target]),
    nextRevision: () => "nested-revision",
  });

  const error = await captureRejection(coordinator.runExclusive(async () =>
    coordinator.runTransaction({
      operation: "nested",
      prepare: async () => ({
        entries: [
          {
            id: "target",
            target,
            content: "must-not-commit",
            validate: async () => {},
          },
        ],
      }),
    })));

  assert.equal(error.code, "config_write_nested_transaction");
  assert.equal(fs.existsSync(target), false);
  await coordinator.runExclusive(async () => {
    fs.writeFileSync(target, "queue-continued");
  });
  assert.equal(fs.readFileSync(target, "utf8"), "queue-continued");
});

test("runExclusive nested inside a transaction reuses the active lease without recovering its own journal", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-transaction-exclusive-",
  );
  fs.writeFileSync(target, "original");
  const coordinator = createConfigWriteCoordinator(
    coordinatorSafetyForTargets([target]),
  );
  const events = [];

  await coordinator.runTransaction({
    operation: "transaction-with-exclusive-helper",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          content: "candidate",
          async validate() {
            await coordinator.runExclusive(async () => {
              events.push("exclusive-helper");
            });
          },
        },
      ],
    }),
  });

  assert.deepEqual(events, ["exclusive-helper"]);
  assert.equal(fs.readFileSync(target, "utf8"), "candidate");
});

test("recovery nested inside a transaction is rejected explicitly without scanning its active journal", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-transaction-recovery-",
  );
  fs.writeFileSync(target, "original");
  const coordinator = createConfigWriteCoordinator(
    coordinatorSafetyForTargets([target]),
  );

  await coordinator.runTransaction({
    operation: "transaction-with-recovery-helper",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          content: "candidate",
          async validate() {
            await assert.rejects(
              coordinator.recoverPendingTransactions(),
              (error) => error?.code === "config_write_nested_recovery",
            );
          },
        },
      ],
    }),
  });

  assert.equal(fs.readFileSync(target, "utf8"), "candidate");
});

test("a new process recovers a hard kill after every commit position without journal secret leakage", async () => {
  const moduleUrl = new URL("../desktop/config-write-coordinator.mjs", import.meta.url).href;
  const workerSource = String.raw`
    import fs from "node:fs";
    const { createConfigWriteCoordinator } = await import(process.env.COORDINATOR_MODULE_URL);
    const rootDir = process.env.TRANSACTION_ROOT;
    const journalDir = process.env.TRANSACTION_JOURNAL_DIR;
    const targets = JSON.parse(process.env.TRANSACTION_TARGETS);
    const killAfter = Number(process.env.TRANSACTION_KILL_AFTER);
    let commitCount = 0;
    const coordinator = createConfigWriteCoordinator({
      allowedRoots: [rootDir],
      journalDir,
      nextRevision: () => "crash-revision",
      fileOps: {
        async rename(from, to) {
          await fs.promises.rename(from, to);
          if (from.includes(".candidate.")) {
            commitCount += 1;
            if (commitCount === killAfter) {
              process.exit(91);
            }
          }
        },
      },
    });
    await coordinator.runTransaction({
      operation: "child-crash",
      prepare: async () => ({
        entries: targets.map((target, index) => ({
          id: "target-" + index,
          target,
          content: "candidate-" + index + "-sk-super-secret-child",
          sensitive: index === 0,
          validate: async () => {},
        })),
      }),
    });
  `;

  for (let killAfter = 1; killAfter <= 4; killAfter += 1) {
    const rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `codexbridge-config-coordinator-crash-${killAfter}-`),
    );
    const configDir = path.join(rootDir, "config");
    const journalDir = path.join(rootDir, ".transactions");
    fs.mkdirSync(configDir, { recursive: true });
    const targets = Array.from({ length: 4 }, (_, index) =>
      path.join(configDir, `target-${index}.json`));
    const originals = targets.map((target, index) => Buffer.from(`original-${index}`));
    targets.forEach((target, index) => fs.writeFileSync(target, originals[index]));

    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", workerSource],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          COORDINATOR_MODULE_URL: moduleUrl,
          TRANSACTION_ROOT: rootDir,
          TRANSACTION_JOURNAL_DIR: journalDir,
          TRANSACTION_TARGETS: JSON.stringify(targets),
          TRANSACTION_KILL_AFTER: String(killAfter),
        },
      },
    );
    assert.equal(child.status, 91, child.stderr || child.stdout);

    const journalFiles = fs.existsSync(journalDir)
      ? fs.readdirSync(journalDir).filter((name) => name.endsWith(".journal.json"))
      : [];
    assert.equal(journalFiles.length, 1);
    const journalText = fs.readFileSync(path.join(journalDir, journalFiles[0]), "utf8");
    assert.doesNotMatch(journalText, /sk-super-secret-child/);
    assert.doesNotMatch(journalText, /candidate-\d-/);

    const recoveryCoordinator = createConfigWriteCoordinator({
      allowedRoots: [rootDir],
      journalDir,
    });
    const recovery = await recoveryCoordinator.recoverPendingTransactions();
    assert.deepEqual(recovery, { recovered: 1, cleaned: 0, pending: [] });
    targets.forEach((target, index) => {
      assert.deepEqual(fs.readFileSync(target), originals[index]);
    });
    assert.deepEqual(fs.readdirSync(journalDir), []);
    const remainingArtifacts = fs.readdirSync(configDir).filter((name) =>
      name.includes(".candidate.") || name.includes(".rollback."));
    assert.deepEqual(remainingArtifacts, []);
  }
});

test("a hard kill after verification keeps the committed target and only cleans complete-journal artifacts", async () => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-config-coordinator-complete-crash-"),
  );
  const configDir = path.join(rootDir, "config");
  const journalDir = path.join(rootDir, ".transactions");
  const target = path.join(configDir, "target.json");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(target, "original");
  const moduleUrl = new URL("../desktop/config-write-coordinator.mjs", import.meta.url).href;
  const workerSource = String.raw`
    import fs from "node:fs";
    const { createConfigWriteCoordinator } = await import(process.env.COORDINATOR_MODULE_URL);
    const coordinator = createConfigWriteCoordinator({
      allowedRoots: [process.env.TRANSACTION_ROOT],
      journalDir: process.env.TRANSACTION_JOURNAL_DIR,
      fileOps: {
        async unlink(filePath) {
          if (filePath.includes(".rollback.")) {
            process.exit(92);
          }
          await fs.promises.unlink(filePath);
        },
      },
    });
    await coordinator.runTransaction({
      operation: "complete-crash",
      prepare: async () => ({
        entries: [{
          id: "target",
          target: process.env.TRANSACTION_TARGET,
          content: "committed-sk-complete-secret",
          sensitive: true,
          validate: async () => {},
        }],
      }),
    });
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", workerSource],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        COORDINATOR_MODULE_URL: moduleUrl,
        TRANSACTION_ROOT: rootDir,
        TRANSACTION_JOURNAL_DIR: journalDir,
        TRANSACTION_TARGET: target,
      },
    },
  );
  assert.equal(child.status, 92, child.stderr || child.stdout);
  assert.equal(fs.readFileSync(target, "utf8"), "committed-sk-complete-secret");
  const journalFiles = fs.readdirSync(journalDir)
    .filter((name) => name.endsWith(".journal.json"));
  assert.equal(journalFiles.length, 1);
  const journalText = fs.readFileSync(path.join(journalDir, journalFiles[0]), "utf8");
  assert.match(journalText, /"stage": "complete"/);
  assert.doesNotMatch(journalText, /sk-complete-secret/);

  const coordinator = createConfigWriteCoordinator({
    allowedRoots: [rootDir],
    journalDir,
  });
  assert.deepEqual(await coordinator.recoverPendingTransactions(), {
    recovered: 0,
    cleaned: 1,
    pending: [],
  });
  assert.equal(fs.readFileSync(target, "utf8"), "committed-sk-complete-secret");
  assert.deepEqual(fs.readdirSync(journalDir), []);
});

test("recovery fails closed on a journal that points outside allowed roots", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-malicious-journal-",
  );
  const safety = coordinatorSafetyForTargets([target]);
  fs.mkdirSync(safety.journalDir, { recursive: true });
  const outsideRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-config-coordinator-malicious-outside-"),
  );
  const outsideTarget = path.join(outsideRoot, "sentinel.json");
  fs.writeFileSync(outsideTarget, "sentinel");
  const transactionId = "12345678-1234-1234-1234-123456789abc";
  const journalPath = path.join(
    safety.journalDir,
    `.codexbridge-config-transaction.${transactionId}.journal.json`,
  );
  fs.writeFileSync(journalPath, `${JSON.stringify({
    version: 1,
    transactionId,
    stage: "planning",
    entries: [
      {
        index: 0,
        target: outsideTarget,
        candidatePath: path.join(outsideRoot, ".sentinel.candidate.tmp"),
        rollbackPath: path.join(outsideRoot, ".sentinel.rollback.tmp"),
        existed: true,
        changed: true,
        originalSha256: "0".repeat(64),
        candidateSha256: "1".repeat(64),
        originalMode: 0o644,
        targetMode: 0o644,
        state: "pending",
      },
    ],
  })}\n`, { mode: 0o600 });
  const coordinator = createConfigWriteCoordinator(safety);

  await assert.rejects(
    coordinator.recoverPendingTransactions(),
    (error) =>
      error?.code === "config_recovery_incomplete" &&
      error.pending?.[0]?.recoveryId === transactionId,
  );
  assert.equal(fs.readFileSync(outsideTarget, "utf8"), "sentinel");
  assert.equal(fs.existsSync(journalPath), true);
  await assert.rejects(
    coordinator.runExclusive(async () => assert.fail("must not run")),
    (error) => error?.code === "config_recovery_incomplete",
  );
  let prepareCalls = 0;
  await assert.rejects(
    coordinator.runTransaction({
      operation: "must-not-mask-recovery",
      prepare: async () => {
        prepareCalls += 1;
        return { entries: [] };
      },
    }),
    (error) =>
      error?.code === "config_recovery_incomplete" &&
      error.pending?.[0]?.recoveryId === transactionId,
  );
  assert.equal(prepareCalls, 0);
});

test("recovery rejects a journal source symlink before it can drive in-root mutations", async (t) => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-journal-symlink-",
  );
  fs.writeFileSync(target, "candidate");
  const safety = coordinatorSafetyForTargets([target]);
  fs.mkdirSync(safety.journalDir, { recursive: true });
  const transactionId = "deadbeef-1234-1234-1234-deadbeef1234";
  const outsideDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-config-coordinator-journal-source-"),
  );
  const outsideJournal = path.join(outsideDir, "outside.json");
  const journalPath = path.join(
    safety.journalDir,
    `.codexbridge-config-transaction.${transactionId}.journal.json`,
  );
  fs.writeFileSync(outsideJournal, `${JSON.stringify({
    version: 1,
    transactionId,
    stage: "committing",
    entries: [
      {
        index: 0,
        target,
        candidatePath: path.join(
          path.dirname(target),
          `.${path.basename(target)}.candidate.${transactionId}.0.tmp`,
        ),
        rollbackPath: null,
        existed: false,
        changed: true,
        originalSha256: null,
        candidateSha256: createHash("sha256").update("candidate").digest("hex"),
        originalMode: null,
        targetMode: 0o644,
        state: "committed",
      },
    ],
  })}\n`, { mode: 0o600 });
  try {
    fs.symlinkSync(outsideJournal, journalPath, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
      t.skip(`file symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const coordinator = createConfigWriteCoordinator(safety);

  await assert.rejects(
    coordinator.recoverPendingTransactions(),
    (error) => error?.code === "config_recovery_incomplete",
  );
  assert.equal(fs.readFileSync(target, "utf8"), "candidate");
  assert.equal(fs.existsSync(journalPath), true);
});

test("recovery tightens an existing journal directory and rejects oversized journal input", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-journal-size-",
  );
  const safety = coordinatorSafetyForTargets([target]);
  fs.mkdirSync(safety.journalDir, { recursive: true, mode: 0o777 });
  fs.chmodSync(safety.journalDir, 0o777);
  const transactionId = "baadf00d-1234-1234-1234-baadf00d1234";
  const journalPath = path.join(
    safety.journalDir,
    `.codexbridge-config-transaction.${transactionId}.journal.json`,
  );
  fs.writeFileSync(journalPath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20), {
    mode: 0o600,
  });
  const chmodCalls = [];
  const coordinator = createConfigWriteCoordinator({
    ...safety,
    fileOps: {
      async chmod(filePath, mode) {
        chmodCalls.push({ filePath, mode });
        await fsp.chmod(filePath, mode);
      },
    },
  });

  await assert.rejects(
    coordinator.recoverPendingTransactions(),
    (error) => error?.code === "config_recovery_incomplete",
  );
  assert.equal(
    chmodCalls.some(({ filePath, mode }) =>
      filePath === safety.journalDir && mode === 0o700),
    true,
  );
  assert.equal(fs.existsSync(journalPath), true);
});

test("recovery does not follow an in-root junction to clean artifacts outside the physical root", async (t) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-config-coordinator-recovery-junction-root-"),
  );
  const outsideDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-config-coordinator-recovery-junction-outside-"),
  );
  const linkedDir = path.join(rootDir, "linked-config");
  try {
    fs.symlinkSync(outsideDir, linkedDir, "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
      t.skip(`junction creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const journalDir = path.join(rootDir, ".transactions");
  fs.mkdirSync(journalDir, { recursive: true });
  const transactionId = "feedface-1234-1234-1234-feedface1234";
  const target = path.join(linkedDir, "target.json");
  const candidatePath = path.join(
    linkedDir,
    `.target.json.candidate.${transactionId}.0.tmp`,
  );
  const rollbackPath = path.join(
    linkedDir,
    `.target.json.rollback.${transactionId}.0.tmp`,
  );
  fs.writeFileSync(target, "committed");
  fs.writeFileSync(candidatePath, "outside-candidate");
  fs.writeFileSync(rollbackPath, "outside-rollback");
  const journalPath = path.join(
    journalDir,
    `.codexbridge-config-transaction.${transactionId}.journal.json`,
  );
  fs.writeFileSync(journalPath, `${JSON.stringify({
    version: 1,
    transactionId,
    stage: "complete",
    entries: [
      {
        index: 0,
        target,
        candidatePath,
        rollbackPath,
        existed: true,
        changed: true,
        originalSha256: "0".repeat(64),
        candidateSha256: createHash("sha256").update("committed").digest("hex"),
        originalMode: 0o644,
        targetMode: 0o644,
        state: "committed",
      },
    ],
  })}\n`, { mode: 0o600 });
  const coordinator = createConfigWriteCoordinator({
    allowedRoots: [rootDir],
    journalDir,
  });

  await assert.rejects(
    coordinator.recoverPendingTransactions(),
    (error) => error?.code === "config_recovery_incomplete",
  );
  assert.equal(fs.readFileSync(target, "utf8"), "committed");
  assert.equal(fs.existsSync(candidatePath), true);
  assert.equal(fs.existsSync(rollbackPath), true);
  assert.equal(fs.existsSync(journalPath), true);
});

test("recovery accepts a validated orphan journal update left before atomic replacement", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-orphan-update-",
  );
  fs.writeFileSync(target, "original");
  const safety = coordinatorSafetyForTargets([target]);
  fs.mkdirSync(safety.journalDir, { recursive: true });
  const transactionId = "abcdef12-1234-1234-1234-abcdef123456";
  const candidatePath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.candidate.${transactionId}.0.tmp`,
  );
  const rollbackPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.rollback.${transactionId}.0.tmp`,
  );
  fs.writeFileSync(candidatePath, "candidate-sk-orphan-secret", { mode: 0o600 });
  fs.writeFileSync(rollbackPath, "original", { mode: 0o600 });
  const baseJournalPath = path.join(
    safety.journalDir,
    `.codexbridge-config-transaction.${transactionId}.journal.json`,
  );
  const updatePath = `${baseJournalPath}.update.tmp`;
  fs.writeFileSync(updatePath, `${JSON.stringify({
    version: 1,
    transactionId,
    stage: "prepared",
    entries: [
      {
        index: 0,
        target,
        candidatePath,
        rollbackPath,
        existed: true,
        changed: true,
        originalSha256: createHash("sha256").update("original").digest("hex"),
        candidateSha256: createHash("sha256")
          .update("candidate-sk-orphan-secret")
          .digest("hex"),
        originalMode: 0o644,
        targetMode: 0o644,
        state: "pending",
      },
    ],
  })}\n`, { mode: 0o600 });
  const securedLegacyArtifacts = new Set();
  const coordinator = createProductionConfigWriteCoordinator({
    ...safety,
    platform: "win32",
    privateAcl: {
      async securePath(filePath, { kind }) {
        if ([candidatePath, rollbackPath].includes(filePath)) {
          assert.equal(kind, "file");
          securedLegacyArtifacts.add(path.resolve(filePath));
        }
      },
    },
    fileOps: {
      async readFile(filePath, options) {
        if ([candidatePath, rollbackPath].includes(filePath)) {
          assert.equal(securedLegacyArtifacts.has(path.resolve(filePath)), true);
        }
        return fsp.readFile(filePath, options);
      },
    },
  });

  assert.deepEqual(await coordinator.recoverPendingTransactions(), {
    recovered: 1,
    cleaned: 0,
    pending: [],
  });
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.equal(fs.existsSync(candidatePath), false);
  assert.equal(fs.existsSync(rollbackPath), false);
  assert.deepEqual(
    securedLegacyArtifacts,
    new Set([path.resolve(candidatePath), path.resolve(rollbackPath)]),
  );
  assert.deepEqual(fs.readdirSync(safety.journalDir), []);
});

test("a rollback failure retains one recovery copy, then recovery succeeds and the FIFO continues", async () => {
  const targets = createTransactionTargets(
    "codexbridge-config-coordinator-rollback-recovery-",
  ).slice(0, 2);
  targets.forEach((target, index) => fs.writeFileSync(target, `original-${index}`));
  let injectCommitFailure = true;
  let injectRollbackFailure = true;
  const coordinator = createConfigWriteCoordinator({
    ...coordinatorSafetyForTargets(targets),
    fileOps: {
      async rename(from, to) {
        if (
          injectCommitFailure &&
          from.includes(".candidate.") &&
          to === targets[1]
        ) {
          const error = new Error("injected commit failure");
          error.code = "EACCES";
          throw error;
        }
        if (
          injectRollbackFailure &&
          from.includes(".restore.") &&
          to === targets[0]
        ) {
          const error = new Error("injected rollback failure");
          error.code = "EBUSY";
          throw error;
        }
        await fsp.rename(from, to);
      },
    },
  });

  const error = await captureRejection(coordinator.runTransaction({
    operation: "rollback-failure",
    prepare: async () => ({
      entries: targets.map((target, index) => ({
        id: `target-${index}`,
        target,
        content: `candidate-${index}-sk-recovery-secret`,
        sensitive: true,
        validate: async () => {},
      })),
    }),
  }));

  assert.equal(error.rollbackComplete, false);
  assert.equal(typeof error.recoveryId, "string");
  assert.equal(
    error.rollbackErrors.some(({ stage, entryIndex, code }) =>
      stage === "restore" && entryIndex === 0 && code === "EBUSY"),
    true,
  );
  assert.equal(fs.readFileSync(targets[0], "utf8"), "candidate-0-sk-recovery-secret");
  assert.equal(fs.readFileSync(targets[1], "utf8"), "original-1");
  const journalFiles = fs.readdirSync(coordinatorSafetyForTargets(targets).journalDir)
    .filter((name) => name.endsWith(".journal.json"));
  assert.equal(journalFiles.length, 1);
  const journalText = fs.readFileSync(
    path.join(coordinatorSafetyForTargets(targets).journalDir, journalFiles[0]),
    "utf8",
  );
  assert.doesNotMatch(journalText, /sk-recovery-secret/);
  assert.equal(
    privateStagingArtifactNamesForTarget(targets[0])
      .filter((name) => name.includes(".rollback.")).length,
    1,
  );

  injectCommitFailure = false;
  injectRollbackFailure = false;
  assert.deepEqual(await coordinator.recoverPendingTransactions(), {
    recovered: 1,
    cleaned: 0,
    pending: [],
  });
  targets.forEach((target, index) => {
    assert.equal(fs.readFileSync(target, "utf8"), `original-${index}`);
  });
  await coordinator.runTransaction({
    operation: "after-recovery",
    prepare: async () => ({
      entries: targets.map((target, index) => ({
        id: `target-${index}`,
        target,
        content: `final-${index}`,
        validate: async () => {},
      })),
    }),
  });
  targets.forEach((target, index) => {
    assert.equal(fs.readFileSync(target, "utf8"), `final-${index}`);
  });
});

test("rollback inspection failure preserves candidate evidence so later recovery cannot overwrite a same-byte external edit", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-inspect-evidence-",
  );
  fs.writeFileSync(target, "original");
  const safety = coordinatorSafetyForTargets([target]);
  let failNextTargetRead = false;
  const coordinator = createConfigWriteCoordinator({
    ...safety,
    fileOps: {
      async readFile(filePath, options) {
        if (filePath === target && failNextTargetRead) {
          failNextTargetRead = false;
          const error = new Error("injected rollback inspection failure");
          error.code = "EACCES";
          throw error;
        }
        return fsp.readFile(filePath, options);
      },
    },
  });

  const error = await captureRejection(coordinator.runTransaction({
    operation: "inspect-evidence",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          content: "candidate",
          validate: async () => {
            failNextTargetRead = true;
            throw new Error("force rollback before commit");
          },
        },
      ],
    }),
  }));

  assert.equal(error.rollbackComplete, false);
  assert.equal(
    privateStagingArtifactNamesForTarget(target)
      .filter((name) => name.includes(".candidate.")).length,
    1,
  );
  assert.equal(
    privateStagingArtifactNamesForTarget(target)
      .filter((name) => name.includes(".rollback.")).length,
    1,
  );
  fs.writeFileSync(target, "candidate");
  assert.deepEqual(await coordinator.recoverPendingTransactions(), {
    recovered: 1,
    cleaned: 0,
    pending: [],
  });
  assert.equal(fs.readFileSync(target, "utf8"), "candidate");
  assert.deepEqual(privateStagingDirectoriesForTarget(target), []);
});

test("rollback chmod failure keeps the original-byte recovery copy until a later recovery restores mode", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-rollback-chmod-",
  );
  fs.writeFileSync(target, "original");
  const safety = coordinatorSafetyForTargets([target]);
  let targetChmodCalls = 0;
  let injectRollbackChmodFailure = true;
  const coordinator = createConfigWriteCoordinator({
    ...safety,
    fileOps: {
      async chmod(filePath, mode) {
        if (filePath === target) {
          targetChmodCalls += 1;
          if (injectRollbackChmodFailure && targetChmodCalls === 2) {
            injectRollbackChmodFailure = false;
            const error = new Error("injected rollback chmod failure");
            error.code = "EACCES";
            throw error;
          }
        }
        await fsp.chmod(filePath, mode);
      },
    },
  });

  const error = await captureRejection(coordinator.runTransaction({
    operation: "rollback-chmod-failure",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          content: "candidate",
          validate: async () => {},
        },
      ],
    }),
    verifyCommitted: async () => {
      throw new Error("force rollback");
    },
  }));

  assert.equal(error.rollbackComplete, false);
  assert.equal(typeof error.recoveryId, "string");
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.equal(
    privateStagingArtifactNamesForTarget(target)
      .filter((name) => name.includes(".rollback.")).length,
    1,
  );
  assert.deepEqual(await coordinator.recoverPendingTransactions(), {
    recovered: 1,
    cleaned: 0,
    pending: [],
  });
  assert.equal(targetChmodCalls >= 3, true);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(safety.journalDir), []);
  assert.deepEqual(privateStagingDirectoriesForTarget(target), []);
});

test("rollback target fsync failure retains WAL and recovery copy until metadata is durably synced", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-rollback-fsync-",
  );
  fs.writeFileSync(target, "original");
  const safety = coordinatorSafetyForTargets([target]);
  let targetSyncCalls = 0;
  const coordinator = createConfigWriteCoordinator({
    ...safety,
    fileOps: {
      async syncFile(filePath, applyMetadata) {
        const handle = await fsp.open(filePath, "r+");
        try {
          await applyMetadata?.();
          if (filePath === target) {
            targetSyncCalls += 1;
            if (targetSyncCalls === 2) {
              const error = new Error("injected rollback fsync failure");
              error.code = "EIO";
              throw error;
            }
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
    },
  });

  const error = await captureRejection(coordinator.runTransaction({
    operation: "rollback-fsync-failure",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          content: "candidate",
          validate: async () => {},
        },
      ],
    }),
    verifyCommitted: async () => {
      throw new Error("force rollback");
    },
  }));

  assert.equal(error.rollbackComplete, false);
  assert.equal(typeof error.recoveryId, "string");
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.equal(
    privateStagingArtifactNamesForTarget(target)
      .filter((name) => name.includes(".rollback.")).length,
    1,
  );
  assert.deepEqual(await coordinator.recoverPendingTransactions(), {
    recovered: 1,
    cleaned: 0,
    pending: [],
  });
  assert.equal(targetSyncCalls >= 3, true);
  assert.deepEqual(fs.readdirSync(safety.journalDir), []);
});

test("a transient journal-stage update failure rolls back cleanly and does not create a false recovery incident", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-journal-update-failure-",
  );
  fs.writeFileSync(target, "original");
  const safety = coordinatorSafetyForTargets([target]);
  let failUpdateOnce = true;
  const coordinator = createConfigWriteCoordinator({
    ...safety,
    fileOps: {
      async rename(from, to) {
        if (failUpdateOnce && from.endsWith(".journal.json.update.tmp")) {
          failUpdateOnce = false;
          const error = new Error("injected journal update failure");
          error.code = "EIO";
          throw error;
        }
        await fsp.rename(from, to);
      },
    },
  });

  const error = await captureRejection(coordinator.runTransaction({
    operation: "journal-update-failure",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          content: "candidate",
          validate: async () => {},
        },
      ],
    }),
  }));

  assert.equal(error.code, "config_transaction_failed");
  assert.equal(error.rollbackComplete, true);
  assert.deepEqual(error.rollbackErrors, []);
  assert.equal(error.recoveryId, undefined);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(safety.journalDir), []);
  await coordinator.runExclusive(async () => {});
});

test("a rollback-stage journal update failure is ignored once the files and journal were fully restored", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-rollback-stage-failure-",
  );
  fs.writeFileSync(target, "original");
  const safety = coordinatorSafetyForTargets([target]);
  let journalUpdateRenames = 0;
  const coordinator = createConfigWriteCoordinator({
    ...safety,
    fileOps: {
      async rename(from, to) {
        if (from.endsWith(".journal.json.update.tmp")) {
          journalUpdateRenames += 1;
          if (journalUpdateRenames === 2) {
            const error = new Error("injected rollback-stage journal update failure");
            error.code = "EIO";
            throw error;
          }
        }
        await fsp.rename(from, to);
      },
    },
  });

  const error = await captureRejection(coordinator.runTransaction({
    operation: "rollback-stage-update-failure",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          content: "candidate",
          validate: async () => {
            throw new Error("validation failed");
          },
        },
      ],
    }),
  }));

  assert.equal(journalUpdateRenames >= 2, true);
  assert.equal(error.rollbackComplete, true);
  assert.deepEqual(error.rollbackErrors, []);
  assert.equal(error.recoveryId, undefined);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(safety.journalDir), []);
});

test("a cleanup failure leaves a complete journal that the next recovery cleans without rollback", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-complete-cleanup-",
  );
  fs.writeFileSync(target, "original");
  let failCleanupOnce = true;
  const coordinator = createConfigWriteCoordinator({
    ...coordinatorSafetyForTargets([target]),
    fileOps: {
      async unlink(filePath) {
        if (failCleanupOnce && filePath.includes(".rollback.")) {
          failCleanupOnce = false;
          const error = new Error("injected cleanup failure");
          error.code = "EBUSY";
          throw error;
        }
        await fsp.unlink(filePath);
      },
    },
  });

  await coordinator.runTransaction({
    operation: "cleanup-failure",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          content: "committed",
          validate: async () => {},
        },
      ],
    }),
  });

  assert.equal(fs.readFileSync(target, "utf8"), "committed");
  assert.equal(
    fs.readdirSync(coordinatorSafetyForTargets([target]).journalDir)
      .filter((name) => name.endsWith(".journal.json")).length,
    1,
  );
  assert.deepEqual(await coordinator.recoverPendingTransactions(), {
    recovered: 0,
    cleaned: 1,
    pending: [],
  });
  assert.equal(fs.readFileSync(target, "utf8"), "committed");
  assert.deepEqual(fs.readdirSync(coordinatorSafetyForTargets([target]).journalDir), []);
});

test("journals and rollback artifacts are private while final targets preserve or derive their intended mode", async () => {
  const targets = createTransactionTargets(
    "codexbridge-config-coordinator-permissions-",
  ).slice(0, 3);
  fs.writeFileSync(targets[0], "existing");
  const privateWrites = [];
  const chmodCalls = [];
  const coordinator = createConfigWriteCoordinator({
    ...coordinatorSafetyForTargets(targets),
    fileOps: {
      async chmod(filePath, mode) {
        chmodCalls.push({ filePath, mode });
        await fsp.chmod(filePath, mode);
      },
      async stat(filePath) {
        if (filePath === targets[0]) {
          return { mode: 0o100640 };
        }
        return fsp.stat(filePath);
      },
      async writeFile(filePath, content, options) {
        if (
          filePath.includes(".candidate.") ||
          filePath.includes(".rollback.") ||
          filePath.includes(".journal.json")
        ) {
          privateWrites.push({ filePath, options });
        }
        await fsp.writeFile(filePath, content, options);
      },
    },
  });

  await coordinator.runTransaction({
    operation: "permission-modes",
    prepare: async () => ({
      entries: targets.map((target, index) => ({
        id: `target-${index}`,
        target,
        content: `candidate-${index}`,
        sensitive: index === 2,
        mode: index === 2 ? 0o777 : undefined,
        validate: async () => {},
      })),
    }),
  });

  assert.equal(privateWrites.length > 0, true);
  privateWrites.forEach(({ options }) => {
    assert.equal(options.mode, 0o600);
    assert.equal(options.flush, true);
    assert.equal(options.flag, "wx");
  });
  const finalModes = new Map(
    chmodCalls
      .filter(({ filePath }) => targets.includes(filePath))
      .map(({ filePath, mode }) => [filePath, mode]),
  );
  assert.equal(finalModes.get(targets[0]), 0o640);
  assert.equal(finalModes.get(targets[1]), 0o644);
  assert.equal(finalModes.get(targets[2]), 0o600);
});

function windowsSystemExecutableForTest(name) {
  return path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    name,
  );
}

function runIcaclsForTest(args) {
  const result = spawnSync(windowsSystemExecutableForTest("icacls.exe"), args, {
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function readWindowsAclSddlForTest(target) {
  const savePath = path.join(
    os.tmpdir(),
    `.codexbridge-private-acl-test-${randomUUID()}.txt`,
  );
  try {
    runIcaclsForTest([target, "/save", savePath]);
    const saved = fs.readFileSync(savePath, "utf16le");
    const daclLine = saved
      .split(/\r?\n/u)
      .find((line) => line.startsWith("D:"));
    assert.equal(typeof daclLine, "string");
    return daclLine;
  } finally {
    if (fs.existsSync(savePath)) {
      fs.unlinkSync(savePath);
    }
  }
}

test("Windows private ACL hardening removes a broadly inherited Everyone grant from files and directories", {
  skip: process.platform !== "win32",
}, async (t) => {
  const { createWindowsPrivateAcl } = await import(
    "../desktop/windows-private-acl.mjs"
  );
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codexbridge-private-acl-&-inherited-wide-"),
  );
  const target = path.join(rootDir, "candidate & literal.fixture");
  t.after(() => {
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
    if (fs.existsSync(rootDir)) {
      fs.rmdirSync(rootDir);
    }
  });

  runIcaclsForTest([
    rootDir,
    "/grant",
    "*S-1-1-0:(OI)(CI)(R)",
  ]);
  fs.writeFileSync(target, "temporary fixture only");
  runIcaclsForTest([target, "/grant", "*S-1-1-0:(R)"]);
  assert.match(readWindowsAclSddlForTest(target), /;;;(?:WD|S-1-1-0)\)/u);

  const privateAcl = createWindowsPrivateAcl();
  await privateAcl.securePath(target, { kind: "file" });
  await privateAcl.securePath(rootDir, { kind: "directory" });

  const fileDacl = readWindowsAclSddlForTest(target);
  const directoryDacl = readWindowsAclSddlForTest(rootDir);
  assert.match(fileDacl, /^D:[A-Z]*P[A-Z]*/u);
  assert.match(directoryDacl, /^D:[A-Z]*P[A-Z]*/u);
  assert.doesNotMatch(fileDacl, /;;;(?:WD|S-1-1-0)\)/u);
  assert.doesNotMatch(directoryDacl, /;;;(?:WD|S-1-1-0)\)/u);
  assert.equal((fileDacl.match(/\(A;/gu) || []).length, 3);
  assert.equal((directoryDacl.match(/\(A;/gu) || []).length, 3);
  assert.equal((directoryDacl.match(/;OICI;FA;/gu) || []).length, 3);
});

test("Windows ACL command runner binds literal arguments and rejects a hard timeout", async () => {
  const { runBoundedWindowsCommand } = await import(
    "../desktop/windows-private-acl.mjs"
  );
  const executable = "C:\\Windows\\System32\\icacls.exe";
  const literalPath = "C:\\fixture & whoami\\candidate.tmp";
  let invocation;

  const error = await captureRejection(runBoundedWindowsCommand(
    executable,
    [literalPath, "/verify"],
    {
      timeoutMs: 17,
      execFileImpl(file, args, options, callback) {
        invocation = { file, args, options };
        const timeout = new Error("simulated timeout with sensitive command text");
        timeout.killed = true;
        timeout.signal = "SIGKILL";
        callback(timeout, Buffer.alloc(0), Buffer.alloc(0));
      },
    },
  ));

  assert.equal(error.code, "windows_private_acl_timeout");
  assert.deepEqual(invocation.file, executable);
  assert.deepEqual(invocation.args, [literalPath, "/verify"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.timeout, 17);
  assert.equal(invocation.options.killSignal, "SIGKILL");
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(error.message.includes(literalPath), false);
  assert.equal(error.message.includes("sensitive"), false);
});

test("Windows ACL command runner owns a watchdog when execFile never completes", async () => {
  const { runBoundedWindowsCommand } = await import(
    "../desktop/windows-private-acl.mjs"
  );
  const killedWith = [];
  let safetyTimer;
  const safetyTimeout = new Promise((_, reject) => {
    safetyTimer = setTimeout(() => {
      const error = new Error("test watchdog expired");
      error.code = "test_watchdog_expired";
      reject(error);
    }, 250);
  });

  let error;
  try {
    error = await captureRejection(Promise.race([
      runBoundedWindowsCommand(
        "C:\\Windows\\System32\\icacls.exe",
        ["C:\\fixture\\candidate.tmp", "/verify"],
        {
          timeoutMs: 15,
          execFileImpl() {
            return {
              kill(signal) {
                killedWith.push(signal);
                return true;
              },
            };
          },
        },
      ),
      safetyTimeout,
    ]));
  } finally {
    clearTimeout(safetyTimer);
  }

  assert.equal(error.code, "windows_private_acl_timeout");
  assert.deepEqual(killedWith, ["SIGKILL"]);
});

test("Windows ACL command runner rejects a nonzero exit without reflecting stderr", async () => {
  const { runBoundedWindowsCommand } = await import(
    "../desktop/windows-private-acl.mjs"
  );
  const error = await captureRejection(runBoundedWindowsCommand(
    "C:\\Windows\\System32\\icacls.exe",
    ["C:\\fixture\\candidate.tmp", "/verify"],
    {
      execFileImpl(_file, _args, _options, callback) {
        const nonzero = new Error("Command failed: leaked fixture path");
        nonzero.code = 5;
        callback(nonzero, Buffer.alloc(0), Buffer.from("private stderr"));
      },
    },
  ));

  assert.equal(error.code, "windows_private_acl_command_failed");
  assert.equal(error.message.includes("fixture"), false);
  assert.equal(error.message.includes("stderr"), false);
});

test("Windows ACL verification accepts a domain RID-500 user emitted as its raw SID", async () => {
  const { createWindowsPrivateAcl } = await import(
    "../desktop/windows-private-acl.mjs"
  );
  const userSid = "S-1-5-21-111-222-333-500";
  const stats = {
    dev: 1,
    ino: 2,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
    nlink: 1,
  };
  const privateAcl = createWindowsPrivateAcl({
    platform: "win32",
    systemRoot: "C:\\Windows",
    commandRunner: async (executable) => ({
      stderr: Buffer.alloc(0),
      stdout: Buffer.from(
        executable.endsWith("whoami.exe")
          ? `"DOMAIN\\Administrator","${userSid}"`
          : "",
      ),
    }),
    fileOps: {
      async lstat() {
        return stats;
      },
      async readFile() {
        return [
          "candidate.tmp",
          `D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${userSid})`,
          "",
        ].join("\r\n");
      },
      async unlink() {},
    },
    randomId: () => "fixed",
    tempDirectory: "C:\\Temp",
  });

  await privateAcl.securePath("C:\\fixture\\candidate.tmp", { kind: "file" });
});

test("Windows ACL verification can confirm an already-private file without applying permissions", async () => {
  const { createWindowsPrivateAcl } = await import(
    "../desktop/windows-private-acl.mjs"
  );
  const userSid = "S-1-5-21-111-222-333-1001";
  const invocations = [];
  const stats = {
    dev: 7,
    ino: 8,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
    nlink: 1,
  };
  const privateAcl = createWindowsPrivateAcl({
    platform: "win32",
    systemRoot: "C:\\Windows",
    commandRunner: async (executable, args) => {
      invocations.push({ executable, args });
      return {
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(
          executable.endsWith("whoami.exe")
            ? `"DOMAIN\\User","${userSid}"`
            : "",
        ),
      };
    },
    fileOps: {
      async lstat() {
        return stats;
      },
      async readFile() {
        return [
          "already-private.toml",
          `D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${userSid})`,
          "",
        ].join("\r\n");
      },
      async unlink() {},
    },
    randomId: () => "verify-only",
    tempDirectory: "C:\\Temp",
  });

  await privateAcl.verifyPath("C:\\fixture\\already-private.toml", { kind: "file" });

  assert.equal(
    invocations.some(({ args }) => args.includes("/grant:r")),
    false,
  );
  assert.equal(
    invocations.some(({ executable }) => executable.endsWith("powershell.exe")),
    false,
  );
});

test("Windows ACL verification isolates the DACL when icacls appends a SACL", async () => {
  const { createWindowsPrivateAcl } = await import(
    "../desktop/windows-private-acl.mjs"
  );
  const userSid = "S-1-5-21-111-222-333-1001";
  const stats = {
    dev: 5,
    ino: 6,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
    nlink: 1,
  };
  const privateAcl = createWindowsPrivateAcl({
    platform: "win32",
    systemRoot: "C:\\Windows",
    commandRunner: async (executable) => ({
      stderr: Buffer.alloc(0),
      stdout: Buffer.from(
        executable.endsWith("whoami.exe")
          ? `"DOMAIN\\User","${userSid}"`
          : "",
      ),
    }),
    fileOps: {
      async lstat() {
        return stats;
      },
      async readFile() {
        return [
          "private-stage",
          `D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;FA;;;${userSid})S:PAINO_ACCESS_CONTROL`,
          "",
        ].join("\r\n");
      },
      async unlink() {},
    },
    randomId: () => "fixed-sacl",
    tempDirectory: "C:\\Temp",
  });

  await privateAcl.securePath("C:\\fixture\\private-stage", {
    kind: "directory",
  });
});

test("Windows ACL replacement removes explicit untrusted grants without a reset-to-inherited window", async () => {
  const { createWindowsPrivateAcl } = await import(
    "../desktop/windows-private-acl.mjs"
  );
  const userSid = "S-1-5-21-111-222-333-1001";
  const commands = [];
  let savedDaclReads = 0;
  const stats = {
    dev: 3,
    ino: 4,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
    nlink: 1,
  };
  const privateAcl = createWindowsPrivateAcl({
    platform: "win32",
    systemRoot: "C:\\Windows",
    commandRunner: async (executable, args, options) => {
      commands.push({ executable, args, options });
      return {
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(
          executable.endsWith("whoami.exe")
            ? `"DOMAIN\\User","${userSid}"`
            : executable.endsWith("powershell.exe")
              ? "CODEXBRIDGE_PRIVATE_ACL_REPLACED\r\n"
              : "",
        ),
      };
    },
    fileOps: {
      async lstat() {
        return stats;
      },
      async readFile() {
        savedDaclReads += 1;
        const untrusted = savedDaclReads === 1
          ? "(A;;FR;;;WD)"
          : "";
        return [
          "candidate.tmp",
          `D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${userSid})${untrusted}`,
          "",
        ].join("\r\n");
      },
      async unlink() {},
    },
    randomId: () => `fixed-${savedDaclReads}`,
    tempDirectory: "C:\\Temp",
  });

  const target = "C:\\fixture & literal\\candidate.tmp";
  await privateAcl.securePath(target, { kind: "file" });

  assert.equal(commands.some(({ args }) => args.includes("/reset")), false);
  const replacement = commands.find(({ executable }) =>
    executable.endsWith("powershell.exe"));
  assert.equal(Boolean(replacement), true);
  assert.equal(
    replacement.args.some((argument) => argument.includes(target)),
    false,
  );
  assert.equal(
    replacement.options.environment.CODEXBRIDGE_PRIVATE_ACL_LITERAL_PATH,
    target,
  );
  assert.equal(
    replacement.options.environment.CODEXBRIDGE_PRIVATE_ACL_KIND,
    "file",
  );
  assert.equal(
    replacement.options.environment.CODEXBRIDGE_PRIVATE_ACL_USER_SID,
    userSid,
  );
  const replacementScript = replacement.args.at(-1);
  assert.match(replacementScript, /Get-Acl -LiteralPath \$LiteralPath/);
  assert.doesNotMatch(replacementScript, /(?:File|Directory)Security\]::new/);
});

test("the Windows coordinator writes artifacts only inside deduplicated private staging directories", async () => {
  const [target, secondTarget] = createTransactionTargets(
    "codexbridge-config-coordinator-windows-acl-wiring-",
  );
  fs.writeFileSync(target, "original");
  fs.writeFileSync(secondTarget, "second-original");
  const safety = coordinatorSafetyForTargets([target, secondTarget]);
  const secured = [];
  const privateDirectories = new Set();
  const artifactWritesOutsidePrivateDirectories = [];
  const fileOps = {
    async writeFile(filePath, bytes, options) {
      if (
        /\.(?:journal\.json|candidate|rollback|restore|update)\b/u.test(
          path.basename(filePath),
        ) &&
        !privateDirectories.has(path.resolve(path.dirname(filePath)))
      ) {
        artifactWritesOutsidePrivateDirectories.push(filePath);
      }
      return fsp.writeFile(filePath, bytes, options);
    },
  };
  const coordinator = createProductionConfigWriteCoordinator({
    ...safety,
    fileOps,
    platform: "win32",
    privateAcl: {
      async securePath(filePath, options) {
        secured.push({ filePath, ...options });
        if (options.kind === "directory") {
          privateDirectories.add(path.resolve(filePath));
        }
      },
    },
  });

  await coordinator.runTransaction({
    operation: "windows-acl-wiring",
    prepare: async () => ({
      entries: [
        {
          id: "target",
          target,
          content: "candidate",
          validate: async ({ tempPath }) => {
            assert.equal(
              privateDirectories.has(path.resolve(path.dirname(tempPath))),
              true,
            );
          },
        },
        {
          id: "second-target",
          target: secondTarget,
          content: "second-candidate",
          validate: async ({ tempPath }) => {
            assert.equal(
              privateDirectories.has(path.resolve(path.dirname(tempPath))),
              true,
            );
          },
        },
      ],
    }),
  });

  assert.deepEqual(artifactWritesOutsidePrivateDirectories, []);
  assert.equal(
    secured.some(({ filePath, kind }) =>
      filePath === safety.journalDir && kind === "directory"),
    true,
  );
  const stagingDirectoryCalls = secured.filter(({ filePath, kind }) =>
    kind === "directory" && filePath !== safety.journalDir);
  assert.equal(stagingDirectoryCalls.length, 1);
  assert.equal(secured.some(({ kind }) => kind === "file"), false);
  assert.equal(
    fs.readdirSync(path.dirname(target)).some((name) =>
      name.startsWith(".codexbridge-private-stage.")),
    false,
  );
});

test("a Windows journal directory identity change during ACL hardening fails before journal bytes", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-windows-journal-identity-",
  );
  fs.writeFileSync(target, "original");
  const safety = coordinatorSafetyForTargets([target]);
  const movedJournalDir = `${safety.journalDir}.moved`;
  const journalWrites = [];
  let swapped = false;
  const coordinator = createProductionConfigWriteCoordinator({
    ...safety,
    platform: "win32",
    privateAcl: {
      async securePath(filePath, { kind }) {
        if (!swapped && filePath === safety.journalDir && kind === "directory") {
          swapped = true;
          fs.renameSync(safety.journalDir, movedJournalDir);
          fs.mkdirSync(safety.journalDir, { mode: 0o700 });
        }
      },
    },
    fileOps: {
      async writeFile(filePath, bytes, options) {
        if (path.dirname(filePath) === safety.journalDir) {
          journalWrites.push(filePath);
        }
        return fsp.writeFile(filePath, bytes, options);
      },
    },
  });

  const error = await captureRejection(coordinator.runTransaction({
    operation: "windows-journal-identity-change",
    prepare: async () => ({
      entries: [{
        id: "target",
        target,
        content: "candidate-secret",
        sensitive: true,
        validate: async () => {},
      }],
    }),
  }));

  assert.equal(swapped, true);
  assert.equal(error.code, "config_transaction_failed");
  assert.deepEqual(journalWrites, []);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
});

test("safe transaction failure metadata reports private staging ACL failures without reflecting the cause", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-windows-acl-fail-closed-",
  );
  fs.writeFileSync(target, "original");
  const safety = coordinatorSafetyForTargets([target]);
  let failed = false;
  const coordinator = createProductionConfigWriteCoordinator({
    ...safety,
    platform: "win32",
    privateAcl: {
      async securePath(filePath, { kind }) {
        if (
          kind === "directory" &&
          filePath.includes(".codexbridge-private-stage.")
        ) {
          failed = true;
          const error = new Error("secret candidate bytes absolute test path");
          error.code = "windows_private_acl_command_failed";
          throw error;
        }
      },
    },
  });

  const error = await captureRejection(coordinator.runTransaction({
    operation: "windows-acl-failure",
    prepare: async () => ({
      entries: [{
        id: "target",
        target,
        content: "candidate",
        sensitive: true,
        validate: async () => {},
      }],
    }),
  }));

  assert.equal(failed, true);
  assert.equal(error.code, "config_transaction_failed");
  assert.equal(error.failurePhase, "private_staging");
  assert.equal(error.causeCode, "windows_private_acl_command_failed");
  assert.doesNotMatch(error.message, /secret|candidate bytes|absolute test path/i);
  assert.doesNotMatch(error.stack ?? "", /secret|candidate bytes|absolute test path/i);
  assert.doesNotMatch(
    JSON.stringify(error),
    /secret|candidate bytes|absolute test path/i,
  );
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(safety.journalDir), []);
  assert.deepEqual(
    fs.readdirSync(path.dirname(target)).filter((name) =>
      name.includes(".candidate.") ||
      name.includes(".rollback.") ||
      name.startsWith(".codexbridge-private-stage.")),
    [],
  );
});

test("safe transaction failure metadata never coerces a non-string cause code", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-hostile-cause-code-",
  );
  fs.writeFileSync(target, "original");
  const safety = coordinatorSafetyForTargets([target]);
  const coordinator = createProductionConfigWriteCoordinator({
    ...safety,
    platform: "win32",
    privateAcl: {
      async securePath(filePath, { kind }) {
        if (
          kind === "directory" &&
          filePath.includes(".codexbridge-private-stage.")
        ) {
          const error = new Error("must remain private");
          error.code = {
            toString() {
              throw new Error("must not coerce a hostile cause code");
            },
          };
          throw error;
        }
      },
    },
  });

  const error = await captureRejection(coordinator.runTransaction({
    operation: "hostile-cause-code",
    prepare: async () => ({
      entries: [{
        id: "target",
        target,
        content: "candidate",
        sensitive: true,
        validate: async () => {},
      }],
    }),
  }));

  assert.equal(error.name, "ConfigTransactionError");
  assert.equal(error.code, "config_transaction_failed");
  assert.equal(error.failurePhase, "private_staging");
  assert.equal(error.causeCode, "operation_failed");
});

test("an unchanged sensitive Windows target is republished without securing the old inode in place", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-windows-acl-unchanged-sensitive-",
  );
  fs.writeFileSync(target, "unchanged");
  const originalStats = fs.statSync(target, { bigint: true });
  let oldTargetSecuredInPlace = false;
  let replacementTargetSecured = false;
  const coordinator = createProductionConfigWriteCoordinator({
    ...coordinatorSafetyForTargets([target]),
    platform: "win32",
    privateAcl: {
      async securePath(filePath, { kind }) {
        if (filePath !== target || kind !== "file") {
          return;
        }
        const currentStats = fs.statSync(filePath, { bigint: true });
        if (
          currentStats.dev === originalStats.dev &&
          currentStats.ino === originalStats.ino
        ) {
          oldTargetSecuredInPlace = true;
          const error = new Error("the original target inode must not be secured in place");
          error.code = "windows_private_acl_command_failed";
          throw error;
        }
        replacementTargetSecured = true;
      },
    },
  });

  await coordinator.runTransaction({
    operation: "windows-acl-unchanged-sensitive",
    prepare: async () => ({
      entries: [{
        id: "target",
        target,
        content: "unchanged",
        sensitive: true,
        validate: async () => {},
      }],
    }),
  });

  const replacementStats = fs.statSync(target, { bigint: true });
  assert.equal(fs.readFileSync(target, "utf8"), "unchanged");
  assert.notEqual(replacementStats.ino, originalStats.ino);
  assert.equal(oldTargetSecuredInPlace, false);
  assert.equal(replacementTargetSecured, true);
  assert.equal(
    fs.readdirSync(path.dirname(target)).some((name) =>
      name.includes(".candidate.") ||
      name.includes(".rollback.") ||
      name.startsWith(".codexbridge-private-stage.")),
    false,
  );
});

test("an already-private unchanged sensitive Windows target stays zero-write", async () => {
  const [target] = createTransactionTargets(
    "codexbridge-config-coordinator-windows-acl-already-private-",
  );
  fs.writeFileSync(target, "unchanged-private");
  const originalStats = fs.statSync(target, { bigint: true });
  const verified = [];
  let targetSecureCalls = 0;
  let targetRenameCalls = 0;
  const coordinator = createProductionConfigWriteCoordinator({
    ...coordinatorSafetyForTargets([target]),
    platform: "win32",
    privateAcl: {
      async verifyPath(filePath, options) {
        verified.push({ filePath, ...options });
      },
      async securePath(filePath, { kind }) {
        if (filePath === target && kind === "file") {
          targetSecureCalls += 1;
          const error = new Error("already-private target must not be rewritten");
          error.code = "windows_private_acl_command_failed";
          throw error;
        }
      },
    },
    fileOps: {
      async rename(from, to) {
        if (to === target) {
          targetRenameCalls += 1;
        }
        await fsp.rename(from, to);
      },
    },
  });

  await coordinator.runTransaction({
    operation: "windows-already-private-unchanged-sensitive",
    prepare: async () => ({
      entries: [{
        id: "target",
        target,
        content: "unchanged-private",
        sensitive: true,
        validate: async ({ unchanged }) => assert.equal(unchanged, true),
      }],
    }),
  });

  const finalStats = fs.statSync(target, { bigint: true });
  assert.deepEqual(verified, [{ filePath: target, kind: "file" }]);
  assert.equal(targetSecureCalls, 0);
  assert.equal(targetRenameCalls, 0);
  assert.equal(finalStats.ino, originalStats.ino);
  assert.equal(fs.readFileSync(target, "utf8"), "unchanged-private");
});
