# Router 整改记录 86：拆分上游 URL 回退策略

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，只提取 OpenAI 兼容上游地址的 `/v1` 回退策略：

- 根 Base URL 的 Chat Completions 地址可回退到 `/v1/chat/completions`；
- 根 Base URL 的 Responses 地址可回退到 `/v1/responses`；
- 只有预期的非 JSON HTML 错误才触发 Chat JSON 请求回退；
- 流式请求通过 `Content-Type: text/html` 判断门户页或错误页；
- 已包含 `/v1` 或完整端点的 Base URL 不产生二次回退；
- 构造回退地址时清除原 Base URL 的查询参数和片段。

本轮不修改首次请求地址、回退调用顺序、重试次数、代理配置或错误文案，不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态调用面搜索替代：

- URL 回退策略的生产调用全部位于 `src/upstream.js`；
- Responses 代理、Chat 流式代理和 Chat JSON 请求分别调用同一组回退函数；
- `UpstreamHttpError` 通过工厂参数注入新模块，避免新模块反向导入 `src/upstream.js`；
- `joinUpstreamUrl` 继续使用现有配置模块实现，没有重新实现 URL 拼接；
- 现有服务器测试覆盖根地址 HTML 回退和完整端点禁止回退；
- 新模块及直接测试已接入 `check:syntax` 和 `test:router`。

## TDD 证据

先新增 `tests/upstream-url-fallback.test.js`，直接导入计划中的独立模块：

```powershell
node --test tests/upstream-url-fallback.test.js
```

实现前结果为 `4/4` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/upstream-url-fallback.js` 尚不存在。

最小实现后直接测试为 `4/4` 通过，分别验证：

- 根地址可以生成 Chat 与 Responses 的 `/v1` 回退地址；
- 已版本化地址和完整端点不会生成根地址回退；
- Chat JSON 回退只接受 502 非 JSON HTML 错误；
- HTML 响应检测只读取 Content-Type，不消费响应正文。

## 模块边界

新增 `src/upstream-url-fallback.js`，导出 `createUpstreamUrlFallbackPolicy`。工厂返回：

- `chatCompletionsRootFallbackUrl`
- `chatCompletionsV1FallbackUrl`
- `responsesV1FallbackUrl`
- `upstreamResponseLooksHtml`

模块内部持有根路径判断、`/v1` Base URL 构造和非 JSON HTML 错误识别。`src/upstream.js` 继续负责首次请求、日志、代理选择和是否执行第二次网络请求。

拆分后：

- `src/upstream-url-fallback.js` 为 77 行；
- `src/upstream.js` 从上一批的 4947 行降至 4887 行；
- 旧 URL 回退函数没有在 `src/upstream.js` 中残留第二份副本。

## 验证结果

- URL 回退策略红测：实现前 `4/4` 按预期失败；
- URL 回退策略绿测：`4/4`；
- URL 策略、服务器、上游代理和路由健康定向测试：`191/191`；
- `npm run check`：通过；
- Router 子套件：`575/575`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `94.7` 秒；
- smoke 资源摘要：`28/2/3/46/3/0/2`。

Electron smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning；两项没有导致 smoke 失败，也不属于本轮 URL 回退策略拆分范围。

## 主要修改文件

- `src/upstream-url-fallback.js`
- `src/upstream.js`
- `tests/upstream-url-fallback.test.js`
- `package.json`

## 后续边界

1. 首次端点生成仍由 `joinOpenAiEndpointUrl` 和路由 Base URL 负责，不应与回退策略混合迁移。
2. 新增供应商特殊回退规则时，应单独建立 URL 行为测试，禁止根据普通 4xx 或 JSON 错误盲目重试。
3. 下一批可评估 usage 归一化或历史元数据纯函数，持久化写入和网络编排仍应分离。
4. 每次相关重构继续验证根 URL、完整端点、Sol/Terra Responses SSE、Anthropic 鉴权和普通 API-key 路由。
