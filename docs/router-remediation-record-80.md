# Router 整改记录 80：生产依赖漏洞清零与 CI 审计门禁

## 整改目标

本轮处理整体扫描中剩余的生产依赖安全风险，同时保持升级范围最小：

- 修复根项目生产依赖树中的已知漏洞。
- 修复内嵌 `vendor/chatgpt-codex-bridge` 独立锁文件中的已知漏洞。
- 验证 MCP Server、ASAR 和真实 Electron 桌面链路兼容。
- 将生产依赖审计接入 Windows、macOS 构建工作流。

本轮没有升级 Electron 主版本、Undici 主版本，没有修改模型路由、参数转换、自动切换、失败回退或用户供应商凭据。

## 修复前基线

### 根项目

`npm audit --omit=dev` 报告：

- 高危：`2`
- 中危：`2`
- 合计：`4`

依赖路径：

- `@modelcontextprotocol/sdk@1.29.0` → `@hono/node-server@1.19.14`
- `@modelcontextprotocol/sdk` / AJV → `fast-uri@3.1.3`
- `@electron/asar` / minimatch → `brace-expansion@5.0.6`

### 内嵌 Bridge

`vendor/chatgpt-codex-bridge` 的生产审计同样报告 `4` 项：

- `@hono/node-server` Windows 编码反斜杠路径穿越
- `fast-uri` 主机解析混淆
- `hono` 重复请求头、请求上下文隔离和 JSX 转义问题

## 定向升级

### 根项目锁定结果

- `@modelcontextprotocol/sdk`：`1.29.0` → `1.30.0`
- `@hono/node-server`：`1.19.14` → `2.0.12`
- `fast-uri`：`3.1.3` → `3.1.4`
- `brace-expansion`：`5.0.6` → `5.0.9`
- `hono`：保留已安全的 `4.12.29`

### 内嵌 Bridge 锁定结果

- `@modelcontextprotocol/sdk`：`1.29.0` → `1.30.0`
- `@hono/node-server`：`1.19.14` → `2.0.12`
- `fast-uri`：`3.1.2` → `3.1.4`
- `hono`：`4.12.26` → `4.12.32`

项目要求 Node.js `>=22.16.0`，满足新 `@hono/node-server` 的 Node.js `>=20` 和 `brace-expansion` 的 Node.js `20 || >=22` 要求。

## 持续门禁

新增命令：

```powershell
npm run audit:prod
```

该命令依次审计：

1. 根项目生产依赖
2. `vendor/chatgpt-codex-bridge` 生产依赖

`.github/workflows/desktop-portable.yml` 的 Windows 和 macOS 作业都在安装依赖后、测试或打包前执行该门禁。

## 验证结果

- 根项目生产依赖审计：`0` 漏洞
- 内嵌 Bridge 生产依赖审计：`0` 漏洞
- 根项目完整依赖审计：`0` 漏洞
- MCP 1.30 `McpServer` 真实构造：通过
- ASAR 创建、列举和提取 smoke：通过
- Bridge、桌面渲染器与打包规则定向测试：`129/129`
- 项目完整 `npm run check`：通过
- 桌面测试：`892/892`
- 历史恢复测试：`16/16`
- 真实 Windows Electron smoke：退出码 `0`
- smoke 资源摘要：`28/2/3/46/3/0/2`
- `git diff --check`：通过
- 删除文件检查：无删除

审计收尾时，在并发访问 npm Registry 的情况下出现过一次 TLS 连接建立前断开；单独重跑正式 `npm run audit:prod` 后根项目和内嵌 Bridge 均成功返回 `0` 漏洞，因此没有通过忽略退出码或降低审计级别绕过。

## 主要修改文件

- `package.json`
- `package-lock.json`
- `vendor/chatgpt-codex-bridge/package.json`
- `vendor/chatgpt-codex-bridge/package-lock.json`
- `.github/workflows/desktop-portable.yml`

## 后续风险

1. `npm audit` 是随安全公告变化的时间点结果，CI 门禁必须继续保留。
2. Electron `39` 到当前新主版本属于高风险升级，应单独安排窗口、验证 Windows/macOS 打包和窗口安全策略，不能混入本轮。
3. Undici 后续补丁升级应围绕代理、SSE、超时和取消语义单独验证。
4. `src/upstream.js`、`desktop/settings.mjs` 和 `desktop/main.cjs` 仍需按职责逐步拆分。
