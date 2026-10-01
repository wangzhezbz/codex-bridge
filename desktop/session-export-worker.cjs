const path = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");

const ACTIONS = new Set(["session", "project", "loose", "all", "filtered"]);
const MAX_MARKDOWN_BYTES = 32 * 1024 * 1024;
const MAX_ID_CHARS = 512;

(async () => {
  try {
    const action = String(workerData?.action || "").trim();
    const homeDir = String(workerData?.homeDir || "").trim();
    const payload = workerData?.payload && typeof workerData.payload === "object"
      ? workerData.payload
      : {};
    if (!ACTIONS.has(action) || !path.isAbsolute(homeDir)) {
      throw exportError("session_export_request_invalid", "会话导出请求无效。");
    }
    if ((action === "session" && String(payload.sessionId || "").length > MAX_ID_CHARS)
      || (action === "project" && String(payload.projectKey || "").length > MAX_ID_CHARS)) {
      throw exportError("session_export_request_invalid", "会话导出请求无效。");
    }
    const settings = await import("./settings.mjs");
    let exported;
    if (action === "session") {
      exported = settings.exportCodexSessionMarkdown(String(payload.sessionId || ""), { homeDir });
    } else if (action === "project") {
      exported = settings.exportCodexProjectMarkdown(String(payload.projectKey || ""), { homeDir });
    } else if (action === "loose") {
      exported = settings.exportCodexLooseSessionsMarkdown({ homeDir });
    } else if (action === "filtered") {
      exported = settings.exportCodexFilteredSessionsMarkdown({
        homeDir,
        sessionIds: Array.isArray(payload.sessionIds) ? payload.sessionIds.slice(0, 1000) : [],
        filterText: String(payload.filterText || "").slice(0, 1000),
      });
    } else {
      exported = settings.exportCodexSessionTreeMarkdown({ homeDir });
    }
    const markdown = String(exported.markdown || "");
    const markdownBytes = Buffer.byteLength(markdown, "utf8");
    if (markdownBytes > MAX_MARKDOWN_BYTES) {
      throw exportError(
        "session_export_too_large",
        `会话导出内容超过 ${MAX_MARKDOWN_BYTES} bytes，请使用筛选导出缩小范围。`,
      );
    }
    parentPort.postMessage({
      ok: true,
      result: publicExportResult(action, exported, markdown, markdownBytes),
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      code: String(error?.code || "session_export_failed"),
      error: error?.message || String(error),
    });
  }
})();

function publicExportResult(action, exported, markdown, markdownBytes) {
  const base = { markdown, markdownBytes };
  if (action === "session") {
    return {
      ...base,
      session: {
        id: String(exported.session?.id || ""),
        title: String(exported.session?.title || ""),
      },
      databasePath: String(exported.databasePath || ""),
    };
  }
  if (action === "project") {
    return {
      ...base,
      project: {
        key: String(exported.project?.key || ""),
        name: String(exported.project?.name || ""),
        sessionCount: Array.isArray(exported.project?.sessions) ? exported.project.sessions.length : 0,
      },
    };
  }
  if (action === "loose") {
    return {
      ...base,
      group: {
        key: String(exported.group?.key || "loose"),
        name: String(exported.group?.name || "No-project sessions"),
        sessionCount: Array.isArray(exported.group?.sessions) ? exported.group.sessions.length : 0,
      },
    };
  }
  return {
    ...base,
    tree: { summary: { ...(exported.tree?.summary || {}) } },
    ...(action === "filtered" ? { filterText: String(exported.filterText || "") } : {}),
  };
}

function exportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
