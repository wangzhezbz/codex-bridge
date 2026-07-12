# 记录 11：正常 ChatGPT/Codex 配置被误判为草稿冲突

日期：2026-07-11

状态：已完成；完整门禁与非空 Codex 配置的 Windows 打包真实启停烟测通过。

## 用户现场

- Router 启动失败，诊断码为 `config_draft_toml_conflict`。
- 实时日志为空。

## 根因

- 当前 ChatGPT/Codex 的正常 `config.toml` 会包含顶层 `model`、`sandbox_mode`、`model_reasoning_effort`、`approval_policy` 等设置。
- Router 启动事务把这些正常已有设置全部当成不可迁移冲突，在 Router 子进程创建前即失败。
- 之前的打包烟测使用空白 Codex home，只证明空配置能启动，没有覆盖真实用户已有配置。
- 启动 IPC 的失败报告只写桌面运行时文件，没有同步进入界面使用的实时日志数组。

## 整改

- Router 接管已有非托管 Codex 配置时，在同一配置事务内把原始 `config.toml` 保存到私有备份文件。
- 运行期间只临时移除会与 CodexBridge 托管块重复的字段；插件、MCP、项目、功能开关等其他 TOML 内容继续保留。
- 托管块携带固定的原配置备份标记。停止 Router 时校验托管块外内容未被并发修改，再逐字节恢复启动前的原配置。
- 备份缺失或托管块外发生修改时失败关闭，不覆盖用户新修改。
- Router 启动失败的安全阶段和诊断码同时写入运行时文件与界面实时日志，不回显配置内容、路径或密钥。
- Windows 打包烟测改为预置包含 `model`、`sandbox_mode`、`approval_policy` 和插件段的非空 Codex 配置；真实执行启动、运行态检查、停止、停止态检查，并断言停止后原配置逐字节一致。

## TDD 与验收证据

- RED：正常非空 Codex 配置稳定复现 `config_draft_toml_conflict`，失败阶段为 planning；打包烟测静态检查确认此前没有预置真实形态配置。
- GREEN：正常非空配置接管与逐字节恢复测试通过；旧的“只移除托管块并保留用户 TOML”测试继续通过。
- 配置事务、草稿、主进程和打包测试聚焦回归：119/119 通过。
- `npm run check`：通过；Desktop 766/766，0 失败。
- `npm run package:win`：通过。
- `npm run package:win:smoke`：通过；验证包内桌面真实 Router 启停以及非空 Codex 配置恢复。

## 安全边界

- 未读取或写入真实用户 API Key。
- 自动化验收只使用系统临时目录和测试 Codex home。
- 原配置备份属于敏感文件，沿用 Windows 私有 ACL 与事务回滚保护。
