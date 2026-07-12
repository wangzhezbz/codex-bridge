# 记录 10：升级遗留开关与 Router 真实启动链路整改

日期：2026-07-11

状态：已完成；完整代码门禁和 Windows 打包真实启停烟测通过。

## 用户现场

- 从旧测试包升级后，“重复请求保护”仍显示开启。
- Router 点击启动后只显示通用失败提示，无法判断端口、权限、配置或进程退出原因。
- 用户提供的发布前体检中，4 个模型缺少 API Key 会使正式发布体检失败，但这不应阻止 Router 本地进程启动。

## 根因

- 旧版本曾把重复请求保护默认保存为 `true`；只修改新安装默认值不能覆盖已经持久化的旧值。
- Windows 配置事务会对内容未变化的敏感文件再次执行替换发布，即使 ACL 已经安全；真实文件被占用时会引入不必要的启动失败。
- Router 子进程 stderr、Windows 大写错误码和“启动阶段立即退出”没有进入安全的错误分类，界面只能得到 `operation_failed`。
- 旧打包烟测分别验证桌面能打开和 `src/server.js` 能运行，没有调用桌面实际的 `router:start` / `router:stop` IPC。

## 整改

- 增加重复请求保护策略版本 2：没有策略版本的旧 `true` 一次性迁移为关闭；用户在新版本中手动开启后会携带版本标记并正常持久化、导出和导入。
- Windows ACL 增加只读 `verifyPath`；内容未变化且 ACL 已安全的敏感文件保持零写入，无法证明安全时才走加固重发布。
- 配置事务错误码统一安全小写；Router 启动增加端口占用、端口权限、配置无效、运行文件缺失、健康检查失败和启动后立即退出等固定中文提示与有界诊断码，不回显路径、密钥或原始 stderr。
- Windows 打包烟测使用独立数据目录和独立 Codex home，种入旧版 `duplicateRequestProtection: true`，确认迁移为关闭后，通过真实 Electron IPC 完成 Router 启动、运行态检查、停止和停止态检查；不读写真实 Codex 配置。

## TDD 与验收证据

- RED 分别复现：旧 `true` 未迁移、已安全文件仍重写、`EACCES` 被降为通用错误、端口冲突不分类、启动阶段退出不携带原因、打包烟测没有真实启停。
- 聚焦回归：507/507 通过。
- `npm run check`：通过；Router 与 Desktop 全套 0 失败，Desktop 765/765。
- `npm run desktop:smoke`：通过。
- `npm run release:code-ready`：14 通过、8 提醒、0 失败；提醒均为本机配置或真实供应商验收，不是代码门禁失败。
- `git diff --check`：退出码 0，仅保留既有 CRLF/LF 提醒。
- Windows 打包烟测：通过；`desktopSmoke.routerLifecycleOk=true`，真实桌面启停 65590ms，独立 Router health 432ms，模型 `gpt-5.5`。

## 约束

- 未使用真实 API Key。
- 未操作真实 Codex 状态库。
- 真实启停烟测只使用系统临时目录、独立 Router 端口和独立 Codex home。
