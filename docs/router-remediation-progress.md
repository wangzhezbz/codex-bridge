# CodexBridge 路由整改执行台账

更新时间：2026-07-10

这份台账只记录本轮对标 ccswitch / codex++ 后的 8 项核心整改，避免重复优化已经完成的内容。

## 8 项计划状态

1. 路由契约统一：进行中
   - 已新增 `src/route-plan.js`，把普通模型、Codex 辅助任务、旧 `cb-*` 槽位回退放到同一个 RoutePlan 入口。
   - 已把 `/v1/responses` 入口切到 RoutePlan。
   - 已阻止“辅助任务模型被删后偷偷回退第一个模型”的行为，改为本地中文提示且不请求上游。

2. 辅助任务路由：进行中
   - 已保留“拦截 Codex 辅助任务”和“转发到指定辅助模型”两种模式。
   - 待继续检查设置页删除模型、同步模型、导入配置时是否会自动清理失效引用。

3. 转换兼容矩阵：进行中
   - 已新增 `src/route-capability-matrix.js`，从 adapter contract 生成用户可读的能力矩阵。
   - 已把矩阵接入 Codex 可见模型目录和桌面 `capabilityStatus`。
   - 已覆盖图片输入、工具、MCP、文件、音频、压缩、长上下文和生图代理状态。
   - 待继续让能力页前端直接展示矩阵，减少手写说明。

4. 错误分类与熔断：已完成核心收敛
   - 已把 401 / 402 / 429 / 5xx / 网络超时 / 流式中断 / 工具循环归类成中文短错误，统一保留“报错信息”。
   - 已调整限流分类优先级：只有 `provider_rate_limited` 或 HTTP 429 先判限流；timeout、stream、502/504 网关异常不会被误判成本地限流。
   - 已确认重复请求拦截只缓存 400/401/402/403/413/415/422 这类确定性失败；503、502、网络超时、流式中断会放行自动重试。

5. 模型身份与无登录显示：已完成本轮修复
   - 已让 OpenAI 兼容模型目录保留标准化后的 `id / owned_by / name / display_name / description`，避免 provider family 被推断出来后又被路由别名覆盖成“自定义”。
   - 已新增回归测试，覆盖 Kimi 这类 provider family 推断后仍显示真实供应商和模型名。

6. 诊断与资源页对齐：已完成本轮主口径收敛
   - 插件主统计已改为优先使用 Codex CLI 已安装插件列表，计入所有真实 marketplace 外部插件，不再只认 OpenAI 白名单源。
   - CLI 不可用或安装列表为空时，只使用 `config.toml` 里已启用的外部插件兜底；本地缓存不再冒充“已安装插件”。
   - `openai-bundled` 内置插件和 `personal` 本地插件不计入主插件数量，只放高级诊断。
   - 技能主统计继续使用本地 Codex 技能设置；插件内置技能、缓存技能和 prompt-input 额外技能只放诊断区，避免把用户看不见的项混进主列表。
   - 已新增/更新资源页回归测试，覆盖缓存不进主统计、config 兜底、Claude 官方市场插件计入主列表。

7. 能力边界：已完成本轮收敛
   - 图片生成继续作为唯一已自动接管的扩展能力展示。
   - OCR、搜索、浏览器、Computer Use、文件、语音和视频供应商已统一放到“实验能力供应商”，只用于手动体检和试运行，不再暗示会自动接管模型路由。
   - 实验能力配置入口已移到模型能力诊断前面，避免用户找不到配置入口。
   - 旧 `image_generation` 能力供应商不再混入实验能力列表，避免和专用图片供应商重复。
   - 未配置实验能力供应商不再算启动体检提醒，也不再进入正式发包真实环境必检清单。

8. 启动性能：已完成本轮关键优化
   - 首屏继续使用 `state:get({ lite: true })`，资源、会话、体检、图片/能力历史等重数据只在进入对应页面时加载。
   - 旧版免安装数据迁移已从主进程模块加载阶段移到窗口加载后的后台任务，避免打包版双击时先同步扫描桌面/上级目录导致十几秒卡住。
   - 后台迁移完成并复制到旧数据时会刷新界面，仍保留旧版配置恢复能力。

## 本轮已新增验证

- `tests/route-plan.test.js`
  - 辅助任务使用指定模型。
  - 指定辅助模型被删除时不回退默认模型。
  - 未指定辅助模型时才使用第一个可用模型。
  - 旧 `cb-*` 模型槽位回退到当前默认模型。
- `tests/adapter-profile.test.js`
  - 能力矩阵不会改变 adapter contract。
  - Chat 路由文件能力明确标记为降级而不是原生。
- `tests/desktop-settings.test.js`
  - Codex 可见模型目录包含能力矩阵和能力摘要。
- `tests/route-health.test.js`
  - 402 余额、502/504 网关、timeout、stream、400 参数错误不会被误判成限流。
  - 真正的 429 / TPD rate limit 仍识别为供应商限流。
- `tests/upstream-proxy.test.js`
  - 常见供应商 HTTP 错误输出中文短句，并保留真实“报错信息”。
- `tests/server.test.js`
  - 全量通过，覆盖辅助任务路由、重复请求拦截、可重试 502/503/stream 不缓存。
- `tests/desktop-renderer.test.js`
  - 能力页文案保持简短，实验能力配置必须在模型能力诊断前展示。
- `tests/desktop-settings.test.js`
  - 未配置实验能力供应商不再产生启动提醒或发包门禁；已配置但失败、过期或默认供应商停用仍会提示。
- `tests/desktop-data-dir.test.js`
  - 旧版免安装数据迁移仍能复制缺失配置，且不会覆盖新配置。

## 2026-07-08 第二轮执行记录

目标：继续对齐 ccswitch / codex++ 的核心路由体验，先补底层状态，不重复调整已经收敛过的资源页和能力页。

本次处理：

- 路由健康快照新增 `availability` 和 `circuitState`，让上层能区分“可用、限流冷却中、上次失败待恢复、未验证、已禁用”。
- 只有本地冷却仍有效时才把路由标成 `rate_limited/open`；如果冷却已经结束但上次失败是 429，则标成 `degraded/half_open`，避免长期显示为正在限流。
- 禁用路由现在明确标成 `disabled`，不计入异常路由数量。
- 桌面端 Router 健康探测结果改成中文提示，避免用户看到英文健康状态。
- 已补 `tests/route-health.test.js` 覆盖冷却、半开、禁用三种状态。

未处理：

- 本次不改打包和 GitHub 发包流程。
- 本次不重新改资源页、能力页和模型页 UI。
- 下一步再把这些底层状态接入智能切换和用户可见中文错误摘要。

## 下一步

8 项计划的本轮核心整改已完成；第二轮从路由健康状态开始继续补齐高可用闭环。

## 2026-07-08 第三轮路由安全体检

目标：扫描近期大量改动后是否还有会影响核心转发的路由漏洞，重点保证 Codex 请求不会被错误兜底到不可用模型。

本次处理：

- 辅助任务模型兜底现在只会选择可用路由；禁用、缺少 Key、处于本地冷却或被当前请求排除的路由不会再被选中。
- 用户配置的辅助任务模型如果被删除、禁用或缺少 Key，会直接返回“辅助任务模型不可用”，不会静默切到默认模型。
- 旧的 `cb-*` 模型名兜底现在只会回退到当前可用默认路由或第一个可用路由，不再选中禁用/无 Key/冷却路由。
- `/v1/models` 和 `/model-catalog.json` 不再暴露 `enabled: false` 的模型，避免 Codex 模型栏看到已停用或旧配置模型。
- 手动指定已禁用模型时会按未配置处理；如果所有模型都被禁用，默认路由会在入口直接失败，不再返回空路由进入后续转发链路。
- 发版体检测试同步当前产品口径：未配置实验能力供应商不再作为严格发版阻断项。

已新增/更新验证：

- `tests/route-plan.test.js`
  - 指定辅助模型禁用或缺少 Key 时不回退。
  - 未指定辅助模型时跳过禁用路由，选择第一个可用路由。
  - 当前请求排除的路由不会被辅助任务兜底选中。
  - 旧 `cb-*` 模型名不会回退到不可用默认模型。
- `tests/route-fidelity-regression.test.js`
  - 禁用路由不会进入 Codex 可见模型目录。
  - 手动路由不会命中禁用模型。
  - 所有模型禁用时路由入口直接报未配置。
- `tests/server.test.js`
  - `/v1/models` 和 `/model-catalog.json` 同步隐藏禁用路由。
- `tests/package-naming.test.js`
  - 发版体检门禁与“实验能力不再默认提醒”的产品逻辑保持一致。

已验证：

- `node --check src\route-plan.js src\smart-routing.js src\config.js src\model-catalog.js` 相关文件语法通过。
- `node --test tests\route-fidelity-regression.test.js tests\route-plan.test.js tests\server.test.js tests\smart-routing.test.js`：260 项通过。
- `node --test tests\package-naming.test.js`：41 项通过。
- `npm run test:router`：457 项通过。
- `npm run test:desktop`：429 项通过。
- `npm run check:syntax`：通过。
- `git diff --check`：无 whitespace error；仅提示两个既有 CRLF/LF 换行提醒。

## 2026-07-08 第四轮阶段 1：RouteDecision v2

目标：把普通路由、智能切换、旧 `cb-*` 模型兜底和 Codex 辅助任务转发统一到一份稳定决策摘要里，后续日志、错误提示和 UI 诊断都从同一个口径读取。

本次处理：
- `src/route-plan.js` 新增 `ROUTE_DECISION_VERSION = route-decision-v2`，每个 RoutePlan 都带 `decision` 字段。
- `decision` 统一记录：请求类型、请求模型、决策原因、原路由、目标路由、是否改路由、是否重写上游模型、被跳过的候选路由和用户可读摘要。
- 路由排除支持 `routeExclusions.items/details/ids`，预算、健康和当前请求排除原因会被写入 `decision.skippedRoutes`。
- `src/upstream.js` 的 `route_trace` 优先读取 `context.routePlan.decision`，同时保留旧的 `reason/requestedModel/originalRoute/selectedRoute/selectedUpstreamModel/changed` 字段，兼容既有日志测试。

已验证：
- `node --test tests\route-plan.test.js`
- `node --test --test-name-pattern "server auto-selects a code model only when the explicit switch is enabled" tests\server.test.js`
- `node --test --test-name-pattern "server falls back to the default route for stale Codex desktop model ids" tests\server.test.js`
- `node --test --test-name-pattern "server routes Codex desktop auxiliary model requests to the configured helper model" tests\server.test.js`

## 2026-07-08 第四轮阶段 2：资源页插件统计对齐

目标：资源页主统计只反映 Codex 当前实际可用资源，并修复用户机器上 Codex 插件页显示 5 个、CodexBridge 显示 0 个的问题。

本次处理：
- `desktop/settings.mjs` 的 Codex CLI 插件快照解析兼容只有 `name/displayName/title`、没有 `id/pluginId` 的格式。
- 对这类 name-only 插件生成稳定 slug，例如 `GitHub -> github`、`HyperFrames by HeyGen -> hyperframes-by-heygen`。
- 继续复用已知 slug 到 marketplace 的映射，保证这些插件会进入“已安装插件”主统计，而不是被当成未知项丢弃。

已验证：
- `node --test --test-name-pattern "resource center counts Codex CLI installed plugins when snapshot only exposes display names" tests\desktop-settings.test.js`
- `node --test --test-name-pattern "resource center" tests\desktop-settings.test.js`

## 2026-07-09 第四轮阶段 3：能力页降噪和接管边界

目标：能力页不再把 OCR、搜索、浏览器、Computer Use、语音、视频等实验供应商展示成已经自动接管的能力，避免用户误以为配置后模型会自动调用。

本次确认：
- 能力页顶部只展示当前模型真实能力、降级方式和已接入代理能力。
- “实验能力供应商”明确标注只用于手动体检和试运行，不会自动接管模型请求。
- 当前自动接管的扩展能力只保留图片生成；实验能力记录也只记录手动测试结果。

已验证：
- `node --test --test-name-pattern "desktop renderer keeps release, capability, resource, and session copy concise" tests\desktop-renderer.test.js`

## 2026-07-09 第四轮阶段 4：模型名缓存和失效模型引用

目标：降低未登录 Codex 时模型栏显示“自定义”的概率，并避免用户改坏或删除模型后，保存其它供应商仍然报 `Selected model is not available`。

本次确认：
- Codex 可见模型目录写入真实 `display_name/name/title`，all-api 模式也不会退回“自定义”。
- `models_cache.json` 会同步 CodexBridge 模型并清理旧的 CodexBridge 缓存项。
- 保存供应商前会修复过期模型选择、辅助任务模型、智能切换模型和失败备用顺序。
- Kimi 等供应商被同步成新的 remote 模型后，旧 `kimi-k2-7-code` 选择会迁移到当前可用模型。

已验证：
- `node --test --test-name-pattern "router config repairs stale auxiliary and smart routing route references|router config builds from repaired selected model ids instead of stale saved ids|provider save repairs stale selected model before refreshing router config" tests\desktop-settings.test.js`
- `node --test --test-name-pattern "applyCodexConfig mirrors CodexBridge models into the Codex model cache|refreshCodexVisibleModelCatalogIfManaged updates the Codex picker cache after route changes" tests\desktop-settings.test.js`
- `node --test --test-name-pattern "all-api Codex-visible model catalog keeps provider display names" tests\desktop-settings.test.js`

## 2026-07-09 第四轮阶段 5：错误提示中文短句化

目标：用户看到错误时，先看到供应商/网络/参数/余额等真实原因，不再把所有失败都理解成 CodexBridge 自己限流或阻止请求。

本次处理：
- 上游 HTTP 错误统一走中文短句：401 提示 API Key，402 提示余额/额度，429 提示供应商限流，5xx 提示服务或网关异常。
- 错误末尾保留 `报错信息：...`，只放状态码和摘要，不再直接塞整段 HTML。
- 上下文压缩失败的本地兜底从英文 `CodexBridge local compact fallback` 改成“上下文压缩失败，已使用本地摘要继续。”。
- 压缩失败原因补齐 `HTTP 状态码 - 报错摘要`，并保留账号、Key、项目 ID 脱敏。

已验证：
- `node --test --test-name-pattern "sendUpstreamError explains common provider HTTP failures in Chinese" tests\upstream-proxy.test.js`
- `node --test --test-name-pattern "chat-routed remote compact" tests\server.test.js`
- `node --test --test-name-pattern "compact fallback" tests\server.test.js`

## 2026-07-09 第四轮阶段 6：真实验收 smoke 和脱敏报告

目标：把需要真实 Key、真实 Router 和真实安装包的验收项沉到可交给测试机执行的报告流程里，本地代码收尾不再因为缺真实数据反复空转。

本次确认：
- `release-preflight` 能读取真实环境验收报告，并能从当前证据生成验收报告。
- `release:code-ready` 在只缺真实环境证据时可以通过，正式发包 gate 仍可用 strict warnings 阻断。
- 打包 smoke 会写机器可读报告，供发包前体检读取。
- 诊断、能力供应商和图片/能力试运行历史会脱敏保存，不把 Key 写进报告。

已验证：
- `node --test --test-name-pattern "release preflight CLI reads real environment acceptance report evidence|release preflight CLI writes a real acceptance report from current evidence|release preflight JSON explains strict warning blockers|release code-ready exits zero when only real-environment evidence is missing" tests\package-naming.test.js`
- `node --test --test-name-pattern "Windows packaged smoke writes a machine-readable report for release preflight|desktop smoke checks cover capability diagnostics and project recovery" tests\package-naming.test.js`
- `node --test --test-name-pattern "redact|diagnostic|acceptance" tests\desktop-settings.test.js`

## 2026-07-09 第四轮阶段 7：启动和 UI 轻量化

目标：降低双击启动后的首屏等待，避免隐藏页面在首屏一起渲染，同时保留设置页、资源页和会话页的真实数据加载能力。

本次处理：
- Renderer 首次只请求 `getState({ lite: true })`，并且 `render()` 只渲染当前可见页面，不再同步渲染模型、能力、资源、会话、日志等所有隐藏页面。
- `settings` 不再触发完整详细扫描；进入设置页时只读取设置需要的备份详情，避免顺带扫描 Codex 资源和会话索引。
- 后台 lite 状态广播不会覆盖已加载过的详细片段，避免资源/会话/体检/备份在页面打开后又被轻量状态冲空。
- 资源、会话、体检仍保持按需加载：进入对应页面时才读取 Codex CLI 快照、资源列表、会话树和启动体检。

已验证：
- `node --test --test-name-pattern "desktop renderer keeps heavy startup data lazy and dense pages folded" tests\desktop-renderer.test.js`
- `node --test tests\desktop-renderer.test.js`

## 2026-07-09 第五轮阶段 1：RouteSync Engine

目标：把模型选择、桌面智能切换、Codex 辅助任务模型、Router 配置和 Codex 模型缓存的同步收敛到一个入口，避免用户改坏或删除某个模型后，保存其它供应商时仍被旧模型引用卡死。

本次处理：
- 新增 `buildRouteSyncPlan()`，先给出同步计划，明确是否需要修复模型引用、是否要写 Router 配置、是否要刷新 Codex 模型缓存。
- 新增 `synchronizeRouteState()`，按计划一次性修复过期选择、辅助任务模型、智能切换模型、失败备用顺序，并重新写入 Router 配置和 Codex 模型缓存。
- 桌面端 `models:repairReferences` 改为调用统一同步入口，不再分散调用引用修复和模型缓存刷新。
- 覆盖用户反馈的 Kimi 场景：旧 `kimi-k2-7-code` 被同步后的 remote 模型替代后，保存其它供应商不应继续报 `Selected model is not available: kimi-k2-7-code`。

已验证：
- `node --test tests\desktop-settings.test.js --test-name-pattern "synchronizeRouteState repairs"`
- `node --test tests\desktop-settings.test.js` 随同该命令全量通过 284 项。

## 2026-07-09 第五轮阶段 2：Route Contract Matrix

目标：把关键路由行为沉淀成一张可执行契约矩阵，后续改智能切换、辅助任务、旧模型兜底或 failover 时先跑矩阵，避免重复修同一类问题。

本次处理：
- 新增 `src/route-contract-matrix.js`，提供 `evaluateRouteContractMatrix()` 和 `evaluateRouteContractCase()`。
- 新增 `tests/route-contract-matrix.test.js`，覆盖手动路由、旧 `cb-*` 模型兜底、Codex 辅助任务、辅助任务模型被删、生图路由、长上下文路由、失败备用顺序。
- 契约报告会返回 `summary`、每条 case 的 `actual` 和 `mismatches`，方便后续接入发布体检或 CI。

已验证：
- `node --test tests\route-contract-matrix.test.js`
- `node --test tests\route-plan.test.js tests\smart-routing.test.js tests\route-contract-matrix.test.js`
- `npm run check:syntax`

## 2026-07-09 第五轮阶段 3：RouteSync 全入口接入

目标：所有会改变模型选择、供应商、模型能力、自定义模型、配置档、配置包、Catalog 和 Codex 应用状态的桌面入口，都必须走统一 RouteSync，避免某个页面保存后继续引用已经删除或同步替换掉的旧模型。

本次处理：
- 新增 `tests/desktop-main-route-sync.test.js`，用源码契约锁定关键 IPC 入口必须直接调用 `syncRouteStateAfterMutation()`。
- `desktop/main.cjs` 新增 `syncRouteStateAfterMutation()`，统一调用 `settings.synchronizeRouteState()`，并记录 mode、选中路由数量、修复前后问题数和 Codex 模型缓存刷新状态。
- 已接入入口：模式切换、桌面设置保存、模型选择、图片上传开关、生图代理选择、图片供应商保存/删除、能力供应商保存/删除、模型能力保存/重置、供应商刷新/保存/重置、Logo 上传应用、自定义模型保存/删除、配置档应用、配置包导入/同步目录导入/备份恢复、Catalog 生成、Codex 应用和初始化。
- 移除主进程里旧的 `refreshCodexModelPickerCache()` 散落刷新路径，避免新入口之外继续绕过引用修复。

已验证：
- `node --test tests\desktop-main-route-sync.test.js`
- `node --check desktop\main.cjs`
- `node --test tests\desktop-settings.test.js`
- `node --test tests\route-plan.test.js tests\smart-routing.test.js tests\route-contract-matrix.test.js`
- `npm run check:syntax`

## 2026-07-09 第五轮阶段 4：RouteSync 用户链路 Smoke

目标：把用户最容易碰到的失效模型链路变成一条可执行 smoke，后续不是只靠分散单测判断，而是直接跑“用户动作链路”。

本次处理：
- 新增 `desktop/route-sync-smoke.mjs`，提供 `runDesktopRouteSyncSmoke()`。
- 新增 `tests/route-sync-smoke.test.js`，覆盖 3 条链路：保存供应商时旧模型选择被修复、辅助任务模型被删除后回到可用路由、导入含旧模型 ID 的配置包后同步到当前远程模型。
- `test:desktop` 已纳入 `tests/route-sync-smoke.test.js`，`check:syntax` 已纳入 `desktop/route-sync-smoke.mjs`。

已验证：
- `node --test tests\route-sync-smoke.test.js`
- `npm run check:syntax`
- `npm run test:desktop`

## 2026-07-09 第五轮阶段 5：Route 请求级 Smoke

目标：把关键路由从“配置同步正确”推进到“真实 `/v1/responses` 请求链路能跑通”，避免旧模型兜底、Codex 辅助任务和生图代理只停留在纯函数或分散单测里。

本次处理：
- 新增 `src/route-request-smoke.js`，提供 `runRouteRequestSmoke()`，可向 Router 的 `/v1/responses` 发送一组 smoke 请求并汇总 `total/passed/failed`。
- 新增 `tests/route-request-smoke.test.js`，启动真实 Router、本地模型假上游和本地图片假上游，覆盖 3 条链路：旧 `cb-*` 模型自动兜底到默认路由、Codex 辅助任务模型转发到配置的 helper 路由、明确生图请求转发到图片代理并返回本地可展示结果。
- `test:router` 已纳入 `tests/route-request-smoke.test.js`，`check:syntax` 已纳入 `src/route-request-smoke.js`。

已验证：
- `node --test tests\route-request-smoke.test.js`
- `node --check src\route-request-smoke.js`
- `node --check tests\route-request-smoke.test.js`

## 2026-07-09 第五轮阶段 6：Route 请求失败链路 Smoke

目标：把真实 `/v1/responses` 失败链路纳入 smoke，确保错误归因清晰、中文可读，并且不会把上游错误、配置错误或防重放保护统一说成 CodexBridge 限制。

本次处理：
- 扩展 `runRouteRequestSmoke()` 的断言能力，支持检查错误码、响应体必须包含的中文原因，以及不应再出现的旧式笼统报错文本。
- 新增失败链路 smoke：辅助任务模型被删、图片代理缺 API Key、上游 401、402、429、HTML 502 网关错误和上游超时。
- `requireApiKey()` 的缺 Key 错误改成中文，返回 `missing_provider_api_key` 时会说明具体模型/供应商缺少 API Key 和应填写的 Key 名。
- smoke 中隔离相同提示词触发的旧请求防重放状态，避免测试之间互相污染。

已验证：
- `node --test --test-name-pattern "route request smoke classifies failure paths" tests\route-request-smoke.test.js`
- `node --test tests\route-request-smoke.test.js`

## 2026-07-09 第五轮阶段 7：运行态路由诊断收口

目标：在不改变转发链路的前提下，让支持诊断报告能直接看到最近请求为什么选中、切换或兜底到某个路由，避免排查时只能读整段 `route_trace` JSON。

本次处理：
- `src/route-trace.js` 新增 `routeDecisionSummaryForLog()`，从已有 `route_decision` 结构化事件生成一行短摘要。
- 摘要包含请求 ID、原因、请求模型到实际路由、上游模型、接口类型、是否发生切换，以及被跳过路由的简短原因。
- skipped route 的详细内容不会进入摘要，避免把 Key、账号或供应商原始错误带进诊断摘要。
- `desktop/settings.mjs` 的支持诊断新增 `Recent route decisions` 区块，自动从最近 `route_trace` 日志中提取摘要。
- 原始 `route_trace {...}` JSON 不再混入 `Recent errors`，避免诊断报告继续变成机器日志。

已验证：
- `node --test tests\route-trace.test.js`
- `node --test --test-name-pattern "supportDiagnostics includes route health, usage, proxy, and update paths without secrets" tests\desktop-settings.test.js`

## 2026-07-09 第五轮阶段 8：路由契约矩阵进入固定检查链路

目标：把前面新增的路由契约矩阵从“手动记得跑”收口到 `npm run check` 固定链路里，避免后续改智能切换、辅助任务、旧模型兜底或 failover 时绕过契约测试。

本次处理：
- `package.json` 的 `test:router` 纳入 `tests/route-contract-matrix.test.js`。
- `package.json` 的 `check:syntax` 纳入 `src/route-contract-matrix.js`。
- `tests/package-naming.test.js` 增加脚本契约断言，后续如果有人把契约矩阵从固定检查链路里移除，会直接失败。

已验证：
- `node --test --test-name-pattern "router checks include the route fidelity and contract matrix suites" tests\package-naming.test.js`

## 2026-07-09 第五轮阶段 9：智能失败切换请求级 Smoke

目标：把智能失败切换从 server 单测推进到真实 `/v1/responses` 请求级 smoke，确保上游失败时是否切备用模型、关闭时是否不切、备用不可用时是否不乱切都有链路证据。

本次处理：
- `tests/route-request-smoke.test.js` 新增 failover smoke：主模型返回 502，开启自动失败切换时切到指定备用模型并返回成功。
- 同一 smoke 覆盖关闭自动失败切换时不偷偷切换，直接返回主模型上游错误。
- 同一 smoke 覆盖备用模型禁用或缺 Key 时不会乱切到不可用模型。
- `src/route-request-smoke.js` 的单条结果新增 `smartFailover` 字段，保留响应里的 `codexbridge_smart_failover` 元数据，方便 smoke 报告直接看出从哪条路由切到哪条路由。
- smoke 同时断言运行日志里出现 `smart-failover` 和 `route_trace` 的 `smart_failover` 决策记录。

已验证：
- `node --test --test-name-pattern "route request smoke covers smart failover" tests\route-request-smoke.test.js`

## 2026-07-09 去重验收：不再重复推进已完成项

目标：先核对已完成记录和固定测试链路，避免把已经处理过的 RouteSync、路由契约、请求级 smoke、资源计数、能力边界、错误中文化、启动发现等事项反复当成“下一步”。

本次确认：
- `package.json` 的 `npm run check` 已固定包含 `check:syntax`、`test:router`、`test:desktop`。
- 路由契约矩阵、路由请求 smoke、RouteSync 用户链路 smoke、桌面 RouteSync 入口契约、资源计数回归、错误中文化回归都已经进入固定测试链路。
- 本轮没有发现需要继续修改同一批功能的失败证据；后续只有在真实用户反馈或固定回归失败时，才针对具体失败点继续改。

已验证：
- `npm run check`：443 项通过，0 失败。

## 2026-07-09 五项对齐收口

目标：把和 ccswitch / Codex++ 对齐时确认的五个核心短板一次性收口：大上下文切小上下文保护、Codex 辅助任务策略、图片/能力供应商模板、配置原子写、资源页当前可用口径。

本次处理：
- 确认并回归大上下文切小上下文链路：用户从大上下文模型切到小上下文模型时，Router 会先使用切换前的大上下文模型做自动压缩，再把压缩后的上下文交给目标小模型。
- 确认并回归 Codex 辅助任务链路：辅助任务可以配置指定模型；指定模型被删除、禁用或缺 Key 时不会静默乱切，会进入明确的不可用处理。
- 确认并回归图片供应商模板和通用接口：保留硅基流动、智谱 / Z.ai、OpenAI、火山方舟和通用接口模板；尺寸支持留空交给上游默认。
- 补齐密钥和桌面选项的原子写入：`saveSecrets()` 与 `saveDesktopOptions()` 统一走临时文件写入再 rename，避免设置保存一半导致模型引用或桌面策略损坏。
- 确认并回归资源页当前可用口径：主列表继续以 Codex 当前可见/可用资源为准，本地缓存、未启用和市场候选只留在诊断口径，不混进当前数量。

已验证：
- `node --test tests\route-plan.test.js tests\route-trace.test.js tests\smart-routing.test.js`
- `node --test --test-name-pattern "context|auxiliary|image generation|resource|atomic|provider save repairs|stale selected|generic image|Codex picker cache|context windows" tests\server.test.js tests\desktop-settings.test.js tests\desktop-renderer.test.js`
- `npm run check`：445 项通过，0 失败。

## 2026-07-09 发包前收口文档

目标：把测试包前需要看的交付清单、用户更新日志、真实验收边界、已知边界和不再重复推进事项收成一份文档，避免继续在同一批功能上反复绕圈。

本次处理：
- 新增 `docs/pre-release-handoff.md`，按路由、模型自愈、错误提示、上下文、资源页、能力页、图片生成、自动更新、启动性能等模块列出已交付内容。
- 同一文档增加“给用户看的更新日志”，避免把内部实现细节直接写给普通用户。
- 同一文档列出必须真实验收的项目，包括安装版、便携版、真实 API Key、模型自愈、智能失败切换、图片生成、资源页数量和大上下文切小上下文。
- 同一文档列出已知边界和“不再重复推进的事项”。
- `docs/release-checklist.md` 已把该文档放到 tag 前第 0 步。

已验证：
- `npm run check`：443 项通过，0 失败。

## 2026-07-10 Codex 0.144 / GPT-5.6 兼容整改

目标：修复 Codex 更新后自定义 `cb-*` 模型被 ChatGPT 账号模型白名单拒绝的问题，接入 GPT-5.6，并把资源统计和启动卡顿按当前 Codex 实际行为重新收口。

本次处理：

- CodexBridge 改用独立的 `[model_providers.codexbridge]` 自定义 provider，不再把 `cb-*` 模型挂在内置 `openai` provider 上。这样 Codex 不会再把自定义路由名当成 ChatGPT 订阅模型校验。
- 混合模式继续使用 OpenAI 登录鉴权；全 API 模式使用本地 Router 固定鉴权头。两种模式都走 `http://127.0.0.1:<port>/v1` 的 Responses 接口。
- 新增托管配置自愈：只修复 CodexBridge 自己写入的旧配置，保留用户当前选择并在改写前创建备份。
- 不再改写 Codex 原生 `models_cache.json`。CodexBridge 只维护自己的模型目录，避免 Codex 更新后缓存结构变化造成模型栏异常。
- 新增 GPT-5.6 Sol、Terra、Luna 预设，按当前 Codex 原生缓存保留上下文、推理等级、Responses Lite、摘要、verbosity、搜索工具和多代理版本元数据。
- provider TOML 生成已拆到 `desktop/codex-provider.mjs`，混合模式和全部 API 模式共享同一份稳定配置契约。
- 资源页主统计改成 Codex 设置页口径：插件只算 `codex plugin list --json` 的已安装项；MCP 只算 `config.toml` 中用户可见配置并排除内置 `node_repl`；技能只算已安装插件实际提供的可见技能；市场只算配置的市场源。
- 当前机器实时对照结果为：插件 17、MCP 2、技能 36、市场 2。此前截图的 16 / 2 / 33 / 2 少的是后来安装的 Cowart（1 个插件、3 个技能）。
- 旧便携版数据搜索和迁移移入 Worker，窗口显示后不再同步遍历开始菜单、桌面或历史安装包目录，避免主线程卡住。
- `desktop-runtime.log` 改为 5 MB 主文件加 1 个 5 MB 备份；历史 31 MB 日志会在下次写入时自动收敛，不做批量删除。
- 更新器测试临时目录改到系统临时目录，项目根目录不再继续产生 `.tmp-updates-*`。现有历史目录保留，没有执行批量删除。

本轮工作区边界：

- 基线分支：`codex/all-model-contract-lock`，基线提交：`2b82bfe0282680f2335fe5f48d61026aaef36800`。
- 接手时工作区已有大量未提交修改；本轮只在现有文件上增量修改，不重置、不回退、不覆盖用户改动。
- 本轮新增文件：`desktop/codex-provider.mjs`、`desktop/legacy-migration-worker.cjs`、`desktop/runtime-log.cjs`、`tests/desktop-codex-provider.test.js`、`tests/desktop-runtime-log.test.js`。
- 本轮未打包、未暂存、未提交、未推送、未发布 GitHub。

新的权威口径：

- 以后涉及 Codex 模型展示，优先使用自定义 provider 和 CodexBridge 自有模型目录，不再把修改原生模型缓存当成解决方案。
- 以后涉及资源数量，必须同时对照 Codex CLI 已安装插件、用户可见 MCP 配置、插件可见技能和市场配置，缓存/候选只放高级诊断。
- 已有历史台账中与上述两条冲突的描述视为过时，不再据此重复改造。

本轮验证：

- `node --test tests/desktop-settings.test.js`：300 项通过。
- `npm run check`：语法、Router、桌面、文档和打包契约全部通过。
- `npm run desktop:smoke`：通过，源码版 Electron 输出 `providers=15 resources=17/2/36/2`。
- `git diff --check`：无 whitespace error；只有既有 CRLF/LF 换行提醒。
- 日志轮转实测：`desktop-runtime.log` 180 字节，`desktop-runtime.log.1` 5,242,880 字节。

## 2026-07-10 核心风险收尾

目标：按 1→7 顺序完成数据安全、会话连续性、模式鉴权、上下文策略、正常重试、跨机器资源发现和配置事务七项整改。每项必须记录根因、失败测试、最小修改、回归结果和剩余风险，禁止用旧的绿色测试代替新行为验收。

执行边界：

- 当前分支 `codex/all-model-contract-lock`，接手基线提交 `2b82bfe0282680f2335fe5f48d61026aaef36800`。
- 接手时有 82 个既有变更路径；49 个跟踪文件 diff 为新增 54311 行、删除 7302 行。全部保留。
- 不访问真实用户 Key，不写真实 Codex `state*.sqlite`，行为测试只使用临时目录和本地 mock。
- 不打包、不暂存、不提交、不推送、不发布。
- 设计记录：`docs/superpowers/specs/2026-07-10-codexbridge-core-risk-remediation-design.md`。
- 执行计划：`docs/superpowers/plans/2026-07-10-codexbridge-core-risk-remediation.md`。

接手验证基线：

- `npm run check`：通过；现有绿色测试中仍包含自动改 state SQLite、completed/error 重放等旧契约。
- `npm run desktop:smoke`：通过，`providers=15 resources=17/2/36/2`。
- `npm run release:code-ready`：通过 15、提醒 7、失败 0。
- `git diff --check`：通过，仅有既有 CRLF/LF 提醒。

根因总览：

1. `applyCodexConfig()` 越权把配置写入和 Codex 官方会话数据库迁移绑在一起。
2. Chat `ResponseHistory` 只有内存，没有 Bridge 自有持久化和“引用历史缺失”错误状态。
3. 模式、上下文、重复保护、资源发现分别维护权威规则，造成运行态与展示态分裂。
4. 桌面多个 IPC 入口并发读改写，多文件没有统一暂存、验证、提交和回滚。

检查表：

- [x] 1. P0：停止自动写 Codex state SQLite；显式迁移只允许 `codex-bridge → codexbridge`。
- [x] 2. P0：Bridge Chat 历史跨 Router 重启持久化，缺失时明确报错。
- [x] 3. P1：模式切换同步 Router、模型目录和 Codex 鉴权并可回滚。
- [x] 4. P1：建立唯一上下文策略，压缩失败保持旧模型。
- [x] 5. P1：默认只拦截 pending 精确重复，正常重试和配置变化必须放行。
- [x] 6. P2：统一 Codex CLI 定位，未知资源显示“无法读取”，并兼容新版 ChatGPT / 旧版 Codex 的安全重启。
- [ ] 7. P2：配置写入串行化、原子化并支持跨文件回滚。
- [ ] 最终：全量检查、桌面 smoke、发布代码体检、diff 检查、整体验收审查。

### 记录 0：设计与执行基线

状态：已完成。

本次处理：

- 将七项风险归并为“官方状态越权、Bridge 状态不持久、策略权威分散、配置写入无事务”四类根因。
- 选择提取窄组件并保持既有外部接口的渐进方案，拒绝继续在大文件中散点修补，也不进行全量状态管理重写。
- 固定每项 RED→GREEN→REFACTOR 和即时台账更新规则，避免后续窗口重复劳动。
- 完成依赖审查：保持 1→7 验收顺序，但 Task 2 先保存旧路由策略输入，Task 3 先建立配置事务/revision 和 Codex 定位器基础；Task 4、6、7 只完成各自剩余职责，禁止重复实现同一基础设施。

验证：设计与执行计划已经写入仓库文档；尚未修改生产代码。

### 记录 1：Codex state SQLite 默认只读

状态：已完成；第二轮任务审查通过。

根因：

- `applyCodexConfig()` 在配置已变化和配置未变化两个分支都会调用旧会话同步器；Router 启动与启动兼容修复又会进入 `applyCodexConfig()`。
- 旧同步器会扫描主库和历史备份，自动导入主库中已删除的线程，把 `codex-bridge` 及多种本地 provider 猜成 `openai`，并重写来源、归档和用户事件字段。
- 旧备份按 DB、WAL、SHM 三个文件分别复制，不能保证得到同一时点的一致 SQLite 快照。

本次处理：

- 配置应用、Router 启动准备、启动兼容修复和历史显示修复不再调用任何 Codex state 写入器，也不再返回 `historySync` 写入结果。
- 删除旧的备份线程导入、批量 provider/可见性字段重写和 DB/WAL/SHM 分别复制实现；兼容入口只返回 `explicit_migration_required`，不扫描数据库。
- 第一版把普通历史诊断的备份关联查询改成 `readOnly/query_only`；审查后决定彻底移除备份 ATTACH 脚手架，避免普通诊断继续触碰历史备份。
- 新增 `desktop/codex-state-migration.mjs`：必须显式选择 `.codex` 目录内的单个 `state*.sqlite`；预览使用只读连接并返回 SHA-256 确认指纹；确认迁移先用 SQLite online backup 生成一致快照并规范为单文件，再在 `BEGIN IMMEDIATE` 事务中只执行精确的 `codex-bridge → codexbridge` 更新。
- 指纹缺失、数据库在预览后变化、目标越出所选 `.codex` 目录时全部拒绝；迁移不会读取或导入任何历史备份线程，也不会猜测 `openai` 来源。

TDD 证据：

- RED：`node --test tests/desktop-codex-state-migration.test.js`，9 项失败。失败输出明确显示自动入口把 `codex-bridge/custom/deepseek/kimi/litellm/unknown` 改成 `openai`，并把 backup-only 的 `deleted` 线程重新导入；显式迁移模块尚不存在。
- GREEN：同一命令 9/9 通过，覆盖 current/changed config、Router 启动准备、启动修复、backup-only 不复活、只读预览、缺失/过期确认、越界路径、精确 provider 更新和单文件一致快照。
- 相关回归：`node --test tests/desktop-settings.test.js tests/desktop-main-route-sync.test.js tests/desktop-codex-provider.test.js`，292/292 通过。
- 语法：`npm run check:syntax` 通过，并已把 focused 测试和新迁移模块加入桌面测试/语法入口。

第一轮审查：Needs fixes。

- SQL 必须显式 `COLLATE BINARY`，否则真实表若声明 NOCASE 会扩大迁移范围。
- 快照创建中途失败也必须清理该次唯一快照；并发迁移不能复用同一路径。
- 普通支持诊断不得继续枚举并 ATTACH 历史备份数据库。
- 预览必须在单个只读事务快照内生成。

审查修复：

- provider 统计与更新显式使用 `COLLATE BINARY`，NOCASE 表结构也只迁移完全匹配值。
- 快照使用 UUID 唯一路径；backup/规范化任一阶段失败都会逐一清理本次 DB/WAL/SHM 明确路径；双并发迁移不会共享快照。
- preview 在 `readOnly + query_only + BEGIN/COMMIT` 单一读取事务内完成。
- 普通 session/export/diagnostics 全部是 read-only + query-only，旧备份枚举和 ATTACH 脚手架完全移除。
- 删除主进程死亡的 history-sync 日志路径；恢复文案不再承诺归入内置 OpenAI。
- Node engine 调整为 `>=22.16.0`，与 `node:sqlite.backup` 最低支持版本一致。
- 修复 RED：20 项中 8 项按预期失败；修复 GREEN：20/20 通过。
- 修复后相关回归：293/293 通过；语法和 `git diff --check` 通过。
- 第二轮审查：Spec Compliance ✅，无 Critical、无 Important，Task quality Approved。

剩余边界：

- 本任务只提供显式迁移内核，没有新增自动迁移或隐式 UI 触发；后续若接 UI，必须原样保留“用户选择单库 → 只读预览 → 指纹确认”边界。
- 没有访问真实用户 Codex 数据库或 Key；所有行为测试只使用系统临时目录中的 SQLite 文件。

### 记录 2：Bridge Chat 历史跨 Router 重启持久化

状态：已完成；第三轮任务审查通过。

根因：

- `createRouterServer()` 每次构造新的纯内存 `ResponseHistory`，Router 关闭后累计 messages、response 和路由元数据全部消失。
- Chat 路由引用未知 `previous_response_id` 时，旧门面返回空 messages，Router 会把当前 turn 当成新会话继续发给上游，造成无提示断链。
- messages 与 response/meta 原来分两次写内存，无法对持久存储提供一行完整、可事务提交的 turn。

本次处理：

- 新增 Bridge 自有 `state/response-history.sqlite3`，使用内置 `node:sqlite`、WAL、`synchronous=NORMAL`、5000ms busy timeout 和 schema v1；不发现、不读取、不写入 Codex 官方状态库。
- 一行保存 gzip JSON 的累计 messages、response 和非敏感路由元数据，以及原始/存储字节数和 created/updated/access/expiry 时间；默认滑动 TTL 30 天、容量 2GiB、单条完整记录上限 100MiB。
- `recordTurn()` 在事务前序列化压缩，事务内 UPSERT、清除同 ID tombstone、清理过期/冷记录并提交；容量清理保护最近一小时访问记录与当前写入记录，必要时允许软超额。
- `ResponseHistory` 保留既有同步方法，新增 `recordTurn/lookup/prune/health/close`，优先内存、其次 SQLite；TTL、LRU、expired/evicted/corrupt/storage_unavailable 状态进入统一 lookup 契约。
- Router 生产启动从 `CODEXBRIDGE_DATA_DIR`、`ROUTER_CONFIG` 或 cwd 解析 Bridge 数据根；桌面 Router 环境显式设置 `CODEXBRIDGE_DATA_DIR=rootDir`。
- `createRouterServer(config, { history, historyPath, historyOptions })` 支持注入或内部拥有持久历史；关闭时只关闭内部拥有的 store。
- Chat 路由对持久历史的 missing/expired/evicted/corrupt 返回 409 `local_history_unavailable`，存储不可用返回 503；两类错误都不进入智能 failover。原生 Responses 的未知供应商 ID 仍可直达原生上游。
- `src/upstream.js` 与 `src/image-generation.js` 改为单次 `recordTurn()` 保存 messages、response、parent response ID 和安全 route snapshot；route snapshot 不包含 Key 值。

首轮审查修复：

- 原生 Responses 非流式成功体在发送 headers 前先验证 `completed` 并完成落库；流式只先转发普通事件，扣住 `response.completed` 与其后尾部，原子落库成功后才释放。写入失败只返回中文 `response.failed`，不泄露 completed，也不进入备用路由。
- SSE 事件改为有界 `Buffer[]` 增量解析，支持 LF/CRLF 跨 chunk（并兼容 lone CR），避免 delimiter 前字符串无界增长与重复全量扫描；单事件和 terminal 尾部限制为 48MiB，为 100MiB 完整 turn 留出重复存储余量，整体超限仍返回明确本地错误。
- tombstone 增加独立 TTL、数量和字节上限；新库启用 incremental auto-vacuum，淘汰后做有界 incremental vacuum 与安全 WAL checkpoint；health 暴露 page/freelist/DB/WAL/tombstone 指标。600 次 churn 行为测试确认活跃链与当前行保留，文件增长受控。
- 路由元数据改为 allowlist，route snapshot 单独限定字段；清除 `access_token/bearerToken/authorizationHeader`、URL userinfo 和敏感查询参数。
- 旧 `record()+recordResponse()` 在持久模式下用独立有界 pending 保存完整 turn，不再把 1MiB 内存缓存截断写入 SQLite；`history_record_too_large` 等单请求策略错误不再永久毒化 store。
- 桌面 Router 控制路径在 secrets 注入后最终覆盖；`CODEXBRIDGE_DATA_DIR/ROUTER_CONFIG/CODEXBRIDGE_SECRETS_FILE` 不能保存为 provider API Key 环境变量，普通供应商 Key 仍正常注入。
- 新增独立 Kimi `kimi-k2.7-code` close/recreate 续聊，与既有 DeepSeek 重启测试分开覆盖。
- 最终审查补丁把“对外错误契约”和“是否永久 poison”拆开：所有 `recordTurn/recordResponse` 写异常统一对外为 HTTP 503 `local_history_storage_unavailable` 且禁止 failover；原始 code 保留在 `internalCode/cause`。too-large、BUSY、LOCKED 不永久 poison，后续小写可成功；FULL、IOERR、CORRUPT、NOTADB、CANTOPEN、READONLY 按持久故障锁定。
- SSE terminal 只允许有效 failed/incomplete/cancelled 原样旁路；malformed `response.completed` 与没有完整 response 的 DONE-only 尾部不会泄露 success/completed，而是返回 `upstream_stream_invalid_terminal` 的 `response.failed`，备用路由调用为 0。

TDD 证据：

- 主链 RED：`node --test tests/history-persistence.test.js`，5/5 失败；`recordTurn` 不存在、Router 重建后第二次上游仅收到当前 turn、未知本地 ID 仍调用上游并返回 200。
- 边界 RED：同一 focused 文件新增 TTL/容量后 10 项中 2 项失败；内存命中没有刷新磁盘 TTL，冷记录没有容量 tombstone。
- 原子/错误 RED：Chat atomic、image atomic、history write no-failover 三条 focused pattern 各 1/1 失败，分别显示 `recordTurn` 未调用或错误触发备用路由。
- 数据目录 RED：`tests/router-data-dir.test.js` 因模块不存在失败；桌面 env focused 因 `CODEXBRIDGE_DATA_DIR` 缺失失败。
- 首轮审查 RED：native durability 初始 0/3（非流式提前 200、流式泄露 completed、>2MiB terminal 重启缺失）；retention 初始 0/1（无 auto-vacuum/page/tombstone 指标）；metadata、split write、oversize lifecycle、env collision、reserved apiKeyEnv 各 0/1，均留下对应失败输出。
- 最终审查 RED：raw too-large/BUSY/FULL 写错 0/3（非流式返回 500，BUSY 流式走通用上游错误）；malformed completed / DONE-only / incomplete 初始 1/3，仅 incomplete 正确旁路。
- focused GREEN：`node --test tests/history.test.js tests/history-persistence.test.js tests/history-retention.test.js tests/router-data-dir.test.js`，38/38 通过；raw 写错 3/3、SSE terminal 分类 3/3、desktop env/reserved 3/3。
- 相关回归：`node --test tests/server.test.js tests/sse.test.js tests/upstream-proxy.test.js`，235/235 通过；usage fixture 补齐为有效 completed response 以符合新终态契约。
- 转换/路由回归：`node --test tests/conversion.test.js tests/route-fidelity-regression.test.js`，118/118 通过。
- 完整 Router 回归：`npm run test:router`，498/498 通过。
- 最终固定链路：`npm run check` 通过（先完成语法检查，Router 498/498、Desktop 464/464）。
- 语法：`npm run check:syntax` 通过；`git diff --check` 通过，仅保留既有 CRLF/LF 提醒。

第三轮审查：Spec Compliance ✅，无 Critical、无 Important，Task quality Approved。复审再次执行 focused 38/38 与语法检查均通过；额外确认新增测试没有残留活动句柄。

剩余边界：

- 同步门面与最多 100MiB 完整记录是本任务明确契约；极大记录的 JSON/gzip 会占用 Router 事件循环时间，后续若改异步必须保持请求链一致性与事务语义。
- 容量只淘汰冷记录；全部为最近访问或当前记录时会按设计软超额，不以破坏活跃会话换取硬上限。
- 持久历史门禁只对生产持久 store 生效；显式注入的纯内存测试/兼容门面保留旧行为。桌面和 `startServer()` 生产路径始终创建持久 store。
- 流式响应最终历史写失败时 HTTP 200 headers 已按 SSE 协议发送，不能改为 503；当前保证 completed 未释放，只发送中文 `response.failed` 且备用路由调用为 0。非流式请求在 headers 前返回明确 503。
- 未访问真实用户 Key 或 Codex state SQLite；所有新增行为测试只使用系统临时目录、本地 mock 和假 Key，并逐一删除明确的 SQLite sidecar 文件后删除空目录。

### 记录 3：模式切换同步 Router 与 Codex 鉴权

状态：已完成；独立复审通过。

根因：

- 旧 `mode:select` 先写选择与 Router 状态，未把 Codex provider 鉴权纳入同一事务，并在完整验证前广播界面。
- 多文件最后一步失败或运行中 Router 未加载候选模型时，没有统一回滚边界，会留下 Router/Codex 模式分裂。

本次处理：

- 新增共享串行写协调器：同目录唯一暂存、全候选验证、原子替换、提交后重读/验证、逆序原子回滚和逐路径清理；随机 `configRevision` 只在成功后返回。
- 新增纯候选构建与四文件模式事务，原子管理 selection、Router JSON、Codex catalog、Codex TOML；构建阶段零写入，保留非 Bridge TOML。
- 严格区分 hybrid 登录透传与 all_api 固定本地头；未知模式拒绝，all_api 不依赖 `auth.json`。
- `mode:select` 仅委托纯 handler；运行中 Router 在四文件提交后精确核对 health model IDs，失败触发全回滚并 best-effort 刷新旧 health，成功后才广播一次。
- 新增 Codex Desktop locator 基础与重启提示；只提示现有按钮/手动重开，不自动强杀 Codex。Task 6 继续扩展 CLI 与资源发现。

TDD 证据：

- RED：coordinator/locator/handler 均先以模块不存在失败；strict mode 2/5；Settings transaction 0/7；missing parent 迭代 4/5。
- GREEN：coordinator 6/6、provider 5/5、transaction 7/7、locator 9/9、handler 6/6；Task 3 聚焦总链初验 67/67。
- 旧 Settings 回归 290/290；`npm run check:syntax` 通过；所有新模块与测试已加入固定检查入口。
- 首轮独立审查发现 1 个 Important：提交后虽重读文件但未逐字节核对冻结候选，最后一次 rename 后的外部篡改可能被误判成功。
- 审查修复按 RED→GREEN 完成：新增 post-rename tamper 用例先稳定复现 5/6，再冻结候选 Buffer，并在 `verifyCommitted` 前逐目标 `Buffer.equals`；不一致时逆序恢复四文件且不泄露草稿。修复后 coordinator + transaction 13/13。
- 独立复审结论：Approved；无剩余 Critical/Important。

剩余边界：

- 本任务只迁移 `mode:select`；其它写入口在 Task 7 复用同一协调器统一收口。
- 没有连接真实 Router health、真实 Codex Desktop、真实 Home 配置或真实 Key；全部使用注入与临时目录验证。

### 记录 4：唯一上下文策略与严格切模压缩

状态：已完成；独立总审与修复后复审均通过。

根因：

- Catalog 宣传 95% 上下文、80% 自动压缩，但 Chat 与切模各自使用 65%，Chat compact 另有固定 120 KiB 上限；全局 catalog 百分比也没有进入运行时。
- 持久化旧响应虽然保存了 route snapshot，切模时却只看 route ID 和当前配置；删除、漂移、重启及同 ID 改模型均可能绕过精确旧路由。
- 工具协议输入会整体跳过切模压缩；旧模型压缩失败又会生成本地伪摘要，继续请求目标或 failover。
- Native Responses compact 未按路由预算裁剪；结构化日志缺少输入预算、工具边界等关键事实，并把 `targetInputBudget` 错写成 compact threshold。

本次处理：

- 新增 version 1 `contextPolicyForRoute()`，统一上游/有效窗口、input budget、compact threshold、output reserve 与 token truncation；1M 精确为 950000/800000，258400 精确为 245480/206720，未知窗口失败关闭。
- 新增 `normalizeContextPolicyConfig()`，让显式 `config.catalog` 默认值进入生产运行时，同时保持 route override 优先；Catalog、Chat、Chat/Responses compact、切模和 smart routing 统一消费同一策略。
- 新增无密钥 route snapshot create/validate/resolve；删除、禁用、歧义、关键字段漂移、未知策略/compact contract、需要重建的不安全凭据均拒绝。合法更严格 truncation limit 可以跨重启精确恢复。
- 带持久快照的同 ID continuation 也先校验：同 ID 改 provider/model/API/Base URL/Key env/策略时本地 409、零上游；完全不变的 inline-key 同路由仍可正常继续且不保存 Key 值。
- 大模型切小模型先调用持久快照对应的旧路由压缩；Responses→Chat、Chat→Responses、全量 input、`previous_response_id` 均覆盖。fresh current input 不进入摘要。
- 精确剥离完整 prior prefix，不误删孤立重复句；活动 tool call/output 原子保护，无法配对或整个受保护块超预算时在任何压缩/目标调用前失败关闭。
- 旧模型 HTTP、网络、空摘要失败统一返回 `409 context_switch_compaction_failed`，禁止本地伪摘要、目标调用和 failover。
- 成功后持久化实际 compacted context；普通上游截断仍保留未截断统一历史。删除固定 120 KiB 限制，Native Responses explicit/switch compact 也按 route token budget 处理。
- 三类结构化日志补齐 policy/version、route IDs、tokens、input budget、compact threshold、preserved tool count、outcome/reason，且不记录正文、摘要或 Key。

TDD 与回归证据：

- 初始 RED：策略模块不存在；strict switch 仅 1/3；旧压缩 500 仍返回 200；工具续接跳过旧压缩；删除旧路由仍调用目标。
- 审查反例 RED：同 ID 漂移返回 200 并调用新小模型；catalog=90/70 时目录 900/700、Chat 仍 950/800；10000/7000 严格快照自我拒绝；Native Responses compact 仍发送早期超大正文；日志字段缺失。
- strict switch 子项 138/138；独立聚焦复审 112/112。
- Task 4 聚焦矩阵 259/259；完整 Router 回归 563/563。
- `npm run check:syntax` 与 `git diff --check` 通过；仅保留既有 CRLF/LF 提醒。

独立审查：

- 首轮 Not Approved：1 个 Critical（同 ID 漂移绕过快照）和 4 个 Important（全局策略未进运行时、严格 truncation 快照误拒、日志合同不完整、Native Responses compact 未统一预算）。
- 五项均添加行为覆盖并修复；最终复审 Approved，剩余 Critical/Important/Minor 均为 0。

剩余边界：

- Snapshot 永不保存 Key 值，因此同路由可验证非敏感契约但不会比较两个 inline Key 内容；Key/配置变化后的重试隔离由任务 5 的非敏感 config revision 负责。
- 整个活动工具块若大于目标路由安全 input budget，严格切模会拒绝，而不是拆断工具协议。

### 记录 5：pending-only 精确重复保护

状态：已完成；第四轮独立复审通过。

根因：

- 旧模块全局 Map 同时承担 pending ownership、完成结果重放、错误缓存、语义/turn/opaque 猜测、TTL 与容量淘汰，导致正常重试、生图、切模型和修 Key 后重试被误杀；长任务又会在 60 秒后失去保护。
- 独立的上游 payload 失败缓存会在配置修复后继续本地拒绝相同请求；供应商 cooldown 与本地 pacing 状态没有明确分层。
- 初版修复后审查进一步确认：direct Chat 与显式能力副作用没有统一接入；API surface 和 session/account 标识没有进入指纹；流式 fetch 在拿到 headers 后过早撤销 abort/timeout，body 卡死会永久占用无 TTL owner。

本次处理：

- 新增每 Router server 实例独占的 pending guard，只保存 SHA-256、ownership token、时间和有界安全诊断；不设 TTL、不淘汰活跃 owner，容量满时只旁路新请求。
- 精确指纹包含 config revision、request surface、非敏感 route identity、compact kind、Codex thread/turn/session/account headers 与完整规范化 body；不读取 Key，不接收 authorization/cookie，不保留 URL 凭据或敏感查询值。
- Responses、direct Chat 与显式 capability 使用同一契约。capability owner 跟真实副作用 Promise，direct Chat owner 跨主路由与 failover，所有 owner 只在真实执行结束的 `finally` 释放。
- 删除 completed/error/semantic/opaque 重放和上游失败缓存；401/402/413/429/5xx/timeout/stream/cancel/local error 结束后均允许相同请求重新访问上游。
- 将 fetch abort/timeout 延伸到 response body 的 done/cancel/error；客户端在 headers 后断开也会取消卡死上游流并释放 owner。HTML root fallback 会先取消旧 body。
- provider `Retry-After` cooldown 与可选本地 RPM pacing 拆成独立状态；关闭本地 pacing 不会抹掉供应商 cooldown。
- 桌面新增独立开关 `duplicateRequestProtection`，默认开启并写入 Router config；普通 Router 配置写入生成新 revision，模式事务保留提交 revision。
- idle resume 只处理“有 previous_response_id 且没有任何 fresh input”；secrets file 优先于陈旧进程环境 Key。

TDD 与回归证据：

- 初始 RED 稳定复现完成结果、413、compact、生图、同 turn 新 encrypted input、关闭开关和 secrets 优先级的旧错误行为。
- focused 最终 47/47，覆盖五次并发重连、超过旧 60 秒边界、capacity、不泄密、Key/config/route/model/surface/header 变化、direct Chat、capability 副作用与断线、以及两类流 headers 后卡死取消。
- `tests/server.test.js` 211/211；完整 Router 594/594；Desktop 503/503。
- `npm run check:syntax` 通过；`git diff --check` 退出 0，仅保留既有 CRLF/LF 提醒。

独立审查：

- 前三轮依次发现 2、2、1 个 Important，全部补行为测试并修根因。
- 第四轮 Approved：Critical 0、Important 0、Minor 0。

剩余边界：

- Guard 按设计只在单个 Router 进程内协调；桌面产品不应并行启动多个 Router 实例。
- 容量满时优先保护已有 owner，不以淘汰活跃请求换取硬容量。
- 未使用真实 Key 或真实供应商；真实客户端/供应商重连节奏留待最终真实环境验收。

### 记录 6：跨机器资源发现与 ChatGPT / Codex 安全重启

状态：已完成；最终独立复审通过，Critical / Important / Minor 均为 0。

根因：

- 资源快照绕过共享 locator，只认显式 CLI 或 PATH；首次 2500ms、无可靠重试，并把超时、启动失败、部分列表失败和 schema 漂移折叠成空数组与数字 0。
- 插件、MCP、Skills 的“当前可用”权威混入 available、配置和缓存来源；测试又把后端同一错误摘要当预期，无法识别假 0。
- 重启、项目恢复、启动体检和模式切换各自维护 Codex-only 发现规则；桌面产品更新为 ChatGPT 后，新旧应用共存、Classic 和同名进程会产生误启、误关与假成功风险。
- PowerShell 快捷方式和 Store 参数错误地追加在 `-Command` 后，真实路径不会进入 `$args[0]`；原测试因后续 fallback 而假绿。

本次处理：

- `desktop/codex-locator.mjs` 统一返回独立 desktop/CLI target，优先解析固定快捷方式和官方 Store，再看普通路径与受限 WindowsApps；支持新版 ChatGPT、旧版 Codex、Windows/macOS、双环境变量和 packaged `resources/codex.exe`，全链路有候选/操作/时间预算。
- 快捷方式路径和 Store package family 改为子进程环境变量安全绑定，真实 `.lnk` 覆盖空格、中文和单引号；Store 仅接受 OpenAI 官方 publisher `2p2nqsd0c76g0`，已卸载包的陈旧快捷方式不再通过。
- CLI 首次读取 8000ms、prompt-input 12000ms；timeout/start failure 只重试一次，仅完整成功结果进入短缓存，force refresh 可绕过。Main、发布体检和启动检查的成对读取都复用同一次 locator/snapshot。
- installed 插件和 MCP 条目必须带显式 `enabled:boolean`；安装列表失败、未知 schema、缺字段、timeout 与 prompt-input 解析失败保持 `summary:null + readStatus`。成功空列表仍为 0。
- Renderer、支持诊断、配置包、同步状态、desktop smoke 和 release preflight 全部保留未知并显示“无法读取”；未知资源只是本机配置提醒，不再误判成仓库代码阻断。
- 新增 `desktop/openai-desktop-compat.cjs`：自动发现 ChatGPT 优先、Codex fallback；Classic、CodexBridge、非官方 Store、浏览器/空/损坏快捷方式全部拒绝。
- Windows 只按与受信候选精确匹配的绝对可执行路径和 PID 结束 ChatGPT/Codex；name-only、同名伪程序、多路径歧义和部分 taskkill 失败全部 fail closed，彻底移除按 image name 终止。
- 所有辅助命令有硬超时，快捷方式解析另有总预算；Windows 等到 `spawn` 成功才返回，macOS quit/open 任一步失败都不报成功。保存的非标准 `.app` 在重启、项目恢复和模式切换中保持一致。
- Settings 与 package/release 测试隔离真实 Windows 用户目录、开始菜单和真实 CLI；未访问真实 Key、真实 Codex Home/数据库或真实 ChatGPT/Codex 进程。
- UI、托盘、README、Windows/macOS 使用文档统一为“ChatGPT / Codex”，CLI/config 权威名称仍保持 `codex`。

TDD 与回归证据：

- desktop-only locator 初始 5/5 RED；Settings 体检相关 5/8 RED；Main 共享 snapshot 1/1 RED。
- 真实 shortcut/Store 参数绑定 3/3 RED，稳定复现 COM 与 ParameterBinding 错误；发布体检共享快照 1/1 RED。
- 行为反例覆盖浏览器/空/损坏/陈旧快捷方式、未知 Store publisher、name-only 双品牌进程、同名伪程序、多路径、helper timeout、taskkill 部分失败、mac quit/open 失败及非标准保存路径。
- 最终 locator 39/39，Main focused 18/18，Settings 314/314，完整 Desktop 573/573。
- `npm run check:syntax` 通过；`git diff --check` exit 0，仅保留既有 CRLF/LF 提醒。

独立审查：

- 多轮审查依次关闭 PATH/WindowsApps、预算、shell token、缓存顺序、unknown 传播、ChatGPT/Codex 共存、Classic/Bridge 排除、进程误杀、命令无界等待、mac 假成功、PowerShell 参数、测试不隔离、Settings 浅扫描、Store publisher、陈旧 Store link 与模式切换路径漂移。
- 最终 Approved：Critical 0、Important 0、Minor 0。

剩余边界：

- 没有启动或结束真实 ChatGPT/Codex，也没有使用真实 Store/macOS 安装包；正式测试包前仍需在真实 Windows/macOS 上验收签名包 AppID、重启和 `--open-project`。
- Store publisher 白名单与 CLI JSON schema 都按 fail-closed 处理；OpenAI 后续变更时会显示无法读取/手动指引，必须有证据地更新，而不是猜测放行。
- 所有配置写入口的共享事务、CAS 和崩溃恢复属于记录 7，不能在本记录重复造第二条队列。

### 记录 7：配置事务、崩溃恢复与桌面生命周期收口

状态：已完成；聚焦安全回归、完整 Settings、完整 Desktop、语法与补丁检查均通过。

根因：

- 配置写入分散为“先写源文件、再同步 Router/catalog/TOML”，后段失败会留下混合代际；旧协调器缺少持久 WAL、严格 CAS 和跨进程恢复。
- Windows 上 `0600/0700` 不能代表 DACL 已收紧，candidate/rollback/journal 可能在权限收紧前短暂暴露；旧 WAL、junction、SACL 文本和命令卡死也缺少失败关闭边界。
- 导入、provider logo 与 Codex 备份恢复存在 path-based 读取、链接跟随、超限后读取或读中换包风险。
- Router start/stop/quit 与 watchdog 不在一个生命周期状态机中；终止失败后的晚退出可能被当成崩溃重启，启动回滚失败也可能永久保留死句柄。
- 已提交事务后的日志、状态读取或 Renderer 广播失败仍可能让 IPC 报失败，诱导用户重试已落盘操作；旧快照状态下界面仍可继续写入。

本次处理：

- 所有生产配置 mutation 统一进入一个 FIFO coordinator：单次稳定快照构建不可变 draft，统一派生 Router JSON、根/Codex catalog 与 managed TOML，全部验证后才提交；任一 rename/verify 失败逆序恢复。
- 新增期望原件 CAS、敏感元数据 WAL、硬中断逐提交点恢复、恢复冲突证据保留、严格 allowed roots/junction 检查，以及显式逐文件/逐目录清理。
- Windows 敏感字节先写入已收紧并验证 DACL 的去重私有 staging 目录；journal 目录身份变化、命令硬超时、非零退出、DACL/SACL 混淆与旧 v1 WAL 均 fail closed。
- managed TOML 只替换唯一 Bridge block，保留 BOM、CRLF、Unicode 注释、插件/MCP 表与用户尾部字节；自动停止只移除当前 managed block，不再回放旧整文件备份。
- 配置包先做完整无密钥验证并用有界单链接 fd 读取；provider logo 拒绝 symlink/hardlink/junction/读中换包并经私有同目录临时文件发布；Codex 备份恢复通过单一有界 fd 与源/目录身份校验。
- provider 刷新覆盖 fetch/body 硬截止、错误脱敏、无效 HTTP 200 保留旧缓存、同 provider 新请求覆盖旧请求与 provider 指纹 CAS。
- Router 生命周期统一串行化 start/stop/quit；失败停止的晚退出不触发 watchdog，失败回滚留下的 child 晚退出会清除句柄，稳定 60 秒后重置连续崩溃预算。
- 状态读取失败返回最后完整快照并标记 `stateUnavailable`；Renderer 在恢复前默认拒绝全部写动作。提交后日志、状态、广播与托盘发布均为 best-effort，不再把 durable commit 伪装成可重试失败。

TDD 与回归证据：

- coordinator/Windows ACL 最终 55/55；实现期额外重复两轮同样通过。config transaction/mutation 上层 45/45。
- provider timeout/order/cache 4/4，stale provider transaction 1/1；恢复链 7/7；Renderer 38/38；生命周期/提交后/韧性状态复审集 33/33。
- 完整 Settings 330/330；完整 Desktop 744/744。
- `npm run check:syntax` 通过；`git diff --check` exit 0，仅有既有 CRLF/LF 提醒。

独立审查：

- 复审发现并关闭 2 个生命周期 Important：失败 stop 后晚退出反向重启、失败 start rollback 后死句柄不清理。
- 复审稳定复现并关闭 selected backup 换包 TOCTOU；安全复审提出的 credential 分类绕过、Key/body 反射、无效缓存覆盖、logo 链接、超限导入、stale refresh 与 Windows DACL 出生窗口均已补行为覆盖。

剩余边界：

- 最后一次协作式 CAS 检查与 rename 无法仅靠 Node path API 合并为一个内核 no-replace 操作；彻底消除非协作编辑器的微窗口需要 `ReplaceFileW`、`renameat2` 或等价原生能力。
- 未读取真实 Key、真实 Codex Home/数据库，也未启动或结束真实 Router、ChatGPT/Codex 进程；真实签名包与跨平台进程行为留在最终真实环境验收。

### 记录 8：全量门禁与七项最终广审

状态：已完成；未打包、未暂存、未提交、未推送、未发布。

最终门禁：

- `npm run check` 通过：语法、完整 Router 回归与 Desktop 744/744 全部通过。
- `npm run desktop:smoke` 通过：providers=15，资源权威 17/6/102/2，桌面导航状态正常。
- `npm run release:code-ready` 通过：15 项通过、7 项提醒、0 项失败；提醒均属于本机配置或真实环境验收。
- `git diff --check` exit 0，仅保留既有 CRLF/LF 提醒。
- 同一最终树上的 Task 7 证据：coordinator/Windows ACL 55/55，Settings 330/330。

广审结论：

- 重新核对路由契约、持久历史、原子模式/配置发布、统一上下文策略、pending-only 防重、ChatGPT/Codex 发现重启、配置 WAL 七项要求。
- 生产目录未发现禁用的递归删除；命中项仅为发布安全扫描规则本身。
- 未发现 `shell: true`、按 image name 结束进程、Key/Authorization 日志反射、Main 绕过事务直接写核心配置或遗留 TODO/FIXME。
- 先前独立复审发现均有最终行为测试；本轮未发现剩余 Critical/Important。

测试包判断与真实环境缺口：

- 当前代码适合进入隔离的测试包构建任务，但本任务按约束没有创建包。
- 新构建产物仍需 Windows/macOS 签名与 AppID、ChatGPT/Codex 重启、真实 Router route health、生图代理、安装器/更新流程和真实供应商/客户端验收。
- 当前机器缺 NSIS，且 code-ready 时没有运行生产 Router、没有配置图片供应商；旧本地产物的 packaged smoke 不能替代新包验收。

### 记录 9：用户验收问题整改与替换测试包

状态：已完成；三项实现均经独立复审 Approved；新 Windows x64 便携测试包已生成并通过打包后 smoke。未暂存、未提交、未推送、未发布。

用户反馈与根因：

- Router 启动报 `ConfigTransactionError`：内容未变化的 Windows 敏感配置会在事务/WAL 建立前直接对旧目标原地收紧 ACL；跨机器、用户 SID 或旧链接/权限状态变化时，这一步可能失败，并被 Electron 直接包装成内部 remote-method 错误。
- 普通用户页面出现“发布前、正式发包、安装包目录、NSIS”等词：桌面体检直接复用了发布检查的原始项目；能力汇总卡也展示 Router 配置、兼容函数、文本降级、128K 阈值和自动接管等实现概念。
- 实验能力供应商和实验运行记录排在正式图片能力之前：静态 DOM 原顺序就是实验供应商 → 模型诊断 → 实验历史 → 图片能力，顶部又追加了一张实验能力汇总卡。
- 重复请求保护默认开启：Desktop normalize、Router config、Renderer、Responses、direct Chat、capability、upstream 和 pure guard 使用 `!== false` 或等价默认开启表达式；缺失字段也会创建 pending ownership。

本次处理：

- Windows 上内容未变且敏感的目标改为 `privateRepublish`：相同字节进入既有私有 staging、WAL、CAS、rollback、同卷 rename 和最终 ACL 校验，不再修改旧 inode；普通未变文件仍保持零写入。
- `ConfigTransactionError` 只携带固定阶段和受限原因码；真实 unsafe path/link 统一带 `config_write_unsafe_path`。`router:start` IPC 始终返回成功/失败包络，Renderer 只显示固定中文操作提示，不再暴露 Electron 内部前缀，也不会失败后误报“已启动”。
- 普通启动体检移除 `update_flow`，发布检查内部仍保留；Router 未启动提示改为回到概览启动并重新体检。
- 能力页顺序改为模型汇总 → 模型诊断 → 图片供应商/记录 → 最底部实验供应商/实验记录；删除顶部实验汇总函数。能力卡改为用户能做什么：工具协作、读取文件、处理长对话/文档、生成并保存图片。
- 重复请求保护改为全链路严格 `=== true` opt-in；缺失和 false 都不计算指纹、不创建 owner。显式 true 保留 pending-only 完全相同请求保护，部分保存与导入/导出保留 true；两份示例配置显式 false。
- 界面明确区分：重复保护只拦仍在执行中的完全相同请求并返回本地结果；本地请求节奏按 RPM 给不同请求排队；供应商 429 冷却始终生效且不受这两个默认开关影响。

TDD 与独立复审：

- Task 1 RED 复现旧 inode 原地 ACL 与缺失失败元数据；IPC RED 复现内部 rejected IPC。修复后 coordinator 聚焦 3/3、Main/Renderer/结果包络 77/77；独立审查发现真实 unsafe-path 原因码未贯通和 Error 非枚举字段测试盲区，补真实 coordinator→IPC 与 message/stack 断言后复审 Approved。
- Task 2 RED 5/5，覆盖错误 DOM 顺序、顶部实验卡、位置文案、普通 UI 的 update flow 和发布术语；初次 GREEN 5/5、Renderer 43/43。独立审查要求能力卡彻底用户化并删除死函数，新增 RED 2/2 后完整 Renderer 44/44，复审 Approved。
- Task 3 完整 RED 10 项中 8 项失败，稳定证明缺失字段仍在 Desktop、示例、pure guard、Responses、direct Chat 和 capability 默认开启；显式 true 边界保持通过。GREEN 10/10，guard/release/rate-limit 34/34，桌面/Renderer/示例 417/417，独立复审 Approved。

最终门禁与测试包：

- 聚焦集成：Desktop/事务链 469/469；Router/保护链 245/245。
- `npm run check` 通过；单独新鲜复验 Router 598/598、Desktop 758/758，语法检查通过。
- `npm run desktop:smoke` 通过：providers=15，资源权威 17/6/102/2。
- `npm run release:code-ready`：15 项通过、7 项提醒、0 项失败；提醒仅为本机配置或真实环境验收。
- `git diff --check` exit 0。
- 最终便携标记状态 packaged smoke：总计 12026ms；Desktop 11577ms；Router health 448ms；模型 `gpt-5.5`；全部 `ok:true`。
- ZIP：`dist-artifacts/CodexBridge-Windows-x64-Portable-v0.2.3-test-20260711-223236.zip`，141352097 bytes，SHA-256 `BB326D28C3585099E8D0535F32D0C253C92D897EE885F5EB049686D5C6D47E08`。
- ZIP 头为 `50 4B 03 04`，共 703 个条目；`.codexbridge-portable`、`CodexBridge.exe`、`resources/app/package.json`、`resources/app/src/server.js` 齐全；未包含 `secrets.local.json`、`router.config.json` 或 `model-catalog.json`；`.sha256` 二次核对一致。

剩余真实环境边界：

- 新包已覆盖临时目录和本地 mock 下的桌面/Router health；仍需在最初报错的机器上启动一次，以确认其现场 ACL、SID、链接或安全软件没有第二个独立问题。
- 未使用真实供应商 Key/真实上游；供应商连接、生图、真实客户端重连与安装器仍属于跨机器人工验收。当前机器无 NSIS，因此本轮交付便携 ZIP，不生成 Setup.exe。
