export function createCodexHistoryRecoveryFlow({
  preview,
  stopDesktop,
  listProcesses,
  probeCatalogWritable,
  apply,
  backupExists,
  restartDesktop,
  recoverProjects,
  loadState = () => null,
  saveState = () => {},
  recordPhase = () => {},
} = {}) {
  requireFunction(preview, "preview");
  requireFunction(stopDesktop, "stopDesktop");
  requireFunction(listProcesses, "listProcesses");
  requireFunction(probeCatalogWritable, "probeCatalogWritable");
  requireFunction(apply, "apply");
  requireFunction(backupExists, "backupExists");
  requireFunction(restartDesktop, "restartDesktop");
  requireFunction(recoverProjects, "recoverProjects");
  requireFunction(loadState, "loadState");
  requireFunction(saveState, "saveState");
  requireFunction(recordPhase, "recordPhase");

  const restored = normalizePersistedState(loadState());
  let current = restored.current;
  let preparedPreview = restored.preparedPreview;
  let launchTarget = restored.launchTarget;
  let lastRecordedPhase = "";

  function persist() {
    saveState({
      version: 1,
      current,
      preparedPreview,
      launchTarget,
      savedAt: new Date().toISOString(),
    });
    if (current.phase && current.phase !== lastRecordedPhase) {
      lastRecordedPhase = current.phase;
      recordPhase(current.phase, current);
    }
  }

  async function prepare() {
    preparedPreview = await preview();
    const summary = preparedPreview?.summary || {};
    current = {
      ...emptyStatus(),
      ok: preparedPreview?.ok === true,
      phase: "planned",
      scanOnly: true,
      summary: { ...summary },
      rawThreads: numberValue(summary.rawThreads),
      activeUserThreads: numberValue(summary.activeUserThreads),
      catalogThreadsBefore: numberValue(summary.catalogThreads),
      sidebarThreadsBefore: numberValue(summary.sidebarThreads),
      plannedInserts: numberValue(summary.plannedInserts),
      plannedUpdates: numberValue(summary.plannedUpdates),
      unrecoverableThreads: numberValue(summary.unrecoverableThreads),
      message: "恢复计划已生成，尚未写入新版会话目录。",
    };
    persist();
    return status();
  }

  async function execute({ manualExit = false } = {}) {
    if (!preparedPreview) {
      await prepare();
    }
    current = {
      ...current,
      ok: false,
      phase: "waiting_for_exit",
      scanOnly: false,
      failureCode: "",
      failureReason: "",
      message: manualExit
        ? "正在重新检测 ChatGPT / Codex 是否已完全退出。"
        : "正在退出 ChatGPT / Codex。",
    };
    persist();

    if (!manualExit) {
      let stopResult;
      try {
        stopResult = await stopDesktop();
      } catch (error) {
        stopResult = {
          ok: false,
          failureCode: error?.code || "desktop_stop_failed",
          message: error?.message || String(error),
        };
      }
      launchTarget = String(stopResult?.launchTarget || launchTarget || "");
      if (stopResult?.ok !== true) {
        return await failForRunningDesktop(
          stopResult?.failureCode || stopResult?.code || "desktop_stop_failed",
          stopResult?.message || "未能完全退出 ChatGPT / Codex。",
        );
      }
    }

    recordPhase("process_check", current);
    let running;
    try {
      running = normalizeProcesses(await listProcesses());
    } catch (error) {
      return failStatus(
        "failed",
        "process_check_failed",
        `无法确认 ChatGPT / Codex 是否已完全退出：${error?.message || String(error)}`,
      );
    }
    if (running.length) {
      return failStatus("awaiting_manual_exit", "desktop_processes_running", "仍检测到 ChatGPT / Codex 进程，请手动完全退出后重新检测。", {
        runningProcessIds: running.map((item) => item.processId).filter(Boolean),
      });
    }

    recordPhase("writable_probe", current);
    const writable = await probeCatalogWritable();
    if (writable?.ok !== true) {
      return failStatus("failed", writable?.code || "catalog_busy", writable?.message || "新版会话目录数据库仍被占用。", {
        runningProcessIds: [],
      });
    }

    current = { ...current, phase: "migrating", runningProcessIds: [], message: "正在备份并迁移新版会话目录。" };
    persist();
    let migration;
    try {
      migration = await apply();
    } catch (error) {
      return failStatus("failed", error?.code || "migration_failed", error?.message || String(error));
    }

    const verification = migration?.verification || {};
    const backupDir = String(migration?.backupDir || "");
    const backupPresent = Boolean(backupDir && await backupExists(backupDir));
    const expected = numberValue(verification.expectedActiveUserThreads);
    const catalogVerified = numberValue(verification.catalogActiveUserThreads);
    const sidebarVerified = numberValue(verification.sidebarActiveUserThreads);
    const verified = migration?.ok === true && verification.consistent === true && backupPresent &&
      expected > 0 && catalogVerified === expected && sidebarVerified === expected;
    if (!verified) {
      return failStatus("failed", "post_write_verification_failed", "迁移提交后的目录、侧栏或备份回读验证未通过。", {
        actualInserted: numberValue(migration?.applied?.inserted),
        actualUpdated: numberValue(migration?.applied?.updated),
        backupDir,
        backupExists: backupPresent,
        rereadCatalogThreads: numberValue(migration?.after?.summary?.catalogThreads),
        rereadSidebarThreads: numberValue(migration?.after?.summary?.sidebarThreads),
      });
    }

    current = {
      ...current,
      phase: "verified",
      commitStatus: "verified",
      actualInserted: numberValue(migration?.applied?.inserted),
      actualUpdated: numberValue(migration?.applied?.updated),
      backupDir,
      backupExists: true,
      rereadCatalogThreads: numberValue(migration?.after?.summary?.catalogThreads),
      rereadSidebarThreads: numberValue(migration?.after?.summary?.sidebarThreads),
      verification,
      message: "迁移已提交并完成目录、侧栏和备份回读验证。",
    };
    persist();

    let restartResult;
    try {
      recordPhase("restart", current);
      restartResult = await restartDesktop({ launchTarget });
    } catch (error) {
      return failStatus("failed", "restart_failed", error?.message || String(error), { commitStatus: "verified" });
    }
    if (restartResult?.ok !== true) {
      return failStatus("failed", "restart_failed", restartResult?.message || "迁移成功，但重新启动 ChatGPT / Codex 失败。", { commitStatus: "verified" });
    }

    const manualRestartRequired = restartResult?.skipped === true ||
      restartResult?.manualRestartRequired === true;
    let projectRecovery = null;
    if (!manualRestartRequired) {
      try {
        projectRecovery = await recoverProjects();
      } catch (error) {
        return failStatus("failed", "project_recovery_failed", error?.message || String(error), { commitStatus: "verified" });
      }
    }
    current = {
      ...current,
      ok: true,
      phase: manualRestartRequired ? "completed" : "restarted",
      restartResult,
      projectRecovery,
      message: manualRestartRequired
        ? `历史目录已迁移并回读验证，实际新增 ${current.actualInserted} 条；请手动打开 ChatGPT / Codex。`
        : `历史目录已迁移并回读验证，实际新增 ${current.actualInserted} 条；ChatGPT / Codex 已重新启动。`,
    };
    persist();
    return status();
  }

  async function failForRunningDesktop(code, message) {
    let running;
    try {
      running = normalizeProcesses(await listProcesses());
    } catch (error) {
      return failStatus(
        "failed",
        "process_check_failed",
        `无法确认 ChatGPT / Codex 是否已完全退出：${error?.message || String(error)}`,
      );
    }
    return failStatus("awaiting_manual_exit", code, message, {
      runningProcessIds: running.map((item) => item.processId).filter(Boolean),
    });
  }

  function failStatus(phase, failureCode, failureReason, extra = {}) {
    current = {
      ...current,
      ...extra,
      ok: false,
      phase,
      failureCode,
      failureReason,
      message: failureReason,
    };
    persist();
    return status();
  }

  function status() {
    return structuredClone(current);
  }

  return { prepare, execute, status };
}

function normalizePersistedState(value) {
  if (!value || typeof value !== "object" || value.version !== 1) {
    return { current: emptyStatus(), preparedPreview: null, launchTarget: "" };
  }
  const persistedCurrent = value.current && typeof value.current === "object"
    ? value.current
    : emptyStatus();
  return {
    current: { ...emptyStatus(), ...persistedCurrent },
    preparedPreview: value.preparedPreview && typeof value.preparedPreview === "object"
      ? value.preparedPreview
      : null,
    launchTarget: String(value.launchTarget || ""),
  };
}

function emptyStatus() {
  return {
    ok: false,
    phase: "idle",
    scanOnly: true,
    plannedInserts: 0,
    plannedUpdates: 0,
    actualInserted: 0,
    actualUpdated: 0,
    commitStatus: "not_started",
    backupDir: "",
    backupExists: false,
    rereadCatalogThreads: 0,
    rereadSidebarThreads: 0,
    runningProcessIds: [],
    failureCode: "",
    failureReason: "",
    message: "尚未生成恢复计划。",
  };
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`History recovery dependency ${name} must be a function.`);
  }
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeProcesses(processes) {
  return (Array.isArray(processes) ? processes : [])
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      ...item,
      processId: Number(item.processId || item.pid || 0),
    }));
}
