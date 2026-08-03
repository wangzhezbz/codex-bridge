import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const BRIDGE_RULES_FILE = "BRIDGE.md";
export const BRIDGE_RULES_BEGIN = "<!-- BEGIN CODEXBRIDGE ROUTING RULES -->";
export const BRIDGE_RULES_END = "<!-- END CODEXBRIDGE ROUTING RULES -->";
export const BRIDGE_RULES_VERSION = "2026-07-01-auto-delegate-v3";
export const CODEX_DELEGATION_FILE = "AGENTS.md";
export const CODEX_DELEGATION_BEGIN = "<!-- BEGIN CODEXBRIDGE CODEX DELEGATION -->";
export const CODEX_DELEGATION_END = "<!-- END CODEXBRIDGE CODEX DELEGATION -->";
export const CODEX_DELEGATION_VERSION = "2026-08-02-per-call-thread-v3";

export function bridgeRulesPathForTarget(targetRepo) {
  return path.join(path.resolve(targetRepo), BRIDGE_RULES_FILE);
}

export function codexDelegationPathForTarget(targetRepo) {
  return path.join(path.resolve(targetRepo), CODEX_DELEGATION_FILE);
}

export function hasBridgeRoutingMarker(text = "") {
  return text.includes(BRIDGE_RULES_BEGIN) && text.includes(BRIDGE_RULES_END);
}

export function hasCodexDelegationMarker(text = "") {
  return text.includes(CODEX_DELEGATION_BEGIN) && text.includes(CODEX_DELEGATION_END);
}

function replaceMarkedBlock(existing, beginMarker, endMarker, block) {
  const beginIndex = existing.indexOf(beginMarker);
  const endIndex = existing.indexOf(endMarker, beginIndex);
  if (beginIndex < 0 || endIndex < 0) {
    return null;
  }
  const afterEndIndex = endIndex + endMarker.length;
  return `${existing.slice(0, beginIndex)}${block}${existing.slice(afterEndIndex)}`;
}

function markedBlockNeedsRefresh(existing, requiredSnippets = []) {
  return requiredSnippets.some((snippet) => !existing.includes(snippet));
}

export function buildBridgeRoutingRules({ chatgptProjectUrl, conversationId } = {}) {
  const projectLine = chatgptProjectUrl ? `- GPT 会话: ${chatgptProjectUrl}` : null;
  const conversationLine = conversationId ? `- Bridge conversation: ${conversationId}` : null;
  const contextLines = [projectLine, conversationLine].filter(Boolean);

  return [
    BRIDGE_RULES_BEGIN,
    "## CodexBridge 分工规则",
    "",
    `- Version: ${BRIDGE_RULES_VERSION}`,
    "",
    "这段由 CodexBridge 自动写入，用来让当前项目/对话默认节省 Codex token，并保持 GPT 与 Codex 的职责清楚。",
    "",
    ...(contextLines.length > 0 ? ["### 绑定信息", "", ...contextLines, ""] : []),
    "### 默认交给 GPT",
    "- 图片、截图、附件、PDF、Word、PPT、Excel、PSD 等文件理解、识别、总结、翻译和内容判断。",
    "- 生图、视觉方案、图标、海报、封面、文案、长文、PPT、Excel、Word、PDF、zip 等内容或文件生成。",
    "- 创意方案、设计方向、调研、头脑风暴、高成本内容判断，以及需要消耗大量推理/生成额度的上游任务。",
    "",
    "### Codex 自己做",
    "- 本地代码修改、运行命令、测试验证、读取日志、检查目录/依赖、修复报错和集成落地。",
    "- 本地文件落地、项目接入、真实环境操作、部署、清理、验证和用户明确要求的本机执行。",
    "- 消费 GPT 已经给出的结论和产物，不重复做 GPT 已完成的高成本图片、文案、设计或文件分析。",
    "- 当 GPT 已经返回分析/文案/设计/文件结果时，Codex 默认只做整理、落地和低成本验收，不再重新分析一遍。",
    "",
    "### 用户显式覆盖",
    "- 如果用户明确说“让 Codex 做”“不要交给 GPT”“你直接处理”“本地执行”，Codex 可以覆盖默认 GPT 路由。",
    "- 如果用户明确说“交给 GPT”“让 GPT 分析”“发给 GPT”，优先按 GPT 路由执行。",
    "- 如果任务同时包含 GPT 上游产出和本地落地，先让 GPT 产出，再由 Codex 使用结果执行本地部分。",
    "- 如果 GPT 超时、页面卡住或网页端被拦截，必须报告 Bridge 状态，不要编造 GPT 结果。",
    "",
    BRIDGE_RULES_END
  ].join("\n");
}

export function buildCodexDelegationInstructions({
  projectId,
  chatgptProjectUrl,
  conversationId,
  currentCodexThreadId,
  targetRepo
} = {}) {
  const bridgeProjectLine = projectId ? `- Bridge project: ${projectId}` : null;
  const projectLine = chatgptProjectUrl ? `- Bound GPT session: ${chatgptProjectUrl}` : null;
  const conversationLine = conversationId ? `- Bridge conversation: ${conversationId}` : null;
  const threadLine = currentCodexThreadId
    ? `- Bound Codex thread: ${currentCodexThreadId}`
    : null;
  const targetLine = targetRepo ? `- Bound local project root: ${path.resolve(targetRepo)}` : null;
  const hasExactRouterScope = Boolean(projectId && conversationId && currentCodexThreadId);
  const scopeLine = hasExactRouterScope
    ? `- Required MCP scope for Router V2: include \`projectId: "${projectId}"\`, \`conversationId: "${conversationId}"\`, and \`currentCodexThreadId: "${currentCodexThreadId}"\` in every Router call.`
    : conversationId
      ? `- Required MCP scope: include \`conversationId: "${conversationId}"\` in every legacy Bridge MCP call for this project; Router V2 additionally requires the bound projectId and currentCodexThreadId.`
      : "- Required MCP scope: use the exact bound project, conversation, and Codex thread; Router V2 requires `projectId`, `conversationId`, and `currentCodexThreadId`.";
  const scopeCallText = hasExactRouterScope
    ? "the exact `projectId`, `conversationId`, and `currentCodexThreadId`"
    : "the exact bound scope (`projectId`, `conversationId`, and `currentCodexThreadId` are required by Router V2)";
  const contextLines = [bridgeProjectLine, projectLine, conversationLine, threadLine, targetLine].filter(Boolean);

  return [
    CODEX_DELEGATION_BEGIN,
    "## CodexBridge delegation rules",
    "",
    `- Version: ${CODEX_DELEGATION_VERSION}`,
    "",
    "These rules are written automatically by CodexBridge so the current Codex thread can save tokens by delegating suitable upstream work to the bound GPT session.",
    "",
    ...(contextLines.length > 0 ? ["### Binding", "", ...contextLines, scopeLine, ""] : []),
    "### Activation scope",
    "- These rules apply only inside this bound local project and the bound Bridge conversation above.",
    "- Do not use Bridge from any other Codex project or conversation, even if another Bridge room is active globally.",
    "- Never route an unrelated project through the active Bridge room. If the current Codex project is not this bound project, ignore this block and handle normally in Codex.",
    "- If there is no Bridge-generated `AGENTS.md`/`BRIDGE.md` marker for the current project and the user did not explicitly ask for Bridge, do not mention Bridge and do not call Bridge MCP tools.",
    "- Do not ask the user to reply with a magic phrase such as `let Codex do it` just because Bridge is not active. If Bridge is not active for this project, handle the request normally in Codex.",
    "- Do not say an existing Bridge binding points to another project unless the user explicitly asked to use Bridge and supplied or selected that conflicting Bridge scope.",
    "",
    "### Priority over local creative skills",
    "- These Bridge delegation rules run before local creative skills, brainstorming skills, image generation tools, Office/file generation helpers, or visual-analysis shortcuts.",
    `- If a local skill or tool would normally handle the request, first call \`delegate_current_request\` with ${scopeCallText}; only use the local skill/tool if Bridge routes the work back to Codex or the user explicitly overrides GPT delegation.`,
    `- Never call Router V2 tools without ${scopeCallText}; incomplete or unscoped calls are rejected so another Codex project or conversation cannot leak into this room.`,
    "- For multi-step creative requests, send only the current stage chosen by Bridge. Do not summarize, combine, or pre-complete later stages locally.",
    "",
    "### Same-turn semantic routing",
    "- During the same Codex inference that reads the user's request, decide whether the work is `codex_only`, `gpt_only`, or `gpt_then_codex`, and include that compact structured judgment as `routingProposal` when calling `delegate_current_request`.",
    "- Do not call a second model to create `routingProposal`. This is part of the same Codex inference and should add only a small structured tool argument.",
    "- Include `version: \"1\"`, `routeKind`, and `confidence` from 0 to 1. Add ordered `stages` only when the task genuinely has dependent steps; each stage must name `actor: \"codex\"` or `actor: \"gpt\"`.",
    "- Assign writing, design, image/poster generation, visual judgment, and downloadable Office/content generation stages to `gpt`. Assign `codex` only to concrete local actions such as editing project files, running commands/tests, integrating returned artifacts, or low-cost verification.",
    "- Put only the current GPT stage in `payloadText`. Later GPT stages belong in later stage instructions so Router V2 can wait for dependencies instead of combining prompts.",
    "- Bridge code remains authoritative for explicit user overrides, binding scope, confidence fallback, stage ordering, cancellation, and project isolation.",
    "",
    "### Existing result revisions",
    "- When the user asks to adjust an answer or artifact that already exists, do not restart any earlier outline, chapter, image, poster, or file-generation stage.",
    "- A small mechanical edit such as deleting one sentence, replacing a label, or changing simple formatting is `codex_only`.",
    "- A substantial rewrite, expansion, tone change, or video-ready copy edit is `gpt_only` with `workType: \"existing_result_revision\"`; send only the user's incremental revision request and do not add old workflow stages.",
    "- An existing-result revision must not regenerate images, posters, files, or other artifacts unless the user explicitly requests a new artifact.",
    "- If the prior `runId` is unavailable, call `get_router_run_status` with the exact project and conversation scope before reading room messages or creating another run.",
    "- If the recovered Router Run already succeeded, consume its stored reply and artifacts. Do not restart or continue an earlier completed stage.",
    "",
    "### Default delegation",
    "- Before answering the user about images, screenshots, attachments, PDFs, Word, PPT, Excel, PSD, long writing, copywriting, visual direction, image generation, Office/file generation, research, brainstorming, or other high-cost content judgment, call the MCP tool `delegate_current_request` with the required scope.",
    "- This is a hard gate, not a suggestion: for GPT-suitable work, delegate first and do not start drafting, designing, generating, or judging the content locally before GPT returns.",
    "- If the MCP tool is unavailable or fails to load, stop instead of doing the GPT-suitable work yourself. Tell the user `Bridge MCP is not loaded in this Codex window`, then ask them to restart/open a fresh Codex window or explicitly override with `让 Codex 做` / `不要交给 GPT`.",
    "- For requests like `写一篇玄幻穿越小说`, `先做前十集大纲`, `写第一章`, or `生成小说海报`, call `delegate_current_request` before producing any outline, chapter text, prompt, poster concept, or image.",
    "- If the result contains a `routerRun`, continue that same persisted workflow with `continue_router_run`, passing its `runId`, `projectId`, `conversationId`, and `currentCodexThreadId`. Do not call `delegate_current_request` again to advance it, because that would create a new run.",
    "- If the returned route contains `sequentialPlan`, treat it as a staged workflow. Only consume the current successful stage and let `continue_router_run` advance the next dependency; never pack all stages into one GPT prompt.",
    "- When the user gives a local file directly to Codex, pass the file path through `localPath` or `localFiles`. Local file analysis waits for GPT by default so Codex answers with GPT's result instead of Codex's own visual/content judgment; use `waitForGpt: false` only for an explicit queue-only handoff.",
    "- Forward the user's original wording for image/file analysis. Do not add inferred observations, assumed fields, or leading descriptions such as what the screenshot probably contains.",
    "- If `delegate_current_request` returns `gpt_only` or `gpt_then_codex`, use the returned `replyText`, `finalJob`, and artifacts as the upstream result. Do not re-analyze GPT conclusions, rewrite GPT copy, or redo GPT visual/file judgment unless the user explicitly asks Codex to do so.",
    "",
    "### Keep in Codex",
    "- Keep local code edits, terminal commands, tests, logs, dependency checks, project integration, deployment, cleanup, and low-cost verification in Codex.",
    "- For GPT-to-Codex handoff, Codex should consume GPT's result and only perform local implementation or lightweight verification.",
    "",
    "### Explicit user override",
    "- If the user says `let Codex do it`, `do not send to GPT`, `you handle it directly`, or `run locally`, keep the work in Codex.",
    "- If the user says `send to GPT`, `let GPT analyze`, or `ask GPT`, delegate through CodexBridge even if Codex could answer directly.",
    "- If GPT times out or the GPT page is blocked, report the Bridge status honestly instead of inventing a result.",
    "",
    CODEX_DELEGATION_END
  ].join("\n");
}

async function targetRepoIsDirectory(targetRepo) {
  try {
    return (await stat(targetRepo)).isDirectory();
  } catch {
    return false;
  }
}

export async function ensureBridgeRoutingRules(input = {}) {
  if (!input.targetRepo) {
    return {
      path: null,
      created: false,
      updated: false,
      reason: "targetRepo missing"
    };
  }

  const targetRepo = path.resolve(input.targetRepo);
  const rulesPath = bridgeRulesPathForTarget(targetRepo);
  if (!(await targetRepoIsDirectory(targetRepo))) {
    return {
      path: rulesPath,
      created: false,
      updated: false,
      reason: "targetRepo unavailable"
    };
  }

  const block = buildBridgeRoutingRules(input);
  try {
    const existing = await readFile(rulesPath, "utf8");
    if (hasBridgeRoutingMarker(existing)) {
      if (
        markedBlockNeedsRefresh(existing, [
          BRIDGE_RULES_VERSION,
          "Codex 默认只做整理、落地和低成本验收",
          "不要编造 GPT 结果"
        ])
      ) {
        const refreshed = replaceMarkedBlock(existing, BRIDGE_RULES_BEGIN, BRIDGE_RULES_END, block);
        await writeFile(rulesPath, refreshed, "utf8");
        return {
          path: rulesPath,
          created: false,
          updated: true,
          reason: "refreshed"
        };
      }
      return {
        path: rulesPath,
        created: false,
        updated: false,
        reason: "already present"
      };
    }

    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    await writeFile(rulesPath, `${existing}${separator}${block}\n`, "utf8");
    return {
      path: rulesPath,
      created: false,
      updated: true,
      reason: "appended"
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await writeFile(rulesPath, `# Bridge\n\n${block}\n`, "utf8");
  return {
    path: rulesPath,
    created: true,
    updated: true,
    reason: "created"
  };
}

export async function ensureCodexDelegationInstructions(input = {}) {
  if (!input.targetRepo) {
    return {
      path: null,
      created: false,
      updated: false,
      reason: "targetRepo missing"
    };
  }

  const targetRepo = path.resolve(input.targetRepo);
  const agentsPath = codexDelegationPathForTarget(targetRepo);
  if (!(await targetRepoIsDirectory(targetRepo))) {
    return {
      path: agentsPath,
      created: false,
      updated: false,
      reason: "targetRepo unavailable"
    };
  }

  const block = buildCodexDelegationInstructions(input);
  const requiredDelegationSnippets = [
    CODEX_DELEGATION_VERSION,
    "MCP tool is unavailable",
    "Priority over local creative skills",
    "Activation scope",
    "other Codex project",
    "ignore this block and handle normally",
    "sequentialPlan",
    "continue_router_run",
    "answers with GPT's result instead of Codex's own visual/content judgment",
    "explicit queue-only handoff",
    "Forward the user's original wording",
    "Required MCP scope",
    "unscoped calls are rejected",
    "routingProposal",
    "same Codex inference",
    "Do not call a second model"
  ];
  if (input.chatgptProjectUrl) {
    requiredDelegationSnippets.push(`Bound GPT session: ${input.chatgptProjectUrl}`);
  }
  if (input.projectId) {
    requiredDelegationSnippets.push(`Bridge project: ${input.projectId}`);
    requiredDelegationSnippets.push(`projectId: "${input.projectId}"`);
  }
  if (input.projectId && input.conversationId) {
    requiredDelegationSnippets.push("both the exact `projectId` and `conversationId`");
  }
  if (input.conversationId) {
    requiredDelegationSnippets.push(`Bridge conversation: ${input.conversationId}`);
    requiredDelegationSnippets.push(`conversationId: "${input.conversationId}"`);
  }
  if (input.currentCodexThreadId) {
    requiredDelegationSnippets.push(`Bound Codex thread: ${input.currentCodexThreadId}`);
    requiredDelegationSnippets.push(
      `currentCodexThreadId: "${input.currentCodexThreadId}"`
    );
  }
  if (input.targetRepo) {
    requiredDelegationSnippets.push(`Bound local project root: ${path.resolve(input.targetRepo)}`);
  }
  try {
    const existing = await readFile(agentsPath, "utf8");
    if (hasCodexDelegationMarker(existing)) {
      if (markedBlockNeedsRefresh(existing, requiredDelegationSnippets)) {
        await writeFile(
          agentsPath,
          replaceMarkedBlock(existing, CODEX_DELEGATION_BEGIN, CODEX_DELEGATION_END, block),
          "utf8"
        );
        return {
          path: agentsPath,
          created: false,
          updated: true,
          reason: "refreshed"
        };
      }
      return {
        path: agentsPath,
        created: false,
        updated: false,
        reason: "already present"
      };
    }

    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    await writeFile(agentsPath, `${existing}${separator}${block}\n`, "utf8");
    return {
      path: agentsPath,
      created: false,
      updated: true,
      reason: "appended"
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await writeFile(agentsPath, `# Codex Agent Instructions\n\n${block}\n`, "utf8");
  return {
    path: agentsPath,
    created: true,
    updated: true,
    reason: "created"
  };
}
