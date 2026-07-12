# 记录 12：ZIP 解压兼容、旧 Codex 误启动与历史项目恢复

日期：2026-07-12

状态：已完成；完整门禁、Windows 打包烟测和标准 ZIP 解压验收通过。

## 用户现场

- WinRAR 每次解压测试 ZIP 都提示无法创建目标文件夹。
- 点击“重启 ChatGPT / Codex”出现 `ambiguous_multiple_codex_paths`。
- 自动打开旧版 Codex，而不是当前 ChatGPT。
- ChatGPT 侧栏历史会话和项目消失；“恢复项目列表”“找回历史对话”没有可见效果。

## 只读证据

- 本机 Codex 数据仍有 104 条会话索引、779 个 session JSONL、10 个存在且可恢复的项目。
- `.codex-global-state.json`、`sqlite/codex-dev.db` 和 sessions 目录均存在；历史数据没有被 Router 删除。
- 新 ChatGPT 进程位于当前 `OpenAI.Codex_26.707.3748.0_x64/.../app/ChatGPT.exe`。
- 同一 ChatGPT 安装会启动 `app/resources/codex.exe ... app-server` 后台助手；旧逻辑把它误认成独立 Codex Desktop。
- 之前手工交付 ZIP 使用 tar 生成，中央目录条目带 `./` 根前缀；这是 WinRAR 报目录创建冲突的直接兼容风险。

## 根因

- 自动启动候选按来源优先，“正在运行的 Codex”排在“已安装的 ChatGPT”之前。
- `resources/codex.exe app-server` 只按文件名被识别为 Codex Desktop，造成多 Codex 路径歧义。
- 项目恢复复用了同一候选排序，所以 `--open-project` 被发给旧 Codex 或错误助手路径。
- “找回历史对话”此前只调整配置中的历史存储开关，没有实际重新打开已发现项目。
- 手工 tar ZIP 虽能被系统工具读取，但其 `./` 根条目不符合本项目 Windows/WinRAR 交付约定。

## 整改

- 用户手动保存的启动项仍保持最高优先级；没有手动指定时，所有自动发现候选统一优先 ChatGPT，再回退旧 Codex。
- 明确排除 `resources/codex.exe` / `app-server` 助手，不把它作为桌面启动项，也不把它作为可停止桌面进程。
- 对所有经过精确路径验证的 ChatGPT 与旧 Codex 升级进程执行统一重启；ChatGPT Classic 和 CodexBridge 继续明确排除，未知路径继续失败关闭。
- “恢复项目列表”使用修正后的 ChatGPT 优先候选；“找回历史对话”在修复历史显示配置后，会实际执行项目恢复计划，把 `--open-project` 发给当前 ChatGPT。
- Windows 发包脚本新增 `--portable-only`，不需要 NSIS 即可使用正式 `Compress-Archive` 路径生成 portable ZIP。
- 最终 ZIP 使用标准 Windows ZIP 中央目录：根目录直接包含 `CodexBridge.exe`，包含 `.codexbridge-portable`，不存在 `./` 或 `./...` 条目。

## TDD 与验收证据

- RED：运行中旧 Codex 压过新 ChatGPT；两个已验证升级路径被误判为歧义；重启只停止新 ChatGPT；`resources/codex.exe app-server` 被识别为桌面应用；历史恢复没有调用项目恢复；发包脚本缺少 portable-only。
- GREEN：上述聚焦测试全部通过。
- `npm run check`：通过；Desktop 767/767，0 失败。
- `npm run package:win`：通过。
- `npm run package:win:smoke`：通过；桌面真实 Router 启停和非空 Codex 配置恢复继续通过。
- 标准 ZIP：710 个中央目录条目；`.codexbridge-portable` 存在；`./` 根条目 0；PowerShell `Expand-Archive` 实际解压通过。

## 安全边界

- 本轮只读检查真实会话和进程路径，没有修改真实会话数据库或全局状态文件。
- 项目恢复仍使用 ChatGPT/Codex 支持的 `--open-project`，不直接伪造项目或固定会话。
- 只停止精确路径已验证的 ChatGPT/Codex 桌面进程；Classic、CodexBridge、内置 CLI 助手和未知路径均不在停止范围。
