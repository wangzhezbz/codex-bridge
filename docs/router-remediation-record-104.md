# Router 整改记录 104：抽取智能故障切换响应文案与输出注入

## 整改目标

本轮只从 `src/upstream.js` 抽取智能故障切换成功后的纯响应处理逻辑：

- 生成人类可读的故障切换提示文案；
- 将提示前置到 Responses 的 `output_text`；
- 同步更新或创建首个 `output_text` 消息内容。

故障切换选择、可用性判断、上游错误分类、`safeText` 脱敏、响应元数据写入和网络请求生命周期继续留在 `src/upstream.js`。本轮不修改 Sol/Terra/Luna 路由、默认模型、故障切换选择、代理或用户密钥。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此改用静态定义、导入和调用面搜索：

- `smartFailoverNotice` 和 `prependResponseOutputText` 只有 `annotateSmartFailoverResponse` 一个生产调用方；
- `smartFailoverReasonLabel` 只服务于提示文案生成，保留为新模块私有函数；
- `annotateSmartFailoverResponse` 依赖 upstream 内部的 `safeText` 与元数据策略，因此没有强行拆出；
- 新模块没有导入，也不读取路由、history、网络、代理或密钥状态；
- 新模块及直接测试已接入 `check:syntax` 和 `test:router`。

## TDD 证据

先新增 `tests/smart-failover-response.test.js`：

```powershell
node --test tests/smart-failover-response.test.js
```

实现前结果为 `0/4` 通过、`4/4` 失败，失败原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/smart-failover-response.js` 尚不存在。

完成最小实现并切换生产调用后，直接测试为 `4/4` 通过，分别验证：

- 供应商显示名和 `rate_limited` 本地化文案；
- route/raw reason 的兜底文案；
- 同时前置 `response.output_text` 与首个 `output_text` 内容块；
- 空 `output` 时创建规范的 assistant message。

## 模块边界

新增 `src/smart-failover-response.js`，公开导出：

- `smartFailoverNotice`
- `prependResponseOutputText`

拆分后：

- `src/smart-failover-response.js` 为 55 行；
- `src/upstream.js` 为 4017 行；
- `tests/smart-failover-response.test.js` 为 91 行；
- 三个原响应处理函数定义已从 `src/upstream.js` 移除；
- upstream 仍负责脱敏后标签组装、响应注解时机和元数据写入。

## 验证结果

- 响应处理红测：实现前 `0/4` 通过、`4/4` 按预期失败；
- 响应处理绿测：`4/4`；
- 响应处理、智能路由、请求烟测、路由契约、上游代理与服务端联合回归：`221/221`；
- `npm run check:syntax`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`645/645`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 生产依赖审计：`0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `88.6` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`。

smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning，两项均未导致失败。

## 主要修改文件

- `src/smart-failover-response.js`
- `src/upstream.js`
- `tests/smart-failover-response.test.js`
- `package.json`

## 后续边界

1. `annotateSmartFailoverResponse` 继续留在 upstream，避免把脱敏和元数据策略扩散到纯响应模块。
2. 新模块只处理已决定故障切换后的展示结果，不参与是否切换、切换到哪个 route 或何时重试。
3. 下一批应重新扫描 `src/upstream.js` 剩余候选；凡涉及 history、网络生命周期或故障切换决策的逻辑，不做机械拆分。
