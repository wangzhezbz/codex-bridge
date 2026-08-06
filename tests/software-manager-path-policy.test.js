import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  isOwnedPath,
  resolveSkillTarget,
  validateInstallRoot,
} from "../desktop/software-manager/path-policy.mjs";

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
    installRoot: "C:\\Tools\\CodexBridge",
    components: { git: { path: "C:\\Tools\\CodexBridge\\components\\git" } },
    skills: { documents: { path: "C:\\Users\\me\\.codex\\skills\\documents" } },
    shortcuts: [{ path: "C:\\Users\\me\\Desktop\\CodexBridge.lnk" }],
    rollback: [{ path: "D:\\CodexBridgeRollback\\chatgpt" }],
    activeTask: null,
    lastTask: null,
  };

  assert.equal(isOwnedPath({ target: "C:\\Tools\\CodexBridge\\components\\git\\bin\\git.exe", ownership }), true);
  assert.equal(isOwnedPath({ target: "C:\\Users\\me\\.codex\\skills\\documents\\SKILL.md", ownership }), true);
  assert.equal(isOwnedPath({ target: "C:\\Users\\me\\Desktop\\CodexBridge.lnk", ownership }), true);
  assert.equal(isOwnedPath({ target: "C:\\Tools\\CodexBridge-old\\payload.exe", ownership }), false);
  assert.equal(isOwnedPath({ target: "C:\\Tools\\CodexBridge\\..\\foreign", ownership }), false);
});
