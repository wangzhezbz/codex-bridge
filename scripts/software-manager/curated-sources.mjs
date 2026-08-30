const COMMIT = /^[0-9a-f]{40}$/u;
const SAFE_SEGMENT = /^[^\\/:*?"<>|.][^\\/:*?"<>|]*$/u;
const MAX_SOURCE_FILES = 2_000;
const MAX_SOURCE_FILE_BYTES = 32 * 1024 * 1024;

export {
  CURATED_CODEX_PLUGINS,
  buildCuratedPluginInstallPlan,
  buildCuratedPluginRemovePlan,
} from "../../shared/software-manager/curated-plugins.mjs";

function frozenSkill(value) {
  return Object.freeze({ ...value, exclude: Object.freeze([...(value.exclude ?? [])]) });
}

export const CURATED_SKILL_SOURCES = Object.freeze([
  frozenSkill({
    id: "pua",
    name: "PUA",
    description: "帮助推进任务、减少拖延。",
    repo: "tanweai/pua",
    commit: "3fd4e5a1cb7a40938113b66febae532ba36f350a",
    prefix: "codex/pua/",
  }),
  frozenSkill({
    id: "frontend-design",
    name: "Frontend Design",
    description: "帮助设计和优化前端界面。",
    repo: "anthropics/skills",
    commit: "f17010c9bb483898c1d9c9f42dde2b3a98889434",
    prefix: "skills/frontend-design/",
  }),
  frozenSkill({
    id: "taste-skill",
    name: "Design Taste",
    description: "帮助提升网页的视觉品质。",
    repo: "Leonxlnx/taste-skill",
    commit: "e988add20dab0fa97d7a76781c48961c8184288e",
    prefix: "skills/taste-skill/",
  }),
  frozenSkill({
    id: "humanizer-zh",
    name: "Humanizer 中文版",
    description: "帮助减少中文内容的 AI 写作痕迹。",
    repo: "op7418/Humanizer-zh",
    commit: "91f3d394db8419c20d67ebe22a96cf8fee0a404b",
    prefix: "",
    exclude: [".gitignore"],
  }),
  frozenSkill({
    id: "agent-reach",
    name: "Agent Reach",
    description: "帮助跨网页、社交和视频平台检索信息。",
    repo: "Panniantong/Agent-Reach",
    commit: "1221ecd0c3e0502ee37406f03543bedf7503f2c7",
    prefix: "agent_reach/skill/",
  }),
  frozenSkill({
    id: "video-use",
    name: "Video Use",
    description: "帮助完成视频检索、转写、剪辑和渲染。",
    repo: "browser-use/video-use",
    commit: "92c2b34e44c205cbc2acae7f6ca7c1c219d5dd66",
    prefix: "",
    exclude: [".gitignore", ".env.example"],
  }),
  frozenSkill({
    id: "seedance-prompt-zh",
    name: "Seedance 2 中文提示词",
    description: "帮助编写 Seedance 2.0 中文视频提示词。",
    repo: "dexhunter/seedance2-skill",
    commit: "e06c7c63a766d623004a2807881c30685ce517af",
    prefix: "zh/",
  }),
]);

function curatedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeGitPath(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== ".." && SAFE_SEGMENT.test(part));
}

function sourceDefinition(source) {
  if (!source || typeof source !== "object" || !CURATED_SKILL_SOURCES.includes(source)
    || !COMMIT.test(source.commit) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source.repo)) {
    throw curatedError("curated_skill_source_not_allowed");
  }
  return source;
}

export function selectCuratedSourceFiles(rawSource, rawTree) {
  const source = sourceDefinition(rawSource);
  if (!Array.isArray(rawTree) || rawTree.length > MAX_SOURCE_FILES) throw curatedError("curated_skill_tree_invalid");
  const selected = [];
  const outputs = new Set();
  for (const entry of rawTree) {
    const sourcePath = String(entry?.path ?? "");
    if (!sourcePath.startsWith(source.prefix)) continue;
    const outputPath = sourcePath.slice(source.prefix.length);
    if (!outputPath || source.exclude.includes(outputPath)) continue;
    if (!safeGitPath(sourcePath)) throw curatedError("curated_skill_path_invalid");
    if (!safeGitPath(outputPath)) throw curatedError("curated_skill_path_invalid");
    if (entry?.type === "tree") continue;
    if (entry?.type !== "blob") throw curatedError("curated_skill_git_entry_rejected");
    const size = Number(entry?.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SOURCE_FILE_BYTES) {
      throw curatedError("curated_skill_file_size_invalid");
    }
    const folded = outputPath.toLocaleLowerCase("en-US");
    if (outputs.has(folded)) throw curatedError("curated_skill_path_duplicate");
    outputs.add(folded);
    selected.push(Object.freeze({ sourcePath, outputPath, size }));
  }
  selected.sort((left, right) => {
    if (left.outputPath === "SKILL.md") return -1;
    if (right.outputPath === "SKILL.md") return 1;
    return left.outputPath.localeCompare(right.outputPath, "en");
  });
  if (!selected.some(({ outputPath }) => outputPath === "SKILL.md")) {
    throw curatedError("curated_skill_entrypoint_missing");
  }
  return Object.freeze(selected);
}
