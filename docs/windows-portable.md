# CodexBridge Windows Portable / Windows 免安装包

## 中文

普通用户不要从源码运行，也不要执行 `npm install`。正式交付方式是下载 GitHub Release 里的 Windows 免安装包：

[CodexBridge-Windows-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Portable.zip)

历史版本在这里：

[GitHub Releases](https://github.com/wangzhezbz/codex-bridge/releases)

### 包名规范

GitHub Release 附件固定命名为：

```text
CodexBridge-Windows-x64-Portable.zip
```

压缩包内的 release 目录会带版本号，例如：

```text
CodexBridge-Windows-x64-Portable-v0.1.3
```

### 用户安装

1. 下载 `CodexBridge-Windows-x64-Portable.zip`。
2. 解压到一个可写目录，例如桌面或 `D:\CodexBridge`。
3. 打开解压后的 `CodexBridge-win32-x64` 文件夹。
4. 双击 `CodexBridge.exe`。

便携版会把配置、密钥和日志写到同级目录：

```text
CodexBridgeData
```

用户机器不需要安装 Node.js、npm 或 Electron。

源码里的 `Start-CodexBridge.cmd` 只适合开发者调试源码环境，不是用户交付方式。

### 应用内操作

1. 在“概览”选择计费模式。大多数用户选择混合模式。
2. 在“模型”页从内置模型池里选择最多 5 个模型。
3. 如需接入新服务，在“模型”页添加自定义 OpenAI-compatible 模型。
4. 在“密钥”页填写对应 Provider 的 API Key。
5. 点击“更新 Codex 配置”，再打开 Router 开关。
6. 打开或重启 Codex。

GPT 订阅模型不需要在 CodexBridge 里填写 API Key。DeepSeek、Kimi、Qwen、OpenRouter 等 API 模型需要填写各自 Provider 的 API Key。

## English

Normal users should not run from source and should not run `npm install`. The customer-facing delivery is the Windows portable package from GitHub Releases:

[CodexBridge-Windows-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Portable.zip)

Release history:

[GitHub Releases](https://github.com/wangzhezbz/codex-bridge/releases)

### Package Naming

The GitHub Release asset uses this stable name:

```text
CodexBridge-Windows-x64-Portable.zip
```

The extracted release folder includes the version, for example:

```text
CodexBridge-Windows-x64-Portable-v0.1.3
```

### Installation

1. Download `CodexBridge-Windows-x64-Portable.zip`.
2. Extract it to a writable folder, such as Desktop or `D:\CodexBridge`.
3. Open the extracted `CodexBridge-win32-x64` folder.
4. Run `CodexBridge.exe`.

The portable build stores config, API keys, and logs in the sibling folder:

```text
CodexBridgeData
```

Users do not need Node.js, npm, or Electron installed.

`Start-CodexBridge.cmd` is only a developer fallback for running from source. It is not the customer delivery path.

### In-App Workflow

1. Choose the billing mode on the Dashboard. Most users should use Hybrid mode.
2. Select up to five models on the Models page.
3. Add custom OpenAI-compatible models on the Models page when needed.
4. Enter API keys on the Keys page.
5. Click Update Codex Config, then turn on Router.
6. Open or restart Codex.

GPT subscription models do not need an API key in CodexBridge. API providers such as DeepSeek, Kimi, Qwen, and OpenRouter need their own provider keys.
