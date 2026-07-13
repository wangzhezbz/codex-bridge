# 整改记录 46：Windows 配置保存、双倍额度启动与模型引用修复

日期：2026-07-13

## 用户反馈

- 部分 Windows 用户启动时出现 `config_write_unsafe_path`，配置恢复失败后所有写入控件被锁定。
- 保存模型栏、自定义模型或设置时统一报 `ConfigTransactionError`。
- “双倍额度”服务在中文 Windows 用户目录下启动时报扩展目录 `EIO`，服务本身也无法启动。
- 设置页把仍然存在的 `cb-*` 路由误标为“失效引用”，导致“修复失效模型引用”按钮状态与实际模型状态矛盾。

## 根因

1. 配置事务把“允许写入根目录本身是 Windows junction”与“允许根目录内部的链接逃逸”混为一类。用户目录、`.codex` 或应用数据目录只要被系统重定向，全部配置写入都会被误拒绝。
2. 双倍额度服务启动前同步复制 Chrome 扩展。扩展目录被占用、损坏或返回 `EIO` 时，可选的扩展维护动作直接阻断了独立 HTTP 服务。
3. Chrome 返回的 `\\?\C:\...` 设备命名空间路径与普通 `C:\...` 路径未统一，可能把同一扩展目录重复当成两个部署目标。
4. 智能路由下拉框用模型预设 ID 检查已保存的真实路由 ID；`cb-deepseek-v4-pro` 等合法 route ID 因此被误报为失效。
5. 历史版本曾使用 `customModels:save`，当前版本只监听 `customModel:save`；旧 renderer/缓存页面可能调用不到保存处理器。
6. Electron IPC 丢失配置事务的失败阶段和原因码，用户只能看到无法定位的统一失败文案。

## 修复

- 允许显式配置的受信根目录解析到其真实物理目录，同时继续检查目标父目录的物理归属；根目录内部指向外部的 junction/symlink 仍然拒绝写入。
- 双倍额度服务将 Chrome 扩展更新改为可恢复的附属动作：扩展刷新失败会保留独立诊断，但不再阻止服务进程启动。
- 统一 Windows 设备命名空间路径和普通绝对路径，扩展部署目标按真实路径去重。
- 智能路由从当前 `state.models` 读取真实 route ID，选中与失效判断不再混用 `presetId`。
- 同时兼容 `customModel:save` 与历史 `customModels:save`，两者共用一次配置事务，不产生重复写入。
- 配置事务失败时保留并显示安全的 `failurePhase` 与 `causeCode`，运行日志也记录操作、阶段和诊断码，不泄露用户路径或密钥。

## 安全边界

- 没有放宽受信根目录内部的链接逃逸；对应越界测试继续通过。
- 没有批量删除文件或目录，没有读取或写入用户密钥。
- 没有修改会话 provider、历史恢复、15722 Router 路由策略或模型超时。

## TDD 与验证

- 初始定向测试稳定复现 6 项失败：受信根目录 junction、无关 junction 连带阻断、扩展失败阻断服务、旧 IPC 缺失、错误诊断丢失、route ID 误判。
- 修复后定向测试：181/181 通过。
- 完整测试：1360/1360 通过。
- `npm run check:syntax`：通过。
- `npm run desktop:smoke`：通过，桌面状态、资源快照和导航正常。
- `git diff --check`：通过。

## 测试机验收重点

1. 在中文用户名、重定向用户目录或 junction 环境下分别保存模型栏、自定义模型和设置。
2. 扩展目录被占用或暂时不可写时，双倍额度服务仍能启动，并单独提示扩展更新失败。
3. `cb-deepseek-v4-pro` 等仍存在的 route ID 不再显示“失效引用”；真正被删除的 route ID 仍应触发修复入口。

## Windows 便携测试包

- 路径：`dist-artifacts/v0.3.2-hotfix-config-windows-20260713-1745/CodexBridge-Windows-x64-Portable.zip`
- 大小：152,242,095 bytes（145.19 MiB）
- SHA-256：`314D33589113A745DCD03BCFC16BA2010D78825AD45F602924762124A1B658DE`
- 打包后 smoke：通过；明确运行本次新构建目录中的 `CodexBridge.exe`。
- 已在打包目录回读确认：旧 IPC 兼容、扩展 best-effort 启动和真实 route ID 判断代码均已进入产物。
