# Router 整改记录 106：抽取能力 HTTP URL 安全规范化

## 整改目标

本轮只从 `src/upstream.js` 抽取 CodexBridge 能力参数解析中的纯 HTTP URL 规范化逻辑：

- 只允许显式 `http:` 与 `https:`；
- 为符合规则的裸域名、裸 IPv4 和无端口 `localhost` 补全 `https://`；
- 拒绝凭据、控制字符、空白、反斜杠、协议相对地址和根相对地址；
- 保留 URL 标准化后的大小写、默认端口及路径行为。

能力动作白名单、本地路径策略、参数字段映射、实际执行和错误展示继续留在 `src/upstream.js`。本轮不修改 Sol/Terra/Luna 路由、默认模型、智能故障切换、代理或用户密钥。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此改用静态定义、导入和调用面搜索：

- `normalizeBridgeHttpUrl` 有 5 个生产调用点，分别服务 browser、网页截图、OCR 和文件处理参数；
- `parseAllowedBridgeHttpUrl`、`looksLikeBareBridgeHttpUrl` 与 `isBridgeIpv4` 只在函数族内部调用；
- 新模块无导入，不读取 route、history、网络、代理或密钥状态；
- 参数解析函数继续负责把规范化失败转换为对应 capability/action 错误；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

## TDD 与调试证据

先新增 `tests/bridge-capability-url.test.js`：

```powershell
node --test tests/bridge-capability-url.test.js
```

实现前命令退出码为 `1`，测试文件在加载阶段按预期因 `ERR_MODULE_NOT_FOUND` 失败，因为 `src/bridge-capability-url.js` 尚不存在。

最小抽取后的首次运行是 `3/4`：测试错误地预期裸 `localhost:3000/health` 会被接受。根因调查确认原 upstream 与桌面本地能力实现都先用显式 scheme 正则处理字母开头加冒号的输入，因此该值原本就会被拒绝；无端口 `localhost` 才进入裸主机分支。本轮目标是不改变行为，所以只修正测试契约，没有扩大生产放行范围。

修正测试预期后，直接测试为 `4/4` 通过，分别验证：

- 显式 HTTP/HTTPS 的标准化；
- 裸域名、无端口 localhost 与 IPv4 的 HTTPS 补全；
- 危险协议、凭据、分隔符和控制字符拒绝；
- 单标签、双点、非法标签、非法端口和畸形 IPv4 拒绝。

## 模块边界

新增 `src/bridge-capability-url.js`，公开导出：

- `normalizeBridgeHttpUrl`

拆分后：

- `src/bridge-capability-url.js` 为 51 行；
- `src/upstream.js` 从 3964 行降至 3913 行；
- `tests/bridge-capability-url.test.js` 为 65 行；
- 原 URL 规范化函数族定义已从 `src/upstream.js` 移除；
- upstream 仍负责 capability/action 选择和错误返回。

## 验证结果

- URL 安全红测：退出码 `1`，按预期为目标模块缺失；
- 首次实现后契约纠偏：`3/4`，确认是测试误判既有 `localhost:port` 行为；
- 最终 URL 安全绿测：`4/4`；
- URL、能力转换、桌面本地能力、请求烟测、上游代理和服务端联合回归：`308/308`；
- `npm run check:syntax`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`652/652`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 生产依赖审计：`0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `87.1` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`。

smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning，两项均未导致失败。

## 主要修改文件

- `src/bridge-capability-url.js`
- `src/upstream.js`
- `tests/bridge-capability-url.test.js`
- `package.json`

## 后续边界

1. 动作白名单与本地路径属于下一层安全策略，本批没有同时迁移。
2. 桌面本地能力保留其现有 CommonJS 实现，本批没有跨模块强行统一 ESM/CJS。
3. 下一批可为 `parseBridgeCapabilityToolCall` 补齐动作和本地路径直接契约，再决定是否整体抽取参数解析器。
