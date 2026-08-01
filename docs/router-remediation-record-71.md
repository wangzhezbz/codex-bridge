# Router 整改记录 71：Kimi 与 Kimi Code 供应商彻底分离

## 问题

旧实现把 Moonshot Kimi 与 Kimi Code 混在同一个 `kimi` 供应商中。两者实际使用不同的 Base URL、凭据和模型目录：

- Kimi / Moonshot：`https://api.moonshot.cn/v1`
- Kimi Code：`https://api.kimi.com/coding/v1`

这会导致刷新模型列表时请求错误端点、模型混入错误供应商，以及升级后继续引用旧的 Kimi Code 模型 ID。

## 根因

供应商身份只按产品名称归类，没有把 API 边界作为独立身份的一部分。旧配置还可能把 Kimi Code 地址、模型目录和 Key 保存到 `kimi` / `MOONSHOT_API_KEY` 下。

## 修复

1. 保留 `kimi` 作为 Moonshot 供应商：
   - Base URL：`https://api.moonshot.cn/v1`
   - Key：`MOONSHOT_API_KEY`
2. 新增独立的 `kimi-code` 供应商：
   - Base URL：`https://api.kimi.com/coding/v1`
   - Key：`KIMI_CODE_API_KEY`
3. 两个供应商分别刷新模型列表，Moonshot 不再注入 Kimi Code 模型。
4. 只有旧 `kimi` 配置的 Base URL 精确指向 Kimi Code coding 端点时，才迁移到 `kimi-code`。
5. 上述精确旧配置若尚未保存 `KIMI_CODE_API_KEY`，在下一次配置事务中一次性复制旧 Key；普通 Moonshot 配置不会复制或改写。
6. 旧 Kimi Code 模型选择、辅助模型、智能路由和故障备用引用统一修复到新的 `kimi-code-*` ID。

## 验证

- `node --test tests/desktop-config-transaction.test.js`
  - 31/31 通过
- `node --test tests/desktop-settings.test.js`
  - 358/358 通过
- `node --test tests/route-sync-smoke.test.js`
  - 1/1 通过

重点覆盖：

- 两个供应商的端点和 Key 完全独立。
- Moonshot 刷新不会出现 Kimi Code 模型。
- Kimi Code 刷新使用自己的端点与凭据。
- 普通 Moonshot 覆盖配置不会被迁移。
- 旧 coding 端点配置、Key、模型目录和路由引用可安全迁移。
- 重复执行迁移不会覆盖已经配置的 `KIMI_CODE_API_KEY`。

## 数据安全

- 未删除任何用户文件。
- 未把普通 Moonshot Key 写入 Kimi Code，除非旧配置明确指向 Kimi Code coding 端点。
- 原 `MOONSHOT_API_KEY` 在迁移后仍保留，便于用户继续使用 Moonshot 或回滚。
