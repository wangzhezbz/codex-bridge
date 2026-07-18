# 整改记录 54：火山方舟刷新模型 GLM-5.2 协议错误

## 用户现象

- 在内置“Volcano Ark / Doubao”供应商中刷新到 `glm-5.2` 后，模型可以被选择，但请求无法正常运行。
- 同一供应商下的普通豆包 Chat 模型仍需保持现有行为，不能因修复 GLM-5.2 被整体切换协议。

## 根因

刷新模型生成路由时，所有远端模型都继承第一条豆包预设的 `chat_completions`。代码只保留了远端模型 ID 和展示信息，没有按模型或 Coding Plan 地址选择协议，因此 `glm-5.2` 被错误生成成 Chat Completions 路由。

火山方舟 Coding Plan 的 Codex 接入文档要求使用 OpenAI Responses 协议，并使用 `https://ark.cn-beijing.volces.com/api/coding/v3` 作为套餐地址；文档列出的模型名包含 `glm-5.2 (glm-latest)`。

## 修复

1. 对刷新得到的 `glm-5.2` 和 `glm-latest` 生成 Responses 路由。
2. 当供应商地址为 `/api/coding/v3` 时，该目录下刷新出的模型统一生成 Responses 路由。
3. 普通 `/api/v3` 下的其他豆包模型继续使用 Chat Completions，不改变现有路由。
4. GLM 展示名规范为 `GLM 5.2`，上游请求仍使用原始模型 ID。

## 回归边界

- 未修改内置豆包供应商的默认 Base URL。
- 未修改普通豆包 Chat 模型、其他供应商、自动选模或失败切换逻辑。
- 未修改 API Key、模型 ID和用户保存的供应商覆盖配置。

## 验证

- 新增失败优先回归：GLM-5.2 必须是 Responses，普通豆包仍是 Chat；Coding Plan 地址下模型必须是 Responses。
- `tests/desktop-settings.test.js`：343/343 通过。
- 适配器与路由保真测试：57/57 通过。
- `npm run check`：通过；Router 842/842、恢复 14/14 通过。

