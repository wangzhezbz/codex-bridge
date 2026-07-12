import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import { appendEvent, getTask, pathsForTask, updateTask, writeResult } from "./task-store.js";

function manualResult(task, prompt) {
  return [
    "# 手动交给 Codex",
    "",
    "当前任务没有自动执行 Codex，只生成一份可以复制给 Codex 的交接内容。",
    "",
    `任务：${task.title}`,
    task.targetRepo ? `目标项目目录：${task.targetRepo}` : "目标项目目录：未指定",
    "",
    "准备好以后，把下面这段内容复制给 Codex：",
    "",
    "```text",
    prompt,
    "```"
  ].join("\n");
}

async function runManual(storeRoot, task) {
  const prompt = await readFile(task.promptPath, "utf8");
  await updateTask(storeRoot, task.id, { status: "waiting_for_codex" });
  const resultPath = await writeResult(storeRoot, task.id, manualResult(task, prompt.trim()), {
    status: "waiting_for_codex"
  });
  await appendEvent(storeRoot, task.id, {
    type: "runner.manual_handoff",
    resultPath
  });
  return { mode: "manual", status: "waiting_for_codex", resultPath };
}

function collectProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end();
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeoutMs = options.timeoutMs || 120000;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        timedOut
      });
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      finish({ code: timedOut ? 124 : code, stdout, stderr });
    });
  });
}

async function runCodexCli(storeRoot, task, options) {
  const prompt = await readFile(task.promptPath, "utf8");
  const cwd = task.targetRepo || options.cwd || process.cwd();
  const args = options.codexExtraArgs || buildCodexExecArgs(cwd, prompt.trim());

  await updateTask(storeRoot, task.id, { status: "running" });
  await appendEvent(storeRoot, task.id, {
    type: "runner.codex_started",
    cwd
  });

  const result = await collectProcess(options.codexCommand || "codex", args, {
    cwd,
    timeoutMs: options.timeoutMs
  });
  const status = result.code === 0 ? "succeeded" : "failed";
  const text = [
    "# Codex CLI result",
    "",
    `Exit code: ${result.code}`,
    result.timedOut ? "运行结果：超时，桥接器已停止这次 Codex 子进程。" : "运行结果：Codex 子进程已结束。",
    "",
    "## stdout",
    "",
    "```text",
    result.stdout.trim(),
    "```",
    "",
    "## stderr",
    "",
    "```text",
    result.stderr.trim(),
    "```"
  ].join("\n");

  const resultPath = await writeResult(storeRoot, task.id, text, { status });
  await appendEvent(storeRoot, task.id, {
    type: "runner.codex_finished",
    status,
    resultPath
  });

  return { mode: "codex", status, resultPath, exitCode: result.code, timedOut: result.timedOut };
}

export function buildCodexExecArgs(cwd, prompt) {
  return [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "-C",
    cwd,
    prompt
  ];
}

export async function runTask(storeRoot, taskId, options = {}) {
  const task = await getTask(storeRoot, taskId);
  const runnerMode = options.runnerMode || process.env.BRIDGE_RUNNER || "manual";

  if (runnerMode === "manual") {
    return runManual(storeRoot, task);
  }

  if (runnerMode === "codex") {
    return runCodexCli(storeRoot, task, options);
  }

  await appendEvent(storeRoot, task.id, {
    type: "runner.rejected",
    message: `Unsupported runner mode: ${runnerMode}`,
    paths: pathsForTask(storeRoot, task.id)
  });
  throw new Error(`Unsupported runner mode: ${runnerMode}`);
}
