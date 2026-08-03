function requireApi(api) {
  if (typeof api !== "function") {
    throw new TypeError("Bridge API client is required");
  }
  return api;
}

const REAL_CONVERSATION_HOST = "chatgpt.com";

export function displayProjectConversationUrl(value = "") {
  return String(value || "");
}

export function restoreProjectConversationUrl(value = "") {
  return String(value || "").replace(/g某t\.com/gi, REAL_CONVERSATION_HOST);
}

export function projectIdFromPageUrl(value = "") {
  try {
    return new URL(value).searchParams.get("project") || "";
  } catch {
    return "";
  }
}

export function withProjectIdInPageUrl(value = "", projectId = null) {
  const url = new URL(value);
  const normalizedProjectId = String(projectId || "").trim();
  if (normalizedProjectId) {
    url.searchParams.set("project", normalizedProjectId);
  } else {
    url.searchParams.delete("project");
  }
  return url.toString();
}

export function createProjectRefreshCoordinator() {
  let revision = 0;

  return {
    begin(projectId) {
      revision += 1;
      return {
        projectId: String(projectId || ""),
        revision
      };
    },
    invalidate() {
      revision += 1;
    },
    isCurrent(refresh, activeProjectId) {
      return Boolean(
        refresh &&
        refresh.revision === revision &&
        refresh.projectId &&
        refresh.projectId === String(activeProjectId || "")
      );
    }
  };
}

export async function runProjectRefresh({
  coordinator,
  projectId,
  getActiveProjectId,
  load,
  apply
}) {
  const refresh = coordinator.begin(projectId);
  const payload = await load(projectId);
  if (!coordinator.isCurrent(refresh, getActiveProjectId())) {
    return false;
  }
  await apply(payload, projectId);
  return true;
}

export async function selectProjectForScope({ api, projectId, currentCodexThreadId }) {
  const callApi = requireApi(api);
  if (currentCodexThreadId) {
    return callApi("/api/projects/current-session", {
      method: "POST",
      body: JSON.stringify({ projectId })
    });
  }

  return callApi(`/api/projects/${encodeURIComponent(projectId)}/select`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function saveProjectBindingForScope({
  api,
  currentCodexThreadId,
  activeProjectId,
  activeProjectName,
  patch
}) {
  const callApi = requireApi(api);
  if (currentCodexThreadId) {
    return callApi("/api/projects/current-session", {
      method: "POST",
      body: JSON.stringify({
        ...patch,
        projectId: activeProjectId || undefined,
        name: activeProjectName
      })
    });
  }

  if (!activeProjectId) {
    throw new Error("请先创建或选择一个项目。");
  }

  const projectPath = `/api/projects/${encodeURIComponent(activeProjectId)}`;
  await callApi(projectPath, {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
  return callApi(`${projectPath}/select`, {
    method: "POST",
    body: JSON.stringify({})
  });
}
