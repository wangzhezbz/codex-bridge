# Router 整改记录 100：抽取 Responses 工具续跑计数边界

## 整改目标

本轮从 `src/upstream.js` 提取 Responses 工具结果续跑的纯数据计数逻辑，降低主文件中工具协议判断、历史元数据累计与请求执行之间的混杂。

本轮只移动：

- Responses 输入的数组归一化；
- 连续工具输出的续跑分组计数；
- 当前分组数与历史 `toolContinuationTurns` 的累计。

工具执行、工具调用签名、无进展循环保护、最大续跑限制、请求发送、历史写入均保留原位。本轮不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态定义、导入和调用面搜索替代：

- `chatToolContinuationTurns` 只在 chat-completions 转 Responses 的生产路径累计续跑轮次；
- `responseToolOutputContinuationGroups` 同时服务历史累计和无进展循环保护；
- `responseInputItems` 还被工具协议输入识别、工具调用签名和工具结果签名复用，因此作为无状态基础函数一并导出；
- 新模块只依赖既有 `isResponseToolOutputItem` 类型判断，不导入 upstream、网络、路由、SSE、日志或响应发送模块；
- 上游中无外部调用的兼容辅助函数本轮保留，避免把删除无关代码混入纯重构；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

## TDD 证据

先新增 `tests/responses-tool-continuation.test.js`：

```powershell
node --test tests/responses-tool-continuation.test.js
```

实现前结果为 `0/4` 通过、`4/4` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/responses-tool-continuation.js` 尚不存在。

完成最小实现并切换生产调用后，直接测试为 `4/4` 通过，分别验证：

- 空值、标量和数组输入的归一化契约；
- 相邻工具输出折叠为一组、被普通输入分隔后重新计组；
- 当前工具输出分组与正数历史轮次正确累计；
- 当前请求没有工具输出时直接返回 `0`，且不读取历史。

## 模块边界

新增 `src/responses-tool-continuation.js`，公开导出：

- `responseInputItems`
- `responseToolOutputContinuationGroups`
- `chatToolContinuationTurns`

拆分后：

- `src/responses-tool-continuation.js` 为 37 行；
- `src/upstream.js` 从上一批的 4315 行降至 4284 行；
- `tests/responses-tool-continuation.test.js` 为 83 行；
- 原三个函数定义已从 `src/upstream.js` 移除，所有既有调用继续使用同名导入。

## 验证结果

- 续跑计数红测：实现前 `0/4` 通过、`4/4` 按预期失败；
- 续跑计数绿测：`4/4`；
- 续跑计数、上下文切换、历史持久化、上游代理和服务端联合回归：`225/225`；
- `npm run check:syntax`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`631/631`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 生产依赖审计：`0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `107.6` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`。

smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning，两项均未导致失败。本轮没有修改 npm Registry 或代理配置。

## 主要修改文件

- `src/responses-tool-continuation.js`
- `src/upstream.js`
- `tests/responses-tool-continuation.test.js`
- `package.json`

## 后续边界

1. 最大续跑限制和无进展循环终止逻辑继续留在 `src/upstream.js`，避免把路由配置和工具签名状态扩散进纯计数模块。
2. 工具输入、调用签名和结果签名现在共享同一个输入归一化出口。
3. 下一批应重新扫描剩余纯数据函数，优先选择不依赖请求生命周期、网络响应或历史写入的边界。
