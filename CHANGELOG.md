# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> 分叉声明 / Fork notice：本项目自 `TiaraBasori/opencode2api` 的 `v1.5.0`
> 起由 `samson910022/OpenCode2API` 独立维护。`v1.5.0`（含）以前见上游历史；
> 此后变更见本节（`[Unreleased]`）及后续版本节。

### Changed

- **独立维护声明**：README 致谢明确直接上游 `TiaraBasori/opencode2api`，LICENSE 追加上游归属，CHANGELOG 声明分叉点。
- **仓库去耦合**：文档克隆/Issue 链接与 Docker 镜像指向 `samson910022/OpenCode2API`，`package.json` 补全维护元数据。
- **Responses 示例模型**：`README`、`docs/api-reference.md`、`docs/getting-started.md` 的 `/v1/responses` 示例统一为 `opencode/muse-spark-1.3-contributor-free`（解析逻辑无需改动，裸名与带前缀均兼容）。
- **SDK 对齐**：`@opencode-ai/sdk ^1.1.51` → `^1.18.29`（与本地 server `1.18.29` 对齐；v1 调用形状不变，零改码；139 tests 全绿；`cross-spawn@7.0.6` 为 SDK 新增 prod 依赖，既有包去 dev 标记，无新版本；`tool.ids` 仍走上游 experimental 路径，后续跟进）。

### Added

- **Anthropic Messages API**：新增 `POST /v1/messages`（`max_tokens` 必填，支持 `system`/`tools(input_schema)`/`tool_choice{auto,any,tool,none}`/`thinking→reasoning`/`image`；`tool_use.id` 原样往返；非流式回 `message` 对象，流式回 `message_start/content_block_*/message_delta/message_stop` 无 `[DONE]`；认证同时支持 `x-api-key`；CORS 放行 `x-api-key/anthropic-version`）。新增 `src/converters/anthropic.js` 纯函数转换层与 `tests/messages-anthropic.test.js`（9 例）。附带修复 `EXTERNAL_TOOL_PREFIX` 缺 import 的 latent `ReferenceError`。
- **官方对齐重试策略**：移植上游 `session/retry.ts`（`2s×2ⁿ⁻¹` 指数退避 +25% jitter；优先 `retry-after-ms`/`retry-after`，header 等待 clamp 30s；`5xx` 强制、`isRetryable`、`ContextOverflow` 永不）。重试次数 `n` 经 `OPENCODE_PROXY_RETRY_MAX_RETRIES` 控制（默认 3，总尝试 1+n，上限对齐官方 5）。chat 双路由与 messages 非串流改用新退避；responses 非串流新增同结构重试迴圈（仅无产出且 transient 时；responses/messages 串流保持单次尝试）。三处非串流的 prompt/poll 抛错同样走 transient 重试路由（传输层 throw 不再直接逃逸）；真鉴权失败（invalid api key/unauthorized/authentication failed）立即透出不再烧退避。新增 `src/retry/policy.js` 与 `tests/retry-policy.test.js`（11 例）及接线/回归测试 14 例。

### Fixed

- **后端错误透出**：`/v1/responses` 在后端 session 失败时曾 `throw` 纯对象，经 `transformUpstreamError` 被洗成 `500 Internal server error / code Object`、真实讯息丢失。新增 `normalizeBackendError`（纯对象→Error，保留 `data.message`/`name`/状态码推断），两处 `throw polled.error` 改用它；`transformUpstreamError` 纵深加固（默认分支改读 `data.message`/`name`，code 默认 `upstream_error` 不再用 `constructor.name`）。现 Credits 类错误正确回 `402 insufficient_quota` 并携带原文。新增 `tests/backend-error-surface.test.js`（4 例复现 LiteLLM 案例，含 messages）。
- **同族错误路径查漏**：responses 串流 idleTimeout 补 poll 失败检查（不再静默回空 `completed`）；messages 非串流改用 transformed `status/type/code`（不再硬编码 `502/api_error`）；messages 串流检查 `collected.error` 与 poll 失败（失败即抛正規化错误走 SSE error 事件，不再静默 200）；`isTransientUpstreamError` 纳入 `name/code/type` 参与签名匹配（无 message 纯对象不再必判 false）。

## [1.6.0] - 2026-09-08

### ⚠️ Breaking / 行為變更

- **`DISABLE_TOOLS=false` 從被忽略變為真正生效**：舊版只讀 `OPENCODE_DISABLE_TOOLS`，經 compose/`.env` 設 `DISABLE_TOOLS=false` 的用戶實際跑的是預設 `true`（工具禁用）。本版起該別名正式生效，升級後工具會真正啟用並可執行後端操作。要保持禁用請顯式設 `DISABLE_TOOLS=true`（或改用 `OPENCODE_DISABLE_TOOLS=true`）或刪行回預設。
- **串流錯誤語義（僅 `/v1/responses` 改變傳輸形態）**：`stream:true` 的 `/v1/responses` 在 headers 已 flush（早於 preflight）之後出錯時，改經 SSE `response.failed` 事件 + `data: [DONE]` 回報（HTTP 狀態固定為 200）。`/v1/chat/completions` 串流維持原形態（`data: {"error":…}` 後結束），`/v1/messages` 串流維持 `error` 事件後結束（無 `[DONE]`）；且 chat/messages 的 preflight 失敗仍在 headers 送出前發生，故仍回 JSON 狀態碼（行為不變）。只看 HTTP 狀態碼的 responses 串流客戶端請改為同時監聽流內 `response.failed`；`stream:false` 的 JSON 狀態碼語義三路由皆不變（含超時 → `504`）。

### Added

- **Docker 多架构发布**：`ghcr.io/samson910022/opencode2api:latest` 同时推送 `linux/amd64` + `linux/arm64`（此前已上线但未记入 changelog；ARM 机器可直接 pull，无需本地 build）。
- **环境变量兼容别名**：`docker-compose`/`.env` 沿用的 `DISABLE_TOOLS` 正式生效（此前只有 `OPENCODE_DISABLE_TOOLS` 被读取）。解析收敛到共用的 `normalizeBool` + `resolveDisableTools`（无效值让位：canonical env > legacy env > `config.json` > 默认；數字僅 `0/1` 有效，其餘視為未設），`index.js` 直接調用同一 helper 不再手寫 `??` 鏈，附 `tests/env-alias.test.js`。
- **串流强健（responses/chat/messages 三路由）**：串流 `/v1/responses` 在 preflight 等待前即 flush SSE 头 + 15s heartbeat（中转不再看到零字节 stall；chat/messages 的 headers 仍在 preflight 之後送出，其 preflight 失敗維持 JSON 狀態碼）；三路由的 `resolve/session/tool-overrides` preflight 與非串流 `prompt` 全部经 `withTimeout` 限界（真错误立即透出，超时经 `Request timeout` 映射為 `504`）；客户端断开经 `res 'close'` + `!writableEnded` 取消并清理 session（`req 'close'` 在 body 解析完即觸發，不可用）；`promptWithTimeout` 統一改調 `withTimeout`（舊 inline race 洩漏 timer 且晚拒絕可致 unhandled rejection）。附 `tests/stream-hardening.test.js`。
- **小机部署加固（可調）**：compose 加 `mem_limit 768m`/`mem_reservation 256m`/`cpus 1.5`/`pids_limit 256`、日志轮转、`start_period 200s`，补 `OPENCODE_PROXY_RETRY_MAX_RETRIES`/`BIND_HOST`/`OPENCODE_DISABLE_TOOLS` 透传；`Dockerfile` 补 `RETRY` 默认；entrypoint 后端等待 30s→约 180s（覆盖小机冷启动）。`mem_limit` 是部署行為變更（非 API breaking）：此前無上限只會變慢，現超限會被 OOM kill；大機請用 `docker-compose.override.yml` 放寬（見 `docs/docker.md`「覆寫資源限制」）。

### Fixed

- **`DISABLE_TOOLS=false` 被静默忽略**：见上 Breaking（生产默认仍为 `true`，只在显式设 `false`/别名时行为变化）。
- **断线侦测误用 `req 'close'`**：server 端该事件在请求体解析完即触发（实测 +1ms），不能用于串流断线；改用 `res 'close'` + `!writableEnded`（`/v1/messages` 旧 pattern 因监听挂得晚而等于失效，一并修复；監聽器改 `once` 避免殘留）。
- **`withTimeout` 超時誤回 500**：超時訊息現為 `Request timeout after …(label)`，可被 `transformUpstreamError` 正確映射為 `504`（此前自訂訊息繞過映射）；`createApp` 補 `REQUEST_TIMEOUT_MS` 預設，非有限值回退到 `DEFAULT_REQUEST_TIMEOUT_MS`。
- **`BIND_HOST` 命名分裂**：`startProxy` 後備鏈與 `index.js` 合併皆支援 `BIND_HOST` 優先、`OPENCODE_PROXY_BIND_HOST` 後備（此前 `startProxy` 只有後者，經正常 `index.js` 路徑時後備不可達）。
- **文件範例收斂（非 breaking）**：`docs/docker.md` 的 `docker run` 範例刪除 `-p 10001:10001`（後端僅容器內部使用；運行時無變更，舊映射仍可用，建議改走代理端口）。

## [1.5.0] - 2026-04-18

### Added

- **External Tool Bridge**: Added proxy-level bridging for external OpenAI-compatible `tools` across `/v1/chat/completions` and `/v1/responses`.
- **Streaming Tool Call Parity**: Added streaming support for external tool calls in both Chat Completions and Responses APIs.
- **Explicit External Tool Config**: Added explicit `EXTERNAL_TOOLS_MODE=proxy-bridge` and `EXTERNAL_TOOLS_CONFLICT_POLICY=namespace` configuration surface and documentation.

### Changed

- **Project Version**: Bumped the repository version to `1.5.0` across package metadata and documentation badges.

### Fixed

- **Jest Test Shutdown**: Removed a lingering queue rescheduling timer from the proxy request lock flow and updated the default test command to use the verified clean Jest invocation, eliminating the previous generic open-handle warning during `npm test`.

## [1.0.0] - 2025-04-11

### Added

- **OpenAI-compatible API**: `/v1/models`, `/v1/chat/completions`, `/v1/responses` endpoints
- **Streaming Support**: Full SSE streaming for Chat Completions and Responses API
- **Model Aliases**: GPT-style model aliasing (e.g., `gpt5-nano` → `gpt-5-nano`)
- **Docker Deployment**: Complete Docker setup with healthcheck and volume management
- **Configuration**: Environment variables and config.json support
- **Auto Cleanup**: Configurable automatic conversation/session storage cleanup

### Changed

- **Default Security**: `DISABLE_TOOLS` defaults to `true` for safer out-of-box behavior
