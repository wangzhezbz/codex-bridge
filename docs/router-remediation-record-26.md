# Router 整改记录 26：长任务超时统一为 600 秒

日期：2026-07-12

## 问题

经过 Windows 代理的 ChatGPT 流式请求，其响应头等待上限只有 60 秒。即使普通上游超时和 ChatGPT 流空闲超时为 300 秒，代理层仍会最先在 60 秒终止 GPT 5.6、子智能体和 HyperFrames 等长任务。

## 整改

- Router 默认上游请求超时：`300000ms` → `600000ms`。
- Windows 代理流式响应头超时：`60000ms` → `600000ms`。
- 适配器契约默认超时：`300000ms` → `600000ms`。
- ChatGPT / Codex `stream_idle_timeout_ms`：`300000ms` → `600000ms`。
- 流式响应一旦开始返回 SSE，Router 仍会清除请求头阶段计时器，不限制正常持续输出的总任务时长。

## TDD 证据

- RED：适配器契约仍返回 `300000`。
- RED：CodexBridge provider TOML 仍写入 `stream_idle_timeout_ms = 300000`。
- RED：上游与代理响应头默认超时策略不可验证且仍为旧值。
- GREEN：三层策略均返回或写入 `600000ms`。

## 验证结果

- 超时策略聚焦测试：3/3 通过。
- `npm run check`：781/781 通过。
- `npm run desktop:smoke`：通过。
- `npm run release:code-ready`：失败 0；仅保留真实环境与本机配置提醒。
- `npm run package:win:smoke`：新打包的 `CodexBridge.exe` 通过。
- 便携包：`dist-artifacts/test-20260712-timeout-600s/CodexBridge-Windows-x64-Portable.zip`。
- ZIP：141,391,294 字节，725 个条目，危险路径 0，重复条目 0，根目录 `CodexBridge.exe` 1 个。
- SHA256：`5E56CE746C5BBCC3D3B1F4BEDA1FA80ECD669B91E622129A12176B965AF3E116`。
