import { getWorkspaceBinding } from "./conversation-store.js";
import { appendRoomMessage, completeCodexTask } from "./room-store.js";
import { createSyncJob } from "./sync-store.js";

function normalizeResultText(value) {
  const text = value?.trim();
  return text || "已完成。";
}

function shouldSyncToChatGpt(input = {}) {
  return Boolean(input.syncToChatGpt || input.syncToGpt);
}

export function buildCodexResultPayloadForGpt({ resultText, task, workspace }) {
  return [
    "# Codex 执行结果",
    "",
    normalizeResultText(resultText),
    "",
    "# 上下文",
    `本地项目：${task.targetRepo || workspace.targetRepo || "未绑定"}`,
    `房间会话：${task.conversationId || workspace.conversationId || "未绑定"}`,
    "",
    "请基于这个结果继续分析：如果已经完成，只给出简短确认和必要的验收建议；如果还需要继续，请给出下一步应该交给 Codex 的具体任务。"
  ].join("\n");
}

export async function completeRoomCodexTaskWithMessage(storeRoot, taskId, input = {}) {
  const task = await completeCodexTask(storeRoot, taskId, input);
  const resultText = normalizeResultText(input.resultText || task.resultText);
  const message = await appendRoomMessage(storeRoot, {
    conversationId: task.conversationId,
    from: "codex",
    to: ["user", "gpt"],
    text: resultText,
    metadata: {
      codexTaskId: task.id,
      targetRepo: task.targetRepo,
      source: "current_codex_thread",
      syncToChatGpt: shouldSyncToChatGpt(input)
    }
  });

  let syncJob = null;
  let syncWarning = null;

  if (shouldSyncToChatGpt(input)) {
    const workspace = await getWorkspaceBinding(storeRoot);
    const projectUrl = input.projectUrl || workspace.chatgptProjectUrl;

    if (projectUrl) {
      syncJob = await createSyncJob(storeRoot, {
        kind: "codex_result",
        projectUrl,
        targetRepo: input.targetRepo || task.targetRepo || workspace.targetRepo,
        conversationId: task.conversationId || workspace.conversationId,
        taskId: task.id,
        sourceMessageId: message.id,
        userText: resultText,
        payloadText: buildCodexResultPayloadForGpt({
          resultText,
          task,
          workspace
        }),
        modePreference: input.modePreference || workspace.modePreference,
        modelPreference: input.modelPreference || workspace.modelPreference
      });
    } else {
      syncWarning = "GPT 会话未绑定";
    }
  }

  return {
    task,
    message,
    syncJob,
    syncWarning
  };
}
