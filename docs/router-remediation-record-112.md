# Router 整改记录 112：抽取 Responses 上游基础 URL 策略

## 整改目标

本轮从 `src/upstream.js` 抽取 Responses 上游基础 URL 选择逻辑：

- 识别精确的公共 OpenAI API hostname；
- 仅将 `codex_openai` 订阅路由从公共 API 地址转向 ChatGPT Codex backend；
- 保留 `CODEXBRIDGE_CHATGPT_CODEX_BASE_URL` 环境覆盖；
- API-key、自定义 Codex backend、自定义域名和非法 URL 原样返回；
- 保持 `src/upstream.js` 的现有公共导出兼容。

本轮不修改 route id、模型名、默认模型、故障切换、请求路径、代理或认证密钥。特别是 Sol/Terra/Luna 的模型选择与上游模型值均未改变。

## 影响分析

GitNexus 重构流程要求先查询代码图。当前仓库没有 `.gitnexus` 索引，系统也没有可用的 `gitnexus` 命令，因此改用静态定义、导入、调用和测试搜索：

- `responsesBaseUrlForRoute` 有三个 upstream 调用点；
- `src/server.js` 通过 upstream 公共导出在订阅图片端点中使用该策略；
- 策略只依赖 `authModeForRoute`、`route.baseUrl` 与一个环境变量；
- 请求 endpoint 拼接、header、代理、fetch、错误处理和模型 payload 均在策略外；
- `src/upstream.js` 继续重新导出 `responsesBaseUrlForRoute`，公共导出身份比较结果为 `true`；
- 新模块和直接测试已接入 `check:syntax` 与 `test:router`。

## TDD 证据

先新增 `tests/responses-upstream-url.test.js`：

```powershell
node --test tests/responses-upstream-url.test.js
```

实现前命令退出码为 `1`，测试文件在加载阶段按预期因 `ERR_MODULE_NOT_FOUND` 失败，因为 `src/responses-upstream-url.js` 尚不存在。

完成最小抽取并改接 upstream 后，直接测试为 `4/4` 通过，覆盖：

- `api.openai.com` 精确 hostname 与大小写规范化；
- 恶意相似子域、ChatGPT hostname 和非法 URL 拒绝；
- `codex_openai + api.openai.com` 使用默认 ChatGPT Codex backend；
- 环境变量覆盖默认 backend；
- API-key、已有 ChatGPT backend、自定义域名与非法 URL 保持不变。

环境变量测试均在 `finally` 中恢复调用前状态。

## 模块边界

新增 `src/responses-upstream-url.js`，公开导出：

- `responsesBaseUrlForRoute`
- `isPublicOpenAiApiBaseUrl`

拆分后：

- `src/responses-upstream-url.js` 为 22 行；
- `src/upstream.js` 从 3289 行降至 3271 行；
- `tests/responses-upstream-url.test.js` 为 83 行；
- 默认 ChatGPT Codex backend 常量和 hostname 判断只保留在新模块；
- upstream 与 server 继续使用相同的策略函数对象。

## 验证结果

- 直接契约红测：退出码 `1`，按预期为目标模块缺失；
- 直接契约绿测：`4/4`；
- Responses URL、stream、compact、URL fallback、route fidelity、server 与 upstream proxy 联合回归：`213/213`；
- 公共重新导出身份检查：`true`；
- `git diff --check`：退出码 `0`；
- `npm run check`：退出码 `0`；
- Router 子套件：`682/682`；
- 桌面主套件：`892/892`；
- 历史恢复套件：`16/16`；
- 根项目生产依赖审计：`0` 漏洞；
- 内嵌 Bridge 生产依赖审计：`0` 漏洞；
- 真实 Windows Electron smoke：退出码 `0`，耗时约 `112.2` 秒；
- 本次 smoke 动态资源摘要：`28/2/3/46/3/0/2`，加载 provider 数为 `19`。

## 主要修改文件

- `src/responses-upstream-url.js`
- `src/upstream.js`
- `tests/responses-upstream-url.test.js`
- `package.json`
- `docs/router-remediation-record-112.md`

## 后续边界

1. 新模块只选择 base URL，不拼接 `/responses` 或图片 endpoint，也不构造认证 header。
2. ChatGPT Codex backend 环境覆盖仍由调用进程显式控制，本批没有写入或修改用户环境。
3. 下一批应单独处理 `userFacingUpstreamDetail`、`looksLikeHtml` 和 `shouldHideCommonEnglishDetail` 三个已确认无调用的旧辅助函数，先完成死代码证据与删除影响审计。
