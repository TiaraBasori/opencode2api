# 🚀 快速开始

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="Version">
</p>

---

## 📋 环境要求

### 🐳 Docker 方式（推荐）

| 要求 | 说明 |
|:-----|:-----|
| Docker | 20.10+ |
| Docker Compose | 最新版 |

### 💻 本地 Node 方式

| 要求 | 说明 |
|:-----|:-----|
| Node.js | 18+ |
| npm / yarn | 最新版 |

---

## 🏁 快速开始

### 方式一：Docker 部署

| 步骤 | 命令 |
|:-----|:-----|
| 1. 克隆项目 | `git clone https://github.com/TiaraBasori/opencode2api.git` |
| 2. 进入目录 | `cd opencode2api` |
| 3. 复制配置 | `cp .env.example .env` |
| 4. 启动服务 | `docker compose up -d` |

### 方式二：本地 Node 部署

| 步骤 | 命令 |
|:-----|:-----|
| 1. 克隆项目 | `git clone https://github.com/TiaraBasori/opencode2api.git` |
| 2. 进入目录 | `cd opencode2api` |
| 3. 安装依赖 | `npm install` |
| 4. 复制配置 | `cp config.json.example config.json` |
| 5. 安装 CLI | `npm install -g opencode-ai` |
| 6. 启动服务 | `npm start` |

---

## ✅ 验证服务

```bash
# 健康检查
curl http://127.0.0.1:10000/health

# 获取模型列表
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:10000/v1/models
```

---

## 💡 快速测试

### Chat Completions API

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "hi"}],
    "stream": false
  }'
```

### Responses API (带推理)

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt5-nano",
    "input": "Say hi in one sentence.",
    "reasoning": {"effort": "high"},
    "stream": true
  }'
```

---

## ➡️ 下一步

- ⚙️ 查看 [Configuration](./configuration.md) 了解更多配置选项
- 🐳 查看 [Docker Deployment](./docker.md) 了解 Docker 部署详情