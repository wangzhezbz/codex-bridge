# 整改记录 51：残缺托管配置导致 Router 启动失败且体检误报

日期：2026-07-16

## 用户反馈

- Router 启动时报 `managed_toml_invalid`，提示模型配置无效。
- 同一台机器的“启动体检”却显示“可启动”、失败 0 项，和实际启动结果矛盾。

## 根因

1. 用户 `~/.codex/config.toml` 中存在缺失结束标记、重复标记或其他不完整的 CodexBridge 托管块。
2. 配置事务为避免覆盖用户文件，会在规划阶段拒绝所有持久残缺的托管块，因此 Router 尚未拉起就终止。
3. 启动体检原来只检查 `config.toml` 是否存在，没有验证托管标记结构，所以无法提前报告真实阻断项。

## 修复

- 仅在 `router:start` 操作中启用受限自动修复：
  - 识别残缺的 CodexBridge 管理标记范围；
  - 只移除该范围内由 CodexBridge 管理的键和 `model_providers.codexbridge` 残片；
  - 保留管理范围外的用户模型、沙箱、注释、插件和 MCP 配置；
  - 重建唯一、完整的 CodexBridge 托管块。
- 在同一事务中保存两份用途不同的备份：
  - Router 原配置备份保存已清理标记、仍可由 Codex 读取的用户配置，供关闭 Router 时恢复；
  - `config.toml.managed-invalid.*.bak` 原样保存故障文件，供诊断和人工回滚。
- 启动体检现在实际解析托管标记；检测到残缺块时显示失败，并说明启动 Router 会先备份再修复。

## 安全边界

- 普通模型、供应商、设置保存仍然保持失败即停，不会借保存操作自动改写残缺配置。
- 自动修复只处理带 CodexBridge 管理标记的故障文件；无标记的普通 TOML 不进入修复流程。
- 不删除任何用户文件、会话、数据库、插件或 MCP 配置。
- Router 关闭后恢复的是保留用户原始设置的有效 TOML，不会重新写回残缺标记。

## 回归验证

- 目标测试覆盖：残缺标记修复、用户设置保留、原始故障备份、Router 启停恢复、体检失败状态。
- `desktop-config-mutation`、`desktop-config-transaction`、`desktop-settings` 共 389 项测试通过，0 失败。
