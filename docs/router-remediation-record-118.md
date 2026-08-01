# Router 整改记录 118：锁定内嵌 Bridge 跨域边界并更新 Electron 事件接口

## 整改目标

闭环第 116 批发现的两个实质问题：

1. 阻止不可信网页跨域访问回环地址上的内嵌 Bridge；
2. 将 Desktop 控制台监听器迁移到 Electron 39 当前事件对象接口。

## CORS TDD 证据

先新增 `tests/vendor-http-server-security.test.js`，覆盖恶意网页、可信 ChatGPT、合法 Chrome 扩展、同源本地页面和无 Origin 本地客户端。

实现前直接测试为 `0/3`：

- 恶意来源实际返回 `200`，预期 `403`；
- 可信来源实际收到 `Access-Control-Allow-Origin: *`；
- 无 Origin 客户端也收到通配符响应头。

最小实现后，首次绿色验证暴露 Node WHATWG URL 对 `chrome-extension:` 返回 `origin === "null"`，导致合法扩展被误拒。通过单独诊断确认来源后，只调整扩展协议的规范化判断；最终为 `3/3`。

## Electron TDD 证据

先新增 `tests/desktop-renderer-console-message.test.js`，要求：

- `warning` 和 `error` 生成与原行为一致的错误日志；
- `debug` 和 `info` 被忽略；
- 使用新事件字段 `level/message/sourceId/lineNumber`。

实现前按预期因 `desktop/renderer-console-message.cjs` 不存在而失败。新增纯格式化模块并把 `desktop/main.cjs` 监听器切换到单参数事件对象后为 `2/2`。

## 修改内容

- `vendor/chatgpt-codex-bridge/src/http-server.js`
  - 删除通配符 CORS；
  - 只回显 `https://chatgpt.com`、合法 32 位 Chrome 扩展 ID 和当前 Host 的同源 HTTP Origin；
  - 对其他浏览器 Origin 返回 `403` 且不附加允许跨域响应头；
  - 保留无 Origin 的本地原生客户端访问能力。
- `desktop/renderer-console-message.cjs`
  - 新增可独立测试的新事件对象格式化逻辑。
- `desktop/main.cjs`
  - 使用 Electron 39 的 `console-message(details)` 签名。
- `package.json`
  - 把两个新模块、两个新测试和 vendor HTTP 服务纳入 `check:syntax`；
  - 把两个新测试纳入 `test:desktop`。

## 验证结果

- 两组新增直接契约：`5/5`；
- 相关 Desktop/Bridge 联合回归：`81/81`；
- `check:syntax`：退出码 `0`；
- 全仓 `npm run check`：退出码 `0`；
- Electron desktop smoke：退出码 `0`，不再出现 `console-message` 弃用警告；
- vendor 通配符 CORS 静态复扫：`0`；
- 旧五参数监听签名静态复扫：`0`。

smoke 仍输出 Node SQLite experimental warning；这是当前 Node 运行时提示，不是本轮 Electron 事件兼容问题，也不影响退出码。

## 行为边界

- 不给任意 Origin 返回跨域权限；
- 不要求 curl、Node 或桌面主进程等无 Origin 本地客户端伪造浏览器来源；
- 不修改 Bridge API 路由和数据结构；
- 不修改 Router 模型、认证、代理和故障转移行为。
