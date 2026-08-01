# Router 整改记录 76：本地入口鉴权与自动化门禁加固

## 整改目标

本轮处理项目整体扫描中可以立即落地、且不改变供应商路由行为的高优先级风险：

- 消除桌面生成配置中的共享固定 Router Token
- 阻止浏览器跨站调用本地 Router
- 防止 `all_api` 模式接受任意 Bearer Token
- 让完整项目检查和 Windows CI 覆盖供应商模型刷新流程
- 修复桌面 smoke 对异步资源快照的误判

本轮不修改 GPT-5.6 Sol、Terra、Luna 的选择、推荐、自动切换或失败回退行为，
也不修改用户保存的供应商 API Key。

## 根因

1. 桌面端生成的 Router 配置和 Codex TOML 使用公开固定字符串作为本地入口
   Token；同机进程知道该字符串后可以直接调用 Router。
2. Router 返回 `Access-Control-Allow-Origin: *`，没有拒绝非可信浏览器
   `Origin`；这扩大了恶意网页访问本地服务的攻击面。
3. `all_api` 模式允许任意非空 OpenAI Bearer Token 通过本地入口鉴权。
4. `npm run check` 和 Windows CI 没有完整覆盖供应商模型刷新流程。
5. 桌面 smoke 把资源页首次渲染与随后独立读取的资源结果当作同一原子快照；
   Codex app-server 较慢或返回阶段性结果时会产生假失败。

## 修复内容

1. 桌面端为每个数据根目录生成并复用随机 `cbr_` Token，同时写入 Router
   配置和 Codex TOML；检测到旧固定 Token 时自动迁移。
2. 源码部署示例改为通过 `CODEXBRIDGE_ROUTER_TOKEN` 环境变量提供 Token；
   缺失 Token 时默认拒绝请求，仅显式开启匿名 loopback 时例外。
3. `all_api` 模式只接受与 Router 配置完全相同的本地 Token，不再把任意
   Bearer Token 当作已认证。
4. 带浏览器 `Origin` 的请求默认拒绝；只有配置在
   `clientAuth.allowedOrigins` 的规范化精确来源才获得对应 CORS 响应头。
   不带 `Origin` 的 Codex、桌面端和其他原生客户端请求保持原有链路。
5. 项目语法检查、桌面测试脚本和 Windows CI 纳入
   `provider-model-refresh-flow`。
6. 桌面 smoke 实际点击“刷新资源”并等待动作完成。实时环境校验资源摘要
   已完整有效渲染；只有传入固定资源快照夹具时才比较精确计数，避免比较两个
   独立的最终一致性读取。

## 主要修改文件

- `.github/workflows/desktop-portable.yml`
- `package.json`
- `src/server.js`
- `desktop/settings.mjs`
- `desktop/codex-provider.mjs`
- `desktop/config-mutation.mjs`
- `desktop/main.cjs`
- `config/router.config.example.json`
- `config/router.config.hybrid.example.json`
- `README.md`
- `tests/server.test.js`
- `tests/desktop-settings.test.js`
- `tests/desktop-codex-provider.test.js`
- `tests/desktop-config-mutation.test.js`
- `tests/desktop-config-transaction.test.js`
- `tests/desktop-mode-transaction.test.js`
- `tests/package-naming.test.js`

## 验证结果

- 新增门禁测试均先失败、修复后通过。
- Router 受影响回归：`139/139` 通过。
- 桌面配置、模式和供应商定向回归：`35/35` 通过。
- 包装与发布门禁测试：`47/47` 通过。
- 桌面配置事务回归：`31/31` 通过。
- 真实桌面 smoke 通过，Electron 退出码为 `0`：
  - 供应商预览：`19`
  - 插件：`28`
  - 插件 MCP：`3`
  - 市场：`3`
  - 资源页刷新、会话页和统计页导航均完成
- 项目完整 `npm run check` 和 `git diff --check` 通过。

## 后续风险

本轮没有宣称项目已经完成全部安全整改。以下事项仍需按优先级继续处理：

1. Electron Windows sandbox 默认关闭，窗口导航、新窗口和 IPC 权限还需系统加固。
2. 自动更新目前主要校验文件头和大小，仍需加入可信发布签名或强哈希校验。
3. 上游非流式与流式响应仍需统一的体积、时间和背压上限。
4. 生产依赖审计仍有漏洞，需要逐项确认升级兼容性，不能直接批量升级。
5. `desktop/settings.mjs`、`desktop/main.cjs`、`desktop/renderer/app.js` 和
   `src/upstream.js` 体积过大，后续应按配置事务、资源发现、更新和协议适配边界拆分。

桌面 smoke 期间 Chromium 可能报告 GPU 缓存目录拒绝访问；当前不影响退出码和
功能验收，但应作为测试环境噪声与缓存目录权限问题单独跟踪。
