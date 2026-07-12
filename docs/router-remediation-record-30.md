# 整改记录 30：新版会话目录真实迁移与桌面运行时插件合并

日期：2026-07-12

## 根因

1. `syncCodexBridgeConversationProviders()` 只返回只读预览，“找回历史对话”未串联 `local_thread_catalog` 的真实写入、回读和重启流程。
2. 自动退出 ChatGPT / Codex 失败后只有日志，没有可继续的两阶段状态，用户容易把“扫描完成”误认为“迁移完成”。
3. 资源中心只把 Codex CLI 返回的已安装插件作为当前插件集合；新版桌面运行时已加载的 `openai-curated-remote` 插件被降级为缓存目录，因此现场 11 个插件只显示 5 个。
4. 两次历史恢复动作和详细状态刷新可能交错，旧失败提示和旧会话摘要可能覆盖已验证的成功结果。

## 修复

- 新增 `desktop/codex-history-recovery-flow.mjs`，把恢复拆成计划、退出检测、数据库占用检测、备份、事务迁移、回读验证、重启和项目恢复。
- 自动退出失败时进入 `awaiting_manual_exit`，页面提供“我已手动退出，重新检测”；未写数据库时明确显示实际新增 0、提交未开始、备份未创建。
- 写入前动态检查 `local_thread_catalog` schema，备份 DB/WAL/SHM 和全局状态；失败回滚，成功后按目标 ID 回读目录和侧栏。
- 会话页持续显示计划新增、实际新增、提交状态、备份路径、回读目录、回读侧栏和失败原因；成功后用已验证回读结果更新摘要，避免并发旧刷新覆盖。
- 插件集合改为 `unique(cliInstalledPlugins + desktopRuntimeInstalledPlugins)`；远程插件必须同时具备有效 manifest 和当前 prompt-input 可见技能，才标记为 `remote_installed`、`installed=true`、`runtimeLoaded=true`。
- `cached_only` 只保留没有 CLI、配置和运行时加载证据的目录；同一插件的多个版本只选择当前 prompt-input 路径对应的有效版本。

## 自动化覆盖

- 147 条原始线程：130 user、17 subagent、1 archived；目录初始 1，计划新增 128。
- 自动退出失败、手动退出重检、数据库占用拒绝写、schema 缺可选字段、事务回滚、提交后恢复、幂等二次执行。
- CLI 仅返回 5 个 bundled，缓存和 prompt-input 同时证明 6 个 curated remote 已加载，最终必须为 11。
- 打包后的 Electron IPC 真实执行首次退出失败和手动重试；外部脚本直接回读 SQLite、侧栏 JSON、备份目录和渲染结果。

## 打包端到端结果

- 原始线程：147
- 普通用户会话：129
- `local_thread_catalog`：1 -> 129
- 侧栏索引：1 -> 129
- 实际新增：128
- 备份目录：真实存在
- 插件：11（bundled 5 + remote installed 6）
- 截图：`release/history-recovery-packaged-e2e.png`
- 报告：`release/packaged-smoke-report.json`

## 回滚

每次迁移的备份位于 `.codex/codexbridge-history-recovery/<timestamp>-<pid>`。使用现有显式恢复函数可将 `codex-dev.db`、WAL/SHM 和 `.codex-global-state.json` 恢复到迁移前状态；原始 session JSONL、state 数据库线程和侧栏数据不删除。
