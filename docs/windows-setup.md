# Windows Setup / Windows 配置指南

This guide is for developers running from source. Win users should download the installer; the portable zip remains a fallback:

[CodexBridge-Windows-x64-Setup.exe](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Setup.exe)
[CodexBridge-Windows-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Portable.zip)

Mac users:

- Apple Silicon: [CodexBridge-macOS-arm64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-arm64-Portable.zip)
- Intel Mac: [CodexBridge-macOS-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-x64-Portable.zip)

本指南适用于从源码运行的开发者。Win 用户和 Mac 用户请下载免安装包：

[CodexBridge-Windows-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Portable.zip)

## Requirements / 环境要求

- Windows 10/11
- Node.js 22.15.0 or newer
- Codex Desktop
- API keys for the providers you want to use

- Windows 10/11
- Node.js 22.15.0 或更高版本
- Codex Desktop
- 你想使用的 provider API Key

## 1. Prepare Config / 准备配置

Developer source setup:

源码开发配置：

```powershell
cd F:\game_code\router
Copy-Item .\config\router.config.example.json .\config\router.config.json
notepad .\config\router.config.json
```

Use `router.config.example.json` when every model should use API keys.

所有模型都走 API Key 时，使用 `router.config.example.json`。

Use `router.config.hybrid.example.json` when GPT should use Codex/OpenAI authentication and third-party models should use their own API keys:

如果希望 GPT 使用 Codex/OpenAI 认证，而第三方模型使用各自 API Key，使用 `router.config.hybrid.example.json`：

```powershell
Copy-Item .\config\router.config.hybrid.example.json .\config\router.config.json
```

Edit model names, base URLs, and enabled providers for your own account.

根据你的账号情况修改模型名、base URL 和启用的 provider。

## 2. Set API Keys / 设置 API Key

Temporary environment variables for the current PowerShell window:

只在当前 PowerShell 窗口生效的临时环境变量：

```powershell
$env:OPENAI_API_KEY = "your-openai-api-key"
$env:DEEPSEEK_API_KEY = "your-deepseek-api-key"
$env:MOONSHOT_API_KEY = "your-kimi-api-key"
```

Persistent user environment variables:

永久写入当前 Windows 用户环境变量：

```powershell
setx OPENAI_API_KEY "your-openai-api-key"
setx DEEPSEEK_API_KEY "your-deepseek-api-key"
setx MOONSHOT_API_KEY "your-kimi-api-key"
```

After using `setx`, open a new PowerShell window.

使用 `setx` 后，需要重新打开一个 PowerShell 窗口。

## 3. Generate Catalog / 生成模型目录

```powershell
npm run catalog
```

This creates `model-catalog.json`.

这会生成 `model-catalog.json`。

## 4. Start Router / 启动路由

```powershell
npm start
```

The desktop app starts Router after refreshing the router config, Codex config, and model catalog. Win users and Mac users should use the desktop app instead of running these commands manually.

桌面应用启动 Router 前会自动刷新路由配置、Codex 配置和模型目录。Win 用户和 Mac 用户建议直接使用桌面应用，不要手动跑这些命令。

Default local endpoint:

默认本地地址：

```text
http://127.0.0.1:15722
```

## 5. Configure Codex / 配置 Codex

Edit:

编辑：

```text
%USERPROFILE%\.codex\config.toml
```

Example. The desktop app writes this automatically:

示例。桌面应用会自动写入：

```toml
model_provider = "openai"
model = "gpt-5.5"
model_catalog_json = "F:/game_code/router/model-catalog.json"
model_reasoning_effort = "medium"
disable_response_storage = false
network_access = "enabled"
openai_base_url = "http://127.0.0.1:15722/v1"
windows_wsl_setup_acknowledged = true
```

Rules:

规则：

- `model_catalog_json` must point to your real `model-catalog.json` path.
- `openai_base_url` must point to the local CodexBridge Router.
- Do not add `[model_providers.codex-bridge]`, `experimental_bearer_token`, or `requires_openai_auth`.
- Restart Codex Desktop after changing the catalog path.

- `model_catalog_json` 必须指向你电脑里的真实 `model-catalog.json` 路径。
- `openai_base_url` 必须指向本地 CodexBridge Router。
- 不要再添加 `[model_providers.codex-bridge]`、`experimental_bearer_token` 或 `requires_openai_auth`。
- 修改模型目录路径后，需要重启 Codex Desktop。

## 6. Verify / 验证

```powershell
curl.exe http://127.0.0.1:15722/health
curl.exe http://127.0.0.1:15722/v1/models
curl.exe http://127.0.0.1:15722/model-catalog.json
```

PowerShell note:

PowerShell 注意：

- Use `curl.exe`, not `curl`.
- `curl` is usually an alias for `Invoke-WebRequest`.

- 使用 `curl.exe`，不要直接用 `curl`。
- `curl` 在 PowerShell 里通常是 `Invoke-WebRequest` 的别名。

## Troubleshooting / 常见问题

### Codex does not show models / Codex 没显示模型

- Confirm `model_catalog_json` path is correct.
- Restart Codex Desktop.
- Open `http://127.0.0.1:15722/model-catalog.json` and confirm it returns JSON.

- 确认 `model_catalog_json` 路径正确。
- 重启 Codex Desktop。
- 打开 `http://127.0.0.1:15722/model-catalog.json`，确认能返回 JSON。

### Provider returns 401 / provider 返回 401

- Check the API key.
- Check whether the provider requires a different base URL.
- Test the same key with a lightweight request.

- 检查 API Key。
- 检查 provider 是否要求不同的 base URL。
- 用同一个 key 做一次轻量请求测试。

### Provider returns 429 / provider 返回 429

- The account is rate limited.
- Reduce parallel requests.
- Wait and retry.

- 账号被限速。
- 降低并发请求。
- 等一会儿再试。

### Codex shows 502 / Codex 显示 502

Open the CodexBridge log page first.

先打开 CodexBridge 的日志页。

- No `access POST /v1/responses`: Codex did not reach Router. Start Router again from CodexBridge, then restart Codex.
- Has `access POST /v1/responses`: the request reached Router. Read the next `req_... -> upstream` and `req_... !! upstream` lines to see the real provider, model, proxy, status, and upstream message.
- All models fail with 502 and there is no access log: usually stale Codex config or a Windows proxy/VPN intercepting local traffic. Current releases write `http://127.0.0.1:15722/v1` when Router starts.
- `Missing API key ... Set MOONSHOT_API_KEY`: save the Kimi / Moonshot key in the API Key page. The visible Codex slot can be `gpt-5.2` even when the real upstream model is Kimi.

- 没有 `access POST /v1/responses`：Codex 没有打到 Router。请从 CodexBridge 重新启动 Router，然后重启 Codex。
- 有 `access POST /v1/responses`：请求已经进 Router。继续看后面的 `req_... -> upstream` 和 `req_... !! upstream`，确认真实 provider、真实模型、代理、状态码和上游错误。
- 所有模型都 502 且没有 access 日志：通常是 Codex 配置仍是旧的，或 Windows 代理/VPN 接管了本地流量。当前版本启动 Router 时会写入 `http://127.0.0.1:15722/v1`。
- `Missing API key ... Set MOONSHOT_API_KEY`：去“密钥”页保存 Kimi / Moonshot 的 Key。Codex 里显示的槽位可能是 `gpt-5.2`，但真实上游模型是 Kimi。
