export function buildRoomCodexPrompt(task, options = {}) {
  const bridgeBaseUrl = options.bridgeBaseUrl || "http://127.0.0.1:4317";
  const targetRepo = task.targetRepo || "未指定";

  return [
    "# 来自三人工作房间的 Codex 消息",
    "",
    `任务 ID：${task.id}`,
    `目标项目目录：${targetRepo}`,
    "",
    task.promptText?.trim() || "用户没有提供可执行内容。",
    "",
    "# 处理方式",
    "",
    "你就是右侧房间里的 Codex 成员。请在当前 Codex 线程里正常处理这条消息。",
    "如果只是聊天，请直接回复；如果需要检查、修改或运行命令，请在本线程完成。",
    "",
    "完成后，把给用户看的结果回写到右侧房间：",
    "",
    `POST ${bridgeBaseUrl}/api/current-codex/${task.id}/complete`,
    "Content-Type: application/json",
    "",
    '{"resultText":"这里写 Codex 给用户的最终结果"}',
    "",
    "如果这个结果需要让 GPT 继续分析或复核，可以显式开启同步：",
    "",
    '{"resultText":"这里写 Codex 给用户的最终结果","syncToChatGpt":true}',
    "",
    "如果无法完成，把失败原因回写：",
    "",
    `POST ${bridgeBaseUrl}/api/current-codex/${task.id}/fail`,
    "Content-Type: application/json",
    "",
    '{"error":"这里写失败原因"}'
  ].join("\n");
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function requestOverSocket(socket, method, params, nextId, timeoutMs) {
  const id = nextId();
  const payload = {
    jsonrpc: "2.0",
    id,
    method,
    params
  };

  return withTimeout(
    new Promise((resolve, reject) => {
      function onMessage(event) {
        const message = JSON.parse(event.data);
        if (message.id !== id) {
          return;
        }
        if (message.error) {
          reject(new Error(JSON.stringify(message.error)));
          return;
        }
        resolve(message.result);
      }

      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify(payload));
    }),
    timeoutMs,
    method
  );
}

export async function relayCodexTaskToThread(task, options = {}) {
  if (!task.currentThreadId) {
    return {
      status: "skipped",
      reason: "missing_current_thread_id"
    };
  }

  const appServerUrl = options.appServerUrl || "ws://127.0.0.1:43219";
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;

  if (!WebSocketImpl) {
    throw new Error("WebSocket is not available in this Node runtime");
  }

  let counter = 1;
  const nextId = () => counter++;
  const timeoutMs = options.timeoutMs || 10000;
  const socket = new WebSocketImpl(appServerUrl);

  await withTimeout(
    new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", () => reject(new Error(`Cannot connect to ${appServerUrl}`)));
    }),
    timeoutMs,
    "codex app-server connection"
  );

  try {
    await requestOverSocket(
      socket,
      "initialize",
      {
        clientInfo: {
          name: "chatgpt-codex-bridge",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      },
      nextId,
      timeoutMs
    );

    await requestOverSocket(
      socket,
      "thread/resume",
      {
        threadId: task.currentThreadId,
        excludeTurns: true
      },
      nextId,
      timeoutMs
    );

    const result = await requestOverSocket(
      socket,
      "turn/start",
      {
        threadId: task.currentThreadId,
        input: [
          {
            type: "text",
            text: buildRoomCodexPrompt(task, options)
          }
        ],
        cwd: task.targetRepo || null,
        responsesapiClientMetadata: {
          bridge_room_codex_task_id: task.id
        }
      },
      nextId,
      timeoutMs
    );

    return {
      status: "sent",
      result
    };
  } finally {
    socket.close();
  }
}
