import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { getWorkspaceBinding, updateWorkspaceBinding } from "./conversation-store.js";
import { normalizeChatGptPreferences } from "./preference-compat.js";
import {readJsonState, writeJsonState, withJsonStateLock} from "./json-state-store.js";

const PROJECTS_FILE = "projects.json";

function nowIso() {
  return new Date().toISOString();
}

function compactTimestamp(iso) {
  return iso.replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "");
}

function projectIdFromDate(date = new Date()) {
  return `project_${compactTimestamp(date.toISOString())}_${randomBytes(3).toString("hex")}`;
}

function conversationIdFromDate(date = new Date()) {
  return `conv_${compactTimestamp(date.toISOString())}_${randomBytes(3).toString("hex")}`;
}

function projectsPath(storeRoot) {
  return path.join(storeRoot, PROJECTS_FILE);
}

function validProjectState(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.projects) &&
    (value.activeProjectId == null || typeof value.activeProjectId === "string") &&
    value.projects.every(project => project && typeof project === "object" && !Array.isArray(project) &&
      typeof project.id === "string" && project.id.length > 0 && typeof project.updatedAt === "string");
}

async function readProjectState(storeRoot) {
  const stored=await readJsonState(projectsPath(storeRoot),validProjectState);
  return stored.exists ? {...stored.value,activeProjectId:stored.value.activeProjectId || null} : {activeProjectId:null,projects:[]};
}

async function writeProjectState(storeRoot, state) {
  await writeJsonState(projectsPath(storeRoot),state,validProjectState);
}

function normalizeOptionalText(value) {
  const text = value?.trim();
  return text || null;
}

function projectNameFromInput(input = {}) {
  const explicit = normalizeOptionalText(input.name);
  if (explicit) {
    return explicit;
  }

  const repo = normalizeOptionalText(input.targetRepo);
  if (repo) {
    return repo.split(/[\\/]/).filter(Boolean).at(-1) || repo;
  }

  const url = normalizeOptionalText(input.chatgptProjectUrl);
  if (url) {
    return url.split("/").filter(Boolean).at(-1) || "GPT 会话";
  }

  return "未命名项目";
}

function normalizeProjectInput(input = {}, existing = null) {
  const updatedAt = nowIso();
  const hasPreferenceInput =
    Object.hasOwn(input, "modePreference") || Object.hasOwn(input, "modelPreference");
  const preferences = normalizeChatGptPreferences({
    modePreference:
      Object.hasOwn(input, "modePreference") ? input.modePreference : existing?.modePreference,
    modelPreference:
      Object.hasOwn(input, "modelPreference") ? input.modelPreference : existing?.modelPreference
  });
  return {
    id: existing?.id || input.id || projectIdFromDate(new Date(updatedAt)),
    name: projectNameFromInput(input) || existing?.name || "未命名项目",
    chatgptProjectUrl: normalizeOptionalText(input.chatgptProjectUrl) || existing?.chatgptProjectUrl || null,
    targetRepo: normalizeOptionalText(input.targetRepo) || existing?.targetRepo || null,
    conversationId:
      normalizeOptionalText(input.conversationId) ||
      existing?.conversationId ||
      conversationIdFromDate(new Date(updatedAt)),
    currentCodexThreadId:
      normalizeOptionalText(input.currentCodexThreadId) || existing?.currentCodexThreadId || null,
    modePreference: preferences.modePreference,
    modelPreference: preferences.modelPreference,
    preferenceUpdatedAt: hasPreferenceInput
      ? updatedAt
      : existing?.preferenceUpdatedAt || null,
    createdAt: existing?.createdAt || updatedAt,
    updatedAt
  };
}

function sortProjects(projects) {
  return [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function visibleProjects(projects = []) {
  return projects.filter((project) => !project.deletedAt);
}

async function createProjectLocked(storeRoot, input = {}) {
  const state = await readProjectState(storeRoot);
  const project = normalizeProjectInput(input);
  state.projects = sortProjects([project, ...state.projects]);
  state.activeProjectId = visibleProjects(state.projects).some((item) => item.id === state.activeProjectId)
    ? state.activeProjectId
    : project.id;
  await writeProjectState(storeRoot, state);
  return project;
}

function findCurrentSessionProject(state, currentCodexThreadId, input = {}) {
  const projectId = normalizeOptionalText(input.projectId);
  if (projectId) {
    return state.projects.find((project) => project.id === projectId && !project.deletedAt) || null;
  }

  const visible = visibleProjects(state.projects);
  const active = visible.find((project) => project.id === state.activeProjectId);
  if (active?.currentCodexThreadId === currentCodexThreadId) {
    return active;
  }

  return sortProjects(visible).find((project) => project.currentCodexThreadId === currentCodexThreadId) || null;
}

async function bindCurrentSessionProjectLocked(storeRoot, input = {}, options = {}) {
  const currentCodexThreadId =
    normalizeOptionalText(options.currentCodexThreadId) || normalizeOptionalText(input.currentCodexThreadId);
  if (!currentCodexThreadId) {
    throw new Error("Current Codex thread id is required to bind a Bridge project");
  }

  await getWorkspaceBinding(storeRoot);
  const state = await readProjectState(storeRoot);
  const existing = findCurrentSessionProject(state, currentCodexThreadId, input);
  const project = normalizeProjectInput(
    {
      ...existing,
      ...input,
      id: existing?.id || input.id,
      currentCodexThreadId
    },
    existing
  );

  state.projects = sortProjects(
    existing
      ? state.projects.map((item) => (item.id === existing.id ? project : item))
      : [project, ...state.projects]
  );
  state.activeProjectId = project.id;
  await writeProjectState(storeRoot, state);

  const workspace = await updateWorkspaceBinding(storeRoot, {
    projectId: project.id,
    chatgptProjectUrl: project.chatgptProjectUrl,
    targetRepo: project.targetRepo,
    conversationId: project.conversationId,
    currentCodexThreadId: project.currentCodexThreadId,
    modePreference: project.modePreference,
    modelPreference: project.modelPreference
  });

  return {
    activeProjectId: project.id,
    project,
    workspace,
    created: !existing
  };
}

export async function listProjects(storeRoot, options = {}) {
  const state = await readProjectState(storeRoot);
  const allProjects = sortProjects(visibleProjects(state.projects));
  const currentCodexThreadId = normalizeOptionalText(options.currentCodexThreadId);
  const projects = currentCodexThreadId
    ? allProjects.filter((project) => project.currentCodexThreadId === currentCodexThreadId)
    : allProjects;
  const otherProjects = currentCodexThreadId
    ? allProjects.filter((project) => project.currentCodexThreadId !== currentCodexThreadId)
    : [];
  const storedActiveProject = projects.find((project) => project.id === state.activeProjectId) || null;
  const activeProjectId = storedActiveProject?.id || projects[0]?.id || null;
  return {
    activeProjectId,
    projects,
    otherProjects
  };
}

export async function getProject(storeRoot, projectId) {
  const state = await readProjectState(storeRoot);
  const project = state.projects.find((item) => item.id === projectId && !item.deletedAt);
  if (!project) {
    throw new Error("Project not found");
  }
  return project;
}

async function updateProjectLocked(storeRoot, projectId, input = {}) {
  const state = await readProjectState(storeRoot);
  const existing = state.projects.find((item) => item.id === projectId && !item.deletedAt);
  if (!existing) {
    throw new Error("Project not found");
  }

  const project = normalizeProjectInput({ ...existing, ...input, id: projectId }, existing);
  state.projects = sortProjects(state.projects.map((item) => (item.id === projectId ? project : item)));
  await writeProjectState(storeRoot, state);
  return project;
}

async function deleteProjectLocked(storeRoot, projectId) {
  await getWorkspaceBinding(storeRoot);
  const state = await readProjectState(storeRoot);
  const existing = state.projects.find((item) => item.id === projectId && !item.deletedAt);
  if (!existing) {
    throw new Error("Project not found");
  }

  const deletedAt = nowIso();
  const deletedProject = {
    ...existing,
    deletedAt,
    updatedAt: deletedAt
  };
  state.projects = sortProjects(state.projects.map((item) => (item.id === projectId ? deletedProject : item)));

  const projects = sortProjects(visibleProjects(state.projects));
  const activeProjectId =
    state.activeProjectId === projectId || !projects.some((project) => project.id === state.activeProjectId)
      ? projects[0]?.id || null
      : state.activeProjectId;
  state.activeProjectId = activeProjectId;
  await writeProjectState(storeRoot, state);

  const nextProject = projects.find((project) => project.id === activeProjectId) || null;
  const workspace = await updateWorkspaceBinding(
    storeRoot,
    nextProject
      ? {
          projectId: nextProject.id,
          chatgptProjectUrl: nextProject.chatgptProjectUrl,
          targetRepo: nextProject.targetRepo,
          conversationId: nextProject.conversationId,
          modePreference: nextProject.modePreference,
          modelPreference: nextProject.modelPreference
        }
      : {
          projectId: null,
          chatgptProjectUrl: null,
          targetRepo: null,
          conversationId: null
        }
  );

  return {
    deletedProject,
    activeProjectId,
    project: nextProject,
    workspace
  };
}

async function ensureProjectForWorkspaceLocked(storeRoot, workspace = {}, options = {}) {
  if (!workspace.chatgptProjectUrl && !workspace.targetRepo) {
    return null;
  }

  const currentCodexThreadId = normalizeOptionalText(options.currentCodexThreadId);
  const state = await readProjectState(storeRoot);
  const existing =
    (workspace.projectId && state.projects.find((project) => project.id === workspace.projectId && !project.deletedAt)) ||
    state.projects.find(
      (project) =>
        !project.deletedAt &&
        project.chatgptProjectUrl === workspace.chatgptProjectUrl &&
        project.targetRepo === workspace.targetRepo
    );

  if (
    existing?.currentCodexThreadId &&
    currentCodexThreadId &&
    existing.currentCodexThreadId !== currentCodexThreadId
  ) {
    return null;
  }

  const project = normalizeProjectInput(
    {
      id: existing?.id || workspace.projectId || undefined,
      name: existing?.name || projectNameFromInput(workspace),
      chatgptProjectUrl: workspace.chatgptProjectUrl,
      targetRepo: workspace.targetRepo,
      conversationId: workspace.conversationId,
      currentCodexThreadId: existing ? existing.currentCodexThreadId : currentCodexThreadId,
      modePreference: workspace.modePreference,
      modelPreference: workspace.modelPreference
    },
    existing
  );

  state.projects = sortProjects(
    existing
      ? state.projects.map((item) => (item.id === existing.id ? project : item))
      : [project, ...state.projects]
  );
  state.activeProjectId = workspace.projectId || state.activeProjectId || project.id;
  await writeProjectState(storeRoot, state);
  return project;
}

async function selectProjectLocked(storeRoot, projectId) {
  await getWorkspaceBinding(storeRoot);
  const state = await readProjectState(storeRoot);
  const project = state.projects.find((item) => item.id === projectId && !item.deletedAt);
  if (!project) {
    throw new Error("Project not found");
  }

  const updatedProject = {
    ...project,
    updatedAt: nowIso()
  };
  state.activeProjectId = project.id;
  state.projects = sortProjects(state.projects.map((item) => (item.id === project.id ? updatedProject : item)));
  await writeProjectState(storeRoot, state);

  const workspace = await updateWorkspaceBinding(storeRoot, {
    projectId: updatedProject.id,
    chatgptProjectUrl: updatedProject.chatgptProjectUrl,
    targetRepo: updatedProject.targetRepo,
    conversationId: updatedProject.conversationId,
    modePreference: updatedProject.modePreference,
    modelPreference: updatedProject.modelPreference
  });

  return {
    activeProjectId: updatedProject.id,
    project: updatedProject,
    workspace
  };
}

// Lock order is projects -> workspace; workspace mutations never acquire the
// projects lock. Hold through nested binding updates to prevent selection races.
export function createProject(storeRoot,input={}) { return withJsonStateLock(projectsPath(storeRoot),()=>createProjectLocked(storeRoot,input)); }
export function claimUnboundProject(storeRoot, input) {
  return withJsonStateLock(projectsPath(storeRoot), async () => {
    const state = await readProjectState(storeRoot);
    const project = state.projects.find(p => p.id === input.projectId && !p.deletedAt);
    if (!project || project.conversationId !== input.conversationId) throw new Error("Project scope mismatch");
    if (!input.currentCodexThreadId) throw new Error("Current Codex thread is required");
    if (project.currentCodexThreadId) {
      if (project.currentCodexThreadId !== input.currentCodexThreadId) throw new Error("Project belongs to another Codex thread");
      return project;
    }
    if (!project.targetRepo || !input.cwd) throw new Error("Project directory is required for first-use binding");
    const [target, caller] = await Promise.all([realpath(project.targetRepo), realpath(input.cwd)]);
    const key = value => process.platform === "win32" ? value.toLowerCase() : value;
    if (key(target) !== key(caller)) throw new Error("Current Codex directory does not match the bound project");
    const bound = {...project, currentCodexThreadId: input.currentCodexThreadId, updatedAt: nowIso()};
    state.projects = state.projects.map(p => p.id === bound.id ? bound : p);
    await writeProjectState(storeRoot, state);
    return bound;
  });
}

export function bindCurrentSessionProject(storeRoot,input={},options={}) { return withJsonStateLock(projectsPath(storeRoot),()=>bindCurrentSessionProjectLocked(storeRoot,input,options)); }
export function updateProject(storeRoot,projectId,input={}) { return withJsonStateLock(projectsPath(storeRoot),()=>updateProjectLocked(storeRoot,projectId,input)); }
export function deleteProject(storeRoot,projectId) { return withJsonStateLock(projectsPath(storeRoot),()=>deleteProjectLocked(storeRoot,projectId)); }
export function ensureProjectForWorkspace(storeRoot,workspace={},options={}) { return withJsonStateLock(projectsPath(storeRoot),()=>ensureProjectForWorkspaceLocked(storeRoot,workspace,options)); }
export function selectProject(storeRoot,projectId) { return withJsonStateLock(projectsPath(storeRoot),()=>selectProjectLocked(storeRoot,projectId)); }
