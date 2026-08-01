# Router 整改记录 89：统一 Responses 对象识别与归一化

## 整改目标

本轮继续分阶段缩小 `src/upstream.js`，并消除 `src/upstream.js` 与 `src/sse.js` 中重复的 Responses 对象归一化实现：

- 识别官方 `object: "response"` 响应并保持原对象引用；
- 兼容缺少 object 标记、但包含 status、output、output_text 或 usage 的供应商响应；
- 拒绝没有有效字符串 ID 或只有 ID、没有响应特征的对象；
- 统一判断一个对象是否属于 Responses 形状；
- 统一判断响应是否为无 error 的精确 `completed` 状态。

本轮不修改 SSE 事件解析、终止事件判断、流式缓冲、网络读取、history 写入或响应错误文案，不修改 Sol、Terra、Luna 路由，不修改默认模型、智能路由、自动切换、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态调用面搜索替代：

- `src/upstream.js` 使用对象识别判断非流响应、聚合流结果和是否允许写入历史；
- `src/sse.js` 使用同样的归一化规则从直接 JSON 或 SSE payload 的 response/data/result 中提取响应；
- 两个文件原先各维护一份相同的 `normalizeResponsesObject`；
- 新模块不导入 JSON、SSE、HTTP、history、配置或路由模块；
- `src/sse.js` 只改为导入公共归一化函数，原事件循环和候选优先级保持不变；
- 新模块及直接测试已接入 `check:syntax` 和 `test:router`。

质量门同时补齐了既有 `tests/desktop-codex-provider.test.js` 的显式语法检查；该文件原本已经运行于桌面测试套件，本项只补齐固定 syntax gate，不改变生产行为。

## TDD 证据

先新增 `tests/responses-object.test.js`，直接导入计划中的独立模块：

```powershell
node --test tests/responses-object.test.js
```

实现前结果为 `0/5` 通过、`5/5` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/responses-object.js` 尚不存在。

完成最小实现并切换两个生产调用方后，直接测试为 `5/5` 通过，分别验证：

- 官方 Responses 对象保持引用身份；
- status、output、output_text 和 usage 四类兼容形状补充 object 标记；
- 无效 ID、数组、普通值和只有 ID 的对象均被拒绝；
- 官方形状与兼容形状均可被识别；
- 只有大小写精确、无 error 的 completed 响应被视为成功完成。

## 模块边界

新增 `src/responses-object.js`，导出：

- `normalizeResponsesObject`
- `isResponsesObject`
- `isCompletedResponsesObject`

`src/sse.js` 继续负责文本解析、事件分帧、嵌套候选遍历和终止事件判断；`src/upstream.js` 继续负责网络控制流、完整性错误、history 写入、日志和响应发送。

拆分后：

- `src/responses-object.js` 为 26 行；
- `src/upstream.js` 从上一批的 4785 行降至 4762 行；
- `src/sse.js` 降至 189 行；
- 三个对象函数没有在 `src/upstream.js` 或 `src/sse.js` 中残留重复定义。

## 验证结果

- Responses 对象红测：实现前 `0/5` 通过、`5/5` 按预期失败；
- Responses 对象绿测：`5/5`；
- 对象抽取、SSE、上游代理、历史持久化和服务端联合回归：`219/219`；
- `npm run check`：通过；
- Router 子套件：`588/588`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- `npm run audit:prod`：根项目 `0` 漏洞，内嵌 Bridge `0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `93.5` 秒；
- smoke 资源摘要：`28/2/3/46/3/0/2`。

Electron smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning；两项没有导致 smoke 失败，也不属于本轮对象纯逻辑拆分范围。

## 主要修改文件

- `src/responses-object.js`
- `src/upstream.js`
- `src/sse.js`
- `tests/responses-object.test.js`
- `package.json`

## 后续边界

1. Responses 对象兼容字段新增或完成状态契约变更时，应先扩展独立对象测试，不在 SSE 解析器中另建特殊判定。
2. SSE payload 的 response/data/result 候选遍历仍属于流协议解析，不应搬入对象模块。
3. 下一批可评估 Responses SSE 图像结果回填纯函数；流缓冲、大小上限和网络读取应继续留在 `src/upstream.js`。
4. 每次相关重构继续验证完整与截断 SSE、Sol/Terra、历史写入、Anthropic 鉴权和普通 API-key 路由。
