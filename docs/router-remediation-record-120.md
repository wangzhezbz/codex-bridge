# Router 整改记录 120：本地 Bridge 请求边界加固

## 整改目标

对只监听回环地址的 ChatGPT/Codex Bridge 增加纵深防御，收口 DNS 重绑定、宽泛跨域、未认证扩展调用、敏感下载导入和无界 JSON/Base64 请求体风险。

本批不改变 Sol、Terra、Luna 或其他模型的路由、默认模型、故障转移、代理与用户 API Key；不打包、不发布。

## 已完成

### 1. Host 与跨域边界

- HTTP 请求只接受当前监听端口上的 `127.0.0.1`、`localhost` 和 `[::1]` Host；
- 伪造 Host 即使携带与之匹配的 Origin 也返回 `403`；
- 移除 `Access-Control-Allow-Origin: *`；
- 仅允许 ChatGPT、语法有效的 Chrome 扩展 Origin 和 Bridge 自身同源页面，并按请求回显可信 Origin。

### 2. 每安装认证 Token

- Desktop 首次加载双倍额度配置时生成 64 位十六进制随机 Token，后续启动持久复用；
- Token 仅写入本机双倍额度配置和部署后的扩展配置，不进入 Desktop 状态返回；
- Desktop 通过 `BRIDGE_AUTH_TOKEN` 传给 Bridge 子进程，诊断请求使用 `X-CodexBridge-Token`；
- Content Script 和 Background 下载导入统一通过 `bridge-auth.js` 添加认证头；
- Token 比较使用定长比较，跨域 API 缺失或错误 Token 返回 `401`。

### 3. 敏感导入与请求体上限

- `/api/downloads/import` 在配置了 Token 后无论请求是否同源都必须认证，避免把下载文件路径/内容导入能力暴露给无认证调用者；
- JSON 请求体默认上限为 32 MiB，可通过 `BRIDGE_MAX_JSON_BODY_BYTES` 或服务选项调整；
- 同时校验 `Content-Length` 和实际流式接收字节数，超限返回 `413`，不再继续进入业务处理。

### 4. 固定门禁

- 新增 `tests/bridge-extension-auth.test.js`，以 VM 执行真实扩展认证脚本；
- 扩充 `tests/vendor-http-server-security.test.js`，覆盖 Host、CORS、Token、敏感导入和请求体上限；
- 扩充 `tests/desktop-chatgpt-bridge-service.test.js`，覆盖 Token 持久化、不泄露、扩展部署、诊断头和子进程环境变量；
- 新测试已接入 `test:desktop`，新增脚本和测试已接入 `check:syntax`。

## 验证证据

- 扩展认证专项：`3/3` 通过；
- HTTP 安全专项：`7/7` 通过；
- Desktop Bridge Service：`24/24` 通过；
- `npm run check`：退出码 `0`；
- Router 固定门禁：`684/684` 通过；
- Desktop 固定门禁：`905/905` 通过；
- Recovery：`16/16` 通过；
- `npm run desktop:smoke`：退出码 `0`，Electron Desktop、资源合并与页面加载通过；
- `git diff --check`：通过。

## 剩余边界

- 同源 Bridge 管理页面和本机非浏览器客户端仍保留既有 API 能力；本批重点阻断浏览器跨域、DNS 重绑定和扩展敏感导入攻击面，没有把整个管理 UI 改造成登录系统；
- 32 MiB 上限保护 JSON/Base64 请求，不代替操作系统级内存、磁盘配额或速率限制；
- Electron smoke 是本机应用级证据，不等于真实 ChatGPT 页面、真实 Chrome 已加载扩展或真实供应商账号链路验收。

本批没有删除、重置、清理、暂存、提交、推送、打包或发布任何仓库内容。
