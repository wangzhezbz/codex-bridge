# Router 整改记录 116：最终高风险入口审计与 stop/go 决策

## 审计目标

在不继续机械拆分 `src/upstream.js` 的前提下，对 Router、Desktop 和内嵌 ChatGPT Bridge 的高风险入口做最终复扫，只把有明确安全或兼容收益的问题送入预留整改批次。

本轮不修改模型选择、Sol/Terra/Luna 路由、故障转移、代理、API Key 或用户配置。

## 审计方法

当前仓库没有 `.gitnexus` 索引，也没有可用的 `gitnexus` 命令，因此采用静态定义/调用搜索、固定门禁覆盖检查和 Electron 本机冒烟证据：

- 搜索动态代码执行、`shell: true`、敏感信息日志和危险批量删除命令；
- 复核主 Router 与 vendor 本地 HTTP 服务的认证和跨域边界；
- 复核 `src/upstream.js` 的模块级可变状态和剩余职责；
- 搜索 TODO/FIXME/HACK/XXX；
- 对照本机 Electron 39 类型定义检查弃用事件签名；
- 检查新发现入口是否已经进入 `check:syntax` 和固定测试套件。

## 结果

未发现以下新增问题：

- 动态 `eval` / `new Function`；
- `shell: true`；
- API Key、Token 或 Secret 的显式控制台输出；
- 源码 TODO/FIXME/HACK/XXX；
- 新的批量删除命令；
- `src/upstream.js` 顶层共享可变单例。

发现两项值得执行预留第 118 批的实质问题：

1. `vendor/chatgpt-codex-bridge/src/http-server.js` 对所有响应发送 `Access-Control-Allow-Origin: *`。服务默认监听回环地址但提供多项可改变本地状态的 `/api` 路由，恶意网页可跨域调用并读取结果。
2. `desktop/main.cjs` 仍使用 Electron `webContents` 的五参数 `console-message` 旧签名。本机 Electron 39 冒烟会输出弃用警告，类型定义已经提供单事件对象的新签名。

## stop/go 决策

- `src/upstream.js`：**STOP**。剩余体积本身不构成必须继续拆分的风险，既有 Router 契约和职责边界已经由固定套件覆盖。
- vendor CORS：**GO**。属于明确的本地服务安全边界，修复面可由三类 Origin 契约完整覆盖。
- Electron 控制台事件：**GO**。属于已在本机复现的兼容性警告，适合用纯函数契约和实机 smoke 验证。

因此激活预留第 118 批，完成后再进入第 117 批最终验收。

## 工作树边界

- 保留继承的脏工作树；
- 没有重置、清理、覆盖或删除已有内容；
- 没有暂存、提交、推送、打包或发布；
- 没有改变模型与路由策略。
