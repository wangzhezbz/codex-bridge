import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  authorizeDesktopPath,
  authorizeInstallRoot,
  authorizeSkillsRoot,
  isOwnedPath,
  isValidOwnershipState,
  readFixedDirectoryCapability,
  readInstallRootCapability,
  revalidateFixedDirectoryCapability,
  revalidateInstallRootCapability,
  resolveSkillTarget,
  validateInstallRoot,
} from "../desktop/software-manager/path-policy.mjs";

const CANONICAL_SKILLS_ROOT = "C:\\Users\\me\\.codex\\skills";

function fixtureEnv() {
  return {
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    USERPROFILE: "C:\\Users\\me",
  };
}

async function allowAccess() {}

for (const candidate of [
  "C:\\",
  "C:\\Windows",
  "C:\\Windows\\System32\\CodexBridge",
  "C:\\Program Files",
  "C:\\Program Files\\CodexBridge",
  "C:\\Program Files (x86)\\CodexBridge",
  "C:\\Users\\me\\Desktop\\CodexBridge",
  "C:\\Users\\me\\Documents\\CodexBridge",
  "C:\\Users\\me\\.codex",
  "C:\\Users\\me\\.codex\\managed",
  "\\\\server\\share",
]) {
  test(`rejects unsafe install root ${candidate}`, async () => {
    const result = await validateInstallRoot({
      candidate,
      env: fixtureEnv(),
      maxRelativePath: 180,
      access: allowAccess,
    });
    assert.equal(result.ok, false);
  });
}

test("accepts a normalized writable application directory", async () => {
  const result = await validateInstallRoot({
    candidate: "C:\\Tools\\CodexBridge\\",
    env: fixtureEnv(),
    maxRelativePath: 180,
    access: allowAccess,
  });
  assert.deepEqual(result, { ok: true, path: "C:\\Tools\\CodexBridge" });
});

test("main-process path authorities issue opaque fixed roots only after canonical no-follow validation", async () => {
  const directoryStat = { dev: 1, ino: 10, isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false };
  const install = await authorizeInstallRoot({
    candidate: "D:\\CBApps", env: fixtureEnv(), maxRelativePath: 180, access: allowAccess,
    realpath: async (value) => value, lstat: async () => directoryStat,
  });
  const skills = await authorizeSkillsRoot({
    candidate: CANONICAL_SKILLS_ROOT, realpath: async (value) => value, lstat: async () => directoryStat,
  });
  const desktop = await authorizeDesktopPath({
    getDesktopPath: () => "C:\\Users\\me\\Desktop",
    realpath: async (value) => value, lstat: async () => directoryStat,
  });
  assert.equal(readInstallRootCapability(install), "D:\\CBApps");
  assert.deepEqual(readFixedDirectoryCapability(skills), { kind: "skills", path: CANONICAL_SKILLS_ROOT });
  assert.deepEqual(readFixedDirectoryCapability(desktop), { kind: "desktop", path: "C:\\Users\\me\\Desktop" });
  assert.throws(() => readInstallRootCapability({ path: "D:\\CBApps" }), /capability/);
});

test("path authorities revalidate directory identity and the current peak-path budget before use", async () => {
  let identity = 10;
  const lstat = async () => ({
    dev: 1, ino: identity,
    isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false,
  });
  const install = await authorizeInstallRoot({
    candidate: "D:\\CBApps", env: fixtureEnv(), maxRelativePath: 180, access: allowAccess,
    realpath: async (value) => value, lstat,
  });
  const skills = await authorizeSkillsRoot({
    candidate: CANONICAL_SKILLS_ROOT, realpath: async (value) => value, lstat,
  });
  assert.equal(await revalidateInstallRootCapability(install, { maxRelativePath: 180 }), "D:\\CBApps");
  assert.deepEqual(await revalidateFixedDirectoryCapability(skills), { kind: "skills", path: CANONICAL_SKILLS_ROOT });
  await assert.rejects(revalidateInstallRootCapability(install, { maxRelativePath: 251 }), /path_too_long/u);
  identity = 11;
  await assert.rejects(revalidateInstallRootCapability(install, { maxRelativePath: 180 }), /identity_changed/u);
  await assert.rejects(revalidateFixedDirectoryCapability(skills), /identity_changed/u);
});

test("fixed path authorities reject reparse roots and a renderer-provided desktop replacement", async () => {
  const reparse = { isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => true };
  await assert.rejects(authorizeSkillsRoot({
    candidate: CANONICAL_SKILLS_ROOT, realpath: async (value) => value, lstat: async () => reparse,
  }), /reparse/);
  await assert.rejects(authorizeDesktopPath({
    getDesktopPath: () => "C:\\Users\\me\\Desktop\\..\\Documents",
    realpath: async (value) => value, lstat: async () => ({
      isDirectory: () => true, isSymbolicLink: () => false, isReparsePoint: () => false,
    }),
  }), /noncanonical/);
});

for (const candidate of [
  "//server/share/CodexBridge",
  "C:\\Portable\\.CODEX\\managed",
  "D:\\staging\\.codex\\manager",
  "C:\\Tools.\\CodexBridge",
  "C:\\Tools \\CodexBridge",
  "C:\\Tools\\CodexBridge. ",
  "C:\\CON\\CodexBridge",
  "C:\\Tools\\NUL.txt\\CodexBridge",
]) {
  test(`rejects non-canonical or protected install root ${candidate}`, async () => {
    const result = await validateInstallRoot({
      candidate,
      env: fixtureEnv(),
      maxRelativePath: 100,
      access: allowAccess,
    });
    assert.equal(result.ok, false);
  });
}

test("rejects install roots containing parent traversal", async () => {
  const result = await validateInstallRoot({
    candidate: "C:\\Tools\\staging\\..\\CodexBridge",
    env: fixtureEnv(),
    maxRelativePath: 180,
    access: allowAccess,
  });
  assert.deepEqual(result, { ok: false, error: "install_path_traversal" });
});

test("rejects an install root that is not writable", async () => {
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const result = await validateInstallRoot({
    candidate: "D:\\Apps\\CodexBridge",
    env: fixtureEnv(),
    maxRelativePath: 180,
    access: async () => { throw denied; },
  });
  assert.deepEqual(result, { ok: false, error: "install_root_unwritable" });
});

test("accepts a peak path of 259 characters and rejects 260", async () => {
  const prefix = "D:\\Apps\\";
  const maxRelativePath = 180;
  const accepted = `${prefix}${"a".repeat(259 - maxRelativePath - 1 - prefix.length)}`;
  const rejected = `${accepted}b`;

  assert.equal((await validateInstallRoot({
    candidate: accepted,
    env: fixtureEnv(),
    maxRelativePath,
    access: allowAccess,
  })).ok, true);
  assert.deepEqual(await validateInstallRoot({
    candidate: rejected,
    env: fixtureEnv(),
    maxRelativePath,
    access: allowAccess,
  }), { ok: false, error: "install_peak_path_too_long" });
});

test("Skill target is derived as a direct child of the canonical Skills root", async () => {
  const skillsRoot = path.resolve("fixture", "Skills");
  const target = await resolveSkillTarget({
    skillsRoot,
    skillId: "documents",
    realpath: async () => skillsRoot,
    lstat: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  });
  assert.equal(target, path.join(skillsRoot, "documents"));
});

for (const skillId of ["..", "documents/escape", "Documents", "-documents", "a".repeat(65)]) {
  test(`rejects unsafe Skill ID ${skillId}`, async () => {
    await assert.rejects(resolveSkillTarget({
      skillsRoot: path.resolve("fixture", "Skills"),
      skillId,
      realpath: async (value) => value,
      lstat: async () => null,
    }), { code: "skill_id_rejected" });
  });
}

for (const stat of [
  { isSymbolicLink: () => true },
  { isSymbolicLink: () => false, isReparsePoint: () => true },
]) {
  test("Skill target must be a non-link direct child of the canonical Skills root", async () => {
    const skillsRoot = path.resolve("fixture", "Skills");
    await assert.rejects(resolveSkillTarget({
      skillsRoot,
      skillId: "documents",
      realpath: async () => skillsRoot,
      lstat: async () => stat,
    }), /reparse|link/i);
  });
}

test("ownership rejects sibling-prefix escapes and recognizes explicit owned paths", () => {
  const ownership = {
    schemaVersion: 1,
    generation: 0,
    installRoot: "C:\\Tools\\CodexBridge",
    components: {
      git: { installPath: "C:\\Tools\\CodexBridge\\components\\git" },
      chatgpt: {
        installPath: "C:\\Tools\\CodexBridge\\c",
        entrypointPath: "C:\\Tools\\CodexBridge\\c\\ChatGPT.exe",
      },
    },
    skills: { documents: { target: "C:\\Users\\me\\.codex\\skills\\documents" } },
    shortcuts: [{
      componentId: "chatgpt", name: "ChatGPT", path: "C:\\Users\\me\\Desktop\\ChatGPT.lnk",
      desktopPath: "C:\\Users\\me\\Desktop",
      targetPath: "C:\\Tools\\CodexBridge\\c\\ChatGPT.exe", creationId: "a".repeat(32),
    }],
    rollback: [{ path: "D:\\CodexBridgeRollback\\chatgpt" }],
    activeTask: null,
    lastTask: null,
  };

  assert.equal(isOwnedPath({
    target: "C:\\Tools\\CodexBridge\\components\\git\\bin\\git.exe",
    ownership,
    skillsRoot: CANONICAL_SKILLS_ROOT,
  }), true);
  assert.equal(isOwnedPath({
    target: "C:\\Users\\me\\.codex\\skills\\documents\\SKILL.md",
    ownership,
    skillsRoot: CANONICAL_SKILLS_ROOT,
  }), true);
  assert.equal(isOwnedPath({
    target: "C:\\Users\\me\\Desktop\\ChatGPT.lnk",
    ownership,
    skillsRoot: CANONICAL_SKILLS_ROOT,
  }), true);
  assert.equal(isOwnedPath({
    target: "C:\\Tools\\CodexBridge-old\\payload.exe",
    ownership,
    skillsRoot: CANONICAL_SKILLS_ROOT,
  }), false);
  assert.equal(isOwnedPath({
    target: "C:\\Tools\\CodexBridge\\..\\foreign",
    ownership,
    skillsRoot: CANONICAL_SKILLS_ROOT,
  }), false);
});

test("Skill ownership is bound to the canonical Skills root supplied by the main process", () => {
  const ownership = {
    ...validOwnership(),
    skills: { documents: { target: "C:\\Users\\me\\.codex\\skills\\documents" } },
  };

  assert.equal(isValidOwnershipState(ownership, { skillsRoot: CANONICAL_SKILLS_ROOT }), true);
  assert.equal(isOwnedPath({
    target: "C:\\Users\\me\\.codex\\skills\\documents\\SKILL.md",
    ownership,
    skillsRoot: CANONICAL_SKILLS_ROOT,
  }), true);
});

test("Skill ownership fails closed without a canonical Skills root context", () => {
  const ownership = {
    ...validOwnership(),
    skills: { documents: { target: "C:\\Users\\me\\.codex\\skills\\documents" } },
  };

  assert.equal(isValidOwnershipState(ownership), false);
  assert.equal(isOwnedPath({
    target: "C:\\Users\\me\\.codex\\skills\\documents\\SKILL.md",
    ownership,
  }), false);
});

for (const [label, target] of [
  ["Windows prefix with the same .codex suffix", "C:\\Windows\\.codex\\skills\\documents"],
  ["another user", "C:\\Users\\other\\.codex\\skills\\documents"],
  ["another drive", "D:\\Users\\me\\.codex\\skills\\documents"],
  ["case alias", "c:\\Users\\me\\.codex\\skills\\documents"],
  ["trailing-dot alias", "C:\\Users\\me\\.codex\\skills\\documents."],
  ["nested target", "C:\\Users\\me\\.codex\\skills\\nested\\documents"],
  ["different Skill ID", "C:\\Users\\me\\.codex\\skills\\pdf"],
]) {
  test(`Skill ownership rejects a target not re-derived from the canonical root: ${label}`, () => {
    const ownership = {
      ...validOwnership(),
      skills: { documents: { target } },
    };
    assert.equal(isValidOwnershipState(ownership, { skillsRoot: CANONICAL_SKILLS_ROOT }), false);
    assert.equal(isOwnedPath({ target: `${target}\\SKILL.md`, ownership, skillsRoot: CANONICAL_SKILLS_ROOT }), false);
  });
}

test("ownership metadata strings never become authorized roots", () => {
  const ownership = {
    schemaVersion: 1,
    generation: 0,
    installRoot: "C:\\Owned",
    components: {
      app: { installPath: "C:\\Owned\\app", version: "C:\\Windows" },
      chatgpt: {
        installPath: "C:\\Owned\\c", entrypointPath: "C:\\Owned\\c\\ChatGPT.exe",
      },
    },
    skills: { documents: { target: "C:\\Owned\\skills\\documents", sha256: "C:\\Windows" } },
    shortcuts: [{
      componentId: "chatgpt", name: "ChatGPT", path: "C:\\Owned\\ChatGPT.lnk",
      desktopPath: "C:\\Owned", targetPath: "C:\\Owned\\c\\ChatGPT.exe",
      creationId: "a".repeat(32),
    }],
    rollback: null,
    activeTask: null,
    lastTask: { message: "C:\\Windows" },
  };

  assert.equal(isOwnedPath({ target: "C:\\Owned\\app\\bin.exe", ownership, skillsRoot: "C:\\Owned\\skills" }), true);
  assert.equal(isOwnedPath({
    target: "C:\\Owned\\skills\\documents\\SKILL.md",
    ownership,
    skillsRoot: "C:\\Owned\\skills",
  }), true);
  assert.equal(isOwnedPath({
    target: "C:\\Windows\\System32\\cmd.exe",
    ownership,
    skillsRoot: "C:\\Owned\\skills",
  }), false);
});

test("ownership path fields must be own properties of plain records", () => {
  const inheritedComponent = Object.create({ installPath: "C:\\Windows" });
  const ownership = {
    schemaVersion: 1,
    generation: 0,
    installRoot: null,
    components: { app: inheritedComponent },
    skills: {},
    shortcuts: [],
    rollback: null,
    activeTask: null,
    lastTask: null,
  };
  assert.equal(isOwnedPath({ target: "C:\\Windows\\System32", ownership }), false);
});

function validOwnership() {
  return {
    schemaVersion: 1,
    generation: 0,
    installRoot: null,
    components: {},
    skills: {},
    shortcuts: [],
    rollback: null,
    activeTask: null,
    lastTask: null,
  };
}

test("shortcut ownership is one exact component-bound record with an owned current entrypoint", () => {
  const targetPath = "C:\\Owned\\c\\ChatGPT.exe";
  const shortcut = {
    componentId: "chatgpt", name: "ChatGPT", path: "C:\\Desktop\\ChatGPT（2）.lnk",
    desktopPath: "C:\\Desktop", targetPath, creationId: "a".repeat(32),
  };
  const ownership = {
    ...validOwnership(),
    installRoot: "C:\\Owned",
    components: {
      chatgpt: { managed: true, installPath: "C:\\Owned\\c", entrypointPath: targetPath, version: "2.0.0" },
    },
    shortcuts: [shortcut],
  };
  assert.equal(isValidOwnershipState(ownership), true);
  const v2Target = "C:\\Owned\\V2RayN\\current\\v2rayN.exe";
  assert.equal(isValidOwnershipState({
    ...ownership,
    components: {
      v2rayn: {
        managed: true, installPath: "C:\\Owned\\V2RayN\\current",
        entrypointPath: v2Target, version: "7.0.4",
      },
    },
    shortcuts: [{
      componentId: "v2rayn", name: "V2RayN", path: "C:\\Desktop\\V2RayN（12）.lnk",
      desktopPath: "C:\\Desktop", targetPath: v2Target, creationId: "b".repeat(32),
    }],
  }), true);

  const inherited = Object.assign(Object.create({ creationId: "a".repeat(32) }), {
    componentId: "chatgpt", name: "ChatGPT", path: "C:\\Desktop\\ChatGPT.lnk",
    desktopPath: "C:\\Desktop", targetPath,
  });
  for (const invalid of [
    { ...shortcut, extra: true },
    { componentId: "chatgpt", name: "ChatGPT", path: "C:\\Desktop\\ChatGPT.lnk", desktopPath: "C:\\Desktop", targetPath },
    inherited,
    { ...shortcut, componentId: "v2rayn" },
    { ...shortcut, name: "V2RayN" },
    { ...shortcut, path: "C:\\Desktop\\V2RayN.lnk" },
    { ...shortcut, path: "C:\\Desktop\\ChatGPT(2).lnk" },
    { ...shortcut, path: "C:\\Desktop\\ChatGPT（0）.lnk" },
    { ...shortcut, path: "C:\\Desktop\\ChatGPT（02）.lnk" },
    { ...shortcut, targetPath: "C:\\Owned\\c\\Other.exe" },
  ]) {
    assert.equal(isValidOwnershipState({ ...ownership, shortcuts: [invalid] }), false);
  }
  assert.equal(isValidOwnershipState({ ...ownership, components: {} }), false);
  assert.equal(isValidOwnershipState({
    ...ownership,
    components: {
      chatgpt: { ...ownership.components.chatgpt, installPath: "C:\\Owned\\cp" },
    },
  }), false);
});

test("activeTask registry accepts only an exact known transaction schema", () => {
  const base = {
    ...validOwnership(), installRoot: "C:\\Owned",
    components: {
      chatgpt: {
        managed: true, installPath: "C:\\Owned\\c",
        entrypointPath: "C:\\Owned\\c\\ChatGPT.exe", version: "2.0.0",
      },
    },
    activeTask: {
      kind: "component-uninstall", taskId: "remove-chatgpt",
      componentId: "chatgpt", rootPath: "C:\\Owned",
    },
  };
  assert.equal(isValidOwnershipState(base), true);
  const shortcutTask = {
    kind: "component-shortcut", phase: "reserved", taskId: "shortcut", componentId: "chatgpt",
    desktopPath: "C:\\Desktop", targetPath: "C:\\Owned\\c\\ChatGPT.exe",
    shortcut: {
      name: "ChatGPT", path: "C:\\Desktop\\ChatGPT.lnk", desktopPath: "C:\\Desktop",
      targetPath: "C:\\Owned\\c\\ChatGPT.exe", creationId: "a".repeat(32),
    },
  };
  assert.equal(isValidOwnershipState({ ...base, activeTask: shortcutTask }), true);
  assert.equal(isValidOwnershipState({ ...base, activeTask: { ...shortcutTask, phase: "applied" } }), true);
  const mutations = [
    { ...base.activeTask, kind: "unknown-task" },
    { ...base.activeTask, unexpected: true },
    { kind: "component-shortcut", phase: "cleanup", taskId: "shortcut", componentId: "chatgpt", desktopPath: "C:\\Desktop", targetPath: "C:\\Owned\\c\\ChatGPT.exe" },
    { ...shortcutTask, shortcut: { ...shortcutTask.shortcut, path: "C:\\Elsewhere\\ChatGPT.lnk" } },
    { ...shortcutTask, shortcut: { ...shortcutTask.shortcut, creationId: "renderer-value" } },
    { ...shortcutTask, shortcut: { ...shortcutTask.shortcut, name: "V2RayN" } },
    { ...shortcutTask, shortcut: { ...shortcutTask.shortcut, path: "C:\\Desktop\\V2RayN.lnk" } },
    { ...shortcutTask, shortcut: { ...shortcutTask.shortcut, extra: true } },
    {
      ...shortcutTask,
      targetPath: "C:\\Owned\\c\\Other.exe",
      shortcut: { ...shortcutTask.shortcut, targetPath: "C:\\Owned\\c\\Other.exe" },
    },
    { kind: "git-install", taskId: "git", version: "2.51.0", targetDir: "D:\\Elsewhere\\Git", executablePath: "D:\\Elsewhere\\Git\\cmd\\git.exe", installerPath: "C:\\Temp\\git.exe", installerSha256: "a".repeat(64), replacedInstaller: null },
    { kind: "skill-replace", phase: "reserved", taskId: "skill", skillId: "documents", skillsRoot: CANONICAL_SKILLS_ROOT, target: `${CANONICAL_SKILLS_ROOT}\\documents`, version: "1.0.0", packageSha256: "x".repeat(64), skillMdSha256: "a".repeat(64), treeDigest: "b".repeat(64), manifestDigest: "c".repeat(64), previousEvidence: { kind: "absent" } },
    { kind: "git-install-cleanup", taskId: "git", targetDir: "C:\\Owned\\Git", executablePath: "C:\\Owned\\Git\\cmd\\git.exe", replacedInstaller: null },
  ];
  for (const activeTask of mutations) {
    assert.equal(isValidOwnershipState({ ...base, activeTask }, { skillsRoot: CANONICAL_SKILLS_ROOT }), false);
  }
});

test("Git uninstall task binds external targets to a fixed registry authority and managed targets to CBApps", () => {
  const registryKey = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1";
  const externalTask = {
    kind: "git-uninstall", phase: "executing", taskId: "external-remove", mode: "external", version: "2.51.0",
    targetDir: "C:\\Program Files\\Git", executablePath: "C:\\Program Files\\Git\\cmd\\git.exe",
    uninstallerPath: "C:\\Program Files\\Git\\unins000.exe", registryKey,
    leaseScope: "git-execute", leaseNonce: "a".repeat(32),
  };
  assert.equal(isValidOwnershipState({ ...validOwnership(), activeTask: externalTask }), true);
  for (const activeTask of [
    { ...externalTask, registryKey: "HKLM\\Untrusted\\Git" },
    { ...externalTask, mode: "managed" },
    { ...externalTask, executablePath: "C:\\Other\\git.exe" },
    { ...externalTask, uninstallerPath: "C:\\Other\\unins000.exe" },
  ]) {
    assert.equal(isValidOwnershipState({ ...validOwnership(), activeTask }), false);
  }
  const managedTask = {
    ...externalTask, taskId: "managed-remove", mode: "managed", targetDir: "D:\\CBApps\\Git",
    executablePath: "D:\\CBApps\\Git\\cmd\\git.exe", uninstallerPath: "D:\\CBApps\\Git\\unins000.exe",
  };
  assert.equal(isValidOwnershipState({ ...validOwnership(), installRoot: "D:\\CBApps", activeTask: managedTask }), true);
  assert.equal(isValidOwnershipState({ ...validOwnership(), installRoot: "D:\\Other", activeTask: managedTask }), false);
});

const malformedOwnershipCases = [
  ["inherited top-level installRoot", () => Object.assign(Object.create({ installRoot: "C:\\Windows" }), {
    schemaVersion: 1,
    generation: 0,
    components: {},
    skills: {},
    shortcuts: [],
    rollback: null,
    activeTask: null,
    lastTask: null,
  })],
  ["string component", () => ({ ...validOwnership(), components: { app: "C:\\Windows" } })],
  ["array skill", () => ({ ...validOwnership(), skills: { documents: ["C:\\Windows"] } })],
  ["string shortcut", () => ({ ...validOwnership(), shortcuts: ["C:\\Windows"] })],
  ["malformed rollback", () => ({ ...validOwnership(), rollback: { message: "C:\\Windows" } })],
];

for (const [label, buildOwnership] of malformedOwnershipCases) {
  test(`malformed ownership never authorizes paths: ${label}`, () => {
    assert.equal(isOwnedPath({
      target: "C:\\Windows\\System32\\cmd.exe",
      ownership: buildOwnership(),
    }), false);
  });
}

const unsafeOwnershipPathCases = [
  ["slash UNC", "//server/share/owned"],
  ["backslash UNC", "\\\\server\\share\\owned"],
  ["device namespace", "\\\\?\\C:\\owned"],
  ["DOS device namespace", "\\\\.\\C:\\owned"],
  ["non-drive absolute", "\\owned\\root"],
  ["trailing dot segment", "C:\\Owned.\\app"],
  ["trailing space segment", "C:\\Owned \\app"],
  [".codex data path", "C:\\Users\\me\\.codex\\data"],
];

for (const [label, unsafePath] of unsafeOwnershipPathCases) {
  test(`ownership schema rejects non-canonical path: ${label}`, () => {
    const ownership = { ...validOwnership(), installRoot: unsafePath };
    assert.equal(isValidOwnershipState(ownership), false);
    assert.equal(isOwnedPath({ target: `${unsafePath}\\payload.bin`, ownership }), false);
  });
}

test("ownership schema accepts a canonical drive-absolute path", () => {
  const ownership = { ...validOwnership(), installRoot: "D:\\Owned\\CodexBridge" };
  assert.equal(isValidOwnershipState(ownership), true);
  assert.equal(isOwnedPath({ target: "D:\\Owned\\CodexBridge\\payload.bin", ownership }), true);
});
