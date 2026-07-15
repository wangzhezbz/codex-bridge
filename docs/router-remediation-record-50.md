# 整改记录 50：Router 关闭后官方会话压缩内容不可验证

日期：2026-07-15

## 用户反馈

- 用户关闭 CodexBridge Router 后，继续使用曾经经过 Router 的任务时，官方接口返回 `invalid_encrypted_content`。
- 错误说明历史中的 `encrypted_content` 无法被官方服务解密或解析。

## 根因

1. 官方 GPT 订阅路由收到 `/responses/compact` 或 `compaction_trigger` 时，原实现也进入了 CodexBridge 的兼容压缩器。
2. 兼容压缩器把普通摘要文本放入 `type=compaction` 的 `encrypted_content` 字段；该字段并非 OpenAI 生成的加密载荷。
3. Router 运行时会识别并展开这类旧摘要，因此请求仍可继续；Router 关闭后，请求直接发送给官方服务，明文摘要被当成官方加密载荷校验并返回 400。

## 修复

- 仅当路由同时满足以下条件时，压缩请求改为原生透传：
  - `route.api === "responses"`
  - `authModeForRoute(route) === "codex_openai"`
  - 当前请求为 v1 或 v2 压缩请求
- v1 保留并转发官方 `/responses/compact` 端点。
- v2 保留 `compaction_trigger`，不再替换成 CodexBridge 的摘要提示。
- 官方返回的 opaque `encrypted_content` 原样传回并写入历史。

## 不变范围

- 普通 Responses 请求不变。
- API Key、自定义 Responses 和 Chat Completions 路由继续使用现有兼容压缩与本地降级。
- Router 启动、停止、配置恢复、模型选择和故障切换逻辑均未修改。
- 不扫描、不改写、不删除用户已有会话文件或数据库。

## 回归验证

- 新增 v1 回归：确认请求实际到达 `/responses/compact`，opaque compaction 原样返回。
- 新增 v2 回归：确认 `compaction_trigger` 原样到达官方上游，未出现 Bridge 明文摘要前缀。
- 压缩相关测试覆盖官方订阅、API Key Responses、Chat Completions、本地降级与旧摘要兼容。

## 旧会话说明

- 本次修复阻止新版继续生成不可由官方验证的压缩载荷。
- 已经写入旧任务的 Bridge 明文压缩项不会被自动修改；自动迁移用户历史风险较高，本次未实施任何历史数据写入。
