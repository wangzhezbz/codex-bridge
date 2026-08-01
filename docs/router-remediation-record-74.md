# Router 整改记录 74：Claude / Grok / Gemini 接入加固

## 整改目标

在三家供应商已经进入模型目录的基础上，继续修复真实请求链路中的协议兼容与安全边界，避免出现“界面可配置、实际调用不完整”的假接入。

本轮只处理：

- Anthropic Claude 原生 Messages API 的请求、响应和流式事件
- Claude 工具调用中签名思考块的连续性
- 供应商认证头和协议头的保护
- xAI Grok、Google Gemini 独立供应商边界的回归验证

本轮不修改：

- GPT-5.6 Sol、Terra、Luna 的现有模型选择和推荐方式
- 自动选模型、失败自动切换、本地限流或重复请求保护
- DeepSeek、Kimi、Kimi Code、豆包及既有自定义模型的路由规则
- 双倍额度服务

## 根因

1. Anthropic 虽然已经有独立供应商和模型配置，但直接聊天流式请求仍被强制改为非流式请求，再由 CodexBridge 合成 OpenAI SSE，无法完整保留 Anthropic 原生事件语义。
2. Chat Completions 与 Anthropic Messages 互转时，`stream`、`thinking`、`metadata`、`service_tier` 等请求选项没有全部进入最终请求。
3. Anthropic 的 `thinking`、`redacted_thinking` 和 `signature` 未被完整保存到下一轮工具调用上下文，长工具链可能被上游拒绝。
4. 路由自定义 Header 可以覆盖 `Authorization`、`x-api-key` 和 `anthropic-version`，存在鉴权串线和协议降级风险。

## 修复内容

1. Anthropic 直接聊天请求固定使用原生 `/v1/messages`。
2. Anthropic 鉴权固定使用 `x-api-key`，协议版本固定使用可信的 `anthropic-version`，不再发送 Bearer 鉴权。
3. 流式调用向上游发送 `stream: true`，逐事件翻译：
   - `message_start`
   - `content_block_start`
   - `text_delta`
   - `thinking_delta`
   - `signature_delta`
   - `input_json_delta`
   - `message_delta`
   - `message_stop`
   - `error`
4. 请求转换保留 Anthropic 支持的 `thinking`、`metadata`、`service_tier` 和流式参数。
5. 响应转换保留签名思考块，并在下一轮工具调用前按原顺序恢复，避免破坏 Anthropic 的工具连续性校验。
6. 禁止路由自定义 Header 覆盖供应商鉴权头、Anthropic 协议头和 hop-by-hop Header；普通安全自定义 Header 仍保留。
7. xAI Grok 与 Google Gemini 继续使用各自官方 OpenAI-compatible 入口，不复用 Anthropic 转换，也不相互复用 API Key。
8. 供应商名称保持为“Anthropic Claude”，不把 API 供应商误标为 Claude Code。

## 修改文件

- `src/anthropic-messages.js`
- `src/chat-to-responses.js`
- `src/upstream.js`
- `tests/anthropic-messages.test.js`
- `tests/upstream-proxy.test.js`

## 验证结果

- Anthropic 原生协议与上游代理定向测试：`36/36` 通过。
- Claude / Grok / Gemini 供应商边界定向测试：`5/5` 通过。
- 路由、桌面配置和既有供应商相关回归：`567/567` 通过。
- 项目全量自动化测试：`1451/1451` 通过，`0` 失败。

全量回归覆盖现有 GPT 订阅、GPT-5.6 Sol / Terra / Luna 显式选择、DeepSeek、Kimi、Kimi Code、豆包、自定义模型、配置保存、桌面启动项识别及路由生命周期。

## 外部验证边界

自动化测试使用本地模拟上游验证 URL、Header、请求体、原生 SSE、工具调用和错误处理。本轮没有使用用户真实 API Key 发起计费请求；账号权限、地区、配额和供应商实际开放模型仍需在测试机使用各自账号验证。
