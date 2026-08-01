# Router 整改记录 75：GPT-5.6 Sol 非标准流终止处理

## 现场现象

- GPT-5.6 Sol 请求收到 HTTP 200 和 `response.created` 后，未继续收到
  `response.completed` 或 `[DONE]`。
- CodexBridge 将这类响应报告为普通 HTTP 502，Codex 随后连续重连 5 次。
- 同一环境手动切换 GPT-5.6 Terra 后可以正常完成。

## 根因

本次问题包含两个层次：

1. Sol 上游在部分请求中只返回了 Responses SSE 的创建事件，随后提前结束；
   这不是一个完整的 Responses 结果。
2. Router 原先只根据上游 `Content-Type` 判断是否为 SSE。当上游正文实际是
   SSE、但响应头缺失或错误时，Router 会把它当作普通 JSON 响应处理，并抛出
   “HTTP 200 without a completed response”的通用 502。这会掩盖真实的流截断，
   并触发客户端重复重连。

## 修复内容

- 在请求明确要求流式响应时，同时检查响应正文是否符合 SSE 结构。
- 对正文为 SSE、响应头错误的完整流，按 SSE 原样透传。
- 对只收到 `response.created`、没有任何终止事件的流：
  - 保留已经收到的上游事件；
  - 补发标准 `response.failed` 和 `[DONE]`；
  - 使用 `upstream_stream_truncated` 诊断码结束请求；
  - 不再伪装成普通 HTTP 502，也不让 Codex继续无意义地重连 5 次。
- 日志仅记录路由、原始 Content-Type、终止类型和字节数，不记录响应正文、
  Token 或用户内容。

## 明确不变的行为

- 不把 GPT-5.6 Sol 自动切换为 Terra。
- 不修改订阅模式默认模型或推荐模型。
- 不开启自动选模型或失败自动切换。
- 不改变 DeepSeek、Kimi、豆包、自定义模型和普通非流式请求。
- 上游没有返回模型内容时，Router 不伪造回答。

## 修改文件

- `src/upstream.js`
- `tests/upstream-proxy.test.js`

## 验证结果

- 修复前新增失败测试可以稳定复现：
  - HTTP 200
  - 错误 `Content-Type`
  - 正文只有 `response.created`
  - Router 抛出通用 `UpstreamHttpError`
- 修复后非标准 Responses SSE 定向测试：`2/2` 通过。
- 上游代理完整回归：`34/34` 通过。
- 适配器、显式模型选择、路由健康和智能路由回归：`94/94` 通过。
- 本轮相关测试合计：`128/128` 通过。
- `git diff --check` 通过。

## 剩余外部边界

如果 Sol 上游仍只返回 `response.created` 后断流，CodexBridge 无法生成上游没有
提供的模型内容。本次修复保证客户端收到明确且可终止的失败事件，并避免错误
分类和重连风暴；Sol 上游是否恢复完整输出仍取决于对应账号、节点和服务端状态。
