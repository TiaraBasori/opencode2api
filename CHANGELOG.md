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
