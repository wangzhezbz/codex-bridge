# Router 整改记录 87：拆分上游用量归一化

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，只提取与供应商无关的用量读取和归一化纯逻辑：

- 从 Responses SSE 终止事件读取 usage；
- 从普通响应对象的 `usage`、`response.usage`、`data.usage`、`result.usage` 中按原优先级取值；
- 兼容 snake_case、camelCase、Chat Completions、Responses 以及常见缓存 token 字段；
- 统一生成 prompt、fresh prompt、cache read、cache creation、cache miss、completion 和 total token；
- 供应商未返回 total 时，继续按 prompt 与 completion 求和；
- 供应商明确返回正数 cache miss 时，继续优先使用该值，否则按 prompt 减 cache read 推导 fresh prompt。

本轮不修改用量日志、route trace、回调通知、历史记录、持久化或网络编排，不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态调用面搜索替代：

- 用量读取和归一化的生产调用均位于 `src/upstream.js`；
- SSE 解码继续复用 `src/sse.js` 的 `extractUsageFromSse`，没有复制协议解析；
- `logUsage`、`notifyUpstreamUsage`、route trace 和历史记录仍留在 `src/upstream.js`；
- 新模块不导入网络、配置、历史或持久化模块，保持纯计算边界；
- 新模块及其直接测试已接入 `check:syntax` 和 `test:router`。

## TDD 证据

先新增 `tests/upstream-usage.test.js`，直接导入计划中的独立模块：

```powershell
node --test tests/upstream-usage.test.js
```

实现前结果为 `0/5` 通过、`5/5` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/upstream-usage.js` 尚不存在。

完成最小实现并切换生产调用后，直接测试为 `5/5` 通过，分别验证：

- 顶层 usage 对象优先于嵌套候选；
- Responses input/output/cached token 正确归一化；
- 明确的 cache miss 优先于推导值，同时保留 cache creation；
- camelCase 字段兼容及 total fallback；
- 从 completed Responses SSE 事件提取 usage。

## 模块边界

新增 `src/upstream-usage.js`，导出：

- `extractResponsesUsage`
- `extractUsageObject`
- `normalizeUsage`

模块内部只保留数值字段择优函数 `tokenNumber`。`src/upstream.js` 继续负责何时记录用量、如何关联路由和请求、如何通知预算守卫，以及网络成功或失败后的控制流。

拆分后：

- `src/upstream-usage.js` 为 86 行；
- `src/upstream.js` 从上一批的 4887 行降至 4806 行；
- 旧的四个用量函数没有在 `src/upstream.js` 中残留第二份副本。

## 验证结果

- 用量模块红测：实现前 `0/5` 通过、`5/5` 按预期失败；
- 用量模块绿测：`5/5`；
- 用量、上游代理、服务端、桌面用量和预算守卫定向测试：`210/210`；
- `npm run check`：通过；
- Router 子套件：`580/580`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `87.2` 秒；
- smoke 资源摘要：`28/2/3/46/3/0/2`。

Electron smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning；两项没有导致 smoke 失败，也不属于本轮用量纯逻辑拆分范围。

## 主要修改文件

- `src/upstream-usage.js`
- `src/upstream.js`
- `tests/upstream-usage.test.js`
- `package.json`

## 后续边界

1. 用量持久化、预算判断、历史元数据和通知回调仍应与纯归一化逻辑分离。
2. 后续增加新的供应商 usage 字段时，应先补独立归一化测试，避免改变既有字段优先级。
3. cache miss 为零时的含义需保持当前兼容行为；如果未来要区分“明确为零”和“字段缺失”，应作为单独契约变更处理。
4. 下一批可评估历史元数据纯函数，但持久化写入、route trace 和网络编排应继续留在现有边界。
5. 每次相关重构继续验证根 URL、完整端点、Sol/Terra Responses SSE、Anthropic 鉴权和普通 API-key 路由。
