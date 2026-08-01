# Router 整改记录 83：拆分上游错误呈现层

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，只提取上游错误的最终呈现职责：

- 将内部错误映射为稳定的 HTTP 状态码与 OpenAI 风格 JSON 错误；
- 在 Responses 流已经开始时输出 `response.failed` SSE；
- 保留请求体过大、响应体过大、网络失败、超时和流中断的既有错误码；
- 保留 HTML 错误页标题提取、重试建议和敏感查询参数脱敏；
- 保留 `sendUpstreamError`、`upstreamBodyMessage`、`upstreamErrorInfo` 的调用契约。

本轮不改写任何用户可见错误文案，不修改 Responses、Chat Completions 或 Anthropic 协议转换，不修改 Sol、Terra、Luna 路由，不修改智能路由、自动切换、代理回退顺序或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此本轮使用静态调用面搜索替代：

- 错误类仍定义在 `src/upstream.js`，由新模块工厂注入，避免形成循环依赖；
- `sendUpstreamError` 仍由 `src/upstream.js` 原名导出，外部调用方不需要修改；
- `upstreamBodyMessage` 和 `upstreamErrorInfo` 仍供上游请求与响应处理流程内部使用；
- 原有上游代理、响应守卫、请求生命周期和路由健康测试继续覆盖真实调用链；
- 新模块及其直接测试已经接入 `check:syntax` 和 `test:router`。

## TDD 证据

先新增 `tests/upstream-error-presentation.test.js`，直接导入计划中的独立模块：

```powershell
node --test tests/upstream-error-presentation.test.js
```

实现前结果为 `1` 项失败，错误是预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/upstream-error-presentation.js` 尚不存在。

实现后结果为 `1/1` 通过。测试使用真实的 `UpstreamResponseTooLargeError` 和最小响应收集器，验证：

- HTTP 状态码保持为 `502`；
- 错误码保持为 `upstream_response_too_large`；
- 上游 URL 查询参数中的敏感值不会进入响应正文。

## 模块边界

新增 `src/upstream-error-presentation.js`，导出 `createUpstreamErrorPresentation`。工厂接收四类上游错误构造器并返回：

- `sendUpstreamError`
- `upstreamBodyMessage`
- `upstreamErrorInfo`

`src/upstream.js` 保留错误类、请求编排和公共导出，只负责装配新模块，不再维护 HTTP/SSE 错误呈现分支。

拆分后：

- `src/upstream-error-presentation.js` 为 395 行；
- `src/upstream.js` 为 5194 行；
- 原错误呈现实现没有在 `src/upstream.js` 中残留第二份副本。

## 验证结果

- 错误呈现红测：实现前 `1` 项按预期失败；
- 错误呈现绿测：`1/1`；
- 错误呈现、请求生命周期、响应守卫、上游代理和路由健康定向测试：`51/51`；
- `npm run check`：通过；
- Router 与桌面主测试：`892/892`；
- 历史恢复测试：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `106.7` 秒；
- smoke 资源摘要：`28/2/3/46/3/0/2`。

Electron smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning；两项没有导致 smoke 失败，也不属于本轮错误呈现层拆分范围。

## 主要修改文件

- `src/upstream-error-presentation.js`
- `src/upstream.js`
- `tests/upstream-error-presentation.test.js`
- `package.json`

## 后续边界

1. 后续继续缩小 `src/upstream.js` 时，应优先选择职责完整、调用面可单独锁定的区域，避免同时迁移协议转换与代理编排。
2. 用户可见错误文案如需调整，应单独立项并建立精确快照或契约测试，不应与结构拆分混在同一批。
3. Responses 流错误仍需持续覆盖“响应头已发送”和“尚未发送”两类分支，防止 JSON 与 SSE 输出混用。
4. 每次拆分继续验证 Sol/Terra Responses SSE、普通 API-key 路由、代理流式首包刷新和客户端取消。
