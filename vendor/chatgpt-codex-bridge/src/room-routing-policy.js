function normalizeText(value = "") {
  return String(value || "").trim();
}

function hasBoundGpt(workspace = {}) {
  return Boolean(normalizeText(workspace.chatgptProjectUrl));
}

function hasLocalRepo(workspace = {}) {
  return Boolean(normalizeText(workspace.targetRepo));
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function stripNegatedImageGenerationClauses(text) {
  const patterns = [
    /(?:不要|别|无需|不需要|禁止|避免)(?=[^，。！？!?；;\n]{0,64}(?:生图|生成|画|配图|图片|图像|照片|海报|封面|图标|logo|插画|视觉))[^，。！？!?；;\n]*/gi,
    /\b(?:do not|don't|without|no need to|avoid)\b(?=[^,.!?;\n]{0,80}\b(?:generate|create|draw|image|images|picture|photo|poster|cover|icon|logo|illustration)\b)[^,.!?;\n]*/gi
  ];
  return patterns.reduce((value, pattern) => value.replace(pattern, " "), text);
}

const denyGptPatterns = [
  /(?:不要|别|不用|不要再|不需要).{0,20}(?:交给|发给|给)\s*(?:GPT|ChatGPT)/i,
  /(?:不要|别|不用|不要再|不需要).{0,20}(?:GPT|ChatGPT).{0,20}(?:处理|分析|看|做|生成)?/i,
  /\b(?:do not|don't)\s+(?:send|delegate).{0,30}(?:gpt|chatgpt)\b/i
];

const explicitCodexOnlyPatterns = [
  /(?:只|仅|交给)?\s*Codex.{0,24}(?:直接|自己|来做|处理|分析|看|执行)/i,
  /(?:你直接处理|你自己处理|你自己看|你直接看|本地执行|Codex 来做|让 Codex|给 Codex)/i,
  /\b(?:let|have)\s+codex\b.{0,40}\b(?:do|handle|run|execute|analyze)\b/i
];

const explicitGptRequestPatterns = [
  /(?:让|请|交给|发给)\s*(?:GPT|ChatGPT).{0,32}(?:做|处理|分析|看|生成)?/i,
  /(?:GPT|ChatGPT).{0,32}(?:做|处理|分析|看|生成)/i,
  /\b(?:ask|send|delegate).{0,32}(?:gpt|chatgpt)\b/i
];

const imageGenerationPatterns = [
  /生图|生成.{0,40}(?:图|图片|图像|照片|海报|封面|图标|logo|插画)|画.{0,40}(?:图|图片|图像|照片|海报|封面|图标|logo|插画)|配图|海报|封面|图标|logo|插画|视觉/i,
  /\b(?:image|images|picture|photo|poster|cover|icon|logo|illustration)\b/i
];

const gptAnalysisPatterns = [
  /(?:分析|识别|判断|解释|总结|翻译|提取|审查|评估|看看).{0,32}(?:图片|截图|附件|文件|文档|PDF|pdf|表格|PPT|ppt|Word|word|页面)/i,
  /(?:图片|截图|附件|文件|文档|PDF|pdf|表格|PPT|ppt|Word|word|页面).{0,32}(?:分析|识别|判断|解释|总结|翻译|提取|审查|评估|看看|是什么)/i,
  /(?:这是什么|这个是什么|图里|图片里|截图里|附件里|文件里|文档里)/i,
  /\b(?:analy[sz]e|summari[sz]e|translate|explain|inspect|review)\b/i
];

const gptGenerationPatterns = [
  ...imageGenerationPatterns,
  /设计|方案|文案|长文|小说|PPT|PowerPoint|Excel|xlsx|表格|调研|头脑风暴|排版|审美|风格|素材|生成.{0,24}(?:文件|文档|表格|PPT|ppt|Excel|xlsx|Word|docx|PDF|pdf|zip|压缩包)/i,
  /\b(?:design|copy|article|novel|story|chapter|outline|slides?|deck|spreadsheet|brainstorm|research|style|docx|xlsx|pptx|pdf|zip)\b/i
];

const localExecutionPatterns = [
  /本地|项目|代码|源码|目录|仓库|终端|命令|运行|测试|验证|调试|报错|错误|修复|修改|实现|接入|部署|构建|重构|安装|配置|提交|登录模块/i,
  /C\s*盘|磁盘|硬盘|桌面|快捷方式|Windows|PowerShell|环境变量|注册表|端口|服务|进程|Chrome\s*扩展|扩展/i,
  /创建|新建|写入|删除|清理/i,
  /\b(?:local|repo|repository|code|directory|terminal|command|run|test|debug|fix|change|implement|build|refactor|install|deploy|powershell|npm|node|git)\b/i
];

const simpleLocalFilePatterns = [
  /(?:创建|新建|写入|生成|保存).{0,40}(?:\.(?:txt|md|json|html|css|js|ts|jsx|tsx|py|ps1|bat|cmd|yml|yaml|xml|log)\b|README|AGENTS\.md)/i
];

const downloadableArtifactPatterns = [
  /可下载|下载链接|PPT|PowerPoint|pptx|Excel|xlsx|Word|docx|PDF|pdf|zip|压缩包|图片|照片|海报|封面|图标|logo|插画|PSD|psd/i
];

const localHandoffPatterns = [
  /放进|放到|写进|写到|接入|导入|应用到|集成|保存到|复制到|移动到|替换|改到|落地|本地执行|跑一个|验证一个|按它|照着|根据它/i,
  /\b(?:apply|integrate|save|copy|move|replace|implement|verify)\b/i
];

const sequencePatterns = [
  /(?:先|首先|第一步).{0,60}(?:再|然后|之后|接着|最后)/i,
  /\b(?:first|then|next|finally)\b/i,
  /(?:先让|先用).{0,32}(?:GPT|ChatGPT|设计|规划|方案|生成|调研).{0,80}(?:再|然后|之后).{0,32}(?:Codex|实现|修改|落地|接入|执行|使用)/i,
  /(?:GPT|ChatGPT).{0,80}(?:做|生成|设计|规划|调研).{0,80}Codex.{0,80}(?:实现|修改|执行|落地|使用)/i,
  /(?:设计|方案|素材|图片|截图|附件|文件|PPT|Excel).{0,80}(?:实现|接入|放进|落地|写到|改到|按它).{0,80}(?:项目|代码|本地)/i
];

const greetingPatterns = [/^(你好|您好|嗨|哈喽|在吗|hi|hello|hey)$/i];

function inferCreativeSubject(text = "") {
  if (/玄幻/.test(text) && /穿越/.test(text) && /小说/.test(text)) {
    return "玄幻穿越小说";
  }
  if (/\bfantasy\b/i.test(text) && /\bnovel\b/i.test(text)) {
    return "fantasy novel";
  }
  const novelMatch = text.match(/(?:一篇|一个|这篇)?([^，。,.；;！？?]{0,24}小说)/);
  if (novelMatch?.[1]) {
    return novelMatch[1].trim();
  }
  return "这个创作项目";
}

function inferOutlineLabel(text = "") {
  const episodeMatch = text.match(/(?:前|first)\s*([一二三四五六七八九十百\d]+|ten)\s*(?:集|episodes?)/i);
  if (episodeMatch?.[1]) {
    const count = episodeMatch[1].toLowerCase() === "ten" ? "十" : episodeMatch[1];
    return `前${count}集的大纲`;
  }
  return "大纲";
}

function buildSequentialCreativePlan(text = "") {
  const value = normalizeText(text);
  const hasSequence = matchesAny(value, sequencePatterns);
  const hasOutline = /(?:大纲|提纲|前\s*[一二三四五六七八九十百\d]+\s*集|first\s+ten\s+episodes?|outline|设定|世界观|人物设定)/i.test(value);
  const hasChapter = /(?:第一章|第\s*[一二三四五六七八九十百\d]+\s*章|chapter\s+one|正文|写.{0,8}章)/i.test(value);
  const hasPoster = /(?:海报|封面|配图|生图|生成.{0,12}(?:图|图片|图像|海报|封面)|poster|cover\s+image)/i.test(value);
  const stageCount = [hasOutline, hasChapter, hasPoster].filter(Boolean).length;

  if (!hasSequence || stageCount < 2 || !(hasOutline && (hasChapter || hasPoster))) {
    return null;
  }

  const subject = inferCreativeSubject(value);
  const outlineLabel = inferOutlineLabel(value);
  const stages = [];

  stages.push({
    id: "outline",
    title: `设计${outlineLabel}`,
    payloadText: [
      `请只完成第 1 步：为${subject}设计${outlineLabel}。`,
      "",
      "要求：",
      "- 只输出大纲、核心设定、主线、主要人物和每集概要。",
      "- 不要写第一章。",
      "- 不要生成海报。",
      "- 结尾补一段“下一步写第一章可直接使用的素材”。"
    ].join("\n")
  });

  if (hasChapter) {
    stages.push({
      id: "chapter",
      title: "写第一章内容",
      dependsOn: "outline",
      instruction: "等第 1 步大纲完成后，把大纲结果作为上文，再让 GPT 只写第一章内容。"
    });
  }

  if (hasPoster) {
    stages.push({
      id: "poster",
      title: "生成小说海报",
      dependsOn: hasChapter ? "chapter" : "outline",
      instruction: "等前面的文字设定完成后，再让 GPT 根据最终设定生成小说海报。"
    });
  }

  return {
    id: "sequential_creative_chain",
    summary: "检测到多阶段创作链路，Bridge 会先发送第 1 步，后续阶段必须等上一阶段结果回来后再发送。",
    currentStageIndex: 0,
    stages,
    nextActionText: stages[1]?.instruction || null
  };
}

function buildPolicyStage(actor, title, responsibility) {
  return { actor, title, responsibility };
}

function buildRoutePolicy({ kind, work, workspace = {}, reason = "" }) {
  if (kind === "gpt_then_codex") {
    return {
      id: "gpt_then_codex",
      workType: work,
      primaryActor: "gpt_then_codex",
      summary: "GPT 先完成分析、设计、生成或方案判断，Codex 再基于 GPT 结果做本地落地和验收。",
      principle: "Codex 默认消费 GPT 的上游结论和产物，不重复做高成本视觉、文案、设计或内容判断。",
      codexUsesGptResult: true,
      codexMayReanalyzeGptWork: false,
      requiresLocalRepo: true,
      hasLocalRepo: hasLocalRepo(workspace),
      reason,
      stages: [
        buildPolicyStage("gpt", "上游判断/生成", "完成图片、文件、文案、设计、调研、方案拆解或内容理解。"),
        buildPolicyStage("codex", "本地落地/验收", "使用 GPT 结果执行项目修改、命令运行、文件处理和低成本验证。")
      ]
    };
  }

  if (kind === "codex_only") {
    return {
      id: "codex_only",
      workType: work,
      primaryActor: "codex",
      summary: "Codex 直接处理本地项目、系统、文件、命令、调试、测试和验证。",
      principle: "凡是需要访问本机、修改代码、运行命令或验证结果的任务，优先留给 Codex。",
      codexUsesGptResult: false,
      codexMayReanalyzeGptWork: false,
      requiresLocalRepo: true,
      hasLocalRepo: hasLocalRepo(workspace),
      reason,
      stages: [buildPolicyStage("codex", "本地执行", "检查上下文，执行必要修改或命令，并把实际结果写回房间。")]
    };
  }

  return {
    id: "gpt_only",
    workType: work,
    primaryActor: "gpt",
    summary: "GPT 处理对话、分析、创意、长文、图片和 Office/可下载文件生成。",
    principle: "把高成本创意、视觉、文案、文件生成和附件理解交给 GPT；Codex 只在需要落地时消费结果。",
    codexUsesGptResult: true,
    codexMayReanalyzeGptWork: false,
    requiresLocalRepo: false,
    hasLocalRepo: hasLocalRepo(workspace),
    reason,
    stages: [buildPolicyStage("gpt", "生成/分析", "直接完成用户需要的回答、内容、文件、图片或附件理解。")]
  };
}

export function classifyRoomWork(text = "", options = {}) {
  const value = normalizeText(text);
  const generationValue = stripNegatedImageGenerationClauses(value);
  const hasAttachments = Number(options.attachmentCount || 0) > 0 || Boolean(options.hasAttachments);
  const sequentialPlan = buildSequentialCreativePlan(value);
  const denyGpt = matchesAny(value, denyGptPatterns);
  const explicitCodexOnly = matchesAny(value, explicitCodexOnlyPatterns);
  const explicitGptRequest = matchesAny(value, explicitGptRequestPatterns);
  const gptAnalysis = matchesAny(value, gptAnalysisPatterns);
  const gptGeneration = matchesAny(generationValue, gptGenerationPatterns);
  const imageGeneration = matchesAny(generationValue, imageGenerationPatterns);
  const gptCandidate = gptAnalysis || gptGeneration || hasAttachments || explicitGptRequest;
  const localExecution = matchesAny(value, localExecutionPatterns);
  const simpleLocalFile = matchesAny(value, simpleLocalFilePatterns);
  const downloadableArtifact = matchesAny(value, downloadableArtifactPatterns);
  const localHandoff = matchesAny(value, localHandoffPatterns);
  const sequence = matchesAny(value, sequencePatterns) || (gptCandidate && localExecution && (hasAttachments || localHandoff));
  const greeting = matchesAny(value.replace(/\s+/g, ""), greetingPatterns);

  if (greeting) {
    return "chat";
  }
  if (denyGpt || (explicitCodexOnly && !explicitGptRequest)) {
    return "codex";
  }
  if (simpleLocalFile && !downloadableArtifact && !explicitGptRequest) {
    return "codex";
  }
  if (sequentialPlan) {
    return "sequential_creative_chain";
  }
  if (sequence) {
    return "gpt_then_codex";
  }
  if (localExecution && !gptCandidate) {
    return "codex";
  }
  if (gptCandidate) {
    return imageGeneration && !gptAnalysis ? "image" : "gpt";
  }
  return "chat";
}

function buildCodexPromptText(text, workspace = {}) {
  return [
    "# 来自工作房间的本地执行任务",
    "",
    normalizeText(text),
    "",
    "# Codex 执行要求",
    `目标项目目录：${workspace.targetRepo || "未指定"}`,
    "",
    "请由当前 Codex 线程直接处理。需要检查、创建、修改、运行命令或验证时直接执行；完成后把实际修改、验证命令和剩余风险写回房间。"
  ].join("\n");
}

function buildGptThenCodexPayload(text, workspace = {}) {
  return [
    normalizeText(text),
    "",
    "请先完成适合 GPT 的部分，例如设计、文案、图片/文件生成、调研、方案拆解或质量判断。",
    "Codex 会默认使用你的结论和产物，不会重新分析图片、文案、设计或内容判断；请把可直接消费的结果写清楚。",
    "如果后续需要 Codex 在本地项目中执行，请把结果写成清晰、可执行的交接内容：目标、产物、关键约束、建议步骤和低成本验收方式。",
    "不要声称已经修改、创建、下载或运行了本地项目文件；这些本地动作会由 Codex 完成。",
    "",
    `本地项目目录：${workspace.targetRepo || "未指定"}`
  ].join("\n");
}

export function decideRoomRoute(input = {}) {
  const text = normalizeText(input.text);
  const workspace = input.workspace || {};
  const attachmentCount = Number(input.attachmentCount || 0);
  const sequentialPlan = buildSequentialCreativePlan(text);
  const work = classifyRoomWork(text, {
    attachmentCount,
    hasAttachments: input.hasAttachments
  });

  if (!hasBoundGpt(workspace)) {
    const reason = "未绑定 GPT 会话，任务留给 Codex 在本地处理。";
    return {
      kind: "codex_only",
      targets: ["codex"],
      syncKind: null,
      gptPayloadText: null,
      codexPromptText: buildCodexPromptText(text, workspace),
      reason,
      policy: buildRoutePolicy({ kind: "codex_only", work, workspace, reason })
    };
  }

  if (work === "codex") {
    const reason = hasLocalRepo(workspace)
      ? "检测到本地项目、系统、文件、命令、测试或验证需求，留给 Codex 处理。"
      : "检测到执行型任务，但未设置本地目录，先交给 Codex 判断。";
    return {
      kind: "codex_only",
      targets: ["codex"],
      syncKind: null,
      gptPayloadText: null,
      codexPromptText: buildCodexPromptText(text, workspace),
      reason,
      policy: buildRoutePolicy({ kind: "codex_only", work, workspace, reason })
    };
  }

  if (sequentialPlan) {
    const reason = "检测到多阶段创作链路，先交给 GPT 完成第 1 步，后续步骤等上一阶段结果回来后再继续。";
    return {
      kind: "gpt_only",
      targets: ["gpt"],
      syncKind: "chat_message",
      gptPayloadText: sequentialPlan.stages[0]?.payloadText || text,
      codexPromptText: null,
      reason,
      sequentialPlan,
      policy: buildRoutePolicy({ kind: "gpt_only", work: "sequential_creative_chain", workspace, reason })
    };
  }

  if (work === "gpt_then_codex") {
    const reason = "检测到先 GPT 分析、设计、生成或规划，再由 Codex 消费结果落地的衔接任务。";
    return {
      kind: "gpt_then_codex",
      targets: ["gpt"],
      syncKind: "user_request",
      gptPayloadText: buildGptThenCodexPayload(text, workspace),
      codexPromptText: null,
      reason,
      policy: buildRoutePolicy({ kind: "gpt_then_codex", work, workspace, reason })
    };
  }

  const reason =
    attachmentCount > 0
      ? "检测到附件、图片或文件理解需求，交给 GPT 分析；Codex 只消费结果。"
      : work === "image"
        ? "检测到图片生成需求，交给 GPT 网页端处理。"
        : "普通对话、长文、文案、创意生成或分析任务，交给 GPT 处理。";
  return {
    kind: "gpt_only",
    targets: ["gpt"],
    syncKind: work === "image" ? "image_request" : "chat_message",
    gptPayloadText: text,
    codexPromptText: null,
    reason,
    policy: buildRoutePolicy({ kind: "gpt_only", work, workspace, reason })
  };
}
