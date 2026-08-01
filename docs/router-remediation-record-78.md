# Router 整改记录 78：自动更新包 SHA-256 强校验

## 整改目标

修复自动更新链路只检查文件大小和 EXE/ZIP 文件头、无法发现内容被替换或篡改的
供应链风险。

本轮不修改模型路由、供应商配置、用户 API Key、自动选模型或失败回退行为。

## 可信摘要来源

GitHub Release Asset API 当前为每个上传资产提供：

```text
digest: sha256:<64 个十六进制字符>
```

CodexBridge 直接使用与 Release 元数据、下载地址同源的官方 `digest`，不信任下载
目录中的同名旁路文件，也不接受调用方自行提供的非 SHA-256 算法。

2026-07-31 对当前公开 Release 做只读检查，四个正式资产均返回 SHA-256 digest：

- `CodexBridge-Windows-x64-Setup.exe`
- `CodexBridge-Windows-x64-Portable.zip`
- `CodexBridge-macOS-arm64-Portable.zip`
- `CodexBridge-macOS-x64-Portable.zip`

## 原有风险

1. 更新计划只保留资产名称、大小和下载地址，没有保留 GitHub digest。
2. 下载完成后只验证：
   - 文件非空
   - 文件大小
   - EXE 以 `MZ` 开头
   - ZIP 以 `PK` 开头
3. 攻击者或损坏的中间节点可以构造拥有正确文件头的替换文件，旧逻辑仍会启动
   安装器或便携版替换脚本。
4. GitHub API 失败时，`releases/latest` 页面兜底只能解析版本号和下载地址，
   无法获得可信 digest，但旧逻辑仍允许自动安装。

## 修复内容

1. 更新计划从 GitHub Release Asset 的 `digest` 中只接受严格格式：

```text
sha256:[a-fA-F0-9]{64}
```

2. 安装计划保存规范化的小写 `asset.sha256`。
3. 有新版本但选中资产缺少、为空、算法错误或格式错误时：
   - `plan.ok = false`
   - `updateAvailable = false`
   - 不返回可执行的 `asset`
   - 不下载、不启动安装器、不生成替换脚本
4. GitHub API 失败、只能使用 latest 页面兜底时仍可告诉用户最新版本号，但自动
   更新会因缺少可信 SHA-256 而安全失败关闭。
5. 下载完成后分块读取整个文件并计算 SHA-256，不把大型安装包一次性读入内存。
6. 使用定长摘要比较；内容不匹配时抛出明确的 `SHA-256 mismatch`，安装流程在
   启动任何外部程序前终止。
7. 原有大小和 EXE/ZIP 文件头检查继续保留，形成多层验证。

## 测试驱动证据

修复前新增测试稳定复现：

- GitHub digest 没有进入安装计划
- 缺少 digest 仍返回可安装计划
- `sha512:` 或畸形 digest 仍被接受
- 带正确 `MZ` 文件头的篡改安装器仍能通过验证
- 缺少摘要的合法 ZIP 文件仍能通过验证
- latest 页面兜底没有摘要时仍允许自动安装

修复后 updater 定向测试：`27/27` 通过。

最终验证：

- 项目完整 `npm run check`：通过
- 桌面测试：`892/892`
- 历史恢复测试：`16/16`
- 真实 Windows Electron smoke：退出码 `0`
- smoke 资源摘要：`28/2/3/46/3/0/2`

## 主要修改文件

- `desktop/updater.mjs`
- `tests/desktop-updater.test.js`

## 安全边界

SHA-256 可以验证下载内容是否与 GitHub Release 元数据一致，能够阻止传输损坏、
缓存污染和内容替换。它不能替代操作系统代码签名，也不能防御 GitHub 仓库或发布
账号本身被完全接管。

后续如果具备 Windows 代码签名证书和 Apple Developer ID，应继续增加
Authenticode、notarization 和签名发布者校验。
