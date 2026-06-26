# CodexBridge

Local multi-model gateway and desktop manager for Codex.

Codex 多模型本地网关与桌面管理器。

CodexBridge lets Codex use GPT, DeepSeek, Kimi, and more OpenAI-compatible models from one local router and one model picker.

CodexBridge 让 Codex 通过一个本地 Router 和一个模型栏同时使用 GPT、DeepSeek、Kimi 以及更多 OpenAI-compatible 模型。

## Download / 下载

Latest portable builds:

最新免安装包：

- Windows: [CodexBridge-Windows-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Portable.zip)
- Mac M series: [CodexBridge-macOS-arm64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-arm64-Portable.zip)
- Mac Intel: [CodexBridge-macOS-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-x64-Portable.zip)

macOS note:

macOS 提示“已损坏”或无法打开时，先把 `CodexBridge.app` 放到“应用程序”，然后打开“终端”执行下面命令，输入电脑密码并回车：

```bash
sudo xattr -cr /Applications/CodexBridge.app
```

Release history:

历史版本：

[GitHub Releases](https://github.com/wangzhezbz/codex-bridge/releases)

After downloading, extract the zip and run the app for your platform.

下载后解压，并运行对应平台的应用。

## Status / 当前状态

This repository contains the CodexBridge desktop manager and local router core.

当前仓库包含 CodexBridge 桌面管理器和本地路由核心。

Current capabilities:

- Exposes a local Responses-compatible endpoint for Codex.
- Generates a Codex model catalog.
- Routes GPT, DeepSeek, Kimi, and custom OpenAI-compatible models by model selection.
- Converts Codex Responses requests to Chat Completions for providers such as DeepSeek and Kimi.
- Keeps Codex command execution, file edits, `apply_patch`, and local tools available because Codex still owns the local tool layer.
- Logs the real upstream model, provider, status, and token usage.

当前能力：

- 为 Codex 提供本地 Responses-compatible 接口。
- 生成 Codex 模型目录。
- 根据模型栏选择，把请求路由到 GPT、DeepSeek、Kimi 或自定义 OpenAI-compatible 模型。
- 为 DeepSeek、Kimi 等 Chat Completions 服务做协议转换。
- 保留 Codex 的命令执行、文件修改、`apply_patch` 和本地工具能力，因为本地工具层仍然由 Codex 执行。
- 记录真实上游模型、provider、状态和 token 用量。

## Why / 为什么做这个

Codex Desktop can point its built-in OpenAI provider at a local base URL, but users still need a practical way to mix multiple upstream providers in one model picker.

CodexBridge acts as a local bridge:

```text
Codex Desktop -> CodexBridge -> GPT / DeepSeek / Kimi / other models
```

Codex Desktop 可以把内置 OpenAI provider 指向本地 base URL，但很多 Win 用户和 Mac 用户很难把多家模型同时放进一个模型栏里稳定使用。

CodexBridge 的角色就是本地桥接层：

```text
Codex Desktop -> CodexBridge -> GPT / DeepSeek / Kimi / 更多模型
```

## Billing Modes / 计费模式

CodexBridge supports per-model authentication.

CodexBridge 支持按模型选择认证方式。

### All API / 全部 API

Every model uses the API key configured for its upstream provider.

所有模型都使用各自 provider 配置的 API Key。

Use:

使用：

```text
config/router.config.example.json
```

Codex config keeps the built-in OpenAI provider and points it at the local router:

Codex 配置保留内置 OpenAI provider，并把 base URL 指到本地 Router：

```toml
model_provider = "openai"
model = "gpt-5.5"
model_catalog_json = "C:/Users/you/AppData/Roaming/CodexBridge/model-catalog.json"
model_reasoning_effort = "medium"
disable_response_storage = false
network_access = "enabled"
openai_base_url = "http://localhost:15722/v1"
windows_wsl_setup_acknowledged = true
```

### Hybrid / 混合模式

GPT models can use the Codex/OpenAI authentication that Codex sends to the local router, while DeepSeek, Kimi, and other third-party models keep using their own API keys.

GPT 模型可以使用 Codex 传给本地 Router 的 Codex/OpenAI 认证；DeepSeek、Kimi 和其他第三方模型继续使用各自 API Key。

Use:

使用：

```text
config/router.config.hybrid.example.json
```

Codex config is the same as All API mode. The router decides whether a selected model uses the Codex/OpenAI bearer or that provider's API key:

Codex 配置和全部 API 模式相同；具体上游认证由 Router 按模型决定：

```toml
model_provider = "openai"
model = "gpt-5.5"
model_catalog_json = "C:/Users/you/AppData/Roaming/CodexBridge/model-catalog.json"
model_reasoning_effort = "medium"
disable_response_storage = false
network_access = "enabled"
openai_base_url = "http://localhost:15722/v1"
windows_wsl_setup_acknowledged = true
```

Hybrid mode is implemented in the router core, but real ChatGPT subscription billing must be verified on a signed-in Codex account because unit tests cannot create a ChatGPT subscription bearer token.

混合模式的路由底座已经实现，但真实 ChatGPT 订阅额度需要在已登录的 Codex 账号上实测，因为单元测试不能生成 ChatGPT 订阅 bearer token。

## Quick Start / 快速开始

Win users and Mac users should use the portable builds above. Node.js is only needed when developing from source.

Win 用户和 Mac 用户请使用上面的免安装包。只有从源码开发时才需要 Node.js。

### Desktop manager / 桌面管理器

On Windows, download the Windows portable zip, extract it, and double-click:

Windows 下下载 Windows 免安装包，解压后双击：

```text
CodexBridge.exe
```

On macOS, download the matching macOS zip, extract it, and open:

macOS 下下载对应的 macOS 压缩包，解压后打开：

```text
CodexBridge.app
```

The app opens the CodexBridge window directly. In the window, choose a billing mode, select up to five models, fill API keys, update Codex config, and start the router.

应用会直接打开 CodexBridge 窗口。你可以在窗口里选择计费模式、选择最多 5 个模型、填写 API Key、更新 Codex 配置并启动 Router。

Starting Router from the desktop app also refreshes the Codex config and model catalog, so Win users and Mac users do not need to click setup buttons in a strict order.

从桌面应用启动 Router 时，会自动刷新 Codex 配置和模型目录，Win 用户和 Mac 用户不需要严格按按钮顺序操作。

For development, you can also run:

Source development requires Node.js 22.15.0 or newer because Codex Desktop may send zstd-compressed request bodies.

开发时也可以运行：

源码开发需要 Node.js 22.15.0 或更高版本，因为 Codex Desktop 可能发送 zstd 压缩请求体。

```powershell
npm install
npm run desktop
```

### Headless router / 无界面路由

```powershell
git clone https://github.com/wangzhezbz/codex-bridge.git
cd codex-bridge
Copy-Item .\config\router.config.example.json .\config\router.config.json
notepad .\config\router.config.json
```

For hybrid mode, copy the hybrid example instead:

如果使用混合模式，复制混合示例：

```powershell
Copy-Item .\config\router.config.hybrid.example.json .\config\router.config.json
```

Set API keys for the providers you enabled:

设置你启用的 provider 对应 API Key：

```powershell
$env:OPENAI_API_KEY = "your-openai-api-key"
$env:DEEPSEEK_API_KEY = "your-deepseek-api-key"
$env:MOONSHOT_API_KEY = "your-kimi-api-key"
```

Generate the Codex model catalog:

生成 Codex 模型目录：

```powershell
npm run catalog
```

Start the local router:

启动本地路由：

```powershell
npm start
```

Default local endpoint:

默认本地地址：

```text
http://127.0.0.1:15722
```

## Moonshot / Kimi Endpoints / Moonshot / Kimi 端点

The Kimi / Moonshot provider defaults to the domestic Open Platform endpoint. Switch the Base URL in the desktop app's Kimi provider card (or edit `config/provider-overrides.json`) when you need an international or Kimi Code endpoint.

Kimi / Moonshot provider 默认走国内开放平台端点。如果需要国际版或 Kimi Code 端点，在桌面端 Kimi 服务商卡片里改 Base URL（或直接编辑 `config/provider-overrides.json`）。

Common endpoints / 常见端点：

- Domestic (default) / 国内（默认）：`https://api.moonshot.cn/v1`
- International / 国际版：`https://api.moonshot.ai/v1`
- Kimi Code (OpenAI-compatible) / Kimi Code（OpenAI 兼容）：`https://api.kimi.com/coding/v1`

The Anthropic-compatible endpoint at `/coding/v1/messages` is **not yet supported** by CodexBridge. Use the OpenAI-compatible path above; Anthropic-format requests are out of scope for this release.

CodexBridge **暂不支持** `/coding/v1/messages` 这样的 Anthropic 兼容端点，请使用上面的 OpenAI 兼容路径；Anthropic 格式请求不在本次发布范围内。

## Codex Config / Codex 配置

Edit:

编辑：

```text
%USERPROFILE%\.codex\config.toml
```

On macOS:

macOS 下：

```text
~/.codex/config.toml
```

Example:

示例：

```toml
model_provider = "openai"
model = "gpt-5.5"
model_catalog_json = "C:/Users/you/AppData/Roaming/CodexBridge/model-catalog.json"
model_reasoning_effort = "medium"
disable_response_storage = false
network_access = "enabled"
openai_base_url = "http://localhost:15722/v1"
windows_wsl_setup_acknowledged = true
```

CodexBridge now uses `openai_base_url` instead of a custom `model_providers.codex-bridge` entry, so existing Codex Desktop conversations remain attached to the built-in `openai` provider.

CodexBridge 现在使用 `openai_base_url` 指向本地 Router，不再写 `experimental_bearer_token` 或 `requires_openai_auth`。

Restart Codex Desktop after changing `model_catalog_json`.

修改 `model_catalog_json` 后，需要重启 Codex Desktop 才能刷新模型栏。

## Verify / 验证

Run checks:

运行检查：

```powershell
npm run check
```

Check local endpoints:

检查本地接口：

```powershell
curl.exe http://127.0.0.1:15722/health
curl.exe http://127.0.0.1:15722/v1/models
curl.exe http://127.0.0.1:15722/model-catalog.json
```

In PowerShell, use `curl.exe` instead of `curl` because `curl` is usually an alias for `Invoke-WebRequest`.

PowerShell 里建议使用 `curl.exe`，因为 `curl` 通常是 `Invoke-WebRequest` 的别名。

## Troubleshooting 502 / 502 排查

If Codex shows `502 Bad Gateway`, open the CodexBridge log page first.

如果 Codex 显示 `502 Bad Gateway`，请先打开 CodexBridge 的日志页。

- If there is no `access POST /v1/responses` line, Codex did not reach Router. Restart CodexBridge, start Router again, then restart Codex.
- If `access POST /v1/responses` appears, the request reached Router. Check the following `req_... -> upstream` and `req_... !! upstream` lines for the real provider, model, proxy, status, and upstream message.
- If every model fails with 502 and there is no access log, the usual cause is stale Codex config or a system proxy/VPN intercepting local traffic. Current releases write `http://localhost:15722/v1` automatically when Router starts.
- If the log says `Missing API key ... Set MOONSHOT_API_KEY` or another `*_API_KEY`, save that provider key in the API Key page. The Codex slot name such as `gpt-5.2` may actually map to Kimi or another provider.

- 如果没有 `access POST /v1/responses`，说明 Codex 没有打到 Router。请重启 CodexBridge，重新启动 Router，再重启 Codex。
- 如果出现了 `access POST /v1/responses`，说明请求已经进 Router。继续看后面的 `req_... -> upstream` 和 `req_... !! upstream`，里面会显示真实 provider、真实模型、代理、状态码和上游错误。
- 如果所有模型都 502 且没有 access 日志，常见原因是 Codex 配置仍是旧的，或系统代理/VPN 接管了本地流量。当前版本在启动 Router 时会自动写入 `http://localhost:15722/v1`。
- 如果日志写着 `Missing API key ... Set MOONSHOT_API_KEY` 或其他 `*_API_KEY`，请到“密钥”页保存对应服务商的 Key。`gpt-5.2` 这类 Codex 槽位名可能实际映射到 Kimi 或其他模型。

## Recover Conversations / 找回历史对话

Current releases keep `model_provider = "openai"` and use `openai_base_url`, so old Codex Desktop conversations should remain visible after clicking `更新 Codex 配置`, starting Router, and fully reopening Codex. The recover button is only a fallback for merging old desktop/history settings from backups; it cannot recreate conversations if Codex's local session database was deleted or a different `CODEX_HOME` is being used.

If old Codex conversations disappear after enabling CodexBridge, open CodexBridge and click `找回历史对话`. The app merges history and desktop-related settings from the pre-Bridge backup while keeping the current CodexBridge model list, Router URL, and API settings. Then fully quit and reopen Codex.

如果开启 CodexBridge 后看不到以前的 Codex 对话，打开 CodexBridge，点击 `找回历史对话`。应用会从写入 CodexBridge 前的备份里合并历史对话/桌面相关配置，同时保留当前模型栏、Router 地址和 API 配置。然后完全退出并重新打开 Codex。

## Safety / 安全说明

- Do not commit `config/router.config.json`.
- Do not commit `.env` files or API keys.
- Keep API keys in environment variables for the headless preview.
- The desktop manager stores secrets locally in the current user's CodexBridge data directory.

- 不要提交 `config/router.config.json`。
- 不要提交 `.env` 文件或 API Key。
- 当前无界面预览版建议把 API Key 放在环境变量里。
- 桌面管理器会把密钥保存在当前用户的 CodexBridge 数据目录中。

## Roadmap / 路线图

- Desktop app with setup wizard.
- Provider and API key management.
- Large preset model/provider library.
- One-click Codex config apply and rollback.
- Usage dashboard with real upstream model and token records.
- Live logs and diagnostics export.
- Win and Mac portable packages with no manual Node.js setup.

- 桌面应用和新手配置向导。
- Provider 与 API Key 管理。
- 更丰富的预设模型和 provider 库。
- 一键写入 Codex 配置和一键回滚。
- 展示真实上游模型和 token 记录的用量面板。
- 实时日志和诊断导出。
- Win 和 Mac 免安装包，不再要求用户手动安装 Node.js。

## License / 许可证

MIT
