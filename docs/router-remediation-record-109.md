# Router 整改记录 109：抽取重复工具调用防循环策略

## 整改目标

本轮从 `src/upstream.js` 抽取 Responses/Chat 工具续跑的重复调用防循环逻辑：

- 识别当前响应是否仍包含可执行工具调用；
- 比较当前与上一轮工具调用、工具结果签名；
- 累计连续无进展的工具续跑轮数；
- 规范 route 的最大续跑阈值；
- 达到阈值时生成本地 assistant chat 兜底响应。

本轮只判断已生成的工具协议数据，不执行工具、不调用网络、不选择模型或路由。没有修改 Sol/Terra/Luna 路由、默认模型、智能故障切换、代理或用户密钥。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此改用静态定义、导入、调用和测试搜索：

- 防循环策略的生产调用均位于 `src/upstream.js`；
- 依赖限定为工具项类型判断、工具签名和续跑分组纯函数；
- 网络请求、历史写入、日志和 Responses 转换继续留在 upstream；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

静态终查发现 `sameStringArray` 除防循环签名比较外，还被 upstream 的旧重复用户上下文判断引用。第一次迁移会留下潜在未定义引用，虽然该旧函数当前没有生产调用，仍不能保留悬空依赖。因此将精确有序数组比较作为新模块的显式共享导出，并由 upstream 导入；没有删除或改写旧重复上下文函数。

## TDD 与调试证据

先新增 `tests/responses-tool-loop-guard.test.js`：

```powershell
node --test tests/responses-tool-loop-guard.test.js
```

实现前命令退出码为 `1`，测试文件按预期因 `ERR_MODULE_NOT_FOUND` 失败，因为 `src/responses-tool-loop-guard.js` 尚不存在。

完成初始抽取后直接测试为 `4/4`。随后静态调用终查发现共享数组比较引用，按系统化调试流程确认：

- `sameStringArray` 原有两个调用职责；
- 防循环模块已经包含实现；
- upstream 旧重复上下文判断仍保留一个引用；
- 相关请求级测试无法触发该问题，因为旧判断当前没有生产调用。

在导出修正前新增共享比较契约，测试再次以退出码 `1` 按预期失败，错误为目标模块未导出 `sameStringArray`。完成单一 export/import 修正后，直接测试为 `5/5`。

直接契约覆盖：

- camelCase/snake_case 阈值、向下取整、零值与默认值；
- 可执行工具调用和工具结果输入识别；
- 历史签名优先级与空签名短路；
- 无进展轮数的历史累计和输入分组回退；
- 本地 assistant chat 的结构、模型名和轮数文案；
- 共享签名数组的有序精确比较。

## 模块边界

新增 `src/responses-tool-loop-guard.js`，公开导出：

- `requestHasResponseToolOutput`
- `shouldStopChatToolContinuation`
- `maxChatToolContinuationTurns`
- `responseHasRunnableToolCall`
- `responseRepeatsPreviousToolCall`
- `repeatedToolResultHasNoProgress`
- `repeatedNoProgressToolLoopTurns`
- `sameStringArray`
- `localToolLoopGuardChat`

拆分后：

- `src/responses-tool-loop-guard.js` 为 110 行；
- `src/upstream.js` 从 3504 行降至 3406 行；
- `tests/responses-tool-loop-guard.test.js` 为 140 行；
- upstream 只通过显式导入使用防循环策略和共享比较函数。

## 验证结果

- 新模块红测：退出码 `1`，按预期为目标模块缺失；
- 共享导出红测：退出码 `1`，按预期为目标 named export 缺失；
- 直接契约绿测：`5/5`；
- 工具续跑、签名、输入分析、历史、服务端和上游代理联合回归：`234/234`；
- `git diff --check`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`671/671`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 生产依赖审计：`0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `95` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`，加载 provider 数为 `19`。

## 主要修改文件

- `src/responses-tool-loop-guard.js`
- `src/upstream.js`
- `tests/responses-tool-loop-guard.test.js`
- `package.json`
- `docs/router-remediation-record-109.md`

## 后续边界

1. 防循环策略只返回判断与本地 chat，日志、历史持久化和响应转换仍属于 upstream 编排层。
2. 旧重复用户上下文函数当前无生产调用，本批仅保持其引用完整，不顺带删除死代码。
3. 下一批重新扫描 `src/upstream.js` 剩余 3406 行，优先处理纯错误展示、日志字段或其他单一调用面的低耦合函数族。
