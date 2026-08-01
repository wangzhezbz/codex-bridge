# Router 整改记录 121：Windows Portable 包内容加固

## 整改目标

冻结 ChatGPT Bridge 后续调整，不再改动其服务、扩展或专项测试；本批只处理 Windows Portable 包中的开发残留、敏感本地配置和发布前内容审计。

本批不改变模型路由、默认模型、故障转移、代理或用户 API Key；不生成 Setup、不签名、不推送、不发布。

## 已完成

### 1. 可执行包内容策略

新增 `scripts/package-content-policy.mjs`，统一定义 Windows 包的禁止内容：

- `docs/router-remediation-record-*.md` 整改记录；
- 任意目录下的 `.map` 源码映射；
- `test`、`tests`、`__tests__` 开发测试树；
- `.env` 及其环境变体；
- `.pem`、`.key`、`.p12`、`.pfx` 私钥/证书容器；
- `config/router.config.json`、`config/secrets.local.json` 本地运行配置；
- SQLite 状态备份和旁路文件。

策略保留 Router/Desktop 运行代码、生产依赖、公开示例配置、README 和用户文档。

### 2. 打包前排除与打包后二次阻断

- `scripts/package-windows.mjs` 将统一策略直接加入 Electron Packager ignore；
- `scripts/smoke-packaged-windows.mjs` 在启动应用前枚举真实 `resources/app` 文件；
- 若发现任一违规文件，packaged smoke 立即以 `forbidden_package_content` 失败；
- 成功报告新增 `packageContent`，记录检查文件数和违规数；
- 失败终端只显示前 10 项摘要，完整违规数组保留给程序读取但不再刷屏。

### 3. TDD 与固定门禁

新增 `tests/package-content-policy.test.js`，覆盖：

- 开发残留和敏感材料必须排除；
- 运行代码、依赖和公开示例必须保留；
- 审计结果包含稳定规则 ID 与相对路径；
- 干净文件集返回机器可读统计，违规文件集抛出结构化错误；
- 策略模块和测试必须进入固定语法、Desktop 门禁。

测试按 RED → GREEN 执行，最终专项 `5/5` 通过。

## 真实包对比

旧 Batch 119：

- 应用资源文件：`4309`；
- 应用资源体积：`35454731` 字节；
- Portable 总文件：`4383`；
- Portable 总体积：`376969312` 字节；
- 违规文件：`921`，其中 `.map` `582`、测试树 `230`、整改记录 `109`。

新 Batch 121：

- 应用资源文件：`3389`；
- 应用资源体积：`27652092` 字节；
- Portable 总文件：`3463`；
- Portable 总体积：`369166673` 字节；
- 违规文件：`0`；
- 净减少文件：`920`；
- 净减少体积：`7802639` 字节。

新应用目录：

```text
F:\game_code\router\release\CodexBridge-Windows-x64-Portable-v0.3.13-batch121-20260801-215001\CodexBridge-win32-x64
```

新 smoke 报告：

```text
F:\game_code\router\release\CodexBridge-Windows-x64-Portable-v0.3.13-batch121-20260801-215001\packaged-smoke-report.json
```

## 验证证据

- 包内容策略专项：`5/5` 通过；
- `npm run check`：退出码 `0`；
- Router：`684/684`；
- Desktop：`910/910`；
- Recovery：`16/16`；
- `npm run package:win`：退出码 `0`；
- 新包内容审计：检查 `3389` 个文件，违规 `0`；
- `npm run package:win:smoke`：退出码 `0`；
- `npm run desktop:smoke`：退出码 `0`；
- package-naming：`47/47`；
- `npm run release:code-ready`：通过 `16`、提醒 `6`、失败 `0`；
- `git diff --check`：通过。

## 剩余边界

- 本批没有处理 Windows 代码签名；需要有效证书和正式发布身份后单独接入；
- 新产物是本地 Portable 应用目录，没有生成 ZIP 或 Setup；
- `release:code-ready` 的 6 个提醒属于真实环境或本机配置证据，不代表已完成真实供应商、升级安装或签名验收；
- ChatGPT Bridge 在本批保持冻结，没有继续做服务或扩展调整。

本批没有删除、重置、清理、暂存、提交、推送或发布任何仓库内容。
