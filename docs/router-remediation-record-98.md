# Router 整改记录 98：拆分 Responses compaction 载荷规范化

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，评估上一批留下的 compact 载荷预算与规范化边界。影响分析确认：

- `budgetResponsesCompactPayload` 同时依赖路由上下文策略、历史转 Chat 消息、令牌估算、截断、工具边界统计和历史载荷内联，不适合作为本轮的小型独立模块强行拆分；
- `normalizeBridgePlainCompactionPayload` 与两个私有辅助函数构成独立规范化边界，只负责把 CodexBridge 自产的明文 compaction 项转换为 Responses 可接受的用户消息；
- 该规范化边界有三处生产调用，覆盖普通 Responses 请求、远程 compact 请求和 compact 流式重试。

因此本轮只提取 compaction 载荷规范化，不移动预算、截断、历史、网络、日志决策或响应发送逻辑，不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态定义、导入和调用面搜索替代：

- `normalizeBridgePlainCompactionPayload` 有三处生产调用；
- `normalizeBridgeCompactionInput` 和 `isBridgePlainCompactionItem` 只由规范化入口调用；
- 唯一外部依赖是 `compact.js` 导出的 `COMPACT_SUMMARY_PREFIX`；
- 新模块不导入路由选择、历史存储、令牌预算、网络、代理、SSE 或响应发送模块；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

## TDD 证据

先新增 `tests/responses-compaction-payload.test.js`：

```powershell
node --test tests/responses-compaction-payload.test.js
```

实现前结果为 `0/3` 通过、`3/3` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/responses-compaction-payload.js` 尚不存在。

完成最小实现并切换生产调用后，直接测试为 `3/3` 通过，分别验证：

- Responses 请求中的 `compaction` 和 `context_compaction` 明文摘要在 `input` 与 `messages` 中都转换为 `input_text` 用户消息；
- OpenAI 上游产生的 opaque compaction、普通消息和其他载荷字段保持不变；
- Chat 路由完全不执行规范化；
- 标量输入、非前缀 compaction 和无效 `encrypted_content` 保持原引用且不产生日志。

## 模块边界

新增 `src/responses-compaction-payload.js`，公开导出：

- `normalizeBridgePlainCompactionPayload`

模块内部保留两个私有辅助函数：

- `normalizeBridgeCompactionInput`
- `isBridgePlainCompactionItem`

拆分后：

- `src/responses-compaction-payload.js` 为 54 行；
- `src/upstream.js` 从上一批的 4375 行降至 4322 行；
- `tests/responses-compaction-payload.test.js` 为 111 行；
- 三个函数定义均只存在于新模块，`src/upstream.js` 只保留导入和三处生产调用；
- `COMPACT_SUMMARY_PREFIX` 不再被 `src/upstream.js` 直接导入。

## 验证结果

- 规范化红测：实现前 `0/3` 通过、`3/3` 按预期失败；
- 规范化绿测：`3/3`；
- compaction、上下文策略、上下文切换、Responses 历史、上游代理、服务端和 Sol/Terra SSE 联合回归：`211/211`；
- `npm run check:syntax`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`624/624`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 审计最初两次因 npm Registry 在 TLS 建连前返回 `ECONNRESET` 而无法得出漏洞结论；确认 root/vendor Registry 与代理配置一致、两边 `npm ping` 成功后，重新执行完全相同的在线审计，最终返回 `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `89.6` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`；
- `git diff --check` 与 staged diff check：通过。

smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning，两项均未导致失败。本轮没有修改 npm Registry 或代理配置。

## 主要修改文件

- `src/responses-compaction-payload.js`
- `src/upstream.js`
- `tests/responses-compaction-payload.test.js`
- `package.json`

## 后续边界

1. 只有以 `COMPACT_SUMMARY_PREFIX` 开头的 CodexBridge 明文摘要会被规范化，opaque 上游 compaction 继续原样透传。
2. Chat 路由不会进入该规范化逻辑。
3. `budgetResponsesCompactPayload` 继续留在 `src/upstream.js`；如果后续要移动，必须把上下文策略与预算计算设计成明确依赖，而不是把多个路由职责一起搬走。
4. 下一批应重新从剩余函数的调用面选择低耦合边界，不能默认继续拆 compact 预算函数。
