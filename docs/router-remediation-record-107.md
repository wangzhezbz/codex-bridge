# Router 整改记录 107：抽取 CodexBridge 能力参数解析器

## 整改目标

本轮从 `src/upstream.js` 抽取 `codexbridge_capability` 工具调用的纯参数解析与动作白名单逻辑：

- 校验工具参数必须是 JSON object；
- 统一 capability、action、providerId 与字段别名；
- 规范 browser、Computer Use、搜索、截图、OCR、文件、语音和视频请求；
- 在进入能力执行层前拒绝缺失必填字段、危险 URL 和未知动作。

能力供应商选择、远程请求、本地文件读取、错误脱敏、工具消息关联与聊天续跑继续留在原执行边界。本轮不修改 Sol/Terra/Luna 路由、默认模型、智能故障切换、代理或用户密钥。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此改用静态定义、导入、调用和数据流搜索：

- `parseBridgeCapabilityToolCall` 只有 `bridgeCapabilityToolMessage` 一个生产调用方；
- 解析器只依赖 `tryParseJson` 与上一批抽出的 `normalizeBridgeHttpUrl`；
- 成功结果进入既有 `executeCapabilityRequest`，解析模块本身不执行网络或本地操作；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

## 本地路径安全边界核查

抽取前沿真实调用链检查了 `server → capability provider registry → provider executor`：

- `local_file` adapter 进入独立的 Router/桌面本地文件执行器；
- 远程 `generic_http` 在构造 fetch 请求前调用 `validateRemoteServerCapabilityInput`；
- `file_processing` 输入包含 `path`、`filePath` 或 `localPath` 时，远程执行边界抛出 `remote_file_local_path_rejected`；
- 因此解析器允许表达显式本地路径，但远程供应商不会接收到该路径。

本轮没有把执行层校验移入解析器，也没有扩大本地路径或 URL 放行范围。

## TDD 证据

先新增 `tests/bridge-capability-request.test.js`：

```powershell
node --test tests/bridge-capability-request.test.js
```

实现前命令退出码为 `1`，测试文件在加载阶段按预期因 `ERR_MODULE_NOT_FOUND` 失败，因为 `src/bridge-capability-request.js` 尚不存在。

完成最小抽取并切换生产调用后，直接测试为 `10/10` 通过，覆盖：

- 非法 JSON、数组、null 与非 object 参数；
- browser read/open URL 及危险 URL 拒绝；
- Computer Use 应用列表、白名单启动、桌面截图和未知动作；
- 搜索、网页截图与 OCR 字段规范化；
- 远程文件 URL、本地文件路径、非法或缺失文件来源；
- 语音、视频必填文本和未知 capability/action。

解析器包含中文 Computer Use 安全提示；迁移使用显式 UTF-8 读取和差异匹配，最终定义与 UTF-8 文案均通过静态复核。

## 模块边界

新增 `src/bridge-capability-request.js`，公开导出：

- `parseBridgeCapabilityToolCall`

拆分后：

- `src/bridge-capability-request.js` 为 296 行；
- `src/upstream.js` 从 3913 行降至 3619 行；
- `tests/bridge-capability-request.test.js` 为 235 行；
- 原解析器定义已从 `src/upstream.js` 移除；
- upstream 只通过一个公开入口消费解析结果。

## 验证结果

- 参数解析红测：退出码 `1`，按预期为目标模块缺失；
- 参数解析绿测：`10/10`；
- 能力解析、URL、结果序列化、供应商选择、转换、桌面本地能力、请求烟测、上游代理和服务端联合回归：`332/332`；
- `npm run check:syntax`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`662/662`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 生产依赖审计：`0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `96.4` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`。

根项目审计首次遇到 npm registry TLS 握手中断；`npm ping` 随后在 705ms 返回 PONG，根项目审计按原命令重跑后退出 `0`。没有修改 registry、依赖或网络配置。

smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning，两项均未导致失败。

## 主要修改文件

- `src/bridge-capability-request.js`
- `src/upstream.js`
- `tests/bridge-capability-request.test.js`
- `package.json`

## 后续边界

1. 远程本地路径拒绝仍是 server 执行边界职责，不应仅依赖模型提示词。
2. 能力执行、provider fallback 和错误响应仍留在 upstream/server，不继续机械拆分。
3. 下一批应重新扫描 `src/upstream.js` 剩余 3619 行，优先选择无 history、无网络生命周期且调用面单一的纯函数族。
