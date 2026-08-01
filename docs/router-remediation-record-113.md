# Router 整改记录 113：清理 upstream 错误展示旧死代码

## 整改目标

本轮只处理 `src/upstream.js` 中三个上一批已标记的旧辅助函数：

- `userFacingUpstreamDetail`
- `looksLikeHtml`
- `shouldHideCommonEnglishDetail`

目标是删除已经不在运行路径上的重复实现，继续缩小 `upstream.js`，不改变当前错误展示、路由、代理、认证、模型选择或故障转移行为。

## 影响与死代码证据

GitNexus 重构流程要求先做影响分析。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此改用静态定义、调用、导出和测试搜索：

- 三个函数均只定义在 `src/upstream.js`；
- `userFacingUpstreamDetail` 没有调用点，也没有导出；
- 另外两个函数只被 `userFacingUpstreamDetail` 调用；
- 三者形成一个自包含、不可达的私有代码孤岛；
- 桌面端和 `src/upstream-error-presentation.js` 中存在同名局部标识，但属于其他模块作用域，不受本次删除影响；
- 当前真实上游错误展示由 `createUpstreamErrorPresentation` 生成，并通过 `sendUpstreamErrorInternal` 接入 `src/upstream.js` 的公共 `sendUpstreamError` 导出。

删除后重新搜索，三个标识在 `src/upstream.js` 中的命中数为 `0`。

## 测试策略

这是纯死代码删除，不新增或改变可观察行为。根据测试质量规则，没有添加“源码中不得出现某字符串”一类脆弱测试，也没有为不可达私有函数制造虚假行为契约。

删除前先运行真实错误展示与请求链基线：

```powershell
node --test tests/upstream-error-presentation.test.js tests/upstream-proxy.test.js tests/server.test.js
```

删除前后该组合均为 `183/183` 通过，覆盖常见供应商 HTTP 错误、HTML 网关错误、订阅额度、请求体过大、Responses 流错误及实际 server/upstream 请求链。

## 修改内容

只修改 `src/upstream.js`：

- 删除三个无调用私有函数及关联空行，共减少 35 行；
- 文件从 `3271` 行降至 `3236` 行；
- 没有修改任何 import、export、调用点、配置、测试门禁或依赖。

## 验证结果

- `node --check src/upstream.js`：退出码 `0`；
- 删除后目标符号命中数：`0`；
- 错误展示、server 与 upstream 定向回归：`183/183`；
- `git diff --check`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 主套件：`682/682`；
- Desktop 主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 生产依赖审计：`0` 漏洞；
- Windows Electron smoke：退出码 `0`，耗时约 `119` 秒；
- smoke 加载 provider 数：`19`；
- smoke 动态资源摘要：`28/2/3/46/3/0/2`；
- packaged resource smoke：通过。

Electron smoke 仍输出 Node SQLite experimental warning 与 Electron `console-message` deprecation warning，但命令退出码为 `0`；这些是既有运行时警告，本批没有修改对应代码。

## 工作树边界

- 保留继承的脏工作树；
- 没有重置、清理或覆盖既有修改；
- 没有删除任何文件；
- 没有暂存、提交、推送、打包或发布；
- 没有修改 Sol、Terra、Luna 的路由或上游模型值。

## 下一批候选

对 `src/upstream.js` 顶层普通函数做定义与引用计数后，当前还有两个仅出现一次的候选：

- `requestRepeatsPreviousUserContext`
- `sendLocalRateLimitedResponse`

下一批应分别确认它们没有导出、对象间接引用或动态调用，再决定是否删除；不能仅凭出现次数直接清理。
