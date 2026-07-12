# 整改记录 29：GPT 原生 imagegen 流式图片丢失

日期：2026-07-12

## 现场错误

`/v1/images/generations` 请求上游返回 HTTP 200，并产生正常 usage；CodexBridge 随后报告：

`Native ChatGPT image_gen returned no image output.`

## 根因

- CodexBridge 强制聚合 ChatGPT Responses SSE 时，只保留最终 `response.completed.response`。
- 新版原生 imagegen 可以通过 `response.image_generation_call.partial_image` 事件返回 `partial_image_b64`。
- 最终 completed output 在部分版本中只有 `image_generation_call` 状态而没有 `result`，导致已经返回的图片在聚合时被丢弃。
- 原请求没有设置 `partial_images`；官方默认值是 0，因此也不能保证收到可恢复的流式图片事件。

## 修复

- GPT 路由仍然只调用 ChatGPT 原生 `image_generation` 工具，不切换到任何自定义生图供应商。
- 原生工具请求增加 `partial_images: 1`。
- Responses SSE 聚合时按 `item_id` / `output_index` 保存最后一个 `partial_image_b64`。
- 当最终 `image_generation_call.result` 缺失时，用对应的最后一个流式图片结果补齐；已有正式 `result` 时绝不覆盖。

## 测试

- 先新增失败测试，稳定复现“上游 200、partial image 已返回、completed 无 result、Router 返回 502”。
- 修复后该测试通过。
- 原有“GPT 即使配置了自定义生图供应商也必须走原生 imagegen”测试继续通过。
- `npm run check`：通过；桌面/发布测试 786 项、历史恢复专项 10 项均为 0 失败。
- `npm run package:win:smoke`：打包后的 EXE 冒烟通过。
- ZIP 完整读取 729 项，损坏 0 项。

测试包：`dist-artifacts/test-20260712-native-imagegen-stream-fix/CodexBridge-Windows-x64-Portable.zip`

SHA-256：`D58F09672A1D74494E02E8E16FF743AD6C0F9A5814AE0FE979A70405BE5F084F`

## 修改文件

- `src/server.js`
- `src/upstream.js`
- `tests/server.test.js`
