# Router 整改记录 103：抽取 Responses 输入分析边界

## 整改目标

本轮从 `src/upstream.js` 提取 Responses 输入的纯数据分析逻辑，统一处理：

- 工具协议输入识别；
- 可见与加密用户输入的签名生成；
- opaque 用户输入检测。

重复请求判定、跨模型上下文比较、history 读取与响应元数据写入仍保留在 `src/upstream.js`。本轮不修改工具执行、续跑策略、网络请求、模型路由、默认模型、代理或用户凭据。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此使用静态定义、导入和调用面搜索替代：

- `requestHasToolProtocolInput` 只被当前工具协议续跑判断调用；
- `userInputSignatures` 被重复用户上下文判断、旧历史回退和响应元数据构建调用；
- `inputHasOpaqueUserInput` 被跨路由 opaque 输入判断与响应元数据构建调用；
- 内部递归协议识别、用户文本提取、签名规范化与 opaque 画像保持为模块私有函数；
- 新模块复用既有内容文本转换、Responses 输入归一化和有界签名函数；
- history、route、request 生命周期、网络、SSE、日志和响应发送均未进入新模块；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

## TDD 证据

先新增 `tests/responses-input-analysis.test.js`：

```powershell
node --test tests/responses-input-analysis.test.js
```

实现前结果为 `0/3` 通过、`3/3` 失败，原因均为预期的 `ERR_MODULE_NOT_FOUND`，因为 `src/responses-input-analysis.js` 尚不存在。

完成最小实现并切换生产调用后，直接测试为 `3/3` 通过，分别验证：

- 字符串、`input_text`、可见用户消息和加密用户消息的签名提取与空白规范化；
- 只有带 `encrypted_content` 的用户消息被判定为 opaque 输入；
- 嵌套 Responses 工具结果与 chat `tool_calls` 均被识别为工具协议，普通用户输入不会误判。

## 模块边界

新增 `src/responses-input-analysis.js`，公开导出：

- `requestHasToolProtocolInput`
- `userInputSignatures`
- `inputHasOpaqueUserInput`

拆分后：

- `src/responses-input-analysis.js` 为 103 行；
- `src/upstream.js` 从 4163 行降至 4067 行；
- `tests/responses-input-analysis.test.js` 为 78 行；
- 原输入分析函数家族已从 `src/upstream.js` 移除；
- 重复请求与历史元数据策略继续通过三个公开入口消费分析结果。

## 验证结果

- 输入分析红测：实现前 `0/3` 通过、`3/3` 按预期失败；
- 输入分析绿测：`3/3`；
- 输入分析、工具签名、续跑、上下文、历史、重复请求保护、上游代理和服务端联合回归：`261/261`；
- `npm run check:syntax`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`641/641`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 生产依赖审计：`0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `99.5` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`。

smoke 仍输出 Node.js SQLite experimental warning 和 Electron `console-message` deprecated warning，两项均未导致失败。

## 主要修改文件

- `src/responses-input-analysis.js`
- `src/upstream.js`
- `tests/responses-input-analysis.test.js`
- `package.json`

## 后续边界

1. 重复请求保护和跨路由上下文判断继续留在 upstream，因为它们读取 history、route 和请求上下文。
2. 输入分析模块只负责把原始 Responses/chat 输入变成稳定的布尔值和签名数组。
3. 下一批应重新扫描主文件剩余纯函数；若候选需要 history 或网络生命周期，应停止强拆并换边界。
