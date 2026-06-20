# CodexBridge

Local multi-model gateway and desktop manager for Codex.

Codex 多模型本地网关与桌面管理器。

CodexBridge lets Codex use GPT, DeepSeek, Kimi, and more OpenAI-compatible models from one local provider and one model picker.

CodexBridge 让 Codex 在一个本地 provider 和一个模型栏里同时使用 GPT、DeepSeek、Kimi 以及更多 OpenAI-compatible 模型。

## Status / 当前状态

This repository currently contains the working headless router core. The desktop manager is the next milestone.

当前仓库已经包含可工作的无界面路由核心。桌面管理器是下一阶段目标。

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

Codex Desktop can connect to a custom local provider, but users still need a practical way to mix multiple upstream providers in one model picker.

CodexBridge acts as a local bridge:

```text
Codex Desktop -> CodexBridge -> GPT / DeepSeek / Kimi / other models
```

Codex Desktop 可以连接自定义本地 provider，但普通用户很难把多家模型同时放进一个模型栏里稳定使用。

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

Codex config uses a local router token:

Codex 配置使用本地 router token：

```toml
[model_providers.codex-bridge]
name = "CodexBridge"
base_url = "http://127.0.0.1:15722/v1"
wire_api = "responses"
experimental_bearer_token = "sk-local-codex-router"
```

### Hybrid / 混合模式

GPT models can use the Codex/OpenAI authentication that Codex sends to the local provider, while DeepSeek, Kimi, and other third-party models keep using their own API keys.

GPT 模型可以使用 Codex 传给本地 provider 的 Codex/OpenAI 认证；DeepSeek、Kimi 和其他第三方模型继续使用各自 API Key。

Use:

使用：

```text
config/router.config.hybrid.example.json
```

Codex config uses OpenAI authentication:

Codex 配置使用 OpenAI 认证：

```toml
[model_providers.codex-bridge]
name = "CodexBridge"
base_url = "http://127.0.0.1:15722/v1"
wire_api = "responses"
requires_openai_auth = true
```

Hybrid mode is implemented in the router core, but real ChatGPT subscription billing must be verified on a signed-in Codex account because unit tests cannot create a ChatGPT subscription bearer token.

混合模式的路由底座已经实现，但真实 ChatGPT 订阅额度需要在已登录的 Codex 账号上实测，因为单元测试不能生成 ChatGPT 订阅 bearer token。

## Quick Start / 快速开始

Developer preview requires Node.js 20 or newer.

当前开发预览版需要 Node.js 20 或更高版本。

### Desktop manager / 桌面管理器

On Windows, double-click:

Windows 下可以直接双击：

```text
Start-CodexBridge.cmd
```

The first launch installs desktop dependencies if needed, then opens the CodexBridge window. In the window, choose a billing mode, fill API keys, generate the model catalog, apply Codex config, and start the router.

第一次启动会自动安装桌面依赖，然后打开 CodexBridge 窗口。你可以在窗口里选择计费模式、填写 API Key、生成模型目录、写入 Codex 配置并启动 router。

For development, you can also run:

开发时也可以运行：

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
$env:FENNO_API_KEY = "your-gpt-api-key"
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

Example:

示例：

```toml
model_provider = "codex-bridge"
model = "gpt-5.5"
model_catalog_json = "C:/path/to/codex-bridge/model-catalog.json"
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

`experimental_bearer_token` must match `authToken` in `config/router.config.json`.

`experimental_bearer_token` 必须和 `config/router.config.json` 里的 `authToken` 一致。

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

## Safety / 安全说明

- Do not commit `config/router.config.json`.
- Do not commit `.env` files or API keys.
- Keep API keys in environment variables for the headless preview.
- The future desktop manager will store secrets locally with Windows-native protection.

- 不要提交 `config/router.config.json`。
- 不要提交 `.env` 文件或 API Key。
- 当前无界面预览版建议把 API Key 放在环境变量里。
- 未来桌面管理器会用 Windows 本地安全能力保存密钥。

## Roadmap / 路线图

- Desktop app with setup wizard.
- Provider and API key management.
- Large preset model/provider library.
- One-click Codex config apply and rollback.
- Usage dashboard with real upstream model and token records.
- Live logs and diagnostics export.
- Windows installer with no manual Node.js setup.

- 桌面应用和新手配置向导。
- Provider 与 API Key 管理。
- 更丰富的预设模型和 provider 库。
- 一键写入 Codex 配置和一键回滚。
- 展示真实上游模型和 token 记录的用量面板。
- 实时日志和诊断导出。
- Windows 安装包，不再要求用户手动安装 Node.js。

## License / 许可证

MIT
