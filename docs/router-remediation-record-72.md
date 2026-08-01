# Router 整改记录 72：供应商路由身份与失效预设修复

## 范围

本轮只修复供应商目录与请求适配中的确定性错误，不调整 GPT 订阅策略，不改变 Sol、Terra、Luna 的现有行为，也不合并 Kimi 与 Kimi Code。

## 根因

1. Router 配置生成时把 GLM、OpenRouter、SiliconFlow 都降级标记为通用 `openai-compatible`，导致运行时无法使用这些供应商已有的专用推理参数转换。
2. 千帆预设仍使用旧的 `api.baiduqianfan.ai/v1` 地址。
3. DeepSeek 内置列表仍保留已经失效的 `deepseek-reasoner` 静态别名。

## 修复

1. GLM 路由保留 `zhipu` 供应商身份。
2. OpenRouter 路由保留 `openrouter` 供应商身份。
3. SiliconFlow 路由保留 `siliconflow` 供应商身份。
4. 千帆默认 Base URL 更新为 `https://qianfan.baidubce.com/v2`。
5. 移除失效的 DeepSeek R1 / `deepseek-reasoner` 内置预设；远程模型刷新仍按供应商真实返回结果工作。
6. 保持 Kimi 与 Kimi Code 的独立 Base URL、API Key 和模型目录不变。

## 失败测试

修复前新增测试能够稳定复现：

- GLM、OpenRouter、SiliconFlow 生成的路由错误落入通用适配器。
- 千帆仍返回旧 Base URL。
- 内置 DeepSeek 目录仍包含 `deepseek-reasoner`。

## 验证

- `npm run check:syntax`
  - 通过
- `node --test tests/adapter-profile.test.js`
  - 通过
- 供应商专项回归：
  - `tests/provider-model-refresh-flow.test.js`
  - `tests/route-contract-matrix.test.js`
  - `tests/request-adapter.test.js`
  - 通过
- 全量测试：
  - 1437/1437 通过
  - 0 失败

## 未改动的稳定边界

- GPT 订阅模式和 ChatGPT 原生路由
- Sol、Terra、Luna 的选择与账号兼容策略
- Kimi / Moonshot 与 Kimi Code 的供应商分离
- 豆包 / 火山方舟请求适配
- 手动选模优先级、自动选模开关和故障切换开关

## 后续风险

远程供应商新增模型的能力、上下文窗口和参数支持仍应以远程模型目录及供应商文档为准；在没有可靠能力证据时，不自动猜测或扩大模型能力。
