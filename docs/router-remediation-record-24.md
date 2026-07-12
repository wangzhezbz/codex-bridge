# Router 整改记录 24：真实历史会话重新显示

日期：2026-07-12

## 问题等级

P0。CodexBridge 能扫描到真实历史会话，但 ChatGPT 更新后侧栏只显示其中一部分；用户已有会话不能因为桌面状态迁移而从入口消失。

## 根因

此前“找回历史对话”只修正 `config.toml` 的历史访问设置，并通过 `--open-project` 重新打开项目。它没有把扫描到的会话 ID 写回 ChatGPT 的项目侧栏和无项目会话索引。因此项目可以出现，但项目下仍只有桌面状态中残留的少量会话。

另外，旧分类会把“不在现有侧栏顺序中”的会话标为 `outside_sidebar_project_threads`。这些会话虽然工作目录属于项目，却没有被重新挂回对应项目。

## 整改

- 恢复前只停止经过验证的 ChatGPT / Codex Desktop 进程，避免运行中的桌面应用覆盖状态写入。
- 写入前为 `.codex-global-state.json` 创建唯一备份。
- 将每个项目扫描到的全部真实会话 ID 合并写入 `sidebar-project-thread-orders`。
- 将工作目录属于项目、但旧侧栏顺序缺失的会话重新挂回对应项目。
- 将无项目真实会话写入 `projectless-thread-ids`。
- 同步 `thread-workspace-root-hints`、项目根和项目展开状态。
- 保留已有顺序、置顶列表和其他无关桌面设置；不删除、不改写、不置顶会话。
- 写入完成后重新启动 ChatGPT / Codex，并重新打开发现的真实项目根。
- 控制台文案不再把扫描数量解释成“虚高”或“默认折叠”，明确说明恢复操作会写回全部真实会话。

## TDD 证据

- RED：桌面设置层不存在真实会话侧栏写回函数。
- GREEN：`sidebar recovery writes every scanned real session back to ChatGPT state without pinning threads`。
- RED：工作目录属于项目的 `outside_sidebar_project_threads` 会话仍被留在无项目列表。
- GREEN：该会话重新进入项目侧栏顺序并从无项目列表移除。
- RED：界面仍显示“侧栏默认只展开最近一部分”的错误说明，且恢复入口没有退出/备份确认。
- GREEN：恢复入口明确执行完整恢复，并移除错误说明。

## 回滚

每次恢复生成 `.codex-global-state.json.before-sidebar-recovery.<timestamp>.bak`。若写入后校验失败，操作停止并保留原文件/备份，不继续启动恢复流程。

## 验证结果

- 会话恢复三条聚焦测试：3/3 通过。
- 桌面设置、主进程和渲染层组合测试：422/422 通过。
- `npm run check`：780/780 通过。
- `npm run desktop:smoke`：通过。
- `npm run release:code-ready`：失败 0；仅保留真实环境和本机配置提醒。
- `npm run package:win:smoke`：新打包的 `CodexBridge.exe` 通过。
- 便携包：`dist-artifacts/test-20260712-session-recovery/CodexBridge-Windows-x64-Portable.zip`。
- ZIP：141,387,990 字节，723 个条目，危险路径 0，重复条目 0，根目录 `CodexBridge.exe` 1 个。
- SHA256：`23B26F9DA2C802A31CAFE2EA63BA038DD83FCB709EE6C71248FEDD5CAABE58F6`。
