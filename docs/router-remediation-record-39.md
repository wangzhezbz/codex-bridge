# CodexBridge 整改记录 39：按 Chrome 真实已解压路径更新扩展

日期：2026-07-12

## 第三次现场失败与架构纠正

测试机点击“更新扩展”等待后仍显示旧协议，只打开一个空白 Chrome 页面。连续修补候选目录仍失败，说明“由 CodexBridge 猜测 Chrome 加载目录”的架构不成立。

Chrome 对已解压扩展的权威路径保存在各 Profile 的 `Secure Preferences`：`extensions.settings[*]` 中 `location=4` 的 `path`。当前机器只读复现确认，Bridge 扩展实际加载路径可以完全位于 CodexBridge 数据目录之外。

## 修复

1. 只读扫描测试机自身 `%LOCALAPPDATA%/Google/Chrome/User Data/Default|Profile */Secure Preferences`。
2. 只接受 `location=4`、绝对路径，且目录内 manifest 必须同时满足：
   - Manifest V3；
   - 名称为 `Codex GPT Bridge`；
   - service worker 为 `background.js`；
   - content scripts 同时包含 `bridge-config.js` 与 `content-script.js`。
3. 更新时把内置扩展覆盖到 Chrome 权威记录的真实加载路径，同时保留规范安装目录和旧稳定目录兼容更新。
4. 页面优先显示“Chrome 当前加载目录”，不再把 CodexBridge 推测目录冒充实际加载目录。
5. “更新扩展”不再自动打开任何 Chrome 页面；自动重载未完成时只给出明确提示，由用户选择旁边的“打开扩展管理”。
6. “打开扩展管理”改为：公共安装路径后继续查询 Windows `App Paths/chrome.exe`，找到真实 Chrome 后使用 `--new-tab chrome://extensions/`；找不到时明确报错，不再用系统协议打开一个空白窗口。

## TDD 与验证

- RED：模拟 Chrome Secure Preferences 指向第三方绝对目录，旧实现不识别、不覆盖。
- GREEN：真实加载目录被识别并覆盖，`bridge-config.js` 使用当前端口。
- 当前机器只读真实探测成功读取 Chrome 权威路径；未依赖硬编码本机路径。
- 聚焦 Desktop/Renderer：109/109 通过。
- `npm run check:syntax` 通过。
- 打包后 smoke 通过；包内模拟 Chrome 指向任意外部目录时，真实路径识别、文件覆盖、端口重写和“更新不打开 Chrome”全部通过。
- 测试 ZIP：`release/CodexBridge-Test-v0.2.3-20260712-203444-chrome-authoritative-path/CodexBridge-Windows-x64-Portable.zip`。
- ZIP：152300117 bytes，4613 个条目，SHA-256 `63768A54DF09E2C9384520D084D3E0364290773D27D933F02DAFCD6DE5AAE321`。
- 测试夹具已绑定隔离 Chrome User Data，防止测试访问真实用户扩展。
- 测试排查期间被夹具触碰的上游 Bridge 扩展 3 个文件已按 HEAD/嵌入包哈希逐一恢复，`git status -- chrome-extension` 为空。
- 未删除文件或目录，未修改会话 provider 与 15722 Router。
