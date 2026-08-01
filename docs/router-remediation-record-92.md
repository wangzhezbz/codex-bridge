# Router 整改记录 92：拆分 Responses SSE 分块累加器

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，只提取 Responses SSE 的字节级分块累加逻辑：

- 按 LF、CRLF 和裸 CR 空行分隔符输出完整 SSE block；
- 保留跨 chunk 的分隔符尾部；
- 在完整 block 出现前按 Buffer 累加，避免 UTF-8 多字节字符跨 chunk 时被错误解码；
- 流结束时返回未完成尾部并清空状态；
- 保持生产默认 48 MiB 单事件上限；
- 超限时继续返回状态码 `503`、错误码 `local_history_storage_unavailable` 和 `localHistoryError=true`。

本轮不修改终端事件分类、终端文本缓冲、网络读取、错误事件构造、历史写入或响应发送，不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态调用面搜索替代：

- `createSseBlockAccumulator`、`takeCompleteSseBlocks` 和 `finishSseBlockAccumulator` 只有一个生产调用链；
- 该调用链位于原生 Responses 流代理中，网络 reader 产出的 chunk 仍先转成 Buffer，再交给累加器；
- 完整 block 返回后，是否进入终端缓冲、是否直接写给客户端的判断仍留在 `src/upstream.js`；
- 新模块不导入 HTTP、网络、history、配置、路由、代理或日志模块；
- 新模块及直接测试已接入 `check:syntax` 和 `test:router`。

## TDD 证据

先新增 `tests/responses-sse-blocks.test.js`，直接导入计划中的独立模块：

```powershell
node --test tests/responses-sse-blocks.test.js
```

实现前结果为 `0/4` 通过、`4/4` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/responses-sse-blocks.js` 尚不存在。

完成最小实现并切换生产调用后，直接测试为 `4/4` 通过，分别验证：

- LF 分隔完整 block，并保留与 flush 未完成尾部；
- CRLF 和裸 CR 分隔符可以跨多个 chunk；
- UTF-8 中文字符在多字节中间切块后仍能无损还原；
- 精确达到字节上限允许通过，超过一个字节即抛出原有 503 错误契约。

## 模块边界

新增 `src/responses-sse-blocks.js`，导出：

- `createSseBlockAccumulator`
- `takeCompleteSseBlocks`
- `finishSseBlockAccumulator`

生产调用不传选项，因此继续使用 48 MiB 默认值。`maxBytes` 选项用于对边界进行小内存直接测试，不改变生产默认值。

拆分后：

- `src/responses-sse-blocks.js` 为 83 行；
- `src/upstream.js` 从上一批的 4660 行降至 4588 行；
- 六个旧的累加器内部函数没有在 `src/upstream.js` 中残留第二份定义。

## 验证结果

- SSE 分块累加器红测：实现前 `0/4` 通过、`4/4` 按预期失败；
- SSE 分块累加器绿测：`4/4`；
- 分块累加器、终端状态、SSE、上游代理、历史持久化和服务端联合回归：`222/222`；
- `npm run check`：退出码 `0`；
- Router 子套件：`600/600`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `93.1` 秒；
- smoke 资源摘要：`28/2/3/46/3/0/2`；
- `git diff --check`：通过。

Electron smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning；两项没有导致 smoke 失败，也不属于本轮 SSE 分块拆分范围。

## 主要修改文件

- `src/responses-sse-blocks.js`
- `src/upstream.js`
- `tests/responses-sse-blocks.test.js`
- `package.json`

## 后续边界

1. `src/responses-sse-blocks.js` 只识别 SSE block 边界，不解析事件内容或状态。
2. 终端状态分类继续由 `src/responses-stream-status.js` 负责。
3. 终端文本缓冲、诊断尾部、网络读取和响应发送仍留在 `src/upstream.js`，如需拆分应作为独立批次并覆盖 UTF-8 字节上限与错误元数据。
4. 每次相关重构继续验证完整与截断 SSE、跨 chunk CRLF、Sol/Terra、历史写入、Anthropic 鉴权和普通 API-key 路由。
