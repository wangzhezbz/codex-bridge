# 整改记录 48：自定义 Responses 路由压缩续接兼容恢复

日期：2026-07-13

## 用户反馈

- 自定义 API-Key Responses 模型在 Codex 自动压缩上下文后，中转站开始持续返回 502/504，后续任务无法继续。
- 相同中转站在压缩前可用，旧版经本地修补后也可正常续接，升级后问题复现。

## 根因

1. CodexBridge 本地压缩会生成带固定 `COMPACT_SUMMARY_PREFIX` 的明文 `compaction` 条目，并暂存于 `encrypted_content` 字段。
2. 请求发送给 Responses 上游前已有精确识别和转成普通 `message/input_text` 的兼容逻辑，但入口额外限制为 `authMode === "codex_openai"`。
3. 自定义 API-Key Responses 路由因此把 Bridge 明文 `compaction` 原样发给中转站；不支持该私有结构的上游拒绝请求，表现为压缩后的首次请求 400，随后客户端看到 502/504。

## 修复

- 将 Bridge 明文压缩条目的兼容转换覆盖到所有 `api === "responses"` 路由，不再按订阅鉴权或 API-Key 鉴权分叉。
- 仍只转换同时满足以下条件的条目：
  - 类型为 `compaction` 或 `context_compaction`；
  - `encrypted_content` 以 Bridge 固定摘要前缀开头。
- 不带 Bridge 前缀的官方 opaque compaction 保持原样，避免破坏 GPT 原生续接协议。
- 普通 Chat Completions 路由及自动选模、失败切换规则均未修改。

## TDD 与验证

- 先新增自定义 API-Key Responses 回归测试并确认 RED：上游确实收到原样的 `type:"compaction"` 和 `encrypted_content`。
- 最小修复后定向测试 2/2 通过：官方 `codex_openai` 与自定义 API-Key Responses 均收到普通文本上下文。
- 完整 Router 测试：528/528 通过。
- 项目全量测试：1367/1367 通过。
- `node --check src/upstream.js`、`node --check tests/server.test.js` 与 `git diff --check` 均通过。

## 安全边界

- 未把任意 `encrypted_content` 当作明文解包，只处理 CodexBridge 自己带固定前缀的摘要。
- 未修改上下文压缩阈值、上下文窗口、模型选择、自动路由、失败切换或供应商鉴权。
- 未连接真实用户中转站或读取真实 API Key；跨机器真实压缩续接仍需测试包现场验收。
- 未删除任何文件或目录。
