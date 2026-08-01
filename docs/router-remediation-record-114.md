# Router 整改记录 114：清理历史续接与本地限流旧死代码闭包

## 整改目标

本轮从上一批留下的两个单次出现候选开始：

- `requestRepeatsPreviousUserContext`
- `sendLocalRateLimitedResponse`

不凭出现次数直接删除，而是继续审计它们的调用、导出、对象引用、动态引用和依赖闭包，只清理确认不可达的 upstream 私有代码。

本轮不修改路由、模型、认证、代理、限流实现、故障转移或用户配置。

## 影响分析

当前仓库没有 `.gitnexus` 索引，也没有可用的 `gitnexus` 命令，因此使用精确静态搜索和真实行为测试代替代码图查询。

两个根函数均满足：

- 只在 `src/upstream.js` 中定义一次；
- 没有调用点；
- 没有导出；
- 没有对象属性、计算属性或字符串动态引用；
- 仓库中的其他命中只来自上一批整改记录。

继续沿依赖关系检查后，确认以下三个函数仅由上述不可达根函数调用：

- `requestHasCurrentToolProtocolContinuation`
- `previousUserInputSignatures`
- `localRateLimitedChat`

同时确认以下 upstream 局部绑定在删除函数闭包后不再被使用：

- `sameStringArray`
- `requestHasToolProtocolInput`
- `routeRateLimitStatus`
- `classifyUpstreamError`
- `upstreamErrorInfo`

这里删除的只是 `src/upstream.js` 的导入或解构绑定；共享模块中的对应实现及其其他调用方保持不变。

## 测试策略

本轮是纯不可达代码删除，不新增或改变可观察行为。按照测试质量规则，没有添加检查源码字符串或私有函数存在性的伪测试。

删除前后均运行相同的真实行为组合：

```powershell
node --test tests/rate-limit.test.js tests/responses-tool-loop-guard.test.js tests/upstream-error-presentation.test.js tests/upstream-proxy.test.js tests/server.test.js
```

删除前与删除后均为 `193/193` 通过，覆盖：

- provider cooldown 与 HTTP 429；
- 工具循环和 Responses 工具续接；
- 上游错误展示；
- `previous_response_id` 无新输入保护；
- 模型槽切换与新输入；
- server/upstream 实际请求链。

## 修改内容

只修改 `src/upstream.js`：

- 删除 5 个不可达私有函数；
- 删除 5 个随闭包失效的 import 或解构绑定；
- 文件从 `3236` 行降至 `3096` 行，共减少 `140` 行；
- 删除后上述 10 个局部标识在 `src/upstream.js` 中均为 `0` 次命中；
- 普通顶层函数“只定义、不引用”候选重新扫描结果为空。

## 验证结果

- `node --check src/upstream.js`：退出码 `0`；
- 定向行为回归：`193/193`；
- `git diff --check`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 主套件：`682/682`；
- Desktop 主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 生产依赖审计：`0` 漏洞；
- Windows Electron smoke：退出码 `0`，耗时约 `115.7` 秒；
- smoke provider 数：`19`；
- smoke 动态资源摘要：`28/2/3/46/3/0/2`；
- packaged resource smoke：通过。

Electron smoke 仍输出既有的 Node SQLite experimental warning 与 Electron `console-message` deprecation warning，但退出码为 `0`；本批没有修改对应代码。

## 工作树边界

- 保留继承的脏工作树；
- 没有重置、清理或覆盖已有修改；
- 没有删除任何文件；
- 没有暂存、提交、推送、打包或发布；
- 没有修改 Sol、Terra、Luna 的路由和上游模型值。

## 下一批候选

`src/upstream.js` 仍有 `3096` 行。下一批建议针对图片拒绝回退边界做小步抽取：先为纯消息构造行为建立直接契约，再评估将 `localImageRejectedChat` 移入图片重试策略模块；`sendLocalImageRejectedResponse` 的历史记录和 HTTP/SSE 写入职责暂不一起搬迁，避免一次引入过多依赖。
