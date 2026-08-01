# Router 整改记录 99：统一 Responses compact 请求构建策略

## 整改目标

本轮评估 Responses compact 上游请求执行、流式重试和本地 fallback 是否适合从 `src/upstream.js` 提取。静态依赖分析确认 `callResponsesCompactUpstream` 直接依赖：

- 主文件内的载荷过滤与路由追踪日志；
- 共享 fetch、超时、代理和响应体读取生命周期；
- `UpstreamHttpError` 错误类；
- Responses JSON/SSE 解析和图片结果补全。

这些依赖在主文件中有约 60 处引用。单独移动请求执行函数会引入循环依赖或迫使错误类、网络生命周期和解析链一起迁移，因此本轮不强拆该函数。

可独立提取的边界是 compact 请求构建策略：

- `codex_openai` 订阅路由必须使用 `stream: true`；
- 订阅路由必须省略 `max_output_tokens`；
- API-key 和缺省路由保持非流式并保留 compact 输出上限。

本轮不移动网络请求、流式重试、fallback、预算、历史、错误分类或响应发送逻辑，不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态定义、导入和调用面搜索替代：

- 原 `shouldStreamResponsesCompact` 和 `shouldOmitResponsesCompactMaxOutputTokens` 都只依赖 `authModeForRoute`；
- 两个判断只在上下文切换 compact 和 `/v1/responses/compact` 两条请求构建路径使用；
- 两个判断表达同一个订阅请求契约，适合合并为单一选项对象；
- 新模块不导入 upstream、网络、历史、SSE、日志、错误类或响应模块；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

## TDD 证据

先新增 `tests/responses-compact-request-policy.test.js`：

```powershell
node --test tests/responses-compact-request-policy.test.js
```

实现前结果为 `0/3` 通过、`3/3` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/responses-compact-request-policy.js` 尚不存在。

完成最小实现并切换生产调用后，直接测试为 `3/3` 通过，分别验证：

- 订阅 compact 请求启用流式并省略输出令牌上限；
- API-key compact 请求保持非流式并保留正整数输出令牌上限；
- 未声明订阅认证的路由默认采用 API-key 行为。

测试通过真实 `buildCompactResponsesRequest` 验证最终请求体，不只断言内部常量。

## 模块边界

新增 `src/responses-compact-request-policy.js`，公开导出：

- `responsesCompactRequestOptions`

拆分后：

- `src/responses-compact-request-policy.js` 为 9 行；
- `src/upstream.js` 从上一批的 4322 行降至 4315 行；
- `tests/responses-compact-request-policy.test.js` 为 48 行；
- 原两个重复判断函数已移除；
- 两处生产调用统一获取 `{ stream, omitMaxOutputTokens }`，请求执行和重试结构保持原位。

## 验证结果

- 请求策略红测：实现前 `0/3` 通过、`3/3` 按预期失败；
- 请求策略绿测：`3/3`；
- compact 策略、载荷规范化、上下文策略、上下文切换、路由保真、服务端和 Sol/Terra SSE 联合回归：`227/227`；
- `npm run check:syntax`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`627/627`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 审计首次因 npm Registry 在 TLS 建连前返回连接重置而无法得出结论；随后官方 Registry `PONG 703ms`，完全相同的在线审计返回 `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `107.1` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`；
- `git diff --check` 与 staged diff check：通过。

smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning，两项均未导致失败。本轮没有修改 npm Registry 或代理配置。

## 主要修改文件

- `src/responses-compact-request-policy.js`
- `src/upstream.js`
- `tests/responses-compact-request-policy.test.js`
- `package.json`

## 后续边界

1. `callResponsesCompactUpstream`、`isStreamRequiredError` 和 `compactFallbackReason` 继续留在主文件，避免错误类与网络生命周期发生循环依赖。
2. 订阅路由与 API-key 路由的 compact 请求体差异现在由单一策略出口管理。
3. 下一批应离开高耦合 compact 网络链，从剩余函数中重新选择只依赖纯数据或单一模块的边界。
