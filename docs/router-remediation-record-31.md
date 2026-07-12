# 整改记录 31：GPT 原生 image_gen 流式终态图片丢失

## 现象

ChatGPT / Codex 通过 `POST /v1/images/generations` 请求 GPT 原生生图时，上游返回 HTTP 200，但 CodexBridge 最终返回 502：`Native ChatGPT image_gen returned no image output.`

## 根因

新版 ChatGPT Responses 流的最终 `response.completed.response.output` 可能为空。图片数据实际位于此前的 `response.output_item.done.item.result`，同时也可能出现在 `response.image_generation_call.partial_image.partial_image_b64`。

旧聚合逻辑只会把流式图片回填到终态 `response.output` 中已经存在的 `image_generation_call`。当终态 output 为空时，Router 已经收到了图片字节，却没有创建图片输出项，随后错误地抛出 502。

## 修改

- 记录 `response.output_item.done` 中完整的 `image_generation_call`。
- 终态 output 有占位项时回填 `result` 和 `revised_prompt`。
- 终态 output 为空时，根据流式完成事件安全补建 `image_generation_call`。
- 保留 partial image 回填路径；同一 output index 的最终完成事件覆盖早期 partial image。

## 验证

- RED：新增现场响应形态测试，修复前稳定返回 502。
- GREEN：同一测试修复后返回 200，并得到预期 base64 与 revised prompt。
- 真实 ChatGPT 登录态端到端请求：HTTP 200；PNG 1,273,483 字节；文件签名 `89504e470d0a1a0a`；耗时约 20 秒；包含 revised prompt。
- 真实诊断只记录 SSE 事件类型、字段名和数据长度，不记录令牌、提示词或图片内容。

## 回滚

如需回滚，只撤销 `src/upstream.js` 对 `response.output_item.done` 的收集与空 output 补建逻辑，以及 `tests/server.test.js` 对应回归测试；不涉及配置、用户会话或认证数据。
