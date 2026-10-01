import path from "node:path";

export function routerRecovery(run, job, { allowTerminal = false, platform = process.platform } = {}) {
  const stage = run?.stages?.[run.currentStageIndex];
  if (run?.transportId !== "web-sync" || run.status !== "failed" ||
      stage?.status !== "failed" || stage.submissionState !== "submitted" ||
      !stage.transportRequestId || !job ||
      (!allowTerminal && !["pending", "running"].includes(job.status)) ||
      !["capture", "resend"].includes(job.recoveryMode) ||
      !Number.isFinite(Date.parse(job.recoveryStartedAt || "")) ||
      run.stages.slice(run.currentStageIndex + 1).some(s => s.status !== "pending")) return null;
  const repo = value => value ? (platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)) : null;
  if (job.id !== stage.transportRequestId || job.routerRunId !== run.id ||
      !run.projectId || job.projectId !== run.projectId ||
      !run.conversationId || job.conversationId !== run.conversationId ||
      !run.codexThreadId || job.codexThreadId !== run.codexThreadId ||
      !run.targetRepo || repo(job.targetRepo) !== repo(run.targetRepo)) return null;
  return { mode: job.recoveryMode, startedAt: job.recoveryStartedAt, transportRequestId: job.id };
}

export function observeRouterRecovery(run, job, options) {
  const recovery = routerRecovery(run, job, options);
  if (!recovery) return null;
  const status = job.status === "pending" ? "queued" : "running";
  return {
    routerRun: { ...run, status, error: null, stages: run.stages.map((stage, index) =>
      index === run.currentStageIndex ? { ...stage, status, error: null, completedAt: null } : stage) },
    observationState: "recovering",
    recovery
  };
}
