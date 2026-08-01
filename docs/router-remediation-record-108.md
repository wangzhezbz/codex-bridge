# Router 整改记录 108：抽取路由决策追踪字段格式化器

## 整改目标

本轮从 `src/upstream.js` 抽取路由决策追踪字段的纯格式化逻辑：

- 格式化智能故障切换的原路由与目标路由事实；
- 兼容当前 `routePlan.decision` 与旧版 `routeSelection` 数据形状；
- 清洗换行、连续空白和过长追踪文本；
- 规范被跳过路由的 ID、原因和详情字段。

本轮只序列化已存在的路由决策，不参与路由选择、模型改写、健康判断、故障切换或上游请求。没有修改 Sol/Terra/Luna 路由、默认模型、智能故障切换、代理或用户密钥。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此改用静态定义、导入、调用和测试搜索：

- `routeDecisionTraceDetails` 只有 `recordRouteDecisionTraceEvent` 一个生产调用方；
- `routeDecisionTraceDetailsFromDecision`、`routeDecisionTraceSkippedRoutes` 与 `safeTraceText` 只在该函数族内部使用；
- 上游调用方仍负责写入 route trace 和一次性记录标记；
- 新模块不导入网络、历史、配置或路由选择模块；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

## TDD 证据

先新增 `tests/route-decision-trace.test.js`：

```powershell
node --test tests/route-decision-trace.test.js
```

实现前命令退出码为 `1`，测试文件在加载阶段按预期因 `ERR_MODULE_NOT_FOUND` 失败，因为 `src/route-decision-trace.js` 尚不存在。

完成最小抽取并切换生产调用后，直接测试为 `4/4` 通过，覆盖：

- 智能故障切换字段与脏文本清洗；
- versioned route-plan decision、模型改写和跳过路由过滤；
- 旧版 route-selection 追踪结构；
- 无决策时保持 unchanged manual route 语义。

## 模块边界

新增 `src/route-decision-trace.js`，公开导出：

- `routeDecisionTraceDetails`

拆分后：

- `src/route-decision-trace.js` 为 115 行；
- `src/upstream.js` 从 3619 行降至 3504 行；
- `tests/route-decision-trace.test.js` 为 160 行；
- 原四个格式化函数定义已从 `src/upstream.js` 移除；
- upstream 只保留一个导入和一个生产调用点。

## 验证结果

- 直接契约红测：退出码 `1`，按预期为目标模块缺失；
- 直接契约绿测：`4/4`；
- 路由决策追踪、route trace、请求烟测、智能路由、服务端与上游代理组合回归：`224/224`；
- `git diff --check`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`666/666`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 生产依赖审计：`0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `88.8` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`，加载 provider 数为 `19`。

## 主要修改文件

- `src/route-decision-trace.js`
- `src/upstream.js`
- `tests/route-decision-trace.test.js`
- `package.json`
- `docs/router-remediation-record-108.md`

## 后续边界

1. `ensureRouteTrace` 与 `recordRouteDecisionTraceEvent` 继续留在 upstream，因为它们会修改请求上下文并写入追踪事件。
2. 路由选择、故障切换和网络生命周期仍是高风险边界，不因本次纯格式化抽取而继续机械拆分。
3. 下一批重新扫描 `src/upstream.js` 剩余 3504 行，继续优先选择无网络、无 history 且调用面单一的纯函数族。
