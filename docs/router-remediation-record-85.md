# Router 整改记录 85：拆分图片拒绝重试策略

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，只提取 Chat Completions 图片输入被上游拒绝后的纯策略职责：

- 判断失败是否属于允许去图重试的 400、415 或 422；
- 识别 `image_url`、`input_image` 及其他图片类型内容；
- 将图片内容替换为稳定文本占位；
- 对请求正文和历史消息生成去图副本；
- 保证原始请求对象不被修改。

本轮不迁移本地兜底响应写入、历史持久化、SSE/JSON 输出或重试编排，不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换、代理回退或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态调用面搜索替代：

- 图片策略只有 `proxyChatCompletions` 一个生产调用入口；
- `sendLocalImageRejectedResponse` 和 `localImageRejectedChat` 仍留在 `src/upstream.js`，继续负责本地响应、文案和历史写入；
- `isRateLimitError` 继续独立存在，429 不进入图片重试策略；
- `UpstreamHttpError` 通过工厂参数注入新模块，避免新模块反向导入 `src/upstream.js` 形成循环依赖；
- 现有服务器集成测试继续覆盖去图重试成功、去图重试失败隔离、流式失败隔离和后续会话历史；
- 新模块及直接测试已接入 `check:syntax` 和 `test:router`。

## TDD 证据

先新增 `tests/upstream-image-retry-policy.test.js`，直接导入计划中的独立模块：

```powershell
node --test tests/upstream-image-retry-policy.test.js
```

实现前结果为 `4/4` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/upstream-image-retry-policy.js` 尚不存在。

最小实现后直接测试为 `4/4` 通过，分别验证：

- 带图片的 415 `unsupported media` 错误允许去图重试；
- 429、无关的 400 和不含图片的请求不会进入去图重试；
- 多种图片内容都会变成固定文本占位，文本内容保持原样；
- 去图处理不会修改调用方持有的原始请求对象。

## 模块边界

新增 `src/upstream-image-retry-policy.js`，导出：

- `createUpstreamImageRetryPolicy`
- `chatBodyWithoutImages`
- `chatMessagesWithoutImages`

工厂返回 `shouldRetryChatWithoutImages`。模块内部持有图片识别、内容替换和固定占位文本；`src/upstream.js` 只负责调用策略、执行第二次上游请求，以及在第二次请求失败时生成本地隔离响应。

拆分后：

- `src/upstream-image-retry-policy.js` 为 88 行；
- `src/upstream.js` 从上一批的 5021 行降至 4947 行；
- 旧图片识别和去图策略没有在 `src/upstream.js` 中残留第二份副本。

## 验证结果

- 图片重试策略红测：实现前 `4/4` 按预期失败；
- 图片重试策略绿测：`4/4`；
- 图片策略、服务器、上游代理和路由健康定向测试：`191/191`；
- `npm run check`：通过；
- Router 子套件：`571/571`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `90.7` 秒；
- smoke 资源摘要：`28/2/3/46/3/0/2`。

Electron smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning；两项没有导致 smoke 失败，也不属于本轮图片重试策略拆分范围。

## 主要修改文件

- `src/upstream-image-retry-policy.js`
- `src/upstream.js`
- `tests/upstream-image-retry-policy.test.js`
- `package.json`

## 后续边界

1. `sendLocalImageRejectedResponse` 涉及历史写入和双协议响应，不应在没有独立响应契约测试的情况下与纯策略一起迁移。
2. 图片拒绝匹配正则如需扩展，应单独新增行为测试，避免把普通 400 错误错误地重试为去图请求。
3. 下一批可以评估响应历史记录或路由日志策略，但应先确认依赖注入边界，避免同时移动持久化和网络编排。
4. 每次相关重构继续验证图片失败隔离、Sol/Terra Responses SSE、Anthropic 密钥隔离和普通 API-key 路由。
