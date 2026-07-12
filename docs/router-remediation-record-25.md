# Router 整改记录 25：退出阻塞与 GPT 原生生图 400

日期：2026-07-12

## 问题等级

P0。

- Router 配置恢复发生冲突时，软件退出被取消，Router 进程继续运行。
- GPT 5.6 通过原生 `imagegen` 调用 `/v1/images/generations` 时，上游返回 HTTP 400：`Input must be a list`。

## 根因

### Router 与软件无法退出

退出生命周期先等待 Codex 配置恢复，只有恢复成功后才终止 Router。`codex_router_restore_conflict` 抛出后，流程直接进入失败分支，因此既不结束 Router，也不退出 CodexBridge。

配置冲突的直接原因是：Router 启动后，托管块之外又出现了配置修改；停止时旧实现要求托管块之外的字节必须与启动快照完全一致，因此拒绝恢复。

### GPT 原生生图失败

图片兼容入口把 OpenAI Images 请求转换为原生 Responses 请求时，把 `input` 写成字符串。新版 ChatGPT Codex Responses 后端要求 `input` 为输入项数组，所以稳定返回参数错误。

## 整改

- 应用退出时，配置清理失败降级为警告；仍必须终止 Router、停止本地能力执行器并退出应用。
- 只有 Router 进程未确认结束时，才允许阻止退出。
- Router 停止时，如果托管块外只有前置或追加修改，原配置与并发修改会合并恢复。
- 其他无法自动合并的冲突会优先移除 CodexBridge 托管块并保留当前外部修改，不再把死 Router 地址留在 ChatGPT 配置中。
- GPT 原生 imagegen 请求改为标准 Responses 输入数组：`[{ role: "user", content: [{ type: "input_text", text }] }]`。
- GPT 生图仍只走 ChatGPT 原生 imagegen，不切换到自定义图片供应商。

## TDD 证据

- RED：配置清理拒绝时，退出 Promise 抛错、Router 没有收到终止信号、应用没有退出。
- GREEN：同一场景变成 `managed_config_cleanup_failed` 警告，Router 确认结束后应用退出。
- RED：GPT 原生生图上游收到字符串 `input`，与后端 `Input must be a list` 一致。
- GREEN：上游收到标准输入项数组，并返回原生 `image_generation_call` 结果。
- RED：Router 运行期间追加插件配置后，停止操作抛 `codex_router_restore_conflict`。
- GREEN：原模型设置和追加插件设置同时保留，托管块被移除，停止成功。

## 验证结果

- P0 聚焦回归：配置冲突退出、并发配置恢复、GPT 原生 imagegen 均通过。
- 相关组合测试：341/341 通过。
- `npm run check`：781/781 通过。
- `npm run desktop:smoke`：通过。
- `npm run release:code-ready`：失败 0；仅保留真实环境与本机配置提醒。
- `npm run package:win:smoke`：新打包的 `CodexBridge.exe` 通过。
- 便携包：`dist-artifacts/test-20260712-p0-stop-native-imagegen/CodexBridge-Windows-x64-Portable.zip`。
- ZIP：141,390,108 字节，724 个条目，危险路径 0，重复条目 0，根目录 `CodexBridge.exe` 1 个。
- SHA256：`A7E71FA47A9B15CB00DD52FA083615A9B4C72F5D0A948E922B50A3B131B1BE53`。
