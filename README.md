<p align="center">
  <img src="docs/assets/readme-hero.svg" width="100%" alt="CodexBridge — One Codex. Many models. 一个 Codex，多个模型。" />
</p>

<p align="center">
  <a href="https://github.com/wangzhezbz/codex-bridge/releases/latest"><img src="https://img.shields.io/github/v/release/wangzhezbz/codex-bridge?label=release&amp;color=16786b" alt="最新版本" /></a>
  <img src="https://img.shields.io/badge/Windows-x64-2266a8" alt="Windows x64" />
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-383f43" alt="macOS Apple Silicon 和 Intel" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-383f43" alt="MIT 许可证" /></a>
</p>

<p align="center">
  <strong>一个 Codex，接入你需要的模型。</strong><br />
  本地运行的多模型网关与桌面管理器，统一模型栏、连接配置和用量统计。
</p>

<div align="center">
<table>
  <thead><tr><th align="center" width="200">Windows</th><th align="center" width="200">macOS</th></tr></thead>
  <tbody>
    <tr>
      <td align="center"><a href="https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Setup.exe"><strong>下载安装版</strong></a></td>
      <td align="center"><a href="https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-arm64-Portable.zip"><strong>M 系列芯片</strong></a></td>
    </tr>
    <tr>
      <td align="center"><a href="https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Portable.zip">免安装备用</a></td>
      <td align="center"><a href="https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-x64-Portable.zip">Intel 芯片</a></td>
    </tr>
  </tbody>
</table>
</div>

<p align="center"><strong>简体中文</strong> · <a href="docs/README.en.md">English</a></p>

<p align="center"><a href="#为什么用-codexbridge">为什么</a> · <a href="#核心能力">核心能力</a> · <a href="#快速开始">快速开始</a> · <a href="#计费模式">计费模式</a> · <a href="#文档与排错">文档与排错</a> · <a href="#开发">开发</a></p>

<details>
<summary>下载说明与首次启动</summary>

### Windows

- **推荐·安装版：** [CodexBridge-Windows-x64-Setup.exe](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Setup.exe)
- **免安装版：** [CodexBridge-Windows-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-Windows-x64-Portable.zip)

Windows 下下载 Windows 安装版并运行。免安装包作为备用，完整解压后打开 `CodexBridge.exe`。[安装说明](docs/windows-setup.md) · [便携版说明](docs/windows-portable.md)

### macOS

- **M 系列芯片：** [CodexBridge-macOS-arm64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-arm64-Portable.zip)
- **Intel 芯片：** [CodexBridge-macOS-x64-Portable.zip](https://github.com/wangzhezbz/codex-bridge/releases/latest/download/CodexBridge-macOS-x64-Portable.zip)

解压后打开 `CodexBridge.app`。首次启动被系统拦截时，请按 [macOS 说明](docs/macos-portable.md) 操作。

下载版自带运行环境，无需安装 Node.js。[更新日志](docs/releases.md) · [历史版本](https://github.com/wangzhezbz/codex-bridge/releases)

</details>

## 为什么用 CodexBridge

你可以继续在 Codex 里执行命令、修改文件和使用本地工具，同时从同一个模型栏选择 GPT、DeepSeek、Kimi 或自己配置的模型。

CodexBridge 把模型连接和路由放在本地管理：选择哪个模型，就把请求交给对应供应商；模型、凭据、用量和错误信息都有明确入口。

```text
ChatGPT / Codex  →  本机 CodexBridge  →  你选择的模型供应商
```

网关在本地运行，模型请求仍会发送到所配置的供应商。

## 核心能力

| 你想做什么 | CodexBridge 提供什么 |
| --- | --- |
| 在一个模型栏使用多家模型 | 内置模型和自定义路由，管理供应商、模型顺序和搜索筛选。 |
| 保留 Codex 的执行流程 | 支持 Responses 与 Chat Completions 路由、协议转换、流式输出和工具调用处理。 |
| 看清每次请求用了多少 | 直接展示总、输入、输出、缓存 Token，按模型汇总并查看请求详情。 |
| 知道为什么请求失败 | 就绪检查、实时日志、真实上游状态与可复制的任务报告。 |
| 管理 Codex 本体 | Windows 下安装、更新、卸载与回滚托管的 Codex 程序。 |
| 接入另一份 GPT 工作流 | 内置 ChatGPT-Codex-Bridge 服务，提供扩展与 MCP 配置入口。 |

## 快速开始

1. **下载并打开 CodexBridge。** Windows 使用安装版，macOS 选择对应芯片的包。
2. **准备 Codex。** Windows 可在“软件管理”页安装或更新 Codex；macOS 先安装 Codex。
3. **配置模型。** 在“模型”页填写供应商凭据，勾选希望显示在 Codex 里的模型。
4. **选择计费模式，启动 Router。** 按需要选择“GPT 走订阅”或“全部 API”。
5. **重启 ChatGPT / Codex。** 刷新模型栏后开始使用。自动查找不到时，可以手动选择启动项。

<details>
<summary>English quick start</summary>

On Windows, download the Windows installer and run it. On macOS, extract the build for your chip and open `CodexBridge.app`.

Configure provider credentials and models, choose a billing mode, start Router, then restart ChatGPT / Codex. See the [English guide](docs/README.en.md).

</details>

## 计费模式

| 模式 | GPT 模型 | 其他供应商 |
| --- | --- | --- |
| **GPT 走订阅** | 使用 Codex 传入的登录态。 | 使用对应供应商的 API Key。 |
| **全部 API** | 使用已配置的 API Key。 | 使用对应供应商的 API Key。 |

计费模式由你手动选择。订阅额度用完后，CodexBridge 不会自动把你切换到 API 模式；各供应商的价格、额度与模型权限仍按其自身规则执行。

## 文档与排错

- [详细配置与无界面运行](docs/configuration.md)
- [Windows 安装版](docs/windows-setup.md) · [Windows 免安装版](docs/windows-portable.md) · [macOS](docs/macos-portable.md)
- [更新日志](docs/releases.md)
- [反馈问题](https://github.com/wangzhezbz/codex-bridge/issues) · [模型回归矩阵](docs/model-regression-matrix.md)

遇到 `502` 时，先看“日志”：请求有没有进入 Router、实际使用哪个供应商、上游返回什么状态。历史会话不可见时，在会话页面使用恢复入口，并保留原始备份。[配置与故障排查](docs/configuration.md#troubleshooting-502--502-排查)

## 开发

源码开发需要 **Node.js 22.16+**。运行配置、API Key 和用户数据保存在本地，不应提交到仓库。

```bash
npm ci
npm run desktop
npm run check
```

发布包来自对应版本标签；从源码复现某个发布版本时，请检出同名标签。更多配置命令见 [开发与配置文档](docs/configuration.md)。

## 许可证

[MIT](LICENSE)。
