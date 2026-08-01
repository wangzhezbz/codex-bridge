# Router 整改记录 110：抽取上游网络错误与安全诊断模块

## 整改目标

本轮从 `src/upstream.js` 抽取上游错误类型和网络诊断纯逻辑：

- 统一 HTTP、网络和流式错误对象的元数据；
- 识别 undici、DNS、连接拒绝、重置和超时类网络失败；
- 生成不包含 URL 凭据、query 和 fragment 的网络错误消息；
- 对日志正文执行密钥脱敏、空白压缩和长度限制；
- 保持 server 现有错误日志预览和 upstream 公共导出兼容。

本轮不发起请求、不选择模型或路由，也不改变代理使用、刷新、直连回退或异常分类分支。没有修改 Sol/Terra/Luna 路由、默认模型、智能故障切换、代理配置或用户密钥。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此改用静态定义、导入、调用和测试搜索：

- `UpstreamHttpError` 被 upstream 请求、图片重试、URL 回退、错误展示和测试使用；
- `UpstreamNetworkError` 与 `UpstreamStreamError` 被请求生命周期和错误展示使用；
- `upstreamErrorLogPreview` 由 `src/server.js` 从 `src/upstream.js` 导入；
- `isNetworkFetchFailure` 只参与 upstream 已有代理失败与直连回退分支；
- `safeText` 与 `safeUrl` 只格式化日志和诊断字段，不影响真实请求 URL；
- `src/upstream.js` 继续重新导出三种错误类和 `upstreamErrorLogPreview`，公共导出身份比较结果为 `true`；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

## TDD 证据

先新增 `tests/upstream-network-errors.test.js`：

```powershell
node --test tests/upstream-network-errors.test.js
```

实现前命令退出码为 `1`，测试文件在加载阶段按预期因 `ERR_MODULE_NOT_FOUND` 失败，因为 `src/upstream-network-errors.js` 尚不存在。

完成最小抽取并改接 upstream 后，直接测试为 `5/5` 通过，覆盖：

- HTTP 状态、正文、Retry-After 与受限 route snapshot；
- 网络错误状态码、诊断码、cause、proxy label 与安全 URL；
- 流式错误的默认和显式诊断契约；
- fetch、undici、连接重置、超时与非网络错误分类；
- Bearer/API 密钥脱敏、换行压缩、长度限制与日志预览。

测试使用字面量期望，并验证 route snapshot 不复制 `apiKey`。

## 模块边界

新增 `src/upstream-network-errors.js`，公开导出：

- `UpstreamHttpError`
- `UpstreamNetworkError`
- `UpstreamStreamError`
- `isNetworkFetchFailure`
- `upstreamErrorLogPreview`
- `safeUrl`
- `safeText`

拆分后：

- `src/upstream-network-errors.js` 为 100 行；
- `src/upstream.js` 从 3406 行降至 3316 行；
- `tests/upstream-network-errors.test.js` 为 130 行；
- upstream 原错误类、网络分类、诊断消息和安全格式化定义已移除；
- server 和外部测试仍可从 `src/upstream.js` 使用原公共 API。

## 验证结果

- 直接契约红测：退出码 `1`，按预期为目标模块缺失；
- 直接契约绿测：`5/5`；
- 错误展示、健康分类、header、图片/URL 回退、server 和 upstream proxy 联合回归：`207/207`；
- 公共重新导出身份检查：`true`；
- `git diff --check`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`676/676`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 生产依赖审计：`0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `105.2` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`，加载 provider 数为 `19`。

## 主要修改文件

- `src/upstream-network-errors.js`
- `src/upstream.js`
- `tests/upstream-network-errors.test.js`
- `package.json`
- `docs/router-remediation-record-110.md`

## 后续边界

1. 新模块只定义错误对象与安全诊断，代理 dispatcher、重试、直连回退和 fetch 生命周期继续留在原模块。
2. `src/upstream.js` 中三个无调用的旧用户可见错误辅助函数仍保持不动，后续应单独做死代码证据与清理，不与功能抽取混合。
3. 下一批重新扫描剩余 3316 行，优先选择不改变路由决策的纯 URL 策略、错误展示或数据整形函数族。
