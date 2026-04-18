# ⚙️ 配置详解

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="Version">
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

### 推荐生产配置

```bash
DISABLE_TOOLS=true
OPENCODE_EXTERNAL_TOOLS_MODE=proxy-bridge
OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY=namespace
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
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

### 💻 本地开发

```bash
DISABLE_TOOLS=false
OPENCODE_PROXY_DEBUG=true
```
