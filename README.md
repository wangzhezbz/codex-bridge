# CodexBridge

Local multi-model gateway and desktop manager for Codex.

Codex 多模型本地网关与桌面管理器。

CodexBridge lets Codex use GPT, DeepSeek, Kimi, and more OpenAI-compatible models from one local router and one model picker.

CodexBridge 让 Codex 通过一个本地 Router 和一个模型栏同时使用 GPT、DeepSeek、Kimi 以及更多 OpenAI-compatible 模型。

## 下载

### Windows

- **推荐·安装版：** [CodexBridge-Windows-x64-Setup.exe](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Setup.exe)
- **免安装版：** [CodexBridge-Windows-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Portable.zip)

### macOS

- **M 系列芯片：** [CodexBridge-macOS-arm64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-arm64-Portable.zip)
- **Intel 芯片：** [CodexBridge-macOS-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-x64-Portable.zip)

macOS 提示“已损坏”或无法打开时，先把 `CodexBridge.app` 放到“应用程序”，然后打开“终端”执行下面命令，输入电脑密码并回车：

```bash
sudo xattr -cr /Applications/CodexBridge.app
```

历史版本：[GitHub Releases](https://github.com/wangzhezbz/codex-bridge/releases)

下载后，Windows 用户优先运行 Windows 安装版；Windows 免安装包只是备用方案。macOS 用户解压对应芯片的 macOS 包后运行。

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

The unified ChatGPT Desktop app (and legacy Codex Desktop) can point its Codex provider at a local base URL, but users still need a practical way to mix multiple upstream providers in one model picker.

CodexBridge acts as a local bridge:

```text
ChatGPT / Codex Desktop -> CodexBridge -> GPT / DeepSeek / Kimi / other models
```

新版 ChatGPT Desktop（以及仍受支持的旧版 Codex Desktop）可以把 Codex provider 指向本地 base URL，但很多 Win 用户和 Mac 用户仍很难把多家模型同时放进一个模型栏里稳定使用。

CodexBridge 的角色就是本地桥接层：

```text
ChatGPT / Codex Desktop -> CodexBridge -> GPT / DeepSeek / Kimi / 更多模型
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

Codex config uses a dedicated CodexBridge provider and points it at the local router:

Codex 配置使用独立的 CodexBridge provider，并把 base URL 指到本地 Router：

```toml
model_provider = "codexbridge"
model = "cb-gpt-5-6-sol"
model_catalog_json = "C:/Users/you/.codex/codexbridge-model-catalog.json"
model_reasoning_effort = "medium"
model_providers.codexbridge.name = "CodexBridge"
model_providers.codexbridge.base_url = "http://127.0.0.1:15722/v1"
model_providers.codexbridge.wire_api = "responses"
model_providers.codexbridge.requires_openai_auth = false
model_providers.codexbridge.http_headers = { Authorization = "Bearer <same-random-token-as-router-config>" }
```

The desktop manager generates this local Router token automatically. When running from
source with the example config, set `CODEXBRIDGE_ROUTER_TOKEN` to a random value and use
that same value in the Codex provider header. Requests fail closed when the variable is
missing.

### Hybrid / 混合模式

GPT models can use the Codex/OpenAI authentication that Codex sends to the local router, while DeepSeek, Kimi, and other third-party models keep using their own API keys.

GPT 模型可以使用 Codex 传给本地 Router 的 Codex/OpenAI 认证；DeepSeek、Kimi 和其他第三方模型继续使用各自 API Key。

Use:

使用：

```text
config/router.config.hybrid.example.json
```

Hybrid mode preserves Codex's built-in `openai` provider identity so legacy OpenAI conversations stay in the same history scope. Only the built-in provider base URL is redirected to the local Router:

混合模式保留 Codex 内置 `openai` provider 身份，让旧 OpenAI 会话继续处于同一历史作用域；只把内置 provider 的 base URL 指向本地 Router：

```toml
model_provider = "openai"
model = "cb-gpt-5-6-sol"
model_catalog_json = "C:/Users/you/.codex/codexbridge-model-catalog.json"
model_reasoning_effort = "medium"
openai_base_url = "http://127.0.0.1:15722/v1"
```

Hybrid mode is implemented in the router core, but real ChatGPT subscription billing must be verified on a signed-in Codex account because unit tests cannot create a ChatGPT subscription bearer token.

混合模式的路由底座已经实现，但真实 ChatGPT 订阅额度需要在已登录的 Codex 账号上实测，因为单元测试不能生成 ChatGPT 订阅 bearer token。

## Quick Start / 快速开始

Win users should use the Windows installer above. The Windows portable zip is only a fallback; Mac users should use the macOS portable builds. Node.js is only needed when developing from source.

Win 用户请优先使用上面的 Windows 安装版；Windows 免安装包只是备用。Mac 用户使用对应芯片的 macOS 免安装包。只有从源码开发时才需要 Node.js。

### Desktop manager / 桌面管理器

On Windows, download the Windows installer and run it. Portable fallback users can extract the zip and double-click:

Windows 下下载 Windows 安装版并运行。需要便携版备用时，再解压 zip 后双击：

```text
CodexBridge.exe
```

On macOS, download the matching macOS zip, extract it, and open:

macOS 下下载对应的 macOS 压缩包，解压后打开：

```text
CodexBridge.app
```

The app opens the CodexBridge window directly. In the window, choose a billing mode, select the models you want to expose to Codex, fill API keys, and start the router.

应用会直接打开 CodexBridge 窗口。你可以在窗口里选择计费模式、选择要暴露给 Codex 的模型、填写 API Key，然后启动 Router。

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
model = "cb-gpt-5-6-sol"
model_catalog_json = "C:/Users/you/.codex/codexbridge-model-catalog.json"
model_reasoning_effort = "medium"
openai_base_url = "http://127.0.0.1:15722/v1"
```

Hybrid mode keeps the built-in `openai` provider identity and redirects it to the local Router. This preserves the legacy OpenAI conversation scope; the desktop app repairs older managed configs automatically and keeps a backup before writing. All-API mode continues to use the dedicated `model_providers.codexbridge` entry.

混合模式保留内置 `openai` provider 身份，只把它重定向到本地 Router，从而保留旧 OpenAI 会话作用域。桌面端会自动修复旧托管配置，并在写入前保留备份；全部 API 模式仍使用独立的 `model_providers.codexbridge`。

Restart ChatGPT / Codex Desktop after changing `model_catalog_json`.

修改 `model_catalog_json` 后，需要点击“重启 ChatGPT / Codex”才能刷新模型栏。

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

If ChatGPT / Codex Desktop shows `502 Bad Gateway`, open the CodexBridge log page first.

如果 ChatGPT / Codex Desktop 显示 `502 Bad Gateway`，请先打开 CodexBridge 的日志页。

- If there is no `access POST /v1/responses` line, the desktop app did not reach Router. Restart CodexBridge, start Router again, then restart ChatGPT / Codex Desktop.
- If `access POST /v1/responses` appears, the request reached Router. Check the following `req_... -> upstream` and `req_... !! upstream` lines for the real provider, model, proxy, status, and upstream message.
- If every model fails with 502 and there is no access log, the usual cause is stale Codex config or a system proxy/VPN intercepting local traffic. Current releases write `http://127.0.0.1:15722/v1` automatically when Router starts.
- If the log says `Missing API key ... Set MOONSHOT_API_KEY` or another `*_API_KEY`, save that provider key in the API Key page. The Codex slot name such as `gpt-5.2` may actually map to Kimi or another provider.

- 如果没有 `access POST /v1/responses`，说明桌面应用没有打到 Router。请重启 CodexBridge，重新启动 Router，再点击“重启 ChatGPT / Codex”。
- 如果出现了 `access POST /v1/responses`，说明请求已经进 Router。继续看后面的 `req_... -> upstream` 和 `req_... !! upstream`，里面会显示真实 provider、真实模型、代理、状态码和上游错误。
- 如果所有模型都 502 且没有 access 日志，常见原因是 Codex 配置仍是旧的，或系统代理/VPN 接管了本地流量。当前版本在启动 Router 时会自动写入 `http://127.0.0.1:15722/v1`。
- 如果日志写着 `Missing API key ... Set MOONSHOT_API_KEY` 或其他 `*_API_KEY`，请到“密钥”页保存对应服务商的 Key。`gpt-5.2` 这类 Codex 槽位名可能实际映射到 Kimi 或其他模型。

## Recover Conversations / 找回历史对话

Hybrid mode uses `model_provider = "openai"` with `openai_base_url` pointing to the local Router, so enabling Bridge does not switch legacy conversations into a different provider scope. All-API mode still uses the independent `codexbridge` provider. The recover button is a separate repair tool and is not the primary fix for provider-scoped history visibility.

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

Detailed current progress is tracked in [docs/roadmap-progress.md](docs/roadmap-progress.md).

当前路线图的真实进度记录在 [docs/roadmap-progress.md](docs/roadmap-progress.md)。

- Desktop app with setup wizard.
- Provider and API key management.
- Large preset model/provider library.
- One-click Codex config apply and rollback.
- Usage dashboard with real upstream model and token records.
- Live logs and diagnostics export.
- Windows installer, Windows portable fallback, and macOS portable packages with no manual Node.js setup.

- 桌面应用和新手配置向导。
- Provider 与 API Key 管理。
- 更丰富的预设模型和 provider 库。
- 一键写入 Codex 配置和一键回滚。
- 展示真实上游模型和 token 记录的用量面板。
- 实时日志和诊断导出。
- Windows 安装版、Windows 免安装备用包和 macOS 免安装包，不再要求用户手动安装 Node.js。

## License / 许可证

MIT
