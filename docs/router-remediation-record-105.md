# Router 整改记录 105：抽取能力执行结果序列化

## 整改目标

本轮只从 `src/upstream.js` 抽取 CodexBridge 能力执行成功后的纯结果序列化逻辑：

- 统一能力、供应商和输出文本字段；
- 规范图片、音频、视频、文件及来源字段别名；
- 限制返回给聊天模型的来源列表数量；
- 保留本地保存结果对上游字段的覆盖关系。

能力调用识别、参数解析、URL 安全校验、实际执行、失败脱敏和第二次聊天请求继续留在 `src/upstream.js`。本轮不修改 Sol/Terra/Luna 路由、默认模型、智能故障切换、代理或用户密钥。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此改用静态定义、导入和调用面搜索：

- `bridgeCapabilityToolContent` 只有 `bridgeCapabilityToolMessage` 一个生产调用方；
- `bridgeCapabilityResultData` 只服务于成功结果规范化，保留为新模块私有函数；
- 新模块只依赖既有 `stringifyJson`，不读取 route、history、网络、代理或密钥状态；
- 错误工具消息继续留在 upstream，避免把 `safeText` 脱敏策略扩散到纯结果模块；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

## TDD 证据

先新增 `tests/bridge-capability-result.test.js`：

```powershell
node --test tests/bridge-capability-result.test.js
```

实现前命令退出码为 `1`，测试文件在加载阶段按预期因 `ERR_MODULE_NOT_FOUND` 失败，因为 `src/bridge-capability-result.js` 尚不存在；三个测试用例尚未进入执行阶段。

完成最小实现并切换生产调用后，直接测试为 `3/3` 通过，分别验证：

- response 包装结果的字段别名、来源上限及本地字段覆盖；
- outer result 与 `upstream` 数据的兼容回退；
- 只有 handled 且非 skipped/failed 的结果才标记为成功。

## 模块边界

新增 `src/bridge-capability-result.js`，公开导出：

- `bridgeCapabilityToolContent`

拆分后：

- `src/bridge-capability-result.js` 为 55 行；
- `src/upstream.js` 从 4017 行降至 3964 行；
- `tests/bridge-capability-result.test.js` 为 108 行；
- 原成功结果序列化函数定义已从 `src/upstream.js` 移除；
- upstream 仍负责能力执行时机、失败转换和工具消息关联。

## 验证结果

- 结果序列化红测：退出码 `1`，按预期为目标模块缺失；
- 结果序列化绿测：`3/3`；
- 结果序列化、能力代理、转换、请求烟测、上游代理和服务端联合回归：`301/301`；
- `npm run check:syntax`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`648/648`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 生产依赖审计：`0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `103.4` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`。

并行补充审计首次遇到 npm registry TLS 握手中断；`npm ping` 随后在 1122ms 返回 PONG，两项审计按原命令分别重跑后均退出 `0`。没有修改 registry、依赖或网络配置。

smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning，两项均未导致失败。

## 主要修改文件

- `src/bridge-capability-result.js`
- `src/upstream.js`
- `tests/bridge-capability-result.test.js`
- `package.json`

## 后续边界

1. 能力参数解析和 URL 安全校验属于独立安全边界，本批没有顺手迁移。
2. 错误工具消息继续使用 upstream 的 `safeText` 脱敏，避免成功结果模块承担错误展示策略。
3. 下一批可评估能力调用参数解析函数族，但必须先补齐 URL、local path 和动作白名单的直接安全契约测试。
