import * as fsPromises from "node:fs/promises";
import path from "node:path";

import { recoverSkillOwnershipOffline } from "./component-adapters.mjs";
import { getOwnershipCoordinator } from "./ownership-coordinator.mjs";
import {
  readInstallRootCapability,
  resolveSkillTarget,
} from "./path-policy.mjs";
import { createPreparedSkillRecovery, createSkillFileService } from "./skill-files.mjs";
import {
  createSkillPrepareJournal,
  inferAnyPreparedSkillInstallRoot,
  inferPreparedSkillInstallRoot,
} from "./skill-prepare-journal.mjs";
import { createSkillSwapJournal } from "./skill-swap-journal.mjs";

function recoveryError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function requireWindowsPath(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || value.includes("\0") || !path.win32.isAbsolute(value)
    || path.win32.normalize(value) !== value) throw recoveryError(code);
  return value;
}

export function createDefaultSkillRecoveryHooks({
  fileCapabilities, ownershipStore, dataRoot, skillsRoot,
  skillPathAccess = { realpath: fsPromises.realpath, lstat: fsPromises.lstat },
} = {}) {
  const skillSwapDirectory = path.win32.join(dataRoot, "skill-swaps");
  const skillPrepareDirectory = path.win32.join(dataRoot, "skill-prepares");
  function createRecoverySkillFiles({ installRootCapability, skillsRootCapability }) {
    const installRoot = readInstallRootCapability(installRootCapability);
    return createSkillFileService({
      fileCapabilities, installRootCapability, skillsRootCapability,
      catalogService: null, workspace: null,
      swapJournal: createSkillSwapJournal({ journalDir: skillSwapDirectory, fsApi: fileCapabilities, skillsRoot }),
      prepareJournal: createSkillPrepareJournal({
        journalDir: skillPrepareDirectory, fsApi: fileCapabilities, installRoot,
      }),
      prepareLeaseStore: ownershipStore, hashFile: null, recoveryOnly: true,
    });
  }
  async function inferSkillInstallRoot(ownership) {
    const task = ownership?.activeTask;
    if (!task || !["skill-replace", "skill-uninstall", "skill-prepare"].includes(task.kind)) {
      return inferAnyPreparedSkillInstallRoot({
        journalDir: skillPrepareDirectory, fsApi: fileCapabilities,
      });
    }
    if (typeof task.taskId !== "string" || typeof task.skillId !== "string") {
      throw recoveryError("software_manager_skill_recovery_record_invalid");
    }
    const preparedRoot = await inferPreparedSkillInstallRoot({
      journalDir: skillPrepareDirectory, fsApi: fileCapabilities, taskId: task.taskId, skillId: task.skillId,
    });
    if (task.kind !== "skill-replace") return preparedRoot;
    const claimRoot = requireWindowsPath(task.installRoot, "software_manager_skill_recovery_record_invalid");
    if (preparedRoot !== null && preparedRoot.toLowerCase() !== claimRoot.toLowerCase()) {
      throw recoveryError("software_manager_skill_recovery_record_invalid");
    }
    if (typeof task.swapId !== "string" || task.skillsRoot !== skillsRoot) {
      throw recoveryError("software_manager_skill_recovery_record_invalid");
    }
    const transaction = await createSkillSwapJournal({
      journalDir: skillSwapDirectory, fsApi: fileCapabilities, skillsRoot,
    }).load({ taskId: task.taskId, swapId: task.swapId });
    if (!transaction) return claimRoot;
    if (transaction.snapshot.leaseScope !== task.leaseScope
      || transaction.snapshot.leaseNonce !== task.leaseNonce) {
      throw recoveryError("software_manager_skill_recovery_record_invalid");
    }
    const suffix = path.win32.join("staging", `task-${task.taskId}`, `skill-${task.skillId}.prepare`);
    const sourcePath = transaction.snapshot.sourcePath;
    if (typeof sourcePath !== "string" || !sourcePath.endsWith(`\\${suffix}`)) {
      throw recoveryError("software_manager_skill_recovery_record_invalid");
    }
    const swapRoot = sourcePath.slice(0, -(suffix.length + 1));
    if (swapRoot.toLowerCase() !== claimRoot.toLowerCase()) {
      throw recoveryError("software_manager_skill_recovery_record_invalid");
    }
    return claimRoot;
  }
  async function cleanupAbandonedPreparedSkills({ installRootCapability, heldLease = null }) {
    const installRoot = readInstallRootCapability(installRootCapability);
    let result;
    let primaryError = null;
    try {
      const prepareJournal = createSkillPrepareJournal({
        journalDir: skillPrepareDirectory, fsApi: fileCapabilities, installRoot,
      });
      const reconciliation = await createPreparedSkillRecovery({
        fileCapabilities, installRootCapability, prepareJournal, prepareLeaseStore: ownershipStore,
      }).reconcilePreparedSources({ heldLease });
      if (reconciliation.status === "failed") {
        const errors = reconciliation.failed.map((failure) => failure.error);
        throw errors.length === 1 ? errors[0]
          : new AggregateError(errors, "software_manager_skill_prepare_recovery_failed", { cause: errors[0] });
      }
      const coordinator = getOwnershipCoordinator(ownershipStore);
      result = await coordinator.runExclusive(async (store) => {
        const current = await store.load();
        const task = current.activeTask;
        const isSkillPrepare = task?.kind === "skill-prepare"
          || (task?.kind === "legacy-abandoned-prepare" && task.originalKind === "skill-prepare");
        if (!isSkillPrepare) {
          const canReleaseTransientRoot = current.activeTask === null
            && current.installRoot === installRoot
            && Object.keys(current.components ?? {}).length === 0
            && Object.keys(current.skills ?? {}).length === 0;
          if (!canReleaseTransientRoot || reconciliation.status !== "complete") return current;
          const finalReconciliation = await createPreparedSkillRecovery({
            fileCapabilities, installRootCapability,
            prepareJournal: createSkillPrepareJournal({
              journalDir: skillPrepareDirectory, fsApi: fileCapabilities, installRoot,
            }),
            prepareLeaseStore: ownershipStore,
          }).reconcilePreparedSources({ heldLease });
          if (finalReconciliation.status === "failed") {
            const errors = finalReconciliation.failed.map((failure) => failure.error);
            throw errors.length === 1 ? errors[0]
              : new AggregateError(errors, "software_manager_skill_prepare_recovery_failed", { cause: errors[0] });
          }
          if (finalReconciliation.status !== "complete") return current;
          const next = structuredClone(current);
          next.installRoot = null;
          return store.save(next);
        }
        if (task.kind !== "legacy-abandoned-prepare"
          && (typeof task.leaseNonce !== "string" || typeof task.leaseScope !== "string")) {
          throw recoveryError("software_manager_skill_prepare_claim_invalid");
        }
        if (reconciliation.status !== "complete") return current;
        const finalReconciliation = await createPreparedSkillRecovery({
          fileCapabilities, installRootCapability,
          prepareJournal: createSkillPrepareJournal({
            journalDir: skillPrepareDirectory, fsApi: fileCapabilities, installRoot,
          }),
          prepareLeaseStore: ownershipStore,
        }).reconcilePreparedSources({ heldLease });
        if (finalReconciliation.status === "failed") {
          const errors = finalReconciliation.failed.map((failure) => failure.error);
          throw errors.length === 1 ? errors[0]
            : new AggregateError(errors, "software_manager_skill_prepare_recovery_failed", { cause: errors[0] });
        }
        if (finalReconciliation.status !== "complete") return current;
        const lease = task.kind === "legacy-abandoned-prepare" ? { async release() {} }
          : await ownershipStore.acquireOperationLease({
            nonce: task.leaseNonce, scope: task.leaseScope, wait: false,
          });
        if (lease === null) return current;
        try {
          const next = structuredClone(current);
          next.activeTask = null;
          next.lastTask = {
            taskId: task.taskId,
            componentId: task.kind === "skill-prepare" ? task.skillId : task.componentId,
            action: "prepare-aborted",
          };
          if (next.installRoot === installRoot
            && Object.keys(next.components ?? {}).length === 0
            && Object.keys(next.skills ?? {}).length === 0) {
            next.installRoot = null;
          }
          return await store.save(next);
        } finally { await lease.release(); }
      });
    } catch (error) { primaryError = error; }
    let releaseError = null;
    try { await heldLease?.lease?.release(); } catch (error) { releaseError = error; }
    if (primaryError && releaseError) {
      throw new AggregateError([primaryError, releaseError], primaryError.message, { cause: primaryError });
    }
    if (primaryError) throw primaryError;
    if (releaseError) throw releaseError;
    return result;
  }
  return Object.freeze({
    inferSkillInstallRoot,
    async recoverActiveSkillTransaction({ installRootCapability, skillsRootCapability }) {
      const current = await ownershipStore.load();
      const task = current.activeTask;
      if (task?.kind !== "skill-replace") {
        const recovery = await recoverSkillOwnershipOffline({
          ownershipStore, installRootCapability, skillsRootCapability,
          skillFiles: createRecoverySkillFiles({ installRootCapability, skillsRootCapability }),
          resolveSkillTarget, skillPathAccess, expectedTask: task ?? null,
        });
        return Object.freeze({ status: recovery.status, state: recovery.state, heldLease: null });
      }
      const lease = await ownershipStore.acquireOperationLease({
        nonce: task.leaseNonce, scope: task.leaseScope, wait: false,
      });
      if (lease === null) return Object.freeze({ status: "busy", state: current, heldLease: null });
      const heldLease = Object.freeze({
        taskId: task.taskId, skillId: task.skillId,
        nonce: task.leaseNonce, scope: task.leaseScope, lease,
      });
      try {
        const recovery = await recoverSkillOwnershipOffline({
          ownershipStore, installRootCapability, skillsRootCapability,
          skillFiles: createRecoverySkillFiles({ installRootCapability, skillsRootCapability }),
          resolveSkillTarget, skillPathAccess, expectedTask: task,
        });
        if (recovery.status === "changed") {
          await lease.release();
          return Object.freeze({ status: "changed", state: recovery.state, heldLease: null });
        }
        return Object.freeze({ status: "recovered", state: recovery.state, heldLease });
      } catch (error) {
        // The exact lease is ours, so no process is still applying this swap.
        // If strict reconciliation cannot prove either old or new content, keep
        // the files untouched but release the stale ownership claim. This
        // prevents one interrupted Skill from disabling unrelated software
        // installs forever; reinstalling that Skill remains an explicit action.
        let abandoned;
        try {
          const coordinator = getOwnershipCoordinator(ownershipStore);
          abandoned = await coordinator.runExclusive(async (store) => {
            const latest = await store.load();
            if (JSON.stringify(latest.activeTask ?? null) !== JSON.stringify(task)) {
              return Object.freeze({ status: "changed", state: latest });
            }
            const next = structuredClone(latest);
            next.activeTask = null;
            next.lastTask = {
              taskId: task.taskId,
              componentId: task.skillId,
              action: "skill-recovery-abandoned",
              error: String(error?.code || error?.message || "skill_recovery_failed"),
            };
            return Object.freeze({ status: "abandoned", state: await store.save(next) });
          });
        } catch (abandonError) {
          try { await lease.release(); } catch {}
          throw new AggregateError([error, abandonError], "software_manager_skill_recovery_abandon_failed", {
            cause: error,
          });
        }
        await lease.release();
        return Object.freeze({ ...abandoned, heldLease: null });
      }
    },
    cleanupAbandonedPreparedSkills,
  });
}
