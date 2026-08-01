# Router 整改记录 96：拆分 Responses 本地历史内联策略

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，只提取 Responses 请求是否需要内联本地历史的判断：

- 没有 `previous_response_id` 时不内联；
- 历史对象不支持响应元数据查询时不内联；
- 元数据明确标记 `upstreamKnown === false` 时内联；
- 元数据存在且不是明确的本地响应时不内联；
- 遗留 `resp_chatcmpl_` 或 `resp_chatcmpl-` 响应只有在本地历史非空时内联；
- 普通 Responses ID、空历史和缺失历史不内联。

本轮不移动历史内容读取、载荷改写、上下文切换压缩、持久化、网络读取或响应发送逻辑，不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态调用面搜索替代：

- `shouldInlineLocalHistoryForResponses` 只有一处生产调用；
- `isLikelyLocalChatResponseId` 只由该策略函数调用；
- 既有服务端测试已覆盖本地 Chat 模型历史切换到 Responses 路由，以及缺失元数据的遗留 Chat 历史；
- 既有持久化测试已覆盖 Router 重启后的历史恢复；
- 新模块不导入路由、网络、代理、SSE、日志或响应发送模块；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

## TDD 证据

先新增 `tests/responses-history-policy.test.js`，并使用真实 `ResponseHistory` 验证历史行为：

```powershell
node --test tests/responses-history-policy.test.js
```

实现前结果为 `0/4` 通过、`4/4` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/responses-history-policy.js` 尚不存在。

完成最小实现并切换生产调用后，直接测试为 `4/4` 通过，分别验证：

- 请求前序 ID和元数据查询能力是必要条件；
- `upstreamKnown: false` 与 `upstreamKnown: true` 分别选择内联和保持上游历史；
- 下划线和连字符两种遗留本地 Chat 响应 ID 均可识别；
- 空遗留历史和普通 Responses ID 不会被误判。

## 模块边界

新增 `src/responses-history-policy.js`，导出：

- `shouldInlineLocalHistoryForResponses`

模块内部保留私有的 `isLikelyLocalChatResponseId`，不扩大公共接口。

拆分后：

- `src/responses-history-policy.js` 为 20 行；
- `src/upstream.js` 从上一批的 4544 行降至 4524 行；
- `tests/responses-history-policy.test.js` 为 105 行；
- 是否执行上下文切换内联、如何改写载荷和如何保存历史仍由原调用链负责。

## 验证结果

- 历史策略红测：实现前 `0/4` 通过、`4/4` 按预期失败；
- 历史策略绿测：`4/4`；
- 历史策略、错误呈现、SSE 流、上游代理、持久化和服务端联合回归：`241/241`；
- `npm run check:syntax`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`617/617`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `103.5` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`；
- `git diff --check`：通过。

上一批 smoke 的应用数为 `0`，本批恢复为 `2`，两次资源校验都明确通过，因此按运行环境动态快照处理。smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning，两项没有导致失败。

## 主要修改文件

- `src/responses-history-policy.js`
- `src/upstream.js`
- `tests/responses-history-policy.test.js`
- `package.json`

## 后续边界

1. 新模块只判断是否应内联历史，不修改 `requestBody` 或上游载荷。
2. 上下文切换压缩仍可独立触发历史内联，不受本模块的遗留 ID 判断限制。
3. 普通 Responses 上游历史继续保留 `previous_response_id`，不会被本地缓存误判。
4. 下一批可评估提取 `inlineLocalHistoryForResponsesPayload` 的载荷改写，但必须覆盖工具调用、当前输入去重、上下文切换和遗留历史链。
