# 发布与下载

## 最新下载

### Windows

- **推荐·安装版：** [CodexBridge-Windows-x64-Setup.exe](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Setup.exe)
- **免安装版：** [CodexBridge-Windows-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Portable.zip)

### macOS

- **M 系列芯片：** [CodexBridge-macOS-arm64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-arm64-Portable.zip)
- **Intel 芯片：** [CodexBridge-macOS-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-x64-Portable.zip)

macOS 提示“已损坏”或无法打开时，先把 `CodexBridge.app` 放到“应用程序”，然后打开“终端”执行下面命令，输入电脑密码并回车：

```bash
sudo xattr -cr /Applications/CodexBridge.app
```

历史版本：

[GitHub Releases](https://github.com/wangzhezbz/codex-bridge/releases)

## v0.3.3

- 修复 Windows 用户目录、中文用户名及目录联接场景下的配置写入与恢复失败。
- 修复双倍额度服务因扩展目录不存在而无法启动，并让扩展准备失败降级为可诊断状态。
- 修复旧版自定义模型保存入口、失效模型引用修复和模型选择保存失败。
- 优化模型选择保存：提交成功后只回读轻量状态，不再同步扫描资源、会话和能力数据。
- 补充配置事务、双倍额度服务、主进程 IPC 与 Renderer 回归测试。

## v0.3.2

- 修复 CodexBridge 打开后长时间无响应的问题。
- 将 Codex CLI、prompt-input 和 app-server 资源探测移至独立 Worker，长扫描期间不再阻塞桌面主线程。
- Router 启动和停止不再等待完整资源扫描或占用配置事务队列。
- 状态广播固定使用轻量快照，避免进入资源页后所有后续广播都重复执行完整扫描。
- 取消启动时自动逐项目恢复，保留会话页的显式手动恢复入口。
- 完整 Router、Desktop、历史恢复、打包后 Windows smoke 均已通过。

## v0.3.1

- 兼容新版 ChatGPT/Codex 桌面端，并保留旧版 Codex 启动支持。
- 修复 Router 配置事务、启动、停止、恢复和健康检查链路。
- 修复历史会话 provider 作用域及项目可见性问题。
- 改进模型能力、资源、插件、应用、MCP 和技能诊断。
- 修复 GPT 原生生图与自定义图片供应商路由。
- 新增“双倍额度”独立页面，内置 ChatGPT-Codex-Bridge 服务、Chrome 扩展和 MCP 管理。
- 双倍额度 MCP 自动继承当前 Codex 任务 ID，保持任务和项目隔离。
- 优化 Router 开关响应，不再让资源与会话详细扫描阻塞按钮。
- 更新 Windows 安装、便携更新和跨平台发布流程。

## Package Naming / 包名规范

GitHub Release assets use a stable package name so tutorials can keep one latest-download link:

GitHub Release 附件使用稳定包名，教程里可以固定引用最新版下载链接：

```text
CodexBridge-Windows-x64-Portable.zip
CodexBridge-Windows-x64-Setup.exe
CodexBridge-macOS-arm64-Portable.zip
CodexBridge-macOS-x64-Portable.zip
```

The extracted release folder includes the tag/version:

解压后的 release 目录包含 tag/版本号：

```text
CodexBridge-Windows-x64-Portable-v0.1.10
CodexBridge-macOS-arm64-Portable-v0.1.10
CodexBridge-macOS-x64-Portable-v0.1.10
```

## Release Checklist / 发布检查

Before tagging a release:

发布打 tag 前：

```powershell
npm run release:preflight
npm run release:code-ready
npm run check
npm run package:win
npm run package:win:smoke
npm run package:mac
npm run package:mac:smoke
```

`npm run release:code-ready` is the local code readiness gate. It still reports missing real Router, provider, or installer evidence, but only exits non-zero when repository code/config work remains. In JSON output, use `codeReady.ignoredRealEvidenceItemIds` and `codeReady.ignoredLocalSetupItemIds` to hand those non-code checks to the real test machine.

`npm run release:code-ready` 是本地代码就绪门禁。它仍会报告真实 Router、供应商或安装器证据缺口，但只有仓库代码/配置还有阻断项时才会非零退出。JSON 里的 `codeReady.ignoredRealEvidenceItemIds` 和 `codeReady.ignoredLocalSetupItemIds` 可以直接交给真实测试机继续验收。

After Windows artifacts are generated, run the strict final gate before tagging:

Windows 发布包生成后，打 tag 前再跑一次严格门禁：

```powershell
node scripts/release-preflight.mjs --platform win32 --arch x64 --release-dir dist-artifacts --write-acceptance-report .\release-acceptance.json --write-gate-report .\release-gate.json
npm run release:gate -- --platform win32 --arch x64 --release-dir dist-artifacts --acceptance-report .\release-acceptance.json --write-gate-report .\release-gate.json
```

`npm run release:gate` is the strict release gate; it runs `release-preflight` with `--strict-warnings` so warning-only gaps still block tagging until they are handled or documented.

The plain CLI output and `release-gate.json` split blockers into three groups: `真实环境验收缺口` / `realEvidenceBlockingItemIds` for real Router, provider, or installer evidence; `本机配置/运行待办` / `localSetupBlockingItemIds` for setup steps on the current test machine; and `仓库代码/配置阻断项` / `codeOrConfigBlockingItemIds` for repo changes that must be fixed before tagging.

CLI 输出和 `release-gate.json` 会把阻断项分成三类：`真实环境验收缺口` 是真实 Router、供应商或安装器证据；`本机配置/运行待办` 是当前测试机需要启动、保存或刷新；`仓库代码/配置阻断项` 才是必须回到仓库里修的代码或配置问题。

You can also save the same style of machine-readable gate evidence from the desktop preflight page with `保存门禁报告` after selecting the release artifact directory.

也可以在桌面端体检页选择发布目录后点击 `保存门禁报告`，保存同类机器可读门禁证据。

If real Router, image provider, capability provider, and installer checks were completed separately, pass the evidence JSON too:

如果真实 Router、图片供应商、能力供应商和安装器验收是分开完成的，也可以把留证 JSON 一起传给体检：

```powershell
npm run release:gate -- --platform win32 --arch x64 --release-dir dist-artifacts --acceptance-report .\release-acceptance.json --write-gate-report .\release-gate.json
```

`release-gate.json` and the CI-generated `windows-release-gate.json` / `macos-*-release-gate.json` files are for diagnostics. Do not attach them as public downloads; public release assets should stay limited to the installer and portable packages.

`release-gate.json` 以及 CI 生成的 `windows-release-gate.json` / `macos-*-release-gate.json` 只用于诊断留证，不作为公开下载文件发布；公开 release 里只放安装包和免安装包。

Then push a tag:

然后推送 tag：

```powershell
git tag v0.1.10
git push origin v0.1.10
```

GitHub Actions builds the Windows installer, Windows portable zip, and both macOS portable zips, then attaches them to the same release.

GitHub Actions 会构建 Windows 安装版、Windows 免安装备用包，以及两个 macOS 免安装包，并把它们附加到 release。
