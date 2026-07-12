# CodexBridge Roadmap Progress

Verification 2026-07-06: `npm run check` passed with 435/435 tests. `npm run release:preflight -- --json` also passed with 14 pass, 7 warn, 0 fail, and `releaseGate.codeOrConfigOk=true`; `npm run release:code-ready -- --json` passed with `codeReady.ok=true`, so the remaining warnings are real Router/provider/installer evidence or current-machine setup, not repository code/config blockers.

Update 2026-07-06: the session center now explains the Markdown export migration boundary before users click export. The page says exports are for archive, migration reference, or manual recovery; they do not automatically write back to the Codex Desktop local session database, and target-machine API keys, plugins, MCP, Skills, and paths still come from the target machine.

Update 2026-07-06: exported Codex session/project Markdown now carries explicit migration guidance. Single-session exports include a per-session migration note; project, no-project, full-tree, and filtered multi-session exports add a top-level `迁移清单` before the session content. The exported files explain that they are for archive/migration reference, will not automatically write back to the Codex Desktop local session database, and that API keys, plugins, MCP, Skills, and local paths remain target-machine settings.

Update 2026-07-06: resource center action buttons now only expose actions that are actually wired. Unknown update/remove actions no longer surface a clickable button path that ends in a low-quality "temporarily unavailable" error; users get copyable diagnostics and wired actions for enable/disable, marketplace install/update, marketplace remove, and Codex Desktop update checks.

Update 2026-07-06: added `docs/goal-coverage-audit.md` as the stable goal coverage audit. It splits phase 1-5 into current code evidence, real environment acceptance, and next steps, and explicitly says missing real Key, real Router, or real installer evidence should not make the repository code look unfinished.

Update 2026-07-06: session/project diagnostics now expose classification reasons for every Codex session tree. The backend returns `classification.projectReasons`, project-source counts, sidebar-thread assignment counts, workspace-root counts, and projectless marker counts; the desktop session page and release preflight now surface those reasons so real-machine count differences can be explained instead of guessed.

Update 2026-07-06: Codex resource counting now treats every Codex CLI `installed + enabled` plugin as currently available, not just openai-curated entries. On this machine the current snapshot is MCP 4, plugins 15, skills 37, rules 2; cache-only and marketplace-only resources stay in diagnostics and are not counted as usable until Codex actually enables them.

Update 2026-07-06: image-generation intent detection now recognizes editorial and social visual requests such as 公众号配图、小红书封面图、朋友圈分享图、公众号首图、活动主视觉、KV 图, and English social share card requests. Guideline/spec/尺寸说明/审核清单 style tasks still stay in normal chat instead of being sent to the image provider.

Update 2026-07-06: added `npm run release:code-ready` as a local code-readiness gate. It still reports missing real Router, image provider, capability provider, installer, and local model-catalog evidence, but exits non-zero only when `codeReady.codeOrConfigBlockingItemIds` contains repository code/config blockers; JSON includes `codeReady.ignoredRealEvidenceItemIds` and `codeReady.ignoredLocalSetupItemIds` for handoff to real testers.

Update 2026-07-06: support diagnostics now include the same `codeReady` handoff summary as the CLI. Copied diagnostics show whether repository code/config is locally ready, which real-environment checks were intentionally left to testers, and which current-machine setup checks still need local evidence.

Update 2026-07-06: config package sync import and import-backup restore messages are now fully Chinese. Successful "从同步目录导入" and "恢复导入前备份" responses, missing sync package errors, missing import-backup errors, and the rare duplicate backup-name failure no longer leak English fallback text into the desktop UI.

Update 2026-07-06: release gate summaries now include `codeOrConfigOk`, and the CLI plain report prints `仓库代码状态`. Missing real API keys, real installer evidence, or current-machine Codex setup can be handed off as validation/setup work without making the repository code look unfinished.

Update 2026-07-06: image-generation history now labels external local paths as `外部` in the thumbnail slot. The backend still keeps those paths visible for troubleshooting, but the desktop UI no longer presents them as ordinary cached thumbnails.

Update 2026-07-06: image-generation history thumbnails now only inline files from CodexBridge's managed `generated-images` directory. If a history entry points at an external local path, the path remains visible for troubleshooting, but the settings page will not read and embed that file as a thumbnail.

Update 2026-07-06: image-generation history now preserves multiple failed attempts even when they do not have local image files. Successful image records still de-duplicate by saved local path, but key/quota/moderation/download failures remain as separate troubleshooting records instead of overwriting each other.

Update 2026-07-06: local image-generation previews now encode Windows paths segment-by-segment before placing them in Markdown image tags. Paths with Chinese characters, spaces, parentheses, or `#` still keep the raw Windows path in the assistant text, but the preview URL is safe enough for Markdown rendering.

Update 2026-07-06: image-generation success responses now use Chinese user-facing copy instead of "Image generated via ...". The response still includes provider names, generated URLs when applicable, local previews for saved files, and structured metadata for diagnostics.

Update 2026-07-06: large image-generation responses now include a Markdown local image preview when the generated file is saved locally but too large to inline. The assistant text still keeps the raw Windows path for locating the file, while the preview path is normalized for Markdown rendering.

Update 2026-07-06: resource center blocks now keep the "expand all" button outside the scrollable list. Large plugin/skill/cache groups still show a bounded preview, but the list itself scrolls and the expansion control remains visible and clickable instead of being buried inside the resource block.

Update 2026-07-06: image-generation responses now include the saved local file path in the assistant text when a generated image is saved locally but is too large to inline as `image_generation_call` base64. Small generated images still inline for direct display, while large results remain local and visibly reference the saved file.

Update 2026-07-06: session/project grouping now treats Codex `sidebar-project-thread-orders` as the authoritative thread list for the matching project root. If a session has the same `cwd` as a visible project but is not listed in Codex's sidebar project order, it stays under no-project sessions with reason `outside_sidebar_project_threads`; other real project roots without a sidebar order still fall back to workspace-root matching.

Verification 2026-07-06: `npm run check` passed with 432/432 tests after the sidebar project thread-order regression tests, local file `inspect_file` scoping, browser action scoping, Computer Use action scoping, image history external-thumbnail labeling, release-gate code/config status split, config package sync/restore localization, and the local code-readiness gate.

Update 2026-07-06: local file-processing bridge now exposes `file_processing/inspect_file` to chat-routed models when the current request asks to inspect metadata or preview an explicit local file path. Remote generic file providers still expose only `file_processing/extract_text`, so they no longer see local `path` / `filePath` / `localPath` fields. The desktop capability diagnostics also list the local file bridge actions as `diagnose`, `inspect_file`, and `extract_text`.

Update 2026-07-06: browser bridge actions are now scoped to the current request. URL read requests expose only `browser/read_url`; URL open requests expose only `browser/open_url`; combined search-and-read requests expose `web_search/search` plus `browser/read_url`. Shell fallback block messages now reuse the current tool schema too, so they no longer tell chat models to call unrelated browser or Computer Use actions.

Update 2026-07-06: Computer Use bridge actions are now scoped to the current request. Explicit app-launch requests expose only `computer_use/list_apps` and `computer_use/open_app` with the `app` input field; explicit desktop screenshot requests expose only `computer_use/screenshot_desktop` with the optional `displayId` input field. Generic "Computer Use" requests can still show the whole safe action set for discovery.

Update 2026-07-06: controlled capability input schemas are now request-scoped too. A pure web-search request exposes only the `query` input field instead of also showing URL, OCR image, file, local path, speech, video, app, or display fields; browser, screenshot, OCR, file, speech, video, and Computer Use requests keep only their relevant input fields.

Update 2026-07-06: controlled capability tools now scope both schema and guidance to the current user turn. If a request only asks for web search, CodexBridge exposes only `web_search/search` even when browser, OCR, and file providers are also configured; compound requests such as "search the web and read the best result" still expose both search and browser read actions, and "narrate this and generate a short demo video" still exposes speech plus video.

Update 2026-07-06: controlled capability tools are now request-scoped for chat routes. When capability providers are configured, CodexBridge no longer exposes `codexbridge_capability` for ordinary setup, UI, docs, wording, provider-configuration, or component-building requests such as "Build a webpage screenshot settings panel", "Write OCR provider setup docs", "Create a search box component", "帮我做一个网页截图按钮", or "帮我写一个 OCR 接入文档". Real capability requests such as search, browser URL reads, webpage screenshots, OCR, file extraction, local app opening, speech, and video still expose the bridge tool.

Update 2026-07-06: image-generation intent detection now keeps image-adjacent operations planning in normal chat. Requests such as "帮我生成一个图片缓存策略", "生成头像审核规则", "帮我生成海报投放计划", "生成封面发布流程", "Generate an image caching strategy", and "Create a poster publishing workflow" no longer trigger the image provider, while visual requests such as "帮我生成一张缓存策略海报" and "Generate an image of a caching strategy diagram" still route to image generation.

Update 2026-07-06: support diagnostics now include both normal release-gate and strict release-gate summaries. The strict summary treats WARN items as blockers and keeps the same real-evidence, local-setup, and repo-code buckets, so copied diagnostics can show what would block an actual `release:gate` run even when the non-strict preflight has no failures.

Update 2026-07-06: copied support diagnostics now include the release-gate blocker buckets too. The diagnostic text reports `realEvidenceBlockingItemIds`, `localSetupBlockingItemIds`, and `codeOrConfigBlockingItemIds` alongside the total blocking/failure/warning IDs, so a pasted support report can show whether the next action belongs to real-environment testing, current-machine setup, or repo code work.

Update 2026-07-06: release-gate classification now has three buckets: real-environment acceptance gaps, local setup/runtime tasks, and repository code/config blockers. Items such as missing Codex config, model catalog generation, or current resource snapshots are no longer reported as repo code blockers; they are handoffable local setup tasks.

Update 2026-07-06: release-gate plain output now uses Chinese labels for real-environment acceptance gaps, local setup/runtime tasks, and repository code/config blockers. Strict mode tells developers not to spin on missing real API keys, real Router runs, real installer evidence, or current-machine setup tasks that can be handed to testers.

Update 2026-07-06: the remaining local user-visible failure fallbacks in update checks, capability asset downloads, Codex session export validation, CodexBridge config write validation, and upstream/capability stream fallbacks now use Chinese messages. This keeps local-testable error paths readable without requiring real provider accounts or live user data.

Update 2026-07-06: chat-routed attachment placeholders are now localized. When non-GPT chat routes cannot forward audio, PDF, Office, or oversized file attachments, CodexBridge now inserts Chinese guidance telling the user to switch to a GPT/Responses route or provide transcript/text/OCR content, instead of leaking English "unavailable to this chat provider" placeholders.

Update 2026-07-06: model capability diagnostics now include audio input and attachment degradation. The capability page summarizes which models can accept audio, which ones have a safe fallback path for unsupported PDF, Office, oversized file, or audio attachments, and the per-model "why" text explains those limits without changing routing behavior.

Update 2026-07-06: Router configuration validation errors are now localized. Empty model lists, missing model fields, duplicate model IDs, unsupported API/auth modes, and Base URLs that point back to CodexBridge now produce Chinese guidance; unknown route API responses are also localized.

Update 2026-07-06: unsupported request Content-Encoding errors are now localized. Router request decoding now reports unsupported encodings and missing zstd runtime support in Chinese, and unsupported encodings are rejected before any upstream model call.

Update 2026-07-06: image-generation and config-package validation fallbacks are now localized. Missing image upstream callers, image result download failures, invalid config packages, embedded-secret package imports, and unsupported image provider adapters now use Chinese validation messages while preserving existing error classification.

Update 2026-07-06: missing-model route errors are now localized. When Codex or the Router asks for a model that is not configured, CodexBridge now returns a Chinese `model_not_configured` message with the requested model and available model IDs instead of the older English "Model is not configured" text.

Update 2026-07-06: auto-update user-facing notices and fallback instruction files are now localized. Windows update failure dialogs, install notices, portable fallback notes, installer notes, and completion/failure summary logs use Chinese copy while preserving the existing installer/portable update behavior.

Update 2026-07-06: legacy portable data migration logs are now localized. Successful and failed migration messages use Chinese text, so startup logs and diagnostics do not show English "legacy portable data" implementation messages.

Update 2026-07-06: generic capability proxy setup failures are now localized. Missing proxy executors, missing response builders, and unknown capability execution failures use Chinese messages, so a broken capability integration does not leak English implementation errors into the UI.

Update 2026-07-06: explicit capability failure text no longer uses an English fallback provider name. If a capability provider record is missing a display name, CodexBridge now falls back to "能力供应商" instead of "capability provider", keeping user-facing capability errors fully localized.

Update 2026-07-06: desktop local capability executor bridge failures now stay readable in Chinese. Missing local executor endpoints, authorization failures, unsupported local capability payloads, oversized request bodies, and invalid JSON are reported with actionable Chinese messages instead of leaking English bridge implementation text into Codex chat.

Update 2026-07-06: generic capability proxy provider-selection failures now use structured Chinese errors. When a capability such as OCR has no usable provider, the proxy reports `missing_capability_provider` with a readable "没有可用的 OCR 能力供应商" message instead of leaking English implementation text such as "capability provider is not configured".

Update 2026-07-06: capability diagnostics now explain image-generation proxy routing per model. The "生图代理" pill distinguishes official OpenAI image generation, inherited default image providers, model-specific provider overrides, missing providers, disabled providers, and no default provider instead of showing one generic independent-provider message.

Update 2026-07-06: capability provider execution now gives the same actionable diagnosis for HTML gateway failures. When a generic capability provider returns a 5xx HTML page, the user sees Base URL / Endpoint / proxy guidance instead of a generic provider outage message, and the raw HTML is not shown in the response text.

Update 2026-07-06: image generation provider tests now classify HTML gateway and webpage errors as Base URL / Endpoint / proxy issues. A 502 HTML response such as `Bad gateway` no longer falls through to the vague "no usable image result" health-check message, and raw HTML is still stripped before the user sees the diagnosis.

Update 2026-07-06: image generation health checks now classify common provider risk-control moderation failures as content-review blocks. Errors such as `risk_control failed` or `nsfw detected` now produce the same Chinese "内容审核拦截" guidance as explicit moderation/content-policy errors, instead of falling through to a vague provider failure.

Update 2026-07-06: strict release gate output now includes actionable blocker objects, not just item IDs. `releaseGate.realEvidenceBlockingItems`, `releaseGate.localSetupBlockingItems`, and `releaseGate.codeOrConfigBlockingItems` carry each blocker id, label, status, count, detail, and action; the plain CLI report prints Chinese next-action groups so real API/provider/installer evidence and current-machine setup gaps can be handed to testers without treating them as unfinished code.

Update 2026-07-06: release gate JSON now separates real-environment evidence gaps, local setup/runtime tasks, and repository code/config blockers. `releaseGate.realEvidenceRequiredItemIds` and `releaseGate.realEvidenceBlockingItemIds` list items that need real Router/provider/installer evidence, `releaseGate.localSetupBlockingItemIds` lists current-machine actions such as model catalog generation, and `releaseGate.codeOrConfigBlockingItemIds` keeps repo blockers separate. The plain release-gate report prints the same three buckets in Chinese, so real-data testing is not confused with unfinished code work.

Update 2026-07-05: session/project inventory now prefers Codex's current visible project roots: pinned projects, local project roots, and active workspace roots are used before older `project-order` or saved-workspace history. Historical generated folders stay as loose/no-project sessions when a real active project exists, so the desktop count no longer inflates old generated chat folders into current projects.

Update 2026-07-05: session rows now carry and display a project classification reason. Project sessions can show root matching or Codex thread assignment, while no-project sessions can show Codex projectless markers, generated output folders, workspace hints outside the current project list, missing workspace data, or plain paths outside current projects. This makes the session center explain why a chat landed under a project or under no-project sessions.

Update 2026-07-06: sync-directory config package exports now leave local backup evidence without putting local paths into the portable package. A successful "导出到同步目录" writes `config-package-sync.local.json` with the last directory, file name, export time, and package counts; the settings page shows the last sync export by file name, directory name, time, and counts, can open the recorded sync directory through a fixed internal target, while release preflight reads the same local status without exposing the full machine path.

Update 2026-07-06: config package imports now show a native confirmation preview before writing anything. The preview validates the package, rejects packages marked with embedded secrets, summarizes model selections, custom models, provider settings, capability/image providers, budgets, profiles, Codex resource manifest counts, and missing API Key names, then imports only after the user confirms.

Update 2026-07-06: confirmed config package imports now first back up the current local CodexBridge settings as a safe config package under `config/config-package-import-backups`. The backup keeps the previous model selection, providers, capabilities, budgets, profiles, and other portable settings, but still excludes API Key values, so a bad import can be rolled back by importing the backup package.

Update 2026-07-06: the settings page now shows the latest import rollback backup directly under the config package controls. It displays only the backup file name, backup directory name, time, size, and total backup count, and offers a fixed "open backup directory" action without exposing arbitrary paths.

Update 2026-07-06: import rollback backups now have a one-click restore path from the settings page. Restoring uses a native confirmation dialog, restores the latest `CodexBridge-config-before-import-*.json` package, and first writes a new backup of the current config so rollback does not destroy the state being replaced.

Update 2026-07-06: sync-directory config packages can now be imported back from the last recorded sync export without browsing for the JSON file manually. The settings page shows the action only when the recorded package still exists, the desktop main process reuses the same import preview confirmation, and the import still creates a rollback backup before writing.

Update 2026-07-06: the session center overview now separates project sessions from no-project sessions. The top summary shows total local Codex session index count, current Codex projects, project-owned sessions, active projects, historical projects, and no-project sessions so project grouping can be checked without doing subtraction by hand.

Update 2026-07-05: image generation intent detection now keeps more text-only image-adjacent requests in normal chat. English requests such as "Generate SEO title ideas for this poster image", "Generate hashtags for this image", "Create a file name for this poster image", "Create a logo tagline", and "Generate a sticker label" no longer trigger the image-generation proxy, while direct visual requests still route to the configured image provider.

Update 2026-07-05: release preflight help now shows the final `npm run release:gate -- --platform win32 --arch x64 --release-dir ...` command and explains that it is the strict release gate. The real Router acceptance gap text also now says "严格发布门禁" instead of the older generic preflight wording, so CLI help, desktop details, and release-gate JSON all point testers at the same final check.

Update 2026-07-05: real-environment acceptance guidance now points users to `npm run release:gate -- --release-dir <发布目录>` instead of the older non-strict preflight wording. Desktop preflight items, route-health warnings, incomplete acceptance-report guidance, and release-gate JSON evidence now all tell release testers to use the strict gate so missing real Router/provider/installer proof cannot be missed.

Update 2026-07-05: release preflight now has an explicit `npm run release:gate` command for final publish blocking. It runs `release-preflight` with `--strict-warnings`, accepts the same extra arguments after `--`, and the release docs now use it for the final local gate so warning-only real-environment gaps cannot be mistaken for publish-ready status.

Update 2026-07-05: image generation intent detection now catches editorial/content-marketing requests such as "给这篇文章配一张图", "给这段文案做个首图", and "帮我出个分享卡片". It still keeps planning/product/code requests such as "生成一份配图需求文档", "帮我写一个封面图的 prompt", and "分享卡片组件怎么写" in normal chat.

Update 2026-07-05: image generation error guidance now recognizes prompt/input length failures such as "prompt is too long" and "input text exceeds maximum length". Provider test results and chat fallback responses now tell users in Chinese to shorten the prompt, reduce reference content, or split the generation request.

Update 2026-07-05: image generation intent detection now recognizes more natural Chinese requests such as "帮我弄一张小猫图", "帮我设计一张黑金风海报", and "帮我弄个头像" as real image-generation tasks, while keeping the existing product/setup/image-understanding exclusions.

Update 2026-07-05: release docs now mention the desktop-side `保存门禁报告` path alongside the CLI `--write-gate-report` path, so manual validation from the app and machine validation from the release script produce comparable gate evidence.

Update 2026-07-05: desktop preflight can now save a strict release gate JSON directly. The new "保存门禁报告" action writes the same machine-readable `releaseGate`, status counts, preflight items, data root, Codex resource snapshot context, Router state, and selected release-directory evidence that the CLI gate uses, with warnings treated as blockers for release evidence while the normal text diagnostics remain non-strict.

Update 2026-07-05: desktop acceptance reports and live desktop preflight can now include real installer evidence from a selected release directory. The preflight page has a release-directory control, saves that local path only in desktop options, scans `CodexBridge-Windows-x64-Setup.exe` and `CodexBridge-Windows-x64-Portable.zip` for file path, size, and header bytes when building the desktop check or saving the acceptance JSON, and strips the local release path from exported config packages.

Update 2026-07-05: desktop preflight can now save a real acceptance report JSON directly. The report records live Router health, recent successful image provider tests, recent successful capability provider or local bridge tests, and Windows installer asset evidence when provided; missing evidence keeps the report marked as not fully accepted instead of pretending code tests are real user-environment acceptance.

Update 2026-07-05: capability provider market copy, empty states, execution history, and release preflight warnings now describe the full current ability range. The settings page and `capability_providers` preflight item both mention OCR, search, browser, webpage screenshots, file processing, Computer Use, speech, and video, and the action text now distinguishes remote providers from local bridge providers, so users do not mistake the capability market for the older OCR/search-only scope.

Update 2026-07-05: image generation intent detection now keeps image-generation management work in normal chat. Requests for history panels, thumbnails, local-path displays, provider template buttons, API error-message translation, and similar settings/product tasks no longer trigger the image-generation proxy, while colloquial Chinese generation requests such as "出一张小猫图" and "画个黑金风科技图" still route to the image provider.

Update 2026-07-05: Codex Desktop startup preflight now reuses Windows auto-discovery when no launch target was saved. It checks common install paths plus desktop and Start Menu shortcuts, so a normal Codex install can pass release preflight without forcing the user to manually pick `Codex.exe`.

Update 2026-07-05: Codex resource preflight now treats Codex CLI / current prompt snapshots as the authority for currently usable resources. Extra local plugin cache and skill cache entries are still shown for diagnosis, but they no longer create a warning when Codex already reports the current usable MCP, plugin, and skill set.

Update 2026-07-05: resource center skill counts now exclude Codex system skills, plugin-provided skills, plugin cache skills, and `.agents` skills from the main "currently usable skills" number. Those entries stay visible in discovered/cache diagnostics, while the primary count mirrors user-managed Codex skills that the current prompt actually loaded.

Update 2026-07-05: resource center management now invalidates Codex resource snapshots immediately after successful plugin/MCP toggles, local skill toggles, plugin installs, plugin removals, and marketplace refreshes. The desktop UI no longer reuses stale Codex CLI or prompt-input snapshots right after a user changes resource state.

Update 2026-07-05: generic HTTP capability providers now guard oversized responses. `executeCapabilityProvider` checks `Content-Length` before reading the body, checks actual UTF-8 bytes after reading when no length is available, defaults to an 8 MB limit, and supports per-provider `maxResponseBytes`. Oversized responses are recorded as `provider_response_too_large` and are not read into results or history.

Verification 2026-07-05: `npm run check` passed after the resource snapshot invalidation, bounded response, and bounded asset changes. The checks include Codex resource cache invalidation after management actions, Router-side generic capability response limits, shared capability asset download limits, desktop capability execution limits, and provider model directory response limits.

Update 2026-07-05: provider model directory refresh now uses the same bounded response reader. Oversized remote model-list responses are rejected before reading `text()` or `json()`, the previous cached model directory is kept stale instead of being overwritten, and the failure message explains that the model-list response was too large.

Update 2026-07-05: capability result asset downloads now guard `Content-Length` before reading the body and actual bytes after reading when no length is available. The default asset limit is 64 MB and providers can override it with `maxAssetBytes`; oversized image/audio/video result files fail with `asset_too_large` instead of being loaded into memory.

Update 2026-07-05: Router-side generic capability execution now has the same bounded response protections. Remote capability providers can set `maxResponseBytes`, Router rejects oversized provider responses before calling `text()`, and shared capability asset saving honors `maxAssetBytes` for URL, data URL, and base64 result files.

Update 2026-07-05: Router user-facing capability errors now localize the new oversized response and oversized result-asset cases. `provider_response_too_large` and `asset_too_large` produce Chinese guidance and no longer leak raw English implementation errors into `output_text`.

更新时间：2026-07-05

这份清单用于固定当前真实进度，避免“昨天 90%，今天 50%”这种口径漂移。状态只按代码与测试结果判断；需要真实账号、真实 API Key、真实安装器流程验证的地方会单独标出。

## 当前验证

- `npm run check`：通过；当前全量检查包含 syntax、Router 测试和 Desktop 测试，435 项通过、0 个失败；新增模型列表缓存体检、真实环境验收体检、Codex 项目列表回归、会话归类依据回归、会话搜索/筛选导出回归、会话导出迁移说明回归、多会话导出顶部迁移清单回归、会话页导出迁移边界说明回归、资源中心快照失效回归、打包应用 smoke 证据回归、真实验收报告读取回归、真实验收报告自动生成回归、验收报告输出元信息回归、发布门禁报告落盘回归、英文非图片产物生图误判回归、显式生图请求优先生图代理回归、图片运维策略/规则/流程类任务保持聊天回归、能力工具不在 UI/文档/配置任务里过早暴露回归、能力工具按当前请求收窄 schema 和 guidance 回归、能力工具 input 字段按当前请求收窄回归、Computer Use action/input 按当前请求收窄回归、browser action/input 按当前请求收窄回归、local file inspect_file action/input 按当前请求收窄回归、代码任务保持已选代码模型回归、普通聊天低成本自动选模型回归、供应商级限流/余额自动切换回归、失败自动切换低成本备用路由回归、自动选模型避开已降级/已限流路由回归、自动选模型避开已达每日预算候选回归、失败自动切换避开本地 cooldown 和已达每日预算备用路由回归、智能切换排除原因日志回归、请求详情展示智能路由排除原因回归、智能路由设置安全说明回归、每日费用预算提醒回归、配置包含密钥拒绝导入回归、配置包导入预览确认回归、配置包导入前备份回归、配置包最近导入备份恢复回归、同步目录配置包本地证据回归、同步目录最新配置包导入回归、配置包同步导入/恢复中文文案回归、桌面和 Router 侧本地浏览器 read_url 大响应保护回归、本地文件 inspect_file 检查/历史元数据回归、能力历史文件元信息和文本预览展示回归、更新下载产物文件头校验回归、能力诊断生图代理来源解释回归、图片历史外部缩略图标记回归、发布门禁仓库代码状态回归、本地代码就绪门禁回归、桌面复制诊断 codeReady 交接回归都已完成全量 check 盖章。
- 生图意图识别：新增中文口语否定、口语化正向、编辑/社交配图和生图管理任务回归，显式 `tool_choice=image_generation` 下，`不要用图片生成`、`图片不用生成`、`生图暂时不用`、`生图不要调` 会留在聊天；`给我一张小猫图片`、`我要一张海报`、`I need a poster`、`Give me a logo`、`给公众号文章配个图`、`小红书封面图`、`朋友圈分享图`、`公众号首图`、`活动主视觉`、`KV 图`、`social share card` 会触发生图；生图历史面板、缩略图、本地路径、图片供应商模板按钮、图片生成接口错误提示翻译这类产品/设置任务仍留在聊天；`logo SVG 组件`、`图片预览 Vue 组件`、`封面图尺寸说明`、`配图规范`、`封面图命名规则`、`封面图审核清单`、English image guidelines / hero image specs 这类工程、规范和清单产物不会误触发生图；`不要用蓝色，生成...` 和 `Python 代码雨风格海报` 这类画面约束/风格描述仍会触发生图。
- 配置包导入安全：如果外部配置包明确标记 `includesSecrets: true`，会在导入前拒绝，避免把含 API Key 的包误当成安全迁移包。
- 本地浏览器桥接安全：桌面执行器和 Router 直接执行的 `read_url` 都会按 `Content-Length` 和实际字节数限制响应大小，超限时在读取正文前停止，避免大页面浪费本地内存。
- 自动更新下载安全：安装版下载完成后会校验 Setup.exe 的 `MZ` 文件头，便携包会校验 ZIP 的 `PK` 文件头；如果 GitHub、代理或网关返回 HTML 错误页，不会继续打开安装器或执行替换脚本。
- `npm run release:preflight -- --json`：通过；当前未启动 Router 且本机未安装 NSIS / makensis 时为 14 通过、7 提醒、0 失败，`releaseGate.codeOrConfigOk=true`，没有仓库代码/配置阻断项；配置包体检已和资源中心共用 Codex CLI / 输入框当前资源快照，本机当前快照显示可用 Codex 资源 58 项、配置包 Codex 资源清单 58 项，其中 Codex CLI 已安装且已启用的插件全部计入当前可用，本地发现/缓存资源只作诊断且不计入当前可用，Codex Desktop 体检可通过 Windows 开始菜单/桌面/常见安装目录自动发现，不再要求用户先手动保存路径；自动更新项会明确提示本机暂不能生成真实 Setup.exe，打包后的 `CodexBridge.exe` smoke 证据会作为单独通过项展示；如果真实 Router、图片供应商、能力供应商和安装器验收在外部完成，可通过 `--acceptance-report <path>` 把 JSON 留证并入 `real_environment_acceptance`；如果这些验收已经落在当前机器的 Router 探测、供应商 lastTest 和 release 目录中，可通过 `--write-acceptance-report <path>` 自动生成验收 JSON；需要给 CI 或手动发包留完整门禁证据时，可加 `--write-gate-report <path>` 写出完整 release gate JSON；GitHub Actions 会把 Windows 和 macOS gate report 作为 CI artifact 留证，但公开 GitHub Release 只发布安装包和免安装包。
- 模型列表缓存体检：发布体检会检查远程模型列表缓存；没有缓存时明确说明使用内置离线预设，缓存超过 7 天或时间不可用时提醒重新同步模型列表，避免模型页数量和真实供应商状态长期漂移。
- 供应商测试时效体检：图片供应商和能力供应商的最近通过记录如果超过 7 天，发布体检会提醒重新测试，避免拿很久以前的成功记录当作发包依据。
- 真实环境验收体检：发布体检会单独汇总真实 Router、真实图片供应商测试、真实能力供应商/本地桥接测试、真实 Windows 安装包发布目录；缺少证据时只给提醒，不会把代码测试通过伪装成真实环境通过；`--write-acceptance-report` 可从当前 Router 探测、近期供应商测试记录和有效 Windows 发布目录自动写出验收 JSON，`--acceptance-report` 可读取外部真实验收 JSON，报告不存在或 JSON 读取失败时会在体检详情里明确说明。
- 发布体检文案口径：普通 CLI 报告在 0 失败但仍有提醒时显示“有提醒”，不再写成“可发布”；严格模式仍会把 WARN 项作为发布阻断，避免测试包和正式发包时误读体检结果。
- 删除安全体检：已扫描发布/更新相关文件，未发现 `del /s`、`rd /s`、`rmdir /s`、`Remove-Item -Recurse`、`rm -rf` 这类禁用批量删除命令；该项已纳入发布前体检。
- 模型目录预检：已能区分“0 个路由”和“已有默认/保存的模型选择但路由配置未生成”，避免进度口径误判。
- CLI 发布体检：会主动探测当前配置端口上的 Router 健康状态；Router 已运行时能直接把 Router 和路由健康纳入门禁结果。
- 临时真实 Router + CLI 发布体检：通过；使用独立临时数据目录和临时 home 生成 5 条路由、启动 Router，再执行 `scripts/release-preflight.mjs --data-dir <temp> --home-dir <temp> --json`，结果为 16 通过、5 提醒、0 失败；Router、路由健康和模型目录均为通过。该验证只证明本地 Router / 路由体检链路，不替代真实图片供应商、真实能力供应商或真实 Windows 安装器验收。
- `npm run desktop:smoke`：通过；Node/Electron 输出了 SQLite experimental warning，不影响结果。
- `npm run package:win`：通过，生成本地 Windows 包 `release/CodexBridge-Windows-x64-Portable-v0.2.3-local-2026-07-05-065933779/CodexBridge-win32-x64`。
- `npm run package:win:smoke`：通过，打包后的 `CodexBridge.exe` 能完成桌面 smoke 和 Router health smoke，并写入 `release/packaged-smoke-report.json` 供发布体检读取；最新验证路径为 `release/CodexBridge-Windows-x64-Portable-v0.2.3-local-2026-07-05-065933779/CodexBridge-win32-x64/CodexBridge.exe`。
- Windows artifacts 脚本：`npm run package:win:artifacts` 已接入本地脚本和 GitHub Actions；已用测试内假 `makensis` 验证 portable zip、`.codexbridge-portable` 标记和 Setup 输出链路。发布体检会检测本机是否有 NSIS / `makensis`；带 `--release-dir` 时会同时检查 `Setup.exe` 和 `Portable.zip` 不是空文件，并确认文件头分别像 Windows EXE 和 ZIP；当前机器缺少 NSIS 工具，真实 `Setup.exe` 生成仍需在安装 NSIS 的 Windows 环境或 CI 中验证。

## 第一阶段：生图代理

| 事项 | 状态 | 边界 |
| --- | --- | --- |
| 测试生图按钮 | 已完成 | 图片供应商页可以直接测试，展示预览、耗时、本地路径和错误。 |
| 图片生成历史 | 已完成 | 支持缩略图、失败记录、本地文件定位和清理策略。 |
| 生图错误提示 | 已完成 | Key、余额、限流、模型名、尺寸、审核、下载失败等会转成中文提示。 |
| 供应商模板 | 已完成 | 已有硅基流动、智谱/Z.ai、OpenAI、通用接口模板。 |
| 模型卡片生图代理折叠 | 已完成 | 每个模型只常显图片上传和上下文，生图代理放到高级设置。 |
| 生图意图识别 | 持续增强 | 已补英文、中文误判、口语化正例、编辑/社交配图和生图管理任务场景；封面、壁纸、表情包、贴纸、横幅、产品图、公众号配图、小红书封面图、朋友圈分享图、公众号首图、活动主视觉、KV 图、social share card 等真实视觉目标会触发生图代理，组件、上传页面、规范、尺寸说明、命名清单、审核清单、API 配置、生图历史、缩略图、本地路径、供应商模板按钮、错误提示翻译等非图片产物仍留在聊天里；英文 logo/design spec、poster specification、image guidelines、hero image specs、naming convention、checklist、manifest，以及中文 `logo SVG 组件`、`图片预览 Vue 组件` 等工程产物不会再误触发生图；自动选模型手动开启后，显式“生成图片/海报/插画”等请求会优先生图代理，即使提示词里包含 Python、代码雨等画面风格词；后续如果用户给出新误判样例，继续加回归。 |

## 第二阶段：产品化底座

| 事项 | 状态 | 边界 |
| --- | --- | --- |
| 通用能力代理底座 | 已完成 | 流程包含识别请求、选供应商、执行、保存结果、构造回复、历史记录。 |
| 模型能力诊断 | 已完成 | 能展示模型能力、图片代理、能力供应商状态和诊断结果。 |
| 供应商健康检查 | 已完成 | 能检查 Key、模型、返回格式、权限/额度类错误；图片供应商和能力供应商的通过记录超过 7 天会在发布体检里提醒重新测试；真实供应商仍需用户填 Key 实测。 |
| 配置导入导出 | 已完成 | 支持模型、供应商、能力、预算、配置档等；API Key 默认不导出；导入前会先预览覆盖范围、缺失 Key 和 Codex 资源清单提示，用户确认后会先备份当前本机配置为不含 Key 的配置包，再写入新配置。 |
| 自动更新流程 | 已完成代码与测试 | 安装器路径、桌面图标、启动新版、清理安装包已有测试；发布目录体检会拦截缺失、旧命名、空文件和错误文件头；仍建议发包前做真实安装器端到端测试。 |
| 发布前体检 | 已完成 | release preflight 已覆盖路由、图片代理、能力供应商、资源、配置包、更新流程等；本地 Chrome / Computer Use 能力会明确标注为 CodexBridge 受控桥接，并说明安全动作和边界；CLI JSON 和桌面复制诊断都会给出 releaseGate 阻断原因与具体体检项 id，便于发包前留证、CI 判断和排查。 |

## 第三阶段：能力扩展

| 事项 | 状态 | 边界 |
| --- | --- | --- |
| 通用能力供应商 | 已完成基础版 | 支持多能力分组、默认/备用/优先级、测试、执行和历史；本地文件检查记录会在历史里展示文件名、类型、行数、文本预览和本地定位入口。 |
| 图片、OCR、搜索、文件、语音、视频能力槽 | 已接入配置与执行框架 | 具体能力是否可用取决于用户配置的供应商。 |
| 本地浏览器桥接 | 已完成安全子集 | 支持打开 URL、读取网页、网页截图；只接受 http/https；体检会说明它不是 GPT 原生 Chrome 工具。 |
| 本地文件桥接 | 已完成安全子集 | 支持检查单个明确本地文本文件和读取文本内容；返回文件名、类型、大小、行数和预览；拒绝目录、过大文件和明显二进制文件。 |
| Computer Use 桥接 | 已完成安全桥接基础版 | 只开放白名单查询、白名单启动应用和桌面截图；不开放鼠标、键盘和任意命令。完整原生 Computer Use 仍需要 GPT / OpenAI Responses。 |
| 多供应商能力市场 | 已完成基础版 | 可按能力查看供应商、默认、备用、禁用和测试结果。 |

## 第四阶段：智能路由

| 事项 | 状态 | 边界 |
| --- | --- | --- |
| 自动选模型 | 已完成基础版 | 默认关闭，必须用户手动开启；设置页会明确说明只影响后续新请求；自动候选会避开路由健康里已降级、本地 cooldown 中或本地预算已达到每日上限的路由，避免连续命中刚刚限流、失败或已被预算守卫拦截的模型，并在日志和请求详情里记录被排除的候选和原因；如果用户已经选在最合适的代码模型上，代码任务会保持当前模型，不会再被普通聊天回退逻辑拉回默认聊天模型；普通聊天在至少两个普通聊天候选配置了明确单价时，会优先选择预估成本更低的聊天模型，且不会把代码专用或长上下文专用模型当成便宜聊天模型。 |
| 失败自动切换 | 已完成基础版 | 默认关闭，必须用户手动开启；设置页会明确说明只影响后续新请求；会明确记录/提示切换原因；遇到限流或余额类供应商级错误时，优先切到不同 provider，避免从同一个上游的一个模型跳到另一个同样受限的模型；同一兼容范围内如果至少两个备用候选配置了明确单价，会优先选择预估成本更低的备用路由；备用候选如果正在本地 cooldown 或已经达到每日预算上限，也会被跳过，并在日志和请求详情里记录被排除的路由和原因。 |
| 成本和额度控制 | 已完成基础版 | 支持全局、模型、供应商维度的请求/Token/费用提醒；可配置每日费用上限，Router 会按用量和百万 token 单价估算成本，命中上限后本地拦截后续请求；自动选模型和失败自动切换开启时，已达到每日上限的候选不会再被自动选中或作为备用路由，用户手动选择该模型时仍会收到本地预算拦截提示。 |

## 第五阶段：用户资产

| 事项 | 状态 | 边界 |
| --- | --- | --- |
| 会话/项目管理 | 已完成基础版 | 按 Codex 当前可见项目优先展示：固定项目、本地项目和当前活跃 workspace 优先，历史 `project-order` / saved workspace 只在没有当前项目时兜底；旧的生成目录和历史工作区不会再被强行算成当前项目，会归入无项目会话用于找回和导出；会话数量标为“本机 Codex 会话索引”，用于找回和导出，避免误解成侧边栏当前第一页；概览会分别显示项目内会话和无项目会话，方便核对项目归属；项目和单个会话都能直接打开对应本地目录，支持按项目、路径、标题、模型和摘要搜索；搜索只影响页面显示，既可导出当前筛选 Markdown，也保留全部/项目/无项目的完整范围导出，方便核对和找回。 |
| 本地配置包 | 已完成 | 可迁移模型、供应商、能力、配置档、预算，以及只作迁移参考的 Codex 资源清单（MCP/插件/技能/提示词/AGENTS）；发布体检和手动导出会尽量复用 Codex CLI 与 Codex 输入框当前资源快照，避免资源中心和配置包数量不一致；Key 需要目标机器重填，导入确认框会列出缺失 Key，导入前自动留下可回滚的旧配置包，设置页会显示最近导入备份，可打开备份目录，也可确认后一键恢复最近备份；恢复前会再备份当前配置，资源不会在导入时自动启用。 |
| 插件/技能/MCP 管理 | 已完成基础版 | 资源页可诊断、复制、打开、启停、更新；计数区分当前可用、本地缓存/未启用和插件市场候选；切换插件/MCP 前会先备份 Codex 配置，并在界面提示备份路径。 |
| 云备份 | 已完成基础版 | 先不接具体云厂商 API；设置页可选择 OneDrive、坚果云、网盘同步盘等本地同步目录，把不含 API Key 的配置包导出到该目录；同步目录导出会在本机留下 `config-package-sync.local.json` 证据，设置页和发布体检只展示文件名、同步目录名、时间与数量，不暴露完整机器路径；设置页可通过固定内部目标打开上次同步目录，也可在记录的配置包仍存在时直接从同步目录导入，导入前仍会预览并备份当前配置。 |
| 完整插件市场安装体验 | 已完成基础版 | 能用 `codex plugin list --available --json` 识别 Codex CLI 快照里的可安装 marketplace 插件，资源页可手动刷新插件市场快照，展示“可安装”，并从本地 marketplace manifest 读取显示名、用途、分类、能力和来源详情；资源卡片可打开详情弹窗，确认真实来源、可用性、诊断和管理边界；资源页可按已安装、插件市场候选、本地缓存、OpenAI / Claude / 个人来源筛选，方便对齐 Codex 里实际能用和本地发现的差异；可通过确认后调用 Codex CLI 安装/更新 marketplace 插件，已安装的非内置 marketplace 插件也可通过二次确认后调用 `codex plugin remove` 卸载；资源页已经提供“搜索插件市场”入口，会先刷新 Codex CLI 插件市场快照，再自动切到“插件市场候选”并按关键词筛选。 |

## 发包前必须再做

1. 用真实用户配置启动 Router，再跑一次 `npm run release:gate -- --release-dir <发布目录>`，确认模型目录、路由健康和真实验收缺口不再只是提醒；临时独立配置下的真实 Router 探测已经通过。
2. 用真实图片供应商 Key 测一次生图，确认图片能展示并落本地。
3. 用真实能力供应商或本地能力跑一次能力诊断。
4. 在安装 NSIS 的 Windows 环境或 GitHub Actions 中跑 `npm run package:win:artifacts`，再用 `--release-dir dist-artifacts` 确认 `CodexBridge-Windows-x64-Setup.exe` 和 `CodexBridge-Windows-x64-Portable.zip` 都生成、不是空文件，且文件头格式正确。
5. 用生成的 Windows 安装包做一次真实安装/更新端到端验证。
6. 用户明确要求发包后，才发布 GitHub Release。
