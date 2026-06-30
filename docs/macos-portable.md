# CodexBridge macOS Portable / macOS 免安装包

## 中文

Mac 用户不要从源码运行，也不要执行 `npm install`。正式交付方式是下载 GitHub Release 里的 macOS 免安装包：

- Apple Silicon 芯片 Mac: [CodexBridge-macOS-arm64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-arm64-Portable.zip)
- Intel 芯片 Mac: [CodexBridge-macOS-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-x64-Portable.zip)

如果 macOS 提示“已损坏”或无法打开，先把 `CodexBridge.app` 放到“应用程序”，然后打开“终端”执行下面命令，输入电脑密码并回车：

```bash
sudo xattr -cr /Applications/CodexBridge.app
```

Win 用户请下载 Windows 包：

[CodexBridge-Windows-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Portable.zip)

历史版本在这里：

[GitHub Releases](https://github.com/wangzhezbz/codex-bridge/releases)

### 如何选择

- M 系列芯片，例如 M1、M2、M3、M4：下载 `CodexBridge-macOS-arm64-Portable.zip`。
- Intel 芯片 Mac：下载 `CodexBridge-macOS-x64-Portable.zip`。

### 安装和首次打开

1. 下载对应的 macOS zip。
2. 解压后得到 `CodexBridge.app`。
3. 可以直接放在“应用程序”目录，也可以放在桌面或其他可写目录。
4. 首次打开如果 macOS 提示无法验证开发者，请右键或 Control-click `CodexBridge.app`，选择“打开”。

当前 macOS 包是未签名预览包。后续有 Apple Developer 证书后，可以补代码签名和 notarization，届时首次打开会更顺滑。

### 用户数据目录

Mac 版会把配置、密钥、模型选择、统计和日志写到当前用户目录：

```text
~/Library/Application Support/CodexBridge
```

重新下载或解压新版应用不会覆盖这里的配置和 API Key。

### 应用内操作

1. 在“概览”选择计费模式。
2. 在“模型”页选择要暴露给 Codex 的模型。
3. 如需接入新服务，在“模型”页添加自定义 OpenAI-compatible 模型，或刷新服务商模型列表后再选择。
4. 填写对应 Provider 的 API Key。
5. 打开 Router 开关，CodexBridge 会自动刷新 Codex 配置。
6. 打开或重启 Codex。

GPT 订阅模型不需要在 CodexBridge 里填写 API Key。API providers such as DeepSeek, Kimi, Qwen, and OpenRouter need their own provider keys.

### 历史对话不见了

如果启动 Router 并重启 Codex 后，Codex 里看不到以前的对话，先不要删除任何目录。打开 CodexBridge，点击右上角“找回历史对话”，然后完全退出并重新打开 Codex。

这个按钮会从 CodexBridge 写入前的备份里合并历史对话/桌面相关配置，同时保留当前模型栏、Router 地址和 API 配置。当前配置会先备份，不会删除历史对话文件。

## English

Mac users should not run from source and should not run `npm install`. The customer-facing delivery is the macOS portable package from GitHub Releases:

- Apple Silicon Mac: [CodexBridge-macOS-arm64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-arm64-Portable.zip)
- Intel Mac: [CodexBridge-macOS-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-x64-Portable.zip)

If macOS says the app is damaged or cannot be opened, move `CodexBridge.app` to Applications, then run this command in Terminal and enter your Mac password:

```bash
sudo xattr -cr /Applications/CodexBridge.app
```

Win users should download the Windows package:

[CodexBridge-Windows-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Portable.zip)

Release history:

[GitHub Releases](https://github.com/wangzhezbz/codex-bridge/releases)

### Pick the Right Package

- M-series chips such as M1, M2, M3, and M4: download `CodexBridge-macOS-arm64-Portable.zip`.
- Intel Mac: download `CodexBridge-macOS-x64-Portable.zip`.

### Install and First Launch

1. Download the matching macOS zip.
2. Extract it to get `CodexBridge.app`.
3. Move it to Applications, Desktop, or another writable folder.
4. On first launch, if macOS says the developer cannot be verified, right-click or Control-click `CodexBridge.app`, then choose Open.

The current macOS package is an unsigned preview build. Code signing and notarization can be added after an Apple Developer certificate is available.

### User Data Directory

The macOS build stores config, API keys, model selection, usage data, and logs in the current user profile:

```text
~/Library/Application Support/CodexBridge
```

Downloading or extracting a newer app will not overwrite saved settings or API keys.

### In-App Workflow

1. Choose the billing mode on the Dashboard.
2. Select up to five models on the Models page.
3. Add custom OpenAI-compatible models on the Models page when needed.
4. Enter API keys on the Keys page.
5. Click Update Codex Config, then turn on Router.
6. Open or restart Codex.

GPT subscription models do not need an API key in CodexBridge. API providers such as DeepSeek, Kimi, Qwen, and OpenRouter need their own provider keys.

### Missing History

If old Codex conversations disappear after starting Router and restarting Codex, do not delete any folders. Open CodexBridge, click Recover History in the top-right corner, then fully quit and reopen Codex.

This merges history and desktop-related settings from the pre-Bridge backup while keeping the current model list, Router URL, and API settings. The current config is backed up first, and conversation files are not deleted.
