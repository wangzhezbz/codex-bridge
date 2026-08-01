# Router 整改记录 77：Electron 主窗口与 IPC 安全边界

## 整改目标

继续处理项目扫描中的 P1 安全风险，加固 Electron 桌面主窗口：

- Windows 默认启用 Chromium sandbox
- 阻止主窗口导航到非受信页面
- 阻止主窗口创建新窗口和附加 WebView
- 限制 IPC 只能由当前 CodexBridge 主窗口调用

本轮不修改模型目录、供应商 API Key、Router 路由、自动选模型、失败回退或
GPT-5.6 Sol、Terra、Luna 的显式选择行为。

## 原有风险

1. Windows 默认添加 `--no-sandbox` 与 `--disable-gpu-sandbox`，导致 Chromium
   进程隔离保护默认关闭。
2. 主窗口没有 `will-navigate`、`will-redirect` 和 `setWindowOpenHandler`
   安全策略。一旦渲染层出现可控导航，远程页面可能在带 preload 的窗口环境中加载。
3. 现有约 80 个 `ipcMain.handle` handler 没有统一验证调用来源。单独依赖
   `contextIsolation` 和 `nodeIntegration: false` 不能防止错误导航后 preload
   能力被滥用。

## 修复内容

1. 新增 `desktop/window-security.cjs`，集中实现可测试的窗口安全策略。
2. Chromium sandbox 现在默认开启。只有操作员明确设置
   `CODEXBRIDGE_NO_SANDBOX=1` 时才添加关闭 sandbox 的命令行参数；
   `CODEXBRIDGE_CHROMIUM_SANDBOX=1` 始终优先保持启用。
3. 主窗口固定启用：
   - `sandbox: true`
   - `contextIsolation: true`
   - `nodeIntegration: false`
   - `webSecurity: true`
   - `allowRunningInsecureContent: false`
   - `webviewTag: false`
4. 主窗口只允许当前 `desktop/renderer/index.html`，允许页面内部 hash；
   其他文件、HTTP/HTTPS 导航和重定向全部调用 `preventDefault()`。
5. `window.open` 全部返回 `deny`，`will-attach-webview` 全部阻止。产品需要打开
   外部链接时继续通过已有、受校验的主进程外链 IPC。
6. 所有现有 IPC handler 通过统一注册器校验：
   - `event.sender` 必须是当前主窗口的 WebContents
   - `event.senderFrame.url` 必须是受信 renderer 文件
   任意其他窗口、frame 或远程页面调用都会收到 `ERR_UNTRUSTED_IPC_SENDER`。
7. 桌面 smoke 增加真实运行检查：确认安全 WebPreferences、生效的 Chromium
   sandbox，以及非受信导航确实被阻止。

## 测试驱动证据

修复前新增测试稳定失败：

- sandbox 策略函数不存在
- 导航和弹窗保护不存在
- IPC sender 统一校验不存在
- 固定桌面门禁没有包含安全策略测试

实现后定向安全与桌面契约回归：`103/103` 通过。

最终项目完整 `npm run check` 通过，其中：

- 桌面测试：`888/888`
- 历史恢复测试：`16/16`
- 语法、Router、Anthropic 和供应商模型刷新门禁全部通过

第一次真实 smoke 中，主动构造的非受信导航已经成功被阻止，但阻断日志被错误
归入 renderer 错误计数，导致 smoke 按一个错误退出。根因确认后，仅把成功阻断
事件改为安全运行日志，不放宽导航策略；第二次真实 smoke 通过。

## 真实桌面验证

- Electron 正常启动，退出码为 `0`
- Windows 默认没有添加 `--no-sandbox`
- 主窗口安全 WebPreferences 检查通过
- 非受信导航拦截检查通过
- 供应商预览：`19`
- 资源摘要：`28/2/3/46/3/0/2`
- 插件：`28`
- 应用：`2`
- 插件 MCP：`3`
- 技能：`46`
- 市场：`3`
- 原有资源、会话和统计页面导航通过

## 主要修改文件

- `desktop/window-security.cjs`
- `desktop/main.cjs`
- `tests/desktop-window-security.test.js`
- `tests/package-naming.test.js`
- `package.json`

## 明确保留的兼容入口

如果极少数旧 Windows 环境确实无法在 Chromium sandbox 下启动，可以临时设置：

```powershell
$env:CODEXBRIDGE_NO_SANDBOX="1"
npm run desktop
```

该入口现在是显式、可审计的兼容降级，不再是所有 Windows 用户的默认行为。

## 后续风险

下一批建议继续处理：

1. 自动更新包的可信签名或强哈希校验。
2. 上游流式与非流式响应的统一体积、时间和背压上限。
3. 生产依赖漏洞的逐项兼容性升级。
