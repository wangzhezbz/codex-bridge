# CodexBridge Windows Portable Fallback / Windows 便携版备用

## 中文

Win 用户不要从源码运行，也不要执行 `npm install`。默认请下载 Windows 安装版，它会打开安装窗口、支持选择安装目录，并默认创建桌面图标：

[CodexBridge-Windows-x64-Setup.exe](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Setup.exe)

Windows 便携版备用只适合无法安装、需要手动解压、或想放到自定义目录里直接运行的场景：

[CodexBridge-Windows-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Portable.zip)

Mac 用户请下载 macOS 包：

- Apple Silicon: [CodexBridge-macOS-arm64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-arm64-Portable.zip)
- Intel Mac: [CodexBridge-macOS-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-x64-Portable.zip)

历史版本在这里：

[GitHub Releases](https://github.com/wangzhezbz/codex-bridge/releases)

### 包名规范

GitHub Release 附件固定命名为：

```text
CodexBridge-Windows-x64-Portable.zip
```

压缩包内的 release 目录会带版本号，例如：

```text
CodexBridge-Windows-x64-Portable-v0.1.10
```

### 便携版备用安装

1. 下载 `CodexBridge-Windows-x64-Portable.zip`。
2. 解压到一个可写目录，例如桌面或 `D:\CodexBridge`。
3. 打开解压后的 `CodexBridge-win32-x64` 文件夹。
4. 双击 `CodexBridge.exe`。

便携版会把配置、密钥、模型选择、统计和日志写到用户目录：

```text
%APPDATA%\CodexBridge
```

从旧版升级时，应用会尽量自动把旧解压目录里的 `CodexBridgeData` 复制到这个用户目录。复制只补缺失文件，不会覆盖你已经保存的新配置或新密钥。

Win 用户机器不需要安装 Node.js、npm 或 Electron。

源码里的 `Start-CodexBridge.cmd` 只适合开发者调试源码环境，不是用户交付方式。

### 应用内操作

1. 在“概览”选择计费模式。大多数用户选择混合模式。
2. 在“模型”页选择要暴露给 Codex 的模型。
3. 如需接入新服务，在“模型”页添加自定义 OpenAI-compatible 模型，或刷新服务商模型列表后再选择。
4. 填写对应 Provider 的 API Key。
5. 打开 Router 开关，CodexBridge 会自动刷新 Codex 配置。
6. 打开或点击“重启 ChatGPT / Codex”；新版桌面端使用 `ChatGPT.exe`，旧版 `Codex.exe` 仍兼容。

GPT 订阅模型不需要在 CodexBridge 里填写 API Key。DeepSeek、Kimi、Qwen、OpenRouter 等 API 模型需要填写各自 Provider 的 API Key。

### 历史对话不见了

如果启动 Router 并重启 ChatGPT / Codex 后，桌面端看不到以前的对话，先不要删除任何目录。打开 CodexBridge，进入左侧“会话”页，点击“找回历史对话”，然后完全退出并重新打开当前使用的 ChatGPT 或 Codex Desktop。

这个按钮会从 CodexBridge 写入前的备份里合并历史对话/桌面相关配置，同时保留当前模型栏、Router 地址和 API 配置。当前配置会先备份，不会删除历史对话文件。

如果 Codex 里的项目列表不对，也在“会话”页点击“恢复项目列表”。CodexBridge 会让 Codex 逐个打开可识别的真实项目目录，用 Codex 自己的方式刷新项目栏；不会修改模型、路由或会话内容。

## English

Win users should not run from source and should not run `npm install`. The normal download is the Windows installer. It opens an installer window, lets users choose the install location, and creates a desktop shortcut by default:

[CodexBridge-Windows-x64-Setup.exe](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Setup.exe)

The Windows portable fallback is only for locked-down machines, manual extraction, or users who intentionally want a self-contained folder:

[CodexBridge-Windows-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Portable.zip)

Mac users should download the macOS package:

- Apple Silicon: [CodexBridge-macOS-arm64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-arm64-Portable.zip)
- Intel Mac: [CodexBridge-macOS-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-x64-Portable.zip)

Release history:

[GitHub Releases](https://github.com/wangzhezbz/codex-bridge/releases)

### Package Naming

The GitHub Release asset uses this stable name:

```text
CodexBridge-Windows-x64-Portable.zip
```

The extracted release folder includes the version, for example:

```text
CodexBridge-Windows-x64-Portable-v0.1.10
```

### Portable Fallback Installation

1. Download `CodexBridge-Windows-x64-Portable.zip`.
2. Extract it to a writable folder, such as Desktop or `D:\CodexBridge`.
3. Open the extracted `CodexBridge-win32-x64` folder.
4. Run `CodexBridge.exe`.

The portable build stores config, API keys, model selection, usage data, and logs in the user profile:

```text
%APPDATA%\CodexBridge
```

When upgrading from older portable builds, the app tries to import the old `CodexBridgeData` folder into this user directory. The migration only fills missing files and will not overwrite newly saved settings or API keys.

Win users do not need Node.js, npm, or Electron installed.

`Start-CodexBridge.cmd` is only a developer fallback for running from source. It is not the customer delivery path.

### In-App Workflow

1. Choose the billing mode on the Dashboard. Most users should use Hybrid mode.
2. Select up to five models on the Models page.
3. Add custom OpenAI-compatible models on the Models page when needed.
4. Enter API keys on the Keys page.
5. Click Update Codex Config, then turn on Router.
6. Open or restart ChatGPT / Codex Desktop; new installations use `ChatGPT.exe`, while legacy `Codex.exe` remains supported.

GPT subscription models do not need an API key in CodexBridge. API providers such as DeepSeek, Kimi, Qwen, and OpenRouter need their own provider keys.

### Missing History

If old conversations disappear after starting Router and restarting ChatGPT / Codex, do not delete any folders. Open CodexBridge, go to the Sessions page in the left sidebar, click Recover History, then fully quit and reopen the ChatGPT or Codex Desktop app you currently use.

This merges history and desktop-related settings from the pre-Bridge backup while keeping the current model list, Router URL, and API settings. The current config is backed up first, and conversation files are not deleted.

If the Codex project list is wrong, click Recover Projects on the same Sessions page. CodexBridge asks Codex to open each recognized real project folder so Codex can refresh its own project list; model, router, and conversation data are not changed.
