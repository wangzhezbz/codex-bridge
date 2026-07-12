# CodexBridge 整改记录 36：双倍额度嵌入包更新与版本协议检查

日期：2026-07-12

## 输入包

- 文件：`F:\game_code\bridge\release\ChatGPT-Codex-Bridge-Embedded-v0.1.0-20260712-104653.zip`
- SHA-256：`EC43782388F1CDC5434B38F5A7DF37972B3EFD6C50773C047625AFACF3C5A7CF`
- 文件数：42
- 解压后总字节：912166
- 禁止目录命中：0
- 密钥/私钥模式命中：0

## 差异审计

新旧嵌入包路径集合完全一致，不需要删除文件。34 个文件哈希未变，8 个运行文件更新：

- `chrome-extension/content-script.js`
- `public/app.js`
- `public/index.html`
- `public/styles.css`
- `src/preference-compat.js`
- `src/service-metadata.js`
- `src/task-store.js`
- `src/gpt-transports/transport-registry.js`

覆盖后 vendor 42/42 文件与 ZIP 条目哈希一致。

## 宿主集成修改

1. `desktop/chatgpt-bridge-service.cjs` 新增独立 `/version` 读取：
   - 验证服务名与 protocolVersion；
   - 读取并返回 serviceVersion；
   - 读取并返回 extensionProtocolVersion；
   - 当前协议为 `v20260712-preference-verify`。
2. “双倍额度”页面在嵌入版本旁显示扩展协议。
3. HTTP 子服务和 MCP 配置的 `BRIDGE_ROUTER_V2` 均改为 `0`，保持第一版关闭状态，不接管 Bridge 内部 Router。
4. 继续使用用户数据目录下的稳定扩展副本：
   - vendor/chrome-extension 是只读源；
   - 用户安装目录是 `<CodexBridge数据目录>/chatgpt-bridge-extension`；
   - 修改端口时只更新稳定副本的 bridge-config.js；
   - 避免程序升级路径改变导致 Chrome 扩展失效，也避免写入只读安装目录。
5. 子服务仍使用宿主 Electron Node、`windowsHide=true`、健康就绪检查、SIGTERM 优雅退出和超时兜底；只停止宿主拥有的子进程。

## 验证

- 宿主服务单元测试：7/7 通过。
- 双倍额度 renderer 聚焦测试：通过。
- CodexBridge 相关合并套件：147/148 通过；唯一失败仍是既有 release preflight 真实验收证据测试，与双倍额度链路无关。
- vendor JavaScript 语法：35/35 通过。
- 实际 HTTP 生命周期：
  - 随机宿主端口启动成功；
  - `/health` 返回 ready；
  - `/version` 返回 0.1.0 / protocol 1 / `v20260712-preference-verify`；
  - 数据目录与扩展目录均由宿主传入；
  - SIGTERM 后状态为 stopped；
  - CodexBridge Router 示例配置哈希前后一致。
- 上游源仓全量测试：597/597 通过，0 失败。

## 上游 Git

- 仓库：`https://github.com/wangzhezbz/chatgpt-codex-bridge`
- 分支：`main`
- 本轮提交：`cf06e7c1e4341842775ea2764a7401dd6a9ade24`
- 远端 main 已回读为相同提交。

## 未改边界

- 未修改 CodexBridge 15722 Router。
- 未把 Bridge Router、模型同步或 Chrome 状态机重写到宿主。
- 未接入 ChatGPT 私有 OAuth、Cookie 或私有 backend-api。
- 未修改会话 provider 和历史恢复逻辑。
