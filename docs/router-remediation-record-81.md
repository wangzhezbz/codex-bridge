# Router 整改记录 81：分阶段拆分上游响应守卫

## 整改目标

本轮开始拆分过大的 `src/upstream.js`，但只迁移已经稳定并有回归测试覆盖的一组职责：

- 上游响应正文总量限制；
- 流式响应正文空闲超时；
- 客户端断开后的取消处理；
- 下游写入背压与 drain 等待；
- 与上述边界对应的错误类型。

本轮不修改模型路由、协议转换、智能路由、失败回退、上游鉴权或用户密钥。

## 影响分析

GitNexus 重构流程要求先查询代码图，但当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令。因此本轮使用静态调用面搜索完成替代分析，并用原有集成测试反向验证：

- `readUpstreamText` 覆盖普通 JSON、Responses 非流式与错误正文；
- `readUpstreamBody` 覆盖 Responses、Chat Completions 与 Anthropic 流式正文；
- `writeResponseChunk` 覆盖 SSE 输出和直接流式透传；
- 三类错误仍由 `src/upstream.js` 使用并对外导出；
- `cancelUpstreamResponse` 仍服务于备用地址切换和超限响应清理。

## TDD 证据

先新增 `tests/upstream-response-guard.test.js`，直接从计划中的独立模块导入并验证路由级正文上限。

红测：

```powershell
node --test tests/upstream-response-guard.test.js
```

结果为 `1` 项失败，原因是 `src/upstream-response-guard.js` 尚不存在。

实现模块并迁移后重跑，结果为 `1/1` 通过。该测试同时验证：

- 超限响应抛出 `UpstreamResponseTooLargeError`；
- 错误码保持 `upstream_response_too_large`；
- 限制值和实际字节数保持准确；
- 上游 URL 查询参数不会进入错误消息。

## 模块边界

新增 `src/upstream-response-guard.js`，集中提供：

- `UpstreamTimeoutError`
- `UpstreamResponseTooLargeError`
- `ClientClosedRequestError`
- `readUpstreamText`
- `readUpstreamBody`
- `writeResponseChunk`
- `upstreamResponseLimitBytes`
- `upstreamResponseIdleTimeoutMs`
- 响应取消和客户端断开识别辅助函数

`src/upstream.js` 继续以原名称重导出既有公共错误类型和配置函数，因此已有导入方无需修改。新文件和测试已接入 `check:syntax` 与 `test:router`。

## 验证结果

- 新模块红测：实现前 `1` 项失败，原因符合预期；
- 新模块绿测：`1/1`；
- 上游响应、代理与路由健康定向测试：`49/49`；
- `npm run check`：通过；
- Router 与桌面测试：`892/892`；
- 历史恢复测试：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`；
- smoke 资源摘要：`28/0/3/0/3/0/2`。

第一次桌面 smoke 使用 124 秒外层时限时未返回。只读检查确认 smoke 内部资源首次渲染和主动刷新各允许等待 60 秒；不修改代码、不放宽内部断言，仅将同一命令的外层观察窗口扩大到 5 分钟后，命令在约 147 秒正常完成。

## 主要修改文件

- `src/upstream-response-guard.js`
- `src/upstream.js`
- `tests/upstream-response-guard.test.js`
- `package.json`

## 后续边界

1. 下一阶段仍应小步拆分，不要把 Responses、Chat Completions 和 Anthropic 协议转换一次性搬迁。
2. 可优先选择调用关系清晰、已有测试覆盖的错误呈现或请求生命周期辅助逻辑。
3. 每次拆分都必须保留 `src/upstream.js` 的既有公共导出，并单独验证 Sol、Terra、普通 API-key 模型和流式透传。
4. 桌面 smoke 的资源探测耗时受本机 Codex 资源读取影响，执行方应提供大于 2 分钟的外层观察窗口，但不能删除内部超时或跳过资源断言。
