# 🔌 API 参考

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.0-blue" alt="Version">
</p>

---

## 📋 基础信息

| 项目 | 值 |
|:-----|:---|
| **Base URL** | `http://127.0.0.1:10000` |
| **API Version** | `v1` |
| **认证方式** | Bearer Token (当 `API_KEY` 配置时必需) |

---

## 🔑 认证

```bash
# 带认证
curl -H "Authorization: Bearer YOUR_API_KEY" ...

# 不带认证 (未配置 API_KEY 时)
curl ...
```

---

## 📡 端点

### ✅ 健康检查

```http
GET /health
```

**响应示例:**

```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

### 📋 模型列表

```http
GET /v1/models
```

**响应示例:**

```json
{
  "object": "list",
  "data": [
    {
      "id": "opencode/big-pickle",
      "object": "model",
      "created": 1704067200,
      "owned_by": "opencode"
    }
  ]
}
```

---

### 💬 Chat Completions

```http
POST /v1/chat/completions
```

**请求体:**

| 参数 | 类型 | 必填 | 说明 |
|:-----|:-----|:-----|:-----|
| `model` | string | ✅ | 模型 ID |
| `messages` | array | ✅ | 消息数组 |
| `tools` | array | - | 外部工具定义数组，遵循 OpenAI-compatible function tools 结构 |
| `tool_choice` | string/object | - | 工具选择策略；会按代理桥接语义处理 |
| `stream` | boolean | - | 是否流式输出 |
| `temperature` | number | - | 温度 (0-2) |
| `top_p` | number | - | 核采样 (0-1) |
| `max_tokens` | number | - | 最大 token 数 |
| `reasoning_effort` | string | - | 推理强度 |

**示例:**

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "你好!"}],
    "stream": false
  }'
```

**带外部工具的示例:**

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [
      {"role": "user", "content": "读取 https://example.com 并告诉我标题"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "web_fetch",
          "description": "Fetch a web page and summarize it",
          "parameters": {
            "type": "object",
            "properties": {
              "url": {"type": "string"}
            },
            "required": ["url"]
          }
        }
      }
    ]
  }'
```

当模型决定调用工具时，非流式响应会返回标准 `message.tool_calls`；流式响应会返回 `chat.completion.chunk` 中的 `delta.tool_calls`。

---

### 🧠 Responses API

```http
POST /v1/responses
```

**请求体:**

| 参数 | 类型 | 必填 | 说明 |
|:-----|:-----|:-----|:-----|
| `model` | string | ✅ | 模型 ID |
| `input` | string | ✅* | 输入文本 |
| `prompt` | string | ✅* | 提示词 |
| `messages` | array | ✅* | 消息数组 |
| `tools` | array | - | 外部工具定义数组，遵循 OpenAI-compatible function tools 结构 |
| `stream` | boolean | - | 是否流式输出 |
| `reasoning_effort` | string | - | 推理强度 |

> * 至少需要提供 `input`、`prompt` 或 `messages` 其中之一

**示例:**

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "input": "打招呼",
    "reasoning": {"effort": "high"},
    "stream": true
  }'
```

**带外部工具的示例:**

```bash
curl -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "input": "东京现在天气怎么样？",
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "weather_lookup",
          "description": "Look up weather by city",
          "parameters": {
            "type": "object",
            "properties": {
              "city": {"type": "string"},
              "unit": {"type": "string"}
            },
            "required": ["city"]
          }
        }
      }
    ]
  }'
```

非流式 `responses` 响应会在 `response.output` 中返回 `type: "function_call"` 项；流式模式会发送 function_call 生命周期和参数增量事件。

### 🧭 推荐提示模板（OpenClaw / Claude Code）

在真实运行环境中，如果你希望第一跳**稳定先产出 tool call**，推荐把“调用工具”和“基于工具结果继续回答”拆成两步，而不是混在同一句里。

**推荐第一跳提示：**

```text
Call weather_lookup for Tokyo now. Do not answer directly.
```

或中文：

```text
现在调用 weather_lookup 查询 Tokyo。不要直接回答。
```

收到 `tool_calls` / `function_call` 后，再把工具结果回灌，并追加第二跳提示：

```text
Great, now answer the original request using the tool result.
```

或中文：

```text
很好，现在基于工具结果回答原始问题。
```

### 为什么推荐两段式提示

- 第一跳只负责**稳定产出工具调用**
- 第二跳只负责**基于工具结果生成最终回答**
- 这样比把“先调工具再回答”写在同一条用户消息里更稳定，尤其适合 OpenClaw、Claude Code 这类 agent 客户端

### 推荐的 agent 行为

1. 先发送严格的 tool-only 提示
2. 如果收到 `tool_calls` / `function_call`，执行工具
3. 回灌工具结果
4. 再发送第二跳提示要求模型整合工具结果回答

> 这个两段式模式是当前 `opencode2api` 外部工具桥接的推荐集成方式。

### 🌊 流式工具调用

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "input": "查询东京天气",
    "stream": true,
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "weather_lookup",
          "description": "Look up weather by city",
          "parameters": {
            "type": "object",
            "properties": {
              "city": {"type": "string"}
            },
            "required": ["city"]
          }
        }
      }
    ]
  }'
```

当启用流式模式时：

- Chat Completions 会在 `chat.completion.chunk` 中返回 `delta.tool_calls`
- Responses API 会返回 `response.output_item.added`、`response.function_call_arguments.delta`、`response.function_call_arguments.done`、`response.output_item.done` 等事件
- Messages API 会返回 `message_start`、`content_block_start`、`content_block_delta`（`text_delta`/`thinking_delta`/`input_json_delta`）、`content_block_stop`、`message_delta`、`message_stop`（无 `[DONE]`）

> 注意：代理内部会使用命名空间隔离同名工具，但这些内部名称不会作为公开 API 返回给客户端。

---

### 🟣 Messages API（Anthropic 兼容）

`POST /v1/messages`。认证可用 `Authorization: Bearer` 或 `x-api-key`；`max_tokens` 必填；首条 message 须为 `user`。

| 字段 | 说明 |
|:-----|:-----|
| `model` | 模型 ID（支持 `opencode/` 前缀或裸名） |
| `max_tokens` | 必填，最大输出 tokens |
| `system` | string 或 `[{type:'text', text}]` |
| `messages` | `user`/`assistant` 数组，content 支持 `text`、`image`（base64/url）、`tool_use`、`tool_result` |
| `tools` | `[{name, description, input_schema}]`（`input_schema` 即 JSON Schema） |
| `tool_choice` | `{type:'auto'|'any'|'tool'|'none', name?}`（`any`≈强制调用） |
| `thinking` | `{type:'enabled', budget_tokens}` 映射为推理强度（`disabled`→关闭） |
| `stream` | bool，流式返回 Anthropic SSE 事件 |
| `temperature` / `top_p` / `stop_sequences` | 透传（`stop_sequences`→`stop`）；`top_k` 暂忽略 |

**示例:**

```bash
curl -X POST http://127.0.0.1:10000/v1/messages \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "用一句话打招呼"}]
  }'
```

**带工具的示例:**

```bash
curl -X POST http://127.0.0.1:10000/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "查询东京天气"}],
    "tools": [
      {
        "name": "weather_lookup",
        "description": "Look up weather by city",
        "input_schema": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    ]
  }'
```

工具调用以 `content: [{type:'tool_use', id, name, input}]` 返回（`stop_reason: 'tool_use'`），下一轮把 `tool_use` + `tool_result` 回灌进 `messages` 即可继续。`thinking` 以无签名 `thinking` block 返回（多轮透传签名暂为占位空串）。

---

## 🔧 推理强度

| 输入值 | 映射结果 |
|:-------|:---------|
| `minimal` | `none` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `high` |

---

## ⚠️ 错误响应

### 401 Unauthorized

```json
{
  "error": {
    "message": "Invalid API key",
    "type": "invalid_request_error",
    "code": "invalid_api_key"
  }
}
```

### 404 Not Found

```json
{
  "error": {
    "message": "Model not found",
    "type": "invalid_request_error",
    "code": "model_not_found"
  }
}
```

### 500 Internal Server Error

```json
{
  "error": {
    "message": "Internal server error",
    "type": "server_error",
    "code": "internal_error"
  }
}
```
