# 整改记录 28：新版 Codex 历史目录恢复与资源数量对齐

日期：2026-07-12

## 根因

- 旧会话仍保存在 `state_*.sqlite` 与 `sessions` / `archived_sessions` rollout 中。
- 旧“找回历史对话”只修复 `config.toml` 和 `.codex-global-state.json`，没有回填新版 Codex 实际读取的 `sqlite/codex-dev.db/local_thread_catalog`。
- `syncCodexBridgeConversationProviders()` 固定返回 `explicit_migration_required`，因此此前没有执行真实迁移。
- 资源页此前没有单独统计 ChatGPT 插件页的“应用”，导致插件、应用、MCP、技能四类数量无法与新版 ChatGPT 对齐。

## 实现

- 新增只读恢复预览，扫描当前 `state_*.sqlite`、rollout、归档 rollout、全局侧栏状态和 `local_thread_catalog`，按 thread ID 去重。
- 区分普通用户、subagent、无用户事件内部线程、归档线程和缺少 rollout 的数据库记录；provider 只作为元数据，不作为过滤条件。
- 显式恢复前要求 ChatGPT / Codex 完全退出；动态读取 `PRAGMA table_info`，只写当前 schema 支持的字段。
- 写入前备份 `codex-dev.db`、存在的 WAL/SHM 与 `.codex-global-state.json`；SQLite 使用事务，失败回滚，提交后验证失败则自动恢复完整备份。
- 同步 `local_thread_catalog`、项目侧栏顺序、无项目线程、workspace root hints 与 saved workspace roots；项目归属按现有侧栏、root hints、state cwd、rollout cwd 的顺序确定。
- 会话页分开展示原始线程、普通用户、当前目录、当前侧栏、待恢复、subagent/内部、归档数量。
- 资源页新增“应用”统计，并以 ChatGPT 插件页的已安装/启用口径显示插件、应用、MCP、技能。

## 安全与回滚

- 不删除任何 session JSONL、rollout、数据库线程或现有侧栏数据。
- 备份目录：`%USERPROFILE%\.codex\codexbridge-history-recovery\<时间戳-进程号>\`。
- 自动回滚覆盖事务中断和提交后验证失败。
- 手动回滚时必须先完全退出 ChatGPT / Codex 与 CodexBridge，再从上述目录恢复 `codex-dev.db`、对应 WAL/SHM（若备份存在）和 `.codex-global-state.json`。

## 验证

- `npm run check`：桌面/路由 786 项通过，历史目录恢复 10 项通过，0 失败。
- `npm run desktop:smoke`：通过；本机实际资源摘要 `17 / 1 / 3 / 70 / 2`（插件/应用/MCP/技能/市场）。
- `npm run release:code-ready`：15 通过、7 提醒、0 失败。
- `npm run package:win:smoke`：打包后的 EXE 桌面与 Router 冒烟通过。
- `git diff --check`：0 错误（仅已有 CRLF/LF 提醒）。
- 自动化覆盖 147 条 state / 1 条 catalog、130 user / 17 subagent、三种 provider、去重、归档、Codex 未退出拒写、可选字段缺失、事务回滚、提交后恢复、幂等与显式恢复。

测试包：`dist-artifacts/test-20260712-thread-catalog-recovery/CodexBridge-Windows-x64-Portable.zip`

SHA-256：`7679D5A044AE1F4102020FEB63C724A01379BD6F60CC161AAEAB7575EAA7F1A4`

## 修改文件

- `desktop/codex-thread-catalog-recovery.mjs`
- `desktop/settings.mjs`
- `desktop/main.cjs`
- `desktop/preload.cjs`
- `desktop/renderer/app.js`
- `desktop/renderer/index.html`
- `tests/desktop-codex-thread-catalog-recovery.test.js`
- `tests/desktop-main-route-sync.test.js`
- `tests/desktop-renderer.test.js`
- `tests/desktop-settings.test.js`
- `package.json`
