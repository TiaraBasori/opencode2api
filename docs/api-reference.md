# 🔌 API 参考

<p align="center">
  <img src="https://img.shields.io/badge/version-1.5.0-blue" alt="Version">
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
    "model": "opencode/big-pickle",
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
    "model": "opencode/big-pickle",
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

### 🌊 流式工具调用

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
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

> 注意：代理内部会使用命名空间隔离同名工具，但这些内部名称不会作为公开 API 返回给客户端。

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
