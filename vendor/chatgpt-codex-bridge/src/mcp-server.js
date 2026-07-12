#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import { createBridgeTools } from "./bridge-tools.js";

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ],
    structuredContent: value
  };
}

export function createMcpServer(options = {}) {
  const tools = createBridgeTools(options);
  const server = new McpServer({
    name: "chatgpt-codex-bridge",
    version: "0.1.0"
  });

  server.registerTool(
    "create_task",
    {
      description: "Create a bridge task for Codex. Set run=true to hand it to the configured runner.",
      inputSchema: {
        title: z.string().min(1).describe("Short task title"),
        prompt: z.string().min(1).describe("Full prompt for Codex"),
        targetRepo: z.string().optional().describe("Optional absolute path to the target repository"),
        run: z.boolean().optional().describe("Whether to immediately run the configured bridge runner")
      }
    },
    async (input) => textResult(await tools.createTask(input))
  );

  server.registerTool(
    "list_tasks",
    {
      description: "List bridge tasks newest-first.",
      inputSchema: {}
    },
    async () => textResult(await tools.listTasks())
  );

  server.registerTool(
    "get_task_status",
    {
      description: "Read task metadata and event history.",
      inputSchema: {
        taskId: z.string().min(1).describe("Bridge task id")
      }
    },
    async (input) => textResult(await tools.getTaskStatus(input))
  );

  server.registerTool(
    "get_task_result",
    {
      description: "Read the RESULT.md content for a bridge task.",
      inputSchema: {
        taskId: z.string().min(1).describe("Bridge task id")
      }
    },
    async (input) => textResult(await tools.getTaskResult(input))
  );

  server.registerTool(
    "request_revision",
    {
      description: "Create a follow-up revision task tied to an earlier bridge task.",
      inputSchema: {
        taskId: z.string().min(1).describe("Original bridge task id"),
        prompt: z.string().min(1).describe("Revision request")
      }
    },
    async (input) => textResult(await tools.requestRevision(input))
  );

  server.registerTool(
    "list_codex_inbox",
    {
      description: "List GPT-session instructions waiting for the current Codex thread.",
      inputSchema: {}
    },
    async () => textResult(await tools.listInboxItems())
  );

  server.registerTool(
    "claim_next_codex_inbox_item",
    {
      description: "Claim the oldest pending GPT-session instruction for this Codex thread.",
      inputSchema: {
        workerId: z.string().optional().describe("Identifier for the Codex thread claiming the item")
      }
    },
    async (input) => textResult(await tools.claimNextInboxItem(input))
  );

  server.registerTool(
    "complete_codex_inbox_item",
    {
      description: "Mark a claimed Codex inbox item complete after the current Codex thread executes it.",
      inputSchema: {
        itemId: z.string().min(1).describe("Inbox item id"),
        resultText: z.string().describe("Execution result to record locally")
      }
    },
    async (input) => textResult(await tools.completeInboxItem(input))
  );

  server.registerTool(
    "fail_codex_inbox_item",
    {
      description: "Mark a Codex inbox item failed when the current Codex thread cannot execute it.",
      inputSchema: {
        itemId: z.string().min(1).describe("Inbox item id"),
        error: z.string().describe("Failure reason")
      }
    },
    async (input) => textResult(await tools.failInboxItem(input))
  );

  server.registerTool(
    "list_room_messages",
    {
      description: "List the shared user, GPT, and Codex room messages.",
      inputSchema: {
        conversationId: z.string().optional().describe("Optional room conversation id")
      }
    },
    async (input) => textResult(await tools.listRoomMessages(input))
  );

  server.registerTool(
    "bind_current_codex_session",
    {
      description:
        "Bind this running Codex thread to its own Bridge project, GPT conversation URL, local project directory, and routing rules before delegating work.",
      inputSchema: {
        projectId: z.string().optional().describe("Optional existing Bridge project id to claim for this Codex thread"),
        name: z.string().optional().describe("Bridge project name shown in the right-side Bridge page"),
        chatgptProjectUrl: z.string().min(1).describe("GPT conversation or project URL to use for this Codex thread"),
        targetRepo: z.string().min(1).describe("Absolute local project directory for this Codex thread"),
        conversationId: z.string().optional().describe("Optional existing Bridge room conversation id")
      }
    },
    async (input) => textResult(await tools.bindCurrentCodexSession(input))
  );

  server.registerTool(
    "ask_chatgpt_project",
    {
      description: "Ask the bound GPT session from the current Codex thread and create a GPT sync job.",
      inputSchema: {
        projectId: z.string().optional().describe("Bridge project id. Provide projectId or conversationId to avoid cross-room routing."),
        conversationId: z
          .string()
          .optional()
          .describe("Bridge conversation id. Provide projectId or conversationId to avoid cross-room routing."),
        text: z.string().min(1).describe("Question or context Codex wants to send to GPT"),
        reason: z.string().optional().describe("Optional reason for the consultation")
      }
    },
    async (input) => textResult(await tools.askChatGptProject(input))
  );

  server.registerTool(
    "delegate_current_request",
    {
      description:
        "Route the current Codex user request through Bridge policy. It either keeps local work in Codex or sends GPT-suitable text/files to the bound GPT session.",
      inputSchema: {
        projectId: z.string().optional().describe("Bridge project id. Provide projectId or conversationId to avoid cross-room routing."),
        conversationId: z
          .string()
          .optional()
          .describe("Bridge conversation id. Provide projectId or conversationId to avoid cross-room routing."),
        text: z.string().min(1).describe("The current user request from this Codex thread"),
        localPath: z.string().optional().describe("Optional single local file path attached to the current request"),
        filename: z.string().optional().describe("Optional display filename for the single local file"),
        contentType: z.string().optional().describe("Optional MIME type for the single local file"),
        localFiles: z
          .array(
            z.object({
              localPath: z.string().min(1).describe("Absolute local file path available to this Codex thread"),
              filename: z.string().optional().describe("Optional display filename"),
              contentType: z.string().optional().describe("Optional MIME type")
            })
          )
          .optional()
          .describe("Optional files attached to the current request"),
        attachmentCount: z.number().optional().describe("Attachment count when files are not listed explicitly"),
        hasAttachments: z.boolean().optional().describe("Whether the request has attachments"),
        waitForGpt: z
          .boolean()
          .optional()
          .describe(
            "Wait for the GPT-session reply before returning. Defaults to true for delegated local file analysis; pass false only for queue-only handoff."
          ),
        timeoutMs: z.number().optional().describe("How long to wait for GPT before returning"),
        pollMs: z.number().optional().describe("How often to check the local sync job while waiting"),
        modePreference: z.string().optional().describe("Optional GPT mode to use"),
        modelPreference: z.string().optional().describe("Optional GPT model to use")
      }
    },
    async (input) => textResult(await tools.delegateCurrentRequest(input))
  );

  server.registerTool(
    "continue_router_run",
    {
      description:
        "Continue a persisted Router V2 run under the exact Bridge project, GPT conversation, and current Codex thread scope.",
      inputSchema: {
        runId: z.string().min(1).describe("Router Run id returned by delegate_current_request"),
        projectId: z.string().min(1).describe("Bridge project id that owns the Router Run"),
        conversationId: z.string().min(1).describe("GPT conversation id that owns the Router Run"),
        waitForGpt: z
          .boolean()
          .optional()
          .describe("When true, keep advancing successful stages until the run stops or completes"),
        timeoutMs: z.number().optional().describe("How long to wait for the current GPT stage"),
        pollMs: z.number().optional().describe("How often to check the current GPT stage")
      }
    },
    async (input) => textResult(await tools.continueRouterRun(input))
  );

  server.registerTool(
    "cancel_router_run",
    {
      description:
        "Cancel the current stage of a persisted Router V2 run under its exact Bridge scope.",
      inputSchema: {
        runId: z.string().min(1).describe("Router Run id returned by delegate_current_request"),
        projectId: z.string().min(1).describe("Bridge project id that owns the Router Run"),
        conversationId: z.string().min(1).describe("GPT conversation id that owns the Router Run"),
        reason: z.string().optional().describe("Optional cancellation reason")
      }
    },
    async (input) => textResult(await tools.cancelRouterRun(input))
  );

  server.registerTool(
    "read_chatgpt_project_answer",
    {
      description: "Read the current status or reply for a GPT-session sync job created by Codex.",
      inputSchema: {
        syncJobId: z.string().min(1).describe("Sync job id returned by ask_chatgpt_project")
      }
    },
    async (input) => textResult(await tools.readChatGptProjectAnswer(input))
  );

  server.registerTool(
    "send_local_file_to_chatgpt_project",
    {
      description:
        "Send a local file that the user gave to this current Codex thread to the bound GPT session for analysis.",
      inputSchema: {
        projectId: z.string().optional().describe("Bridge project id. Provide projectId or conversationId to avoid cross-room routing."),
        conversationId: z
          .string()
          .optional()
          .describe("Bridge conversation id. Provide projectId or conversationId to avoid cross-room routing."),
        localPath: z.string().min(1).describe("Absolute local file path available to this Codex thread"),
        filename: z.string().optional().describe("Optional display filename for GPT and the artifact library"),
        contentType: z.string().optional().describe("Optional MIME type, such as image/png or text/plain"),
        note: z.string().optional().describe("What GPT should analyze or answer about this file"),
        modePreference: z.string().optional().describe("Optional GPT mode to use for the analysis"),
        modelPreference: z.string().optional().describe("Optional GPT model to use for the analysis")
      }
    },
    async (input) => textResult(await tools.sendLocalFileToChatGptProject(input))
  );

  server.registerTool(
    "send_local_file_to_chatgpt_project_and_wait",
    {
      description:
        "Send a local file from the current Codex thread to GPT, then wait for the reply and return it in one call.",
      inputSchema: {
        projectId: z.string().optional().describe("Bridge project id. Provide projectId or conversationId to avoid cross-room routing."),
        conversationId: z
          .string()
          .optional()
          .describe("Bridge conversation id. Provide projectId or conversationId to avoid cross-room routing."),
        localPath: z.string().min(1).describe("Absolute local file path available to this Codex thread"),
        filename: z.string().optional().describe("Optional display filename for GPT and the artifact library"),
        contentType: z.string().optional().describe("Optional MIME type, such as image/png or text/plain"),
        note: z.string().optional().describe("What GPT should analyze or answer about this file"),
        modePreference: z.string().optional().describe("Optional GPT mode to use for the analysis"),
        modelPreference: z.string().optional().describe("Optional GPT model to use for the analysis"),
        timeoutMs: z.number().optional().describe("How long Codex should wait for GPT before returning"),
        pollMs: z.number().optional().describe("How often to check the local sync job while waiting")
      }
    },
    async (input) => textResult(await tools.sendLocalFileToChatGptProjectAndWait(input))
  );

  server.registerTool(
    "wait_for_chatgpt_project_answer",
    {
      description: "Wait for a previously queued GPT-session sync job to finish.",
      inputSchema: {
        syncJobId: z.string().min(1).describe("Sync job id returned by a GPT-session bridge tool"),
        timeoutMs: z.number().optional().describe("How long Codex should wait for GPT before returning"),
        pollMs: z.number().optional().describe("How often to check the local sync job while waiting")
      }
    },
    async (input) => textResult(await tools.waitForChatGptProjectAnswer(input))
  );

  server.registerTool(
    "list_artifacts",
    {
      description:
        "List files downloaded from GPT replies for Codex post-processing. If projectSavedPath is present, use it directly instead of searching the filesystem.",
      inputSchema: {
        syncJobId: z.string().optional().describe("Optional sync job id to filter artifacts"),
        conversationId: z.string().optional().describe("Optional room conversation id to filter artifacts")
      }
    },
    async (input) => textResult(await tools.listArtifacts(input))
  );

  server.registerTool(
    "read_artifact_text",
    {
      description: "Read a downloaded GPT artifact as UTF-8 text when it is a text-like file.",
      inputSchema: {
        artifactId: z.string().min(1).describe("Artifact id returned by list_artifacts or a sync job"),
        maxChars: z.number().optional().describe("Maximum characters to return")
      }
    },
    async (input) => textResult(await tools.readArtifactText(input))
  );

  server.registerTool(
    "claim_next_room_codex_task",
    {
      description: "Claim the oldest pending room task assigned to this current Codex thread.",
      inputSchema: {
        currentThreadId: z.string().optional().describe("Current Codex thread id"),
        workerId: z.string().optional().describe("Identifier for the Codex worker claiming the task")
      }
    },
    async (input) => textResult(await tools.claimNextRoomCodexTask(input))
  );

  server.registerTool(
    "complete_room_codex_task",
    {
      description: "Complete a claimed room Codex task and write the Codex answer back into the shared room.",
      inputSchema: {
        taskId: z.string().min(1).describe("Room Codex task id"),
        resultText: z.string().describe("Execution result to show as the Codex room message"),
        syncToChatGpt: z
          .boolean()
          .optional()
          .describe("When true, also queue this Codex result back to the bound GPT session"),
        modePreference: z.string().optional().describe("Optional GPT mode to use when syncing the result"),
        modelPreference: z.string().optional().describe("Optional GPT model to use when syncing the result")
      }
    },
    async (input) => textResult(await tools.completeRoomCodexTask(input))
  );

  server.registerTool(
    "fail_room_codex_task",
    {
      description: "Mark a room Codex task failed when this Codex thread cannot execute it.",
      inputSchema: {
        taskId: z.string().min(1).describe("Room Codex task id"),
        error: z.string().describe("Failure reason")
      }
    },
    async (input) => textResult(await tools.failRoomCodexTask(input))
  );

  return server;
}

export function installMcpShutdownHandlers(options = {}) {
  const server = options.server;
  const processRef = options.processRef || process;
  const logger = options.logger || console;
  const listeners = [];
  let closePromise = null;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  function close(reason = "manual") {
    if (closePromise) {
      return closePromise;
    }
    closePromise = Promise.resolve()
      .then(() => server.close())
      .then(
        () => {
          processRef.exitCode = 0;
          logger.error?.(`GPT Codex Bridge MCP shutdown complete: ${reason}`);
          resolveClosed({ error: null });
          return { error: null };
        },
        (error) => {
          processRef.exitCode = 1;
          logger.error?.(`GPT Codex Bridge MCP shutdown failed: ${error.message || error}`);
          resolveClosed({ error });
          return { error };
        }
      );
    return closePromise;
  }

  function listen(emitter, event, reason) {
    if (!emitter?.on) {
      return;
    }
    const handler = () => void close(reason);
    emitter.on(event, handler);
    listeners.push([emitter, event, handler]);
  }

  listen(processRef, "SIGTERM", "SIGTERM");
  listen(processRef, "SIGINT", "SIGINT");
  listen(processRef.stdin, "end", "stdin-end");
  listen(processRef.stdin, "close", "stdin-close");

  function dispose() {
    for (const [emitter, event, handler] of listeners) {
      emitter.off?.(event, handler);
    }
    listeners.length = 0;
  }

  return { close, closed, dispose };
}

export async function startMcpServer(options = {}) {
  const server = createMcpServer(options);
  const transport = options.transport || new StdioServerTransport();
  await server.connect(transport);
  const lifecycle = installMcpShutdownHandlers({
    server,
    processRef: options.processRef || process,
    logger: options.logger || console
  });
  console.error("GPT Codex Bridge MCP server running on stdio");
  return { lifecycle, server, transport };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startMcpServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
