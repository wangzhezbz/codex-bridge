# CodexBridge Windows Portable / Windows 便携版

## 中文

给客户交付时，不要让客户从源码运行，也不要让客户执行 `npm install`。

正确交付方式是使用已经打包好的 Windows 便携版：

1. 在开发机或 GitHub Actions 运行 `npm run package:win`。
2. 运行 `npm run package:win:smoke` 验证打包产物。
3. 把 `release/.../CodexBridge-win32-x64` 整个文件夹压缩发给客户。
4. 客户解压到一个可写目录，例如桌面或 `D:\CodexBridge`。
5. 客户双击 `CodexBridge.exe`。

便携版会把配置、密钥和日志写到同级目录：

```text
CodexBridgeData
```

客户机器不需要安装 Node.js、npm 或 Electron。

源码里的 `Start-CodexBridge.cmd` 只适合开发者调试源码环境。如果客户使用它，就又会回到 npm / Electron 下载和安装问题。

## English

Do not ask customers to run from source, and do not ask them to run `npm install`.

The customer-facing delivery should be the packaged Windows portable build:

1. Run `npm run package:win` on a developer machine or in GitHub Actions.
2. Run `npm run package:win:smoke` to verify the packaged app.
3. Zip and distribute the whole `release/.../CodexBridge-win32-x64` folder.
4. Ask the customer to extract it to a writable folder, such as Desktop or `D:\CodexBridge`.
5. Ask the customer to run `CodexBridge.exe`.

The portable build stores config, API keys, and logs in the sibling folder:

```text
CodexBridgeData
```

Customers do not need Node.js, npm, or Electron installed.

`Start-CodexBridge.cmd` is only a developer fallback for running from source. It is not the customer delivery path.
