# CodexBridge Goal Coverage Audit

Last updated: 2026-07-06

This document keeps the long-running product goal stable. It is not a release note and it is not a substitute for real testing. Its job is to separate:

- current code evidence that is covered by tests or local preflight,
- real environment acceptance that needs real keys, a running Router, or release artifacts,
- the next useful product work.

Do not treat missing real Key, real Router, or real installer evidence as a repository code blocker. The release gates should still surface those checks, but they belong to real environment validation.

## Current Gate

- 当前代码证据: `npm run check` passed with 435/435 tests on 2026-07-06.
- Current code-ready evidence: `npm run release:code-ready -- --json` passed with `codeReady.ok=true` and `releaseGate.codeOrConfigOk=true`.
- Real environment验收: still required for a live Router run, real image provider test, real capability provider/local bridge test, and real Windows installer artifacts.
- Policy: 不把真实 Key、真实 Router、真实安装器证据当作仓库代码阻塞.

## 第一阶段：图片生成代理

Status: code-complete for local behavior; real provider coverage still needs real API keys.

当前代码证据:

- 图片供应商页支持测试提示词、测试生图、耗时、错误原因、本地保存路径和预览。
- 图片生成历史支持缩略图、供应商、来源模型、时间、打开文件夹、清理旧图片。
- 生图错误会按 Key、余额/额度、限流、模型名、尺寸、审核、下载失败等类别转成人话。
- 供应商模板覆盖硅基流动、智谱/Z.ai、OpenAI、通用接口。
- 模型列表把生图代理收进高级设置，常态保留图片上传和上下文。

真实环境验收:

- 用真实 SiliconFlow 或其他国产生图 Key 跑一次成功生图，确认返回图片被保存到本地并能在 Codex 里展示。
- 用一个失败 Key 或错误模型名跑一次失败，确认错误文案对普通用户可读。

下一步:

- 收集真实供应商返回格式差异，必要时给单个供应商加更精确的返回字段模板。

## 第二阶段：代理底座和发布体检

Status: code-complete for generic bridge flow and local gates; real evidence still required before publishing.

当前代码证据:

- 能力代理底座已经抽成识别请求、选择供应商、执行、保存结果、返回可展示内容。
- 模型能力诊断页展示图片上传、工具调用、MCP、文件、音频、附件降级、长上下文、生图代理和原因说明。
- 生图路由持续补充误触发保护，管理、设置、文档、规则类请求不会误发给生图 API。
- 供应商健康检查能检查 Key、模型名、权限/余额、返回格式，并给中文结论。
- 配置包支持模型、供应商、图片供应商、能力供应商、设置档、预算和 Codex 资源清单；API Key 默认不导出。
- 自动更新流程已覆盖下载、启动安装器/便携替换、重启新版、清理安装包和旧版本，真实 Setup.exe 生成依赖 NSIS 或 GitHub Actions。
- 发布前体检已把启动体检、路由体检、供应商体检、图片代理体检和安装器证据汇入 preflight/release gate。

真实环境验收:

- 启动真实 Router 后跑严格发布门禁。
- 提供真实 release 目录，包含 `CodexBridge-Windows-x64-Setup.exe` 和 `CodexBridge-Windows-x64-Portable.zip`。
- 在安装 NSIS 的 Windows 环境或 GitHub Actions 验证真实安装器。

下一步:

- 保持 `release:code-ready` 与 `release:gate` 的边界：前者收代码，后者拦真实发包。

## 第三阶段：能力扩展

Status: core capability market is in place; deeper real provider adapters can be added incrementally.

当前代码证据:

- 通用能力代理已经覆盖 image_generation、OCR、web_search、browser、computer_use、file_processing、webpage_screenshot、speech、video。
- Chrome / Computer Use 已采用 CodexBridge 中转层思路：非 GPT 模型不直接拿 GPT 原生工具，而是输出受控意图，由本地桥接执行安全动作再回填结果。
- 多供应商能力市场支持多个供应商、默认能力、优先级、备用和启停状态。
- 本地能力模板包括本地浏览器、本地网页截图、本地文件、本地 Computer Use 安全动作。

真实环境验收:

- 至少选择一个远程 OCR/搜索/截图/语音/视频供应商做成功和失败各一次的真实体检。
- 在真实桌面环境验证本地浏览器/Computer Use 桥接的安全动作边界。

下一步:

- 如果用户选择具体国产 OCR、搜索或视频供应商，补供应商专用模板和错误翻译。

## 第四阶段：智能路由

Status: implemented behind explicit user switches. Keep both off by default.

当前代码证据:

- 自动选模型：已实现，默认关闭。
- 失败自动切换：已实现，默认关闭。
- 设置页有明确开关，文案说明实验能力且不会默认接管用户手动选择。
- 自动选模型覆盖代码任务、长上下文任务、普通低价聊天、生图任务。
- 失败自动切换覆盖 429、余额不足、502/超时等可重试上游错误，并跳过冷却中、未授权、预算超限或不健康候选。
- 成本和额度控制支持全局、模型和供应商每日请求、Token、费用估算和本地拦截。

真实环境验收:

- 在用户明确开启开关后，用两个真实供应商验证一次 429/502 后的备用模型切换。
- 在关闭开关时确认同样请求不会自动改模型或自动切换。

下一步:

- 自动切换后的用户提示继续打磨，确保日志和对话里都能说明原模型、备用模型和原因。

## 第五阶段：用户资产

Status: local assets are mostly implemented; cloud backup is intentionally not started.

当前代码证据:

- 会话/项目管理支持项目文件夹式展示、无项目会话、导出 Markdown、恢复计划、历史找回和归类依据说明。
- 会话中心和导出的 Markdown 都已明确写入迁移说明：导出文件用于留档/迁移参考，不会自动写回 Codex Desktop 本地会话数据库；单会话导出有每个会话的迁移说明，多会话导出顶部有 `迁移清单`，项目会话和无项目会话会给不同处理提示。
- 本地配置包支持导出、导入预览、敏感 Key 默认不导出、同步目录导出和导入前备份恢复。
- 插件/技能/MCP 管理中心支持当前可用与缓存/市场资源区分、启用/停用、更新、卸载、诊断、详情和用途说明。
- Codex 资源数量以 Codex CLI 当前已安装且启用的资源为准，本地缓存只做诊断，不冒充可用资源。

真实环境验收:

- 在一台干净机器导入配置包，确认模型、供应商、能力供应商、预算和资源清单恢复，API Key 需要用户重新填写。
- 在真实 Codex 桌面里核对项目/会话数量和 CodexBridge 归类依据是否一致。

下一步:

- 后续如果要做“自动导入/回写 Codex 会话库”，必须另做设计和真实 Codex 桌面验证；当前导出能力只承诺迁移参考和人工恢复，不冒充自动恢复。

## Operating Rules

- Normal routing must not regress while adding capability routing.
- Smart routing auto-select and failover must never be enabled by default.
- Real provider and installer checks must stay visible, but they should be handed to real testers when code-ready is already clean.
- New behavior should have tests that fail first and then pass.
