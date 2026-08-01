# Router 整改记录 82：拆分上游请求生命周期

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，只提取上游请求生命周期职责：

- 计算普通上游请求总超时；
- 计算流式代理首包超时；
- 合并调用方、客户端和本地超时的 `AbortSignal`；
- 在客户端断开或本地超时时映射稳定错误类型；
- SSE 响应开始后清理首包阶段的请求计时器。

本轮不修改 Responses、Chat Completions 或 Anthropic 协议转换，不修改 Sol、Terra、Luna 路由，不修改智能路由、自动切换、代理回退顺序或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库仍没有 `.gitnexus` 索引，系统没有可用的 `gitnexus` 命令，因此使用静态调用面搜索替代：

- `streamingProxyFetchOptions` 由 `fetchUpstream` 调用，同时是现有公开导出；
- 请求生命周期只由 `fetchAndTrackRateLimit` 创建；
- 生命周期错误映射发生在 fetch 失败和响应体 reader 失败两个位置；
- `upstreamTimeoutMs` 同时服务于公开配置契约和生命周期实现；
- 原有上游代理测试覆盖代理 dispatcher 刷新、流式首包超时、客户端取消和 Responses 流错误。

## TDD 证据

先新增 `tests/upstream-request-lifecycle.test.js`，直接验证独立生命周期模块：

```powershell
node --test tests/upstream-request-lifecycle.test.js
```

实现前结果为 `1` 项失败，原因是计划中的 `src/upstream-request-lifecycle.js` 尚不存在。

实现后结果为 `1/1` 通过。测试使用真实计时器与 `AbortSignal`，验证：

- 配置的 10 毫秒截止时间会终止请求 signal；
- 生命周期将终止原因映射为 `UpstreamTimeoutError`；
- 错误码保持 `upstream_timeout`；
- 超时值保持为 10 毫秒；
- 上游 URL 查询参数不会进入错误消息。

## 模块边界

新增 `src/upstream-request-lifecycle.js`，提供：

- `createUpstreamRequestLifecycle`
- `streamingProxyFetchOptions`
- `upstreamTimeoutMs`

生命周期对象集中提供合并后的 `init.signal`、超时状态、客户端断开状态、`errorFor`、`responseStarted` 和幂等清理入口。

`src/upstream.js` 保留响应体包装和代理回退流程，只调用生命周期对象，不再自行维护计时器和 signal 监听器。既有 `streamingProxyFetchOptions`、`upstreamTimeoutMs` 仍由 `src/upstream.js` 原名重导出。

新模块和测试已接入 `check:syntax` 与 `test:router`。

## 验证结果

- 生命周期红测：实现前 `1` 项失败，原因符合预期；
- 生命周期绿测：`1/1`；
- 生命周期、响应守卫、上游代理与路由健康定向测试：`50/50`；
- `npm run check`：通过；
- Router 与桌面测试：`892/892`；
- 历史恢复测试：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`；
- smoke 资源摘要：`28/2/3/46/3/0/2`。

Electron smoke 仍输出 Node.js SQLite experimental warning 与 Electron `console-message` deprecated warning；两项没有导致 smoke 失败，也不属于本轮请求生命周期拆分范围。

## 主要修改文件

- `src/upstream-request-lifecycle.js`
- `src/upstream.js`
- `tests/upstream-request-lifecycle.test.js`
- `package.json`

## 后续边界

1. `src/upstream.js` 当前仍保留响应体 `ReadableStream` 包装；如果下一阶段迁移，必须同时覆盖 reader 取消、cleanup 幂等和客户端断开错误映射。
2. 错误响应文案和 HTTP/SSE 输出可以独立成下一候选模块，但不能同时改写文案与拆分结构。
3. 协议转换继续分开处理，不能把 Responses、Chat Completions 和 Anthropic 一次性搬迁。
4. 每次拆分继续验证代理流式首包刷新、Sol/Terra Responses SSE、普通 API-key 路由和客户端取消。
