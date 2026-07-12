# Router 整改记录 27：GPT 原生 imagegen 强制 store=false

日期：2026-07-12

## 问题等级

P0。GPT 5.6 原生生图请求已使用列表输入，但 ChatGPT Codex Responses 后端仍返回 HTTP 400：`Store must be set to false`。

## 根因

公共 `codex_openai` Responses 适配层会在调用方未指定时默认补充 `store=true`。普通对话沿用该兼容行为，但 `/v1/images/generations` 转换出的原生 `image_generation` 请求只允许 `store=false`。专用转换入口没有显式覆盖，因此被公共默认值改成了 `true`。

## 整改

- 只在 GPT 原生图片兼容入口显式写入 `store: false`。
- 保持输入为标准 Responses 列表。
- 保持 `tools: [{ type: "image_generation", action: "generate" }]`。
- GPT 模型仍只调用 ChatGPT 原生 imagegen，不切换自定义或第三方图片供应商。
- 不修改普通聊天、历史记录、工具调用和非 GPT 生图代理的存储合约。

## TDD 证据

- 将测试上游改为严格模拟 ChatGPT 后端：输入不是列表则返回 `Input must be a list`；`store !== false` 则返回 `Store must be set to false`。
- RED：Router 实际发出 `store=true`，测试得到与测试机相同的 HTTP 400。
- GREEN：Router 发出 `store=false`，严格上游接受请求并返回原生 `image_generation_call` 图片结果。

## 验证结果

- 生图、适配层、代理协议回归：293/293 通过。
- `npm run check`：781/781 通过。
- `npm run desktop:smoke`：通过；资源摘要 `providers=15 resources=17/3/70/2`。
- `npm run release:code-ready`：15 通过、7 提醒、0 失败。
- `npm run package:win:smoke`：新打包应用通过桌面和 Router health smoke。
- 便携包：`dist-artifacts/test-20260712-native-imagegen-store-false/CodexBridge-Windows-x64-Portable.zip`。
- ZIP 校验：726 项、无危险路径、无重复路径、根目录包含 `CodexBridge.exe`。
- SHA256：`B87D5A066888959935642E7DF27715770DD560A925A37A8F25417BA2C9B92D19`。
