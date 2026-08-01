# Router 整改记录 101：统一稳定 JSON 序列化边界

## 整改目标

本轮统一 `src/upstream.js` 与 `src/route-snapshot.js` 中重复的稳定 JSON 序列化实现，建立单一纯数据出口。

稳定序列化用于：

- 比较已保存路由快照与当前路由快照；
- 比较上下文续跑使用的快照数据；
- 规范化工具结果签名中的结构化 JSON。

本轮不修改路由选择、快照字段、工具执行、工具续跑限制、历史写入、网络请求、代理或用户凭据，也不修改 Sol、Terra、Luna 和默认模型。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态定义、导入和调用面搜索替代：

- 两份 `stableStringify` 实现对原始值、数组和对象的处理逐行等价；
- 原始值沿用 `JSON.stringify` 语义；
- 数组保持输入顺序，对象键递归排序；
- upstream 有三处调用，分别服务快照比较和工具结果签名；
- route-snapshot 有一处调用，服务所有关键快照字段的深度等值判断；
- 新模块无任何项目内依赖，不导入路由、历史、网络、SSE、工具或日志模块；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

## TDD 证据

先新增 `tests/stable-json.test.js`：

```powershell
node --test tests/stable-json.test.js
```

实现前结果为 `0/3` 通过、`3/3` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/stable-json.js` 尚不存在。

完成最小实现并切换两处生产模块后，直接测试为 `3/3` 通过，分别验证：

- 嵌套对象键递归排序；
- 数组元素顺序保持不变，同时数组内对象仍稳定排序；
- `null`、字符串、数字、布尔值和 `undefined` 保持原生 JSON 语义。

## 模块边界

新增 `src/stable-json.js`，公开导出：

- `stableStringify`

拆分后：

- `src/stable-json.js` 为 12 行；
- `src/upstream.js` 从 4284 行降至 4272 行；
- `src/route-snapshot.js` 当前为 482 行；
- `tests/stable-json.test.js` 为 35 行；
- 两份私有 `stableStringify` 定义均已移除，调用方统一使用共享导入。

## 验证结果

- 稳定序列化红测：实现前 `0/3` 通过、`3/3` 按预期失败；
- 稳定序列化绿测：`3/3`；
- 稳定序列化、路由快照、上下文切换、历史持久化、上游代理和服务端联合回归：`251/251`；
- `npm run check:syntax`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`634/634`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 生产依赖审计：`0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `122.5` 秒；
- 本次 smoke 动态资源摘要：`28/0/3/0/3/0/2`。

本次 smoke 在当前运行环境中没有枚举到 apps 和 skills，但脚本自身判定通过，插件、MCP、市场和其余资源链正常；本轮没有桌面资源相关代码改动，因此将其记录为动态环境差异，不将其冒充为应用/技能实时可用性证明。smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning，两项均未导致失败。

## 主要修改文件

- `src/stable-json.js`
- `src/upstream.js`
- `src/route-snapshot.js`
- `tests/stable-json.test.js`
- `package.json`

## 后续边界

1. 路由快照校验和续跑策略保持原位，只共享稳定序列化算法。
2. 工具签名逻辑已不再依赖 upstream 私有序列化函数，下一批可以重新评估该纯签名家族的独立模块边界。
3. Electron 动态 apps/skills 发现结果需要与代码门禁分开解释，不能据此次 `0/0` 推断资源已被删除。
