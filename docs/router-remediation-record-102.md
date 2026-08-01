# Router 整改记录 102：抽取 Responses 工具签名边界

## 整改目标

本轮从 `src/upstream.js` 提取工具调用与工具结果签名的纯数据逻辑，降低主文件中协议归一化、历史比较和无进展循环策略之间的混杂。

本轮移动：

- Responses 与 chat 工具调用签名生成；
- 最新连续工具调用分组提取；
- 最新及上一组工具结果签名提取；
- 超长签名文本的 SHA-256 有界压缩。

历史元数据读取、重复比较、无进展轮次累计、最大续跑限制和本地循环终止响应均保留在 `src/upstream.js`。本轮不修改工具执行、请求发送、历史写入、路由、默认模型、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态定义、导入和调用面搜索替代：

- 四个工具签名入口的生产调用者全部位于 `src/upstream.js`；
- 调用结果用于保存本轮签名、回退读取输入内签名以及判断重复工具循环；
- 工具结果 JSON 继续使用上一批抽取的稳定序列化模块；
- 输入分组继续使用 `responses-tool-continuation.js` 的共享输入归一化；
- 2000 字符有界签名同时被用户输入签名复用，因此作为公开基础函数迁入新模块并由 upstream 导入；
- 历史对象、route、request 生命周期、网络、SSE 和日志均未进入新模块；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

## TDD 证据

先新增 `tests/responses-tool-signatures.test.js`：

```powershell
node --test tests/responses-tool-signatures.test.js
```

实现前结果为 `0/4` 通过、`4/4` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/responses-tool-signatures.js` 尚不存在。

完成最小实现并切换生产调用后，直接测试为 `4/4` 通过，分别验证：

- Responses 与 chat 两种工具调用结构生成相同类型的可比较签名；
- 只返回最后一个连续工具调用分组，并按签名排序；
- 工具结果正确区分最新分组与上一分组，结构化结果使用稳定 JSON；
- 2000 字符原样保留，超过 2000 字符后输出长度和固定 SHA-256 摘要。

## 模块边界

新增 `src/responses-tool-signatures.js`，公开导出：

- `latestToolCallSignaturesFromInput`
- `responseToolCallSignatures`
- `latestToolResultSignaturesFromInput`
- `previousToolResultSignaturesFromInput`
- `boundedSignatureText`

拆分后：

- `src/responses-tool-signatures.js` 为 122 行；
- `src/upstream.js` 从 4272 行降至 4163 行；
- `tests/responses-tool-signatures.test.js` 为 94 行；
- 原工具签名函数家族及有界文本函数已从 `src/upstream.js` 移除；
- `upstream.js` 继续负责签名与历史元数据的比较策略。

## 验证结果

- 工具签名红测：实现前 `0/4` 通过、`4/4` 按预期失败；
- 工具签名绿测：`4/4`；
- 签名、续跑、稳定序列化、上下文切换、历史持久化、上游代理和服务端联合回归：`232/232`；
- `npm run check:syntax`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`638/638`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 生产依赖审计：`0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `76.9` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`。

本次动态资源发现恢复了 apps 和 skills，说明上一批 `28/0/3/0/3/0/2` 是运行时发现波动，不是资源代码被删除。smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning，两项均未导致失败。

## 主要修改文件

- `src/responses-tool-signatures.js`
- `src/upstream.js`
- `tests/responses-tool-signatures.test.js`
- `package.json`

## 后续边界

1. 重复工具调用判断和无进展轮次累计继续留在 upstream，避免把历史访问和 route 策略扩散进纯签名模块。
2. 用户输入签名仍复用 `boundedSignatureText`，其输出契约未改变。
3. 下一批可评估工具循环策略函数是否能以显式历史元数据输入形成纯策略模块；若仍需要 history 对象，则应继续留在主文件。
