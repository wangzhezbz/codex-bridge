# 整改记录 47：模型选择保存响应提速

日期：2026-07-13

## 用户反馈

- 点击“保存选择”后配置最终能够保存，但按钮长时间保持转圈状态。

## 根因

1. `models:saveSelection` 完成配置事务后，事务发布阶段先生成一次轻量状态快照。
2. IPC 处理器随后又同步生成一次完整状态快照，完整快照会读取会话目录、Codex 资源、能力运行记录、图片记录与缩略图等重型数据。
3. renderer 在完整快照返回前一直禁用保存按钮，因此用户看到的等待时间并不是配置写入时间，而是无关的桌面全量扫描时间。

## 修复

- 模型选择继续通过原有共享配置事务提交，不改变写入、校验、回滚和 Router 配置更新规则。
- 该 IPC 提交时关闭重复状态广播，提交后只生成一次 `{ lite: true }` 轻量快照并立即返回。
- renderer 使用 `mergeStateWithRetainedDetailSlices()` 合并轻量响应，保留已经加载的资源、会话、能力和图片详情，避免提速后页面数据被清空。

## TDD 与验证

- 先新增两个回归测试并确认失败：
  - 主进程不得在模型选择保存后调用完整 `getStatePayload(settings)`。
  - renderer 不得用轻量保存响应直接覆盖已经加载的详细状态。
- 修复后定向测试：105/105 通过。
- 完整测试：1362/1362 通过。
- `npm run check:syntax`：通过。
- `npm run desktop:smoke`：通过。
- 新 Windows 便携包打包 smoke：通过，实际启动本次构建目录中的 `CodexBridge.exe`。

## 安全边界

- 未跳过配置事务或提交后验证。
- 未改变模型选择内容、Router 路由策略、会话逻辑或资源识别逻辑。
- 未删除任何文件或目录。

## Windows 测试包

- 路径：`dist-artifacts/v0.3.2-save-speed-windows-20260713-180348/CodexBridge-Windows-x64-Portable.zip`
- 大小：152,243,672 bytes（145.19 MiB）
- SHA-256：`B8F8514F263220F90AF9A8E208BD2A77A27D2FEC35A4D565BCA946364C993E52`
- 已从打包目录回读确认：轻量状态回读和 renderer 状态合并代码均已进入产物。
