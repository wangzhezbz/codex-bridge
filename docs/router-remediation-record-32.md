# 整改记录 32：ChatGPT 插件页资源权威统计

## 现象

测试机 ChatGPT 插件页显示插件 10、应用 1、MCP 1、技能 16；CodexBridge 曾显示插件 11、应用 0、技能 19。

## 根因

- `codex plugin list --json` 返回的是 CLI 安装集合，当前 ChatGPT Desktop 渲染器还会应用版本相关的可见性选择器，因此 CLI 的 11 个条目不能直接作为桌面插件页主数量。
- App Server 启动早期可能返回不可用或空结果，旧逻辑会让后续空快照覆盖已经读取到的 Sites 应用。
- App Server 的 `skills/list` 包含用户技能；ChatGPT Desktop 技能页还会排除推荐技能目录中已单独归类的条目。测试机 19 个用户技能中有 3 个属于推荐目录，因此主数量是 16。

## 修改

- 只读解析当前安装的 ChatGPT Desktop `plugins-page-selectors-*.js`，动态取得桌面页隐藏规则；不在 CodexBridge 中硬编码排除 Browser。
- App Server 有权威插件列表时优先使用；没有时使用当前 Desktop 渲染器策略；两者都不可用才回退 CLI，并明确标记来源。
- 应用主集合只取 App Server `app/list`，保留最后一次权威成功快照；暂时不可用时显示缓存状态，不再用空结果覆盖 Sites。
- 技能主集合按 Desktop 技能页规则过滤插件内部路径、系统技能和推荐目录技能；用户技能与磁盘技能文件数量仅留在高级诊断。
- 资源页显示最后有效读取时间、读取状态和应用 ID；强制刷新链路记录 snapshot、list、state payload、broadcast 和 renderer 阶段。

## 验证

- 回归夹具：CLI 插件 11、Desktop 可见 10、用户技能 19、推荐目录命中 3、应用 Sites 1，结果为 `10 / 1 / 1 / 16`。
- 缓存回归：首次读取 Sites 成功，下一次 App Server 未就绪，仍保留 Sites 并标记 stale/cached。
- 版本适配回归：当前渲染器选择器隐藏 Browser；未来选择器没有该规则时不会被 CodexBridge 固定排除。
- 桌面相关测试：433/433 通过。

## 边界

本轮未修改会话、provider 作用域、历史数据库或侧栏逻辑。

