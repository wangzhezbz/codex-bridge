# CodexBridge Windows Portable / Windows 免安装包

## 中文

Win 用户不要从源码运行，也不要执行 `npm install`。正式交付方式是下载 GitHub Release 里的 Windows 免安装包：

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

### 用户安装

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
6. 打开或重启 Codex。

GPT 订阅模型不需要在 CodexBridge 里填写 API Key。DeepSeek、Kimi、Qwen、OpenRouter 等 API 模型需要填写各自 Provider 的 API Key。

### 历史对话不见了

如果启动 Router 并重启 Codex 后，Codex 里看不到以前的对话，先不要删除任何目录。打开 CodexBridge，点击右上角“找回历史对话”，然后完全退出并重新打开 Codex。

这个按钮会从 CodexBridge 写入前的备份里合并历史对话/桌面相关配置，同时保留当前模型栏、Router 地址和 API 配置。当前配置会先备份，不会删除历史对话文件。

## English

Win users should not run from source and should not run `npm install`. The customer-facing delivery is the Windows portable package from GitHub Releases:

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

### Installation

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
6. Open or restart Codex.

GPT subscription models do not need an API key in CodexBridge. API providers such as DeepSeek, Kimi, Qwen, and OpenRouter need their own provider keys.

### Missing History

If old Codex conversations disappear after starting Router and restarting Codex, do not delete any folders. Open CodexBridge, click Recover History in the top-right corner, then fully quit and reopen Codex.

This merges history and desktop-related settings from the pre-Bridge backup while keeping the current model list, Router URL, and API settings. The current config is backed up first, and conversation files are not deleted.
