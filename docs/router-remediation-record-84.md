# Router 整改记录 84：拆分上游请求头策略

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，只提取上游请求头构造与响应头过滤职责：

- 为普通 API-key 路由生成 Bearer 鉴权头；
- 为 Anthropic Messages 路由生成 `x-api-key` 和协议版本头；
- 为 Codex/OpenAI 订阅路由使用请求作用域内的 bearer token；
- 按既有白名单透传 Codex 运行时元数据；
- 阻止自定义头覆盖鉴权、协议版本和逐跳传输头；
- 从上游响应中移除不应转发的编码、长度和连接头。

本轮不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换、代理回退、用户凭据来源或协议转换。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态调用面搜索替代：

- `upstreamHeaders` 和 `filteredHeaders` 的生产调用全部位于 `src/upstream.js`；
- `responsesBaseUrlForRoute` 是独立的公共 URL 契约，继续留在 `src/upstream.js`；
- `headerValue` 同时服务 Codex 请求头透传和 `UpstreamHttpError.retryAfter` 读取，因此作为新模块的显式接口保留；
- 现有上游代理测试继续覆盖 Anthropic 密钥隔离、Codex 头透传、Retry-After、Sol 模型保持和 API-key 路由；
- 新模块及直接测试已接入 `check:syntax` 和 `test:router`。

## TDD 证据

先新增 `tests/upstream-header-policy.test.js`，直接导入计划中的独立模块：

```powershell
node --test tests/upstream-header-policy.test.js
```

实现前结果为 `3/3` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/upstream-header-policy.js` 尚不存在。

最小实现后直接测试为 `3/3` 通过，分别验证：

- Anthropic 自定义头不能替换可信 `x-api-key` 和协议版本；
- Codex 运行时元数据可以透传，但客户端和路由自带的鉴权头不能覆盖可信 bearer token；
- 上游响应中的编码、长度和逐跳连接头不会转发给客户端。

## 回归中发现并修复的依赖遗漏

首次运行完整定向回归时，错误路径稳定出现：

```text
ReferenceError: headerValue is not defined
    at new UpstreamHttpError (.../src/upstream.js:135:5)
```

根因是原私有 `headerValue` 不只用于 Codex 头透传，还被 `UpstreamHttpError` 用于读取上游 `Retry-After`。初次迁移只移动了函数，没有更新这个调用者。

最小修复是从新模块显式导出 `headerValue`，并在 `src/upstream.js` 中导入。没有复制实现，也没有修改 Retry-After 解析行为。修复后同一组鉴权、代理、服务端、适配器与路由健康测试为 `237/237`。

## 模块边界

新增 `src/upstream-header-policy.js`，导出：

- `upstreamHeaders`
- `filteredHeaders`
- `headerValue`

模块内部持有 Codex 精确透传头、前缀白名单和禁止覆盖集合。`src/upstream.js` 保留请求编排、错误类和公共 URL 选择，只导入上述策略函数。

拆分后：

- `src/upstream-header-policy.js` 为 176 行；
- `src/upstream.js` 从上一批的 5194 行降至 5021 行；
- 旧请求头策略没有在 `src/upstream.js` 中残留第二份副本。

## 验证结果

- 请求头策略红测：实现前 `3/3` 按预期失败；
- 请求头策略绿测：`3/3`；
- 鉴权、代理、服务端、适配器和路由健康定向测试：`237/237`；
- `npm run check`：通过；
- Router 子套件：`567/567`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `101.6` 秒；
- smoke 资源摘要：`28/2/3/46/3/0/2`。

Electron smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning；两项没有导致 smoke 失败，也不属于本轮请求头策略拆分范围。

## 主要修改文件

- `src/upstream-header-policy.js`
- `src/upstream.js`
- `tests/upstream-header-policy.test.js`
- `package.json`

## 后续边界

1. 下一批继续选择 `src/upstream.js` 内部职责完整的纯策略区域，避免一次移动请求编排、流处理和协议转换。
2. `responsesBaseUrlForRoute` 涉及 Codex/OpenAI 公共地址替换，应继续与头策略分离，除非单独建立 URL 契约测试后再迁移。
3. 请求头白名单或黑名单如需调整，应单独立项并新增安全行为测试，不应与结构拆分混合。
4. 每次相关重构继续验证 Anthropic 密钥隔离、Codex 头透传、Retry-After、Sol/Terra Responses SSE 和普通 API-key 路由。
