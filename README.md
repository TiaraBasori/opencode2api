# OpenCode2API

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/Node.js-18+-orange" alt="Node">
</p>

> 📖 [文档](./docs/README.md) | 🚀 [快速开始](#-快速开始)

将本地 [OpenCode](https://opencode.ai) 运行时转换为 OpenAI 兼容 API 网关。在任何 OpenAI 客户端中使用免费模型 (GPT, Nemotron, MiniMax)。

---

## ✨ 功能特性

| 特性 | 说明 |
|:-----|:-----|
| 🟢 **OpenAI 兼容** | `/v1/models`, `/v1/chat/completions`, `/v1/responses` |
| 📡 **流式输出** | Chat Completions 与 Responses API 的完整 SSE 流式支持 |
| 🧠 **推理控制** | 支持 `reasoning_effort` 和 `reasoning: { "effort": "high" }` |
| 🐳 **Docker 部署** | 一键部署，自动启动 OpenCode 后端 |
| 🛡️ **工具安全** | 默认禁用工具调用 |

---

## 🚀 快速开始

### Docker 部署 (推荐)

```bash
# 1. 克隆并配置
git clone https://github.com/TiaraBasori/opencode2api.git
cd opencode2api
cp .env.example .env

# 2. 编辑 .env 设置你的配置
# 必填: API_KEY, OPENCODE_SERVER_PASSWORD

# 3. 启动
docker compose up -d

# 4. 测试
curl http://127.0.0.1:10000/health
```

### Node.js (本地开发)

```bash
# 1. 安装 OpenCode CLI
npm install -g opencode-ai
# Linux/macOS: curl -fsSL https://opencode.ai/install | bash

# 2. 克隆并运行
git clone https://github.com/TiaraBasori/opencode2api.git
cd opencode2api
npm install
cp config.json.example config.json
npm start
```

---

## 💡 使用示例

### Chat Completions

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

### Responses API (带推理)

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt5-nano",
    "input": "用一句话打招呼",
    "reasoning": {"effort": "high"},
    "stream": true
  }'
```

---

## 📦 部署方式

| 模式 | 说明 | 适用场景 |
|:-----|:-----|:---------|
| 🐳 **Docker** | 完整栈，自动启动 OpenCode 后端 | 生产环境，最简配置 |
| 💻 **独立 Node** | 手动管理后端 | 开发、自定义集成 |

---

## ⚙️ 配置

### 快速参考

| 环境变量 | 默认值 | 说明 |
|:--------|:-------|:------|
| `PORT` / `OPENCODE_PROXY_PORT` | `10000` | 代理服务端口 |
| `OPENCODE_SERVER_PORT` | `10001` | OpenCode 后端服务端口 |
| `API_KEY` | - | Bearer Token 认证密钥 |
| `BIND_HOST` | `0.0.0.0` | 绑定地址 |
| `DISABLE_TOOLS` | `true` | 禁用 OpenCode 工具调用 |
| `USE_ISOLATED_HOME` | `false` | 使用隔离的 OpenCode 配置目录 |
| `OPENCODE_PROXY_PROMPT_MODE` | `standard` | 提示词处理模式 |
| `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT` | `false` | 忽略传入的 system prompt |
| `OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS` | `false` | 自动清理会话存储 |
| `OPENCODE_PROXY_CLEANUP_INTERVAL_MS` | `43200000` | 清理间隔 (毫秒) |
| `OPENCODE_PROXY_CLEANUP_MAX_AGE_MS` | `86400000` | 最大存储时间 (毫秒) |
| `OPENCODE_PROXY_REQUEST_TIMEOUT_MS` | `180000` | 请求超时时间 (毫秒) |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:10001` | OpenCode 后端地址 |
| `OPENCODE_SERVER_PASSWORD` | - | OpenCode 后端密码 |
| `OPENCODE_PATH` | `opencode` | OpenCode 可执行文件路径 |
| `OPENCODE_ZEN_API_KEY` | - | Zen API Key 透传 |
| `DEBUG` / `OPENCODE_PROXY_DEBUG` | `false` | 调试日志 |

> 📄 完整配置参考: [配置详解](./docs/configuration.md)

### 推荐生产配置

```env
API_KEY=your-secret-key
OPENCODE_SERVER_PASSWORD=your-password
DISABLE_TOOLS=true
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

---

## 🔌 API 参考

### 端点

| 方法 | 路径 | 说明 |
|:-----|:-----|:-----|
| `GET` | `/health` | 健康检查 |
| `GET` | `/v1/models` | 获取可用模型列表 |
| `POST` | `/v1/chat/completions` | Chat Completions API |
| `POST` | `/v1/responses` | Responses API |

### 模型名称格式

- 直接使用: `opencode/big-pickle`
- 带别名: `gpt5-nano` (自动解析为 `gpt-5-nano`)
- 带前缀: `opencode/gpt5-nano`

> 📖 详见 [API 参考文档](./docs/api-reference.md)

---

## 🔧 故障排查

### 请求卡住但 `/v1/models` 正常
```bash
USE_ISOLATED_HOME=false  # 让 OpenCode 复用本地登录态
```

### 模型找不到
- 查看可用模型: `curl http://127.0.0.1:10000/v1/models`
- 确认模型 ID 完全匹配

### 没有推理输出
- 使用 `stream: true` 的 Responses API
- 发送 `reasoning.effort` 或 `reasoning_effort`

> 📖 完整指南: [故障排查](./docs/troubleshooting.md)

---

## 🔨 开发

```bash
# 运行测试
npm test -- --runInBand

# Docker 开发
docker compose up -d --build
```

---

## 📄 许可证

MIT · 详见 [LICENSE](./LICENSE.md)

---

## 🙏 致谢

感谢以下开源项目:

- [dxxzst/opencode-to-openai](https://github.com/dxxzst/opencode-to-openai)
- [lucasliet/opencode-openai-proxy](https://github.com/lucasliet/opencode-openai-proxy)