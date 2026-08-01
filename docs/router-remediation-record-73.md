# Router 整改记录 73：Anthropic Claude、xAI Grok、Google Gemini 三供应商接入

## 整改范围

本轮新增三个彼此独立的 API 供应商：

- Anthropic Claude
- xAI Grok
- Google Gemini

Anthropic 接入使用独立 API Key 和原生 Messages API，不复用 Claude Pro / Max 或 Claude Code 的订阅登录态。xAI 与 Gemini 使用各自官方的 OpenAI-compatible API。

## 根因

原供应商与路由协议只覆盖 OpenAI Responses 和 Chat Completions。Anthropic Messages 的请求路径、鉴权头、消息结构、工具调用和流式事件均不同，不能仅更换 Base URL 后按 OpenAI-compatible 协议发送。

## 修复内容

1. 新增 Anthropic、xAI、Gemini 供应商预设、API Key、Base URL 和首批模型目录。
2. Anthropic 请求使用 `/v1/messages`、`x-api-key` 和 `anthropic-version`。
3. 新增 OpenAI Chat Completions 与 Anthropic Messages 的双向结构转换，覆盖系统消息、图片、工具调用、工具结果、停止原因和用量。
4. Anthropic 原生响应转换为 Codex 当前可消费的兼容流，保持现有 Responses 路由入口不变。
5. xAI Grok 与 Google Gemini 保持 OpenAI-compatible 调用，不引入额外转换。
6. 供应商连接测试与模型刷新使用各自正确的鉴权头。
7. 配置导入、运行时校验和适配器诊断增加新协议与新供应商身份。
8. Anthropic 协议身份优先于 Base URL 推断；即使使用本地中转地址，也不会误退回 OpenAI-compatible。

## 失败测试证据

- Anthropic 流式请求最初错误发往 `/v1/chat/completions`，失败测试要求改为 `/v1/messages`。
- Anthropic 适配器最初被识别为 `chat_completions` 与 `openai-compatible`，失败测试要求独立的 `anthropic_messages` / `messages-anthropic`。
- xAI 最初被归入普通 OpenAI-compatible，失败测试要求保留 `xai` 供应商身份。
- Anthropic 使用本地中转 Base URL 时最初被错误降级，失败测试锁定“协议字段优先”的判断规则。

## 稳定边界

本轮未修改：

- GPT 订阅路由及其历史作用域
- Kimi 与 Kimi Code 的供应商边界
- 豆包 / 火山方舟的参数兼容逻辑
- 自动选模型、失败切换和本地限流开关
- 双倍额度服务

## 验证

- 新增协议转换、供应商目录、鉴权、适配器及上游请求测试。
- 项目检查脚本覆盖新增 `src/anthropic-messages.js` 及对应测试。
- 定向回归：`441/441` 通过，`0` 失败。
- 完整回归：`1448/1448` 通过，`0` 失败。

## 外部验证边界

自动化测试使用本地模拟上游验证请求路径、请求头、请求体和响应转换。本轮没有使用真实用户 API Key 发起计费请求；具体模型可用性仍受供应商账号权限、地区和配额影响。
