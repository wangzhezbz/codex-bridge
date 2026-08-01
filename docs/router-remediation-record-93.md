# Router 整改记录 93：拆分 Responses 终端文本缓冲与诊断尾部

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，只提取 Responses 流的终端文本缓冲与诊断尾部裁剪：

- 按追加顺序保存终端 SSE 文本；
- 使用 UTF-8 字节数执行终端文本上限检查；
- 保持生产默认 48 MiB 终端缓冲上限；
- 超限时继续返回状态码 `503`、错误码 `local_history_storage_unavailable` 和 `localHistoryError=true`；
- 超限追加不污染已经保存的终端文本；
- 诊断文本继续只保留最后 2,000,000 个 JavaScript 字符单元。

本轮不修改 SSE 分块、终端事件分类、网络读取、错误事件构造、历史写入或响应发送，不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态调用面搜索替代：

- `createTextBuffer`、`appendTerminalText` 和 `textBufferValue` 只有一个生产调用链；
- `appendDiagnosticTail` 只在同一条原生 Responses 流调用链的非终端 block 路径使用；
- SSE block 是否属于终端、何时写客户端、何时读取历史仍由 `src/upstream.js` 决定；
- 新模块不导入 HTTP、网络、history、配置、路由、代理或日志模块；
- 新模块及直接测试已接入 `check:syntax` 和 `test:router`。

## TDD 证据

先新增 `tests/responses-stream-text.test.js`，直接导入计划中的独立模块：

```powershell
node --test tests/responses-stream-text.test.js
```

实现前结果为 `0/4` 通过、`4/4` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/responses-stream-text.js` 尚不存在。

完成最小实现并切换生产调用后，直接测试为 `4/4` 通过，分别验证：

- 终端文本保持追加顺序；
- 中文 UTF-8 多字节内容按字节计算，精确达到上限允许通过；
- 超限错误保留既有 503 元数据，且失败追加不污染状态；
- 诊断文本未超限时完整保留；
- 诊断文本超限时只裁掉最旧字符。

## 模块边界

新增 `src/responses-stream-text.js`，导出：

- `createTextBuffer`
- `appendTerminalText`
- `textBufferValue`
- `appendDiagnosticTail`

生产调用不传选项，因此继续使用 48 MiB 与 2,000,000 字符默认值。`maxBytes` 和 `maxChars` 选项用于小内存边界测试，不改变生产默认值。

拆分后：

- `src/responses-stream-text.js` 为 42 行；
- `src/upstream.js` 从上一批的 4588 行降至 4561 行；
- 五个旧的文本缓冲、错误构造和诊断裁剪函数没有在 `src/upstream.js` 中残留第二份定义。

## 验证结果

- 终端文本缓冲红测：实现前 `0/4` 通过、`4/4` 按预期失败；
- 终端文本缓冲绿测：`4/4`；
- 文本缓冲、SSE 分块、终端状态、上游代理、历史持久化和服务端联合回归：`226/226`；
- `npm run check`：退出码 `0`；
- Router 子套件：`604/604`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `109.9` 秒；
- smoke 资源摘要：`28/2/3/46/3/0/2`；
- `git diff --check`：通过。

Electron smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning；两项没有导致 smoke 失败，也不属于本轮文本缓冲拆分范围。

## 主要修改文件

- `src/responses-stream-text.js`
- `src/upstream.js`
- `tests/responses-stream-text.test.js`
- `package.json`

## 后续边界

1. `src/responses-stream-text.js` 只负责字符串累加、上限与裁剪，不判断终端事件。
2. SSE 分块和终端状态继续分别由 `src/responses-sse-blocks.js` 与 `src/responses-stream-status.js` 负责。
3. 网络读取、响应写入、历史保存及错误发送继续留在 `src/upstream.js`。
4. 下一批可评估 Responses 流内容类型识别与强制聚合策略纯函数；每次仍需覆盖完整与截断 SSE、Sol/Terra、Anthropic 鉴权和普通 API-key 路由。
