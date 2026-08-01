# Router 整改记录 88：拆分历史 Turn 元数据构造

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，只提取历史 turn 的纯对象构造逻辑：

- 根据响应 ID、消息和调用方元数据构造原子 history turn；
- 始终使用当前请求的 `previous_response_id` 生成 `parentResponseId`；
- 始终根据当前 route 重新生成安全 route snapshot；
- 畸形旧路由无法生成完整可信快照时，保留原有最小快照降级行为；
- 没有响应 ID 时返回 `null`，不触发持久化。

本轮不移动或修改 `recordTurn`、`record`、`recordResponse` 的持久化调用，不修改历史存储异常包装、route trace、网络编排或响应输出，不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态调用面搜索替代：

- `recordHistoryTurn` 的生产调用全部位于 `src/upstream.js`；
- 历史 turn 对象原先在 `recordHistoryTurn` 内部构造，然后进入原子 `recordTurn` 或兼容旧式双写分支；
- route snapshot 继续复用 `src/route-snapshot.js` 的 `createRouteSnapshot`；
- context policy 继续使用 `contextPolicyForRoute` 和 adapter profile 的 context window fallback；
- 新模块不导入 history store、SQLite、HTTP、日志或 route trace；
- 新模块及直接测试已接入 `check:syntax` 和 `test:router`。

## TDD 证据

先新增 `tests/upstream-history-metadata.test.js`，直接导入计划中的独立模块：

```powershell
node --test tests/upstream-history-metadata.test.js
```

实现前结果为 `0/3` 通过、`3/3` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/upstream-history-metadata.js` 尚不存在。

完成最小实现并切换生产调用后，直接测试为 `3/3` 通过，分别验证：

- 当前 parent 和 route snapshot 会覆盖调用方传入的陈旧值；
- route snapshot 不持久化 API key，且保留凭据来源标记；
- 畸形旧路由降级为 `id/api/model` 最小快照；
- 缺少响应 ID 时不构造 history turn。

## 模块边界

新增 `src/upstream-history-metadata.js`，导出：

- `buildHistoryTurn`
- `routeSnapshotForHistory`

`src/upstream.js` 继续负责：

- 判断是否存在 history store；
- 调用 `recordTurn`；
- 兼容旧 store 的 `record` 与 `recordResponse`；
- 捕获并转换本地历史存储错误；
- 决定何时记录 Responses、Chat、compact 或本地 fallback 响应。

拆分后：

- `src/upstream-history-metadata.js` 为 42 行；
- `src/upstream.js` 从上一批的 4806 行降至 4785 行；
- 旧的 `routeSnapshotForHistory` 没有在 `src/upstream.js` 中残留第二份副本。

## 验证结果

- 历史元数据红测：实现前 `0/3` 通过、`3/3` 按预期失败；
- 历史元数据绿测：`3/3`；
- 历史持久化、跨模型上下文、route snapshot、服务端和上游代理联合回归：`254/254`；
- `npm run check`：通过；
- Router 子套件：`583/583`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `72.3` 秒；
- smoke 资源摘要：`28/2/3/46/3/0/2`。

Electron smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning；两项没有导致 smoke 失败，也不属于本轮历史元数据纯逻辑拆分范围。

## 主要修改文件

- `src/upstream-history-metadata.js`
- `src/upstream.js`
- `tests/upstream-history-metadata.test.js`
- `package.json`

## 后续边界

1. 历史 store 调用和存储异常转换继续留在 `src/upstream.js`，除非后续有独立的持久化事务设计与故障测试。
2. route snapshot 字段或 context policy 契约发生变化时，应同时验证正常快照和畸形旧路由降级路径。
3. 下一批可评估 Responses 对象识别与归一化纯函数；SSE 缓冲、网络读取和 history 写入仍应保持分离。
4. 每次相关重构继续验证重启恢复、跨模型压缩、Sol/Terra Responses SSE、Anthropic 鉴权和普通 API-key 路由。
