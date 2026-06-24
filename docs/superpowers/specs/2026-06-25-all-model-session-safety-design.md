# 全模型会话安全设计

## 摘要

CodexBridge 在继续增强模型切换能力之前，必须先补上一层更稳定的会话安全协议。它要保证所有内置模型和自定义模型在可用范围内稳定工作，不因为切换模型导致 Codex 任务损坏、工具能力丢失、上游参数报错、历史被污染、工具无限循环，或者在任务已经卡住后继续消耗用户 token。

这份设计给现有路由器外面加一套“全模型兼容契约”。本地入口仍然是 Codex 使用的 Responses API，现有 provider 转换逻辑继续保留，但要逐步引入显式的会话状态、模型能力矩阵、请求渲染预算、附件策略、上下文压缩策略和安全熔断器。

目标不是让所有上游模型都拥有同等能力。有些模型天然不支持工具、图片、文件、长上下文或 Responses 原生流程。目标是把这些限制显式化并安全处理：不支持就本地降级、明确提示或切到有能力的模型，而不是反复向上游试错。

## 不可破坏的发布红线

只要下面任意一条退化，就不能发版：

- 任意内置预设模型无法完成普通文本请求。
- 任意内置预设模型因为 CodexBridge 转发了已知不支持的参数而返回 provider 400 或 422。
- 模型切换后工具结果丢失。
- MCP namespace 工具被丢弃、改名错误，或无法映射回 Codex。
- 不支持图片或文件的 provider 被反复发送图片或文件 payload。
- 一个任务在出现重复工具调用、重复工具输出、重复 provider 错误或客户端断开后仍继续请求上游。
- 小上下文模型永久裁剪或覆盖全局会话状态。
- 模型切换后，Codex 明明应该看到工具结果或历史状态，却只收到一句泛泛而谈的短回答。

这些红线覆盖所有模型类别，不只覆盖 DeepSeek 和 Kimi：

- GPT / 原生 Responses 路由。
- 通用 OpenAI-compatible chat 路由。
- DeepSeek、Kimi、MiniMax、豆包、通义、百度、Gemini 等内置预设。
- 支持视觉的模型。
- 纯文本模型。
- 自定义模型的保守模式。

自定义模型不能保证完成所有 Codex 任务，因为它们可能本身不支持工具、图片、文件或长上下文。但 CodexBridge 必须保证：未知自定义模型默认安全保守，按纯文本、最小参数、短上下文、无图片、无文件、无推测工具能力处理；只有用户显式开启某项能力后，才允许使用对应能力。

## 当前已有基础

现有实现已经有一些重要保护：

- `ResponseHistory` 保存统一本地 chat history，避免小模型的上游裁剪污染大模型历史。
- chat 路由在发送上游前按该 route 的 `contextWindow` 裁剪 payload。
- MCP namespace 工具会为 chat-completions provider 做扁平化映射。
- 工具调用和工具结果会尽量成对规范化，避免 provider 收到断裂历史。
- chat provider 拒绝图片时，可以去掉图片并重试文本。
- 超大的 data image URL 会在 chat 请求前替换成占位文本。
- 请求体有 25 MB 限制，压缩体解压后也会再次检查。
- 客户端断开会中止上游请求。
- 上游超时、失败短路、rate limit 本地回退、chat 工具循环 guard 已经能降低 token 跑飞风险。

缺失的是一套统一协议：同一个 canonical conversation 应该如何安全地渲染给不同能力、不同上下文长度、不同工具格式的模型。

## 架构设计

### 1. 会话状态层

在 `ResponseHistory` 后面引入 `ConversationState`。

它负责保存模型无关的 canonical session record：

- 用户轮次。
- 助手可见文本。
- 只保存公开摘要，不保存隐藏思维链。
- 工具调用。
- 工具输出。
- 附件元信息。
- 本地 fallback 消息。
- 压缩摘要。
- 每个 response 的元数据。

canonical 记录永远不能存成某个 provider 已经裁剪过的 payload。小模型可以拿到一个短视图，但这个短视图不能反过来覆盖全局会话。

现有 `ResponseHistory` 可以作为第一版存储后端，但职责要收窄：

- 保存 canonical turns。
- 保存 Codex probe 需要的 provider response object。
- 保存模型切换和安全判断需要的 metadata。
- 用 byte limit 和 entry limit 控制内存。

### 2. 模型能力矩阵

每个 route 都要生成一份标准化能力描述。内置预设显式声明能力，自定义模型使用安全默认值。

能力字段包括：

- `api`：`responses` 或 `chat_completions`。
- `providerFamily`：OpenAI、DeepSeek、Kimi、MiniMax、Doubao、Qwen、Gemini、Baidu、generic OpenAI-compatible 或 custom。
- `contextWindow`：真实上游输入窗口。
- `catalogContextWindow`：暴露给 Codex 模型目录的窗口。
- `supportsTools`：native、chat-functions、limited 或 none。
- `supportsMcpNamespaces`：只有 adapter 能安全保留 namespace 时才为 true。
- `supportsImages`：native、chat-image-url、text-placeholder 或 none。
- `supportsFiles`：native、text-placeholder 或 none。
- `supportsResponsePreviousId`：只有真正能维护 upstream previous response state 的 Responses route 才为 true。
- `supportsPromptCaching`：unknown、provider-native 或 false。
- `safeParams`：允许转发的参数白名单。
- `dropParams`：显式禁止字段，在 `safeParams` 之后兜底。
- `maxToolContinuationTurns`：每个 route 的工具循环阈值。
- `upstreamTimeoutMs`：每个 route 的上游超时。

路由启动和配置热加载后，都要为每个 route 生成一个 `AdapterProfile`。测试必须断言每个内置预设都有 profile。

### 3. Provider Adapter

provider 特殊逻辑要从零散条件判断中收拢到 adapter。

每个 adapter 负责：

- 参数白名单。
- 工具 schema 整形。
- 工具调用返回转换。
- 图片和文件渲染。
- provider 特殊 schema 兼容。
- 错误分类。
- prompt cache 相关提示。
- fallback 行为。

第一批 adapter：

- `responses-native`：GPT / Codex auth 路由。
- `chat-openai-compatible`：通用保守基线。
- `chat-deepseek`。
- `chat-kimi`。
- `chat-minimax`。
- `chat-doubao`。
- `chat-qwen`。
- `chat-gemini`。
- `custom-conservative`。

通用 adapter 必须严格保守。provider 专用 adapter 只有在测试证明支持后，才能增加能力。

### 4. 请求渲染预算

每次请求上游前，CodexBridge 都从 canonical conversation 渲染 provider payload。

渲染步骤：

1. 从 `ConversationState` 获取 canonical history。
2. 根据 route 选择 adapter profile。
3. 构建稳定 system prefix：
   - 用户和 developer 指令。
   - 只有需要时才加入 Bridge 工具指导。
   - 只有需要时才加入能力限制说明。
4. 加入全局压缩摘要。
5. 加入最近轮次，并保留工具调用/工具结果配对。
6. 加入当前用户输入和当前工具输出。
7. 执行 adapter 专属裁剪。
8. fetch 之前验证最终 payload 是否符合 adapter 规则。

稳定 prefix 对 provider prompt cache 很重要。renderer 不应插入时间戳、随机 id、噪声诊断、重复工具指导等会破坏缓存前缀的内容，除非当前请求真的需要。

renderer 内部要输出预算诊断：

- canonical token 估算。
- rendered token 估算。
- 摘要 token。
- 最近轮次 token。
- 附件占位 token。
- 被丢弃的历史轮次数。
- 工具调用配对是否被 flatten。

这些信息写入脱敏日志和测试，不默认暴露给模型。

### 5. Prompt Cache 策略

CodexBridge 不能强制 provider 命中 prompt cache，但可以避免自己破坏可缓存前缀。

规则：

- 模型切换时保持稳定指令结构。
- Bridge 指导按确定性 section 插入，并且只在相关请求出现。
- 不把 provider 错误文本放进可复用 prefix。
- 不把 route 名、临时 request id、时间戳放进 prompt 内容。
- 老历史优先使用 canonical summary，而不是每次重新排版原始长历史。
- 同 provider、同模型、canonical history 未变化时，旧上下文渲染结果应尽量 byte-identical。

跨 provider 切换本来就会降低缓存命中率。目标不是让不同 provider 共用缓存，而是避免同一 provider 内部因为 Bridge 自己的渲染抖动导致缓存命中变差。

### 6. 上下文压缩策略

压缩默认是全局的，模型专属只作为 rendered view。

canonical state 可以包含：

- `globalSummary`：所有模型共用的 provider-neutral 摘要。
- `toolLedger`：已完成工具和关键输出的紧凑记录。
- `attachmentLedger`：附件、截图、图片、被省略文件详情的紧凑记录。
- `modelViewCache`：可选的每模型渲染摘要，只用于性能，不能作为事实源。

触发压缩的条件：

- canonical 估算大小超过阈值。
- 某个 route 无法同时容纳必要最近轮次和最小工具 ledger。
- 用户明确要求压缩或继续长上下文。

压缩模型选择：

- 优先使用强上下文、强工具兼容的原生 Responses route。
- 如果没有原生 route，使用配置中标记为 `canSummarizeSafely` 的最佳模型。
- 如果没有安全 summarizer，不做破坏性压缩，只做确定性裁剪并给本地提示。

压缩输出必须结构化：

- 当前目标。
- 已做决定。
- 文件和路径。
- 关键工具结果。
- 外部约束。
- 未完成任务。
- 已知失败尝试。
- 附件信息，以及附件内容是否真的被模型看过。

小模型的 rendered context 或临时摘要不能覆盖 `globalSummary`，除非它是由压缩策略选中的模型生成，并且通过验证。

### 7. 附件策略

附件必须按模型能力显式处理。

图片：

- 原生支持图片的 Responses route，在请求大小限制内接收 image part。
- 支持 image URL 的 chat route，在 adapter 允许时接收 image URL part。
- 纯文本或未知 route 接收确定性占位文本，尽量包含文件名、类型、大小。
- 超大 data image 不转发给 chat provider，改写入 attachment ledger 并放入占位文本。

文件：

- 原生支持文件的 route，只有在请求格式确认安全时才接收支持的 file input。
- chat provider 默认不接收原始文件数据。
- 不支持的文件输入变成占位文本，说明文件未转发，并带安全元信息。
- 如果任务明显需要文件内容，而当前模型无法接收文件：开启 `autoRouteCapabilities` 时优先切到有能力的原生 route；关闭时返回本地解释，不向上游试错。

大请求：

- 保留现有 25 MB decoded request cap。
- 增加压缩体解压后超过限制的测试。
- 增加超大图片、不支持图片、不支持文件、混合 text/image/file 的 adapter 测试。

### 8. 工具、MCP、Skill、Hook 安全

本地工具归 Codex 执行。CodexBridge 要保证翻译模型 API 时不破坏工具契约。

规则：

- 不能静默丢弃当前轮 tools。
- 不能暴露 Codex 无法映射回来的 tool call name。
- MCP 工具必须保留 namespace 前缀。
- provider 支持时，保留完整 assistant tool-call + tool-output 配对。
- provider 无法安全 replay 历史工具调用时，才能把历史配对 flatten 成 system context。
- chat provider 不应引导 native Browser、Chrome、Computer Use 插件 bootstrap，除非必要工具存在且支持。
- 模型无法使用所需工具类别时，要本地明确 fallback。

Hook 和插件行为按当前轮能力处理，不按历史记忆处理。旧 prompt 提到插件，不能导致后续轮次自动反复 bootstrap 插件。

### 9. 安全熔断器

增加 request-level 和 conversation-level watchdog。

跟踪内容：

- 单个用户 turn 的上游请求次数。
- 连续工具续写次数。
- 重复 tool name + arguments。
- 没有新用户输入时重复 tool output。
- 重复 provider error fingerprint。
- 重复本地 fallback reason。
- 客户端断开和 timeout。
- 单轮 token 使用增长。

触发动作：

- 达到循环阈值后本地停止。
- 停止后不再请求上游。
- 保留最新有用工具结果。
- 返回简洁本地解释，说明为什么 CodexBridge 停止。
- 写入脱敏诊断日志。

默认限制：

- 上游超时：5 分钟。
- chat 连续工具续写：默认 2 次，弱 adapter 可以更低。
- 重复相同工具调用：同一用户 turn 内第二次重复就停止。
- 重复相同上游错误：短时间内本地短路。
- provider 401 不缓存，因为用户可能马上修 auth。

### 10. 自动路由策略

模型切换默认仍由用户控制。自动切换只允许用于安全或能力保全，并且必须在 metadata/log 中可见。

允许的自动决策：

- 压缩时使用配置好的原生 Responses route。
- 当前模型无法处理必要附件且 `autoRouteCapabilities` 开启时，使用有文件/图片能力的原生 route。
- 没有安全 route 时，返回本地 fallback，而不是上游试错。

禁止的自动决策：

- 普通文本请求因为另一个模型可能更好，就静默切 provider。
- provider 拒绝参数后跨 provider 反复重试。
- 工具循环后继续尝试更弱模型。

### 11. 可观测性

诊断必须能说明请求实际去了哪里、为什么这样处理。

增加脱敏日志：

- route id。
- upstream model。
- adapter id。
- 能力决策。
- 被丢弃的参数。
- 附件处理决策。
- 渲染预算摘要。
- watchdog 决策。
- token 用量和 provider 返回的 cached token 用量。

诊断禁止包含：

- API key。
- Bearer token。
- URL userinfo。
- 原始大文件内容。
- 原始 base64 图片/文件 payload。

## 验证计划

测试是设计的一部分，不是事后补丁。

Adapter contract 测试：

- 每个内置预设都有标准化 adapter profile。
- 每个 adapter 都有参数安全白名单。
- fetch 前会丢弃不支持参数。
- 自定义保守 adapter 只转发最小安全字段。

Conversation rendering 测试：

- 大 canonical history 对小模型和大模型渲染不同，但不会修改 canonical state。
- 同 provider 重复请求时，稳定 prefix 在 history 未变化时 byte-identical。
- 工具调用配对能保持配对，或用安全 header flatten。
- MCP 名称往返不丢失。
- 当前用户输入永远保留。

附件测试：

- 超大 data image 变成占位文本。
- 纯文本模型不会收到 image payload。
- 不支持文件的 chat provider 不接收文件数据。
- 原生 image route 在限制内接收图片内容。
- 混合 image/file/text 轮次保持语义清楚。

压缩测试：

- 全局摘要插入在旧原始轮次之前。
- 每模型视图不能覆盖全局状态。
- 压缩失败不能丢 canonical history。
- 工具 ledger 在压缩后保留。

Watchdog 测试：

- 客户端断开会中止上游。
- 上游超时会停止请求。
- 相同工具调用重复会本地停止。
- 重复 provider error 会短路，不再请求上游。
- 工具输出续写循环会本地停止，不再请求上游。

端到端 provider 类别烟测：

- 原生 Responses 文本。
- 通用 chat 文本。
- DeepSeek 风格 chat tools。
- Kimi 风格 schema。
- 支持视觉的 route。
- 纯文本 route 收到图片时使用占位文本。
- 自定义保守 route。

打包发布闸门：

- `npm run check`。
- `npm run desktop:smoke`。
- `npm run package:win`。
- `npm run package:win:smoke`。
- GitHub Actions release run 通过后，才能称为版本已发布。

## 实现阶段

### 阶段 1：锁定兼容契约

增加 adapter profile 生成和测试，先不改变运行行为。锁住所有内置预设当前可用行为。补上不支持参数、模型类别 smoke path、自定义保守默认值的回归测试。

阶段 1 完成后，仓库必须至少包含：

- `src/adapter-profile.js`：标准化 route 能力和参数白名单。
- `tests/adapter-profile.test.js`：覆盖所有内置预设和自定义保守模式。
- server 层参数过滤测试：证明不支持参数不会发到上游。
- provider 类别 smoke 测试：覆盖 native Responses、DeepSeek、Kimi、MiniMax、Doubao、Qwen、generic chat、自定义保守模式。

### 阶段 2：抽出渲染边界

把 conversation rendering 从 `responses-to-chat.js` 中抽出来，形成接收 canonical state 和 adapter profile 的 renderer。已有测试通过的行为必须保持等价。

### 阶段 3：安全熔断器

增加重复工具调用检测、重复错误检测、单用户 turn 上游预算、更清楚的本地停止响应。

### 阶段 4：附件和压缩策略

增加 attachment ledger、全局摘要表示、压缩 route 策略，以及小/大模型切换测试。

### 阶段 5：可观测性和 UI 展示

在诊断和 usage summary 里展示 adapter id、被丢弃参数、附件决策、watchdog 停止原因、cache/cached-token 信号。

## 回滚策略

每个阶段都要能独立发布。如果某阶段导致 provider 退化：

- 回滚该阶段 commit。
- 尽可能保留捕获退化的测试。
- 有已知 provider 类别失败时不发版。

运行时配置可以临时提供 `compatMode: "legacy"`，仅用于紧急支持。它保留旧转换路径一个发布周期，但不能关闭防循环、断开中止、重复上游失败短路等 watchdog 保护。

## 验收标准

设计实现完成的标准：

- 所有内置预设都有 adapter profile 和兼容性测试。
- 自定义模型默认进入保守安全行为。
- provider-specific 参数过滤有测试。
- canonical history 能跨小模型渲染、压缩和模型切换存活。
- 工具、MCP、工具输出续写都有回归测试。
- 附件行为显式且有测试。
- watchdog 能本地停止重复 token 浪费行为。
- 诊断能解释能力决策，且不泄露密钥或 payload。
- 本地完整验证和打包验证都通过后才发版。
