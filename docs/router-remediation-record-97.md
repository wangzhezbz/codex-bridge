# Router 整改记录 97：拆分 Responses 历史载荷改写与输入转换

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`。原计划只提取 `inlineLocalHistoryForResponsesPayload`，但静态依赖分析确认它直接依赖同文件内的 Chat→Responses 输入转换函数，而该转换函数同时被上下文切换摘要复用。因此本轮按一个内聚边界共同提取：

- Responses 历史载荷改写；
- Chat 消息到 Responses 输入项的转换；
- 系统指令合并与去重；
- 助手工具调用和对应工具输出转换；
- 文本、自定义输入和图片输入转换。

本轮不修改是否内联历史的策略、不修改历史选择或持久化、不修改上下文预算、网络读取、SSE、响应发送、Sol、Terra、Luna 路由、默认模型、智能路由、自动切换、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态定义、导入和调用面搜索替代：

- `inlineLocalHistoryForResponsesPayload` 有两处生产调用，分别用于普通 Responses 本地历史内联和 compact 预算路径；
- `chatMessagesToResponsesInput` 除被载荷改写调用外，还被上下文切换摘要路径直接复用；
- 转换器的五个辅助函数只服务于这一转换族，没有其他外部调用；
- 新模块只依赖既有的 JSON 序列化和 Responses→Chat 内容取文本工具；
- 新模块不导入路由、网络、代理、SSE、日志、历史存储或响应发送模块；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

因此没有把载荷改写函数孤立抽出后再复制或反向依赖原文件，而是将完整转换族作为一个内聚模块迁移。

## TDD 证据

先新增 `tests/responses-history-payload.test.js`：

```powershell
node --test tests/responses-history-payload.test.js
```

实现前结果为 `0/4` 通过、`4/4` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/responses-history-payload.js` 尚不存在。

完成最小实现并切换生产调用后，直接测试为 `4/4` 通过，分别验证：

- 两条系统指令按顺序合并到既有 `instructions`，历史输入替换当前输入，同时删除 `messages` 和 `previous_response_id` 并保留其他元数据；
- 已存在于 `instructions` 的系统指令不会重复追加；
- 助手工具调用及匹配的工具结果会转换为 Responses `function_call` / `function_call_output`，缺少函数名的无效调用不会进入载荷；
- 混合文本、`custom` 输入和图片输入得到保留，图片 `detail` 不丢失。

## 模块边界

新增 `src/responses-history-payload.js`，公开导出：

- `inlineLocalHistoryForResponsesPayload`
- `chatMessagesToResponsesInput`

模块内部保留五个私有辅助函数：

- `chatMessageToResponsesInputItems`
- `responsesInputRole`
- `chatContentToResponsesContent`
- `chatPartToResponsesPart`
- `textPartForRole`

拆分后：

- `src/responses-history-payload.js` 为 151 行；
- `src/upstream.js` 从上一批的 4524 行降至 4375 行；
- `tests/responses-history-payload.test.js` 为 131 行；
- 七个函数定义均只存在于新模块，`src/upstream.js` 只保留导入和三处生产调用。

## 验证结果

- 载荷转换红测：实现前 `0/4` 通过、`4/4` 按预期失败；
- 载荷转换绿测：`4/4`；
- 载荷、历史策略、错误呈现、SSE、上游生命周期、代理、持久化和服务端联合回归：`245/245`；
- `npm run check:syntax`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`621/621`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `105.4` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`；
- `git diff --check`：通过。

smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning，两项均未导致失败。

## 主要修改文件

- `src/responses-history-payload.js`
- `src/upstream.js`
- `tests/responses-history-payload.test.js`
- `package.json`

## 后续边界

1. 是否使用本地历史仍由上一批的 `responses-history-policy` 决定，本模块只在调用方明确要求后改写载荷。
2. 普通 Responses 上游历史仍保留 `previous_response_id`；只有本地历史内联路径会删除它。
3. 上下文切换摘要继续复用同一 Chat→Responses 转换器，转换规则没有分叉。
4. 下一批可评估 compact 载荷预算与规范化边界，但必须先确认它与令牌估算、截断决策和日志事件的依赖关系，不能只按函数长度拆分。
