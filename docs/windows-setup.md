# Windows Setup / Windows 配置指南

This guide is for the current headless developer preview. The future desktop app will replace most of these manual steps.

本指南适用于当前无界面开发预览版。未来桌面应用会把大部分手动步骤变成图形化操作。

## Requirements / 环境要求

- Windows 10/11
- Node.js 20 or newer
- Codex Desktop
- API keys for the providers you want to use

- Windows 10/11
- Node.js 20 或更高版本
- Codex Desktop
- 你想使用的 provider API Key

## 1. Prepare Config / 准备配置

Recommended for most users:

大多数用户建议直接双击：

```text
Start-CodexBridge.cmd
```

Then use the desktop window to select mode, fill API keys, generate the catalog, apply Codex config, and start the router.

然后在桌面窗口里选择模式、填写 API Key、生成模型目录、写入 Codex 配置并启动 router。

Manual developer setup:

手动开发配置：

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
$env:FENNO_API_KEY = "your-gpt-api-key"
$env:DEEPSEEK_API_KEY = "your-deepseek-api-key"
$env:MOONSHOT_API_KEY = "your-kimi-api-key"
```

Persistent user environment variables:

永久写入当前 Windows 用户环境变量：

```powershell
setx FENNO_API_KEY "your-gpt-api-key"
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

Example:

示例：

```toml
model_provider = "codex-bridge"
model = "gpt-5.5"
model_catalog_json = "F:/game_code/router/model-catalog.json"
model_reasoning_effort = "medium"
disable_response_storage = true
network_access = "enabled"
windows_wsl_setup_acknowledged = true

[model_providers.codex-bridge]
name = "CodexBridge"
base_url = "http://127.0.0.1:15722/v1"
wire_api = "responses"
experimental_bearer_token = "sk-local-codex-router"
```

Hybrid mode example:

混合模式示例：

```toml
model_provider = "codex-bridge"
model = "gpt-5.5"
model_catalog_json = "F:/game_code/router/model-catalog.json"
model_reasoning_effort = "medium"
disable_response_storage = true
network_access = "enabled"
windows_wsl_setup_acknowledged = true

[model_providers.codex-bridge]
name = "CodexBridge"
base_url = "http://127.0.0.1:15722/v1"
wire_api = "responses"
requires_openai_auth = true
```

Rules:

规则：

- `model_catalog_json` must point to your real `model-catalog.json` path.
- `experimental_bearer_token` must match `authToken` in `config/router.config.json`.
- Hybrid mode uses `requires_openai_auth = true` instead of `experimental_bearer_token`.
- Restart Codex Desktop after changing the catalog path.

- `model_catalog_json` 必须指向你电脑里的真实 `model-catalog.json` 路径。
- `experimental_bearer_token` 必须和 `config/router.config.json` 里的 `authToken` 一致。
- 混合模式使用 `requires_openai_auth = true`，不要再写 `experimental_bearer_token`。
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
