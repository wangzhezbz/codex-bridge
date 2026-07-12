# CodexBridge 整改记录 34：内置“双倍额度”

日期：2026-07-12

## 本轮目标

将独立项目 ChatGPT Codex Bridge 以内置运行包方式接入 CodexBridge 桌面端，用户入口统一命名为“双倍额度”，并保持现有 15722 模型 Router、会话恢复和资源识别逻辑不变。

## 根因与边界

- 原 ChatGPT Codex Bridge 用户包面向独立安装，包含启动脚本和首次 `npm install` 流程，不适合作为桌面应用内置依赖。
- 新的 embedded 包提供稳定入口、健康协议、数据目录变量、扩展目录变量和优雅退出能力，因此宿主只需要管理独立 HTTP 子进程并修复 MCP 配置。
- “双倍额度”与模型 Router 是两条独立链路；本轮没有修改 `src/server.js`、`src/upstream.js` 或 15722 路由编排。

## 上游源码发布

- 仓库：`https://github.com/wangzhezbz/chatgpt-codex-bridge`
- 分支：`main`
- 首次提交：`2342faa8848a9e2779e3dccb4d2704216aa129d9`
- 标签：`v0.1.0`
- 上游全量测试：591 项通过，退出码 0。
- 嵌入专项提交前复验：36 项通过，退出码 0。

## 嵌入包审计

- 来源：`F:\game_code\bridge\release\ChatGPT-Codex-Bridge-Embedded-v0.1.0-20260712-082349`
- ZIP SHA-256：`2680E3E6F390F24107917E837C026799D700F697DEC211211D9B3D1138E9077E`
- 源嵌入包：42 个文件，907935 字节。
- 禁入目录命中：0。
- 密钥、Cookie、授权令牌和用户数据扫描命中：0。
- 宿主位置：`vendor/chatgpt-codex-bridge/`。

## 实现内容

1. 新增 `desktop/chatgpt-bridge-service.cjs`：
   - 校验 embedded manifest 的服务名和协议版本。
   - 默认端口 4317，端口配置原子持久化。
   - 使用 `process.execPath + ELECTRON_RUN_AS_NODE=1` 隐藏启动 HTTP 服务。
   - 通过 `/health` 确认 `chatgpt-codex-bridge` / protocol 1。
   - 兼容外部已启动服务，宿主只附着、不强杀。
   - 只停止宿主自己启动的子进程。
   - 将扩展复制到稳定数据目录并生成统一 `bridge-config.js`。
   - 备份并原子修复 `mcp_servers.chatgpt_codex_bridge`，保留其余 TOML。
2. 新增窄 IPC 与 preload API，只暴露状态、端口、启停、打开、扩展准备和 MCP 修复。
3. 新增独立侧边栏和页面，用户可见名称只使用“双倍额度”。
4. 增加宿主依赖 `@modelcontextprotocol/sdk` 和 `zod`，用户电脑不执行 `npm install`。
5. 新模块与测试加入 `npm run check` 正式门禁。

## 测试结果

- 服务管理单元测试：6/6 通过。
- 渲染器与IPC聚焦套件：54/54 通过。
- 本轮聚焦合并验证：60/60 通过。
- 历史恢复套件：14/14 通过。
- Electron desktop smoke：通过。
- Windows portable 打包：通过。
- Packaged smoke：通过。
- 实包运行：SDK 和 Zod 存在；`/health` 返回 ready；SIGTERM 后进程退出。
- Packaged vendor 为41个运行文件；Electron Packager prune 只移除了嵌套 `package-lock.json`，源码 vendor 仍为完整42文件。

## 已知但未扩大处理的既有门禁失败

`npm run check` 没有全绿，本轮未通过修改旧测试或 Router 行为来掩盖：

- Router 套件：3个 compact fallback 测试仍断言英文 `CodexBridge local compact fallback`，当前实现返回中文回退说明。
- Desktop 套件：4个既有失败，涉及 provider 兼容迁移旧预期、模式事务旧 provider 断言和两项发布验收证据。
- 上述失败不经过 `desktop/chatgpt-bridge-service.cjs`、`doubleQuota:*` IPC 或 vendor 运行入口。

## 回滚方法

如需撤销本轮内置功能，只回退本轮新增/修改的宿主文件和 `vendor/chatgpt-codex-bridge`，不要触碰 Router、会话数据库或用户 Codex 配置。已通过页面安装 MCP 的用户可从自动生成的 `config.toml.double-quota-*.bak` 恢复原配置。
