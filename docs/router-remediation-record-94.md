# Router 整改记录 94：拆分 Responses 流协议识别与强制聚合策略

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，只提取 Responses 上游响应的三项纯策略判断：

- 根据 `Content-Type` 判断响应是否为 `text/event-stream`；
- 根据请求、上游载荷和路由契约判断是否需要把订阅 Responses 流强制聚合为非流式响应；
- 根据响应文本的行首标记判断内容是否具有 SSE 形状。

本轮不移动网络读取、SSE 分块、终端事件解析、历史写入、错误文案或响应发送逻辑，不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态调用面搜索替代：

- 三个策略函数原先都只在 `src/upstream.js` 内定义；
- `responseUsesEventStream` 另有一份等价私有实现存在于 `src/upstream-request-lifecycle.js`；
- 新模块只依赖既有 `authModeForRoute` 配置判断，不导入网络、history、代理、日志或响应发送模块；
- `src/upstream.js` 与 `src/upstream-request-lifecycle.js` 现在共享同一份内容类型判断；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

## TDD 证据

先新增 `tests/responses-stream-policy.test.js`，直接导入计划中的独立模块：

```powershell
node --test tests/responses-stream-policy.test.js
```

实现前结果为 `0/6` 通过、`6/6` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/responses-stream-policy.js` 尚不存在。

完成最小实现并切换生产调用后，直接测试为 `6/6` 通过，分别验证：

- SSE 内容类型大小写不敏感，并接受带参数的 `Content-Type`；
- 缺失或非 SSE 内容类型不会误判；
- 只有非流式客户端、Responses API、`codex_openai` 订阅鉴权和上游真实流式载荷的组合会触发强制聚合；
- 客户端流式请求、上游非流式载荷、Chat API 和 API-key 路由都不会触发强制聚合；
- 行首 `data:`、行首 `event:` 和换行后的 SSE 标记可被识别；
- 空文本、普通 JSON 和行内出现的 `data:` 字样不会被误判为 SSE。

## 模块边界

新增 `src/responses-stream-policy.js`，导出：

- `responseUsesEventStream`
- `shouldAggregateForcedResponsesStream`
- `looksLikeSseResponse`

拆分后：

- `src/responses-stream-policy.js` 为 25 行；
- `src/upstream-request-lifecycle.js` 为 127 行，并删除了等价的私有内容类型判断；
- `src/upstream.js` 从上一批的 4561 行降至 4548 行；
- 三个策略函数在生产代码中各自只保留一份定义。

## 验证结果

- 协议策略红测：实现前 `0/6` 通过、`6/6` 按预期失败；
- 协议策略绿测：`6/6`；
- 协议策略与请求生命周期联合回归：`7/7`；
- 策略、SSE 分块、终端状态、文本缓冲、上游代理、历史持久化和服务端联合回归：`233/233`；
- `npm run check:syntax`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`610/610`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `157.7` 秒；
- smoke 资源摘要：`28/2/3/46/3/0/2`；
- `git diff --check`：通过。

Electron smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning；两项没有导致 smoke 失败，也不属于本轮纯策略拆分范围。

## 主要修改文件

- `src/responses-stream-policy.js`
- `src/upstream.js`
- `src/upstream-request-lifecycle.js`
- `tests/responses-stream-policy.test.js`
- `package.json`

## 后续边界

1. 新模块只负责同步、无副作用的协议与聚合判断，不读取响应体、不写入历史、不发送客户端响应。
2. SSE 分块、终端状态和文本缓冲继续分别由既有独立模块负责。
3. 网络读取、历史保存、错误发送与本地回放决策继续留在 `src/upstream.js`。
4. 下一批可评估提取 `responsesStreamFailureMessage` 或局部历史判断，但必须继续覆盖完整与截断 SSE、Sol/Terra、Anthropic 鉴权和普通 API-key 路由。
