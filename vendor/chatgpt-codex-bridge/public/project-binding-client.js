function requireApi(api) {
  if (typeof api !== "function") {
    throw new TypeError("Bridge API client is required");
  }
  return api;
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
