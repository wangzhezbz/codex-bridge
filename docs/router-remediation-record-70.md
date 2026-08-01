# Router 整改记录 70：Kimi 刷新后缺少新模型

## 现象

用户在内置 Kimi 供应商中点击“刷新模型列表”后，仍然看不到 Kimi Code 当前模型。

## 根因

内置 Kimi 配置混用了两套彼此独立的服务：

- API Key 与文档指向 Kimi Code；
- 默认 Base URL 却指向 Moonshot Platform。

因此刷新请求实际访问的是 Moonshot 的 `/v1/models`，无法保证返回 Kimi Code 当前目录。单纯提示“刷新成功”不能解决数据源错误。

## 修改

1. 内置 Kimi 的默认 Base URL 改为 `https://api.kimi.com/coding/v1`。
2. Kimi Code 刷新结果会保留官方当前模型：
   - `k3`
   - `k3-256k`
   - `kimi-for-coding`
   - `kimi-for-coding-highspeed`
3. 远端 `/models` 返回的额外模型仍会合并保留；同 ID 的远端元数据优先。
4. 识别并升级老版本保存的“Moonshot Base URL + Kimi Code 文档/密钥页”混合默认配置，避免老用户仍停留在错误目录。
5. 用户若明确把 Base URL 配置为 `https://api.moonshot.cn/v1`，并使用 Moonshot 文档配置，继续使用 Moonshot 目录，不注入 Kimi Code 模型。
6. 继续兼容已有 `MOONSHOT_API_KEY` 密钥存储，避免升级后要求用户重新填写 Key。

## 失败测试与修复验证

修复前，内置 Kimi 刷新测试收到的是 Moonshot URL，无法满足 Kimi Code 目录断言。

修复后：

```text
node --test --test-name-pattern "built-in Kimi refresh|saved legacy Kimi bundled default|explicitly pointed at Moonshot" tests/desktop-settings.test.js
tests 3
pass 3
fail 0
```

完整桌面回归：

```text
npm run test:desktop
tests 868
pass 868
fail 0
```

## 影响边界

- 只改变内置 Kimi 的默认模型目录来源和 Kimi Code 目录合并。
- 明确配置的 Moonshot Base URL 保持独立。
- 其他供应商、Router 路由选择和请求转发逻辑不受此修改影响。
