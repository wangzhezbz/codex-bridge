# 整改记录 55：动态模型目录协议与类型边界审计

## 审计范围

本轮沿着动态模型的完整执行链检查同类问题：

1. 供应商 `/models` 刷新结果；
2. 模型目录与展示名称；
3. 供应商设置保存后的继承规则；
4. Router 配置生成；
5. Responses / Chat 适配器选择。

## 确认的同类根因

### 1. 保存供应商会覆盖模型级协议

供应商编辑页保存的是供应商级 `api`。旧逻辑在构建模型目录时会把该值重新覆盖到每一个内置动态模型，因此即使刷新阶段已把 `glm-5.2` 或 Coding Plan 判定为 Responses，用户再次保存火山供应商后仍可能被降回 Chat Completions。

### 2. 非对话模型会进入 Codex 模型栏

此前除火山方舟外，其余供应商会把 `/models` 返回的全部 ID 都当作对话模型。Embedding、Rerank、生图、视频、语音、审核等模型因此可能出现在模型栏，选中后才在运行阶段报接口或参数错误。

## 修复边界

1. 保存供应商后，模型协议重新经过模型 ID 与 Base URL 的权威规则计算：
   - 火山 `glm-5.2` / `glm-latest` 使用 Responses；
   - `/api/coding/v3` 下的模型使用 Responses；
   - 普通 `/api/v3` 豆包对话模型继续使用 Chat Completions。
2. 所有动态供应商统一过滤明显非对话模型；优先使用上游返回的类型/能力元数据，缺少元数据时再按模型 ID 分类。
3. 原始远程目录仍完整保存在缓存中供诊断，仅 Codex 可选择的对话模型目录执行过滤，不删除任何上游记录。
4. Qwen VL 等可通过 Chat Completions 使用的多模态理解模型继续保留。
5. 不修改自动选模、失败切换、API Key、供应商 Base URL 或现有内置模型的默认协议。

## 回归覆盖

- 保存火山供应商后，GLM 5.2 的最终 Router 路由仍为 Responses。
- 保存普通火山地址后，普通豆包最终 Router 路由仍为 Chat Completions。
- 保存 Coding Plan 地址后，该目录生成的最终 Router 路由均为 Responses。
- OpenAI 动态目录不会把 Embedding、生图、语音、审核模型放进对话模型栏。
- Qwen 动态目录不会把 Embedding、Rerank、TTS 模型放进对话模型栏，同时保留 Coder 与 VL 对话模型。

