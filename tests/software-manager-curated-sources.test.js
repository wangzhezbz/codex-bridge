import assert from "node:assert/strict";
import test from "node:test";

import {
  CURATED_CODEX_PLUGINS,
  CURATED_SKILL_SOURCES,
  buildCuratedPluginInstallPlan,
  buildCuratedPluginRemovePlan,
  selectCuratedSourceFiles,
} from "../scripts/software-manager/curated-sources.mjs";
import {
  cleanupPreparedCuratedSkills,
  prepareCuratedSkills,
} from "../scripts/software-manager/publish-curated-skills.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const publishCuratedSource = fs.readFileSync(
  path.join(path.resolve(import.meta.dirname, ".."), "scripts", "software-manager", "publish-curated-skills.mjs"),
  "utf8",
);

test("curated source registry pins seven complete skills and two full Codex plugins", () => {
  assert.deepEqual(CURATED_SKILL_SOURCES.map(({ id }) => id), [
    "pua",
    "frontend-design",
    "taste-skill",
    "humanizer-zh",
    "agent-reach",
    "video-use",
    "seedance-prompt-zh",
  ]);
  assert.equal(CURATED_SKILL_SOURCES.every(({ commit }) => /^[0-9a-f]{40}$/u.test(commit)), true);
  assert.deepEqual(CURATED_CODEX_PLUGINS.map(({ id, selector, capabilities }) => ({ id, selector, capabilities })), [
    {
      id: "claude-mem",
      selector: "claude-mem@claude-mem-local",
      capabilities: ["Skills", "MCP", "Hooks", "Local Worker"],
    },
    {
      id: "cowart",
      selector: "cowart@cowart-github",
      capabilities: ["3 Skills", "MCP", "Canvas Widget"],
    },
  ]);
  assert.equal(CURATED_CODEX_PLUGINS.every(({ commit }) => /^[0-9a-f]{40}$/u.test(commit)), true);
  assert.deepEqual(CURATED_SKILL_SOURCES.map(({ description }) => description), [
    "帮助推进任务、减少拖延。",
    "帮助设计和优化前端界面。",
    "帮助提升网页的视觉品质。",
    "帮助减少中文内容的 AI 写作痕迹。",
    "帮助跨网页、社交和视频平台检索信息。",
    "帮助完成视频检索、转写、剪辑和渲染。",
    "帮助编写 Seedance 2.0 中文视频提示词。",
  ]);
  assert.deepEqual(CURATED_CODEX_PLUGINS.map(({ description }) => description), [
    "为 Codex 增加跨会话记忆能力。",
    "为 Codex 增加图像生成和画布创作能力。",
  ]);
  assert.equal([...CURATED_SKILL_SOURCES, ...CURATED_CODEX_PLUGINS]
    .every(({ description }) => description.endsWith("。") && description.length <= 28), true);
});

test("curated skill selection preserves required companion files while stripping repository prefixes", () => {
  const agentReach = CURATED_SKILL_SOURCES.find(({ id }) => id === "agent-reach");
  const selected = selectCuratedSourceFiles(agentReach, [
    { path: "README.md", type: "blob", size: 20 },
    { path: "agent_reach/skill/SKILL.md", type: "blob", size: 100 },
    { path: "agent_reach/skill/references/dev.md", type: "blob", size: 50 },
    { path: "agent_reach/skill/references/web.md", type: "blob", size: 50 },
    { path: "agent_reach/skill-link", type: "commit", size: 0 },
  ]);
  assert.deepEqual(selected.map(({ sourcePath, outputPath }) => ({ sourcePath, outputPath })), [
    { sourcePath: "agent_reach/skill/SKILL.md", outputPath: "SKILL.md" },
    { sourcePath: "agent_reach/skill/references/dev.md", outputPath: "references/dev.md" },
    { sourcePath: "agent_reach/skill/references/web.md", outputPath: "references/web.md" },
  ]);

  const videoUse = CURATED_SKILL_SOURCES.find(({ id }) => id === "video-use");
  const videoFiles = selectCuratedSourceFiles(videoUse, [
    { path: ".gitignore", type: "blob", size: 1 },
    { path: "SKILL.md", type: "blob", size: 100 },
    { path: "helpers/render.py", type: "blob", size: 100 },
    { path: "install.md", type: "blob", size: 100 },
    { path: "static/video-use-banner.png", type: "blob", size: 100 },
  ]);
  assert.deepEqual(videoFiles.map(({ outputPath }) => outputPath), [
    "SKILL.md",
    "helpers/render.py",
    "install.md",
    "static/video-use-banner.png",
  ]);
});

test("curated skill selection fails closed for missing entrypoints and unsafe Git entries", () => {
  const pua = CURATED_SKILL_SOURCES.find(({ id }) => id === "pua");
  assert.throws(() => selectCuratedSourceFiles(pua, [
    { path: "codex/pua/README.md", type: "blob", size: 10 },
  ]), /curated_skill_entrypoint_missing/u);
  assert.throws(() => selectCuratedSourceFiles(pua, [
    { path: "codex/pua/SKILL.md", type: "blob", size: 10 },
    { path: "codex/pua/link", type: "commit", size: 0 },
  ]), /curated_skill_git_entry_rejected/u);
  assert.throws(() => selectCuratedSourceFiles(pua, [
    { path: "codex/pua/SKILL.md", type: "blob", size: 10 },
    { path: "codex/pua/../escape.md", type: "blob", size: 10 },
  ]), /curated_skill_path_invalid/u);
});

test("curated plugin plans always recreate pinned marketplaces and remove their dedicated source", () => {
  assert.deepEqual(buildCuratedPluginInstallPlan({ id: "claude-mem", installedMarketplaces: [] }), [
    ["plugin", "marketplace", "add", "thedotmack/claude-mem", "--ref", "4702c337d85aa12e8ab7f845264a78885676261f", "--json"],
    ["plugin", "add", "claude-mem@claude-mem-local", "--json"],
  ]);
  assert.deepEqual(buildCuratedPluginInstallPlan({ id: "cowart", installedMarketplaces: ["cowart-github"] }), [
    ["plugin", "marketplace", "remove", "cowart-github", "--json"],
    ["plugin", "marketplace", "add", "zhongerxin/cowart", "--ref", "6a338f016dee21fd97346c5fd8fe1bd81b1a7522", "--json"],
    ["plugin", "add", "cowart@cowart-github", "--json"],
  ]);
  assert.deepEqual(buildCuratedPluginRemovePlan({ id: "cowart" }), [
    ["plugin", "remove", "cowart@cowart-github", "--json"],
    ["plugin", "marketplace", "remove", "cowart-github", "--json"],
  ]);
  assert.throws(() => buildCuratedPluginInstallPlan({ id: "unknown", installedMarketplaces: [] }), /curated_plugin_not_allowed/u);
});

test("curated publisher can consume an already prepared owned work directory after a GitHub timeout", () => {
  assert.match(publishCuratedSource, /prepared\s*=\s*false/u);
  assert.match(publishCuratedSource, /if\s*\(!prepared\)\s*await prepareCuratedSkills/u);
  assert.match(publishCuratedSource, /values\[index\]\s*===\s*"--prepared"/u);
  assert.match(publishCuratedSource, /finally\s*\{[\s\S]*?cleanupPreparedCuratedSkills\(outputRoot\)/u);
  assert.match(publishCuratedSource, /values\[index\]\s*===\s*"--descriptions-only"/u);
  assert.match(publishCuratedSource, /refreshCuratedSkillDescriptions/u);
});

test("curated skill preparation downloads only selected files and cleans each staged path explicitly", async () => {
  const work = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "curated-skills-parent-")), "stage");
  const source = CURATED_SKILL_SOURCES.find(({ id }) => id === "pua");
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (String(url).includes("/git/trees/")) {
      return {
        ok: true,
        json: async () => ({ tree: [
          { path: "README.md", type: "blob", size: 7 },
          { path: "codex/pua/SKILL.md", type: "blob", size: 5 },
        ] }),
      };
    }
    return { ok: true, arrayBuffer: async () => Buffer.from("skill") };
  };
  const prepared = await prepareCuratedSkills({ outputRoot: work, sources: [source], fetchImpl });
  assert.deepEqual(prepared.map(({ id, files }) => ({ id, files })), [{ id: "pua", files: ["SKILL.md"] }]);
  assert.equal(fs.readFileSync(path.join(work, "pua", "SKILL.md"), "utf8"), "skill");
  assert.equal(requests.some((url) => url.includes("README.md")), false);
  await cleanupPreparedCuratedSkills(work);
  assert.equal(fs.existsSync(work), false);
});
