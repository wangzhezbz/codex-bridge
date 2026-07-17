# 整改记录 52：自定义火山方舟模型错误透传 reasoning 参数

日期：2026-07-18

## 用户反馈

- 用户在火山方舟供应商下添加自定义模型后，请求返回 HTTP 400。
- 方舟明确提示 `reasoning is not supported by current model`。
- 报错中显示的 `kimi-k2.7-code` 是用户配置的真实上游模型名，不代表 Router 自动切换到了 Kimi 供应商。

## 根因

1. 桌面端生成的路由已经包含正确的 `provider=volcengine` 和 `providerFamily=doubao`。
2. 适配器归类时，`custom=true` 的优先级错误地高于显式 `providerFamily`，把已归属火山方舟的自定义模型重新归类成通用 `custom`。
3. 通用自定义适配器按兼容性原则透传 Codex 的 `reasoning`、`reasoning_effort` 和 `thinking` 参数；火山方舟当前模型不支持顶层 `reasoning`，因此拒绝请求。
4. 从全局自定义入口填写方舟 Base URL 时，路由生成阶段也没有根据 `ark.cn-*.volces.com` 识别火山方舟适配器。

## 修复

- 显式 `providerFamily` 现在优先于 `custom` 标记，已归属供应商的自定义模型继承该供应商适配器。
- 只有真实供应商族仍为 `custom` 的模型才启用通用自定义参数透传。
- 全局自定义模型使用 `ark.cn-*` 或 `volces.com` Base URL 时，自动归类为 `doubao` / `chat-doubao`。
- 火山方舟自定义 Chat Completions 路由会移除当前模型不支持的 `reasoning`、`reasoning_effort` 和 `thinking` 参数，不影响请求模型、消息、工具和其他普通参数。

## 安全边界

- 不修改自动选模、失败切换、备用模型或用户当前模型选择。
- 不改变真正未知的 OpenAI-compatible 自定义供应商；它们仍保留原有通用透传行为。
- 不改变 GPT Responses、DeepSeek、Kimi、Qwen、OpenRouter、SiliconFlow 等已有供应商的 reasoning 适配规则。
- 不改写用户已有模型配置；下次生成 Router 配置时即可应用正确适配器。

## 回归验证

- 新增“供应商内自定义方舟模型继承 Doubao 适配器”失败用例。
- 新增“全局自定义方舟 Base URL 自动识别”失败用例。
- 新增“方舟自定义模型请求体不包含不支持的 reasoning 参数”失败用例。
- 修复前 3 项用例均按预期失败；修复后全部通过。
- Adapter、转换与路由保真专项 162 项通过，通用自定义参数透传测试保持通过。
