# Router 整改记录 119：全新 Windows Portable 测试包交付

## 交付目标

基于第 117/118 批已经收口的当前工作树生成一个全新的本地 Windows Portable 测试包，运行打包后 smoke，检查 ZIP 关键内容并计算 SHA-256。

本批不复用旧包，不生成 Setup.exe，不修改源代码，不提交、不推送、不打标签、不发布。

## 打包预检

- 当前分支：`codex/all-model-contract-lock`，不是 `main`；
- `scripts/package-windows.mjs` 使用时间戳版本目录和 `overwrite: false`；
- 打包脚本没有递归删除逻辑；
- `.git`、测试、旧 release、dist、coverage、data、logs、真实 Router 配置、local secret 和模型缓存均在排除范围；
- 当前未跟踪内容属于本轮源码、测试和整改记录，没有发现要随包排除的运行密钥或临时数据。

## 新包路径

应用目录：

```text
F:\game_code\router\release\CodexBridge-Windows-x64-Portable-v0.3.13-batch119-20260801-185732\CodexBridge-win32-x64
```

可交付 ZIP：

```text
F:\game_code\router\release\CodexBridge-Windows-x64-Portable-v0.3.13-batch119-20260801-185732-artifacts\CodexBridge-Windows-x64-Portable.zip
```

## 验证证据

- `npm run package:win`：退出码 `0`；
- 打包 Electron：`39.8.10`，平台 `win32 x64`；
- `npm run package:win:smoke`：退出码 `0`；
- smoke 明确目标：新目录中的 `CodexBridge.exe`；
- smoke 报告：新包目录下的 `packaged-smoke-report.json`；
- ZIP 大小：`152436065` 字节；
- ZIP 条目：`4429`；
- ZIP 包含 `CodexBridge.exe`：是；
- ZIP 包含 `resources/app/src/server.js`：是；
- ZIP SHA-256：`B17CDBA88AF3886AD4E5DCCBCD42D49DD9FF25349DAFDF8C48AF47B4B4CE8716`。

## 边界

打包 smoke 证明当前 Windows Portable 应用能够启动 Desktop、启动本地 Router 并通过固定的历史恢复和资源合并验收。它不代替真实 Sol/其他供应商账号、地区、代理、额度和上游完整响应验证。

本批没有删除、重置、清理、暂存、提交、推送或发布任何仓库内容。
