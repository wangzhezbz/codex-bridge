# CodexBridge 整改记录 35：资源权威统计与新版 ChatGPT 重启

日期：2026-07-12

## 本轮目标

优先修复两条独立故障链：

1. 资源页错误显示 10 个插件、0 个应用、16 个技能，而测试机权威数据应为 11 个已安装插件、1 个应用、1 个插件 MCP、19 个用户技能和 1 个规则文件。
2. 新版解压安装的 ChatGPT 正在运行时，“重启 ChatGPT / Codex”因 `untrusted_codex_path` 拒绝执行。

本轮没有修改已经恢复正常的会话 provider 逻辑，也没有修改“双倍额度”或 15722 Router 编排。

## 根因

- `listCodexResources()` 在 Codex CLI installed 集合之后又应用了从 ChatGPT `app.asar` 静态解析出的隐藏名单，导致 Browser 被错误减掉。静态 renderer 选择器不是实时安装状态，不能覆盖 CLI 权威结果。
- `normalizeCodexPluginPageSkills()` 已经从 app-server `skills/list` 正确筛出当前用户 `CODEX_HOME/skills` 下的 19 个非系统技能，但随后又按 curated/recommended 缓存排除了 3 个，错误变成 16。
- app-server 启动早期可能短暂返回空应用列表；旧逻辑会让这个空结果覆盖上一次有效的 Sites 快照。
- 重启安全策略只信任保存路径、快捷方式、常规安装目录和 Store 包。新版解压包虽然具有完整的 `OpenAI.Codex_*\app\ChatGPT.exe` 结构，但测试机若缺少对应快捷方式，就会被判为不可信路径。

## 实现

1. 已安装插件主集合直接采用 Codex CLI installed 与已验证远程安装的去重结果；app-server/renderer 隐藏策略只保留在高级诊断中，不再减掉 Browser。
2. 用户技能按 app-server `skills/list`、当前用户 `CODEX_HOME/skills`、非 `.system` 路径统计；recommended 只作为分类字段，不再排除。
3. 应用继续以 app-server `app/list` 为权威来源：
   - 首次空列表延迟 500ms 再读取一次；
   - 已有有效应用快照时，后续暂时空列表不会覆盖，而会标记为 stale cache；
   - 资源页打开和“刷新资源”仍会强制刷新。
4. 新版 ChatGPT 解压版仅在同时满足以下结构证据时允许安全重启：
   - 路径属于 `OpenAI.Codex_*\app\ChatGPT.exe`；
   - 同目录存在 `resources\codex.exe`；
   - 同目录存在 `resources\app.asar`。
   任意普通同名 `ChatGPT.exe`、ChatGPT Classic 或 CodexBridge 都不会因此获得结束权限。
5. 资源页标签改为“用户技能”，并明确列出插件、应用、插件 MCP 与用户技能各自的权威来源。

## 测试与现场验证

- 先建立失败测试，确认修复前：插件实际为 10 而预期 11；新版解压路径仍为不可信。
- 资源组合回归覆盖：11 插件、1 应用、1 插件 MCP、19 用户技能、1 规则文件。
- app-server 回归覆盖：后续失败或暂时空列表保留上一次有效 Sites 快照。
- 重启回归覆盖：结构完整的新版本解压包可授权；任意其他路径仍拒绝。
- `desktop-main-route-sync` + `desktop-renderer`：98/98 通过。
- 资源聚焦测试：27/27 通过。
- 当前开发机 app-server 权威读取成功，Sites ID 为 `connector_20205bf7d4e99a89d7154bb849718324`，快照状态为 `authoritative`。
- 当前运行的 `OpenAI.Codex_26.707.3748.0_x64\app\ChatGPT.exe` 只读授权验证结果：`safeToStop=true`，原因 `verified_openai_codex_release`。验证过程没有结束或重启真实进程。

## 回滚

如需回滚，只恢复本记录列出的资源统计、app-server 探测、重启兼容和相应测试文件；不要恢复或改写会话数据库、provider 作用域或 Router 配置。
