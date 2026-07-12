# CodexBridge 整改记录 37：ChatGPT 重启隔离与动态扩展管理

日期：2026-07-12

## 用户现场

1. 选择统一版 ChatGPT 后点击“重启 ChatGPT / Codex”，仍被旧版 Codex 进程触发 `untrusted_codex_path`，无法打开 ChatGPT。
2. “双倍额度”只能重新检测或打开扩展页，不能把新版内置扩展覆盖到 Chrome 实际使用的稳定目录，旧磁盘文件无法靠“重新加载”升级。

## 根因

1. 重启计划虽然已经确定目标品牌为 ChatGPT，但停止列表仍包含所有识别出的 ChatGPT/Codex 进程。旧版 Codex 路径无法通过当前 ChatGPT 启动项的信任校验，错误地阻塞了 ChatGPT 重启。
2. 宿主只读取 `/health` 和 `/version`，没有读取 `/api/diagnostics/status`，因而无法区分未安装、版本过低、版本一致但断连和完全正常四种状态。
3. 旧稳定扩展目录没有采用统一的 `extensions/chatgpt-codex-bridge` 路径，页面也没有执行“覆盖内置文件、重写端口、打开扩展管理、重新检测”的完整动作。

## 修改

1. 重启计划只停止与已选启动项品牌一致的受信进程：选择 ChatGPT 时，残留 Codex 不再进入停止/阻塞列表；选择 Codex 时亦反向隔离。
2. 双倍额度服务新增诊断读取：
   - `/version`：读取 `extensionProtocolVersion`；
   - `/api/diagnostics/status`：读取扩展当前版本、期望版本、连接、重载和来源目录状态。
3. 扩展固定复制到 `<CodexBridge数据目录>/extensions/chatgpt-codex-bridge/`，每次安装、更新或修复都覆盖内置扩展并重新生成当前端口的 `bridge-config.js`。
4. 页面主按钮动态显示：安装扩展、更新扩展、修复扩展、扩展已是最新。完成条件同时要求版本一致、`needsReload=false`、`connected=true`。
5. 保留“打开扩展管理”和“重新检测”两个独立按钮；打开 Chrome 扩展页时优先使用本机 Chrome 可执行文件，避免额外命令行窗口。

## 测试

- RED：混合运行旧 Codex 与当前 ChatGPT 时，旧实现错误把两个 PID 都列入停止计划。
- GREEN：当前品牌隔离后只停止 ChatGPT PID，旧 Codex 不再阻塞重启。
- 扩展四态单元测试：安装、更新、修复、最新全部通过。
- 稳定目录测试：`manifest.json`、`background.js`、`content-script.js`、`bridge-config.js` 全部存在且端口配置正确。
- 聚焦 Desktop/Renderer：106/106 通过。
- `npm run check:syntax` 通过。
- 完整 Desktop 套件 799/803；4 个失败属于会话 provider 作用域切换后尚未更新的旧断言/真实验收证据测试，与本轮重启和扩展改动无关，本轮相关测试全部通过。
- 打包后 smoke 通过；包内 HTTP 子服务实际启动、诊断、停止通过：服务 0.1.0、扩展协议 `v20260712-preference-verify`、稳定目录和四个必需扩展文件均已回读。
- 测试 ZIP：`release/CodexBridge-Test-v0.2.3-20260712-195421-chatgpt-extension/CodexBridge-Windows-x64-Portable.zip`。
- ZIP：152295131 bytes，4611 个条目，SHA-256 `270CEF9E35C37CE79BB1123F56221F3F5166BA018948977FFEE26CA7090C2105`。

## 边界

- 未修改已经验收成功的会话 provider 作用域逻辑。
- 未修改 15722 Router、Bridge 内部模型同步或 Chrome 状态机。
- 未批量删除任何文件或目录。
