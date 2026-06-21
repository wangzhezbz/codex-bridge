# Releases / 发布与下载

## Latest Download / 最新下载

Windows portable package:

Windows 免安装包：

[CodexBridge-Windows-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Portable.zip)

Release history:

历史版本：

[GitHub Releases](https://github.com/wangzhezbz/codex-bridge/releases)

## Package Naming / 包名规范

GitHub Release assets use a stable package name so tutorials can keep one latest-download link:

GitHub Release 附件使用稳定包名，教程里可以固定引用最新版下载链接：

```text
CodexBridge-Windows-x64-Portable.zip
```

The extracted release folder includes the tag/version:

解压后的 release 目录包含 tag/版本号：

```text
CodexBridge-Windows-x64-Portable-v0.1.8
```

## Release Checklist / 发布检查

Before tagging a release:

发布打 tag 前：

```powershell
npm run check
npm run package:win
npm run package:win:smoke
```

Then push a tag:

然后推送 tag：

```powershell
git tag v0.1.8
git push origin v0.1.8
```

GitHub Actions builds the Windows portable zip and attaches it to the release.

GitHub Actions 会构建 Windows 免安装包，并把 zip 附加到 release。
