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

## Package Naming / 包名规范

GitHub Release assets use a stable package name so tutorials can keep one latest-download link:

GitHub Release 附件使用稳定包名，教程里可以固定引用最新版下载链接：

```text
CodexBridge-Windows-x64-Portable.zip
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
npm run check
npm run package:win
npm run package:win:smoke
npm run package:mac
npm run package:mac:smoke
```

Then push a tag:

然后推送 tag：

```powershell
git tag v0.1.10
git push origin v0.1.10
```

GitHub Actions builds the Windows portable zip and both macOS portable zips, then attaches them to the same release.

GitHub Actions 会构建 Windows 和 macOS 免安装包，并把 zip 附加到 release。
