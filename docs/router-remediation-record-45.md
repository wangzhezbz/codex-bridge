# 整改记录 45：桌面启动与 Router 开关主线程阻塞治理

日期：2026-07-13

## 用户反馈

- 每次打开 CodexBridge 都会长时间卡住。
- 启动 Router、关闭 Router 后按钮持续转圈，窗口像失去响应。
- 记录 44 已把开关后的完整广播改为后台执行，但实际机器仍有明显卡顿。

## 深层根因

1. 完整状态读取被整体包在配置协调器的共享队列中；资源页所需的 Codex CLI、prompt-input 和 app-server 探测会同步占用 Electron 主线程约 19～23 秒，同时阻塞 Router 启停所需的配置事务。
2. Renderer 请求过一次详细状态后，Main 中的全局 `rendererNeedsDetailedState` 会永久保持为真；之后所有状态广播都会重复执行完整资源、会话和诊断扫描。
3. 启动后的自动项目恢复会依次处理每个工作区。现场有 9 个根目录，单目录等待上限 8 秒，最坏会额外占用约 72 秒，并以约 400ms 的间隔反复生成恢复计划。
4. 记录 44 只缩短了 Router IPC 返回后的刷新链路，没有消除主线程同步扫描和配置队列争用，因此用户仍能感到整窗卡顿。

## 修改

- 完整资源快照改由独立 Worker 执行；20 秒级 CLI/app-server 探测不再阻塞 Electron 主线程事件循环。
- 状态广播固定使用轻量快照，不再由全局粘滞标记把后续广播升级为完整扫描。
- 完整状态读取不再占用配置事务协调器；Router 启停的配置写入不必等待资源探测结束。
- 移除启动时自动逐项目恢复。项目恢复入口和手动恢复能力继续保留，只有用户明确操作时才执行重扫描。
- Worker 纳入桌面源码存在性检查和语法门禁。
- 未修改 15722 Router 的模型路由、供应商、超时或配置事务语义；未删除用户文件，未生成新的测试包。

## TDD 证据

- 先更新行为测试，初次稳定出现 3 项失败：状态读取仍持有共享配置锁、启动仍自动恢复项目、详细状态全局标记仍会污染后续广播。
- 增加 Worker 语法门禁后，先稳定失败于 `check:syntax` 未包含新文件，再补齐脚本。
- 聚焦回归最终 100/100 通过。

## 性能与回归验证

- 真实 Codex 数据资源快照在 Worker 中耗时 20,746ms；同时主线程 25ms 心跳记录 811 次，最大间隔 29ms，证明长扫描期间主线程保持响应。
- `npm run test:desktop`：817/817 通过。
- `npm run check:syntax`：通过。
- `npm run desktop:smoke`：通过；providers=15，资源快照和桌面导航正常。
- 最终同一源码树重新执行 `npm run check`：退出码 0；语法、完整 Router、Desktop 817/817、历史恢复 14/14 全部通过。
- `git diff --check`：通过。

## 后续验收边界

- 自动项目恢复已取消；若用户需要恢复历史项目，继续使用会话页的显式恢复入口。

## Windows 便携测试包

- 用户确认后只生成一个 Windows x64 便携 ZIP，不生成安装器。
- 打包后 smoke 通过，明确命中新构建目录中的 `CodexBridge.exe`。
- ZIP：`dist-artifacts/v0.3.1-performance-test-20260713-123914/CodexBridge-Windows-x64-Portable.zip`。
- 大小：152,238,448 bytes（145.19 MiB）。
- SHA-256：`E328AE27084AD0A422662336EF991E1AA3322B40BBFF9E320567C4CED052AE74`。
- ZIP 头：`50 4B 03 04`，共 4,318 个条目。
- `CodexBridge.exe`、`.codexbridge-portable`、Router 入口和新增资源 Worker 均存在；未包含 `secrets.local.json`、`router.config.json` 或 `model-catalog.json`。
