# Router 整改记录 91：拆分 Responses 流终端状态分类

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，只提取 Responses 流的终端事件分类与非成功终端透传判断：

- 识别 `[DONE]`；
- 识别 `response.completed`、`response.failed`、`response.incomplete` 和 `response.cancelled`；
- 保持 SSE `event:` 字段优先、JSON payload `type` 仅作回退的既有顺序；
- 仅当终端事件与合法 Responses 对象的失败状态一致时透传非成功终端；
- 保持状态比较对大小写不敏感。

本轮不修改 SSE 分帧、流读取、事件缓冲、终端文本缓冲、字节上限、错误事件构造、历史写入或网络生命周期，不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态调用面搜索替代：

- `responsesTerminalKind` 只有两个生产调用点，分别位于普通 Responses 流与强制聚合 Responses 流的终端处理路径；
- `isPassThroughNonSuccessTerminal` 只紧随上述两个分类调用点使用；
- 新模块复用 `src/sse.js` 的 `parseSseEvents`、`src/json.js` 的 `tryParseJson` 和 `src/responses-object.js` 的 `isResponsesObject`，没有复制底层解析或对象识别逻辑；
- `src/upstream.js` 继续拥有何时读取、何时终止、如何发送错误、如何持久化历史的全部编排权；
- 新模块不导入 HTTP、网络、history、配置、路由、代理或日志模块；
- 新模块及直接测试已接入 `check:syntax` 和 `test:router`。

## TDD 证据

先新增 `tests/responses-stream-status.test.js`，直接导入计划中的独立模块：

```powershell
node --test tests/responses-stream-status.test.js
```

实现前结果为 `0/4` 通过、`4/4` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/responses-stream-status.js` 尚不存在。

完成最小实现并切换生产调用后，直接测试为 `4/4` 通过，分别验证：

- `[DONE]` 与四类命名终端事件；
- JSON payload `type` 回退；
- `event:` 字段优先于冲突的 payload `type`；
- 无效 JSON、非终端事件和空输入被忽略；
- failed、incomplete、cancelled 仅在 Responses 对象状态匹配时透传；
- completed、状态不匹配和不完整对象不进入非成功透传。

## 模块边界

新增 `src/responses-stream-status.js`，导出：

- `responsesTerminalKind`
- `isPassThroughNonSuccessTerminal`

拆分后：

- `src/responses-stream-status.js` 为 39 行；
- `src/upstream.js` 从上一批的 4689 行降至 4660 行；
- 两个旧函数没有在 `src/upstream.js` 中残留第二份定义。

## 验证结果

- 状态分类红测：实现前 `0/4` 通过、`4/4` 按预期失败；
- 状态分类绿测：`4/4`；
- 状态分类、Responses 对象、SSE、上游代理、历史持久化和服务端联合回归：`223/223`；
- `npm run check`：退出码 `0`；
- Router 子套件：`596/596`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `102.1` 秒；
- `git diff --check`：通过。

Electron smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning；两项没有导致 smoke 失败，也不属于本轮状态分类拆分范围。本轮计时包装没有保留 smoke 的标准输出摘要，因此不将上一批资源计数冒充为本轮实测值。

## 主要修改文件

- `src/responses-stream-status.js`
- `src/upstream.js`
- `tests/responses-stream-status.test.js`
- `package.json`

## 后续边界

1. SSE 分帧和 JSON payload 解析继续由 `src/sse.js` 负责，状态模块只负责分类。
2. 事件缓冲、终端文本缓冲、字节上限与网络读取继续留在 `src/upstream.js`，如需拆分应作为独立批次并覆盖跨 chunk 分隔符与超限错误。
3. 如果未来要改变终端优先级或新增状态，应作为协议契约变更处理，先增加冲突事件测试。
4. 每次相关重构继续验证完整与截断 SSE、Sol/Terra、历史写入、Anthropic 鉴权和普通 API-key 路由。
