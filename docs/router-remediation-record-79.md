# Router 整改记录 79：上游响应体积、停滞时间与流式背压边界

## 整改目标

本轮处理整体扫描中剩余的高优先级资源边界风险：

- 非流式 JSON、错误正文和兼容聚合路径不再无限读取上游响应。
- 流式响应在收到响应头后仍有正文空闲时间上限。
- Responses、OpenAI Chat 和 Anthropic Messages 流式转发尊重 Node.js 下游写入背压。
- 客户端断开或长期不读取时，主动取消上游正文，避免连接和内存长期占用。

本轮没有修改 Sol、Terra、Luna 的模型选择、推荐、自动切换、失败回退或用户保存的供应商凭据。

## 根因

1. 多条非流式路径直接调用 `Response.text()`，没有统一的字节上限。
2. SSE 收到响应头后会解除原请求总超时；如果上游保留连接但停止发送正文，读取可以无限等待。
3. 流式路径直接调用 `res.write()`，没有处理返回 `false` 的情况；慢客户端会让 Router 继续从上游读取并扩大本地缓冲。
4. 下游关闭或背压等待失败时，异步迭代器只释放 reader lock，没有保证取消上游正文。
5. 新增的本地“响应过大”错误如果只按 HTTP 502 分类，会退化成笼统的 `upstream_error`，丢失可诊断错误码。

## 修复内容

### 1. 统一响应读取器

`src/upstream.js` 的非流式与流式路径现在共用受控正文读取器：

- 默认总响应上限：`64 MiB`
- 默认连续无正文数据等待上限：`600000ms`
- 同时检查可信的 `Content-Length` 和实际累计字节数
- 超限错误：`upstream_response_too_large`
- 停滞错误：`upstream_timeout`

单路由可使用以下配置覆盖默认值：

```json
{
  "maxUpstreamResponseBytes": 67108864,
  "upstreamResponseIdleTimeoutMs": 600000
}
```

同时兼容蛇形命名：

- `max_upstream_response_bytes`
- `upstream_response_idle_timeout_ms`

### 2. 流式背压

所有主要流式写入统一通过背压等待器：

- `res.write()` 返回 `false` 后暂停读取下一块上游数据
- 收到 `drain` 后继续
- 客户端 `close`、写入 `error` 或请求取消时立即终止
- 默认最多等待 `600000ms`
- 提前退出时取消上游正文

这使慢客户端的速度可以真实传导到上游读取，而不是只在 Router 内存中堆积。

### 3. 错误分类

`src/route-health.js` 显式保留 `upstream_response_too_large`，避免其被 HTTP 502 的通用供应商错误覆盖。客户端会收到明确的本地响应安全上限提示。

## 测试驱动证据

修复前新增测试稳定复现：

- 超过路由字节上限的 JSON 被完整接受
- SSE 在响应头之后停滞时没有正文空闲超时
- 慢客户端写缓冲已满时，Router 仍立即写入下一块
- 背压长期不恢复时，上游正文没有被取消
- HTTP 502 分类覆盖了 `upstream_response_too_large`

修复后：

- `tests/upstream-proxy.test.js`：`40/40` 通过
- `tests/route-health.test.js` + `tests/upstream-proxy.test.js`：`48/48` 通过
- 项目完整 `npm run check`：通过
- 桌面测试：`892/892` 通过
- 历史恢复测试：`16/16` 通过
- 真实 Windows Electron smoke：退出码 `0`
- smoke 资源摘要：`28/2/3/46/3/0/2`
- `git diff --check`：通过
- 删除文件检查：无删除

## 主要修改文件

- `src/upstream.js`
- `src/route-health.js`
- `tests/upstream-proxy.test.js`

## 后续风险

1. 生产依赖漏洞仍需逐项确认兼容升级，不能直接批量升级。
2. `src/upstream.js` 体积仍然过大，后续应把响应读取、背压、Responses SSE 和协议适配拆成独立模块。
3. 默认 64 MiB / 600 秒是兼容性优先的安全上限；如果特定私有供应商确实需要更大响应，应只对该路由精确覆盖并保留测试。
