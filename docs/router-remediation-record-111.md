# Router 整改记录 111：归并智能故障切换响应注解

## 整改目标

本轮将 `src/upstream.js` 中的智能故障切换响应注解迁入现有 `src/smart-failover-response.js`：

- 清洗原路由、原模型、目标路由、目标模型与失败原因；
- 写入 `codexbridge_smart_failover` 响应元数据；
- 生成用户可见的中文切换提示；
- 将提示同步写入 `output_text` 和首个 Responses 文本块；
- 缺少原路由或失败原因时保持响应不变。

本轮只注解已经发生的智能故障切换，不判断是否切换、不选择目标模型，也不执行重试或网络请求。没有修改 Sol/Terra/Luna 路由、默认模型、智能故障切换条件、代理或用户密钥。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此改用静态定义、导入、调用和测试搜索：

- `annotateSmartFailoverResponse` 只有 chat-compatible 响应完成路径一个生产调用点；
- 函数只依赖既有 `smartFailoverNotice`、`prependResponseOutputText` 与安全文本格式化；
- 故障切换选择、route health、代理、请求重试和历史持久化均在函数外；
- 迁移后 upstream 只有一个导入和一个调用点；
- 现有 `smart-failover-response.js` 与测试已经在固定语法和 Router 门禁中，无需修改 package scripts。

## TDD 证据

先在 `tests/smart-failover-response.test.js` 新增两条直接契约：

```powershell
node --test tests/smart-failover-response.test.js
```

实现前原有 `4/4` 继续通过，新增两条按预期因 `annotateSmartFailoverResponse is not a function` 失败，命令总结果为 `4` 通过、`2` 失败。

完成最小迁移并改接 upstream 后，直接测试为 `6/6` 通过，新增覆盖：

- 元数据换行清洗、原/目标字段与失败原因；
- 中文切换提示同步写入摘要和 Responses 文本块；
- 返回原响应对象，不替换对象身份；
- 缺少原路由或失败原因时不写元数据、不改变响应。

## 模块边界

`src/smart-failover-response.js` 现公开导出：

- `smartFailoverNotice`
- `annotateSmartFailoverResponse`
- `prependResponseOutputText`

拆分后：

- `src/smart-failover-response.js` 为 81 行；
- `src/upstream.js` 从 3316 行降至 3289 行；
- `tests/smart-failover-response.test.js` 为 162 行；
- upstream 原注解定义及不再使用的提示/文本注入导入已移除。

## 验证结果

- 直接契约红测：原有 `4` 条通过，新增 `2` 条按预期失败；
- 直接契约绿测：`6/6`；
- 智能路由、请求烟测、route health、route trace、server 与 upstream proxy 联合回归：`234/234`；
- `git diff --check`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`678/678`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 生产依赖审计：`0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `86.3` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`，加载 provider 数为 `19`。

## 主要修改文件

- `src/smart-failover-response.js`
- `src/upstream.js`
- `tests/smart-failover-response.test.js`
- `docs/router-remediation-record-111.md`

## 后续边界

1. smart-failover 模块只处理响应元数据和用户可见文本，路由选择与故障切换执行仍留在既有边界。
2. 下一批可评估 `responsesBaseUrlForRoute` 的纯 URL 策略抽取，但必须保持 ChatGPT Codex backend、环境覆盖值和 API-key route 原行为。
3. 三个无调用的旧用户可见错误辅助函数仍应单独处理，避免把死代码清理混入 URL 或路由策略迁移。
