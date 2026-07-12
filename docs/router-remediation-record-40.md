# CodexBridge 整改记录 40：扩展更新结果真实性与 Chrome Profile 兼容

日期：2026-07-12

## 现场结论

测试机页面显示“Chrome 当前加载目录（未检测到时显示安装目录）”，实际展示的是安装目录，同时旧扩展继续上报旧协议。这证明 Chrome 活跃目录没有被识别，上一包只写入安装目录，不能算更新成功。

## 修复

1. Chrome Profile 扫描同时读取 `Secure Preferences` 与 `Preferences`。
2. 支持 `chromeUserDataDir` 本身就是 Profile 目录，也支持其下的 `Default`、`Profile N`、`Guest Profile`、`System Profile`。
3. 读取扩展 ID 与真实路径；仍只接受 location=4 且 manifest 完整匹配的 Bridge 扩展，防止覆盖无关目录。
4. 只有识别出 Chrome 真实目录时，旧版本按钮才显示“更新扩展”。
5. 已连接旧扩展但未识别磁盘目录时，按钮改为“重新安装扩展”，状态明确说明不能自动换绑；点击后准备固定目录并打开文件夹，提示移除旧扩展后加载该目录。
6. “更新扩展”不再自动打开 Chrome；文件覆盖、自动重载和手动扩展管理彻底分离。
7. 扩展管理由 `--new-tab` 改为 `--new-window chrome://extensions/`；找不到真实 Chrome 可执行文件时继续明确报错，不使用会产生空白页的系统协议回退。

## 验证

- RED：Chrome 直接 Profile 的 `Preferences` 中存在真实路径时旧实现返回空；无真实目录时仍错误显示“更新扩展”。
- GREEN：Preferences/Secure Preferences 两类位置均可识别；未知目录显示“重新安装扩展”。
- 聚焦 Desktop/Renderer：110/110 通过。
- `npm run check:syntax` 通过。
- 打包后 smoke 通过；包内验证 Preferences 真实路径覆盖与未知路径“重新安装扩展”状态通过。
- 测试 ZIP：`release/CodexBridge-Test-v0.2.3-20260712-205141-extension-truthful-state/CodexBridge-Windows-x64-Portable.zip`。
- ZIP：152302133 bytes，4614 个条目，SHA-256 `B6D4E2628A98347BC857B75A707A4DC254D36C30811CC6212C7FE4B8455DCB1A`。
- 测试完全使用隔离 Chrome User Data；上游 Bridge 源扩展保持干净。
- 未修改会话 provider、15722 Router，未删除文件或目录。
