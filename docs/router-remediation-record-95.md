# Router 整改记录 95：统一 Responses 流中断文案生成

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，只把 `responsesStreamFailureMessage` 移入既有的 `src/upstream-error-presentation.js`：

- 保持路由标签优先级为 `displayName`、`id`、`model`、`route`；
- 保持上游错误详情的密钥脱敏；
- 保持回车、换行和连续空白压平为单行；
- 保持诊断详情最多 300 个字符；
- 保持既有英文中断文案和客户端 SSE 发送行为。

本轮不移动错误分类、SSE 构造或发送、网络读取、历史写入、日志和响应结束逻辑，不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态调用面搜索替代：

- `responsesStreamFailureMessage` 原先只有一处生产调用；
- 它只负责根据路由标签和错误详情构造文本，不读取响应体、不写历史、不发送响应；
- 它依赖的 `safeText` 已经存在于 `src/upstream-error-presentation.js`，该模块同时拥有上游错误脱敏与客户端呈现职责；
- 提取后 `src/upstream.js` 只导入并调用该函数；
- 生产代码中只保留一份 `responsesStreamFailureMessage` 定义。

## TDD 证据

先在 `tests/upstream-error-presentation.test.js` 新增三项直接行为测试：

```powershell
node --test tests/upstream-error-presentation.test.js
```

实现前结果为 `1/4` 通过、`3/4` 失败。新增测试均因预期的 `TypeError: responsesStreamFailureMessage is not a function` 失败，证明既有模块尚未提供该导出。

完成最小实现并切换生产调用后，直接测试为 `4/4` 通过，分别验证：

- 优先使用 `displayName`，并对错误详情执行密钥脱敏与单行化；
- 路由标签按 `id`、`model`、默认 `route` 的顺序回退；
- 空错误详情不会留下尾部空格；
- 错误详情最多保留 300 个字符。

## 模块边界

`src/upstream-error-presentation.js` 新增导出：

- `responsesStreamFailureMessage`

拆分后：

- `src/upstream-error-presentation.js` 为 402 行；
- `src/upstream.js` 从上一批的 4548 行降至 4544 行；
- `tests/upstream-error-presentation.test.js` 为 107 行；
- 错误分类、SSE 写入、日志和异常抛出仍由原调用链负责。

## 验证结果

- 流中断文案红测：实现前 `1/4` 通过、`3/4` 按预期失败；
- 流中断文案绿测：`4/4`；
- 错误呈现、协议策略、SSE 分块、终端状态、文本缓冲、上游代理、历史持久化和服务端联合回归：`237/237`；
- `npm run check`：退出码 `0`；
- Router 子套件：`613/613`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `140.9` 秒；
- 本次 smoke 动态资源摘要：`28/0/3/46/3/0/2`；
- `git diff --check`：通过。

Electron smoke 明确报告资源校验通过，但本次动态应用数为 `0`，与上一批的 `2` 不同；该值按当前运行环境快照记录，不作为本轮代码回归。smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning，两项没有导致失败。

## 主要修改文件

- `src/upstream-error-presentation.js`
- `src/upstream.js`
- `tests/upstream-error-presentation.test.js`

## 后续边界

1. `responsesStreamFailureMessage` 只生成脱敏文本，不决定错误分类或错误码。
2. `src/upstream.js` 继续决定何时写入错误 SSE、何时结束响应和何时重新抛出异常。
3. 下一批可评估把 `shouldInlineLocalHistoryForResponses` 与本地 Chat 响应 ID 判断提取为历史策略模块。
4. 后续历史策略拆分必须覆盖有元数据、缺失元数据、空历史、非本地响应 ID、跨 Router 重启和普通 Responses 上游历史。
