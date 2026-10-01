function requireApi(api) {
  if (typeof api !== "function") {
    throw new TypeError("Bridge API client is required");
  }
  return api;
}

const REAL_CONVERSATION_HOST = "chatgpt.com";

export function projectsForPage(payload, hasPageScope) {
  const projects = payload.projects || [];
  if (hasPageScope) return projects;
  return [...new Map([...projects, ...(payload.otherProjects || [])].map(p => [p.id, p])).values()];
}

export async function pageUrlForSavedProject({ api, project, pageUrl }) {
  if (!project?.currentCodexThreadId) return null;
  const scope = await requireApi(api)("/api/scopes", {
    method: "POST",
    body: JSON.stringify({
      projectId: project.id,
      conversationId: project.conversationId,
      currentCodexThreadId: project.currentCodexThreadId
    })
  });
  if (!scope.scopeToken) throw new Error("未能打开项目，请重试。");
  const url = new URL(pageUrl);
  url.searchParams.set("scope", scope.scopeToken);
  url.searchParams.set("project", project.id);
  return url.toString();
}

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

export async function createNewProjectForScope({ api, input }) {
  const callApi = requireApi(api);
  // Creation must never use current-session, which intentionally updates an
  // existing binding for the service's calling thread.
  const created = await callApi("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      chatgptProjectUrl: input.chatgptProjectUrl,
      targetRepo: input.targetRepo
    })
  });
  return callApi(`/api/projects/${encodeURIComponent(created.project.id)}/select`, {
    method: "POST", body: JSON.stringify({})
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
