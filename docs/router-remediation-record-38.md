# CodexBridge 整改记录 38：双倍额度两行布局与扩展原目录更新

日期：2026-07-12

## 现场问题

- 运行控制与 Chrome 扩展并排后，扩展路径和状态文案过窄、换行混乱。
- 点击“更新扩展”只看到 Chrome 扩展页打开，扩展仍停留在 `v20260711-router-v2-safety`。

## 根因

上一轮把主稳定目录规范为 `<数据目录>/extensions/chatgpt-codex-bridge`，但旧版用户的 Chrome 已经加载 `<数据目录>/chatgpt-bridge-extension`。宿主只覆盖新目录；Chrome 即使执行 `runtime.reload()`，仍从旧目录加载旧文件，因此版本不变。页面又无条件打开扩展管理页，掩盖了“文件覆盖路径错误”。

## 修复

1. 运行控制和 Chrome 扩展改为上下两行单列布局。
2. 新安装继续使用规范稳定目录。
3. 检测到完整旧稳定目录时，更新同时覆盖规范目录和旧目录，并在两个目录重新生成当前端口的 `bridge-config.js`。
4. 新增真正的扩展管理动作：覆盖文件后轮询诊断状态，等待旧扩展心跳触发 `chrome.runtime.reload()`。
5. 只有自动重载后仍不满足“版本一致、已连接、不需重载”时才打开扩展管理页，并明确提示用户点击“重新加载”；自动成功时不再打开 Chrome 页面。

## TDD 与验证

- RED：旧稳定目录未被覆盖；`manageExtension()` 不存在；页面仍为 `grid two`。
- GREEN：旧/新两个稳定目录均被覆盖；自动重载诊断从旧版本收敛到最新；页面改为单列。
- 聚焦 Desktop/Renderer：108/108 通过。
- `npm run check:syntax` 通过。
- 打包后 smoke 通过；包内真实兼容场景验证新旧两个稳定目录均被覆盖、旧目录端口已更新、页面为单列。
- 测试 ZIP：`release/CodexBridge-Test-v0.2.3-20260712-201841-extension-update-fix/CodexBridge-Windows-x64-Portable.zip`。
- ZIP：152297143 bytes，4612 个条目，SHA-256 `629C114BEDFB903B3034CF45A52AC9C1AE76BE0EF9F19FD8B64025FFEBE71BA6`。
- 未修改会话 provider、15722 Router 或 Bridge 内部模型同步。
- 未删除任何文件或目录。
