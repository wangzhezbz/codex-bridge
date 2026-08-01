# Router 整改记录 115：抽取图片拒绝回退消息构造并收口剩余批次

## 整改目标

本轮从 `src/upstream.js` 抽取图片输入被上游拒绝后的纯 Chat 响应构造逻辑，同时保留以下职责在原位置：

- 重试错误解析与脱敏；
- 历史 Turn 写入；
- 用量日志；
- HTTP JSON 与 Responses SSE 输出；
- 图片失败隔离和后续会话续接。

本轮不修改图片重试判定、模型路由、故障转移、认证、代理或用户配置。

## 影响分析

当前仓库没有 `.gitnexus` 索引，也没有可用的 `gitnexus` 命令，因此使用精确定义、调用、导出和测试搜索：

- `localImageRejectedChat` 只有 `sendLocalImageRejectedResponse` 一个调用点；
- `sendLocalImageRejectedResponse` 仍由真实 Chat 图片失败链调用；
- 旧函数同时混合错误详情解析和纯返回对象构造；
- 新接口 `imageRejectedFallbackChat(route, retryDetail)` 只接收已处理的安全详情，不接触 Error 类型、网络、history、response writer 或配置；
- `sendLocalImageRejectedResponse` 继续负责把 `UpstreamHttpError` 或普通错误转换成 `retryDetail`。

## TDD 证据

### 第一轮：供应商显示名与错误详情

先在 `tests/upstream-image-retry-policy.test.js` 添加返回结构契约。实现前运行：

```powershell
node --test tests/upstream-image-retry-policy.test.js
```

结果为 `4/5` 通过，唯一失败按预期显示新导出类型为 `undefined`。完成最小实现后为 `5/5`。

### 第二轮：显示名回退与空详情

再添加无 `displayName`、无 `retryDetail` 的真实分支。实现前结果为 `5/6`，失败值精确暴露：

- 显示名变成 `undefined`；
- 输出了空的“去掉图片后上游仍返回”句子。

补齐 `displayName → id → 当前模型` 回退和详情条件句后为 `6/6`。

## 修改内容

- `src/upstream-image-retry-policy.js`
  - 新增并导出 `imageRejectedFallbackChat`；
  - 只负责生成稳定的 Chat completion 结构和用户提示。
- `tests/upstream-image-retry-policy.test.js`
  - 新增两项直接行为契约。
- `src/upstream.js`
  - 导入新构造器；
  - 保留安全错误详情解析；
  - 删除旧 `localImageRejectedChat`；
  - 从 `3096` 行降至 `3072` 行。

没有新增模块文件，因此现有 `check:syntax` 和 `test:router` 固定入口已自动覆盖修改后的源文件与测试文件。

## 验证结果

- 直接契约：`6/6`；
- 图片策略、server 与 upstream 联合回归：`185/185`；
- `git diff --check`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 主套件：`684/684`；
- Desktop 主套件：`892/892`；
- 历史恢复套件：`16/16`；
- Windows Electron smoke：退出码 `0`，耗时约 `99.7` 秒；
- smoke provider 数：`19`；
- smoke 动态资源摘要：`28/2/3/46/3/0/2`；
- packaged resource smoke：通过；
- `release:code-ready`：通过 `16`、提醒 `6`、失败 `0`；
- 源码 TODO/FIXME/HACK/XXX：`0`。

生产依赖审计第一次运行时，根项目先返回 `0` 漏洞，随后 vendor 审计在连接 npm TLS 前被外部网络断开。没有修改代码或依赖规避该错误；单独重新运行完整 `npm run audit:prod` 后，根项目与 vendor 均为 `0` 漏洞。

Electron smoke 仍输出既有 Node SQLite experimental warning 与 Electron `console-message` deprecation warning，但退出码为 `0`。

## 当前剩余量

当前 7 项核心风险整改和多轮独立复审均已闭环，`release:code-ready` 也明确报告仓库代码状态已收尾。后续不再把 `upstream.js` 行数本身当作必须继续拆分的风险。

按“代码整改完成”口径，本批之后：

1. 预计还剩 `2` 批；
2. 如果最终扫描发现新的实质性问题，最多扩展到 `3` 批；
3. 本地 Windows 测试包属于可选交付，用户明确要求时再单独增加 `1` 批；
4. 不再为了制造批次机械拆函数。

建议的收口顺序：

1. 第 116 批：对剩余 `upstream.js` 和高风险入口做最终 stop/go 审计，只处理有明确收益且低耦合的问题；
2. 第 117 批：全仓最终风险复扫、门禁、工作树清单和可直接接手的最终中文交付；
3. 第 118 批仅作为发现实质性问题时的预留，不默认执行。

## 代码之外的三类边界

`release:code-ready` 的 6 项提醒可以归并为三类，不属于仓库代码缺陷：

1. 本机配置：生成模型目录、启动 Router、检查路由健康，并按需配置图片供应商；
2. 真实环境：真实 Sol/其他供应商、真实图片生成、真实客户端重连与目标机器现场；
3. 正式发布环境：NSIS Setup.exe、安装器和自动更新链验收。

## 工作树边界

- 保留继承的脏工作树；
- 没有重置、清理或覆盖已有修改；
- 没有删除任何文件；
- 没有暂存、提交、推送、打包或发布；
- 没有修改 Sol、Terra、Luna 的路由和上游模型值。
