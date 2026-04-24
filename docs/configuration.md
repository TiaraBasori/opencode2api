# ⚙️ 配置详解

<p align="center">
  <img src="https://img.shields.io/badge/version-1.5.0-blue" alt="Version">
</p>

---

## 📌 配置方式

> 配置优先级：**环境变量 > config.json > 默认值**

---

## 🔧 环境变量

### 核心配置

| 变量 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `PORT` / `OPENCODE_PROXY_PORT` | `10000` | 代理服务端口 |
| `OPENCODE_SERVER_PORT` | `10001` | OpenCode 后端服务端口 |
| `API_KEY` | - | Bearer Token 认证密钥 |
| `BIND_HOST` | `0.0.0.0` | 绑定地址 |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:10001` | OpenCode 后端地址 |
| `OPENCODE_SERVER_PASSWORD` | - | OpenCode 后端密码 |

### 功能配置

| 变量 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `DISABLE_TOOLS` | `true` | 禁用 OpenCode 工具调用 |
| `OPENCODE_EXTERNAL_TOOLS_MODE` | `proxy-bridge` | 外部工具桥接模式；当前仅支持 `proxy-bridge` |
| `OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY` | `namespace` | 外部工具冲突隔离策略；当前仅支持 `namespace` |
| `OPENCODE_INTERNAL_WEB_FETCH_ENABLED` | `false` | 兼容旧开关；未显式配置 allowlist 时，启用后默认放行 `web_fetch` |
| `OPENCODE_INTERNAL_ALLOWED_TOOLS` | `(none)` | 当请求未传入 `tools` 时允许使用的 OpenCode 内置工具列表，逗号分隔 |
| `OPENCODE_INTERNAL_TOOL_METRICS_ENABLED` | `true` | 输出 internal allowlist 模式的调试/指标日志 |
| `OPENCODE_TOOL_DISCOVERY_FIXTURE` | `(none)` | 集成测试/本地调试用的固定后端工具 ID 列表，逗号分隔 |
| `USE_ISOLATED_HOME` | `false` | 使用隔离的 OpenCode 配置目录 |
| `PROMPT_MODE` | `standard` | 提示词处理模式 |
| `OMIT_SYSTEM_PROMPT` | `false` | 忽略传入的 system prompt |
| `AUTO_CLEANUP_CONVERSATIONS` | `false` | 自动清理会话存储 |
| `CLEANUP_INTERVAL_MS` | `43200000` | 清理间隔 (毫秒) |
| `CLEANUP_MAX_AGE_MS` | `86400000` | 最大存储时间 (毫秒) |
| `REQUEST_TIMEOUT_MS` | `180000` | 请求超时时间 (毫秒) |

### 调试配置

| 变量 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `DEBUG` / `OPENCODE_PROXY_DEBUG` | `false` | 开启调试日志 |
| `OPENCODE_PATH` | `opencode` | OpenCode 可执行文件路径 |
| `OPENCODE_ZEN_API_KEY` | - | Zen API Key 透传 |

---

## 📄 config.json 示例

```json
{
    "PORT": 10000,
    "API_KEY": "your-secret-api-key",
    "BIND_HOST": "0.0.0.0",
    "DISABLE_TOOLS": true,
    "EXTERNAL_TOOLS_MODE": "proxy-bridge",
    "EXTERNAL_TOOLS_CONFLICT_POLICY": "namespace",
    "INTERNAL_WEB_FETCH_ENABLED": false,
    "INTERNAL_ALLOWED_TOOLS": ["web_fetch"],
    "INTERNAL_TOOL_METRICS_ENABLED": true,
    "INTERNAL_TOOL_DISCOVERY_FIXTURE": [],
    "USE_ISOLATED_HOME": false,
    "PROMPT_MODE": "standard",
    "OMIT_SYSTEM_PROMPT": false,
    "AUTO_CLEANUP_CONVERSATIONS": false,
    "CLEANUP_INTERVAL_MS": 43200000,
    "CLEANUP_MAX_AGE_MS": 86400000,
    "DEBUG": false,
    "OPENCODE_SERVER_URL": "http://127.0.0.1:10001",
    "OPENCODE_PATH": "opencode",
    "REQUEST_TIMEOUT_MS": 180000
}
```

---

## 🛠️ 外部工具桥接

OpenCode2API 现在支持把外部客户端传入的 OpenAI-compatible `tools` 桥接到代理层，而不是把这些工具直接暴露为 OpenCode 内置工具。

### 当前支持的模式

| 配置项 | 支持值 | 说明 |
|:------|:------|:-----|
| `OPENCODE_EXTERNAL_TOOLS_MODE` / `EXTERNAL_TOOLS_MODE` | `proxy-bridge` | 由代理虚拟化外部工具，并返回 OpenAI-compatible tool calling 结果 |
| `OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY` / `EXTERNAL_TOOLS_CONFLICT_POLICY` | `namespace` | 使用代理内部命名空间隔离同名冲突 |

### 工具冲突策略

- 外部客户端工具优先以“代理桥接”的方式参与对话。
- OpenCode 内置工具仍按现有 `DISABLE_TOOLS` 机制管理，不会因为客户端传入同名工具而被误触发。
- 代理内部会使用类似 `external__web_fetch` 的命名空间名避免冲突。
- 这些内部命名空间名称不会作为公开 API 的一部分暴露给客户端。

### 内置工具 allowlist

- 当请求 **未传入** `tools` 时，代理会进入 internal allowlist 模式，只允许 `OPENCODE_INTERNAL_ALLOWED_TOOLS` 中声明的 OpenCode 内置工具。
- `OPENCODE_INTERNAL_WEB_FETCH_ENABLED=true` 仅用于兼容旧配置：如果未显式配置 allowlist，则默认把 allowlist 视为 `web_fetch`。
- 代理会读取后端工具列表，并通过精确匹配或 `.<tool>` / `/<tool>` 后缀匹配解析最终可用工具。
- 如果配置的 allowlist 在后端工具列表中一个也没有匹配到，代理会自动回退到“全部内置工具禁用”的安全模式。
- `OPENCODE_INTERNAL_TOOL_METRICS_ENABLED=true` 时，会输出 internal allowlist 模式的调试/指标日志，记录模式选择、后端工具发现、allowlist 命中情况和降级原因，但不会记录工具输出内容。
- `OPENCODE_TOOL_DISCOVERY_FIXTURE` 可在集成测试或本地调试时绕过真实 `client.tool.ids()`，直接提供固定工具 ID 列表。
- 一旦客户端传入 `tools`，请求立即切回外部工具桥接模式，所有 OpenCode 内置工具继续保持禁用。

### 推荐生产配置

```bash
DISABLE_TOOLS=true
OPENCODE_EXTERNAL_TOOLS_MODE=proxy-bridge
OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY=namespace
OPENCODE_INTERNAL_ALLOWED_TOOLS=web_fetch
OPENCODE_INTERNAL_TOOL_METRICS_ENABLED=true
OPENCODE_TOOL_DISCOVERY_FIXTURE=
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

---

## 🎯 Prompt Mode 说明

| 模式 | 说明 |
|:-----|:-----|
| **standard** (默认) | 标准模式，完整处理提示词 |
| **plugin-inject** | 插件注入模式，减小模型侧提示词大小，通常与 `OMIT_SYSTEM_PROMPT=true` 配合使用 |

---

## ⭐ 推荐配置

### 🐳 Docker 生产环境

```bash
DISABLE_TOOLS=true
OPENCODE_EXTERNAL_TOOLS_MODE=proxy-bridge
OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY=namespace
OPENCODE_INTERNAL_ALLOWED_TOOLS=web_fetch
OPENCODE_INTERNAL_TOOL_METRICS_ENABLED=true
OPENCODE_TOOL_DISCOVERY_FIXTURE=
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

### 💻 本地开发

```bash
DISABLE_TOOLS=false
OPENCODE_PROXY_DEBUG=true
```
