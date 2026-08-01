# Router 整改记录 90：拆分 Responses SSE 图像结果回填

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，只提取 Responses SSE 图像结果的内存回填逻辑：

- 从 `response.output_item.done` 中读取完整 image generation result；
- 从 `response.image_generation_call.partial_image` 中读取 partial image；
- 优先按 item ID 匹配已有 `image_generation_call`，再按 output index 匹配；
- 不覆盖已有非空 result；
- 只在原值缺失时补充 `revised_prompt`；
- 将未匹配候选按 output index 排序后追加到响应 output；
- 同一 item/index 的多次 partial 事件继续使用事件流中最后一个有效候选；
- 忽略无效 JSON、非图像事件和空白结果。

本轮保留原有“原地补全并返回同一 response 对象”的调用契约，不修改 SSE 分帧、终止事件判断、流式缓冲、大小限制、网络读取、history 写入或错误文案，不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态调用面搜索替代：

- `hydrateStreamedImageGenerationResults` 只有一个生产入口，位于 `extractResponsesObject`；
- 调用顺序继续是先由 `extractResponseObjectFromSse` 提取响应，再使用同一 SSE 文本补全图像结果；
- 新模块复用 `src/sse.js` 的 `parseSseEvents` 和 `src/json.js` 的 `tryParseJson`，没有复制协议解析；
- `src/upstream.js` 继续负责何时提取响应、何时检查完成状态、何时写入历史和如何发送结果；
- 新模块不导入 HTTP、网络、history、配置、路由或日志模块；
- 新模块及直接测试已接入 `check:syntax` 和 `test:router`。

原实现候选对象中的 `partialImageIndex` 从未被读取；迁移时移除了这一项无效内部记录，候选择优顺序仍由现有 Map 覆盖顺序决定，外部行为不变。

## TDD 证据

先新增 `tests/responses-image-results.test.js`，直接导入计划中的独立模块：

```powershell
node --test tests/responses-image-results.test.js
```

实现前结果为 `0/4` 通过、`4/4` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/responses-image-results.js` 尚不存在。

完成最小实现并切换生产调用后，直接测试为 `4/4` 通过，分别验证：

- 没有 output 数组的响应保持不变；
- completed image 事件按 item ID 回填 result 和 revised prompt；
- 已有非空 result 不被改写；
- partial 事件保留最新候选并按 output index 追加；
- 无效、无关和空白结果事件被忽略。

## 模块边界

新增 `src/responses-image-results.js`，导出：

- `hydrateStreamedImageGenerationResults`

该函数是确定性的内存转换，但为保持既有调用契约会原地补全 `response.output`。`src/upstream.js` 仍保留 `extractResponsesObject` 编排入口以及所有网络、缓冲、完成状态、历史与响应发送逻辑。

拆分后：

- `src/responses-image-results.js` 为 75 行；
- `src/upstream.js` 从上一批的 4762 行降至 4689 行；
- 旧的图像回填函数没有在 `src/upstream.js` 中残留第二份副本。

## 验证结果

- 图像结果回填红测：实现前 `0/4` 通过、`4/4` 按预期失败；
- 图像结果回填绿测：`4/4`；
- 图像回填、SSE、上游代理、历史持久化和服务端联合回归：`218/218`；
- `npm run check`：通过；
- Router 子套件：`592/592`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `79.3` 秒；
- smoke 资源摘要：`28/2/3/46/3/0/2`。

Electron smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning；两项没有导致 smoke 失败，也不属于本轮图像回填拆分范围。

## 主要修改文件

- `src/responses-image-results.js`
- `src/upstream.js`
- `tests/responses-image-results.test.js`
- `package.json`

## 后续边界

1. SSE 分帧、终止状态和 JSON payload 解析继续由 `src/sse.js` 负责，不在图像模块复制。
2. 如果未来要按 `partial_image_index` 选择候选，应作为单独契约变更处理并先增加乱序事件测试。
3. 下一批可评估 Responses 流事件状态分类纯函数；终端缓冲、字节上限和网络读取仍应留在 `src/upstream.js`。
4. 每次相关重构继续验证原生图像流、完整与截断 SSE、Sol/Terra、历史写入、Anthropic 鉴权和普通 API-key 路由。
